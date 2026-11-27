//! Replays `fixtures/tool_cards_golden.json`, recorded from the real TS by
//! `rust/scripts/tool-cards-golden.mjs`, through the tool cards' helpers
//! (`claudius_chat::tool_text`, `cards::schedule_action_label`).

use claudius_chat::cards::schedule_action_label;
use claudius_chat::tool_text::{self as tt, PreviewType, SettledToolReason};
use claudius_client::{JsRecord, ToolProgressInfo};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("fixtures/tool_cards_golden.json");

fn s(v: &Value) -> &str {
    v.as_str().expect("a string arg")
}

fn opt_s(v: &Value) -> Option<&str> {
    v.as_str()
}

fn n(v: &Value) -> f64 {
    v.as_f64().expect("a number arg")
}

fn reason(v: &Value) -> SettledToolReason {
    match s(v) {
        "stopped" => SettledToolReason::Stopped,
        "failed" => SettledToolReason::Failed,
        other => panic!("no reason {other}"),
    }
}

fn opt_str(o: Option<String>) -> Value {
    o.map_or(Value::Null, Value::String)
}

fn tokens(t: Vec<(String, tt::JsonTokenType)>) -> Value {
    t.into_iter()
        .map(|(text, kind)| json!({"text": text, "type": kind.as_str()}))
        .collect()
}

/// The helper `name` on `args`, as the recorder wrote its result.
fn call(name: &str, args: &[Value]) -> Value {
    let a = |i: usize| &args[i];
    match name {
        "formatElapsed" => json!(tt::format_elapsed(n(a(0)))),
        "formatDuration" | "fmtDuration" => json!(tt::format_duration(n(a(0)))),
        "settledToolReason" => {
            tt::settled_tool_reason(opt_s(a(0))).map_or(Value::Null, |r| json!(r.as_str()))
        }
        "settledToolLabel" => json!(reason(a(0)).label()),
        "settledToolTitle" => json!(reason(a(0)).title()),
        "extractFeedbackDraftText" => opt_str(tt::extract_feedback_draft_text(a(0))),
        "splitPathForTruncation" => {
            let (head, tail) = tt::split_path_for_truncation(s(a(0)));
            json!({"head": head, "tail": tail})
        }
        "getPreviewType" => match tt::get_preview_type(s(a(0))) {
            Some(PreviewType::Image) => json!("image"),
            Some(PreviewType::Html) => json!("html"),
            None => Value::Null,
        },
        "pathFromToolInput" => match tt::path_from_tool_input(a(0)) {
            None => Value::Null,
            Some(t) => match t.line {
                // JSON's `7`, not serde's `7.0`, for a whole line.
                Some(l) if l.fract() == 0.0 => json!({"path": t.path, "line": l as i64}),
                Some(l) => json!({"path": t.path, "line": l}),
                None => json!({"path": t.path}),
            },
        },
        "normalizeLocalPath" => json!(tt::normalize_local_path(s(a(0)))),
        "toWorkspaceRelative" => opt_str(tt::to_workspace_relative(s(a(0)), s(a(1)))),
        "filesHref" => json!(tt::files_href(s(a(0)), s(a(1)))),
        "buildEditorUrl" => json!(tt::build_editor_url(s(a(0)), a(1).as_f64(), s(a(2)))),
        "parseSubagentHandBack" => {
            let h = tt::parse_subagent_hand_back(s(a(0)));
            json!({"text": h.text, "provenance": h.provenance})
        }
        "tokenizeJsonValue" => tokens(tt::tokenize_json_value(a(0))),
        "tokenizeJsonPretty" => tokens(tt::tokenize_json_pretty(s(a(0)))),
        "canonicalModelId" => opt_str(tt::canonical_model_id(opt_s(a(0)))),
        "prettyModelName" => json!(tt::pretty_model_name(opt_s(a(0)))),
        "findSubagentRetry" => {
            let mut progress: JsRecord<ToolProgressInfo> = JsRecord::new();
            for pair in a(2).as_array().expect("pairs") {
                let info = serde_json::from_value(pair[1].clone()).expect("a ToolProgressInfo");
                progress.insert(s(&pair[0]).to_owned(), info);
            }
            tt::find_subagent_retry(s(a(0)), s(a(1)), &progress)
                .map_or(Value::Null, |r| serde_json::to_value(r).expect("json"))
        }
        "effectiveWorkflowSize" => json!(tt::effective_workflow_size(Some(a(0)))),
        "str" => opt_str(tt::str_value(Some(a(0)))),
        "safeJsonObject" => tt::safe_json_object(opt_s(a(0))).unwrap_or(Value::Null),
        "scheduleAction" => json!(schedule_action_label(s(a(0)))),
        other => panic!("no replay for {other}: add one"),
    }
}

#[test]
fn every_recorded_helper_call_matches_the_ts() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let sections = fixture["sections"].as_object().expect("sections");
    let mut failures = Vec::new();
    let mut total = 0;
    for (name, cases) in sections {
        for case in cases.as_array().expect("cases") {
            total += 1;
            let args = case["args"].as_array().expect("args");
            let got = call(name, args);
            if got != case["out"] {
                failures.push(format!(
                    "{name}({}):\n  ts:   {}\n  rust: {got}",
                    serde_json::to_string(args).unwrap_or_default(),
                    case["out"]
                ));
            }
        }
    }
    assert!(total >= 500, "only {total} cases");
    assert!(
        failures.is_empty(),
        "{} of {total} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn the_fixture_covers_every_section_the_replay_knows() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let sections = fixture["sections"].as_object().expect("sections");
    for name in [
        "formatElapsed",
        "formatDuration",
        "fmtDuration",
        "settledToolReason",
        "settledToolLabel",
        "settledToolTitle",
        "extractFeedbackDraftText",
        "splitPathForTruncation",
        "getPreviewType",
        "pathFromToolInput",
        "normalizeLocalPath",
        "toWorkspaceRelative",
        "filesHref",
        "buildEditorUrl",
        "parseSubagentHandBack",
        "tokenizeJsonValue",
        "tokenizeJsonPretty",
        "canonicalModelId",
        "prettyModelName",
        "findSubagentRetry",
        "effectiveWorkflowSize",
        "str",
        "safeJsonObject",
        "scheduleAction",
    ] {
        assert!(
            sections
                .get(name)
                .and_then(Value::as_array)
                .is_some_and(|c| !c.is_empty()),
            "{name} has cases"
        );
    }
}
