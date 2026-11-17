//! DB-backed programmatic subagents (table `db_agents` in the per-cwd
//! `.claudius.db`), fed to the CLI at session start as `Options.agents`:
//! port of `lib/server/db-agents.ts`.
//!
//! Inputs are JSON values as `JSON.parse` makes them. A number literal past
//! `f64` range is JS `Infinity`, which `serde_json` can't hold, so
//! [`json_parse`] keeps it as a sentinel string that the helpers here
//! ([`is_string`], [`number`], [`js_string`]) read back as the number.

use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use claudius_agent::js;
use regex::Regex;
use rusqlite::types::ValueRef;
use serde_json::{Map, Value, json};

use crate::agents::MAX_AGENT_NAME_LENGTH;
use crate::{db, js_params, js_string};

// ─── JS values from JSON.parse ────────────────────────────────────────────

const INFINITY: &str = "\u{0}js:Infinity";
const NEG_INFINITY: &str = "\u{0}js:-Infinity";

/// `JSON.parse(text)` (V8's `SyntaxError` message on failure), with
/// `±Infinity` kept as sentinel strings. No string is safe from a sentinel
/// (JSON escapes spell anything), so one exactly NUL + `js:Infinity` (or
/// `js:-Infinity`) in the text reads back as the number too.
pub fn json_parse(text: &str) -> Result<Value, String> {
    if let Some(message) = js::json_parse_error(text) {
        return Err(message);
    }
    js::json_parse(&with_infinities(text))
}

/// [`json_parse`] with lone-surrogate escapes kept as their
/// [`crate::js_string`] stand-ins, so [`crate::js_string::stringify`] writes
/// them back as `JSON.stringify` does.
pub fn json_parse_js(text: &str) -> Result<Value, String> {
    if let Some(message) = js::json_parse_error(text) {
        return Err(message);
    }
    crate::js_string::parse(&with_infinities(text))
}

/// `text` (valid JSON) with each infinite number literal replaced by its
/// sentinel string.
pub(crate) fn with_infinities(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut i, mut in_string) = (0, 0, false);
    while i < b.len() {
        match (in_string, b[i]) {
            (true, b'"') => in_string = false,
            (true, b'\\') => i += 1,
            (false, b'"') => in_string = true,
            (false, b'-' | b'0'..=b'9') => {
                let len = b[i..]
                    .iter()
                    .take_while(|c| matches!(c, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
                    .count();
                if let Ok(f) = text[i..i + len].parse::<f64>()
                    && f.is_infinite()
                {
                    out.push_str(&text[copied..i]);
                    out.push_str(if f > 0.0 {
                        "\"\\u0000js:Infinity\""
                    } else {
                        "\"\\u0000js:-Infinity\""
                    });
                    copied = i + len;
                }
                i += len - 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// The infinity a sentinel stands for.
pub fn infinity(v: &Value) -> Option<f64> {
    match v.as_str()? {
        INFINITY => Some(f64::INFINITY),
        NEG_INFINITY => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

/// `typeof v === "string"`.
pub fn is_string(v: &Value) -> bool {
    v.is_string() && infinity(v).is_none()
}

/// `v` when `typeof v === "string"`.
pub fn as_str(v: &Value) -> Option<&str> {
    if is_string(v) { v.as_str() } else { None }
}

/// `v` when `typeof v === "number"`.
pub fn number(v: &Value) -> Option<f64> {
    infinity(v).or_else(|| v.as_f64())
}

/// `v` as `JSON.stringify` writes it: the sentinels as `null`.
pub fn number_json(v: &Value) -> Value {
    if infinity(v).is_some() {
        Value::Null
    } else {
        v.clone()
    }
}

/// `String(v)`: [`js_string::to_js_string`], with the sentinels (also as
/// array items) as the infinities they stand for. An object with an own
/// `toString` key throws (`NoPrimitive`), also as an array item.
pub fn js_string(v: &Value) -> Result<String, js_string::NoPrimitive> {
    if let Some(f) = infinity(v) {
        return Ok(if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        });
    }
    match v {
        // `Array.prototype.join`: `null` items are empty.
        Value::Array(items) => Ok(items
            .iter()
            .map(|i| {
                if i.is_null() {
                    Ok(String::new())
                } else {
                    js_string(i)
                }
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(",")),
        v => js_string::to_js_string(v),
    }
}

// ─── validation ──────────────────────────────────────────────────────────

/// `/^[\w.\-]+$/`.
static NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.\-]+$").expect("name regex"));

/// `/^[\w][\w.-]*(?::[\w][\w.-]*)?$/`: a plain or `plugin:skill` name.
static SKILL_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*(?::[A-Za-z0-9_][A-Za-z0-9_.\-]*)?$")
        .expect("skill regex")
});

/// `isValidAgentName(name)`: a string of `[\w.-]`, at most 256 long
/// (`.length`: the names are plain strings, so not `js_string::len16`).
pub fn is_valid_agent_name(name: &Value) -> bool {
    as_str(name)
        .is_some_and(|s| s.encode_utf16().count() <= MAX_AGENT_NAME_LENGTH && NAME_RE.is_match(s))
}

/// `assertValidAgentName(name)`: the thrown message.
pub fn assert_valid_agent_name(name: &Value) -> Result<(), String> {
    if as_str(name).is_some_and(|s| s.encode_utf16().count() > MAX_AGENT_NAME_LENGTH) {
        return Err(format!(
            "agent name too long (max {MAX_AGENT_NAME_LENGTH} characters)"
        ));
    }
    if !is_valid_agent_name(name) {
        return Err("invalid agent name".into());
    }
    Ok(())
}

/// `coerceAgentDefinition(input)`: the SDK fields of `input`, in this order,
/// or `None` without a description and a prompt (both non-blank).
pub fn coerce_agent_definition(input: Option<&Value>) -> Option<Value> {
    let o = input?.as_object()?; // `!input || typeof input !== "object"`; arrays have no fields
    let field = |k: &str| o.get(k);
    let string = |k: &str| field(k).and_then(as_str);
    let description = string("description").map(js::trim).unwrap_or("");
    let prompt = string("prompt").unwrap_or("");
    if description.is_empty() || js::trim(prompt).is_empty() {
        return None;
    }
    let mut def = Map::new();
    def.insert("description".into(), json!(description));
    def.insert("prompt".into(), json!(prompt));
    let strings = |k: &str, keep: &dyn Fn(&str) -> bool| {
        field(k).and_then(Value::as_array).map(|items| {
            Value::Array(
                items
                    .iter()
                    .filter(|t| as_str(t).is_some_and(keep))
                    .cloned()
                    .collect(),
            )
        })
    };
    let any = |_: &str| true;
    if let Some(v) = strings("tools", &any) {
        def.insert("tools".into(), v);
    }
    if let Some(v) = strings("disallowedTools", &any) {
        def.insert("disallowedTools".into(), v);
    }
    if let Some(v) = strings("skills", &|s| SKILL_NAME_RE.is_match(s)) {
        def.insert("skills".into(), v);
    }
    for k in ["model", "initialPrompt"] {
        if let Some(s) = string(k) {
            def.insert(k.into(), json!(s));
        }
    }
    if let Some(v) = field("maxTurns").filter(|v| number(v).is_some()) {
        def.insert("maxTurns".into(), number_json(v));
    }
    if let Some(v) =
        field("autoCompactWindow").filter(|v| number(v).is_some_and(|n| n.is_finite() && n > 0.0))
    {
        def.insert("autoCompactWindow".into(), v.clone());
    }
    for k in ["background", "omitClaudeMd"] {
        if let Some(v) = field(k).filter(|v| v.is_boolean()) {
            def.insert(k.into(), v.clone());
        }
    }
    let one_of =
        |k: &str, allowed: &[&str]| string(k).filter(|s| allowed.contains(s)).map(|s| json!(s));
    if let Some(v) = one_of("memory", &["user", "project", "local"]) {
        def.insert("memory".into(), v);
    }
    let effort = one_of("effort", &["low", "medium", "high", "xhigh", "max"]).or_else(|| {
        field("effort")
            .filter(|v| number(v).is_some())
            .map(number_json)
    });
    if let Some(v) = effort {
        def.insert("effort".into(), v);
    }
    let modes = [
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
        "dontAsk",
        "auto",
    ];
    if let Some(v) = one_of("permissionMode", &modes) {
        def.insert("permissionMode".into(), v);
    }
    Some(Value::Object(def))
}

// ─── the table ───────────────────────────────────────────────────────────

/// One `listDbAgents` row as `JSON.stringify` writes it: `{name,
/// definition, updatedAt}`, `updatedAt` being whatever SQLite holds.
pub type DbAgentRow = Value;

/// A column as better-sqlite3 hands it to JS (as JSON): integers as
/// (lossy) numbers, text decoded lossily, a blob as a `Buffer`.
fn js_column(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => {
            serde_json::Number::from_f64(i as f64).map_or(Value::Null, Value::Number)
        }
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "type": "Buffer", "data": b }),
    }
}

/// `JSON.parse(r.definition_json)`: the column as a string first (`String`
/// of a number, `"null"`, a blob's UTF-8).
fn parse_definition(v: ValueRef<'_>) -> Option<Value> {
    let text = match v {
        ValueRef::Text(t) | ValueRef::Blob(t) => String::from_utf8_lossy(t).into_owned(),
        // `JSON.parse(5)` is 5, `JSON.parse(null)` null: never a definition.
        ValueRef::Integer(_) | ValueRef::Real(_) | ValueRef::Null => return None,
    };
    json_parse(&text).ok()
}

/// `listDbAgents(cwd)`: the valid rows in `name` order; none when the DB or
/// the table is missing.
pub fn list_db_agents(cwd: &str) -> Vec<DbAgentRow> {
    let Ok(handle) = db::open_db(cwd, db::Mode::ReadOnly) else {
        return Vec::new();
    };
    let rows = handle.with(|c| {
        let mut st =
            c.prepare("SELECT name, definition_json, updated_at FROM db_agents ORDER BY name")?;
        let mut rows = st.query([])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            let name = js_column(r.get_ref(0)?);
            // A row stored before the 256-char cap would now be refused.
            if !is_valid_agent_name(&name) {
                continue;
            }
            let Some(parsed) = parse_definition(r.get_ref(1)?) else {
                continue; // skip corrupt JSON rather than crash
            };
            if let Some(def) = coerce_agent_definition(Some(&parsed)) {
                let mut row = Map::new();
                row.insert("name".into(), name);
                row.insert("definition".into(), def);
                row.insert("updatedAt".into(), js_column(r.get_ref(2)?));
                out.push(Value::Object(row));
            }
        }
        Ok(out)
    });
    rows.unwrap_or_default()
}

/// `loadDbAgentsForOptions(cwd)`: name → definition for `Options.agents`,
/// `None` when there are no rows.
pub fn load_db_agents_for_options(cwd: &str) -> Option<Value> {
    let rows = list_db_agents(cwd);
    if rows.is_empty() {
        return None;
    }
    let mut map = Map::new();
    for mut r in rows {
        let name = r["name"].as_str().unwrap_or_default().to_owned();
        map.insert(name, r["definition"].take());
    }
    Some(Value::Object(map))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `upsertDbAgent(cwd, name, definition)`: the stored row, or the thrown
/// error's message.
pub fn upsert_db_agent(
    cwd: &str,
    name: &Value,
    definition: Option<&Value>,
) -> Result<DbAgentRow, String> {
    assert_valid_agent_name(name)?;
    let name = as_str(name).unwrap_or_default();
    let Some(def) = coerce_agent_definition(definition) else {
        return Err("agent definition requires non-empty description and prompt".into());
    };
    let handle = db::open_db(cwd, db::Mode::ReadWrite).map_err(|e| e.to_string())?;
    let updated_at = now_ms();
    handle
        .with(|c| {
            c.execute(
                "INSERT INTO db_agents(name, definition_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       definition_json = excluded.definition_json,
       updated_at = excluded.updated_at",
                js_params![name, js_string::stringify(&def), updated_at],
            )
        })
        .map_err(|e| e.to_string())?;
    Ok(json!({ "name": name, "definition": def, "updatedAt": updated_at }))
}

/// `deleteDbAgent(cwd, name)`: whether a row went.
pub fn delete_db_agent(cwd: &str, name: &str) -> Result<bool, String> {
    assert_valid_agent_name(&json!(name))?;
    let handle = db::open_db(cwd, db::Mode::ReadWrite).map_err(|e| e.to_string())?;
    handle
        .with(|c| c.execute("DELETE FROM db_agents WHERE name = ?", js_params![name]))
        .map(|n| n > 0)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infinities_survive_the_parse() {
        let v = json_parse(r#"{"a":1e400,"b":[-1e999,"1e400"],"c":1.5}"#).unwrap();
        assert_eq!(number(&v["a"]), Some(f64::INFINITY));
        assert_eq!(number(&v["b"][0]), Some(f64::NEG_INFINITY));
        assert!(is_string(&v["b"][1]));
        assert_eq!(js_string(&v["b"]).unwrap(), "-Infinity,1e400");
        let v = json_parse(r#"{"a":1e400,"b":"\u0000Infinity","c":"\u0000js:Infinity"}"#).unwrap();
        assert_eq!(number(&v["a"]), Some(f64::INFINITY));
        assert!(is_string(&v["b"]));
        assert_eq!(
            number(&v["c"]),
            Some(f64::INFINITY),
            "the one spelling that collides"
        );
        assert_eq!(
            json_parse("{").unwrap_err(),
            js::json_parse_error("{").unwrap()
        );
    }

    #[test]
    fn js_string_follows_string() {
        for (v, s) in [
            (json!(null), "null"),
            (json!(true), "true"),
            (json!(-0.0), "0"),
            (json!(1e21), "1e+21"),
            (json!([null, [1, [2]], "x"]), ",1,2,x"),
            (json!({}), "[object Object]"),
        ] {
            assert_eq!(js_string(&v).as_deref(), Ok(s));
        }
        // `String({toString: 1})` throws, also inside `Array.prototype.join`.
        for v in [json!({"toString": 1}), json!([1, [{"toString": null}]])] {
            assert_eq!(js_string(&v), Err(js_string::NoPrimitive));
        }
    }
}
