//! Usage extras parity (S16): `extract_usage_behaviors`,
//! `extract_weekly_used_skills` and the `/context` merge replayed against
//! what `lib/shared/usage-behaviors.ts`, `lib/shared/skill-usage.ts` and
//! the route's `{ ...data, weeklyUsedSkills }` produced
//! (`rust/scripts/usage-behaviors-golden.mjs`).
//!
//! Inputs are the recorded JSON texts, parsed by serde_json here; outputs
//! are compared as the `JSON.stringify` text the routes send.

use std::sync::OnceLock;

use claudius_agent::js;
use claudius_core::usage_behaviors::{
    USAGE_BEHAVIOR_KEYS, extract_usage_behaviors, extract_weekly_used_skills,
    with_weekly_used_skills,
};
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/usage_behaviors_golden.json")).unwrap()
    })
}

fn parse(case: &Value) -> Value {
    serde_json::from_str(case["text"].as_str().unwrap()).unwrap()
}

#[test]
fn the_behavior_keys_match() {
    assert_eq!(fixture()["keys"], json!(USAGE_BEHAVIOR_KEYS));
}

#[test]
fn extract_usage_behaviors_matches() {
    let cases = fixture()["usage"].as_array().unwrap();
    assert!(cases.len() >= 100);
    let mut found = 0;
    for c in cases {
        let got = extract_usage_behaviors(&parse(c)).unwrap_or(Value::Null);
        found += usize::from(!got.is_null());
        assert_eq!(js::stringify(&got), c["behaviors"], "{}", c["text"]);
    }
    // Enough cases have a section for the field checks to mean something.
    assert!(found >= 50, "{found}");
}

#[test]
fn extract_weekly_used_skills_matches() {
    let mut named = 0;
    for c in fixture()["usage"].as_array().unwrap() {
        let got = extract_weekly_used_skills(&parse(c));
        named += got.len();
        assert_eq!(js::stringify(&json!(got)), c["skills"], "{}", c["text"]);
    }
    assert!(named >= 20, "{named}");
}

#[test]
fn the_context_merge_matches() {
    let cases = fixture()["context"].as_array().unwrap();
    assert!(cases.len() >= 15);
    for c in cases {
        let data = parse(c);
        assert_eq!(js::stringify(&data), c["summary"], "{}", c["text"]);
        for f in c["full"].as_array().unwrap() {
            let weekly: Option<Vec<String>> =
                serde_json::from_value(f["weeklyUsedSkills"].clone()).unwrap();
            let got = with_weekly_used_skills(&data, weekly.clone());
            assert_eq!(
                js::stringify(&got),
                f["body"],
                "{} with {weekly:?}",
                c["text"]
            );
        }
    }
}
