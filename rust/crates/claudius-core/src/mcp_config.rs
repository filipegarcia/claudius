//! MCP server config files: port of `lib/server/mcp.ts` (`listConfigured`,
//! `upsertServer`, `removeServer`, `findConfigWhitespaceWarnings`), behind
//! `GET/POST /api/mcp` and `DELETE /api/mcp/[name]`.
//!
//! Where a scope's servers live:
//! * user: `mcpServers` in `homedir()/.claude/settings.json` (read and
//!   written), then `homedir()/.claude/mcp.json` (read only; a name the
//!   settings file already has is skipped);
//! * project: `mcpServers` in `<cwd>/.mcp.json`;
//! * local: `mcpServers` in `<cwd>/.claude/settings.local.json`.
//!
//! The files are parsed as `JSON.parse` reads them (any JSON value, lossy
//! UTF-8, a leading BOM is a syntax error) and rewritten as
//! `JSON.stringify(value, null, 2) + "\n"`, so numbers, key order and the
//! untouched rest of the file come out as the TS writes them. A `.mcp.json`
//! that is empty or only whitespace counts as missing; an empty settings
//! file doesn't parse. The settings files go through
//! [`settings::write_settings`] (atomic, through symlinks, mode kept); a
//! `.mcp.json` is written in place, like `fs.writeFile`.
//!
//! The odd shapes follow the JS the TS runs on them: `name in servers`
//! also finds `Object.prototype` (and, for an array, `Array.prototype`)
//! names, so deleting `toString` rewrites the file and reports success;
//! deleting an array index leaves a hole (`null`); a string `mcpServers`
//! spreads into one entry per UTF-16 unit; and where JS throws a
//! `TypeError` (`in` on a primitive, a property set on a primitive file,
//! a `null` settings file) the call fails ([`McpConfigError::Type`]).

use std::path::{Path, PathBuf};

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::settings::{self, Scope};
use crate::{paths, safe_path};

/// `Object.getOwnPropertyNames(Object.prototype)` (node 22): what
/// `key in object` finds on every object besides its own keys.
pub const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `Object.getOwnPropertyNames(Array.prototype)` (node 22), `length`
/// included: what `key in array` finds besides its indexes.
pub const ARRAY_PROTOTYPE_KEYS: [&str; 40] = [
    "length",
    "constructor",
    "at",
    "concat",
    "copyWithin",
    "fill",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "lastIndexOf",
    "pop",
    "push",
    "reverse",
    "shift",
    "unshift",
    "slice",
    "sort",
    "splice",
    "includes",
    "indexOf",
    "join",
    "keys",
    "entries",
    "values",
    "forEach",
    "filter",
    "flat",
    "flatMap",
    "map",
    "every",
    "some",
    "reduce",
    "reduceRight",
    "toReversed",
    "toSorted",
    "toSpliced",
    "with",
    "toLocaleString",
    "toString",
];

/// Why a config call failed. The routes answer every one of them like the
/// TS handler that threw: Next's empty 500.
#[derive(Debug, thiserror::Error)]
pub enum McpConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// `readJson`'s `JSON.parse` threw (V8's message).
    #[error("SyntaxError: {0}")]
    Parse(String),
    /// `readSettings`' `SettingsParseError`.
    #[error("{path} doesn't load: {reason}")]
    SettingsParse { path: String, reason: String },
    /// Where the JS throws a `TypeError` (V8's message).
    #[error("TypeError: {0}")]
    Type(String),
    #[error(transparent)]
    Write(#[from] settings::SettingsError),
    /// `assertWithin`'s `PathInjectionError` ([`safe_path`]), by message.
    #[error("{0}")]
    PathInjection(&'static str),
}

type Result<T> = std::result::Result<T, McpConfigError>;

/// A configured server, as `listConfigured` lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfiguredServer {
    pub scope: Scope,
    pub name: String,
    /// The value as the file holds it (any JSON value).
    pub config: Value,
    /// `findConfigWhitespaceWarnings(config)`; left out of the JSON when
    /// empty.
    pub warnings: Vec<String>,
}

impl ConfiguredServer {
    /// `{scope, name, config, warnings?}`, in the TS key order.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("scope".into(), json!(scope_name(self.scope)));
        o.insert("name".into(), json!(self.name));
        o.insert("config".into(), self.config.clone());
        if !self.warnings.is_empty() {
            o.insert("warnings".into(), json!(self.warnings));
        }
        Value::Object(o)
    }
}

fn scope_name(scope: Scope) -> &'static str {
    match scope {
        Scope::User => "user",
        Scope::Project => "project",
        Scope::Local => "local",
    }
}

/// `homedir()/.claude`.
fn claude_home() -> String {
    paths::claude_home().to_string_lossy().into_owned()
}

/// The base directory and the relative path of a scope's settings file,
/// as `pathFor` builds it.
fn settings_file(scope: Scope, cwd: &str) -> (String, &'static str) {
    match scope {
        Scope::User => (claude_home(), "settings.json"),
        Scope::Project => (cwd.to_owned(), ".claude/settings.json"),
        Scope::Local => (cwd.to_owned(), ".claude/settings.local.json"),
    }
}

/// `projectMcpJsonPath(cwd)`: `assertWithin(cwd, ".mcp.json")`.
pub fn project_mcp_json_path(cwd: &str) -> Option<PathBuf> {
    safe_path::assert_within(cwd, ".mcp.json")
        .ok()
        .map(PathBuf::from)
}

/// `userMcpJsonPath()`: `assertWithin(homedir()/.claude, "mcp.json")`.
pub fn user_mcp_json_path() -> Option<PathBuf> {
    safe_path::assert_within(&claude_home(), "mcp.json")
        .ok()
        .map(PathBuf::from)
}

/// `fs.readFile(assertWithin(base, rel), "utf8")`: the path read, and
/// `None` for a missing file, invalid UTF-8 as U+FFFD (a BOM is kept).
/// `assertWithin` refuses a base that resolves to `/` (TS checks for
/// `"/" + sep`), so a `/` workspace can't read its `.mcp.json`.
fn read_text(base: &str, rel: &str) -> Result<(String, Option<String>)> {
    let target = safe_path::assert_within(base, rel).map_err(McpConfigError::PathInjection)?;
    match std::fs::read(&target) {
        Ok(bytes) => Ok((target, Some(String::from_utf8_lossy(&bytes).into_owned()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((target, None)),
        Err(e) => Err(e.into()),
    }
}

/// `readJson(p)`: `None` for a missing file or one that is empty or only
/// (JS) whitespace, else `JSON.parse` of it.
fn read_json(base: &str, rel: &str) -> Result<Option<Value>> {
    let (_, Some(text)) = read_text(base, rel)? else {
        return Ok(None);
    };
    if js::trim(&text).is_empty() {
        return Ok(None);
    }
    js::json_parse(&text)
        .map(Some)
        .map_err(McpConfigError::Parse)
}

/// `writeJson(p, value)`: `JSON.stringify(value, null, 2) + "\n"`, written
/// in place (through a symlink, keeping the mode) after `mkdir -p` of its
/// directory.
fn write_json(base: &str, rel: &str, value: &Value) -> Result<()> {
    let target = safe_path::assert_within(base, rel).map_err(McpConfigError::PathInjection)?;
    if let Some(dir) = Path::new(&target).parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&target, format!("{}\n", js::stringify_pretty(value)))?;
    Ok(())
}

/// `readSettings(scope, cwd)` as the TS gets it: the parsed value, of any
/// type (`{}` for a missing file).
fn read_settings_value(scope: Scope, cwd: &str) -> Result<Value> {
    let (base, rel) = settings_file(scope, cwd);
    let (path, Some(text)) = read_text(&base, rel)? else {
        return Ok(json!({}));
    };
    js::json_parse(&text).map_err(|reason| McpConfigError::SettingsParse { path, reason })
}

/// `settings.mcpServers` with no `?.`: a `null` settings file throws.
fn settings_servers(settings: &Value) -> Result<Option<&Value>> {
    match settings {
        Value::Null => Err(McpConfigError::Type(
            "Cannot read properties of null (reading 'mcpServers')".into(),
        )),
        Value::Object(m) => Ok(m.get("mcpServers")),
        _ => Ok(None),
    }
}

/// `key in v`: own keys and the prototype's names; a primitive throws.
fn js_in(key: &str, v: &Value) -> Result<bool> {
    match v {
        Value::Object(m) => Ok(m.contains_key(key) || OBJECT_PROTOTYPE_KEYS.contains(&key)),
        Value::Array(a) => Ok(js::array_index(key).is_some_and(|i| (i as usize) < a.len())
            || ARRAY_PROTOTYPE_KEYS.contains(&key)
            || OBJECT_PROTOTYPE_KEYS.contains(&key)),
        _ => Err(McpConfigError::Type(format!(
            "Cannot use 'in' operator to search for '{key}' in {}",
            js::to_string(Some(v))
        ))),
    }
}

/// `delete v[key]` in strict mode, once `key in v` holds: an own key goes
/// (the rest keep their order), an array index leaves a hole (which
/// `JSON.stringify` writes as `null`), an array's `length` throws, and a
/// prototype name is left alone.
fn js_delete(v: &mut Value, key: &str) -> Result<()> {
    match v {
        Value::Object(m) => {
            m.shift_remove(key);
        }
        Value::Array(a) => match js::array_index(key).map(|i| i as usize) {
            Some(i) if i < a.len() => a[i] = Value::Null,
            _ if key == "length" => {
                return Err(McpConfigError::Type(
                    "Cannot delete property 'length' of [object Array]".into(),
                ));
            }
            _ => {}
        },
        _ => {}
    }
    Ok(())
}

/// One UTF-16 unit of a string as a JS string: a lone surrogate (half of
/// an astral character) can't be a Rust `char`, so it becomes U+FFFD.
fn unit_string(unit: u16) -> Value {
    Value::String(
        char::from_u32(u32::from(unit))
            .unwrap_or('\u{FFFD}')
            .to_string(),
    )
}

/// `Object.entries(v)`: an object's own keys (array indexes first), an
/// array's items, a string's UTF-16 units; nothing for anything else.
fn entries(v: &Value) -> Vec<(String, Value)> {
    match v {
        Value::Object(m) => js::own_keys_order(m)
            .into_iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        Value::Array(a) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::String(s) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, u)| (i.to_string(), unit_string(u)))
            .collect(),
        _ => Vec::new(),
    }
}

/// `{...v}`: the same own entries, as a fresh object.
fn spread(v: &Value) -> Map<String, Value> {
    entries(v).into_iter().collect()
}

/// `String(v)` (and `ToPropertyKey`) for a JSON value. An object with an
/// own `toString` key throws: that value isn't callable, and
/// `Object.prototype.valueOf` returns the object, which isn't a primitive.
/// An array joins its items (`null` as `""`), so one holding such an
/// object throws too.
pub fn property_key(v: &Value) -> Result<String> {
    match v {
        Value::Object(m) if m.contains_key("toString") => Err(McpConfigError::Type(
            "Cannot convert object to primitive value".into(),
        )),
        Value::Array(items) => Ok(items
            .iter()
            .map(|item| match item {
                Value::Null => Ok(String::new()),
                item => property_key(item),
            })
            .collect::<Result<Vec<_>>>()?
            .join(",")),
        v => Ok(js::to_string(Some(v))),
    }
}

/// `/^\s|\s$/.test(String(v))`.
fn has_edge_whitespace(v: &Value) -> Result<bool> {
    let s = property_key(v)?;
    Ok(s.starts_with(js::is_whitespace) || s.ends_with(js::is_whitespace))
}

/// `findConfigWhitespaceWarnings(config)`: every `url`, `command` and
/// `env` (else `headers`) key and value whose text starts or ends with JS
/// whitespace, in that order. A primitive config throws (`"url" in
/// config`).
pub fn find_config_whitespace_warnings(config: &Value) -> Result<Vec<String>> {
    let mut warnings = Vec::new();
    // `value != null && HAS_EDGE_WHITESPACE.test(value)`
    let mut flag = |label: &str, value: Option<&Value>| -> Result<()> {
        if let Some(v) = value.filter(|v| !v.is_null())
            && has_edge_whitespace(v)?
        {
            warnings.push(format!("{label} has leading/trailing whitespace"));
        }
        Ok(())
    };
    let get = |key: &str| js::prop(Some(config), key);
    if js_in("url", config)? {
        flag("url", get("url"))?;
    }
    if js_in("command", config)? {
        flag("command", get("command"))?;
    }
    let has_env = js_in("env", config)?;
    let record = if has_env {
        get("env")
    } else if js_in("headers", config)? {
        get("headers")
    } else {
        None
    };
    let label = if has_env { "env" } else { "header" };
    if let Some(record) = record.filter(|r| js::truthy(r)) {
        for (key, value) in entries(record) {
            flag(
                &format!("{label} key \"{key}\""),
                Some(&Value::String(key.clone())),
            )?;
            flag(&format!("{label} value for \"{key}\""), Some(&value))?;
        }
    }
    Ok(warnings)
}

/// `listConfigured(cwd)`: the user scope's settings.json servers, then
/// `~/.claude/mcp.json`'s (minus names already listed), then the
/// project's `.mcp.json`, then the local settings, each with its
/// whitespace warnings.
pub fn list_configured(cwd: &str) -> Result<Vec<ConfiguredServer>> {
    let mut out: Vec<ConfiguredServer> = Vec::new();
    let push = |out: &mut Vec<ConfiguredServer>, scope, name, config| {
        out.push(ConfiguredServer {
            scope,
            name,
            config,
            warnings: Vec::new(),
        });
    };
    // `x?.mcpServers ?? {}` of a parsed JSON file.
    let json_servers = |v: &Option<Value>| match v {
        Some(Value::Object(m)) => m.get("mcpServers").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    };

    let user = read_settings_value(Scope::User, cwd)?;
    for (name, cfg) in entries(settings_servers(&user)?.unwrap_or(&Value::Null)) {
        push(&mut out, Scope::User, name, cfg);
    }
    let user_json = read_json(&claude_home(), "mcp.json")?;
    for (name, cfg) in entries(&json_servers(&user_json)) {
        if out.iter().any(|s| s.scope == Scope::User && s.name == name) {
            continue;
        }
        push(&mut out, Scope::User, name, cfg);
    }
    let project = read_json(cwd, ".mcp.json")?;
    for (name, cfg) in entries(&json_servers(&project)) {
        push(&mut out, Scope::Project, name, cfg);
    }
    let local = read_settings_value(Scope::Local, cwd)?;
    for (name, cfg) in entries(settings_servers(&local)?.unwrap_or(&Value::Null)) {
        push(&mut out, Scope::Local, name, cfg);
    }

    for server in &mut out {
        server.warnings = find_config_whitespace_warnings(&server.config)?;
    }
    Ok(out)
}

/// `upsertServer(scope, cwd, name, config)`: set `mcpServers[name]` in the
/// scope's file (a new key goes last, an existing one keeps its place).
/// `name` is the property key the TS computes (`String(name)`).
pub fn upsert_server(scope: Scope, cwd: &str, name: &str, config: &Value) -> Result<()> {
    if scope == Scope::Project {
        // `(await readJson(path)) ?? {}`
        let mut current = match read_json(cwd, ".mcp.json")? {
            None | Some(Value::Null) => json!({}),
            Some(v) => v,
        };
        match &mut current {
            Value::Object(m) => {
                let mut servers = spread(m.get("mcpServers").unwrap_or(&Value::Null));
                servers.insert(name.to_owned(), config.clone());
                m.insert("mcpServers".into(), Value::Object(servers));
            }
            // A named property on an array: `JSON.stringify` leaves it out.
            Value::Array(_) => {}
            // Setting a property on a primitive throws in strict mode.
            v => {
                let kind = match v {
                    Value::String(_) => "string",
                    Value::Number(_) => "number",
                    _ => "boolean",
                };
                return Err(McpConfigError::Type(format!(
                    "Cannot create property 'mcpServers' on {kind} '{}'",
                    js::to_string(Some(v))
                )));
            }
        }
        return write_json(cwd, ".mcp.json", &current);
    }
    let settings = read_settings_value(scope, cwd)?;
    // `{...settings, mcpServers: {...(settings.mcpServers ?? {}), [name]: config}}`
    let mut next = spread(&settings);
    let mut servers = spread(settings_servers(&settings)?.unwrap_or(&Value::Null));
    servers.insert(name.to_owned(), config.clone());
    next.insert("mcpServers".into(), Value::Object(servers));
    settings::write_settings(scope, cwd, &next)?;
    Ok(())
}

/// `removeServer(scope, cwd, name)`: `false` when the scope's file has no
/// truthy `mcpServers` or `name in mcpServers` fails; otherwise the entry
/// is deleted, the file rewritten, and `true`.
pub fn remove_server(scope: Scope, cwd: &str, name: &str) -> Result<bool> {
    if scope == Scope::Project {
        let Some(mut current) = read_json(cwd, ".mcp.json")? else {
            return Ok(false);
        };
        // `current?.mcpServers`
        let Some(servers) = current
            .as_object_mut()
            .and_then(|m| m.get_mut("mcpServers"))
            .filter(|s| js::truthy(s))
        else {
            return Ok(false);
        };
        if !js_in(name, servers)? {
            return Ok(false);
        }
        js_delete(servers, name)?;
        write_json(cwd, ".mcp.json", &current)?;
        return Ok(true);
    }
    let mut settings = read_settings_value(scope, cwd)?;
    settings_servers(&settings)?;
    let Some(servers) = settings
        .as_object_mut()
        .and_then(|m| m.get_mut("mcpServers"))
        .filter(|s| js::truthy(s))
    else {
        return Ok(false);
    };
    if !js_in(name, servers)? {
        return Ok(false);
    }
    js_delete(servers, name)?;
    let settings = settings.as_object().cloned().unwrap_or_default();
    settings::write_settings(scope, cwd, &settings)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_follows_js() {
        let o = json!({"a": 1, "__proto__": 2});
        assert!(js_in("a", &o).unwrap());
        assert!(js_in("toString", &o).unwrap());
        assert!(js_in("__proto__", &json!({})).unwrap());
        assert!(!js_in("length", &o).unwrap());
        assert!(!js_in("b", &o).unwrap());
        let a = json!(["x", "y"]);
        assert!(js_in("0", &a).unwrap());
        assert!(js_in("1", &a).unwrap());
        assert!(!js_in("2", &a).unwrap());
        assert!(!js_in("01", &a).unwrap());
        assert!(js_in("length", &a).unwrap());
        assert!(js_in("push", &a).unwrap());
        assert!(js_in("hasOwnProperty", &a).unwrap());
        for p in [
            json!("ab"),
            json!(5),
            json!(true),
            json!(false),
            Value::Null,
        ] {
            assert!(js_in("a", &p).is_err(), "{p}");
        }
    }

    #[test]
    fn delete_follows_strict_js() {
        let mut o = json!({"a": 1, "b": 2, "c": 3});
        js_delete(&mut o, "a").unwrap();
        assert_eq!(js::stringify(&o), r#"{"b":2,"c":3}"#, "order kept");
        js_delete(&mut o, "toString").unwrap();
        assert_eq!(js::stringify(&o), r#"{"b":2,"c":3}"#);
        let mut a = json!(["x", "y", "z"]);
        js_delete(&mut a, "1").unwrap();
        assert_eq!(a, json!(["x", null, "z"]), "a hole");
        js_delete(&mut a, "push").unwrap();
        assert_eq!(a, json!(["x", null, "z"]));
        assert!(js_delete(&mut a, "length").is_err());
    }

    #[test]
    fn entries_and_spread_follow_js() {
        assert_eq!(
            spread(&json!({"b": 1, "10": 2, "2": 3})),
            serde_json::from_str::<Map<String, Value>>(r#"{"2":3,"10":2,"b":1}"#).unwrap()
        );
        assert_eq!(
            entries(&json!("a\u{1F600}")),
            vec![
                ("0".into(), json!("a")),
                ("1".into(), json!("\u{FFFD}")),
                ("2".into(), json!("\u{FFFD}")),
            ]
        );
        assert_eq!(entries(&json!([true])), vec![("0".into(), json!(true))]);
        for v in [json!(5), json!(true), Value::Null] {
            assert!(entries(&v).is_empty());
        }
    }

    #[test]
    fn paths_are_refused_like_assert_within() {
        fn refused<T>(r: Result<T>) -> &'static str {
            match r {
                Err(McpConfigError::PathInjection(m)) => m,
                Err(e) => panic!("{e}"),
                Ok(_) => "",
            }
        }
        // `"/.mcp.json".startsWith("/" + sep)` is false, so TS throws for
        // a `/` workspace before reading anything.
        for root in ["/", "//", "/.", "/a/.."] {
            assert_eq!(project_mcp_json_path(root), None);
            for scope in [Scope::Project, Scope::Local] {
                assert_eq!(
                    refused(remove_server(scope, root, "x")),
                    "path escapes base directory"
                );
                assert_eq!(
                    refused(read_settings_value(scope, root)),
                    "path escapes base directory"
                );
            }
        }
        assert_eq!(refused(read_json("", ".mcp.json")), "invalid base path");
        assert_eq!(
            refused(read_json("/a\0b", ".mcp.json")),
            "null byte in path"
        );
        // A write checks too, before any fs call (a NUL never reaches it).
        assert_eq!(
            refused(write_json("/a\0b", ".mcp.json", &json!({}))),
            "null byte in path"
        );
    }

    /// `readSettings` throws `SettingsParseError(pathFor(scope, cwd), …)`:
    /// the path `assertWithin` resolved, not the cwd as given.
    #[test]
    fn a_settings_parse_error_names_the_resolved_path() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().canonicalize().unwrap();
        let cwd = cwd.to_str().unwrap();
        std::fs::create_dir(format!("{cwd}/.claude")).unwrap();
        std::fs::write(format!("{cwd}/.claude/settings.local.json"), "{").unwrap();
        match read_settings_value(Scope::Local, &format!("{cwd}//./")) {
            Err(McpConfigError::SettingsParse { path, .. }) => {
                assert_eq!(path, format!("{cwd}/.claude/settings.local.json"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn settings_files_match_path_for() {
        for scope in [Scope::User, Scope::Project, Scope::Local] {
            let (base, rel) = settings_file(scope, "/w/p");
            assert_eq!(
                PathBuf::from(safe_path::assert_within(&base, rel).unwrap()),
                settings::path_for(scope, "/w/p")
            );
        }
        assert_eq!(
            project_mcp_json_path("/w/p").unwrap(),
            PathBuf::from("/w/p/.mcp.json")
        );
        assert_eq!(
            user_mcp_json_path().unwrap(),
            paths::claude_home().join("mcp.json")
        );
    }

    #[test]
    fn configured_server_json_leaves_out_empty_warnings() {
        let mut s = ConfiguredServer {
            scope: Scope::Local,
            name: "n".into(),
            config: json!({"url": " u"}),
            warnings: vec![],
        };
        assert_eq!(
            js::stringify(&s.to_json()),
            r#"{"scope":"local","name":"n","config":{"url":" u"}}"#
        );
        s.warnings = vec!["w".into()];
        assert_eq!(
            js::stringify(&s.to_json()),
            r#"{"scope":"local","name":"n","config":{"url":" u"},"warnings":["w"]}"#
        );
    }
}
