//! Replays `fixtures/json_parse_golden.json` (recorded by
//! `rust/scripts/json-parse-golden.mjs` from node 22's own `JSON.parse`):
//! [`json_parse_error`] must give V8's `SyntaxError` message for every
//! recorded input, byte for byte, and `None` for the ones V8 parses;
//! [`json_parse_error_utf16`] must give the exact code units, lone surrogates
//! included; and [`json_parse`] must give the value JS has (as
//! `JSON.stringify` prints it) or the same message.

use std::collections::BTreeSet;
use std::path::PathBuf;

use claudius_agent::js::{json_parse, json_parse_error, json_parse_error_utf16, stringify};
use serde_json::Value;

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/json_parse_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn units_of(v: &Value) -> Vec<u16> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|u| u16::try_from(u.as_u64().unwrap()).unwrap())
        .collect()
}

/// The exact message units a case recorded: `messageUnits` when the message
/// had lone surrogates, else the message itself.
fn exact_units(c: &Value) -> Option<Vec<u16>> {
    match (&c["messageUnits"], &c["message"]) {
        (Value::Array(_), _) => Some(units_of(&c["messageUnits"])),
        (_, Value::String(m)) => Some(m.encode_utf16().collect()),
        _ => None,
    }
}

fn report(failures: &[String], total: usize) {
    assert!(
        failures.is_empty(),
        "{} of {total} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn recorded_on_node_22() {
    // The wording and the window are V8's, and they change between majors.
    let fx = fixture();
    let node = fx["node"].as_str().unwrap();
    assert!(node.starts_with("v22."), "recorded on {node}");
}

#[test]
fn fixture_covers_every_template() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    let messages: Vec<&str> = cases.iter().filter_map(|c| c["message"].as_str()).collect();
    assert!(messages.len() >= 2000, "only {} malformed", messages.len());
    let valid = cases.iter().filter(|c| c["message"].is_null()).count();
    assert!(valid >= 150, "only {valid} valid");
    for reason in [
        "Unexpected end of JSON input",
        "Unexpected number in JSON at position ",
        "Unexpected string in JSON at position ",
        "Expected property name or '}' in JSON at position ",
        "Expected ',' or ']' after array element in JSON at position ",
        "Expected ',' or '}' after property value in JSON at position ",
        "Expected ':' after property name in JSON at position ",
        "Expected double-quoted property name in JSON at position ",
        "Bad escaped character in JSON at position ",
        "Bad Unicode escape in JSON at position ",
        "Bad control character in string literal in JSON at position ",
        "Unterminated string in JSON at position ",
        "Exponent part is missing a number in JSON at position ",
        "Unterminated fractional number in JSON at position ",
        "No number after minus sign in JSON at position ",
        "Unexpected non-whitespace character after JSON at position ",
        "\"undefined\" is not valid JSON",
    ] {
        assert!(
            messages.iter().any(|m| m.starts_with(reason)),
            "no case for {reason:?}"
        );
    }
    // The four token forms.
    let forms: BTreeSet<(bool, bool)> = messages
        .iter()
        .filter(|m| m.starts_with("Unexpected token '"))
        .map(|m| {
            (
                m.contains(", ...\""),
                m.ends_with("\"... is not valid JSON"),
            )
        })
        .collect();
    assert_eq!(forms.len(), 4, "{forms:?}");
    assert!(messages.iter().any(|m| m.contains("(line 3 column 1)")));
}

#[test]
fn messages_match_v8() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for c in cases {
        let input = c["input"].as_str().unwrap();
        let want = c["message"].as_str();
        let got = json_parse_error(input);
        if got.as_deref() != want {
            failures.push(format!(
                "[{}] input: {input:?}\n  v8:   {want:?}\n  rust: {got:?}",
                c["group"].as_str().unwrap()
            ));
            continue;
        }
        let units: Vec<u16> = input.encode_utf16().collect();
        let exact = json_parse_error_utf16(&units);
        if exact != exact_units(c) {
            failures.push(format!(
                "[{}] input: {input:?}\n  v8 units:   {:?}\n  rust units: {exact:?}",
                c["group"].as_str().unwrap(),
                exact_units(c)
            ));
        }
    }
    report(&failures, cases.len());
}

#[test]
fn lone_surrogates_are_dropped_from_the_string_message() {
    let fx = fixture();
    let mut lone = 0;
    for c in fx["cases"].as_array().unwrap() {
        let Some(n) = c["lone"].as_u64() else {
            continue;
        };
        lone += 1;
        let exact = units_of(&c["messageUnits"]);
        let message = c["message"].as_str().unwrap();
        // The dropped units are exactly the lone ones.
        assert_eq!(
            exact.len() - message.encode_utf16().count(),
            usize::try_from(n).unwrap(),
            "{message:?}"
        );
    }
    assert!(lone >= 20, "only {lone} messages with a lone surrogate");
}

#[test]
fn lone_surrogate_inputs_match_v8() {
    // Raw lone surrogates no `&str` can hold: the UTF-16 entry point only.
    let fx = fixture();
    let cases = fx["jsOnly"].as_array().unwrap();
    assert!(cases.len() >= 15, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for c in cases {
        let input = units_of(&c["input"]);
        let want = exact_units(c);
        let got = json_parse_error_utf16(&input);
        if got != want {
            failures.push(format!(
                "input: {input:?}\n  v8:   {want:?}\n  rust: {got:?}"
            ));
        }
    }
    report(&failures, cases.len());
}

#[test]
fn values_match_js() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for c in cases {
        let input = c["input"].as_str().unwrap();
        let got = json_parse(input);
        match (&c["message"], &c["value"], got) {
            (Value::String(m), _, Err(e)) if *m == e => {}
            (Value::Null, Value::String(v), Ok(value)) if stringify(&value) == *v => {}
            // Nesting serde_json can't hold: V8 parses it, Rust says so.
            (Value::Null, Value::Null, Err(e)) if c["depth"].as_u64() >= Some(128) => {
                assert!(e.starts_with("recursion limit exceeded"), "{e}");
            }
            (_, _, got) => failures.push(format!(
                "[{}] input: {input:?}\n  js:   {} {}\n  rust: {got:?}",
                c["group"].as_str().unwrap(),
                c["message"],
                c["value"]
            )),
        }
    }
    report(&failures, cases.len());
}

#[test]
fn lone_surrogate_escapes_parse() {
    // serde_json rejects these; V8 doesn't, so neither does the port.
    for text in [
        r#""\ud800""#,
        r#""\udc00""#,
        r#"["\udbff\ud800"]"#,
        r#"{"\ud83d":1}"#,
    ] {
        assert_eq!(json_parse_error(text), None, "{text}");
        assert!(serde_json::from_str::<Value>(text).is_err(), "{text}");
    }
    assert_eq!(json_parse(r#""a\ud800b""#).unwrap(), "a\u{fffd}b");
    assert_eq!(
        json_parse(r#"["\ud83d\ude00", "\\ud800", "\udc00\ud800"]"#).unwrap(),
        serde_json::json!(["\u{1f600}", "\\ud800", "\u{fffd}\u{fffd}"])
    );
    assert_eq!(
        json_parse(r#"{"x":1e400,"y":[-1e999, 1e308],"z":"1e400"}"#).unwrap(),
        serde_json::json!({"x": null, "y": [null, 1e308], "z": "1e400"})
    );
    // node: JSON.stringify(JSON.parse(text)) with strings made well-formed.
    let text = r#"["\udbff\udfff", "\ud800", [1E+400, 1.5e400, -2e-400, 1e+2]]"#;
    assert_eq!(
        stringify(&json_parse(text).unwrap()),
        "[\"\u{10ffff}\",\"\u{fffd}\",[null,null,0,100]]"
    );
    // A pair needs its second half to be a `\u` escape of a low surrogate.
    let text = r#"["\ud800zzdc00", "\ud800\udc00", "\udfff", "\udc00\udc00"]"#;
    assert_eq!(
        stringify(&json_parse(text).unwrap()),
        "[\"\u{fffd}zzdc00\",\"\u{10000}\",\"\u{fffd}\",\"\u{fffd}\u{fffd}\"]"
    );
}

#[test]
fn deep_and_long_inputs() {
    // V8's parser is iterative: no depth limit, and no recursion here.
    let n = 1_000_000;
    assert_eq!(
        json_parse_error(&"[".repeat(n)).as_deref(),
        Some("Unexpected end of JSON input")
    );
    let deep = "[".repeat(n) + &"]".repeat(n);
    assert_eq!(json_parse_error(&deep), None);
    let deep_x = "[".repeat(n) + "x";
    assert_eq!(
        json_parse_error(&deep_x).unwrap(),
        format!(
            "Unexpected token 'x', ...\"{}x\" is not valid JSON",
            "[".repeat(10)
        )
    );
    // A long line: the position is its UTF-16 offset.
    let long = format!("[\"{}\", 1 2]", "\u{e9}".repeat(100_000));
    assert_eq!(
        json_parse_error(&long).unwrap(),
        "Expected ',' or ']' after array element in JSON at position 100007 (line 1 column 100008)"
    );
}
