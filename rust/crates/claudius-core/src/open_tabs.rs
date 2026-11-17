//! The per-cwd tab strip: port of `lib/server/open-tabs-db.ts`, behind
//! `GET/PUT /api/sessions/open-tabs`.
//!
//! Four keys of the per-cwd `ui_state` table (migration 003), each value a
//! JSON text: `open_tabs` (the strip's session ids, in order), `pinned_tabs`
//! (the pinned subset), `active_tab` (the last-active id) and
//! `tab_label_max_width` (px, clamped to [60, 600]).
//!
//! Reads open the DB read-only, so they never create the file (only its
//! project dir, as `openDb`'s `mkdir` does) or migrate it, and every failure
//! (no DB, a file that isn't one or isn't in WAL mode, no table, no row, a
//! value that doesn't parse or has the wrong type) reads as the default.
//! The value is taken as better-sqlite3 hands it to JS and `JSON.parse`
//! coerces it: a falsy one (`""`, `0`, `0.0`, NULL in a typeless table)
//! is no value; a number is parsed from its JS text (`1e21` → `"1e+21"`,
//! Infinity → `"Infinity"`, which doesn't parse); a BLOB from its UTF-8
//! text. Writes open it read-write (creating and migrating it) and upsert
//! with the TS statement, so a table another writer made without a unique
//! key fails the same way. Ids are JS strings ([`js_string`]): a lone
//! surrogate is read, stored and bound as TS does.

use claudius_agent::js;
use rusqlite::OptionalExtension;
use rusqlite::types::ValueRef;
use serde_json::Value;

use crate::db::{Mode, open_db};
use crate::loop_ticks_db::math_round;
use crate::{js_params, js_string};

const KEY: &str = "open_tabs";
const ACTIVE_KEY: &str = "active_tab";
const PINNED_KEY: &str = "pinned_tabs";
const TAB_LABEL_MAX_WIDTH_KEY: &str = "tab_label_max_width";

/// Bounds for the tab-label max width (px). The UI mirrors them.
pub const TAB_LABEL_MIN: f64 = 60.0;
pub const TAB_LABEL_MAX: f64 = 600.0;
pub const TAB_LABEL_DEFAULT: f64 = 180.0;

/// The most ids a strip (or the pinned set) keeps.
pub const MAX_TABS: usize = 200;

/// `String(v)` for the value better-sqlite3 returns, which is what
/// `JSON.parse(v)` parses; `None` when `v` is falsy (`!row?.value`).
fn parse_text(v: ValueRef) -> Option<String> {
    match v {
        ValueRef::Null => None,
        ValueRef::Integer(0) => None,
        // A JS number: past 2^53 it rounds.
        ValueRef::Integer(n) => Some(js::number_to_string(n as f64)),
        // `-0.0` too (SQLite stores NaN as NULL).
        ValueRef::Real(0.0) => None,
        ValueRef::Real(f) if f.is_infinite() => {
            Some(if f > 0.0 { "Infinity" } else { "-Infinity" }.into())
        }
        ValueRef::Real(f) => Some(js::number_to_string(f)),
        ValueRef::Text([]) => None,
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        // A `Buffer`, truthy even when empty; `String(buffer)` is its UTF-8.
        ValueRef::Blob(b) => Some(String::from_utf8_lossy(b).into_owned()),
    }
}

/// `JSON.parse(row.value)` for `key`'s row, or `None` where the TS returns
/// its default first (no DB, a query that throws, no row, a falsy value) or
/// the parse throws. A lone-surrogate escape (which `JSON.stringify` writes
/// for one) reads as its [`js_string`] stand-in, so it is written back as
/// the same escape.
fn read_parsed(cwd: &str, key: &str) -> Option<Value> {
    let db = open_db(cwd, Mode::ReadOnly).ok()?;
    let row = db.with(|c| {
        c.query_row(
            "SELECT value FROM ui_state WHERE key = ?",
            js_params![key],
            |r| Ok(parse_text(r.get_ref(0)?)),
        )
        .optional()
    });
    // The query threw (no table), no row, or a falsy value.
    let text = row.ok()???;
    js_string::parse(&text).ok()
}

/// The string items of a parsed array, in order, duplicates kept.
fn strings_of(v: Option<Value>) -> Vec<String> {
    match v {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|x| match x {
                Value::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `getOpenTabs(cwd)`: the strip's ids, as stored.
pub fn get_open_tabs(cwd: &str) -> Vec<String> {
    strings_of(read_parsed(cwd, KEY))
}

/// `getPinnedTabs(cwd)`.
pub fn get_pinned_tabs(cwd: &str) -> Vec<String> {
    strings_of(read_parsed(cwd, PINNED_KEY))
}

/// `getActiveTab(cwd)`: the stored id when it parses to a string (`""`
/// included).
pub fn get_active_tab(cwd: &str) -> Option<String> {
    match read_parsed(cwd, ACTIVE_KEY) {
        Some(Value::String(s)) => Some(s),
        _ => None,
    }
}

/// `getTabLabelMaxWidth(cwd)`: a stored finite number, clamped; `None`
/// when nothing usable is saved.
pub fn get_tab_label_max_width(cwd: &str) -> Option<f64> {
    // `JSON.parse` reads an overflowing literal as ±Infinity, which isn't
    // finite; `json_parse` reads it as `null`, which isn't a number either.
    read_parsed(cwd, TAB_LABEL_MAX_WIDTH_KEY)?
        .as_f64()
        .map(clamp_label_width)
}

/// `clampLabelWidth`: `Math.round`, then into [60, 600]; not finite → 180.
pub fn clamp_label_width(n: f64) -> f64 {
    if !n.is_finite() {
        return TAB_LABEL_DEFAULT;
    }
    TAB_LABEL_MAX.min(TAB_LABEL_MIN.max(math_round(n)))
}

/// The setters' sanitize step: dedupe in order (first wins), then at most
/// [`MAX_TABS`].
pub fn sanitize_ids<S: AsRef<str>>(ids: &[S]) -> Vec<&str> {
    let mut seen = std::collections::HashSet::new();
    let mut cleaned = Vec::new();
    for v in ids {
        let v = v.as_ref();
        if !seen.insert(v) {
            continue;
        }
        cleaned.push(v);
        if cleaned.len() >= MAX_TABS {
            break;
        }
    }
    cleaned
}

/// The TS upsert on the read-write handle.
fn upsert(cwd: &str, key: &str, value: &str) -> anyhow::Result<()> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    db.with(|c| {
        c.execute(
            "INSERT INTO ui_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            js_params![key, value],
        )
    })?;
    Ok(())
}

fn json_ids(ids: &[&str]) -> String {
    js_string::stringify(&Value::Array(
        ids.iter().map(|s| Value::String((*s).to_owned())).collect(),
    ))
}

/// `setOpenTabs(cwd, ids)`: [`sanitize_ids`], stored as `JSON.stringify`.
pub fn set_open_tabs<S: AsRef<str>>(cwd: &str, ids: &[S]) -> anyhow::Result<()> {
    let cleaned = sanitize_ids(ids);
    upsert(cwd, KEY, &json_ids(&cleaned))
}

/// `setPinnedTabs(cwd, ids)`.
pub fn set_pinned_tabs<S: AsRef<str>>(cwd: &str, ids: &[S]) -> anyhow::Result<()> {
    let cleaned = sanitize_ids(ids);
    upsert(cwd, PINNED_KEY, &json_ids(&cleaned))
}

/// `setActiveTab(cwd, id)`: `None` deletes the row.
pub fn set_active_tab(cwd: &str, id: Option<&str>) -> anyhow::Result<()> {
    let Some(id) = id else {
        let db = open_db(cwd, Mode::ReadWrite)?;
        db.with(|c| c.execute("DELETE FROM ui_state WHERE key = ?", js_params![ACTIVE_KEY]))?;
        return Ok(());
    };
    upsert(
        cwd,
        ACTIVE_KEY,
        &js_string::stringify(&Value::String(id.to_owned())),
    )
}

/// `setTabLabelMaxWidth(cwd, width)`: the clamped width as its JS text.
pub fn set_tab_label_max_width(cwd: &str, width: f64) -> anyhow::Result<()> {
    let v = clamp_label_width(width);
    upsert(cwd, TAB_LABEL_MAX_WIDTH_KEY, &js::number_to_string(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falsy_values_never_parse() {
        assert_eq!(parse_text(ValueRef::Null), None);
        assert_eq!(parse_text(ValueRef::Integer(0)), None);
        assert_eq!(parse_text(ValueRef::Real(-0.0)), None);
        assert_eq!(parse_text(ValueRef::Text(b"")), None);
        assert_eq!(parse_text(ValueRef::Blob(b"")).as_deref(), Some(""));
        assert_eq!(parse_text(ValueRef::Real(1e21)).as_deref(), Some("1e+21"));
        assert_eq!(
            parse_text(ValueRef::Real(f64::NEG_INFINITY)).as_deref(),
            Some("-Infinity")
        );
        assert_eq!(
            parse_text(ValueRef::Integer(9_007_199_254_740_993)).as_deref(),
            Some("9007199254740992")
        );
    }

    #[test]
    fn sanitize_dedupes_then_caps() {
        let ids: Vec<String> = (0..250).map(|i| format!("{}", i % 230)).collect();
        let got = sanitize_ids(&ids);
        assert_eq!(got.len(), MAX_TABS);
        assert_eq!(got[199], "199");
        assert_eq!(sanitize_ids(&["a", "b", "a", "", ""]), ["a", "b", ""]);
    }

    #[test]
    fn clamp_rounds_like_math_round() {
        assert_eq!(clamp_label_width(f64::NAN), 180.0);
        assert_eq!(clamp_label_width(59.5), 60.0);
        assert_eq!(clamp_label_width(60.5), 61.0);
        assert_eq!(clamp_label_width(599.4999999999999), 599.0);
        assert_eq!(clamp_label_width(599.5), 600.0);
        assert_eq!(clamp_label_width(-1e308), 60.0);
    }
}
