//! `lib/server/settings-import.ts`: the resumable importer behind
//! `POST /api/settings/import`, `GET`/`DELETE /api/settings/import/:id` and
//! `POST /api/settings/import/:id/resolve`.
//!
//! The pipeline is driven by a session file under
//! `~/.claude/.claudius/imports/<importId>.json`
//! (`JSON.stringify(session, null, 2)` + a newline, written tmp + rename):
//! step 0 merges the four system files (and restores bundled
//! customizations), then each workspace is committed in turn, pausing on a
//! hazard (`missing_root`, `not_a_directory`, `id_collision`,
//! `path_collision`) until the caller's decision arrives. The file is
//! removed on `done`, and on `cancelImport`.
//!
//! Faithful details worth naming:
//! * `advance` reads the session **outside** its `try`, so a session file
//!   that doesn't parse is an uncaught throw (Next's empty 500), while
//!   anything the pipeline throws becomes `{state:"error", error, log}` —
//!   with `log` left out when the session has none.
//! * a bundle without `system` throws `Cannot read properties of undefined
//!   (reading 'userSettings')` and lands in that error state.
//! * merge strategy v1: deep-merge, import wins, arrays unioned by a
//!   sorted-key `JSON.stringify` identity (target's entries first).
//! * settings files are read with [`crate::settings`], so a malformed one
//!   errors and nothing is written over it.
//! * `decisions[meta.id]` where the id is `__proto__` is a JS setter, so
//!   the decision is never stored (the import re-pauses forever). Mirrored.
//! * every fs path built from the bundle (`importId`, a customization's
//!   `src/` file) is resolved and checked right above the call.

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::settings::{self, Scope};
use crate::skills::Thrown;
use crate::updater::settings::SettingsPatch;
use crate::workspaces::CreateInputJs;
use crate::{asset_ingest, customizations, customize_settings, js_string, keybindings};
use crate::{node_err, node_path, now_ms, paths, safe_path, updater, workspaces};

use claudius_agent::js;

// ── paths ────────────────────────────────────────────────────────────────

/// `importsDir()` — `homedir()/.claude/.claudius/imports`.
pub fn imports_dir() -> String {
    node_path::join(&[&paths::claudius_root().to_string_lossy(), "imports"])
}

/// `sessionPath(importId)`, resolved and pinned inside [`imports_dir`].
/// `None` for an id that escapes it — the TS `path.join`s the URL's segment
/// and would read or write outside (a deliberate difference; the id is
/// generated server-side, so no real session reaches it).
fn session_path(import_id: &str) -> Option<String> {
    let base = imports_dir();
    let target = node_path::resolve(&[&base, &format!("{import_id}.json")]);
    target.starts_with(&format!("{base}/")).then_some(target)
}

/// `readSession`: the parsed file, `None` for ENOENT. A read error or a
/// file `JSON.parse` refuses is an `Err` — which every caller leaves
/// uncaught.
fn read_session(import_id: &str) -> Result<Option<Value>, Thrown> {
    let Some(path) = session_path(import_id) else {
        return Ok(None);
    };
    let bytes = match node_err::fs::read_file(Path::new(&path)) {
        Ok(b) => b,
        Err(e) if e.code == "ENOENT" => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    js::json_parse(&String::from_utf8_lossy(&bytes))
        .map(Some)
        .map_err(|message| Thrown {
            name: "SyntaxError",
            message,
        })
}

/// `writeSession`: `mkdir -p`, a tmp file, then rename.
fn write_session(session: &Value) -> Result<(), Thrown> {
    let import_id = session
        .get("importId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let dir = imports_dir();
    node_err::fs::mkdir_recursive(Path::new(&dir))?;
    let Some(file) = session_path(import_id) else {
        return Err(Thrown::path_injection("path escapes base directory"));
    };
    let tmp = format!("{file}.{}.{}.tmp", std::process::id(), now_ms());
    let mut body = js::stringify_pretty(session);
    body.push('\n');
    if !tmp.starts_with(&format!("{dir}/")) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    node_err::fs::write_file(Path::new(&tmp), body.as_bytes())?;
    node_err::fs::rename(Path::new(&tmp), Path::new(&file))?;
    Ok(())
}

/// `deleteSession` — best effort.
fn delete_session(import_id: &str) {
    if let Some(path) = session_path(import_id) {
        let _ = std::fs::remove_file(path);
    }
}

// ── JS value helpers ─────────────────────────────────────────────────────

/// JS `v.key`: a `TypeError` on `undefined` / `null`, else the own key
/// (`None` is `undefined`).
fn member<'a>(v: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, Thrown> {
    match v {
        None => Err(Thrown::type_error(format!(
            "Cannot read properties of undefined (reading '{key}')"
        ))),
        Some(Value::Null) => Err(Thrown::type_error(format!(
            "Cannot read properties of null (reading '{key}')"
        ))),
        Some(Value::Object(m)) => Ok(m.get(key)),
        Some(Value::Array(items)) => Ok(js::array_index(key).and_then(|i| items.get(i as usize))),
        Some(_) => Ok(None),
    }
}

/// JS `v?.key`.
fn opt<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => m.get(key),
        Some(Value::Array(items)) => js::array_index(key).and_then(|i| items.get(i as usize)),
        _ => None,
    }
}

/// `v?.kind === want`.
fn kind_is(v: Option<&Value>, want: &str) -> bool {
    opt(v, "kind").and_then(Value::as_str) == Some(want)
}

/// JS `v.length` for an array or string; `None` (`undefined`) otherwise.
fn js_length(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Array(items)) => Some(items.len() as f64),
        Some(Value::String(s)) => Some(js_string::len16(s) as f64),
        _ => None,
    }
}

/// JS `v.length` without optional chaining: a `TypeError` on `undefined` /
/// `null`, else [`js_length`].
fn length_of(v: Option<&Value>) -> Result<Option<f64>, Thrown> {
    member(v, "length")?;
    Ok(js_length(v))
}

/// `Object.keys(v).length`, which `null` refuses.
fn own_keys_len(v: Option<&Value>) -> usize {
    match v {
        Some(Value::Object(m)) => m.len(),
        Some(Value::Array(items)) => items.len(),
        Some(Value::String(s)) => js_string::len16(s),
        _ => 0,
    }
}

/// `String(v)` in a template literal.
fn text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => js_string::to_js_string(v).unwrap_or_else(|_| "[object Object]".into()),
    }
}

/// `a === b` where `None` is `undefined`; objects and arrays are never
/// equal to anything (reference identity).
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Object(_) | Value::Array(_)), _) => false,
        (_, Some(Value::Object(_) | Value::Array(_))) => false,
        (Some(x), Some(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(p), Some(q)) => p == q,
            _ => x == y,
        },
        _ => false,
    }
}

/// `assertAbsoluteUserPath(input)`.
fn assert_absolute_user_path(input: Option<&Value>) -> Result<String, &'static str> {
    let Some(Value::String(s)) = input else {
        return Err("invalid path");
    };
    if s.is_empty() {
        return Err("invalid path");
    }
    if s.contains('\0') {
        return Err("null byte in path");
    }
    if !node_path::is_absolute(s) {
        return Err("path must be absolute");
    }
    Ok(node_path::resolve(&[s]))
}

// ── validation ───────────────────────────────────────────────────────────

/// `validateBundle(input)`: a known version and a workspaces array whose
/// entries each hold a `meta` with string `id` and `rootPath`.
pub fn validate_bundle(input: &Value) -> bool {
    if !matches!(input, Value::Object(_) | Value::Array(_)) {
        return false;
    }
    if opt(Some(input), "version").and_then(Value::as_f64) != Some(1.0) {
        return false;
    }
    let Some(list) = opt(Some(input), "workspaces").and_then(Value::as_array) else {
        return false;
    };
    for w in list {
        if !matches!(w, Value::Object(_) | Value::Array(_)) {
            return false;
        }
        let meta = opt(Some(w), "meta");
        if !meta.is_some_and(js::truthy) {
            return false;
        }
        if !opt(meta, "id").is_some_and(Value::is_string)
            || !opt(meta, "rootPath").is_some_and(Value::is_string)
        {
            return false;
        }
    }
    true
}

// ── deep merge ───────────────────────────────────────────────────────────

/// `mergeDeep(target, source)`: arrays unioned by [`stable_key`] (the
/// target's entries first), plain objects merged recursively, `null` or
/// `undefined` source keeping the target, anything else source-wins.
pub fn merge_deep(target: Option<&Value>, source: Option<&Value>) -> Option<Value> {
    if let (Some(Value::Array(t)), Some(Value::Array(s))) = (target, source) {
        let mut seen: Vec<String> = Vec::new();
        let mut out: Vec<Value> = Vec::new();
        for item in t.iter().chain(s.iter()) {
            let k = stable_key(Some(item));
            if !seen.contains(&k) {
                seen.push(k);
                out.push(item.clone());
            }
        }
        return Some(Value::Array(out));
    }
    if let (Some(Value::Object(t)), Some(Value::Object(s))) = (target, source) {
        let mut out = t.clone();
        for (k, v) in js::own_keys_order(s) {
            let merged = if out.contains_key(k) {
                merge_deep(out.get(k), Some(v))
            } else if k == "__proto__" {
                // `k in out` sees the inherited accessor, and the assignment
                // runs its setter: never an own key, so never printed.
                continue;
            } else if v.is_null() && OBJECT_PROTOTYPE_METHODS.contains(&k.as_str()) {
                // `k in out` sees the inherited method, and a `null` source
                // keeps it: a function-valued key `JSON.stringify` drops.
                continue;
            } else {
                Some(v.clone())
            };
            match merged {
                Some(m) => {
                    out.insert(k.clone(), m);
                }
                None => {
                    out.shift_remove(k);
                }
            }
        }
        return Some(Value::Object(out));
    }
    match source {
        None | Some(Value::Null) => target.cloned(),
        Some(v) => Some(v.clone()),
    }
}

/// The methods every plain object inherits from `Object.prototype`, which
/// `k in out` finds without an own key.
const OBJECT_PROTOTYPE_METHODS: [&str; 11] = [
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// `stableKey(v)`: plain objects recursed with sorted keys, so key order
/// doesn't change an array entry's identity.
fn stable_key(v: Option<&Value>) -> String {
    match v {
        Some(Value::Array(items)) => {
            let parts: Vec<String> = items.iter().map(|i| stable_key(Some(i))).collect();
            format!("[{}]", parts.join(","))
        }
        Some(Value::Object(m)) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        js_string::stringify(&Value::String((*k).clone())),
                        stable_key(m.get(*k))
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        // `JSON.stringify(v) ?? "null"` — `undefined` stringifies to nothing.
        None => "null".into(),
        Some(v) => js_string::stringify(v),
    }
}

// ── system merge ─────────────────────────────────────────────────────────

/// `mergeSystem(bundle)`.
fn merge_system(bundle: Option<&Value>) -> Result<(), Thrown> {
    let sys = member(bundle, "system")?.cloned();
    let sys = sys.as_ref();

    if let Some(user) = member(sys, "userSettings")?.filter(|v| js::truthy(v)) {
        let current = settings::read_settings_value(Scope::User, "").map_err(thrown)?;
        let next = merge_deep(Some(&current), Some(user)).unwrap_or(Value::Null);
        settings::write_settings_value(Scope::User, "", &next).map_err(thrown)?;
    }

    if let Some(c) = member(sys, "customizeSettings")?.filter(|v| js::truthy(v)) {
        // `setSettings({autoFixPrompt: c.autoFixPrompt})`: `{...current,
        // ...patch}`, where an `undefined` prompt is a key `JSON.stringify`
        // drops (so the file is written as `{}`).
        let mut next = customize_settings::get_settings().map_err(anyhow_thrown)?;
        match opt(Some(c), "autoFixPrompt") {
            Some(v) => {
                next.insert(customize_settings::AUTO_FIX_PROMPT.into(), v.clone());
            }
            None => {
                next.shift_remove(customize_settings::AUTO_FIX_PROMPT);
            }
        }
        customize_settings::write_settings(&next).map_err(anyhow_thrown)?;
    }

    if let Some(u) = member(sys, "updaterSettings")?.filter(|v| js::truthy(v)) {
        updater::settings::patch_updater_settings(&SettingsPatch::from_json(u))
            .map_err(|e| Thrown::error(e.message))?;
    }

    if let Some(k) = member(sys, "keybindings")?.filter(|v| js::truthy(v)) {
        let home = paths::home_dir().to_string_lossy().into_owned();
        let current = keybindings::read_keybindings(&home)?;
        let next = merge_deep(current.get("data"), Some(k)).unwrap_or(Value::Null);
        keybindings::write_keybindings(&home, &next)?;
    }

    let list = member(bundle, "customizations")?.cloned();
    if list.as_ref().is_some_and(js::truthy) && js_length(list.as_ref()).is_some_and(|n| n > 0.0) {
        restore_customizations(list.as_ref())?;
    }
    Ok(())
}

fn thrown(e: settings::SettingsError) -> Thrown {
    Thrown {
        name: e.name(),
        message: e.to_string(),
    }
}

/// An `anyhow` error (its message is the one Node or V8 gives) as the
/// `Error` the TS throws.
fn anyhow_thrown(e: anyhow::Error) -> Thrown {
    Thrown {
        name: "Error",
        message: e.to_string(),
    }
}

/// `/^cust_[a-f0-9]{12}$/`.
fn valid_cust_id(id: &str) -> bool {
    id.len() == 17
        && id.starts_with("cust_")
        && id[5..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `restoreCustomizations(customizations)`. The TS runs these through
/// `Promise.all`, whose interleaved `index.json` read-modify-writes lose
/// all but one record; here they run in order, so each lands.
fn restore_customizations(list: Option<&Value>) -> Result<(), Thrown> {
    let Some(Value::Array(items)) = list else {
        return Err(Thrown::type_error("customizations.map is not a function"));
    };
    let store = customizations::Store::from_env();
    for bundled in items {
        // `const { meta, publishedFiles } = bundled`.
        if bundled.is_null() {
            return Err(Thrown::type_error(
                "Cannot destructure property 'meta' of 'bundled' as it is null.",
            ));
        }
        let meta = opt(Some(bundled), "meta").cloned();
        let published = opt(Some(bundled), "publishedFiles").cloned();

        let id = member(meta.as_ref(), "id")?.cloned();
        if !valid_cust_id(&text(id.as_ref())) {
            let shown = match &id {
                None => "undefined".to_owned(),
                Some(v) => js_string::stringify(v),
            };
            return Err(Thrown::path_injection(&format!(
                "invalid customization id: {shown}"
            )));
        }
        let id = id.as_ref().and_then(Value::as_str).unwrap_or_default();

        store
            .upsert_customization_record(meta.as_ref().unwrap_or(&Value::Null))
            .map_err(|e| Thrown::error(e.to_string()))?;

        let src_dir = store.customization_src_dir(id);
        let Some(Value::Array(files)) = published.as_ref() else {
            return Err(Thrown::type_error(match published {
                None => "Cannot read properties of undefined (reading 'map')".to_owned(),
                Some(Value::Null) => "Cannot read properties of null (reading 'map')".to_owned(),
                Some(_) => "publishedFiles.map is not a function".to_owned(),
            }));
        };
        for f in files {
            // `async ({ path, content }) => …`: destructuring `null` rejects
            // (any other primitive just has no such keys).
            if f.is_null() {
                return Err(Thrown::type_error(
                    "Cannot destructure property 'path' of 'object null' as it is null.",
                ));
            }
            let content = opt(Some(f), "content");
            // `join(srcDir, path)` validates its arguments.
            let Some(Value::String(rel)) = opt(Some(f), "path") else {
                return Err(Thrown::type_error(format!(
                    "The \"path\" argument must be of type string. Received {}",
                    received(opt(Some(f), "path"))
                )));
            };
            let joined = node_path::join(&[&src_dir, rel]);
            let target =
                safe_path::assert_within(&src_dir, &joined).map_err(Thrown::path_injection)?;
            node_err::fs::mkdir_recursive(Path::new(&node_path::dirname(&target)))?;
            // `writeFile(target, content, "utf-8")` takes a string or any
            // iterable (an array: each chunk through `Buffer.from`); the
            // rest is refused before the file is opened.
            let chunks: Vec<&Value> = match content {
                Some(c @ Value::String(_)) => vec![c],
                Some(Value::Array(items)) => items.iter().collect(),
                other => {
                    return Err(Thrown::type_error(format!(
                        "The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received {}",
                        received(other)
                    )));
                }
            };
            let sink = node_path::resolve(&[&target]);
            if sink == src_dir {
                // A path that is `srcDir` itself (`""`, `"."`): `src/` is
                // a directory, so the open is EISDIR, as in the TS. A
                // missing `src/` the TS would create as a file; refused.
                if std::fs::metadata(&src_dir).is_ok_and(|m| m.is_dir()) {
                    let e = std::io::Error::from_raw_os_error(libc::EISDIR);
                    return Err(
                        node_err::uv_exception(&e, "open", Some(Path::new(&sink)), None).into(),
                    );
                }
                return Err(Thrown::path_injection("path escapes base directory"));
            }
            // Resolved against `src_dir` and checked right above the write.
            if !sink.starts_with(&format!("{src_dir}/")) {
                return Err(Thrown::path_injection("path escapes base directory"));
            }
            write_chunks(Path::new(&sink), &chunks)?;
        }
    }
    Ok(())
}

/// `fs.promises.writeFile(path, data)` for a string (one chunk) or an
/// array: the file is opened (created or truncated) first, then each chunk
/// is written in turn, so a chunk `Buffer.from` refuses leaves the ones
/// before it on disk.
fn write_chunks(path: &Path, chunks: &[&Value]) -> Result<(), Thrown> {
    use std::io::Write as _;
    let mut file = std::fs::File::create(path)
        .map_err(|e| node_err::uv_exception(&e, "open", Some(path), None))?;
    for chunk in chunks {
        let bytes = buffer_from(chunk)?;
        file.write_all(&bytes)
            .map_err(|e| node_err::uv_exception(&e, "write", None, None))?;
    }
    Ok(())
}

/// `Buffer.from(chunk, "utf8")`: a string's UTF-8, an array's elements as
/// bytes (`ToNumber`, then modulo 256). Anything else throws. (An object
/// with a `length`, or `{type: "Buffer", data}`, which Node also turns into
/// bytes, is refused here too.)
fn buffer_from(chunk: &Value) -> Result<Vec<u8>, Thrown> {
    match chunk {
        Value::String(s) => Ok(js_string::lossy(s).as_bytes().to_vec()),
        Value::Array(items) => Ok(items.iter().map(to_uint8).collect()),
        other => Err(Thrown::type_error(format!(
            "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received {}",
            received(Some(other))
        ))),
    }
}

/// `ToUint8(v)`, the byte a typed-array store keeps.
fn to_uint8(v: &Value) -> u8 {
    let n = match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        Value::String(s) => js::to_number(s),
        // `ToPrimitive` of an array is its `join(",")`; a plain object is
        // `"[object Object]"`.
        Value::Array(_) => js::to_number(&js::to_string(Some(v))),
        Value::Object(_) => f64::NAN,
    };
    if !n.is_finite() {
        return 0;
    }
    n.trunc().rem_euclid(256.0) as u8
}

/// Node's `determineSpecificType`: the tail of an `ERR_INVALID_ARG_TYPE`
/// message.
fn received(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => format!("type boolean ({b})"),
        Some(Value::Number(n)) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if x == 0.0 && x.is_sign_negative() {
                "type number (-0)".into()
            } else {
                format!("type number ({})", js::number_to_string(x))
            }
        }
        Some(Value::Array(_)) => "an instance of Array".into(),
        Some(Value::Object(_)) => "an instance of Object".into(),
        Some(Value::String(s)) => {
            let shown = if js_string::len16(s) > 28 {
                let head: Vec<u16> = s.encode_utf16().take(25).collect();
                format!("{}...", String::from_utf16_lossy(&head))
            } else {
                s.clone()
            };
            if shown.contains('\'') {
                format!("type string ({})", js_string::stringify(&json!(shown)))
            } else {
                format!("type string ('{shown}')")
            }
        }
    }
}

// ── hazards and commit ───────────────────────────────────────────────────

#[derive(Clone, Debug)]
enum Hazard {
    MissingRoot,
    NotADirectory(String),
    IdCollision(Value),
    PathCollision(Value),
}

/// `detectHazard(incoming, resolvedRootPath, existing)`: collisions first
/// (cheap, and a heal answer may point at a colliding workspace), then the
/// `stat`.
fn detect_hazard(
    incoming: Option<&Value>,
    resolved_root_path: &str,
    existing: &[Value],
) -> Result<Option<Hazard>, Thrown> {
    let incoming_id = member(incoming, "id")?.cloned();
    for w in existing {
        if strict_eq(member(Some(w), "id")?, incoming_id.as_ref()) {
            return Ok(Some(Hazard::IdCollision(w.clone())));
        }
    }
    let root = Value::String(resolved_root_path.to_owned());
    for w in existing {
        if strict_eq(member(Some(w), "rootPath")?, Some(&root)) {
            return Ok(Some(Hazard::PathCollision(w.clone())));
        }
    }
    match std::fs::metadata(resolved_root_path) {
        Ok(m) if !m.is_dir() => Ok(Some(Hazard::NotADirectory(resolved_root_path.to_owned()))),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Some(Hazard::MissingRoot)),
        Err(e) => {
            Err(
                node_err::uv_exception(&e, "stat", Some(Path::new(resolved_root_path)), None)
                    .into(),
            )
        }
    }
}

/// `shapePause(hazard, wsIndex, workspace)`.
fn shape_pause(hazard: &Hazard, ws_index: f64, workspace: &Value) -> Value {
    let i = crate::js_num(ws_index);
    match hazard {
        Hazard::MissingRoot => {
            json!({ "kind": "missing_root", "wsIndex": i, "workspace": workspace })
        }
        Hazard::NotADirectory(root) => json!({
            "kind": "not_a_directory", "wsIndex": i, "workspace": workspace, "rootPath": root,
        }),
        Hazard::IdCollision(existing) => json!({
            "kind": "id_collision", "wsIndex": i, "incoming": workspace, "existing": existing,
        }),
        Hazard::PathCollision(existing) => json!({
            "kind": "path_collision", "wsIndex": i, "incoming": workspace, "existing": existing,
        }),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Collision {
    Create,
    Update,
    Rename,
}

/// `commitWorkspace(ws, rootPath, collision, renameTo)`: create or update
/// the workspace, restore its icon (best effort), then write the bundle's
/// project / local settings into the now-known-good rootPath.
fn commit_workspace(
    ws: Option<&Value>,
    root_path: &str,
    collision: Collision,
    rename_to: Option<&Value>,
) -> Result<Map<String, Value>, Thrown> {
    let meta = member(ws, "meta")?.cloned();
    let meta = meta.as_ref();
    // `renameTo ?? meta.name`.
    let name = match rename_to.filter(|v| !v.is_null()) {
        Some(v) => Some(v.clone()),
        None => member(meta, "name")?.cloned(),
    };
    let carry: Vec<(&str, Option<Value>)> = vec![
        ("commitPrefix", member(meta, "commitPrefix")?.cloned()),
        ("kind", member(meta, "kind")?.cloned()),
        ("navOrder", member(meta, "navOrder")?.cloned()),
    ];
    let icon = member(meta, "icon")?.cloned();
    let defaults = member(meta, "defaults")?.cloned();
    let root_value = Value::String(root_path.to_owned());

    let create = |name: Option<&Value>| -> Result<Value, Thrown> {
        workspaces::create_raw_js(CreateInputJs {
            name,
            root_path: Some(&root_value),
            icon: icon.as_ref(),
            defaults: defaults.as_ref(),
        })
        .map_err(|e| Thrown::error(e.to_string()))?
        .map_err(Thrown::type_error)
    };

    let (id, action): (String, &str) = if collision == Collision::Update {
        let existing = workspaces::list_raw().map_err(|e| Thrown::error(e.to_string()))?;
        let meta_id = member(meta, "id")?.cloned();
        let mut found: Option<Value> = None;
        for w in &existing {
            if strict_eq(member(Some(w), "id")?, meta_id.as_ref())
                || strict_eq(member(Some(w), "rootPath")?, Some(&root_value))
            {
                found = Some(w.clone());
                break;
            }
        }
        match found {
            // The row vanished between detection and commit: create new.
            None => {
                let created = create(name.as_ref())?;
                (text(created.get("id")), "created")
            }
            Some(w) => {
                let id = text(w.get("id"));
                let mut patch: Vec<(&str, Option<Value>)> = vec![
                    ("name", name.clone()),
                    ("rootPath", Some(root_value.clone())),
                    ("icon", icon.clone()),
                    ("defaults", defaults.clone()),
                ];
                patch.extend(carry.iter().cloned());
                workspaces::update_raw_js(&id, &patch).map_err(|e| Thrown::error(e.to_string()))?;
                (id, "updated")
            }
        }
    } else {
        let created = create(name.as_ref())?;
        let id = text(created.get("id"));
        let action = if collision == Collision::Rename {
            "renamed"
        } else {
            "created"
        };
        // `Object.values(carryOver).some((v) => v !== undefined)`.
        if carry.iter().any(|(_, v)| v.is_some()) {
            workspaces::update_raw_js(&id, &carry).map_err(|e| Thrown::error(e.to_string()))?;
        }
        (id, action)
    };

    // Icon bytes under the *new* id — best effort, as the TS catch is silent.
    if let Some(bytes) = member(ws, "iconBytes")?.filter(|v| js::truthy(v)) {
        let ext = text(opt(Some(bytes), "ext"));
        if let Some(Value::String(b64)) = opt(Some(bytes), "base64") {
            let _ = workspaces::write_icon(&id, &ext, &asset_ingest::buffer_from_base64(b64));
        }
    }

    for (key, scope) in [
        ("projectSettings", Scope::Project),
        ("localSettings", Scope::Local),
    ] {
        let incoming = member(ws, key)?.cloned();
        if !incoming.as_ref().is_some_and(js::truthy) || own_keys_len(incoming.as_ref()) == 0 {
            continue;
        }
        let current = settings::read_settings_value(scope, root_path).map_err(thrown)?;
        let next = merge_deep(Some(&current), incoming.as_ref()).unwrap_or(Value::Null);
        settings::write_settings_value(scope, root_path, &next).map_err(thrown)?;
    }

    let mut entry = Map::new();
    entry.insert("wsIndex".into(), json!(-1));
    entry.insert("workspaceId".into(), json!(id));
    entry.insert("action".into(), json!(action));
    // `rootPath !== meta.rootPath` — the healed path is recorded.
    if !strict_eq(Some(&root_value), member(meta, "rootPath")?) {
        entry.insert(
            "note".into(),
            json!(format!("rootPath rewritten to {root_path}")),
        );
    }
    Ok(entry)
}

// ── public API ───────────────────────────────────────────────────────────

/// `startImport(bundle)`: a fresh session, written, then advanced.
pub fn start_import(bundle: &Value) -> Result<Value, Thrown> {
    let import_id = format!("imp_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
    let mut session = Map::new();
    session.insert("importId".into(), json!(import_id));
    session.insert("createdAt".into(), json!(now_ms()));
    session.insert("bundle".into(), bundle.clone());
    session.insert("mergeStrategy".into(), json!("merge"));
    session.insert("cursor".into(), json!(0));
    session.insert("systemDone".into(), json!(false));
    session.insert("decisions".into(), json!({}));
    session.insert("log".into(), json!([]));
    write_session(&Value::Object(session))?;
    advance(&import_id)
}

/// `getImportProgress(importId)`: `None` when there is no session file.
/// Side-effecting by design — it runs the worker, which is idempotent up to
/// the next hazard.
pub fn get_import_progress(import_id: &str) -> Result<Option<Value>, Thrown> {
    // `if (!session) return null`: a missing file, or one holding `null` /
    // `0` / `""` / `false`.
    let Some(session) = read_session(import_id)?.filter(js::truthy) else {
        return Ok(None);
    };
    // `session.cursor >= session.bundle.workspaces.length` — the property
    // reads throw (uncaught by the route) when `bundle` or `workspaces` is
    // missing.
    let list = member(member(Some(&session), "bundle")?, "workspaces")?.cloned();
    let total = length_of(list.as_ref())?;
    let cursor = opt(Some(&session), "cursor").and_then(Value::as_f64);
    let done = matches!((cursor, total), (Some(c), Some(t)) if c >= t)
        && opt(Some(&session), "systemDone").is_some_and(js::truthy);
    if done {
        return Ok(Some(progress_done(
            import_id,
            cursor,
            total,
            opt(Some(&session), "log").cloned(),
        )));
    }
    advance(import_id).map(Some)
}

/// `cancelImport(importId)`.
pub fn cancel_import(import_id: &str) {
    delete_session(import_id);
}

/// `resolve(importId, {wsIndex, decision})`: validate the decision, record
/// it on the session, then advance.
pub fn resolve(import_id: &str, ws_index: f64, decision: &Value) -> Result<Value, Thrown> {
    let Some(session) = read_session(import_id)?.filter(js::truthy) else {
        return Ok(error_progress(
            import_id,
            "import session not found",
            Some(json!([])),
        ));
    };
    let mut session = session;
    let log = opt(Some(&session), "log").cloned();
    let ws = index_of(
        member(member(Some(&session), "bundle")?, "workspaces")?,
        ws_index,
    );
    let Some(ws) = ws.filter(|v| js::truthy(v)).cloned() else {
        return Ok(error_progress(
            import_id,
            &format!("invalid wsIndex {}", js::number_to_string(ws_index)),
            log,
        ));
    };
    if kind_is(Some(decision), "heal")
        && let Err(message) = assert_absolute_user_path(opt(Some(decision), "newRootPath"))
    {
        return Ok(error_progress(import_id, message, log));
    }
    if kind_is(Some(decision), "rename") {
        // `input.decision.newName.trim()` throws on a missing newName.
        let Some(Value::String(new_name)) = opt(Some(decision), "newName") else {
            return Err(Thrown::type_error(format!(
                "Cannot read properties of {} (reading 'trim')",
                if matches!(opt(Some(decision), "newName"), Some(Value::Null)) {
                    "null"
                } else {
                    "undefined"
                }
            )));
        };
        if js::trim(new_name).is_empty() {
            return Ok(error_progress(import_id, "newName required", log));
        }
    }
    // `session.decisions[ws.meta.id] = input.decision`: the reads throw on a
    // missing `meta`, and so does the write on a missing `decisions`.
    let id = text(member(member(Some(&ws), "meta")?, "id")?);
    let of = match opt(Some(&session), "decisions") {
        None => Some("undefined"),
        Some(Value::Null) => Some("null"),
        Some(_) => None,
    };
    if let Some(of) = of {
        return Err(Thrown::type_error(format!(
            "Cannot set properties of {of} (setting '{id}')"
        )));
    }
    if let Some(decisions) = session
        .as_object_mut()
        .and_then(|m| m.get_mut("decisions"))
        .and_then(Value::as_object_mut)
        // `decisions["__proto__"] = …` runs the prototype setter, so the
        // decision is never stored. Mirrored.
        .filter(|_| id != "__proto__")
    {
        decisions.insert(id, decision.clone());
    }
    write_session(&session)?;
    advance(import_id)
}

/// `{state: "done", importId, processed, total, log}`, each `undefined`
/// field left out as `JSON.stringify` drops it.
fn progress_done(
    import_id: &str,
    processed: Option<f64>,
    total: Option<f64>,
    log: Option<Value>,
) -> Value {
    let mut m = Map::new();
    m.insert("state".into(), json!("done"));
    m.insert("importId".into(), json!(import_id));
    if let Some(p) = processed {
        m.insert("processed".into(), crate::js_num(p));
    }
    if let Some(t) = total {
        m.insert("total".into(), crate::js_num(t));
    }
    if let Some(log) = log {
        m.insert("log".into(), log);
    }
    Value::Object(m)
}

/// `{state: "error", importId, error, log}`; a session without a `log`
/// leaves the key out, as `JSON.stringify` drops `undefined`.
fn error_progress(import_id: &str, error: &str, log: Option<Value>) -> Value {
    let mut m = Map::new();
    m.insert("state".into(), json!("error"));
    m.insert("importId".into(), json!(import_id));
    m.insert("error".into(), json!(error));
    if let Some(log) = log {
        m.insert("log".into(), log);
    }
    Value::Object(m)
}

/// `arr[i]` for a numeric index (`ToPropertyKey` of a non-integer finds no
/// element).
fn index_of(v: Option<&Value>, i: f64) -> Option<&Value> {
    let items = v?.as_array()?;
    if i < 0.0 || i.fract() != 0.0 || !i.is_finite() {
        return None;
    }
    items.get(i as usize)
}

/// The worker loop — `advance(importId)`.
fn advance(import_id: &str) -> Result<Value, Thrown> {
    // Outside the `try`: a session file that doesn't parse throws.
    let Some(session) = read_session(import_id)?.filter(js::truthy) else {
        return Ok(error_progress(
            import_id,
            "import session not found",
            Some(json!([])),
        ));
    };
    let mut session = session;
    match run(&mut session, import_id) {
        Ok(progress) => Ok(progress),
        Err(e) => Ok(error_progress(
            import_id,
            &e.message,
            opt(Some(&session), "log").cloned(),
        )),
    }
}

/// The body of `advance`'s `try`.
fn run(session: &mut Value, import_id: &str) -> Result<Value, Thrown> {
    if !opt(Some(session), "systemDone").is_some_and(js::truthy) {
        merge_system(opt(Some(session), "bundle"))?;
        set(session, "systemDone", json!(true));
        write_session(session)?;
    }

    loop {
        let bundle = member(Some(session), "bundle")?.cloned();
        let list = member(bundle.as_ref(), "workspaces")?.cloned();
        let total = length_of(list.as_ref())?;
        let cursor = opt(Some(session), "cursor")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
        // `cursor < undefined` is `false`.
        let Some(total) = total else { break };
        if !matches!(cursor.partial_cmp(&total), Some(std::cmp::Ordering::Less)) {
            break;
        }
        let ws_index = cursor;
        let ws = index_of(list.as_ref(), ws_index).cloned();
        let meta_id = member(member(ws.as_ref(), "meta")?, "id")?.cloned();
        let decision = member(opt(Some(session), "decisions"), &text(meta_id.as_ref()))?.cloned();
        let decision = decision.as_ref();

        if kind_is(decision, "skip") {
            push_log(
                session,
                json!({
                    "wsIndex": crate::js_num(ws_index),
                    "workspaceId": meta_id.clone().unwrap_or(Value::Null),
                    "action": "skipped",
                }),
            )?;
            bump(session, cursor);
            write_session(session)?;
            continue;
        }

        let requested = if kind_is(decision, "heal") {
            opt(decision, "newRootPath").cloned()
        } else {
            member(member(ws.as_ref(), "meta")?, "rootPath")?.cloned()
        };
        let root_path = match assert_absolute_user_path(requested.as_ref()) {
            Ok(p) => p,
            Err(message) => {
                let name = text(member(member(ws.as_ref(), "meta")?, "name")?);
                return Ok(error_progress(
                    import_id,
                    &format!("{message} (workspace {name})"),
                    opt(Some(session), "log").cloned(),
                ));
            }
        };

        let existing = workspaces::list_raw().map_err(|e| Thrown::error(e.to_string()))?;
        let meta = member(ws.as_ref(), "meta")?.cloned();
        let hazard = detect_hazard(meta.as_ref(), &root_path, &existing)?;

        if let Some(hazard) = hazard {
            if kind_is(decision, "overwrite") {
                let mut entry = commit_workspace(ws.as_ref(), &root_path, Collision::Update, None)?;
                entry.insert("wsIndex".into(), crate::js_num(ws_index));
                push_log(session, Value::Object(entry))?;
                bump(session, cursor);
                write_session(session)?;
                continue;
            }
            if kind_is(decision, "rename") {
                let new_name = opt(decision, "newName").cloned();
                let mut entry = commit_workspace(
                    ws.as_ref(),
                    &root_path,
                    Collision::Rename,
                    new_name.as_ref(),
                )?;
                entry.insert("wsIndex".into(), crate::js_num(ws_index));
                push_log(session, Value::Object(entry))?;
                bump(session, cursor);
                write_session(session)?;
                continue;
            }
            let mut paused = Map::new();
            paused.insert("state".into(), json!("paused"));
            paused.insert("importId".into(), json!(import_id));
            paused.insert("processed".into(), crate::js_num(cursor));
            paused.insert("total".into(), crate::js_num(total));
            paused.insert(
                "pause".into(),
                shape_pause(&hazard, ws_index, meta.as_ref().unwrap_or(&Value::Null)),
            );
            if let Some(log) = opt(Some(session), "log").cloned() {
                paused.insert("log".into(), log);
            }
            return Ok(Value::Object(paused));
        }

        let mut entry = commit_workspace(ws.as_ref(), &root_path, Collision::Create, None)?;
        entry.insert("wsIndex".into(), crate::js_num(ws_index));
        if kind_is(decision, "heal") {
            entry.insert("action".into(), json!("healed"));
        }
        push_log(session, Value::Object(entry))?;
        bump(session, cursor);
        write_session(session)?;
    }

    let cursor = opt(Some(session), "cursor").and_then(Value::as_f64);
    let total = length_of(member(member(Some(session), "bundle")?, "workspaces")?)?;
    let done = progress_done(import_id, cursor, total, opt(Some(session), "log").cloned());
    delete_session(import_id);
    Ok(done)
}

fn set(session: &mut Value, key: &str, v: Value) {
    if let Some(m) = session.as_object_mut() {
        m.insert(key.into(), v);
    }
}

fn bump(session: &mut Value, cursor: f64) {
    set(session, "cursor", crate::js_num(cursor + 1.0));
}

/// `session.log.push(entry)` — a session without a `log` array throws, as
/// the TS property read does.
fn push_log(session: &mut Value, entry: Value) -> Result<(), Thrown> {
    let log = session.as_object_mut().and_then(|m| m.get_mut("log"));
    match log {
        Some(Value::Array(items)) => {
            items.push(entry);
            Ok(())
        }
        Some(Value::Null) => Err(Thrown::type_error(
            "Cannot read properties of null (reading 'push')",
        )),
        None => Err(Thrown::type_error(
            "Cannot read properties of undefined (reading 'push')",
        )),
        Some(_) => Err(Thrown::type_error("session.log.push is not a function")),
    }
}
