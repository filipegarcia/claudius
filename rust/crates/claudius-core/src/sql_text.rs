//! SQLite TEXT the way better-sqlite3 binds and reads JS strings (I15).
//!
//! better-sqlite3 binds a JS string through V8's `String::Utf8Value` and
//! `sqlite3_bind_text` with its byte length: UTF-8, a surrogate pair as its
//! 4-byte character, a NUL kept, and a lone surrogate as its own 3-byte
//! sequence (`\ud800` → `ED A0 80`), which isn't UTF-8. A Rust string holds
//! a lone surrogate as its [`js_string`] stand-in, whose UTF-8 (`F4 8F A0
//! 80`) is neither those bytes nor the U+FFFD (`EF BF BD`) of
//! [`js_string::lossy`]. Binding through [`JsText`] (or [`js_params!`])
//! writes the bytes TS writes, so a row either side wrote matches a
//! lookup from the other. A string without a stand-in binds as itself.
//!
//! better-sqlite3 reads TEXT back with V8's `String::NewFromUtf8`: one
//! U+FFFD per maximal invalid subpart, so a lone surrogate's 3 bytes read
//! as three U+FFFD. That is `String::from_utf8_lossy` ([`decode`]); [`get`]
//! reads a column that way, where rusqlite's `String` fails on bytes that
//! aren't UTF-8 (and its `Value` panics).
//!
//! The ambiguity of [`js_string`] carries over: a genuine U+10F800–U+10FFFF
//! character binds as the lone surrogate it stands for. So a value read back
//! from the database and bound again in the same call (a popped row's
//! `uuid`, a stored MCP server name) binds as it is: its UTF-8 is exactly
//! what TS binds for the string it read back.

use std::borrow::Cow;

use rusqlite::types::{FromSql, ToSqlOutput, Value, ValueRef};
use rusqlite::{Row, RowIndex, ToSql};

use crate::js_string;

/// The bytes better-sqlite3 binds for the JS string `s`: its UTF-8, with
/// each lone surrogate (a [`js_string`] stand-in) as its own 3-byte
/// sequence. Two stand-ins that make a pair (a high, then a low) are that
/// pair's character, as they are in a JS string. Borrowed when `s` has no
/// stand-in.
pub fn encode(s: &str) -> Cow<'_, [u8]> {
    if !s.chars().any(|c| js_string::lone_unit(c).is_some()) {
        return Cow::Borrowed(s.as_bytes());
    }
    let mut out = Vec::with_capacity(s.len());
    for c in char::decode_utf16(js_string::units(s)) {
        match c {
            Ok(c) => out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes()),
            Err(e) => {
                let u = e.unpaired_surrogate();
                out.extend_from_slice(&[
                    0xE0 | (u >> 12) as u8,
                    0x80 | ((u >> 6) & 0x3F) as u8,
                    0x80 | (u & 0x3F) as u8,
                ]);
            }
        }
    }
    Cow::Owned(out)
}

/// TEXT bytes as better-sqlite3 hands them to JS: UTF-8, each maximal
/// invalid subpart a U+FFFD.
pub fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A parameter bound as better-sqlite3 binds the JS value it stands for:
/// any text ([`ToSql`] giving TEXT: `&str`, `String`, `Option<&str>`, a
/// `Value::Text`, …) as [`encode`] writes it, everything else (numbers,
/// blobs, NULL) unchanged.
#[derive(Clone, Debug)]
pub struct JsText<T> {
    value: T,
    /// The re-encoded text, when it differs from the value's own bytes.
    text: Option<Vec<u8>>,
}

impl<T: ToSql> JsText<T> {
    pub fn new(value: T) -> JsText<T> {
        let reencoded = |s: &str| match encode(s) {
            Cow::Owned(b) => Some(b),
            Cow::Borrowed(_) => None,
        };
        // A value that fails to convert fails again when it is bound.
        let text = match value.to_sql() {
            Ok(ToSqlOutput::Borrowed(ValueRef::Text(b))) => {
                std::str::from_utf8(b).ok().and_then(reencoded)
            }
            Ok(ToSqlOutput::Owned(Value::Text(s))) => reencoded(&s),
            _ => None,
        };
        JsText { value, text }
    }
}

impl<T: ToSql> ToSql for JsText<T> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        match &self.text {
            Some(b) => Ok(ToSqlOutput::Borrowed(ValueRef::Text(b))),
            None => self.value.to_sql(),
        }
    }
}

/// `rusqlite::params!` with every parameter bound through [`JsText`].
#[macro_export]
macro_rules! js_params {
    () => {
        &[] as &[&dyn ::rusqlite::ToSql]
    };
    ($($param:expr),+ $(,)?) => {
        &[$(&$crate::sql_text::JsText::new(&$param) as &dyn ::rusqlite::ToSql),+]
            as &[&dyn ::rusqlite::ToSql]
    };
}

/// better-sqlite3's binding of `stmt.run(...args)` (or `.get`) to a
/// statement with `placeholders` anonymous parameters, for JS values that
/// arrive as JSON (S29a): an array argument spreads its items, a plain
/// object binds named parameters (there are none, so it binds nothing), a
/// number is a REAL (so `7` stored in a TEXT column reads `"7.0"`), a
/// string TEXT, `null` NULL, and anything else is a `TypeError`. The type
/// is checked before the count, then the count must match. `Err` is
/// better-sqlite3's message.
pub fn bind_js_args(args: &[serde_json::Value], placeholders: usize) -> Result<Vec<Value>, String> {
    use serde_json::Value as Json;
    const TYPE: &str = "SQLite3 can only bind numbers, strings, bigints, buffers, and null";
    const TOO_MANY: &str = "Too many parameter values were provided";
    let mut out = Vec::with_capacity(placeholders);
    let push = |v: &Json, out: &mut Vec<Value>| {
        let scalar = match v {
            Json::Null => Value::Null,
            Json::Number(n) => Value::Real(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => Value::Text(s.clone()),
            _ => return Err(TYPE),
        };
        if out.len() == placeholders {
            return Err(TOO_MANY);
        }
        out.push(scalar);
        Ok(())
    };
    let mut bound_object = false;
    for arg in args {
        match arg {
            Json::Array(items) => {
                for item in items {
                    push(item, &mut out)?;
                }
            }
            Json::Object(_) => {
                if bound_object {
                    return Err(
                        "You cannot specify named parameters in two different objects".into(),
                    );
                }
                bound_object = true;
            }
            v => push(v, &mut out)?,
        }
    }
    if out.len() < placeholders {
        return Err("Too few parameter values were provided".into());
    }
    Ok(out)
}

/// `st`'s parameters bound from the JS values `args` ([`bind_js_args`]),
/// each text through [`JsText`]. A bind that fails in better-sqlite3 is a
/// `ToSqlConversionFailure` carrying its message, before anything runs.
pub fn js_args(
    st: &rusqlite::Statement<'_>,
    args: &[serde_json::Value],
) -> rusqlite::Result<rusqlite::ParamsFromIter<Vec<JsText<Value>>>> {
    let values = bind_js_args(args, st.parameter_count())
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
    Ok(rusqlite::params_from_iter(
        values.into_iter().map(JsText::new).collect(),
    ))
}

/// A column type [`get`] reads TEXT into.
pub trait FromJsText: FromSql {
    fn from_js_text(text: String) -> Self;
}

impl FromJsText for String {
    fn from_js_text(text: String) -> Self {
        text
    }
}

impl FromJsText for Option<String> {
    fn from_js_text(text: String) -> Self {
        Some(text)
    }
}

impl FromJsText for Value {
    fn from_js_text(text: String) -> Self {
        Value::Text(text)
    }
}

/// `r.get(i)`, with TEXT [`decode`]d as better-sqlite3 reads it; any other
/// storage class converts (or fails) as `r.get` does.
pub fn get<T: FromJsText, I: RowIndex + Copy>(r: &Row<'_>, i: I) -> rusqlite::Result<T> {
    match r.get_ref(i)? {
        ValueRef::Text(t) => Ok(T::from_js_text(decode(t))),
        _ => r.get(i),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_string::lone;
    use rusqlite::Connection;

    fn hex(conn: &Connection, v: &dyn ToSql) -> (String, String) {
        conn.query_row("SELECT typeof(?1), hex(?1)", [v], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap()
    }

    #[test]
    fn encode_writes_lone_surrogates_as_three_bytes() {
        let s = format!("a{}b{}", lone(0xD800), lone(0xDFFF));
        assert_eq!(&*encode(&s), b"a\xED\xA0\x80b\xED\xBF\xBF");
        assert_eq!(&*encode(&lone(0xDC00).to_string()), b"\xED\xB0\x80");
        // A low then a high are two lone surrogates.
        let rev = format!("{}{}", lone(0xDFFF), lone(0xD800));
        assert_eq!(&*encode(&rev), b"\xED\xBF\xBF\xED\xA0\x80");
        // A high then a low, side by side, are the pair's character.
        let pair = format!("x{}{}y", lone(0xD83D), lone(0xDE00));
        assert_eq!(&*encode(&pair), "x\u{1F600}y".as_bytes());
        for plain in ["", "abc", "nul\0mid", "\u{1F600}", "\u{FFFD}", "\u{10F7FF}"] {
            assert!(matches!(encode(plain), Cow::Borrowed(b) if b == plain.as_bytes()));
        }
    }

    #[test]
    fn decode_is_one_replacement_per_maximal_subpart() {
        assert_eq!(decode(b"\xED\xA0\x80"), "\u{FFFD}".repeat(3));
        assert_eq!(decode(b"\xE2\x82"), "\u{FFFD}");
        assert_eq!(decode(b"\xF0\x9F\x98"), "\u{FFFD}");
        assert_eq!(decode(b"\xC0\xAF"), "\u{FFFD}\u{FFFD}");
        assert_eq!(decode(b"a\0b"), "a\0b");
    }

    #[test]
    fn binds_text_as_better_sqlite3_and_leaves_the_rest() {
        let conn = Connection::open_in_memory().unwrap();
        let s = format!("a{}b", lone(0xD800));
        let t = |a: &str, b: &str| (a.to_owned(), b.to_owned());
        assert_eq!(
            hex(&conn, &JsText::new(s.as_str())),
            t("text", "61EDA08062")
        );
        assert_eq!(hex(&conn, &JsText::new(s.clone())), t("text", "61EDA08062"));
        assert_eq!(hex(&conn, &JsText::new(&s)), t("text", "61EDA08062"));
        assert_eq!(
            hex(&conn, &JsText::new(Some(s.as_str()))),
            t("text", "61EDA08062")
        );
        assert_eq!(
            hex(&conn, &JsText::new(Value::Text(s.clone()))),
            t("text", "61EDA08062")
        );
        assert_eq!(hex(&conn, &JsText::new(None::<&str>)), t("null", ""));
        assert_eq!(hex(&conn, &JsText::new("x\0y")), t("text", "780079"));
        assert_eq!(hex(&conn, &JsText::new("")), t("text", ""));
        assert_eq!(hex(&conn, &JsText::new(1.5f64)), t("real", "312E35"));
        assert_eq!(hex(&conn, &JsText::new(7i64)), t("integer", "37"));
        // A blob holding a stand-in's UTF-8 stays those bytes.
        let blob = s.clone().into_bytes();
        assert_eq!(
            hex(&conn, &JsText::new(Value::Blob(blob))),
            t("blob", "61F48FA08062")
        );
        // Without the wrapper, the stand-in's own UTF-8.
        assert_eq!(hex(&conn, &s), t("text", "61F48FA08062"));
    }

    #[test]
    fn js_params_bind_every_parameter() {
        let conn = Connection::open_in_memory().unwrap();
        let (id, n) = (lone(0xDC00).to_string(), 3i64);
        let row: (String, String, i64) = conn
            .query_row("SELECT hex(?), hex(?), ?", js_params![id, "a", n], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(row, ("EDB080".into(), "61".into(), 3));
        let none: i64 = conn
            .query_row("SELECT 1", js_params![], |r| r.get(0))
            .unwrap();
        assert_eq!(none, 1);
    }

    #[test]
    fn get_reads_text_as_better_sqlite3_does() {
        let conn = Connection::open_in_memory().unwrap();
        let sql = "SELECT CAST(x'61EDA080' AS TEXT), NULL, 5, x'ED', 'ok'";
        conn.query_row(sql, [], |r| {
            let fffd = format!("a{}", "\u{FFFD}".repeat(3));
            assert!(
                r.get::<_, String>(0).is_err(),
                "rusqlite's String refuses it"
            );
            assert_eq!(get::<String, _>(r, 0)?, fffd);
            assert_eq!(get::<Option<String>, _>(r, 0)?, Some(fffd.clone()));
            assert_eq!(get::<Value, _>(r, 0)?, Value::Text(fffd));
            assert_eq!(get::<Option<String>, _>(r, 1)?, None);
            assert!(get::<String, _>(r, 1).is_err());
            assert!(get::<String, _>(r, 2).is_err());
            assert_eq!(get::<Value, _>(r, 2)?, Value::Integer(5));
            assert_eq!(get::<Value, _>(r, 3)?, Value::Blob(vec![0xED]));
            assert_eq!(get::<String, _>(r, 4)?, "ok");
            Ok(())
        })
        .unwrap();
    }
}
