//! `~/.claude/.claudius/workspaces.json`: port of
//! `lib/server/workspaces-store.ts`, plus the `listWorkspaceRoots` half of
//! `lib/server/workspace-roots.ts` that `GET /api/workspaces/:id/roots`
//! needs.
//!
//! The store is kept as the JSON value TS works on, not a typed struct, so
//! everything a file holds survives a read-modify-write exactly as
//! `JSON.parse` / `JSON.stringify(shape, null, 2)` round-trips it: unknown
//! keys, their order (array-index keys first), number text (`1.0` → `1`),
//! foreign entries (`5`, `"s"`, `{}`), lone surrogates ([`js_string`]).
//! Lookups follow the TS callbacks: `w.id === id` is strict equality, and
//! an entry that is `null` throws (`Cannot read properties of null`) where
//! the TS `find` / `filter` / `map` reaches it, which the routes turn into
//! Next's bare 500. The `*_raw` functions are the TS functions; the typed
//! [`Workspace`] API on top serves the session code.
//!
//! Writes are atomic (tmp + rename) after a `.bak.<ISO stamp>` snapshot,
//! keeping the last 10 backups by JS sort order. One process-wide lock
//! serializes each read-modify-write; TS runs them on one thread but can
//! interleave two requests' awaits and lose an update.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::js_string::{self, lossy};
use crate::{node_path, now_ms, paths};

const BACKUP_KEEP: usize = 10;
const PALETTE: [&str; 8] = [
    "#d97757", "#5588dd", "#9d6cdd", "#2e9d8f", "#dd8e44", "#cc5577", "#33aabb", "#7d8a4c",
];

/// Serializes the store's read-modify-writes.
static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub icon: Value,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<i64>,
    /// `WorkspaceDefaults` — kept as an open map; see [`Workspace::default_str`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Workspace {
    /// A store entry as the session code reads it: any object (missing or
    /// mistyped fields read as empty), its strings [`lossy`] the way the
    /// filesystem and the CLI see them. Anything else isn't a workspace.
    pub fn from_value(v: &Value) -> Option<Workspace> {
        let m = v.as_object()?;
        let text = |k: &str| {
            m.get(k)
                .and_then(Value::as_str)
                .map(|s| lossy(s).into_owned())
                .unwrap_or_default()
        };
        let num = |k: &str| m.get(k).and_then(Value::as_f64).map(|n| n as i64);
        let known = [
            "id",
            "name",
            "rootPath",
            "icon",
            "createdAt",
            "updatedAt",
            "lastOpenedAt",
            "defaults",
        ];
        Some(Workspace {
            id: text("id"),
            name: text("name"),
            root_path: text("rootPath"),
            icon: m
                .get("icon")
                .map(js_string::lossy_value)
                .unwrap_or(Value::Null),
            created_at: num("createdAt").unwrap_or(0),
            updated_at: num("updatedAt").unwrap_or(0),
            last_opened_at: num("lastOpenedAt"),
            defaults: m
                .get("defaults")
                .map(js_string::lossy_value)
                .and_then(|d| d.as_object().cloned()),
            extra: m
                .iter()
                .filter(|(k, _)| !known.contains(&k.as_str()))
                .map(|(k, v)| (lossy(k).into_owned(), js_string::lossy_value(v)))
                .collect(),
        })
    }
    pub fn default_value(&self, key: &str) -> Option<&Value> {
        self.defaults.as_ref()?.get(key)
    }
    pub fn default_str(&self, key: &str) -> Option<&str> {
        self.default_value(key)?.as_str()
    }
    pub fn is_customization(&self) -> bool {
        self.extra.get("kind").and_then(Value::as_str) == Some("customization")
    }
}

pub fn root_dir() -> PathBuf {
    paths::claudius_root()
}
pub fn workspaces_path() -> PathBuf {
    root_dir().join("workspaces.json")
}
pub fn icons_dir() -> PathBuf {
    root_dir().join("workspace-icons")
}

/// `colorFor` — 32-bit `h*31 + charCode` over UTF-16 units.
fn color_for(id: &str) -> &'static str {
    let mut h: u32 = 0;
    for u in js_string::units(id) {
        h = h.wrapping_mul(31).wrapping_add(u32::from(u));
    }
    PALETTE[(h as usize) % PALETTE.len()]
}

/// `defaultLetterIcon`: the first non-whitespace code unit, upper-cased
/// (`ß` → `SS`; an astral first character gives its lone high surrogate),
/// else `C`; the colour hashes the id.
pub fn default_letter_icon(name: &str, id: &str) -> Value {
    let letter = js_string::first_non_space_unit(name).unwrap_or_else(|| "C".into());
    json!({"kind": "letter", "letter": js_string::to_upper(&letter), "color": color_for(id)})
}

// ---- JS semantics of the store's callbacks -------------------------------------

/// `TypeError: Cannot read properties of null (reading 'id')`.
fn null_read(key: &str) -> anyhow::Error {
    anyhow!("Cannot read properties of null (reading '{key}')")
}

/// `w.id` for a store entry: `None` is `undefined` (a primitive, an array,
/// an object without the key); `null` throws.
fn member_id(w: &Value) -> anyhow::Result<Option<&Value>> {
    match w {
        Value::Null => Err(null_read("id")),
        Value::Object(m) => Ok(m.get("id")),
        _ => Ok(None),
    }
}

/// `a === b` for JSON values (`a` may be `undefined`): objects and arrays
/// are distinct references, never equal.
fn strict_eq(a: Option<&Value>, b: &Value) -> bool {
    match (a, b) {
        (Some(Value::Null), Value::Null) => true,
        (Some(Value::Bool(x)), Value::Bool(y)) => x == y,
        (Some(Value::Number(x)), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Value::String(y)) => x == y,
        _ => false,
    }
}

/// `workspaces.findIndex((w) => w.id === target)`.
fn find_index(ws: &[Value], target: &Value) -> anyhow::Result<Option<usize>> {
    for (i, w) in ws.iter().enumerate() {
        if strict_eq(member_id(w)?, target) {
            return Ok(Some(i));
        }
    }
    Ok(None)
}

fn workspaces_of(shape: &Map<String, Value>) -> &Vec<Value> {
    shape["workspaces"]
        .as_array()
        .expect("readShape only returns stores with an array")
}

fn workspaces_mut(shape: &mut Map<String, Value>) -> &mut Vec<Value> {
    shape
        .get_mut("workspaces")
        .and_then(Value::as_array_mut)
        .expect("readShape only returns stores with an array")
}

/// A `Set` / `Map` key: SameValueZero, with every object or array its own
/// identity.
#[derive(Debug)]
enum Key {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Ref,
}

impl Key {
    fn of(v: Option<&Value>) -> Key {
        match v {
            None => Key::Undefined,
            Some(Value::Null) => Key::Null,
            Some(Value::Bool(b)) => Key::Bool(*b),
            Some(Value::Number(n)) => Key::Num(n.as_f64().unwrap_or(f64::NAN)),
            Some(Value::String(s)) => Key::Str(s.clone()),
            Some(Value::Array(_) | Value::Object(_)) => Key::Ref,
        }
    }
    fn same(&self, other: &Key) -> bool {
        match (self, other) {
            (Key::Undefined, Key::Undefined) | (Key::Null, Key::Null) => true,
            (Key::Bool(a), Key::Bool(b)) => a == b,
            (Key::Num(a), Key::Num(b)) => a == b || (a.is_nan() && b.is_nan()),
            (Key::Str(a), Key::Str(b)) => a == b,
            _ => false,
        }
    }
}

// ---- the file ---------------------------------------------------------------

/// `readShape`: the parsed file when it is `{version: 1, workspaces: [..]}`,
/// `None` when it is missing (only ENOENT) or any other value. The text is
/// read as `fs.readFile(_, "utf8")` does (invalid bytes U+FFFD, a BOM kept,
/// so `JSON.parse` fails on it); a parse error, a `null` file and every
/// other read error throw.
fn read_shape() -> anyhow::Result<Option<Map<String, Value>>> {
    let path = workspaces_path();
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("open '{}'", path.display())),
    };
    let parsed = js_string::parse(&String::from_utf8_lossy(&bytes)).map_err(|e| anyhow!(e))?;
    match parsed {
        Value::Null => Err(null_read("version")),
        Value::Object(m)
            if m.get("version").and_then(Value::as_f64) == Some(1.0)
                && m.get("workspaces").is_some_and(Value::is_array) =>
        {
            Ok(Some(m))
        }
        _ => Ok(None),
    }
}

/// `ensureBootstrap`: the store, or a fresh `{version: 1, workspaces: []}`.
pub fn ensure_bootstrap() -> anyhow::Result<Map<String, Value>> {
    Ok(read_shape()?.unwrap_or_else(|| {
        let mut m = Map::new();
        m.insert("version".into(), json!(1));
        m.insert("workspaces".into(), json!([]));
        m
    }))
}

/// `readdir`: the entry names, sorted by bytes like libuv's `scandir`.
fn sorted_names(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Ok(names)
}

/// JS `Array.prototype.sort()` on strings: by UTF-16 code units.
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `new Date().toISOString().replace(/[:.]/g, "-")`.
fn backup_stamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H-%M-%S-%3fZ")
        .to_string()
}

/// `snapshotAndRotate`, best-effort: copy the file (through a symlink) to
/// `<file>.bak.<stamp>`, then unlink all but the last 10 `<file>.bak.*`
/// entries in JS sort order (a directory among them can't be unlinked and
/// stays).
fn snapshot_and_rotate(file: &Path) {
    if std::fs::metadata(file).is_err() {
        return;
    }
    let Some(dir) = file.parent() else { return };
    let base = file.file_name().unwrap().to_string_lossy().into_owned();
    let snap = dir.join(format!("{base}.bak.{}", backup_stamp()));
    if std::fs::copy(file, &snap).is_err() {
        return;
    }
    let Ok(names) = sorted_names(dir) else { return };
    let prefix = format!("{base}.bak.");
    let mut baks: Vec<String> = names
        .into_iter()
        .filter(|n| n.starts_with(&prefix))
        .collect();
    baks.sort_by(|a, b| utf16_cmp(a, b));
    let drop_n = baks.len().saturating_sub(BACKUP_KEEP);
    for d in &baks[..drop_n] {
        let _ = std::fs::remove_file(dir.join(d));
    }
}

/// `writeShape`: `JSON.stringify(shape, null, 2) + "\n"`, atomically.
fn write_shape(shape: &Map<String, Value>) -> anyhow::Result<()> {
    let file = workspaces_path();
    std::fs::create_dir_all(root_dir())
        .with_context(|| format!("mkdir '{}'", root_dir().display()))?;
    snapshot_and_rotate(&file);
    let tmp = file.with_file_name(format!(
        "workspaces.json.{}.{}.tmp",
        std::process::id(),
        now_ms()
    ));
    let text = js_string::stringify_pretty(&Value::Object(shape.clone())) + "\n";
    std::fs::write(&tmp, text).with_context(|| format!("open '{}'", tmp.display()))?;
    std::fs::rename(&tmp, &file).with_context(|| format!("rename '{}'", tmp.display()))?;
    Ok(())
}

// ---- the TS functions, on raw values ------------------------------------------

/// `listWorkspaces`: the entries as stored.
pub fn list_raw() -> anyhow::Result<Vec<Value>> {
    let _g = lock();
    Ok(workspaces_of(&ensure_bootstrap()?).clone())
}

/// `getWorkspace`.
pub fn get_raw(id: &str) -> anyhow::Result<Option<Value>> {
    get_raw_value(&json!(id))
}

/// `getWorkspace(id)` for an `id` of any JS type (a request body's): the
/// first entry whose `id` is `=== id`, so an object or array never matches.
pub fn get_raw_value(id: &Value) -> anyhow::Result<Option<Value>> {
    let _g = lock();
    let shape = ensure_bootstrap()?;
    let ws = workspaces_of(&shape);
    Ok(find_index(ws, id)?.map(|i| ws[i].clone()))
}

/// The `createWorkspace` input; `icon` / `defaults` are the body's values
/// (`None` is `undefined`).
pub struct CreateInput {
    pub name: String,
    pub root_path: String,
    pub icon: Option<Value>,
    pub defaults: Option<Value>,
}

/// `createWorkspace`: id `wks_` + 12 hex digits of a v4 UUID, `icon ??` the
/// letter icon, `defaults` = `{permissionMode: "auto", ...input.defaults}`.
/// TS reads `Date.now()` three times; one clock reading stamps all three
/// times here.
pub fn create_raw(input: CreateInput) -> anyhow::Result<Value> {
    let _g = lock();
    let mut shape = ensure_bootstrap()?;
    let id = format!("wks_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let icon = match input.icon {
        Some(v) if !v.is_null() => v,
        _ => default_letter_icon(&input.name, &id),
    };
    let mut defaults = Map::new();
    defaults.insert("permissionMode".into(), json!("auto"));
    if let Some(d) = &input.defaults {
        js_string::spread_into(&mut defaults, d);
    }
    let now = now_ms();
    let ws = json!({
        "id": id,
        "name": input.name,
        "rootPath": input.root_path,
        "icon": icon,
        "createdAt": now,
        "updatedAt": now,
        "lastOpenedAt": now,
        "defaults": defaults,
    });
    workspaces_mut(&mut shape).push(ws.clone());
    write_shape(&shape)?;
    Ok(ws)
}

/// `updateWorkspace`: `{...ws, ...patch, id, updatedAt: Date.now()}`, where
/// `patch` is any JSON value (a string spreads its code units).
pub fn update_raw(id: &str, patch: &Value) -> anyhow::Result<Option<Value>> {
    let _g = lock();
    let mut shape = ensure_bootstrap()?;
    let Some(idx) = find_index(workspaces_of(&shape), &json!(id))? else {
        return Ok(None);
    };
    let mut next = workspaces_of(&shape)[idx]
        .as_object()
        .cloned()
        .expect("a matched entry is an object");
    js_string::spread_into(&mut next, patch);
    next.insert("id".into(), json!(id));
    next.insert("updatedAt".into(), json!(now_ms()));
    let next = Value::Object(next);
    workspaces_mut(&mut shape)[idx] = next.clone();
    write_shape(&shape)?;
    Ok(Some(next))
}

/// `deleteWorkspace`: drop every entry with the id; an `activeId` naming it
/// moves to the first remaining entry's `id` (dropped when that is
/// `undefined`); then unlink every icon named `<id>.*`.
pub fn delete_raw(id: &str) -> anyhow::Result<bool> {
    let _g = lock();
    let mut shape = ensure_bootstrap()?;
    let target = json!(id);
    let mut next = Vec::new();
    for w in workspaces_of(&shape) {
        if !strict_eq(member_id(w)?, &target) {
            next.push(w.clone());
        }
    }
    if next.len() == workspaces_of(&shape).len() {
        return Ok(false);
    }
    let first_id = next
        .first()
        .and_then(Value::as_object)
        .and_then(|m| m.get("id"))
        .cloned();
    shape.insert("workspaces".into(), Value::Array(next));
    if strict_eq(shape.get("activeId"), &target) {
        match first_id {
            Some(v) => {
                shape.insert("activeId".into(), v);
            }
            None => {
                shape.shift_remove("activeId");
            }
        }
    }
    write_shape(&shape)?;
    let icons = icons_dir();
    let base = icons.to_string_lossy().into_owned();
    if let Ok(names) = sorted_names(&icons) {
        for f in names.iter().filter(|f| f.starts_with(&format!("{id}."))) {
            let target = node_path::resolve(&[&format!("{base}/{f}")]);
            if !target.starts_with(&format!("{base}/")) {
                continue;
            }
            let _ = std::fs::remove_file(&target);
        }
    }
    Ok(true)
}

/// `reorderWorkspaces`: `ids` must be a permutation of the entries' ids
/// (`Set` semantics: SameValueZero, objects never match); the error is the
/// TS message (`unknown id ${id}`, where `String(id)` itself can throw).
pub fn reorder_raw(ids: &[Value]) -> anyhow::Result<Result<(), String>> {
    let _g = lock();
    let mut shape = ensure_bootstrap()?;
    let ws = workspaces_of(&shape);
    if ids.len() != ws.len() {
        return Ok(Err("ids length does not match".into()));
    }
    let mut keys = Vec::with_capacity(ws.len());
    for w in ws {
        keys.push(Key::of(member_id(w)?));
    }
    let mut have: Vec<&Key> = Vec::new();
    for k in &keys {
        if !have.iter().any(|h| h.same(k)) {
            have.push(k);
        }
    }
    for id in ids {
        let k = Key::of(Some(id));
        match have.iter().position(|h| h.same(&k)) {
            Some(at) => {
                have.remove(at);
            }
            None => {
                let shown = js_string::to_js_string(id)
                    .map_err(|_| anyhow!("Cannot convert object to primitive value"))?;
                return Ok(Err(format!("unknown id {shown}")));
            }
        }
    }
    if !have.is_empty() {
        return Ok(Err("missing ids".into()));
    }
    // `new Map(ws.map((w) => [w.id, w]))`: the last entry for a key wins.
    let next: Vec<Value> = ids
        .iter()
        .map(|id| {
            let k = Key::of(Some(id));
            let at = keys.iter().rposition(|w| w.same(&k)).expect("validated");
            ws[at].clone()
        })
        .collect();
    shape.insert("workspaces".into(), Value::Array(next));
    write_shape(&shape)?;
    Ok(Ok(()))
}

/// `setActiveId`: `null` deletes `activeId`; an id no entry has is a no-op
/// (nothing written); otherwise `activeId` is set (in place, or appended)
/// and the entry's `lastOpenedAt` too.
pub fn set_active_id(id: Option<&str>) -> anyhow::Result<()> {
    let _g = lock();
    let mut shape = ensure_bootstrap()?;
    match id {
        None => {
            shape.shift_remove("activeId");
        }
        Some(id) => {
            let Some(idx) = find_index(workspaces_of(&shape), &json!(id))? else {
                return Ok(());
            };
            shape.insert("activeId".into(), json!(id));
            let mut entry = workspaces_of(&shape)[idx]
                .as_object()
                .cloned()
                .expect("a matched entry is an object");
            entry.insert("lastOpenedAt".into(), json!(now_ms()));
            workspaces_mut(&mut shape)[idx] = Value::Object(entry);
        }
    }
    write_shape(&shape)
}

/// `activeId ?? workspaces[0]?.id ?? null`; `None` is `null`.
fn hint_of(shape: &Map<String, Value>) -> Option<Value> {
    if let Some(v) = shape.get("activeId").filter(|v| !v.is_null()) {
        return Some(v.clone());
    }
    match workspaces_of(shape).first() {
        Some(Value::Object(m)) => m.get("id").filter(|v| !v.is_null()).cloned(),
        _ => None,
    }
}

/// `getActiveIdHint`.
pub fn active_id_hint_raw() -> anyhow::Result<Option<Value>> {
    let _g = lock();
    Ok(hint_of(&ensure_bootstrap()?))
}

/// `resolveActiveWorkspace` with the cookie's value: the entry whose `id` is
/// the cookie, else the one whose `id` is the (truthy) hint.
pub fn resolve_active_raw(cookie_id: Option<&str>) -> anyhow::Result<Option<Value>> {
    let _g = lock();
    let shape = ensure_bootstrap()?;
    let ws = workspaces_of(&shape);
    if let Some(c) = cookie_id.filter(|c| !c.is_empty())
        && let Some(i) = find_index(ws, &json!(c))?
    {
        return Ok(Some(ws[i].clone()));
    }
    let hint = hint_of(&ensure_bootstrap()?);
    match hint.filter(claudius_agent::js::truthy) {
        Some(h) => Ok(find_index(ws, &h)?.map(|i| ws[i].clone())),
        None => Ok(None),
    }
}

/// `iconExt`: the rest of the first entry (in `readdir` order) named
/// `<id>.*`.
pub fn icon_ext(id: &str) -> Option<String> {
    let prefix = format!("{id}.");
    let names = sorted_names(&icons_dir()).ok()?;
    names
        .iter()
        .find_map(|f| f.strip_prefix(&prefix).map(str::to_owned))
}

/// `readIcon`: the bytes and extension, or `None` (no icon, an empty
/// extension, or a read error such as a directory).
pub fn read_icon(id: &str) -> Option<(Vec<u8>, String)> {
    let ext = icon_ext(id).filter(|e| !e.is_empty())?;
    let base = icons_dir().to_string_lossy().into_owned();
    let target = node_path::resolve(&[&format!("{base}/{id}.{ext}")]);
    if !target.starts_with(&format!("{base}/")) {
        return None;
    }
    std::fs::read(lossy(&target).as_ref())
        .ok()
        .map(|b| (b, ext))
}

/// `writeIcon`: `mkdir -p` the icon dir, unlink every `<id>.*` there, write
/// `<id>.<ext>`. `path.join` normalizes the name, so an id with `/..` in it
/// would leave the icon dir in TS; here that write is refused (an `Err`).
pub fn write_icon(id: &str, ext: &str, bytes: &[u8]) -> anyhow::Result<()> {
    let icons = icons_dir();
    std::fs::create_dir_all(&icons).with_context(|| format!("mkdir '{}'", icons.display()))?;
    let base = icons.to_string_lossy().into_owned();
    if let Ok(names) = sorted_names(&icons) {
        for f in names.iter().filter(|f| f.starts_with(&format!("{id}."))) {
            let old = node_path::resolve(&[&format!("{base}/{f}")]);
            if !old.starts_with(&format!("{base}/")) {
                continue;
            }
            let _ = std::fs::remove_file(&old);
        }
    }
    let target = node_path::resolve(&[&format!("{base}/{id}.{ext}")]);
    if !target.starts_with(&format!("{base}/")) {
        bail!("icon path escapes {base}: {target}");
    }
    std::fs::write(lossy(&target).as_ref(), bytes)
        .with_context(|| format!("open '{}'", lossy(&target)))
}

// ---- workspace roots ----------------------------------------------------------

/// `listWorkspaceRoots(ws)`: `primary` (`resolve(ws.rootPath)`), then each
/// non-blank string of `ws.defaults?.additionalDirectories` (an array, or a
/// string's code points), then of the project `settings.json`'s
/// `permissions.additionalDirectories` (an array), resolved against the
/// process cwd and deduped, as `{id, absPath, source}` with ids `extra:<n>`.
/// A non-string `rootPath` or a non-iterable workspace list throws; any
/// failure reading the settings (no file is `{}`; a directory, bad JSON, a
/// `null` file, a primary `"/"` or with a NUL that `assertWithin` rejects)
/// just skips them.
pub fn list_workspace_roots(ws: &Value) -> anyhow::Result<Vec<Value>> {
    let Some(root_path) = ws.get("rootPath").and_then(Value::as_str) else {
        bail!("The \"paths[0]\" argument must be of type string");
    };
    let primary = node_path::resolve(&[root_path]);
    let mut out = vec![json!({"id": "primary", "absPath": primary, "source": "primary"})];
    let mut seen = vec![primary.clone()];
    let mut add = |raw: &Value, source: &str, out: &mut Vec<Value>| {
        let Some(raw) = raw
            .as_str()
            .filter(|s| !claudius_agent::js::trim(s).is_empty())
        else {
            return;
        };
        let abs = node_path::resolve(&[raw]);
        if seen.contains(&abs) {
            return;
        }
        seen.push(abs.clone());
        let id = format!("extra:{}", out.len() - 1);
        out.push(json!({"id": id, "absPath": abs, "source": source}));
    };
    let from_workspace = match ws.get("defaults") {
        Some(Value::Object(d)) => d.get("additionalDirectories").filter(|v| !v.is_null()),
        _ => None,
    };
    match from_workspace {
        None => {}
        Some(Value::Array(items)) => {
            for raw in items {
                add(raw, "workspace", &mut out);
            }
        }
        Some(Value::String(s)) => {
            for raw in js_string::code_points(s) {
                add(&Value::String(raw), "workspace", &mut out);
            }
        }
        Some(_) => bail!("fromWorkspace is not iterable"),
    }
    for raw in &project_additional_dirs(&primary) {
        add(raw, "settings", &mut out);
    }
    Ok(out)
}

/// `readSettings("project", primary).permissions?.additionalDirectories`
/// when it is an array; none where it isn't or the TS `try` catches.
fn project_additional_dirs(primary: &str) -> Vec<Value> {
    // `pathFor` → `assertWithin(primary, ".claude/settings.json")`.
    if primary.contains('\0') {
        return Vec::new();
    }
    let target = node_path::resolve(&[primary, ".claude/settings.json"]);
    if !target.starts_with(&format!("{primary}/")) {
        return Vec::new();
    }
    let Ok(bytes) = std::fs::read(lossy(&target).as_ref()) else {
        return Vec::new();
    };
    let Ok(settings) = js_string::parse(&String::from_utf8_lossy(&bytes)) else {
        return Vec::new();
    };
    match settings
        .get("permissions")
        .and_then(|p| p.get("additionalDirectories"))
    {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

// ---- typed API for the session code ---------------------------------------------

pub fn list() -> anyhow::Result<Vec<Workspace>> {
    Ok(list_raw()?
        .iter()
        .filter_map(Workspace::from_value)
        .collect())
}

pub fn get(id: &str) -> anyhow::Result<Option<Workspace>> {
    Ok(get_raw(id)?.as_ref().and_then(Workspace::from_value))
}

pub fn find_by_root(root: &str) -> anyhow::Result<Option<Workspace>> {
    Ok(list()?.into_iter().find(|w| w.root_path == root))
}

pub struct NewWorkspace {
    pub name: String,
    pub root_path: String,
    pub icon: Option<Value>,
    pub defaults: Option<Map<String, Value>>,
}

pub fn create(input: NewWorkspace) -> anyhow::Result<Workspace> {
    let ws = create_raw(CreateInput {
        name: input.name,
        root_path: input.root_path,
        icon: input.icon,
        defaults: input.defaults.map(Value::Object),
    })?;
    Workspace::from_value(&ws).context("created workspace")
}

/// Shallow-merge `patch` (camelCase JSON) into the workspace; `id` is pinned.
pub fn update(id: &str, patch: Map<String, Value>) -> anyhow::Result<Option<Workspace>> {
    Ok(update_raw(id, &Value::Object(patch))?
        .as_ref()
        .and_then(Workspace::from_value))
}

pub fn delete(id: &str) -> anyhow::Result<bool> {
    delete_raw(id)
}

pub fn reorder(ids: &[String]) -> anyhow::Result<Result<(), String>> {
    let ids: Vec<Value> = ids.iter().map(|s| json!(s)).collect();
    reorder_raw(&ids)
}

pub fn active_id_hint() -> anyhow::Result<Option<String>> {
    Ok(active_id_hint_raw()?.and_then(|v| v.as_str().map(|s| lossy(s).into_owned())))
}

/// `resolveActiveWorkspace` — cookie id first, then the stored hint.
pub fn resolve_active(cookie_id: Option<&str>) -> anyhow::Result<Option<Workspace>> {
    Ok(resolve_active_raw(cookie_id)?
        .as_ref()
        .and_then(Workspace::from_value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_matches_ts_hash() {
        // node: PALETTE[[..."wks_abc"].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 8]
        assert_eq!(color_for("wks_abc"), "#9d6cdd");
        assert_eq!(color_for(""), "#d97757");
    }

    #[test]
    fn from_value_reads_any_object() {
        let raw = r##"{"id":"wks_1","name":"A","rootPath":"/a\ud800","icon":{"kind":"letter","letter":"A","color":"#fff"},"createdAt":1.5,"updatedAt":2,"kind":"customization","navOrder":["x"],"defaults":{"permissionMode":"auto","futureKey":true}}"##;
        let w = Workspace::from_value(&js_string::parse(raw).unwrap()).unwrap();
        assert_eq!(w.root_path, "/a\u{FFFD}");
        assert_eq!(w.created_at, 1);
        assert_eq!(w.last_opened_at, None);
        assert_eq!(w.default_str("permissionMode"), Some("auto"));
        assert!(w.is_customization());
        assert_eq!(w.extra["navOrder"], json!(["x"]));
        assert_eq!(Workspace::from_value(&json!(5)), None);
        let empty = Workspace::from_value(&json!({})).unwrap();
        assert_eq!((empty.id.as_str(), empty.defaults), ("", None));
    }

    #[test]
    fn strict_equality_and_set_keys() {
        assert!(strict_eq(Some(&json!(7)), &json!(7.0)));
        assert!(!strict_eq(Some(&json!("7")), &json!(7)));
        assert!(!strict_eq(None, &Value::Null));
        assert!(!strict_eq(Some(&json!({})), &json!({})));
        assert!(Key::of(None).same(&Key::of(None)));
        assert!(!Key::of(Some(&json!([]))).same(&Key::of(Some(&json!([])))));
        assert!(Key::of(Some(&json!(-0.0))).same(&Key::of(Some(&json!(0)))));
    }

    #[test]
    fn backups_sort_by_utf16() {
        let mut v = vec!["b.\u{FF5E}", "b.\u{1F600}", "b.Z", "b."];
        v.sort_by(|a, b| utf16_cmp(a, b));
        assert_eq!(v, vec!["b.", "b.Z", "b.\u{1F600}", "b.\u{FF5E}"]);
    }
}
