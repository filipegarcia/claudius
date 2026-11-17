//! Request-body semantics of the TS route handlers.
//!
//! Ported routes read bodies in one of four ways, and each fails
//! differently. Pick the helper that matches the TS line, and call it at the
//! same point in the handler (usually *after* the "session not found" check,
//! since `req.json()` is only evaluated where it appears):
//!
//! | TS                                              | Rust                              | bad body →            |
//! |-------------------------------------------------|-----------------------------------|-----------------------|
//! | `await req.json()` (uncaught)                   | [`JsonBody::strict`]              | Next's bare 500       |
//! | `await req.json().catch(() => ({}))` / `null`   | [`JsonBody::lenient`] (fallback)  | the fallback          |
//! | `try { await req.json() } catch { body = {} }`  | [`JsonBody::lenient`] (`{}`)      | the fallback          |
//! | `try { … } catch { return 400 {error} }`        | [`JsonBody::or_bad_request`]      | 400 `{error: msg}`    |
//! | `try { … } catch (e) { … e.message … }`         | [`JsonBody::parse_or_message`]    | `Err(V8's message)`   |
//!
//! A handler that hands the body's strings back (stored, then answered)
//! keeps lone surrogates with [`JsonBody::parse_js_overflow`].
//!
//! Parsing follows `Body.json()`: UTF-8 decode (a BOM is stripped, invalid
//! bytes become U+FFFD), then `JSON.parse`, so any JSON value is accepted,
//! not only objects. What happens next with a non-object body depends on how
//! the handler reads it:
//! * `body?.x` (optional chaining) never throws: index the `Value` directly
//!   (`b["x"]` is `Null` for a missing key or a non-object body).
//! * `body.x` throws a `TypeError` when `body` is `null`, which Next turns
//!   into a bare 500: use [`js_member`].
//!
//! Known edges of `parse`, `strict`, `lenient` and `or_bad_request` (kept
//! as they are; [`JsonBody::parse_or_message`] has neither), where
//! `JSON.parse` accepts a body serde_json rejects (so it counts as malformed
//! here):
//! * lone UTF-16 surrogate escapes (`"\ud800"`);
//! * a number literal past the f64 range (`1e400`), which JS reads as
//!   ±Infinity. A handler that only tells such a value apart with
//!   `Number.isFinite` can use [`JsonBody::lenient_overflow`].
//!
//! They also strip one leading BOM where `Body.json()` strips two.

use std::borrow::Cow;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use claudius_core::js_string;
use serde_json::{Value, json};

/// What Next sends when a route handler throws: `new Response(null, {status: 500})`
/// (empty body, no content type).
pub fn thrown() -> Response {
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

/// Why a body was rejected; converts into the matching TS response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// The TS handler threw → [`thrown`].
    Thrown,
    /// `400 {error: msg}`.
    BadRequest(&'static str),
}

impl IntoResponse for Rejection {
    fn into_response(self) -> Response {
        match self {
            Rejection::Thrown => thrown(),
            Rejection::BadRequest(msg) => {
                (StatusCode::BAD_REQUEST, axum::Json(json!({"error": msg}))).into_response()
            }
        }
    }
}

pub struct JsonBody;

impl JsonBody {
    /// `Body.json()`: `None` when the body is empty or not valid JSON.
    pub fn parse(bytes: &[u8]) -> Option<Value> {
        let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        serde_json::from_str(&String::from_utf8_lossy(bytes)).ok()
    }

    /// `await req.json()` with nothing catching it: an empty or malformed
    /// body is an uncaught `SyntaxError` → [`thrown`].
    pub fn strict(bytes: &[u8]) -> Result<Value, Rejection> {
        Self::parse(bytes).ok_or(Rejection::Thrown)
    }

    /// `await req.json().catch(() => fallback)`, or a `try/catch` that
    /// assigns a fallback. A *valid* `null` body is returned as `null`, not
    /// replaced by the fallback.
    pub fn lenient(bytes: &[u8], fallback: Value) -> Value {
        Self::parse(bytes).unwrap_or(fallback)
    }

    /// `try { body = await req.json() } catch { return 400 {error: msg} }`.
    pub fn or_bad_request(bytes: &[u8], msg: &'static str) -> Result<Value, Rejection> {
        Self::parse(bytes).ok_or(Rejection::BadRequest(msg))
    }

    /// `Body.text()`, the text `Body.json()` parses: undici's
    /// `utf8DecodeBytes` drops a leading UTF-8 BOM, then its `TextDecoder`
    /// (which ignores a BOM by default) drops a second one, and invalid
    /// bytes become U+FFFD (one per maximal invalid subsequence, as
    /// [`String::from_utf8_lossy`] does).
    pub fn text(bytes: &[u8]) -> Cow<'_, str> {
        let once = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        let twice = once.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(once);
        String::from_utf8_lossy(twice)
    }

    /// `await req.json()` where the handler catches the error and uses its
    /// `message`: the value, or the message of V8's `SyntaxError`, byte for
    /// byte (an empty body is "Unexpected end of JSON input"). Positions in
    /// it count UTF-16 units of [`text`](Self::text). Any value V8 parses is
    /// `Ok`; see [`claudius_agent::js::json_parse`] for the few serde_json
    /// can't hold.
    pub fn parse_or_message(bytes: &[u8]) -> Result<Value, String> {
        claudius_agent::js::json_parse(&Self::text(bytes))
    }

    /// [`JsonBody::parse_or_message`], where each number literal that
    /// overflows an f64 (`1e400`, ±Infinity in JS) reads as `infinite`
    /// rather than `null`, as in [`JsonBody::lenient_overflow`]: for a
    /// handler that tells Infinity apart from `null`.
    pub fn parse_or_message_overflow(bytes: &[u8], infinite: &Value) -> Result<Value, String> {
        let text = Self::text(bytes);
        if let Some(message) = claudius_agent::js::json_parse_error(&text) {
            return Err(message);
        }
        match replace_overflowing_numbers(&text, &infinite.to_string()) {
            Some(replaced) => claudius_agent::js::json_parse(&replaced),
            None => claudius_agent::js::json_parse(&text),
        }
    }

    /// [`JsonBody::parse_or_message_overflow`] into JS strings: a
    /// lone-surrogate escape (`"\ud800"`) is kept as its [`js_string`]
    /// stand-in, so `js_string::stringify` writes it back as the escape.
    pub fn parse_js_overflow(bytes: &[u8], infinite: &Value) -> Result<Value, String> {
        let text = Self::text(bytes);
        if let Some(message) = claudius_agent::js::json_parse_error(&text) {
            return Err(message);
        }
        match replace_overflowing_numbers(&text, &infinite.to_string()) {
            Some(replaced) => js_string::parse(&replaced),
            None => js_string::parse(&text),
        }
    }

    /// [`JsonBody::lenient`], where each number literal that overflows an
    /// f64 (`1e400`, ±Infinity in JS) reads as `infinite` instead of failing
    /// the whole body. A `Value` can't hold Infinity, so `infinite` is a
    /// stand-in the handler treats the same way (e.g. a string, where the TS
    /// only checks `Number.isFinite`).
    pub fn lenient_overflow(bytes: &[u8], fallback: Value, infinite: &Value) -> Value {
        if let Some(v) = Self::parse(bytes) {
            return v;
        }
        let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        replace_overflowing_numbers(&String::from_utf8_lossy(bytes), &infinite.to_string())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(fallback)
    }
}

/// `text` with every JSON number literal outside a string that parses to
/// ±Infinity replaced by `with`, or `None` when there is none. Anything that
/// isn't valid JSON stays as it is, so the parse still fails.
pub(crate) fn replace_overflowing_numbers(text: &str, with: &str) -> Option<String> {
    replace_overflowing_signed(text, with, with)
}

/// [`replace_overflowing_numbers`] with `neg` for a literal that overflows
/// to -Infinity (`-1e400`).
pub(crate) fn replace_overflowing_signed(text: &str, with: &str, neg: &str) -> Option<String> {
    let b = text.as_bytes();
    let (mut out, mut copied, mut i) = (String::new(), 0, 0);
    let mut in_string = false;
    while i < b.len() {
        let c = b[i];
        if in_string {
            match c {
                b'\\' => i += 1,
                b'"' => in_string = false,
                _ => {}
            }
            i += 1;
        } else if c == b'"' {
            in_string = true;
            i += 1;
        } else if c == b'-' || c.is_ascii_digit() {
            let start = i;
            while i < b.len() && matches!(b[i], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E') {
                i += 1;
            }
            let token = &text[start..i];
            if is_json_number(token) && token.parse::<f64>().is_ok_and(f64::is_infinite) {
                out.push_str(&text[copied..start]);
                out.push_str(if token.starts_with('-') { neg } else { with });
                copied = i;
            }
        } else {
            i += 1;
        }
    }
    (copied > 0).then(|| out + &text[copied..])
}

/// The JSON number grammar: `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`.
fn is_json_number(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s).as_bytes();
    let digits = |from: usize| s[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = digits(0);
    if int == 0 || (int > 1 && s[0] == b'0') {
        return false;
    }
    let mut i = int;
    if s.get(i) == Some(&b'.') {
        let frac = digits(i + 1);
        if frac == 0 {
            return false;
        }
        i += 1 + frac;
    }
    if matches!(s.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(s.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp = digits(i);
        if exp == 0 {
            return false;
        }
        i += exp;
    }
    i == s.len()
}

/// JS `body.key` (no optional chaining). Throws ([`thrown`]) when `body` is
/// `null`; `Ok(None)` is `undefined` (a missing key, or any non-object
/// body such as an array, string or number).
pub fn js_member<'a>(body: &'a Value, key: &str) -> Result<Option<&'a Value>, Rejection> {
    match body {
        Value::Null => Err(Rejection::Thrown),
        Value::Object(o) => Ok(o.get(key)),
        _ => Ok(None),
    }
}

/// JS truthiness of a body field (`if (body.flag)`): `undefined`, `null`,
/// `false`, `0`, `NaN` and `""` are falsy; everything else (incl. `[]`, `{}`,
/// `"0"`) is truthy.
pub fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `let v = tri!(expr);`: unwrap an `Ok`, or return the `Err` as a response.
#[macro_export]
macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return axum::response::IntoResponse::into_response(e),
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body_of(r: Response) -> (StatusCode, String, Option<String>) {
        let status = r.status();
        let ct = r
            .headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_owned());
        let bytes = axum::body::to_bytes(r.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap(), ct)
    }

    #[test]
    fn parse_follows_body_json() {
        assert_eq!(JsonBody::parse(b""), None);
        assert_eq!(JsonBody::parse(b"   "), None);
        assert_eq!(JsonBody::parse(b"{"), None);
        assert_eq!(JsonBody::parse(b"{'a':1}"), None);
        assert_eq!(JsonBody::parse(b"{\"a\":1} x"), None, "trailing garbage");
        // Any JSON value, not just objects.
        assert_eq!(JsonBody::parse(b"null"), Some(Value::Null));
        assert_eq!(JsonBody::parse(b"[1]"), Some(json!([1])));
        assert_eq!(JsonBody::parse(b"\"s\""), Some(json!("s")));
        assert_eq!(JsonBody::parse(b"42"), Some(json!(42)));
        assert_eq!(
            JsonBody::parse(b" \n\t{\"a\":1}\r\n"),
            Some(json!({"a": 1}))
        );
        // BOM stripped; invalid UTF-8 inside a string → U+FFFD, still parses.
        assert_eq!(
            JsonBody::parse(b"\xEF\xBB\xBF{\"a\":1}"),
            Some(json!({"a": 1}))
        );
        assert_eq!(
            JsonBody::parse(b"{\"a\":\"x\xFFy\"}"),
            Some(json!({"a": "x\u{FFFD}y"}))
        );
        // Duplicate keys: last wins, like JSON.parse.
        assert_eq!(JsonBody::parse(b"{\"a\":1,\"a\":2}"), Some(json!({"a": 2})));
    }

    #[tokio::test]
    async fn strict_throws_bare_500_on_empty_and_malformed() {
        for bad in [&b""[..], b"{", b"nope"] {
            let rej = JsonBody::strict(bad).unwrap_err();
            assert_eq!(rej, Rejection::Thrown);
            let (status, body, ct) = body_of(rej.into_response()).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(body, "", "Next sends an empty 500");
            assert_eq!(ct, None);
        }
        assert_eq!(JsonBody::strict(b"null").unwrap(), Value::Null);
        assert_eq!(JsonBody::strict(b"[]").unwrap(), json!([]));
        assert_eq!(JsonBody::strict(b"{\"a\":1}").unwrap(), json!({"a": 1}));
    }

    #[test]
    fn lenient_falls_back_only_on_parse_failure() {
        assert_eq!(JsonBody::lenient(b"", json!({})), json!({}));
        assert_eq!(JsonBody::lenient(b"{", Value::Null), Value::Null);
        // A valid `null` stays `null` (then `body.x` throws in TS).
        assert_eq!(JsonBody::lenient(b"null", json!({})), Value::Null);
        assert_eq!(JsonBody::lenient(b"[1,2]", json!({})), json!([1, 2]));
    }

    #[test]
    fn lenient_overflow_reads_infinite_literals_as_the_stand_in() {
        let inf = json!("∞");
        let read =
            |body: &str| JsonBody::lenient_overflow(body.as_bytes(), json!({"fallback": 1}), &inf);
        // Bodies serde_json reads are untouched.
        assert_eq!(
            read(r#"{"a":1e308,"b":"1e400"}"#),
            json!({"a": 1e308, "b": "1e400"})
        );
        assert_eq!(read("null"), Value::Null);
        // Overflowing literals, anywhere outside a string.
        assert_eq!(read("1e400"), json!("∞"));
        assert_eq!(read("-1E+999"), json!("∞"));
        assert_eq!(
            read(r#"{"m":1e400,"n":[-2e308, 1.5e309],"s":"x\"1e400","t":5}"#),
            json!({"m": "∞", "n": ["∞", "∞"], "s": "x\"1e400", "t": 5})
        );
        assert_eq!(read("\u{feff}[1e999]"), json!(["∞"]), "BOM stripped");
        assert_eq!(
            read(r#"{"k\\":1e400}"#),
            json!({"k\\": "∞"}),
            "escaped backslash ends no string"
        );
        // Still malformed: the fallback, as JSON.parse would throw.
        for bad in [
            "",
            "{",
            "01e400",
            "1e400-1",
            "[1e400,]",
            "1e400 x",
            "{\"a\":1e400",
            "-",
            "1.e400",
        ] {
            assert_eq!(read(bad), json!({"fallback": 1}), "{bad:?}");
        }
    }

    #[test]
    fn parse_or_message_overflow_keeps_messages_and_marks_infinity() {
        let read = |b: &str| JsonBody::parse_or_message_overflow(b.as_bytes(), &json!(false));
        assert_eq!(
            read(r#"{"w":1e400,"s":"1e400"}"#),
            Ok(json!({"w": false, "s": "1e400"}))
        );
        assert_eq!(read(r#"["\ud800",-1e999]"#), Ok(json!(["\u{fffd}", false])));
        assert_eq!(read("[1e308]"), Ok(json!([1e308])));
        assert_eq!(read("\u{feff}\u{feff}7"), Ok(json!(7)));
        assert_eq!(read(""), Err("Unexpected end of JSON input".to_owned()));
        assert_eq!(
            read("[1e400,]"),
            Err("Unexpected token ']', \"[1e400,]\" is not valid JSON".to_owned())
        );
    }

    #[test]
    fn parse_js_overflow_keeps_lone_surrogates() {
        let read = |b: &str| JsonBody::parse_js_overflow(b.as_bytes(), &json!(false));
        let lone = js_string::lone(0xD800).to_string();
        assert_eq!(
            read(r#"{"w":1e400,"s":"1e400","l":"\ud800"}"#),
            Ok(json!({"w": false, "s": "1e400", "l": lone}))
        );
        assert_eq!(
            read(r#"["\ud800x",-1e999]"#),
            Ok(json!([format!("{lone}x"), false]))
        );
        assert_eq!(read(r#"["\ud83d\ude00"]"#), Ok(json!(["\u{1F600}"])));
        assert_eq!(read("\u{feff}\u{feff}7"), Ok(json!(7)));
        assert_eq!(read(""), Err("Unexpected end of JSON input".to_owned()));
        // V8's message quotes the text as sent, not as the stand-in rewrote it.
        assert_eq!(
            read("[1e400,]"),
            Err("Unexpected token ']', \"[1e400,]\" is not valid JSON".to_owned())
        );
    }

    #[test]
    fn json_number_grammar() {
        for ok in [
            "0", "-0", "7", "-12", "0.5", "1.25e-3", "1E+5", "9e999", "-0.0e0",
        ] {
            assert!(is_json_number(ok), "{ok}");
        }
        for bad in [
            "", "-", "01", "-01", "1.", ".5", "1e", "1e+", "+1", "1.2.3", "1e5e5", "--1", "1-",
            "0x1",
        ] {
            assert!(!is_json_number(bad), "{bad}");
        }
        assert_eq!(replace_overflowing_numbers("[1, 2e3]", "x"), None);
        assert_eq!(
            replace_overflowing_numbers("[1e400]", "x").as_deref(),
            Some("[x]")
        );
    }

    #[tokio::test]
    async fn or_bad_request_is_a_json_400() {
        let rej = JsonBody::or_bad_request(b"{", "invalid json").unwrap_err();
        assert_eq!(rej, Rejection::BadRequest("invalid json"));
        let (status, body, ct) = body_of(rej.into_response()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"error": "invalid json"})
        );
        assert_eq!(ct.as_deref(), Some("application/json"));
        assert_eq!(JsonBody::or_bad_request(b"7", "x").unwrap(), json!(7));
    }

    #[test]
    fn text_follows_body_text() {
        assert_eq!(JsonBody::text(b""), "");
        // Up to two leading BOMs go (undici strips one, its TextDecoder another).
        assert_eq!(JsonBody::text(b"\xEF\xBB\xBF{}"), "{}");
        assert_eq!(JsonBody::text(b"\xEF\xBB\xBF\xEF\xBB\xBF{}"), "{}");
        assert_eq!(
            JsonBody::text(b"\xEF\xBB\xBF\xEF\xBB\xBF\xEF\xBB\xBF{}"),
            "\u{feff}{}"
        );
        assert_eq!(JsonBody::text(b" \xEF\xBB\xBF{}"), " \u{feff}{}");
        // A truncated sequence is one U+FFFD; bytes that never start one, one each.
        assert_eq!(JsonBody::text(b"\xF0\x9F\x98x"), "\u{fffd}x");
        assert_eq!(JsonBody::text(b"\xC0\x80"), "\u{fffd}\u{fffd}");
        assert!(matches!(JsonBody::text(b"ok"), Cow::Borrowed("ok")));
    }

    #[test]
    fn parse_or_message_gives_v8_messages() {
        let msg = |b: &[u8]| JsonBody::parse_or_message(b).unwrap_err();
        assert_eq!(msg(b""), "Unexpected end of JSON input");
        assert_eq!(msg(b"\xEF\xBB\xBF"), "Unexpected end of JSON input");
        assert_eq!(msg(b" \r\n"), "Unexpected end of JSON input");
        assert_eq!(
            msg(b"{"),
            "Expected property name or '}' in JSON at position 1 (line 1 column 2)"
        );
        assert_eq!(
            msg(b"nope"),
            "Unexpected token 'o', \"nope\" is not valid JSON"
        );
        assert_eq!(
            msg(b"\xEF\xBB\xBF\xEF\xBB\xBF\xEF\xBB\xBF{}"),
            "Unexpected token '\u{feff}', \"\u{feff}{}\" is not valid JSON"
        );
        // Invalid UTF-8 is U+FFFD before the parse, and counts in positions.
        assert_eq!(
            msg(b"\"\xC0\x80\" 1"),
            "Unexpected non-whitespace character after JSON at position 5 (line 1 column 6)"
        );
        assert_eq!(
            msg(b"[\xFF\xFE]"),
            "Unexpected token '\u{fffd}', \"[\u{fffd}\u{fffd}]\" is not valid JSON"
        );
        // A 4-byte character is two UTF-16 units.
        assert_eq!(
            msg("[\"\u{1f600}\", 1 2]".as_bytes()),
            "Expected ',' or ']' after array element in JSON at position 9 (line 1 column 10)"
        );
        assert_eq!(JsonBody::parse_or_message(b"null"), Ok(Value::Null));
        assert_eq!(
            JsonBody::parse_or_message(b"\xEF\xBB\xBF\xEF\xBB\xBF{\"a\":\"x\xFFy\"}"),
            Ok(json!({"a": "x\u{FFFD}y"}))
        );
        // V8 parses a lone-surrogate escape, which the strict helpers reject.
        assert_eq!(
            JsonBody::parse_or_message(br#"{"id":"\ud800"}"#),
            Ok(json!({"id": "\u{fffd}"}))
        );
        assert_eq!(JsonBody::parse(br#"{"id":"\ud800"}"#), None);
    }

    #[test]
    fn parse_or_message_matches_body_json() {
        // `new Response(bytes).json()` in node 22, recorded by
        // rust/scripts/json-parse-golden.mjs.
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../claudius-agent/tests/fixtures/json_parse_golden.json");
        let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let bodies = fx["bodies"].as_array().unwrap();
        assert!(bodies.len() >= 40, "only {} bodies", bodies.len());
        for b in bodies {
            let hex = b["bytes"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            let got = JsonBody::parse_or_message(&bytes);
            match (b["message"].as_str(), got) {
                (Some(want), Err(m)) => assert_eq!(m, want, "{hex}"),
                (None, Ok(v)) => assert_eq!(
                    claudius_agent::js::stringify(&v),
                    b["value"].as_str().unwrap(),
                    "{hex}"
                ),
                (want, got) => panic!("{hex}: node {want:?}, rust {got:?}"),
            }
        }
    }

    #[test]
    fn js_truthy_matches_js() {
        for falsy in [
            None,
            Some(json!(null)),
            Some(json!(false)),
            Some(json!(0)),
            Some(json!(-0.0)),
            Some(json!("")),
        ] {
            assert!(!js_truthy(falsy.as_ref()), "{falsy:?}");
        }
        for truthy in [
            json!(true),
            json!(1),
            json!(-1.5),
            json!("0"),
            json!("false"),
            json!([]),
            json!({}),
        ] {
            assert!(js_truthy(Some(&truthy)), "{truthy}");
        }
    }

    #[tokio::test]
    async fn js_member_matches_property_access() {
        let obj = json!({"a": 1, "n": null});
        assert_eq!(js_member(&obj, "a").unwrap(), Some(&json!(1)));
        assert_eq!(
            js_member(&obj, "n").unwrap(),
            Some(&Value::Null),
            "present null ≠ undefined"
        );
        assert_eq!(js_member(&obj, "missing").unwrap(), None);
        for non_object in [json!([1]), json!("s"), json!(3), json!(true)] {
            assert_eq!(
                js_member(&non_object, "a").unwrap(),
                None,
                "{non_object}.a is undefined"
            );
        }
        let rej = js_member(&Value::Null, "a").unwrap_err();
        assert_eq!(rej, Rejection::Thrown);
        let (status, body, _) = body_of(rej.into_response()).await;
        assert_eq!(
            (status, body.as_str()),
            (StatusCode::INTERNAL_SERVER_ERROR, "")
        );
    }
}
