//! Claude Code `settings.json` read/write — port of the parts of
//! `lib/server/settings.ts` the session loop needs.
//!
//! Scopes resolve exactly like `pathFor`: user → `homedir()/.claude/settings.json`
//! (NOT `$CLAUDE_CONFIG_DIR`), project → `<cwd>/.claude/settings.json`,
//! local → `<cwd>/.claude/settings.local.json`, each `path.resolve`d.
//!
//! Errors carry the TS text byte for byte: a file `JSON.parse` refuses is
//! a `SettingsParseError` with V8's message through
//! `sanitizeJsonParseReason`, and an fs failure is Node's
//! (`EACCES: permission denied, open '…'`, [`crate::node_err`]). The file
//! is decoded as lossy UTF-8 like `readFile(path, "utf8")`, and parsed like
//! `JSON.parse`, so any JSON value is a settings value: callers see it the
//! way the TS callers do, through a spread ([`spread`]) or a property read
//! that throws on `null` ([`read_settings_js`]). Replayed against the TS in
//! `tests/settings_errors_golden.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::db_agents;
use crate::node_err::{self, NodeError};
use crate::paths;
use crate::settings_load_error::sanitize_json_parse_reason_utf16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    User,
    Project,
    Local,
}

impl Scope {
    pub fn parse(s: &str) -> Option<Scope> {
        match s {
            "user" => Some(Scope::User),
            "project" => Some(Scope::Project),
            "local" => Some(Scope::Local),
            _ => None,
        }
    }
}

/// `pathFor(scope, cwd)`. An empty or NUL-holding cwd, which `pathFor`
/// refuses, falls back to a plain join here; reads and writes refuse it.
pub fn path_for(scope: Scope, project_cwd: &str) -> PathBuf {
    settings_path(scope, project_cwd).unwrap_or_else(|_| {
        let (base, child) = parts(scope, project_cwd);
        Path::new(&base).join(child)
    })
}

fn parts(scope: Scope, project_cwd: &str) -> (String, &'static str) {
    match scope {
        Scope::User => (
            paths::claude_home().to_string_lossy().into_owned(),
            "settings.json",
        ),
        Scope::Project => (project_cwd.to_owned(), ".claude/settings.json"),
        Scope::Local => (project_cwd.to_owned(), ".claude/settings.local.json"),
    }
}

/// `pathFor`: `assertWithin(base, child)`, which refuses an empty base or a
/// NUL byte and `path.resolve`s the rest (against the process cwd if
/// relative, with `.`, `..` and repeated or trailing slashes folded).
fn settings_path(scope: Scope, project_cwd: &str) -> Result<PathBuf, SettingsError> {
    let (base, child) = parts(scope, project_cwd);
    if base.is_empty() {
        return Err(SettingsError::PathInjection("invalid base path"));
    }
    if base.contains('\0') {
        return Err(SettingsError::PathInjection("null byte in path"));
    }
    Ok(PathBuf::from(crate::trusted_cwd::resolve(&base)).join(child))
}

/// What `readSettings` / `writeSettings` throw. `Display` is the JS
/// `message`.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    /// `SettingsParseError`: the file exists but doesn't parse. `reason` is
    /// `sanitizeJsonParseReason(<V8's message>)`.
    #[error("{path} doesn't load: {reason}")]
    Parse { path: String, reason: String },
    /// The fs call's own error, in Node's words.
    #[error(transparent)]
    Io(#[from] NodeError),
    /// `PathInjectionError` from `pathFor`'s `assertWithin`.
    #[error("{0}")]
    PathInjection(&'static str),
}

impl SettingsError {
    /// The thrown error's `name`.
    pub fn name(&self) -> &'static str {
        match self {
            SettingsError::Parse { .. } => "SettingsParseError",
            SettingsError::Io(_) => "Error",
            SettingsError::PathInjection(_) => "PathInjectionError",
        }
    }
}

/// The `TypeError` message for reading `key` off a `null` settings value.
pub fn null_property_error(key: &str) -> String {
    format!("Cannot read properties of null (reading '{key}')")
}

/// `readSettings(scope, cwd)`'s value, with whether the file was a literal
/// `null` (a number past f64 also parses to `Value::Null`, but it's a
/// number in JS).
fn read_parsed(scope: Scope, project_cwd: &str) -> Result<(Value, bool), SettingsError> {
    read_parsed_with(scope, project_cwd, js::json_parse)
}

/// [`read_parsed`] with the text (which `JSON.parse` accepts) turned into a
/// value by `parse`.
fn read_parsed_with(
    scope: Scope,
    project_cwd: &str,
    parse: fn(&str) -> Result<Value, String>,
) -> Result<(Value, bool), SettingsError> {
    let path = settings_path(scope, project_cwd)?;
    let bytes = match node_err::fs::read_file(&path) {
        Ok(b) => b,
        Err(e) if e.code == "ENOENT" => return Ok((Value::Object(Map::new()), false)),
        Err(e) => return Err(e.into()),
    };
    let text = String::from_utf8_lossy(&bytes);
    let units: Vec<u16> = text.encode_utf16().collect();
    let parse_error = |reason: Vec<u16>| SettingsError::Parse {
        path: path.to_string_lossy().into_owned(),
        reason: char::decode_utf16(reason).filter_map(Result::ok).collect(),
    };
    if let Some(message) = js::json_parse_error_utf16(&units) {
        return Err(parse_error(sanitize_json_parse_reason_utf16(&message)));
    }
    match parse(&text) {
        Ok(v) => {
            let null = v.is_null()
                && text
                    .trim_start_matches([' ', '\t', '\n', '\r'])
                    .starts_with('n');
            Ok((v, null))
        }
        // Past serde_json's nesting limit (V8 has none).
        Err(message) => {
            let units: Vec<u16> = message.encode_utf16().collect();
            Err(parse_error(sanitize_json_parse_reason_utf16(&units)))
        }
    }
}

/// `readSettings(scope, cwd)`: `JSON.parse` of the file (any JSON value; a
/// number past f64 is `null`, which `JSON.stringify` prints for it), `{}`
/// when it's missing (ENOENT). A file that doesn't parse is an error, never
/// `{}`, so a later write can't clobber it.
pub fn read_settings_value(scope: Scope, project_cwd: &str) -> Result<Value, SettingsError> {
    read_parsed(scope, project_cwd).map(|(v, _)| v)
}

/// `readSettings` for a caller that reads properties off the value:
/// `Ok(None)` when the file holds `null`, where `settings.x` throws
/// [`null_property_error`]. Anything else is its [`spread`], since a
/// property read off an array, string, number or boolean finds no settings
/// key.
pub fn read_settings_js(
    scope: Scope,
    project_cwd: &str,
) -> Result<Option<Map<String, Value>>, SettingsError> {
    let (value, null) = read_parsed(scope, project_cwd)?;
    Ok((!null).then(|| spread(&value)))
}

/// `readSettings(scope, cwd)` and whether the file is a literal `null`. A
/// `Value::Null` that isn't one is a number past f64 (JS `±Infinity`), so
/// a caller can tell where JS throws (`settings.x`, `"x" in settings`).
pub fn read_settings_raw(scope: Scope, project_cwd: &str) -> Result<(Value, bool), SettingsError> {
    read_parsed(scope, project_cwd)
}

/// `{ ...await readSettings(scope, cwd) }`: what TS callers that spread
/// the value build from it (`null` → `{}`).
pub fn read_settings(scope: Scope, project_cwd: &str) -> Result<Map<String, Value>, SettingsError> {
    read_parsed(scope, project_cwd).map(|(v, _)| spread(&v))
}

/// `{ ...value }` for a JSON value: an object's own keys, an array's
/// indices, a string's UTF-16 units (half of an astral character is
/// U+FFFD here, a lone surrogate in JS); nothing for the rest.
pub fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(m) => m.clone(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::String(s) => s
            .chars()
            .flat_map(|c| match c.len_utf16() {
                1 => vec![c],
                _ => vec!['\u{fffd}'; 2],
            })
            .enumerate()
            .map(|(i, c)| (i.to_string(), Value::String(c.to_string())))
            .collect(),
        _ => Map::new(),
    }
}

static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// `writeSettings` — `JSON.stringify(next, null, 2)` + newline, atomic via
/// tmp+rename (but written in place through a symlink, preserving the
/// link), keeping the file's mode. Each step fails with Node's error:
/// recursive `mkdir`, the temp file's `open`, `chmod`, then `rename`; a
/// temp file left by a failed step is removed.
pub fn write_settings(
    scope: Scope,
    project_cwd: &str,
    next: &Map<String, Value>,
) -> Result<(), SettingsError> {
    write_settings_value(scope, project_cwd, &Value::Object(next.clone()))
}

/// [`write_settings`] of any JSON value (`PUT /api/settings/full` writes
/// whatever object or array it is given).
pub fn write_settings_value(
    scope: Scope,
    project_cwd: &str,
    next: &Value,
) -> Result<(), SettingsError> {
    let path = settings_path(scope, project_cwd)?;
    let dir = path.parent().unwrap_or(Path::new("/")).to_path_buf();
    node_err::fs::mkdir_recursive(&dir)?;
    let mut body = js::stringify_pretty(next);
    body.push('\n');
    let meta = node_err::fs::lstat(&path).ok();
    if meta.as_ref().is_some_and(|m| m.file_type().is_symlink()) {
        node_err::fs::write_file(&path, body.as_bytes())?;
        return Ok(());
    }
    let base = path.file_name().unwrap().to_string_lossy().into_owned();
    let tmp = dir.join(format!(
        ".{base}.tmp-{}-{}",
        std::process::id(),
        WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let res = (|| -> Result<(), NodeError> {
        node_err::fs::write_file(&tmp, body.as_bytes())?;
        #[cfg(unix)]
        if let Some(m) = &meta {
            use std::os::unix::fs::PermissionsExt;
            node_err::fs::chmod(&tmp, m.permissions().mode() & 0o777)?;
        }
        node_err::fs::rename(&tmp, &path)
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// `persistModelToUserSettings` — `/model` sticks across sessions. A read
/// or write failure is logged and skipped
/// ([`try_persist_model_to_user_settings`]).
pub fn persist_model_to_user_settings(cwd: &str, model: Option<&str>) {
    if let Err(e) = try_persist_model_to_user_settings(cwd, model) {
        tracing::error!(target: crate::log::SESSION, "[session.persistModelToUserSettings] write failed: {e}");
    }
}

/// The body of `persistModelToUserSettings`'s `try`: set (or, for `None`
/// or `""`, remove) `model`, skipping the write when it already matches.
/// `Err` is what TS logs: the read or write error, or the `TypeError` of
/// reading `model` off a `null` file.
pub fn try_persist_model_to_user_settings(cwd: &str, model: Option<&str>) -> Result<(), String> {
    let Some(mut current) = read_settings_js(Scope::User, cwd).map_err(|e| e.to_string())? else {
        return Err(null_property_error("model"));
    };
    // `current.model === (model || undefined)`.
    let desired = model.filter(|m| !m.is_empty());
    let unchanged = match desired {
        Some(m) => current.get("model").and_then(Value::as_str) == Some(m),
        None => !current.contains_key("model"),
    };
    if unchanged {
        return Ok(());
    }
    match desired {
        Some(m) => {
            current.insert("model".into(), Value::String(m.to_owned()));
        }
        None => {
            current.shift_remove("model");
        }
    }
    write_settings(Scope::User, cwd, &current).map_err(|e| e.to_string())
}

/// Set (`Some`) or remove (`None`) `advisorModel` in the user settings file —
/// the persist half of `POST /api/sessions/:id/advisor`. Best-effort: a read
/// or write failure is logged, never fatal (the mid-session apply still
/// runs).
pub fn persist_advisor_to_user_settings(cwd: &str, advisor: Option<&str>) {
    if let Err(e) = try_persist_advisor_to_user_settings(cwd, advisor) {
        tracing::error!(target: crate::log::API, "[api/sessions/advisor] settings write failed: {e}");
    }
}

/// The advisor route's `try`: `{ ...current }` (so a `null` file reads
/// `{}`) with `advisorModel` set or removed. `Err` is what TS logs.
pub fn try_persist_advisor_to_user_settings(
    cwd: &str,
    advisor: Option<&str>,
) -> Result<(), String> {
    let mut current = read_settings(Scope::User, cwd).map_err(|e| e.to_string())?;
    match advisor {
        Some(a) => {
            current.insert("advisorModel".into(), Value::String(a.to_owned()));
        }
        None => {
            current.shift_remove("advisorModel");
        }
    }
    write_settings(Scope::User, cwd, &current).map_err(|e| e.to_string())
}

/// Drop `advisorModel` from the user settings file if it's truthy — the
/// disk half of the advisor auto-disable (`applyFlagSettings({advisorModel:
/// null})` falls back to the file, so the file must be cleared too). A
/// failed read or write, or a `null` file, is returned so the caller can
/// log it under its own TS tag (`[session.setModel]` vs
/// `[session.advisor-compat]`).
pub fn clear_user_advisor_model(cwd: &str) -> Result<(), String> {
    let Some(mut current) = read_settings_js(Scope::User, cwd).map_err(|e| e.to_string())? else {
        return Err(null_property_error("advisorModel"));
    };
    if !current.get("advisorModel").is_some_and(js::truthy) {
        return Ok(());
    }
    current.shift_remove("advisorModel");
    write_settings(Scope::User, cwd, &current).map_err(|e| e.to_string())
}

// ─── The settings routes' helpers (D10) ──────────────────────────────────
//
// Values here are "twins": `JSON.parse`'s value with ±Infinity kept as
// [`db_agents`]'s sentinel strings, so `x ?? {}`, `x == null` and `Set`
// membership tell Infinity apart from `null` as JS does. [`plain`] is what
// `JSON.stringify` writes for one (each sentinel as `null`).

/// `readSettings(scope, cwd)` as a twin: `{}` when the file is missing, a
/// literal `null` as `Value::Null`, ±Infinity as sentinels.
pub fn read_settings_twin(scope: Scope, project_cwd: &str) -> Result<Value, SettingsError> {
    read_parsed_with(scope, project_cwd, db_agents::json_parse).map(|(v, _)| v)
}

/// A twin as `JSON.stringify` sees it: every ±Infinity sentinel is `null`.
pub fn plain(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(plain).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), plain(v))).collect()),
        v if db_agents::infinity(v).is_some() => Value::Null,
        v => v.clone(),
    }
}

/// `{ ...v }` of a twin ([`spread`]; ±Infinity is a number, so nothing).
pub fn spread_twin(v: &Value) -> Map<String, Value> {
    if db_agents::infinity(v).is_some() {
        return Map::new();
    }
    spread(v)
}

/// `{ ...(v ?? {}) }` of a property read (`None` is `undefined`).
pub fn spread_or_empty(v: Option<&Value>) -> Map<String, Value> {
    v.map_or_else(Map::new, spread_twin)
}

/// `v.key` on a `readSettings` value: `None` (`undefined`) unless it is an
/// object with that own key; a `null` file throws V8's `TypeError`. (The
/// keys read here are on no prototype.)
pub fn get_twin<'a>(v: &'a Value, key: &str) -> Result<Option<&'a Value>, UpdateError> {
    match v {
        Value::Null => Err(UpdateError::Type(null_property_error(key))),
        Value::Object(m) => Ok(m.get(key)),
        _ => Ok(None),
    }
}

/// `v ?? {}` (`None` is `undefined`).
pub fn or_empty(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(v) => v.clone(),
    }
}

/// What the settings helpers throw: [`SettingsError`] from the read or
/// write, or a `TypeError` (V8's message) reading a key off a `null` file.
#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error(transparent)]
    Settings(#[from] SettingsError),
    #[error("{0}")]
    Type(String),
}

impl UpdateError {
    /// The thrown error's `name`.
    pub fn name(&self) -> &'static str {
        match self {
            UpdateError::Settings(e) => e.name(),
            UpdateError::Type(_) => "TypeError",
        }
    }
}

/// `{ ...current, [key]: { ...(current[key] ?? {}), ...patch } }`, written
/// to `scope` and returned (a twin).
fn patch_key(
    scope: Scope,
    project_cwd: &str,
    key: &str,
    patch: &Value,
) -> Result<Value, UpdateError> {
    let current = read_settings_twin(scope, project_cwd)?;
    let mut inner = spread_or_empty(get_twin(&current, key)?);
    // `{...a, ...b}`: a key already there keeps its place.
    inner.extend(spread_twin(patch));
    let mut next = spread_twin(&current);
    next.insert(key.to_owned(), Value::Object(inner));
    let next = Value::Object(next);
    write_settings_value(scope, project_cwd, &plain(&next))?;
    Ok(next)
}

/// `updatePermissions(scope, cwd, patch)`: `patch` (an object or array)
/// spread over the scope's `permissions`.
pub fn update_permissions(
    scope: Scope,
    project_cwd: &str,
    patch: &Value,
) -> Result<Value, UpdateError> {
    patch_key(scope, project_cwd, "permissions", patch)
}

/// `updateAutoMode(cwd, patch)`: `patch` spread over the user scope's
/// `autoMode` (upstream reads it from `~/.claude/settings.json` only).
pub fn update_auto_mode(project_cwd: &str, patch: &Value) -> Result<Value, UpdateError> {
    patch_key(Scope::User, project_cwd, "autoMode", patch)
}

/// `resetAutoMode(cwd)`: drop the user scope's `autoMode` key, writing only
/// when `current.autoMode !== undefined`.
pub fn reset_auto_mode(project_cwd: &str) -> Result<Value, UpdateError> {
    let current = read_settings_twin(Scope::User, project_cwd)?;
    if get_twin(&current, "autoMode")?.is_none() {
        return Ok(current);
    }
    let mut next = spread_twin(&current);
    next.shift_remove("autoMode");
    let next = Value::Object(next);
    write_settings_value(Scope::User, project_cwd, &plain(&next))?;
    Ok(next)
}

/// The SDK's four `skillOverrides[name]` literals.
pub const SKILL_OVERRIDE_VALUES: [&str; 4] = ["on", "name-only", "user-invocable-only", "off"];

/// `isSkillOverrideValue(v)`.
pub fn is_skill_override_value(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|s| SKILL_OVERRIDE_VALUES.contains(&s))
}

/// `updateSkillOverride(cwd, name, value)` in the project scope: `"on"`
/// deletes the name's entry, anything else sets it (`overrides[name] =
/// value`, where a `__proto__` that isn't an own key runs the prototype
/// setter and adds nothing); an emptied `skillOverrides` is dropped.
pub fn update_skill_override(
    project_cwd: &str,
    name: &str,
    value: &str,
) -> Result<Value, UpdateError> {
    let current = read_settings_twin(Scope::Project, project_cwd)?;
    let mut overrides = spread_or_empty(get_twin(&current, "skillOverrides")?);
    if value == "on" {
        overrides.shift_remove(name);
    } else if name != "__proto__" || overrides.contains_key(name) {
        overrides.insert(name.to_owned(), Value::String(value.to_owned()));
    }
    let mut next = spread_twin(&current);
    if overrides.is_empty() {
        next.shift_remove("skillOverrides");
    } else {
        next.insert("skillOverrides".into(), Value::Object(overrides));
    }
    let next = Value::Object(next);
    write_settings_value(Scope::Project, project_cwd, &plain(&next))?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spreads_like_js() {
        let s = |v: Value| Value::Object(spread(&v));
        assert_eq!(s(json!({"a": 1})), json!({"a": 1}));
        assert_eq!(s(json!([1, {"b": 2}])), json!({"0": 1, "1": {"b": 2}}));
        assert_eq!(
            s(json!("a\u{e9}\u{1f600}")),
            json!({"0": "a", "1": "\u{e9}", "2": "\u{fffd}", "3": "\u{fffd}"})
        );
        for v in [json!(null), json!(5), json!(true), json!(""), json!([])] {
            assert_eq!(s(v), json!({}));
        }
    }

    #[test]
    fn twins_read_like_js() {
        let twin = |t: &str| db_agents::json_parse(t).unwrap();
        let inf = twin("1e400");
        assert_eq!(
            plain(&twin(r#"{"a":[1e400,-1e400,null,"x"],"b":{"c":1e400}}"#)),
            json!({"a": [null, null, null, "x"], "b": {"c": null}})
        );
        assert_eq!(spread_twin(&inf), Map::new());
        assert_eq!(
            Value::Object(spread_twin(&json!("ab"))),
            json!({"0": "a", "1": "b"})
        );
        assert_eq!(spread_or_empty(None), Map::new());
        assert_eq!(spread_or_empty(Some(&json!(null))), Map::new());
        assert_eq!(or_empty(Some(&inf)), inf);
        assert_eq!(or_empty(Some(&json!(null))), json!({}));
        assert_eq!(or_empty(None), json!({}));
        assert_eq!(or_empty(Some(&json!(false))), json!(false));
        assert!(matches!(
            get_twin(&json!(null), "k"),
            Err(UpdateError::Type(m)) if m == "Cannot read properties of null (reading 'k')"
        ));
        assert_eq!(get_twin(&json!({"k": 1}), "k").unwrap(), Some(&json!(1)));
        for v in [json!("k"), json!(["k"]), json!(1), inf] {
            assert_eq!(get_twin(&v, "k").unwrap(), None);
        }
        assert_eq!(UpdateError::Type(String::new()).name(), "TypeError");
        for v in SKILL_OVERRIDE_VALUES {
            assert!(is_skill_override_value(Some(&json!(v))));
        }
        for v in [json!("ON"), json!(""), json!(null), json!(["on"])] {
            assert!(!is_skill_override_value(Some(&v)));
        }
        assert!(!is_skill_override_value(None));
    }

    #[test]
    fn refuses_what_assert_within_refuses() {
        assert_eq!(
            settings_path(Scope::Project, ""),
            Err(SettingsError::PathInjection("invalid base path"))
        );
        assert_eq!(
            settings_path(Scope::Local, "/a\0b"),
            Err(SettingsError::PathInjection("null byte in path"))
        );
        assert_eq!(
            settings_path(Scope::Local, "/a//b/./c/../"),
            Ok(PathBuf::from("/a/b/.claude/settings.local.json"))
        );
        assert_eq!(
            path_for(Scope::Project, "").to_str(),
            Some(".claude/settings.json")
        );
        assert_eq!(
            SettingsError::PathInjection("x").name(),
            "PathInjectionError"
        );
    }
}
