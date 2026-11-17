//! The JS regex semantics the ported patterns rely on, on the `regex`
//! crate (whose defaults are Unicode-aware where V8's are not):
//!
//! - `\s` is JS whitespace ([`WS`]: no U+0085, plus U+FEFF);
//! - `\d` is `[0-9]` and `\b` the ASCII word boundary (`(?-u:\b)`);
//! - `.` stops at `\n`, `\r`, U+2028 and U+2029 ([`DOT`]);
//! - `/i` without `u` folds only ASCII letters for an ASCII pattern (V8's
//!   `Canonicalize` never maps a non-ASCII character to an ASCII one, so
//!   `ſ` is not `s` and `K` is not `k`): [`AsciiCi`] matches a lowercase
//!   pattern against the ASCII-lowercased text, whose byte offsets are the
//!   original's.

use regex::Regex;
use serde_json::Value;

/// The members of JS `\s`, for a character class.
pub(crate) const WS: &str = r"\t\n\x0b\x0c\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// JS `.` (no `s` flag).
pub(crate) const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

/// A `/…/i` regex with an ASCII-only pattern, written in lowercase.
pub(crate) struct AsciiCi(Regex);

impl AsciiCi {
    pub(crate) fn new(lowercase_pattern: &str) -> Self {
        debug_assert!(!lowercase_pattern.chars().any(|c| c.is_ascii_uppercase()));
        Self(Regex::new(lowercase_pattern).expect("a valid pattern"))
    }

    pub(crate) fn is_match(&self, text: &str) -> bool {
        self.0.is_match(&text.to_ascii_lowercase())
    }

    /// The byte spans of the first match's groups, in `text`.
    pub(crate) fn captures(&self, text: &str) -> Option<Vec<Option<(usize, usize)>>> {
        let lower = text.to_ascii_lowercase();
        let c = self.0.captures(&lower)?;
        Some(c.iter().map(|m| m.map(|m| (m.start(), m.end()))).collect())
    }
}

/// `String(v)` for the `+=` / `join` the TS does on an SDK field: a
/// `TypeError` for an object that shadows `toString`.
pub(crate) fn to_js_string(v: &Value) -> Result<String, crate::JsThrow> {
    claudius_core::js_string::to_js_string(v)
        .map_err(|_| crate::JsThrow::type_error("Cannot convert object to primitive value"))
}

/// `out += s` on JS strings: a lone high surrogate at the end of `out` and
/// a lone low one at the start of `s` join into one character.
pub(crate) fn push_js(out: &mut String, s: &str) {
    use claudius_core::js_string::lone_unit;
    if let (Some(last), Some(first)) = (out.chars().next_back(), s.chars().next())
        && let (Some(hi @ 0xD800..=0xDBFF), Some(lo @ 0xDC00..=0xDFFF)) =
            (lone_unit(last), lone_unit(first))
    {
        out.pop();
        out.extend(char::decode_utf16([hi, lo]).map(|c| c.expect("a pair")));
        out.push_str(&s[first.len_utf8()..]);
        return;
    }
    out.push_str(s);
}

/// `typeof v === "string" ? v : …` for a field that must be a string.
pub(crate) fn as_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `v?.[key]` on a JSON value (an own property of an object; `undefined`
/// for anything else, arrays and strings included, since no key the
/// helpers read is an index or `length`).
pub(crate) fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    claudius_agent::js::prop(v, key)
}

/// JS truthiness, with `undefined` as `None`.
pub(crate) fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(claudius_agent::js::truthy)
}

/// `a === b` for two JSON values (`None` is `undefined`). Objects and
/// arrays are references, and two parsed ones are never the same.
pub(crate) fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `typeof v === "number"` (a JSON number is never `NaN`).
pub(crate) fn as_num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// A field the TS copies without a check and types as a string: the string,
/// or `""` for anything else (see the crate docs).
pub(crate) fn wire_str(v: Option<&Value>) -> String {
    as_str(v).unwrap_or_default().to_owned()
}

/// Builds `[{WS}]`-style patterns: `{WS}` and `{DOT}` in `pattern` are
/// replaced by the JS classes.
pub(crate) fn js_pattern(pattern: &str) -> String {
    pattern.replace("{WS}", WS).replace("{DOT}", DOT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_classes() {
        let ws = Regex::new(&js_pattern("^[{WS}]+$")).unwrap();
        assert!(ws.is_match("\u{feff} \t\u{3000}"));
        assert!(!ws.is_match("\u{85}"));
        let b = Regex::new(r"(?-u:\b)opus(?-u:\b)").unwrap();
        assert!(b.is_match("éopus"));
        assert!(!b.is_match("xopus"));
        let ci = AsciiCi::new("opus");
        assert!(ci.is_match("OPUS"));
        assert!(!ci.is_match("opu\u{17f}"));
        let mut s = format!("a{}", claudius_core::js_string::lone(0xD83D));
        push_js(&mut s, &claudius_core::js_string::lone(0xDE00).to_string());
        assert_eq!(s, "a\u{1F600}");
        push_js(&mut s, &claudius_core::js_string::lone(0xDE00).to_string());
        assert_eq!(claudius_core::js_string::len16(&s), 4);
        let dot = Regex::new(&js_pattern("a{DOT}*b")).unwrap();
        assert!(dot.is_match("a\u{85}b"));
        assert!(!dot.is_match("a\u{2028}b"));
    }

    #[test]
    fn strict_eq_is_js_triple_equals() {
        use serde_json::json;
        // `undefined === undefined`, and numbers by value (`0 === -0`), not
        // by serde_json's integer / float representation.
        assert!(strict_eq(None, None));
        assert!(strict_eq(Some(&json!(0)), Some(&json!(-0.0))));
        assert!(strict_eq(Some(&json!(1)), Some(&json!(1.0))));
        assert!(!strict_eq(Some(&json!(1)), Some(&json!("1"))));
        assert!(!strict_eq(None, Some(&Value::Null)));
        assert!(!strict_eq(Some(&json!({})), Some(&json!({}))));
    }
}
