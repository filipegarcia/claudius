//! `claudius_core::models` against `tests/fixtures/models_golden.json`,
//! recorded by `rust/scripts/models-golden.mjs` from the real TS:
//! `applyModelPickerCuration` over 6 model lists × 63 pickers (the result as
//! `JSON.stringify` text, or V8's `TypeError` message), and the route
//! modules' constants (`PROBE_CANDIDATES`). The routes themselves replay on
//! the real binary in `claudius-server/tests/models.rs`.

use std::path::PathBuf;

use claudius_agent::js;
use claudius_core::models::{PROBE_CANDIDATES, apply_model_picker_curation, static_fallback};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/models_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn curation_matches_the_ts() {
    let f = fixture();
    let cases = f["curation"].as_array().unwrap();
    assert!(cases.len() > 300, "{} cases", cases.len());
    let (mut ok, mut threw) = (0, 0);
    for (i, c) in cases.iter().enumerate() {
        let models = c["models"].as_array().unwrap().clone();
        let got = apply_model_picker_curation(models, c.get("picker"));
        let what = format!(
            "case {i}: models {} picker {:?}",
            c["models"],
            c.get("picker")
        );
        match (&c["got"]["ok"], &c["got"]["threw"]) {
            (Value::String(want), Value::Null) => {
                let got = got.unwrap_or_else(|e| panic!("{what}: threw {e}, want {want}"));
                assert_eq!(js::stringify(&Value::Array(got)), *want, "{what}");
                ok += 1;
            }
            (Value::Null, Value::String(want)) => {
                assert_eq!(c["got"]["type"], "TypeError", "{what}");
                assert_eq!(got.err().as_deref(), Some(want.as_str()), "{what}");
                threw += 1;
            }
            other => panic!("{what}: bad fixture entry {other:?}"),
        }
    }
    // Both outcomes are exercised.
    assert!(ok > 100 && threw > 50, "{ok} results, {threw} throws");
}

#[test]
fn constants_match_the_ts() {
    let f = fixture();
    let want: Vec<Value> = f["candidates"].as_array().unwrap().clone();
    let got: Vec<Value> = PROBE_CANDIDATES
        .iter()
        .map(|c| json!({"value": c.value, "displayName": c.display_name, "description": c.description}))
        .collect();
    assert_eq!(
        js::stringify(&Value::Array(got)),
        js::stringify(&Value::Array(want))
    );
    // `STATIC_FALLBACK` as the route served it with no settings file.
    let plain = f["fallback"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "no settings.json")
        .unwrap();
    let body: Value = serde_json::from_str(plain["got"]["body"].as_str().unwrap()).unwrap();
    assert_eq!(body["source"], "fallback");
    assert_eq!(
        js::stringify(&body["models"]),
        js::stringify(&Value::Array(static_fallback()))
    );
}
