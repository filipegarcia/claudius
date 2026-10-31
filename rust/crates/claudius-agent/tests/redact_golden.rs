//! Replays `fixtures/redact_golden.json` (recorded by
//! `rust/scripts/redact-golden.mjs` from the SDK's own `up()`): the pattern
//! list must be the one [`SDK_PATTERNS`] mirrors, and [`redact`] must give
//! `up()`'s output for every recorded input.

use std::path::PathBuf;
use std::time::Instant;

use claudius_agent::redact::{SDK_PATTERNS, redact};
use serde_json::Value;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/redact_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn patterns_match_the_sdk() {
    let fx = fixture();
    let sdk: Vec<[String; 3]> = fx["patterns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| ["source", "flags", "replacement"].map(|k| p[k].as_str().unwrap().to_owned()))
        .collect();
    let ours: Vec<[String; 3]> = SDK_PATTERNS.iter().map(|p| p.map(str::to_owned)).collect();
    assert_eq!(
        sdk, ours,
        "the SDK's redaction patterns changed: copy them into SDK_PATTERNS"
    );
}

#[test]
fn redaction_matches_up() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    assert!(cases.len() > 1000, "only {} cases", cases.len());
    let mut failures = Vec::new();
    for c in cases {
        let input = c["input"].as_str().unwrap();
        let want = c["output"].as_str().unwrap();
        let started = Instant::now();
        let got = redact(input);
        let took = started.elapsed();
        if got != want {
            failures.push(format!(
                "input: {input:?}\n  sdk:  {want:?}\n  rust: {got:?}"
            ));
        }
        assert!(
            took.as_secs() < 2,
            "redaction took {took:?} on {} chars",
            input.len()
        );
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
