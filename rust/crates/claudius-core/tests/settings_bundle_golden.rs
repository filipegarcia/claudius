//! The pure halves of the backup modules (D11), replayed against the TS
//! recording (`../../claudius-server/tests/fixtures/settings_bundle_golden.json`,
//! written by `rust/scripts/settings-bundle-golden.mjs`):
//!
//! * `customize_settings::DEFAULT_AUTO_FIX_PROMPT` is the TS template byte
//!   for byte;
//! * `settings_export::suggested_filename` over odd epoch values (outside
//!   the JS Date range, non-integers, year 0 and the ±8.64e15 edges);
//! * `settings_import::merge_deep`, compared as `JSON.stringify` prints it;
//! * `settings_import::validate_bundle` over bundles that pass and fail
//!   each of its checks.

use claudius_core::{customize_settings, settings_export, settings_import};
use serde_json::Value;

fn fixture() -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-server/tests/fixtures/settings_bundle_golden.json");
    claudius_core::js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn the_default_auto_fix_prompt_is_the_ts_template() {
    let fx = fixture();
    assert_eq!(
        customize_settings::DEFAULT_AUTO_FIX_PROMPT,
        fx["prompt"].as_str().unwrap()
    );
}

#[test]
fn suggested_filename_matches_the_ts() {
    let fx = fixture();
    let cases = fx["filenames"].as_array().unwrap();
    assert!(cases.len() >= 20, "only {} cases", cases.len());
    for case in cases {
        let text = case[0].as_str().unwrap();
        let at = match text {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            t => t.parse().unwrap(),
        };
        assert_eq!(
            settings_export::suggested_filename(at),
            case[1].as_str().unwrap(),
            "suggestedFilename({text})"
        );
    }
}

#[test]
fn merge_deep_matches_the_ts() {
    let fx = fixture();
    let cases = fx["merge"].as_array().unwrap();
    assert!(cases.len() >= 30, "only {} cases", cases.len());
    for case in cases {
        let (t, s) = (
            case["target"].as_str().unwrap(),
            case["source"].as_str().unwrap(),
        );
        assert!(
            case.get("threw").is_none(),
            "{t} + {s} threw in the recorder"
        );
        let target = claudius_agent::js::json_parse(t).unwrap();
        let source = claudius_agent::js::json_parse(s).unwrap();
        let got = settings_import::merge_deep(Some(&target), Some(&source));
        let want = case["got"].as_str().unwrap();
        assert_eq!(
            got.as_ref()
                .map_or("undefined".into(), claudius_agent::js::stringify),
            want,
            "mergeDeep({t}, {s})"
        );
    }
}

#[test]
fn validate_bundle_matches_the_ts() {
    let fx = fixture();
    let cases = fx["validate"].as_array().unwrap();
    assert!(cases.len() >= 25, "only {} cases", cases.len());
    for case in cases {
        let text = case[0].as_str().unwrap();
        let input = claudius_agent::js::json_parse(text).unwrap();
        assert_eq!(
            settings_import::validate_bundle(&input),
            case[1].as_bool().unwrap(),
            "validateBundle({text})"
        );
    }
}
