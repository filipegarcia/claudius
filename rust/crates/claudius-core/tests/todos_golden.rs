//! Replays `fixtures/todos_golden.json`, recorded from the TS sources by
//! `rust/scripts/todos-golden.mjs`: `parseTaskListResult`, the TaskCreate
//! result id parse, the reminder bodies, `openTodoCount` and the thresholds
//! (including the turn-end staleness ones).

use std::path::PathBuf;

use claudius_core::todos;
use serde_json::Value;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/todos_golden.json");
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
fn thresholds_match() {
    let fx = fixture();
    assert_eq!(
        fx["staleTodoTurnThreshold"],
        todos::STALE_TODO_TURN_THRESHOLD
    );
    assert_eq!(
        fx["midTurnToolUseThreshold"],
        todos::TODOS_MIDTURN_TOOLUSE_THRESHOLD
    );
    assert_eq!(fx["staleFlagTurns"], todos::TODOS_STALE_FLAG_TURNS);
    assert_eq!(fx["staleClearTurns"], todos::TODOS_STALE_CLEAR_TURNS);
}

#[test]
fn task_list_parse_matches() {
    let fx = fixture();
    let cases = fx["parse"].as_array().unwrap();
    assert!(cases.len() >= 35);
    for c in cases {
        // `null` and `undefined` both read as no text.
        let text = dec(&c["text"]).unwrap_or(Value::Null);
        let got = todos::parse_task_list_result(text.as_str()).map(Value::Array);
        assert_eq!(got.unwrap_or(Value::Null), c["out"]["value"], "{text:?}");
    }
}

#[test]
fn created_ids_match() {
    let fx = fixture();
    let cases = fx["realIds"].as_array().unwrap();
    assert!(cases.len() >= 30);
    for c in cases {
        let text = c["text"].as_str().unwrap();
        assert_eq!(
            todos::task_create_real_id(text).map(Value::from),
            c["out"].as_str().map(Value::from),
            "{text:?}"
        );
    }
}

#[test]
fn reminder_bodies_match() {
    let fx = fixture();
    let cases = fx["bodies"].as_array().unwrap();
    assert!(cases.len() >= 9);
    for c in cases {
        let list = c["todos"].as_array().unwrap();
        assert_eq!(
            todos::todos_current_reminder_body(list),
            c["current"],
            "{list:?}"
        );
        assert_eq!(
            todos::todos_mid_turn_reminder_body(list),
            c["midTurn"],
            "{list:?}"
        );
        assert_eq!(
            todos::stale_todo_reminder_body(list),
            c["stale"],
            "{list:?}"
        );
    }
}

#[test]
fn open_counts_match() {
    let fx = fixture();
    for c in fx["openCounts"].as_array().unwrap() {
        let snapshot = c["snapshot"].as_array().map(Vec::as_slice);
        assert_eq!(
            todos::open_todo_count(snapshot),
            c["out"].as_u64().unwrap() as usize,
            "{c}"
        );
    }
}
