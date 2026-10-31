//! JS strings in Rust `String`s, lone surrogates included.
//!
//! A JS string is a sequence of UTF-16 code units, and nothing stops one
//! from holding a lone surrogate: `JSON.parse('"\ud800"')`, the first unit
//! of an astral character (`"😀 rocket".match(/\S/)[0]`), a string spread
//! into an object (`{..."a😀"}` gives keys `"1": "\ud83d"`, `"2": "\ude00"`).
//! `JSON.stringify` then writes it as the escape `"\ud800"`, so such a value
//! survives a file round trip byte for byte. A Rust `str` can't hold one.
//!
//! Here a lone surrogate `u` (U+D800..U+DFFF) is the char
//! `U+10F800 + (u - 0xD800)`: the top 2048 code points of Supplementary
//! Private Use Area-B stand in for the 2048 surrogates. [`parse`] reads
//! lone-surrogate escapes into them, [`stringify`] writes them back as the
//! escapes, and [`units`] / [`from_units`] convert to and from UTF-16 code
//! units, so string lengths, indices and spreads count like JS. A real
//! character in U+10F800..U+10FFFF (private use, never assigned) reads as the
//! surrogate it stands for: the one place this differs from JS. [`lossy`] is
//! the string as UTF-8 bytes see it (`Buffer.from`, a file path): U+FFFD
//! for each lone surrogate.

use std::borrow::Cow;

use claudius_agent::js;
use serde_json::{Map, Value};

const LONE_BASE: u32 = 0x10_F800;

/// The char standing in for the lone surrogate `unit` (`0xD800..=0xDFFF`).
pub fn lone(unit: u16) -> char {
    debug_assert!((0xD800..=0xDFFF).contains(&unit));
    char::from_u32(LONE_BASE + (u32::from(unit) - 0xD800)).expect("below U+110000")
}

/// The surrogate `c` stands for, if it is a [`lone`] stand-in.
pub fn lone_unit(c: char) -> Option<u16> {
    let v = c as u32;
    (v >= LONE_BASE).then(|| (v - LONE_BASE + 0xD800) as u16)
}

/// The JS string's UTF-16 code units.
pub fn units(s: &str) -> Vec<u16> {
    let mut out = Vec::with_capacity(s.len());
    for c in s.chars() {
        match lone_unit(c) {
            Some(u) => out.push(u),
            None => {
                let mut buf = [0u16; 2];
                out.extend_from_slice(c.encode_utf16(&mut buf));
            }
        }
    }
    out
}

/// The string of these UTF-16 code units: pairs are characters, lone
/// surrogates their stand-ins.
pub fn from_units(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|r| r.unwrap_or_else(|e| lone(e.unpaired_surrogate())))
        .collect()
}

/// `s.length`: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.chars()
        .map(|c| {
            if lone_unit(c).is_some() {
                1
            } else {
                c.len_utf16()
            }
        })
        .sum()
}

/// The string as UTF-8 bytes carry it (`Buffer.from(s)`, a file path, a
/// header): each lone surrogate becomes U+FFFD.
pub fn lossy(s: &str) -> Cow<'_, str> {
    if s.chars().any(|c| lone_unit(c).is_some()) {
        Cow::Owned(
            s.chars()
                .map(|c| {
                    if lone_unit(c).is_some() {
                        '\u{FFFD}'
                    } else {
                        c
                    }
                })
                .collect(),
        )
    } else {
        Cow::Borrowed(s)
    }
}

/// [`lossy`] applied to every string and key in `v`.
pub fn lossy_value(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(lossy(s).into_owned()),
        Value::Array(a) => Value::Array(a.iter().map(lossy_value).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (lossy(k).into_owned(), lossy_value(v)))
                .collect(),
        ),
        v => v.clone(),
    }
}

/// `String.prototype.toUpperCase` (full case mapping, as `ß` → `SS`); a
/// lone surrogate has no case.
pub fn to_upper(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if lone_unit(c).is_some() {
            out.push(c);
        } else {
            out.extend(c.to_uppercase());
        }
    }
    out
}

/// `s.match(/\S/)?.[0]`: the first code unit that isn't JS whitespace. The
/// regex has no `u` flag, so for an astral character that is its high
/// surrogate alone.
pub fn first_non_space_unit(s: &str) -> Option<String> {
    let c = s.chars().find(|c| !js::is_whitespace(*c))?;
    if lone_unit(c).is_some() || c.len_utf16() == 1 {
        return Some(c.to_string());
    }
    let mut buf = [0u16; 2];
    c.encode_utf16(&mut buf);
    Some(lone(buf[0]).to_string())
}

/// `for (const ch of s)`: one string per code point (an astral character
/// whole, a lone surrogate alone).
pub fn code_points(s: &str) -> Vec<String> {
    s.chars().map(String::from).collect()
}

/// The own enumerable properties a string spreads into an object
/// (`{...s}`): one per UTF-16 code unit, keyed `"0"`, `"1"`, ...
pub fn spread_string(s: &str) -> Vec<(String, Value)> {
    units(s)
        .into_iter()
        .enumerate()
        .map(|(i, u)| (i.to_string(), Value::String(from_units(&[u]))))
        .collect()
}

/// `{...target, ...src}` for a JSON value `src`: an object's own keys (array
/// indices first, ascending, then the rest in order), an array's indices, a
/// string's code units; `null`, numbers and booleans add nothing. A key that
/// is already there keeps its place and takes the new value.
pub fn spread_into(target: &mut Map<String, Value>, src: &Value) {
    match src {
        Value::Object(m) => {
            for (k, v) in js::own_keys_order(m) {
                target.insert(k.clone(), v.clone());
            }
        }
        Value::Array(a) => {
            for (i, v) in a.iter().enumerate() {
                target.insert(i.to_string(), v.clone());
            }
        }
        Value::String(s) => {
            for (k, v) in spread_string(s) {
                target.insert(k, v);
            }
        }
        _ => {}
    }
}

/// A `TypeError` while turning an object into a primitive: a JSON object
/// with its own `toString` key shadows `Object.prototype.toString` with a
/// value that isn't callable (and its `valueOf` gives back the object), so
/// `String(o)`, `` `${o}` `` and `Number(o)` all throw "Cannot convert object
/// to primitive value".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoPrimitive;

/// `String(v)` (and template literals) for a JSON value: `null` prints
/// `"null"`, arrays join their items with `,` (`null` items empty), objects
/// `[object Object]`, unless one shadows `toString` ([`NoPrimitive`]).
pub fn to_js_string(v: &Value) -> Result<String, NoPrimitive> {
    match v {
        Value::Array(items) => {
            let mut out = String::new();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !item.is_null() {
                    out.push_str(&to_js_string(item)?);
                }
            }
            Ok(out)
        }
        Value::Object(m) if m.contains_key("toString") => Err(NoPrimitive),
        Value::Object(_) => Ok("[object Object]".into()),
        Value::String(s) => Ok(s.clone()),
        v => Ok(js::to_string(Some(v))),
    }
}

/// `Number(v)` for a JSON value (`None` is `undefined`, `NaN`).
pub fn to_js_number(v: Option<&Value>) -> Result<f64, NoPrimitive> {
    Ok(match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js::to_number(s),
        Some(v @ (Value::Array(_) | Value::Object(_))) => js::to_number(&to_js_string(v)?),
    })
}

// ---- JSON --------------------------------------------------------------------

/// `JSON.parse(text)`, lone-surrogate escapes kept as their stand-ins, or
/// the message of V8's `SyntaxError`. As with
/// [`claudius_agent::js::json_parse`], a number past the `f64` range is
/// `null` (JS `Infinity`, which `JSON.stringify` writes as `null`), and
/// nesting past serde_json's 128 levels is an `Err` where V8 parses it.
pub fn parse(text: &str) -> Result<Value, String> {
    if let Some(message) = js::json_parse_error(text) {
        return Err(message);
    }
    match serde_json::from_str(text) {
        Ok(v) => Ok(v),
        Err(_) => serde_json::from_str(&representable(text)).map_err(|e| e.to_string()),
    }
}

/// Rewrites text V8 accepts so serde_json reads it as JS does: a `\u`
/// escape of a lone surrogate becomes its stand-in character, a number out
/// of `f64` range `null`.
fn representable(text: &str) -> String {
    let b = text.as_bytes();
    // The code unit of the `\uXXXX` escape at `i` (V8 checked its digits).
    let unit = |i: usize| u16::from_str_radix(&text[i + 2..i + 6], 16).ok();
    let is_low =
        |i: usize| text[i..].starts_with("\\u") && matches!(unit(i), Some(0xDC00..=0xDFFF));
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut i, mut in_string) = (0, 0, false);
    while i < b.len() {
        match (in_string, b[i]) {
            (true, b'"') => in_string = false,
            (true, b'\\') if b[i + 1] == b'u' => {
                let u = unit(i);
                if matches!(u, Some(0xD800..=0xDBFF)) && is_low(i + 6) {
                    i += 6; // a pair: keep both escapes
                } else if let Some(u @ 0xD800..=0xDFFF) = u {
                    out.push_str(&text[copied..i]);
                    out.push(lone(u));
                    copied = i + 6;
                }
                i += 5;
            }
            (true, b'\\') => i += 1,
            (false, b'"') => in_string = true,
            (false, b'-' | b'0'..=b'9') => {
                let len = b[i..]
                    .iter()
                    .take_while(|c| matches!(c, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
                    .count();
                if text[i..i + len].parse::<f64>().is_ok_and(f64::is_infinite) {
                    out.push_str(&text[copied..i]);
                    out.push_str("null");
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

/// `JSON.stringify(v)`, lone surrogates written as `\udXXX` escapes.
pub fn stringify(v: &Value) -> String {
    escape_lone(js::stringify(v))
}

/// `JSON.stringify(v, null, 2)`, lone surrogates written as escapes.
pub fn stringify_pretty(v: &Value) -> String {
    escape_lone(js::stringify_pretty(v))
}

/// Outside its strings, JSON text is ASCII, so every stand-in is inside one.
fn escape_lone(json: String) -> String {
    if !json.chars().any(|c| lone_unit(c).is_some()) {
        return json;
    }
    let mut out = String::with_capacity(json.len() + 8);
    for c in json.chars() {
        match lone_unit(c) {
            Some(u) => out.push_str(&format!("\\u{u:04x}")),
            None => out.push(c),
        }
    }
    out
}

// ---- URI components ------------------------------------------------------------

/// `encodeURIComponent(s)`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )`
/// as `%XX` UTF-8 bytes; `None` (a `URIError`) for a lone surrogate.
pub fn encode_uri_component(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if lone_unit(c).is_some() {
            return None;
        }
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    Some(out)
}

/// `decodeURIComponent(s)`: every `%XX` escape (a whole UTF-8 sequence of
/// them for a non-ASCII character) decoded, everything else kept; `None` (a
/// `URIError`) for a malformed escape or a sequence that isn't valid UTF-8
/// (overlong, a surrogate, past U+10FFFF).
pub fn decode_uri_component(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let hex_octet = |at: usize| -> Option<u8> {
        let hi = chars.get(at)?.to_digit(16)?;
        let lo = chars.get(at + 1)?.to_digit(16)?;
        Some((hi * 16 + lo) as u8)
    };
    let mut out = String::with_capacity(s.len());
    let mut k = 0;
    while k < chars.len() {
        if chars[k] != '%' {
            out.push(chars[k]);
            k += 1;
            continue;
        }
        let b = hex_octet(k + 1)?;
        k += 3;
        let n = b.leading_ones() as usize;
        if n == 0 {
            out.push(char::from(b));
            continue;
        }
        if n == 1 || n > 4 {
            return None;
        }
        let mut octets = vec![b];
        for _ in 1..n {
            if chars.get(k) != Some(&'%') {
                return None;
            }
            octets.push(hex_octet(k + 1)?);
            k += 3;
        }
        out.push_str(std::str::from_utf8(&octets).ok()?);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lone_surrogates_round_trip_through_json() {
        let text = r#"{"a":"\ud800","b":"x\udfffy","c":"\ud83d\ude00","\udc00":["\ud83d"]}"#;
        let v = parse(text).unwrap();
        assert_eq!(
            stringify(&v),
            r#"{"a":"\ud800","b":"x\udfffy","c":"😀","\udc00":["\ud83d"]}"#
        );
        assert_eq!(units(v["a"].as_str().unwrap()), vec![0xD800]);
        assert_eq!(len16(v["b"].as_str().unwrap()), 3);
        assert_eq!(lossy(v["b"].as_str().unwrap()), "x\u{FFFD}y");
        // `\\ud800` is an escaped backslash, not an escape.
        assert_eq!(parse(r#""\\ud800""#).unwrap(), json!("\\ud800"));
        // Two highs, then a pair.
        let v = parse(r#""\ud800\ud83d\ude00""#).unwrap();
        assert_eq!(units(v.as_str().unwrap()), vec![0xD800, 0xD83D, 0xDE00]);
        assert_eq!(parse("1e400").unwrap(), Value::Null);
        assert!(parse("{").is_err());
    }

    #[test]
    fn units_round_trip() {
        for u in [
            vec![0x61, 0xD83D, 0xDE00, 0xD800],
            vec![0xDC00, 0xD800],
            vec![0xDBFD, 0xDFFF],
            vec![],
        ] {
            assert_eq!(units(&from_units(&u)), u);
        }
        // The one ambiguity: a real character in U+10F800..U+10FFFF.
        assert_eq!(units(&from_units(&[0xDBFF, 0xDFFF])), vec![0xDFFF]);
        // A high then a low, joined, is the character.
        assert_eq!(from_units(&[0xD83D, 0xDE00]), "😀");
    }

    #[test]
    fn spreads_and_letters_count_units() {
        let mut m = Map::new();
        spread_into(&mut m, &json!("a😀"));
        assert_eq!(
            stringify(&Value::Object(m)),
            r#"{"0":"a","1":"\ud83d","2":"\ude00"}"#
        );
        assert_eq!(
            first_non_space_unit(" 😀").map(|s| units(&s)),
            Some(vec![0xD83D])
        );
        assert_eq!(first_non_space_unit("\u{feff} x").as_deref(), Some("x"));
        assert_eq!(first_non_space_unit(" \t"), None);
        assert_eq!(to_upper("ß"), "SS");
    }

    #[test]
    fn to_js_string_matches_string() {
        assert_eq!(
            to_js_string(&json!([1, [2, null], null, "a"])).unwrap(),
            "1,2,,,a"
        );
        assert_eq!(to_js_string(&json!({"a": 1})).unwrap(), "[object Object]");
        assert_eq!(to_js_string(&json!({"toString": 1})), Err(NoPrimitive));
        assert_eq!(to_js_string(&json!([{"toString": 1}])), Err(NoPrimitive));
        assert_eq!(to_js_string(&json!(null)).unwrap(), "null");
        assert_eq!(to_js_number(Some(&json!([26]))).unwrap(), 26.0);
        assert!(to_js_number(Some(&json!({}))).unwrap().is_nan());
    }

    #[test]
    fn uri_components() {
        assert_eq!(
            encode_uri_component("a b/é").as_deref(),
            Some("a%20b%2F%C3%A9")
        );
        assert_eq!(encode_uri_component(&lone(0xD800).to_string()), None);
        assert_eq!(decode_uri_component("%C3%A9%41").as_deref(), Some("éA"));
        assert_eq!(decode_uri_component("%ED%A0%80"), None);
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%C0%80"), None);
    }
}
