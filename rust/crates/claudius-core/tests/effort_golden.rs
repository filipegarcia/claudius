//! Replays `fixtures/effort_golden.json`, recorded from the TS sources by
//! `rust/scripts/effort-golden.mjs`: `buildEffortFlagSettings`,
//! `parseAppliedEffort` and the effort route's `LEVELS`.

use std::path::PathBuf;

use claudius_core::effort;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/effort_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `{"undefined": true}` → `None`, `{"value": v}` → `Some(v)`.
fn dec(v: &Value) -> Option<Value> {
    if v["undefined"] == true {
        None
    } else {
        Some(v["value"].clone())
    }
}

#[test]
fn route_levels_match() {
    assert_eq!(fixture()["routeLevels"], json!(effort::EFFORT_LEVELS));
}

#[test]
fn flag_payloads_match() {
    let fx = fixture();
    let cases = fx["build"].as_array().unwrap();
    assert_eq!(cases.len(), effort::EFFORT_LEVELS.len() * 2);
    for c in cases {
        let got = effort::build_effort_flag_settings(
            c["level"].as_str().unwrap(),
            c["ultracode"].as_bool().unwrap(),
        );
        // Key order too: the payload goes over the wire as written.
        assert_eq!(got.to_string(), c["out"].to_string(), "{c}");
    }
}

#[test]
fn applied_effort_matches() {
    let fx = fixture();
    let cases = fx["parse"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for c in cases {
        // A Rust response is always a value: an absent one reads as `null`.
        let response = dec(&c["response"]).unwrap_or(Value::Null);
        assert_eq!(
            effort::parse_applied_effort(&response),
            dec(&c["out"]),
            "{response}"
        );
    }
}
