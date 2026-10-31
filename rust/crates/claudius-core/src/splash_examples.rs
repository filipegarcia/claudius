//! Port of `lib/server/splash-examples-db.ts`: the chat splash screen's
//! per-workspace suggestion chips and greeting-name override, two rows of the
//! per-cwd `ui_state` table (migration 003), so workspace scoping comes from
//! the database file itself.
//!
//! - `splash_examples` holds `JSON.stringify` of the chip list. No row means
//!   "use the defaults"; a row, even `[]`, is a deliberate choice.
//! - `splash_display_name` holds `JSON.stringify` of the name. An empty or
//!   blank name deletes the row, so "never set" and "cleared" are the same.
//!
//! Strings are JS strings ([`JsString`], UTF-16 code units), because a cap
//! that cuts through a surrogate pair leaves half of it: TS stores that
//! half as a `\udXXX` escape and reads it back as a lone surrogate, and so
//! does this module. Reads go through a read-only handle and fall back
//! (defaults / `None`) on any failure; writes open read-write and fail with
//! `openDb`'s or SQLite's message, as the TS throws.

use claudius_agent::js;
use rusqlite::OptionalExtension;
use rusqlite::types::ValueRef;
use serde_json::Value;

use crate::db::{self, Mode};

const KEY: &str = "splash_examples";
const NAME_KEY: &str = "splash_display_name";

/// UTF-16 units per chip.
pub const SPLASH_EXAMPLE_MAX_LEN: usize = 240;
/// Chips per list.
pub const SPLASH_EXAMPLES_MAX: usize = 12;
/// UTF-16 units of the name override.
pub const SPLASH_DISPLAY_NAME_MAX_LEN: usize = 60;

pub const DEFAULT_SPLASH_EXAMPLES: [&str; 4] = [
    "Check for security vulnerabilities in the latest git commit",
    "Improve test coverage",
    "Find TODO comments in the codebase",
    "Find performance bottlenecks and suggest fixes",
];

/// A JS string: UTF-16 code units, lone surrogates included.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JsString(Vec<u16>);

impl JsString {
    pub fn from_units(units: Vec<u16>) -> JsString {
        JsString(units)
    }

    pub fn units(&self) -> &[u16] {
        &self.0
    }

    /// `s.length`.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `s.trim()`: JS whitespace is all in the BMP, so it is whole units.
    pub fn trim(&self) -> JsString {
        let ws = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(js::is_whitespace);
        let start = self.0.iter().position(|u| !ws(u)).unwrap_or(self.0.len());
        let end = self.0.iter().rposition(|u| !ws(u)).map_or(start, |i| i + 1);
        JsString(self.0[start..end].to_vec())
    }

    /// `s.slice(0, n)`: the first `n` units, which can end on half a pair.
    pub fn prefix(&self, n: usize) -> JsString {
        JsString(self.0[..n.min(self.0.len())].to_vec())
    }

    /// The text with each lone surrogate as U+FFFD (what writing the JS string
    /// out as UTF-8 does).
    pub fn to_string_lossy(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }

    /// `JSON.stringify(s)`: serde_json's escapes (which match V8's for every
    /// Unicode scalar), and a lone surrogate as a lowercase `\udXXX` escape.
    pub fn to_json(&self) -> String {
        let mut out = String::from("\"");
        for c in char::decode_utf16(self.0.iter().copied()) {
            match c {
                Ok(c) => {
                    let mut buf = [0u8; 4];
                    let quoted = serde_json::to_string(c.encode_utf8(&mut buf) as &str)
                        .expect("a string serializes");
                    out.push_str(&quoted[1..quoted.len() - 1]);
                }
                Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
            }
        }
        out.push('"');
        out
    }
}

/// A Rust string's code units, each [`crate::js_string`] stand-in as the
/// lone surrogate it stands for (how a request body parsed with
/// `js_string::parse` carries one).
impl From<&str> for JsString {
    fn from(s: &str) -> JsString {
        JsString(crate::js_string::units(s))
    }
}

/// `JSON.stringify` of an array of strings.
pub fn json_array(items: &[JsString]) -> String {
    let parts: Vec<String> = items.iter().map(JsString::to_json).collect();
    format!("[{}]", parts.join(","))
}

/// `SplashExamplesPayload`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplashExamples {
    /// The list to render: [`DEFAULT_SPLASH_EXAMPLES`] when nothing is saved.
    pub examples: Vec<JsString>,
    /// Whether a list was saved (even an empty one).
    pub customized: bool,
}

impl SplashExamples {
    pub fn defaults() -> SplashExamples {
        SplashExamples {
            examples: DEFAULT_SPLASH_EXAMPLES
                .iter()
                .map(|s| (*s).into())
                .collect(),
            customized: false,
        }
    }

    /// `JSON.stringify(payload)`: `{"examples":[…],"customized":…}`.
    pub fn to_json(&self) -> String {
        format!(
            "{{\"examples\":{},\"customized\":{}}}",
            json_array(&self.examples),
            self.customized
        )
    }
}

/// `SELECT value FROM ui_state WHERE key = ?` on the read-only handle, as the
/// JS value better-sqlite3 returns: `None` when the open or the query fails
/// (no DB yet, a database without the table) or there is no row.
fn read_value(cwd: &str, key: &str) -> Option<Option<String>> {
    let db = db::open_db(cwd, Mode::ReadOnly).ok()?;
    db.with(|c| {
        c.query_row("SELECT value FROM ui_state WHERE key = ?", [key], |r| {
            Ok(parse_input(r.get_ref(0)?))
        })
        .optional()
    })
    .ok()?
}

/// What `JSON.parse(row.value)` is handed: the text of a TEXT value or of a
/// BLOB (a `Buffer`, read as UTF-8). `None` for `NULL` and numbers: they take
/// the fallback either way (`!row.value` for `NULL` and `0`, and any other
/// number parses to a number, neither an array nor a string).
fn parse_input(v: ValueRef) -> Option<String> {
    match v {
        ValueRef::Text(t) | ValueRef::Blob(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Null | ValueRef::Integer(_) | ValueRef::Real(_) => None,
    }
}

/// `getSplashExamples(cwd)`.
pub fn get_splash_examples(cwd: &str) -> SplashExamples {
    let Some(Some(text)) = read_value(cwd, KEY) else {
        return SplashExamples::defaults();
    };
    let Some(Parsed::Array(items)) = parse(&text) else {
        return SplashExamples::defaults();
    };
    let examples = items
        .into_iter()
        .flatten()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .take(SPLASH_EXAMPLES_MAX)
        .collect();
    SplashExamples {
        examples,
        customized: true,
    }
}

/// The cleaned list `setSplashExamples` stores and returns: non-strings
/// skipped, each trimmed, then cut to [`SPLASH_EXAMPLE_MAX_LEN`] units, blanks
/// dropped, at most [`SPLASH_EXAMPLES_MAX`].
pub fn clean_examples(examples: &[Value]) -> Vec<JsString> {
    let mut cleaned = Vec::new();
    for raw in examples {
        let Value::String(raw) = raw else { continue };
        let v = JsString::from(raw.as_str())
            .trim()
            .prefix(SPLASH_EXAMPLE_MAX_LEN);
        if v.is_empty() {
            continue;
        }
        cleaned.push(v);
        if cleaned.len() >= SPLASH_EXAMPLES_MAX {
            break;
        }
    }
    cleaned
}

const UPSERT: &str = "INSERT INTO ui_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value";
const DELETE: &str = "DELETE FROM ui_state WHERE key = ?";

/// One statement on the read-write handle; its error reads as better-sqlite3's.
fn write(cwd: &str, sql: &str, params: &[&str]) -> anyhow::Result<()> {
    let db = db::open_db(cwd, Mode::ReadWrite)?;
    db.with(|c| c.execute(sql, rusqlite::params_from_iter(params)))
        .map_err(|e| anyhow::anyhow!(db::sqlite_message(&e)))?;
    Ok(())
}

/// `setSplashExamples(cwd, examples)`: saves and returns the cleaned list
/// ([`clean_examples`]).
pub fn set_splash_examples(cwd: &str, examples: &[Value]) -> anyhow::Result<Vec<JsString>> {
    let cleaned = clean_examples(examples);
    write(cwd, UPSERT, &[KEY, &json_array(&cleaned)])?;
    Ok(cleaned)
}

/// `resetSplashExamples(cwd)`: back to the defaults (the name stays).
pub fn reset_splash_examples(cwd: &str) -> anyhow::Result<()> {
    write(cwd, DELETE, &[KEY])
}

/// `getSplashDisplayName(cwd)`: the saved name, trimmed and cut to
/// [`SPLASH_DISPLAY_NAME_MAX_LEN`] units; `None` without one.
pub fn get_splash_display_name(cwd: &str) -> Option<JsString> {
    let text = read_value(cwd, NAME_KEY)??;
    let Some(Parsed::String(name)) = parse(&text) else {
        return None;
    };
    let trimmed = name.trim();
    (!trimmed.is_empty()).then(|| trimmed.prefix(SPLASH_DISPLAY_NAME_MAX_LEN))
}

/// `setSplashDisplayName(cwd, name)`: `None`, `""` or a blank name deletes the
/// row; anything else is saved trimmed and cut, and returned.
pub fn set_splash_display_name(cwd: &str, name: Option<&str>) -> anyhow::Result<Option<JsString>> {
    let clean = name.map(|n| JsString::from(n).trim().prefix(SPLASH_DISPLAY_NAME_MAX_LEN));
    match clean {
        Some(clean) if !clean.is_empty() => {
            write(cwd, UPSERT, &[NAME_KEY, &clean.to_json()])?;
            Ok(Some(clean))
        }
        _ => {
            write(cwd, DELETE, &[NAME_KEY])?;
            Ok(None)
        }
    }
}

// ---- JSON.parse, for what these rows need ----------------------------------

/// The parts of a `JSON.parse` result the readers look at.
#[derive(Debug, PartialEq, Eq)]
enum Parsed {
    /// An array: each element a string, or `None` for any other value.
    Array(Vec<Option<JsString>>),
    String(JsString),
    Other,
}

/// `JSON.parse(text)`, or `None` where V8 throws. Strings keep the code units
/// their escapes name, lone surrogates included.
fn parse(text: &str) -> Option<Parsed> {
    let units: Vec<u16> = text.encode_utf16().collect();
    if js::json_parse_error_utf16(&units).is_some() {
        return None;
    }
    // Valid JSON from here on, so the walk can be lenient.
    let mut p = Walk { s: &units, i: 0 };
    p.ws();
    Some(match p.peek() {
        Some(b'"') => Parsed::String(p.string()),
        Some(b'[') => {
            p.i += 1;
            let mut items = Vec::new();
            loop {
                p.ws();
                match p.peek() {
                    Some(b']') | None => break,
                    Some(b',') => p.i += 1,
                    Some(b'"') => items.push(Some(p.string())),
                    Some(_) => {
                        p.skip_value();
                        items.push(None);
                    }
                }
            }
            Parsed::Array(items)
        }
        _ => Parsed::Other,
    })
}

struct Walk<'a> {
    s: &'a [u16],
    i: usize,
}

impl Walk<'_> {
    fn peek(&self) -> Option<u8> {
        self.s
            .get(self.i)
            .and_then(|u| u8::try_from(*u).ok().or(Some(0xff)))
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn hex4(&mut self) -> u16 {
        let digits = &self.s[self.i..self.i + 4];
        self.i += 4;
        digits.iter().fold(0, |n, d| {
            n * 16
                + char::from_u32(u32::from(*d))
                    .and_then(|c| c.to_digit(16))
                    .unwrap_or(0) as u16
        })
    }

    /// A string literal at `"`; its value's code units.
    fn string(&mut self) -> JsString {
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let u = self.s[self.i];
            self.i += 1;
            match u {
                0x22 => return JsString(out),
                0x5c => {
                    let e = self.s[self.i];
                    self.i += 1;
                    out.push(match u8::try_from(e).unwrap_or(0) {
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => self.hex4(),
                        _ => e, // `"`, `\`, `/`
                    });
                }
                u => out.push(u),
            }
        }
    }

    /// Past one value that isn't a string at the top of an array.
    fn skip_value(&mut self) {
        let mut depth = 0usize;
        loop {
            match self.peek() {
                None => return,
                Some(b'"') => {
                    self.string();
                    if depth == 0 {
                        return;
                    }
                    continue;
                }
                Some(b'[' | b'{') => depth += 1,
                Some(b']' | b'}') if depth == 0 => return,
                Some(b']' | b'}') => {
                    depth -= 1;
                    if depth == 0 {
                        self.i += 1;
                        return;
                    }
                }
                Some(b',') if depth == 0 => return,
                _ => {}
            }
            self.i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn js_strings_escape_lone_surrogates_like_json_stringify() {
        let s = JsString::from_units(vec![0x61, 0xd83d, 0x22, 0xdc00, 0x1f, 0xd83d, 0xde00]);
        assert_eq!(s.to_json(), "\"a\\ud83d\\\"\\udc00\\u001f\u{1f600}\"");
        assert_eq!(s.to_string_lossy(), "a\u{fffd}\"\u{fffd}\u{1f}\u{1f600}");
        assert_eq!(JsString::from("\u{2028}é").to_json(), "\"\u{2028}é\"");
    }

    #[test]
    fn trim_and_prefix_work_on_units() {
        let s = JsString::from("\u{feff}\u{a0} a\u{1f600} \u{3000}");
        assert_eq!(s.trim(), JsString::from("a\u{1f600}"));
        assert_eq!(s.trim().prefix(2).units(), &[0x61, 0xd83d]);
        assert_eq!(JsString::from("   ").trim(), JsString::default());
        assert_eq!(JsString::from("\u{85}x").trim(), JsString::from("\u{85}x"));
        assert_eq!(JsString::from("ab").prefix(9), JsString::from("ab"));
    }

    #[test]
    fn stand_ins_read_as_lone_surrogates() {
        let body = crate::js_string::parse(r#"[" \ud83d", "x\udc00y\ud83d\ude00"]"#).unwrap();
        let cleaned = clean_examples(body.as_array().unwrap());
        assert_eq!(cleaned[0].units(), &[0xd83d]);
        assert_eq!(json_array(&cleaned), "[\"\\ud83d\",\"x\\udc00y\u{1f600}\"]");
        assert_eq!(JsString::from("\u{10f800}").units(), &[0xd800]);
    }

    #[test]
    fn parse_reads_strings_and_skips_the_rest() {
        let got = parse(r#" [ "a\ud83d", 1, [ "x", {"k": "]"} ], {"a": [1]}, "b\"\\\/\u0041" ] "#);
        assert_eq!(
            got,
            Some(Parsed::Array(vec![
                Some(JsString::from_units([units("a"), vec![0xd83d]].concat())),
                None,
                None,
                None,
                Some(JsString::from("b\"\\/A")),
            ]))
        );
        assert_eq!(parse("[]"), Some(Parsed::Array(vec![])));
        assert_eq!(parse("[1,"), None);
        assert_eq!(
            parse("\"\\ud800\""),
            Some(Parsed::String(JsString::from_units(vec![0xd800])))
        );
        assert_eq!(parse("null"), Some(Parsed::Other));
        assert_eq!(parse("\u{feff}[]"), None);
    }

    #[test]
    fn only_text_and_blobs_are_parsed() {
        assert_eq!(parse_input(ValueRef::Null), None);
        assert_eq!(parse_input(ValueRef::Integer(7)), None);
        assert_eq!(parse_input(ValueRef::Real(1.5)), None);
        assert_eq!(parse_input(ValueRef::Text(b"")), Some(String::new()));
        assert_eq!(
            parse_input(ValueRef::Blob(b"[\"\xff\"]")),
            Some("[\"\u{fffd}\"]".into())
        );
    }
}
