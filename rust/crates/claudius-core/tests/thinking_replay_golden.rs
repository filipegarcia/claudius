//! Thinking-block replay recovery parity (S19): detection and the rewind
//! plan replayed against what `lib/server/thinking-replay-recovery.ts`
//! returned (`rust/scripts/thinking-replay-golden.mjs`).

use std::sync::OnceLock;

use claudius_agent::js;
use claudius_core::thinking_replay::{
    RecoveryPlan, extract_message_text, is_thinking_replay_error_text,
    plan_thinking_replay_recovery, thinking_replay_error_from,
};
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/thinking_replay_golden.json")).unwrap()
    })
}

fn cases(key: &str, min: usize) -> &'static [Value] {
    let v = fixture()[key].as_array().unwrap();
    assert!(v.len() >= min, "{key}: {}", v.len());
    v
}

#[test]
fn the_error_text_test_matches() {
    let mut matched = 0;
    for c in cases("texts", 15) {
        let want = c["matches"].as_bool().unwrap();
        matched += usize::from(want);
        let text = c["text"].as_str().unwrap();
        assert_eq!(is_thinking_replay_error_text(text), want, "{text:?}");
    }
    assert!(matched >= 5, "{matched}");
}

#[test]
fn message_texts_match() {
    for c in cases("messageTexts", 12) {
        assert_eq!(
            extract_message_text(&c["message"]),
            c["text"].as_str().unwrap(),
            "{}",
            c["message"]
        );
    }
}

#[test]
fn error_records_match() {
    for c in cases("errors", 15) {
        assert_eq!(
            thinking_replay_error_from(&c["record"]).as_deref(),
            c["error"].as_str(),
            "{}",
            c["record"]
        );
    }
}

/// A plan as `JSON.stringify` writes it (an absent prompt uuid omitted).
fn plan_json(plan: Option<RecoveryPlan>) -> String {
    let Some(p) = plan else {
        return "null".into();
    };
    let mut o = Map::new();
    o.insert("resumeAt".into(), json!(p.resume_at));
    o.insert("replayPrompt".into(), json!(p.replay_prompt));
    if let Some(u) = p.replay_prompt_uuid {
        o.insert("replayPromptUuid".into(), u);
    }
    js::stringify(&Value::Object(o))
}

#[test]
fn plans_match() {
    let mut planned = 0;
    for c in cases("plans", 30) {
        let want = c["plan"].as_str().unwrap();
        planned += usize::from(want != "null");
        let got = plan_json(plan_thinking_replay_recovery(
            c["messages"].as_array().unwrap(),
        ));
        assert_eq!(got, want, "{}", c["name"]);
    }
    assert!(planned >= 20, "{planned}");
}
