//! `lib/server/limits-store.ts`: the per-cwd spend and tool-call caps behind
//! `/api/limits` (the Cost page's limits panel, the chat's cap banner and
//! its day-scoped override).
//!
//! One file per cwd, `homedir()/.claude/.claudius/limits/<encodeProjectDir(cwd)>.json`,
//! holding `{limits, overrides, audit}` as `JSON.stringify(state, null, 2)`
//! (no trailing newline), rewritten in place by `fs.writeFile`. Values stay
//! JSON as `JSON.parse` reads them ([`db_agents::json_parse_js`]: `±Infinity`
//! as sentinels, lone surrogates as `js_string` stand-ins), so anything a
//! foreign writer stored survives a rewrite as TS writes it back:
//! - `readLimits`: a missing file is the empty state; any other read or
//!   parse error throws (a malformed or `null` file blocks every write too);
//!   `limits` / `overrides` are kept unless nullish (a `5`, `"ab"` or
//!   Infinity stays), `audit` only when it's an array; a non-object file
//!   reads as empty; other top-level keys are dropped;
//! - the state is always `{limits, overrides, audit}` in that order;
//! - `setOverride` spreads `overrides` like `{...v}` (an object's own keys, an
//!   array's indices, a string's code units; numbers and booleans nothing);
//! - `appendAudit` keeps the newest 200 events, `undefined` written `null`.
//!
//! Each fs call has the inline `resolve(base, name)` + `startsWith(base +
//! "/")` check of the TS. One process-wide lock serialises the calls, so two
//! concurrent writes can't lose one another's change (TS has no lock).

use std::sync::{Mutex, MutexGuard};

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::{db_agents, js_string, node_fs, node_path, paths};

/// `appendAudit`'s cap: the newest events kept.
pub const AUDIT_CAP: usize = 200;

/// The message of what a call threw (the route answers Next's empty 500).
pub type Thrown = String;

static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// `limitsDir()`: `join(homedir(), ".claude", ".claudius", "limits")`.
pub fn limits_dir(home: &str) -> String {
    node_path::join(&[home, ".claude", ".claudius", "limits"])
}

/// `{ ...EMPTY, audit: [] }`.
pub fn empty_state() -> Value {
    json!({"limits": {}, "overrides": {}, "audit": []})
}

const ESCAPES: &str = "limits path escapes base directory";

/// `readLimits(cwd)`.
pub fn read_limits(home: &str, cwd: &str) -> Result<Value, Thrown> {
    let _g = lock();
    read_unlocked(home, cwd)
}

fn read_unlocked(home: &str, cwd: &str) -> Result<Value, Thrown> {
    let base = limits_dir(home);
    let name = format!("{}.json", paths::encode_project_dir(cwd));
    let target = node_path::resolve(&[&base, &name]);
    if !target.starts_with(&format!("{base}/")) {
        return Err(format!("PathInjectionError: {ESCAPES}"));
    }
    let raw = match node_fs::read_to_string(&target) {
        Ok(raw) => raw,
        Err(e) if e.is_not_found() => return Ok(empty_state()),
        Err(e) => return Err(format!("Error: {}", e.message)),
    };
    let parsed = db_agents::json_parse_js(&raw).map_err(|m| format!("SyntaxError: {m}"))?;
    let o = match &parsed {
        Value::Null => {
            return Err("TypeError: Cannot read properties of null (reading 'limits')".into());
        }
        Value::Object(o) => Some(o),
        // A primitive or an array has none of the three properties.
        _ => None,
    };
    let field = |k: &str| o.and_then(|o| o.get(k)).cloned();
    let limits = field("limits").filter(|v| !v.is_null());
    let overrides = field("overrides").filter(|v| !v.is_null());
    let audit = field("audit").filter(Value::is_array);
    Ok(json!({
        "limits": limits.unwrap_or_else(|| json!({})),
        "overrides": overrides.unwrap_or_else(|| json!({})),
        "audit": audit.unwrap_or_else(|| json!([])),
    }))
}

/// `ensureDir()`: `fs.mkdir(limitsDir(), { recursive: true })`.
fn ensure_dir(home: &str) -> Result<(), Thrown> {
    node_fs::mkdir_recursive(&limits_dir(home), 0o777).map_err(|e| format!("Error: {}", e.message))
}

/// `persistLimits(cwd, state)`.
fn persist(home: &str, cwd: &str, state: &Value) -> Result<(), Thrown> {
    let base = limits_dir(home);
    let name = format!("{}.json", paths::encode_project_dir(cwd));
    let target = node_path::resolve(&[&base, &name]);
    if !target.starts_with(&format!("{base}/")) {
        return Err(format!("PathInjectionError: {ESCAPES}"));
    }
    node_fs::write_file(&target, &to_text(state, true), 0o666)
        .map_err(|e| format!("Error: {}", e.message))
}

/// `writeLimits(cwd, limits)`: `limits` replaces the stored caps whole.
pub fn write_limits(home: &str, cwd: &str, limits: Value) -> Result<Value, Thrown> {
    let _g = lock();
    ensure_dir(home)?;
    let mut next = read_unlocked(home, cwd)?;
    next["limits"] = limits;
    persist(home, cwd, &next)?;
    Ok(next)
}

/// `appendAudit(cwd, ev)`; `None` is `undefined` (written `null`).
pub fn append_audit(home: &str, cwd: &str, ev: Option<Value>) -> Result<Value, Thrown> {
    let _g = lock();
    ensure_dir(home)?;
    let mut next = read_unlocked(home, cwd)?;
    let Value::Array(audit) = &mut next["audit"] else {
        unreachable!("readLimits keeps only an array");
    };
    audit.push(ev.unwrap_or(Value::Null));
    let over = audit.len().saturating_sub(AUDIT_CAP);
    audit.drain(..over);
    persist(home, cwd, &next)?;
    Ok(next)
}

/// `setOverride(cwd, key, on)`.
pub fn set_override(home: &str, cwd: &str, key: &str, on: bool) -> Result<Value, Thrown> {
    let _g = lock();
    ensure_dir(home)?;
    let mut next = read_unlocked(home, cwd)?;
    let mut overrides = Map::new();
    let cur = &next["overrides"];
    // `{ ...cur.overrides }`: Infinity is a number, which spreads nothing.
    if db_agents::infinity(cur).is_none() {
        js_string::spread_into(&mut overrides, cur);
    }
    if on {
        overrides.insert(key.to_owned(), Value::Bool(true));
    } else {
        overrides.shift_remove(key);
    }
    next["overrides"] = Value::Object(overrides);
    persist(home, cwd, &next)?;
    Ok(next)
}

/// `todayKey()`: the local calendar date as `${y}-${MM}-${dd}` (the year
/// unpadded, as `getFullYear()` prints it), in the process's zone.
pub fn today_key() -> String {
    today_key_in(crate::now_ms(), &jiff::tz::TimeZone::system())
}

/// [`today_key`] at `ms` in `tz`.
pub fn today_key_in(ms: i64, tz: &jiff::tz::TimeZone) -> String {
    let Ok(ts) = jiff::Timestamp::from_millisecond(ms) else {
        return String::new();
    };
    let d = ts.to_zoned(tz.clone()).date();
    format!("{}-{:02}-{:02}", d.year(), d.month(), d.day())
}

/// `sessionOverrideKey(sessionId)`.
pub fn session_override_key(session_id: &str) -> String {
    format!("session:{session_id}:{}", today_key())
}

/// `` `${v}` `` for a body value as [`db_agents::json_parse_js`] reads it
/// (`None` is `undefined`): the sentinels print `Infinity` / `-Infinity`,
/// arrays join their items (`null` ones empty), and an object with its own
/// `toString` throws V8's `TypeError`.
pub fn template_string(v: Option<&Value>) -> Result<String, Thrown> {
    let Some(v) = v else {
        return Ok("undefined".into());
    };
    if let Some(f) = db_agents::infinity(v) {
        return Ok(if f > 0.0 { "Infinity" } else { "-Infinity" }.into());
    }
    match v {
        Value::Array(items) => {
            let mut out = String::new();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !item.is_null() {
                    out.push_str(&template_string(Some(item))?);
                }
            }
            Ok(out)
        }
        v => js_string::to_js_string(v)
            .map_err(|_| "TypeError: Cannot convert object to primitive value".into()),
    }
}

/// `JSON.stringify(state)` (or with `null, 2`): the Infinity sentinels as
/// `null`, lone surrogates as escapes.
pub fn to_text(state: &Value, pretty: bool) -> String {
    let v = finite(state);
    if pretty {
        js_string::stringify_pretty(&v)
    } else {
        js_string::stringify(&v)
    }
}

/// `v` with every Infinity sentinel replaced by `null`, as `JSON.stringify`
/// writes `±Infinity`.
fn finite(v: &Value) -> Value {
    if db_agents::infinity(v).is_some() {
        return Value::Null;
    }
    match v {
        Value::Array(a) => Value::Array(a.iter().map(finite).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), finite(v))).collect()),
        v => v.clone(),
    }
}

/// `typeof v === "number" && v >= 0` for a body value: the value to store.
pub fn non_negative(v: Option<&Value>) -> Option<Value> {
    let v = v?;
    let n = db_agents::number(v)?;
    (n >= 0.0).then(|| v.clone())
}

/// JS truthiness of a body value (`if (on)`): the Infinity sentinels are
/// truthy numbers.
pub fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(|v| db_agents::infinity(v).is_some() || js::truthy(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> (tempfile::TempDir, String) {
        let d = tempfile::tempdir().unwrap();
        let h = d.path().display().to_string();
        (d, h)
    }

    #[test]
    fn missing_file_reads_empty_and_writes_in_ts_order() {
        let (_d, h) = home();
        assert_eq!(
            to_text(&read_limits(&h, "/p").unwrap(), false),
            r#"{"limits":{},"overrides":{},"audit":[]}"#
        );
        assert!(!std::path::Path::new(&limits_dir(&h)).exists());
        let s = write_limits(&h, "/p", json!({"sessionUsd": 5})).unwrap();
        assert_eq!(
            to_text(&s, false),
            r#"{"limits":{"sessionUsd":5},"overrides":{},"audit":[]}"#
        );
        let file = std::fs::read_to_string(format!("{}/-p.json", limits_dir(&h))).unwrap();
        assert_eq!(
            file,
            "{\n  \"limits\": {\n    \"sessionUsd\": 5\n  },\n  \"overrides\": {},\n  \"audit\": []\n}"
        );
    }

    #[test]
    fn audit_keeps_the_newest_200() {
        let (_d, h) = home();
        for i in 0..205 {
            append_audit(&h, "/p", Some(json!(i))).unwrap();
        }
        let s = read_limits(&h, "/p").unwrap();
        let a = s["audit"].as_array().unwrap();
        assert_eq!((a.len(), &a[0], &a[199]), (200, &json!(5), &json!(204)));
        let s = append_audit(&h, "/p", None).unwrap();
        assert_eq!(s["audit"][199], Value::Null);
    }

    #[test]
    fn template_strings() {
        let v = db_agents::json_parse_js(
            r#"[null, 1.5, 1e21, 1e400, [1, [2, null]], {"a": 1}, {"toString": 1}, "x"]"#,
        )
        .unwrap();
        let s = |i: usize| template_string(Some(&v[i]));
        assert_eq!(template_string(None).unwrap(), "undefined");
        assert_eq!(s(0).unwrap(), "null");
        assert_eq!(s(1).unwrap(), "1.5");
        assert_eq!(s(2).unwrap(), "1e+21");
        assert_eq!(s(3).unwrap(), "Infinity");
        assert_eq!(s(4).unwrap(), "1,2,");
        assert_eq!(s(5).unwrap(), "[object Object]");
        assert!(s(6).is_err());
        assert_eq!(s(7).unwrap(), "x");
    }

    #[test]
    fn today_key_is_the_local_date() {
        let tz = jiff::tz::TimeZone::get("Pacific/Kiritimati").unwrap();
        // 2026-12-31T10:00:00Z is 2027-01-01T00:00 at +14.
        assert_eq!(today_key_in(1_798_711_200_000, &tz), "2027-01-01");
        assert_eq!(
            today_key_in(1_798_711_199_999, &tz),
            "2026-12-31",
            "a millisecond earlier"
        );
        assert_eq!(
            today_key_in(
                -62_135_596_800_000 + 86_400_000 * 400,
                &jiff::tz::TimeZone::UTC
            ),
            "2-02-05"
        );
    }
}
