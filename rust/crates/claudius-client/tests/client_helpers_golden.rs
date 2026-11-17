//! Replays `tests/fixtures/client_helpers_golden.json`, recorded from the
//! real TS helpers of lib/client/use-session.ts (and the filters they call)
//! by `rust/scripts/client-helpers-golden.mjs`, through the Rust port.
//!
//! Each case's result goes to snapshot JSON (see `claudius_client::types`)
//! and both sides are compared as canonical text: object keys sorted (JS
//! key order is not observable on these state objects), arrays in order,
//! numbers as JS prints them, strings with lone surrogates as escapes.
//! `Record`s the UI iterates are `[key, value]` pairs, so their order is
//! compared.
//!
//! `WIRE_TYPE_DIFFS` lists the cases where the TS copies a non-string (or
//! non-boolean) SDK field into a field it types as one, and the port reads
//! `""` (or nothing) instead. Each one must still differ, and only in the
//! fields it lists.

use claudius_client::blocks::{
    apply_bash_auto_background, blocks_from_sdk_content, coerce_todos, extract_peer_origin,
    extract_tool_result, extract_user_content, pick_primary_arg,
    tool_progress_info_from_sdk_message,
};
use claudius_client::compact::{
    merge_compact_boundary, next_transcript_path, normalize_compact_stats,
    with_paged_compact_boundary,
};
use claudius_client::labels::{
    MODEL_UNAVAILABLE_MESSAGE, RESUME_REASON_LABELS, STARTUP_FAILURE_REASON_LABELS,
    is_model_not_found_text, is_opus_high_demand_text, is_rate_limit_hit_text,
    rate_limit_hit_from_blocks, rate_limit_type_from_text, rewrite_model_unavailable_blocks,
};
use claudius_client::messages::{
    AssistantSplit, apply_tool_result_to_list, apply_tool_result_to_trails,
    build_subagent_messages, sort_messages_by_chronology, synthesize_older, upsert_assistant_split,
};
use claudius_client::sdk_filters::{
    CliWrapper, SDK_SLASH_COMMANDS, is_compact_summary_content, is_image_resize_note_content,
    is_local_command_caveat_content, is_sdk_internal_envelope, is_sdk_slash_user_message,
    is_synthetic_task_notification, parse_synthetic_cli_wrapper,
};
use claudius_client::{
    BackgroundBash, CompactStats, DisplayBlock, DisplayMessage, FixedEnv, JsRecord, JsThrow,
    RateLimitHit, RateLimitInfo, SystemEntry, ToolResult,
};
use claudius_core::js_string;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

/// A JSON pointer into a case's expected value and what the port has
/// there instead: JSON text, or `None` for absent.
type Patch = (&'static str, Option<&'static str>);

/// Cases whose TS result carries a non-string id / name / uuid (or a
/// non-boolean `is_error`, a missing `tool_use_id`) that the port reads as
/// `""` or absent, by design (see the crate docs), with the patches that
/// turn the TS result into the port's.
const WIRE_TYPE_DIFFS: &[(&str, &[Patch])] = &[
    (
        "blocksFromSDKContent/tool_use odd id and name",
        &[
            ("/out/0/id", Some(r#""""#)),
            ("/out/0/name", Some(r#""""#)),
            ("/out/1/id", Some(r#""""#)),
            ("/out/1/name", Some(r#""""#)),
        ],
    ),
    (
        "buildSubagentMessages/number uuid",
        &[("/out/0/uuid", Some(r#""""#))],
    ),
    ("extractToolResult/is_error odd", &[("/out/isError", None)]),
    ("extractToolResult/is_error null", &[("/out/isError", None)]),
    (
        "extractToolResult/no tool_use_id",
        &[("/out/tool_use_id", Some(r#""""#))],
    ),
    (
        "applyBashAutoBackground/odd task id",
        &[("/out/0/1/bashId", None)],
    ),
    (
        "applyBashAutoBackground/odd timeout",
        &[("/out/0/1/timedOutAfterMs", None)],
    ),
    (
        "applyBashAutoBackground/odd ends",
        &[("/out/0/1/endsWithAgentFinalResponse", None)],
    ),
    ("nextTranscriptPath/number path", &[("/out", Some("null"))]),
    (
        "toolProgressInfoFromSdkMessage/missing fields",
        &[
            ("/out/toolUseId", Some(r#""""#)),
            ("/out/toolName", Some(r#""""#)),
            ("/out/parentToolUseId", Some("null")),
        ],
    ),
    (
        "toolProgressInfoFromSdkMessage/odd types",
        &[
            ("/out/toolUseId", Some(r#""""#)),
            ("/out/toolName", Some(r#""""#)),
            ("/out/elapsedSeconds", None),
            ("/out/parentToolUseId", Some("null")),
            ("/out/subagentType", None),
            ("/out/subagentRetry/agentId", Some(r#""""#)),
            ("/out/subagentRetry/errorCategory", Some(r#""""#)),
            ("/out/subagentRetry/errorStatus", Some("null")),
        ],
    ),
];

/// `want` with `patches` applied.
fn patched(want: &Value, patches: &[Patch]) -> Value {
    let mut v = want.clone();
    for (ptr, to) in patches {
        let (parent, key) = ptr.rsplit_once('/').unwrap();
        let Some(Value::Object(m)) = v.pointer_mut(parent) else {
            panic!("{ptr}: no object at {parent:?} in {want}");
        };
        match to {
            Some(t) => m.insert(key.into(), serde_json::from_str(t).unwrap()),
            None => m.remove(key),
        };
    }
    v
}

const UNDEFINED: &str = r#"{"$undefined":true}"#;

fn undefined() -> Value {
    serde_json::from_str(UNDEFINED).unwrap()
}

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/client_helpers_golden.json"
    );
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `{"$repeat": [s, n]}` is `s.repeat(n)`.
fn expand(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(expand).collect()),
        Value::Object(m) => {
            if m.len() == 1
                && let Some(Value::Array(r)) = m.get("$repeat")
            {
                return Value::String(
                    r[0].as_str()
                        .unwrap()
                        .repeat(r[1].as_u64().unwrap() as usize),
                );
            }
            Value::Object(m.iter().map(|(k, v)| (k.clone(), expand(v))).collect())
        }
        v => v.clone(),
    }
}

/// Canonical text: sorted keys, JS number text, JS string escapes.
fn canon(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", js_string::stringify(&json!(k)), canon(&m[*k])))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canon).collect::<Vec<_>>().join(",")),
        Value::Number(n) => claudius_agent::js::number_to_string(n.as_f64().unwrap()),
        v => js_string::stringify(v),
    }
}

fn to_v<T: Serialize>(t: &T) -> Value {
    serde_json::to_value(t).unwrap()
}

fn from_v<T: DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{e}: {v}"))
}

fn opt_str(s: Option<&str>) -> Value {
    s.map_or_else(undefined, |s| json!(s))
}

fn thrown(e: &JsThrow) -> Value {
    json!({ "throws": e.to_string() })
}

/// The fixture case's expected fields (`out`, `same`, `throws`).
fn expected(case: &Value) -> Value {
    let mut m = Map::new();
    for k in ["out", "same", "throws"] {
        if let Some(v) = case.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    Value::Object(m)
}

fn out(v: Value) -> Value {
    json!({ "out": v })
}

fn out_same(v: Value, same: bool) -> Value {
    json!({ "out": v, "same": same })
}

fn result<T>(r: Result<T, JsThrow>, f: impl FnOnce(T) -> Value) -> Value {
    r.map_or_else(|e| thrown(&e), f)
}

fn pairs<V: Serialize>(rec: &JsRecord<V>) -> Value {
    Value::Array(rec.iter().map(|(k, v)| json!([k, to_v(v)])).collect())
}

fn record<V: DeserializeOwned>(v: &Value) -> JsRecord<V> {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), from_v(v)))
        .collect()
}

fn blocks(v: &Value) -> Vec<DisplayBlock> {
    from_v(v)
}

fn wrapper(w: Option<CliWrapper>) -> Value {
    match w {
        None => Value::Null,
        Some(CliWrapper::Command {
            command,
            args,
            trailing,
        }) => json!({ "kind": "command", "command": command, "args": args, "trailing": trailing }),
        Some(CliWrapper::Stdout { text, trailing }) => {
            json!({ "kind": "stdout", "text": text, "trailing": trailing })
        }
        Some(CliWrapper::Stderr { text, trailing }) => {
            json!({ "kind": "stderr", "text": text, "trailing": trailing })
        }
    }
}

/// Runs one case of `section` through the port.
fn replay(section: &str, args: &[Value], now: f64) -> Value {
    let mut env = FixedEnv::new(now);
    let a = |i: usize| args.get(i);
    let s = |i: usize| a(i).and_then(Value::as_str);
    match section {
        "isRateLimitHitText" => out(json!(is_rate_limit_hit_text(&blocks(&args[0])))),
        "isOpusHighDemandText" => out(json!(is_opus_high_demand_text(&blocks(&args[0])))),
        "isModelNotFoundText" => out(json!(is_model_not_found_text(&blocks(&args[0])))),
        "rateLimitTypeFromText" => out(opt_str(rate_limit_type_from_text(s(0).unwrap()))),
        "rewriteModelUnavailableBlocks" => {
            let b = blocks(&args[0]);
            match rewrite_model_unavailable_blocks(&b, s(1)) {
                Some(new) => out_same(to_v(&new), false),
                None => out_same(to_v(&b), true),
            }
        }
        "rateLimitHitFromBlocks" => {
            let last: Option<RateLimitInfo> = a(1).filter(|v| !v.is_null()).map(from_v);
            out(to_v(&rate_limit_hit_from_blocks(
                &blocks(&args[0]),
                last.as_ref(),
                s(2),
                s(3),
            )))
        }
        "coerceTodos" => out(to_v(&coerce_todos(args[0].as_array().unwrap()))),
        "blocksFromSDKContent" => {
            result(blocks_from_sdk_content(a(0), &mut env), |b| out(to_v(&b)))
        }
        "buildSubagentMessages" => result(
            build_subagent_messages(args[0].as_array().unwrap(), s(1).unwrap(), &mut env),
            |m| out(to_v(&m)),
        ),
        "extractUserContent" => {
            let c = extract_user_content(a(0));
            out(
                json!({ "text": c.text, "images": to_v(&c.images), "reminderBodies": c.reminder_bodies }),
            )
        }
        "extractPeerOrigin" => out(extract_peer_origin(a(0)).map_or_else(undefined, |p| {
            let mut m = Map::new();
            m.insert("from".into(), json!(p.from));
            if let Some(n) = p.name {
                m.insert("name".into(), json!(n));
            }
            if let Some(b) = p.body {
                m.insert("body".into(), json!(b));
            }
            if let Some(pid) = p.pid {
                m.insert("pid".into(), claudius_client::types::num::to_value(pid));
            }
            if let Some(id) = p.msg_id {
                m.insert("msgId".into(), json!(id));
            }
            Value::Object(m)
        })),
        "extractToolResult" => result(extract_tool_result(a(0), a(1), a(2)), |r| {
            out(r.map_or(Value::Null, |r| {
                let mut m = Map::new();
                m.insert("tool_use_id".into(), json!(r.tool_use_id));
                m.insert("text".into(), json!(r.text));
                if let Some(e) = r.is_error {
                    m.insert("isError".into(), json!(e));
                }
                for (k, on) in [
                    ("staged", r.staged),
                    ("detached", r.detached),
                    ("notRun", r.not_run),
                ] {
                    if on {
                        m.insert(k.into(), json!(true));
                    }
                }
                Value::Object(m)
            }))
        }),
        "applyBashAutoBackground" => {
            let mut shells: JsRecord<BackgroundBash> = record(&args[0]);
            let o = &args[1];
            let changed = apply_bash_auto_background(
                &mut shells,
                o["toolUseId"].as_str().unwrap(),
                o["command"].as_str().unwrap(),
                o.get("toolUseResult"),
                o["startedAt"].as_f64().unwrap(),
            );
            out_same(pairs(&shells), !changed)
        }
        "pickPrimaryArg" => result(pick_primary_arg(s(0).unwrap(), a(1)), |p| {
            out(opt_str(p.as_deref()))
        }),
        "sortMessagesByChronology" => {
            let mut list: Vec<DisplayMessage> = from_v(&args[0]);
            let changed = sort_messages_by_chronology(&mut list);
            let uuids: Vec<&str> = list.iter().map(|m| m.uuid.as_str()).collect();
            out_same(json!(uuids), !changed)
        }
        "applyToolResultToList" => {
            let mut list: Vec<DisplayMessage> = from_v(&args[0]);
            let r: Option<ToolResult> = a(2).map(from_v);
            let changed = apply_tool_result_to_list(&mut list, s(1).unwrap(), r.as_ref());
            out_same(to_v(&list), !changed)
        }
        "applyToolResultToTrails" => {
            let mut trails: JsRecord<Vec<DisplayMessage>> = record(&args[0]);
            let r: Option<ToolResult> = a(2).map(from_v);
            let changed = apply_tool_result_to_trails(&mut trails, s(1).unwrap(), r.as_ref());
            out_same(pairs(&trails), !changed)
        }
        "nextTranscriptPath" => result(next_transcript_path(s(0), &args[1]), |p| {
            out(p.map_or(Value::Null, |p| json!(p)))
        }),
        "withPagedCompactBoundary" => {
            let mut entries: Vec<SystemEntry> = from_v(&args[0]);
            result(
                with_paged_compact_boundary(
                    &mut entries,
                    args[1].as_array().unwrap(),
                    args[2].as_bool().unwrap(),
                ),
                |changed| out_same(to_v(&entries), !changed),
            )
        }
        "mergeCompactBoundary" => {
            let mut entries: Vec<SystemEntry> = from_v(&args[0]);
            let patch = &args[3];
            let stats: Option<CompactStats> = patch.get("compactStats").map(from_v);
            merge_compact_boundary(
                &mut entries,
                s(1).unwrap(),
                s(2).unwrap(),
                stats.as_ref(),
                patch.get("compactSummary").and_then(Value::as_str),
            );
            out(to_v(&entries))
        }
        "normalizeCompactStats" => {
            out(normalize_compact_stats(a(0)).map_or_else(undefined, |s| to_v(&s)))
        }
        "synthesizeOlder" => result(
            synthesize_older(args[0].as_array().unwrap(), &mut env),
            |m| out(json!({ "messages": to_v(&m) })),
        ),
        "toolProgressInfoFromSdkMessage" => {
            result(tool_progress_info_from_sdk_message(&args[0]), |t| {
                out(to_v(&t))
            })
        }
        "upsertAssistantSplit" => {
            let o = &args[0];
            let mut list: Vec<DisplayMessage> = from_v(&o["prev"]);
            let split = AssistantSplit {
                message_id: o["messageId"].as_str().unwrap().into(),
                sdk_uuid: o["sdkUuid"].as_str().unwrap().into(),
                blocks: blocks(&o["newBlocks"]),
                has_stream_scratch: o["hasStreamScratch"].as_bool().unwrap(),
                parent_tool_use_id: o
                    .get("parentToolUseId")
                    .and_then(Value::as_str)
                    .map(Into::into),
                at: o.get("at").and_then(Value::as_f64),
                rate_limit_hit: o.get("rateLimitHit").map(from_v::<RateLimitHit>),
                opus_high_demand: o.get("opusHighDemand").and_then(Value::as_bool),
                aborted: o.get("aborted").and_then(Value::as_bool),
                error_tag: o.get("errorTag").and_then(Value::as_str).map(Into::into),
            };
            let changed = upsert_assistant_split(&mut list, &split);
            out(json!({ "list": to_v(&list), "same": !changed }))
        }
        "isSdkInternalEnvelope" => out(json!(is_sdk_internal_envelope(a(0)))),
        other => panic!("no replay for section {other}"),
    }
}

/// Every `name` in `WIRE_TYPE_DIFFS` is `<section>/<case name>`.
#[test]
fn replays_the_ts_helpers() {
    let fx = fixture();
    // A JSONL `timestamp` without a zone is local time.
    unsafe { std::env::set_var("TZ", fx["tz"].as_str().unwrap()) };
    let now = fx["now"].as_f64().unwrap();
    let sections = fx["sections"].as_object().unwrap();
    let mut failures = Vec::new();
    let mut diffs_seen = Vec::new();
    let mut cases = 0;
    let mut check = |id: String, want: &Value, got: &Value| {
        cases += 1;
        let (w, g) = (canon(want), canon(got));
        if let Some((_, patches)) = WIRE_TYPE_DIFFS.iter().find(|(d, _)| *d == id) {
            diffs_seen.push(id.clone());
            let p = canon(&patched(want, patches));
            if w == g {
                failures.push(format!("{id}: listed in WIRE_TYPE_DIFFS but now matches"));
            } else if p != g {
                failures.push(format!(
                    "{id}: differs beyond its listed fields:\n   ts+patches: {p}\n rust: {g}"
                ));
            }
        } else if w != g {
            failures.push(format!("{id}:\n   ts: {w}\n rust: {g}"));
        }
    };

    for (name, cases_v) in sections {
        match name.as_str() {
            "RESUME_REASON_LABELS" | "STARTUP_FAILURE_REASON_LABELS" => {
                let table = if name == "RESUME_REASON_LABELS" {
                    RESUME_REASON_LABELS
                } else {
                    STARTUP_FAILURE_REASON_LABELS
                };
                let got = Value::Array(table.iter().map(|(k, v)| json!([k, v])).collect());
                check(name.clone(), cases_v, &got);
            }
            "MODEL_UNAVAILABLE_MESSAGE" => {
                check(name.clone(), cases_v, &json!(MODEL_UNAVAILABLE_MESSAGE))
            }
            "sdkSlashCommands" => check(name.clone(), cases_v, &json!(SDK_SLASH_COMMANDS)),
            "slashNames" => {
                for c in cases_v.as_array().unwrap() {
                    let n = c["name"].as_str().unwrap();
                    let got = match is_sdk_slash_user_message(Some(&json!(format!("/{n} arg")))) {
                        Ok(Some(u)) => json!({ "command": u.command, "args": u.args }),
                        Ok(None) => Value::Null,
                        Err(e) => thrown(&e),
                    };
                    check(format!("slashNames/{n}"), &c["out"], &got);
                }
            }
            "userPrompt" => {
                for c in cases_v.as_array().unwrap() {
                    let t = c["text"].as_str().unwrap();
                    let (reminders, rest) =
                        claudius_core::user_prompt::split_leading_system_reminders(t);
                    let got = json!({
                        "text": t,
                        "stripGoalReminder": claudius_core::user_prompt::strip_goal_reminder(t),
                        "splitLeadingSystemReminders": { "reminders": reminders, "rest": rest },
                    });
                    check(
                        format!("userPrompt/{}", js_string::stringify(&json!(t))),
                        c,
                        &got,
                    );
                }
            }
            "sdkFilters" => {
                for c in cases_v.as_array().unwrap() {
                    let content = c.get("content");
                    let each = |r: Result<Value, JsThrow>| r.map_or_else(|e| thrown(&e), out);
                    let mut got = Map::new();
                    got.insert("name".into(), c["name"].clone());
                    if let Some(v) = content {
                        got.insert("content".into(), v.clone());
                    }
                    let slash = is_sdk_slash_user_message(content).map(|u| {
                        u.map_or(
                            Value::Null,
                            |u| json!({ "command": u.command, "args": u.args }),
                        )
                    });
                    got.insert("isSdkSlashUserMessage".into(), each(slash));
                    got.insert(
                        "parseSyntheticCliWrapper".into(),
                        each(Ok(wrapper(parse_synthetic_cli_wrapper(content)))),
                    );
                    for (k, f) in [
                        (
                            "isCompactSummaryContent",
                            is_compact_summary_content as fn(Option<&Value>) -> bool,
                        ),
                        (
                            "isLocalCommandCaveatContent",
                            is_local_command_caveat_content,
                        ),
                        ("isImageResizeNoteContent", is_image_resize_note_content),
                        (
                            "isSyntheticTaskNotification",
                            is_synthetic_task_notification,
                        ),
                    ] {
                        got.insert(k.into(), each(Ok(json!(f(content)))));
                    }
                    check(
                        format!("sdkFilters/{}", c["name"].as_str().unwrap()),
                        c,
                        &Value::Object(got),
                    );
                }
            }
            _ => {
                for c in cases_v.as_array().unwrap() {
                    let args: Vec<Value> = expand(&c["args"]).as_array().unwrap().clone();
                    let got = replay(name, &args, now);
                    let id = format!("{name}/{}", c["name"].as_str().unwrap());
                    check(id, &expected(c), &got);
                }
            }
        }
    }
    for (d, _) in WIRE_TYPE_DIFFS {
        if !diffs_seen.iter().any(|s| s == d) {
            failures.push(format!(
                "{d}: listed in WIRE_TYPE_DIFFS but not in the fixture"
            ));
        }
    }
    assert!(cases > 600, "only {cases} cases");
    assert!(
        failures.is_empty(),
        "{} of {cases} cases differ from the TS:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
