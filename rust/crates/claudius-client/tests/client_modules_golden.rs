//! Replays `tests/fixtures/client_modules_golden.json`, recorded from the
//! real TS modules the chat client's reducer calls (lib/client/task-status,
//! idle-reconcile, prompt-queue, system-entries, stream-recovery,
//! boot-guard, two sdk-message-filters predicates, and the lib/shared
//! readers) by `rust/scripts/client-modules-golden.mjs`, through the Rust
//! port.
//!
//! Each case's result goes to snapshot JSON (see `claudius_client::types`)
//! and both sides are compared as canonical text: object keys sorted, arrays
//! in order, numbers as JS prints them, strings with lone surrogates as
//! escapes. `Record`s the UI iterates are `[key, value]` pairs, so their
//! order is compared. The boot guard's scenarios run on a fake storage that
//! logs every call, and each op's result, calls and the storage left are
//! compared.
//!
//! `DIFFS` lists the cases that differ by design, with the value the port
//! gives instead; each must still differ, and only there.

use claudius_client::boot_guard::{
    BOOT_FORCE_KEY, BOOT_MARKER_KEY, BOOT_MARKER_TTL_MS, SkippedBoot, TabStorage,
    clear_boot_attempt_for, consume_forced_resume, mark_boot_attempt, scope_skipped_boot,
    should_skip_resume,
};
use claudius_client::effort_wait::{
    EffortPick, EffortWaitState, NO_EFFORT_WAIT, effort_applied, effort_picked,
    effort_request_started,
};
use claudius_client::idle_reconcile::{
    ToolHistoryEntry, apply_thinking_tokens_estimate, clear_streaming, sweep_tool_history_done,
};
use claudius_client::labels::{CONVERSATION_RESET_TRIGGER_LABEL, conversation_reset_detail};
use claudius_client::loops::{
    ScheduledLoop, is_schedule_wakeup_stop, mark_wakeups_stopped, read_cron_next_fire_at,
};
use claudius_client::parse_init::parse_init_system_message;
use claudius_client::prompt_queue::{Keyed, drop_prompt, enqueue_prompt, merge_server_prompts};
use claudius_client::sdk_filters::{is_real_user_display_message, is_suppressed_system_event};
use claudius_client::shared::{
    ADVISOR_ACTIVE_SENTINEL, TokenBreakdown, classify_informational_level, cost_from_tokens,
    hook_event_gets_durable_pill, is_fast_mode_credits_rejected_notice, parse_task_list_result,
};
use claudius_client::stream_recovery::{
    STREAM_BADGE_AFTER_MS, STREAM_REBUILD_AFTER_MS, STREAM_RECOVERY_MAX_DELAY_MS,
    should_rebuild_transcript, stream_recovery_delay_ms,
};
use claudius_client::system_entries::append_coalesced_system_entry;
use claudius_client::task_status::{
    TaskInfo, drop_provisional_for_tool_use, find_tool_use_block, is_backgrounded_tool_use,
    reconcile_tasks_on_tool_result, seed_task_status, set_task_model_for_tool_use,
    should_recover_orphan_task, upsert_provisional_task,
};
use claudius_client::types::num;
use claudius_client::workflow_meta::parse_workflow_meta;
use claudius_client::{DisplayBlock, DisplayMessage, JsRecord, JsThrow, SystemEntry};
use claudius_core::js_string;
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

/// Cases that differ by design: `<section>/<case>` (a boot scenario's op
/// is `bootGuard/<scenario>/<op index>`), a JSON pointer into the expected
/// value, and what the port has there (JSON text).
const DIFFS: &[(&str, &str, &str)] = &[
    // `JSON.parse("1e400")` is `Infinity` in JS, a number, so the marker
    // counts; the port reads it as `null` (see the boot_guard docs).
    ("bootGuard/foreign marker: at past f64/0", "/out", "false"),
    (
        "bootGuard/foreign marker: at past f64/1",
        "/calls",
        r#"[["getItem","claudius:boot-pending"]]"#,
    ),
    (
        "bootGuard/foreign marker: at past f64/storage",
        "",
        r#"[["claudius:boot-pending","{\"id\":\"s1\",\"at\":1e400}"]]"#,
    ),
    // A trigger named after an `Object.prototype` member reads that member
    // in the TS (see `conversation_reset_detail`).
    (
        "conversationResetDetail/constructor",
        "/out",
        r#""reason unspecified""#,
    ),
    (
        "conversationResetDetail/toString",
        "/out",
        r#""reason unspecified""#,
    ),
    (
        "conversationResetDetail/__proto__",
        "/out",
        r#""reason unspecified""#,
    ),
    (
        "conversationResetDetail/hasOwnProperty",
        "/out",
        r#""reason unspecified""#,
    ),
];

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/client_modules_golden.json"
    );
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `{"$repeat": [s, n]}` is `s.repeat(n)`. `$num` stays (the replay reads
/// numbers with `num::from_value`).
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

/// A JS number argument (`$num` for the ones JSON can't hold).
fn n(v: &Value) -> f64 {
    num::from_value(v).unwrap_or_else(|| panic!("not a number: {v}"))
}

const UNDEFINED: &str = r#"{"$undefined":true}"#;

fn undefined() -> Value {
    serde_json::from_str(UNDEFINED).unwrap()
}

fn thrown(e: &JsThrow) -> Value {
    json!({ "throws": e.to_string() })
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

/// A `Record` argument. The fixture's object keys are in JS own-key order
/// already (the recorder wrote them with `JSON.stringify`).
fn record<V: DeserializeOwned>(v: &Value) -> JsRecord<V> {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), from_v(v)))
        .collect()
}

/// The fixture case's expected fields.
fn expected(case: &Value) -> Value {
    let mut m = Map::new();
    for k in ["out", "same", "throws"] {
        if let Some(v) = case.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    Value::Object(m)
}

/// A queued prompt: any object with a string `requestId`.
#[derive(Clone)]
struct Prompt(Value);

impl Keyed for Prompt {
    fn request_id(&self) -> &str {
        self.0["requestId"].as_str().unwrap()
    }
}

fn prompts(v: &Value) -> Vec<Prompt> {
    v.as_array().unwrap().iter().cloned().map(Prompt).collect()
}

fn prompt_list(q: &[Prompt]) -> Value {
    Value::Array(q.iter().map(|p| p.0.clone()).collect())
}

fn effort_state(v: &Value) -> EffortWaitState {
    from_v(v)
}

fn tokens(v: &Value) -> TokenBreakdown {
    TokenBreakdown {
        input: n(&v["input"]),
        output: n(&v["output"]),
        cache_read: n(&v["cacheRead"]),
        cache_write_5m: n(&v["cacheWrite5m"]),
        cache_write_1h: n(&v["cacheWrite1h"]),
    }
}

/// Runs one case of `section` through the port.
fn replay(section: &str, args: &[Value]) -> Value {
    let a = |i: usize| args.get(i);
    let s = |i: usize| a(i).and_then(Value::as_str);
    match section {
        "setTaskModelForToolUse" => {
            let mut tasks: JsRecord<TaskInfo> = record(&args[0]);
            let changed = set_task_model_for_tool_use(&mut tasks, s(1).unwrap(), s(2).unwrap());
            out_same(pairs(&tasks), !changed)
        }
        "findToolUseBlock" => {
            let lists: Vec<Vec<DisplayMessage>> = args[1..].iter().map(from_v).collect();
            let refs: Vec<&[DisplayMessage]> = lists.iter().map(Vec::as_slice).collect();
            out(find_tool_use_block(s(0).unwrap(), &refs).map_or(Value::Null, to_v))
        }
        "shouldRecoverOrphanTask" => {
            let t = &args[0];
            let messages: Vec<DisplayMessage> = from_v(&args[1]);
            out(json!(should_recover_orphan_task(
                t.get("toolUseId").and_then(Value::as_str),
                t.get("status").and_then(Value::as_str),
                &messages,
            )))
        }
        "isBackgroundedToolUse" => {
            let b: Option<DisplayBlock> = a(0).filter(|v| !v.is_null()).map(from_v);
            result(is_backgrounded_tool_use(b.as_ref()), |r| out(json!(r)))
        }
        "reconcileTasksOnToolResult" => {
            let mut tasks: JsRecord<TaskInfo> = record(&args[0]);
            let changed = reconcile_tasks_on_tool_result(
                &mut tasks,
                s(1).unwrap(),
                a(2).and_then(Value::as_bool),
                args[3].as_bool().unwrap(),
            );
            out_same(pairs(&tasks), !changed)
        }
        "seedTaskStatus" => {
            let b: Option<DisplayBlock> = a(0).filter(|v| !v.is_null()).map(from_v);
            result(seed_task_status(b.as_ref()), |r| out(json!(r)))
        }
        "upsertProvisionalTask" => {
            let mut tasks: JsRecord<TaskInfo> = record(&args[0]);
            // The key goes in separately; the port sets the row's
            // `toolUseId` itself.
            let mut p: TaskInfo = from_v(&args[1]);
            let id = p.tool_use_id.take().unwrap();
            let changed = upsert_provisional_task(&mut tasks, &id, p);
            out_same(pairs(&tasks), !changed)
        }
        "dropProvisionalForToolUse" => {
            let mut tasks: JsRecord<TaskInfo> = record(&args[0]);
            let dropped = drop_provisional_for_tool_use(&mut tasks, s(1));
            let mut o = Map::new();
            o.insert("tasks".into(), pairs(&tasks));
            if let Some(Some(at)) = dropped {
                o.insert("carriedStartedAt".into(), num::to_value(at));
            }
            out_same(Value::Object(o), dropped.is_none())
        }
        "applyThinkingTokensEstimate" => {
            let mut entries: Vec<ToolHistoryEntry> = from_v(&args[0]);
            let changed = apply_thinking_tokens_estimate(&mut entries, n(&args[1]), s(2));
            out_same(to_v(&entries), !changed)
        }
        "sweepToolHistoryDone" => {
            let mut entries: Vec<ToolHistoryEntry> = from_v(&args[0]);
            let changed = sweep_tool_history_done(&mut entries, n(&args[1]));
            out_same(to_v(&entries), !changed)
        }
        "clearStreaming" => {
            let mut messages: Vec<DisplayMessage> = from_v(&args[0]);
            let changed = clear_streaming(&mut messages);
            out_same(to_v(&messages), !changed)
        }
        "enqueuePrompt" => {
            let mut q = prompts(&args[0]);
            let changed = enqueue_prompt(&mut q, Prompt(args[1].clone()));
            out_same(prompt_list(&q), !changed)
        }
        "dropPrompt" => {
            let mut q = prompts(&args[0]);
            let changed = drop_prompt(&mut q, s(1).unwrap());
            out_same(prompt_list(&q), !changed)
        }
        "mergeServerPrompts" => {
            let mut q = prompts(&args[0]);
            let gone: IndexSet<String> = from_v::<Vec<String>>(&args[2]).into_iter().collect();
            let changed = merge_server_prompts(&mut q, &prompts(&args[1]), &gone);
            out_same(prompt_list(&q), !changed)
        }
        "appendCoalescedSystemEntry" => {
            let mut entries: Vec<SystemEntry> = from_v(&args[0]);
            append_coalesced_system_entry(&mut entries, from_v(&args[1]));
            out_same(to_v(&entries), false)
        }
        "streamRecoveryDelayMs" => out(num::to_value(stream_recovery_delay_ms(n(&args[0])))),
        "shouldRebuildTranscript" => out(json!(should_rebuild_transcript(n(&args[0])))),
        "scopeSkippedBoot" => {
            let state: Option<SkippedBoot> = from_v(&args[0]);
            out(to_v(&scope_skipped_boot(state, s(1))))
        }
        "isSuppressedSystemEvent" => out(json!(is_suppressed_system_event(a(0)))),
        "isRealUserDisplayMessage" => out(json!(is_real_user_display_message(&from_v(&args[0])))),
        "parseInitSystemMessage" => out(to_v(&parse_init_system_message(a(0)))),
        "parseTaskListResult" => {
            out(parse_task_list_result(s(0)).map_or(Value::Null, Value::Array))
        }
        "effortPicked" => {
            let o = &args[1];
            out(to_v(&effort_picked(
                &effort_state(&args[0]),
                EffortPick {
                    pending: o["pending"].as_bool().unwrap(),
                    picked: o["picked"].as_str().unwrap(),
                    shown_before: o["shownBefore"].as_str().unwrap(),
                    no_effort_param: o.get("noEffortParam").and_then(Value::as_bool) == Some(true),
                },
            )))
        }
        "effortApplied" => out(to_v(&effort_applied(&effort_state(&args[0]), a(1)))),
        "effortRequestStarted" => out(to_v(&effort_request_started(&effort_state(&args[0])))),
        "isScheduleWakeupStop" => out(json!(is_schedule_wakeup_stop(a(0)))),
        "markWakeupsStopped" => {
            let mut loops: JsRecord<ScheduledLoop> = record(&args[0]);
            let stop_at = a(1).filter(|v| !v.is_null()).map(n);
            let changed = mark_wakeups_stopped(&mut loops, stop_at);
            out_same(pairs(&loops), !changed)
        }
        "readCronNextFireAt" => {
            out(read_cron_next_fire_at(a(0)).map_or_else(undefined, num::to_value))
        }
        "parseWorkflowMeta" => out(to_v(&parse_workflow_meta(a(0)))),
        "classifyInformationalLevel" => {
            let (hidden, level) = classify_informational_level(s(0));
            let mut o = Map::new();
            o.insert("hidden".into(), json!(hidden));
            if let Some(l) = level {
                o.insert("infoLevel".into(), json!(l));
            }
            out(Value::Object(o))
        }
        "hookEventGetsDurablePill" => out(json!(hook_event_gets_durable_pill(
            s(0).unwrap(),
            args[1].as_bool().unwrap()
        ))),
        "isFastModeCreditsRejectedNotice" => out(json!(
            a(0).is_some_and(is_fast_mode_credits_rejected_notice)
        )),
        "costFromTokens" => out(num::to_value(cost_from_tokens(s(0), &tokens(&args[1])))),
        "conversationResetDetail" => out(json!(conversation_reset_detail(s(0)))),
        other => panic!("no replay for section {other}"),
    }
}

/// The recorder's fake `Storage`: a `Map` (insertion order) that logs each
/// call and throws from the methods listed.
struct FakeStorage {
    data: IndexMap<String, String>,
    throws: Vec<String>,
    log: Vec<Value>,
}

impl FakeStorage {
    fn call(&mut self, op: &str, args: &[&str]) -> Result<(), JsThrow> {
        let mut entry = vec![json!(op)];
        entry.extend(args.iter().map(|a| json!(a)));
        self.log.push(Value::Array(entry));
        if self.throws.iter().any(|t| t == op) {
            return Err(JsThrow {
                name: "SecurityError",
                message: format!("{op} denied"),
            });
        }
        Ok(())
    }
}

impl TabStorage for FakeStorage {
    fn get_item(&mut self, key: &str) -> Result<Option<String>, JsThrow> {
        self.call("getItem", &[key])?;
        Ok(self.data.get(key).cloned())
    }

    fn set_item(&mut self, key: &str, value: &str) -> Result<(), JsThrow> {
        self.call("setItem", &[key, value])?;
        self.data.insert(key.into(), value.into());
        Ok(())
    }

    fn remove_item(&mut self, key: &str) -> Result<(), JsThrow> {
        self.call("removeItem", &[key])?;
        self.data.shift_remove(key);
        Ok(())
    }
}

/// One boot-guard scenario: each op's `{out, calls}`, then the storage.
fn replay_boot(case: &Value) -> (Vec<Value>, Value) {
    let mut st = FakeStorage {
        data: case["initial"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p[0].as_str().unwrap().to_owned(),
                    p[1].as_str().unwrap().to_owned(),
                )
            })
            .collect(),
        throws: from_v(&case["throwsOn"]),
        log: Vec::new(),
    };
    let mut results = Vec::new();
    for op in case["ops"].as_array().unwrap() {
        let op = op.as_array().unwrap();
        let id = op[1].as_str().unwrap();
        st.log.clear();
        let got = match op[0].as_str().unwrap() {
            "shouldSkipResume" => json!(should_skip_resume(
                id,
                &mut st,
                n(&op[2]),
                op[3].as_bool().unwrap(),
                n(&op[4])
            )),
            "markBootAttempt" => {
                mark_boot_attempt(id, &mut st, n(&op[2]), n(&op[3]));
                undefined()
            }
            "clearBootAttemptFor" => {
                clear_boot_attempt_for(id, &mut st);
                undefined()
            }
            "consumeForcedResume" => json!(consume_forced_resume(id, &mut st)),
            other => panic!("no boot op {other}"),
        };
        results.push(json!({ "out": got, "calls": st.log.clone() }));
    }
    let storage = Value::Array(st.data.iter().map(|(k, v)| json!([k, v])).collect());
    (results, storage)
}

#[test]
fn replays_the_ts_modules() {
    let fx = fixture();
    let sections = fx["sections"].as_object().unwrap();
    let mut failures = Vec::new();
    let mut diffs_seen = Vec::new();
    let mut cases = 0;
    let mut check = |id: String, want: &Value, got: &Value| {
        cases += 1;
        let (w, g) = (canon(want), canon(got));
        let listed: Vec<_> = DIFFS.iter().filter(|(d, _, _)| *d == id).collect();
        if listed.is_empty() {
            if w != g {
                failures.push(format!("{id}:\n   ts: {w}\n rust: {g}"));
            }
            return;
        }
        diffs_seen.push(id.clone());
        let mut patched = want.clone();
        for (_, ptr, to) in listed {
            let to: Value = serde_json::from_str(to).unwrap();
            match patched.pointer_mut(ptr) {
                Some(slot) => *slot = to,
                None => panic!("{id}: no {ptr} in {want}"),
            }
        }
        if w == g {
            failures.push(format!("{id}: listed in DIFFS but now matches"));
        } else if canon(&patched) != g {
            failures.push(format!(
                "{id}: differs beyond its listed fields:\n   ts+patches: {}\n rust: {g}",
                canon(&patched)
            ));
        }
    };

    for (name, cases_v) in sections {
        match name.as_str() {
            "streamConstants" => check(
                name.clone(),
                cases_v,
                &json!({
                    "STREAM_BADGE_AFTER_MS": STREAM_BADGE_AFTER_MS,
                    "STREAM_RECOVERY_MAX_DELAY_MS": STREAM_RECOVERY_MAX_DELAY_MS,
                    "STREAM_REBUILD_AFTER_MS": STREAM_REBUILD_AFTER_MS,
                }),
            ),
            "bootConstants" => check(
                name.clone(),
                cases_v,
                &json!({
                    "BOOT_MARKER_KEY": BOOT_MARKER_KEY,
                    "BOOT_FORCE_KEY": BOOT_FORCE_KEY,
                    "BOOT_MARKER_TTL_MS": BOOT_MARKER_TTL_MS,
                }),
            ),
            "NO_EFFORT_WAIT" => check(name.clone(), cases_v, &to_v(&NO_EFFORT_WAIT)),
            "ADVISOR_ACTIVE_SENTINEL" => {
                check(name.clone(), cases_v, &json!(ADVISOR_ACTIVE_SENTINEL))
            }
            "CONVERSATION_RESET_TRIGGER_LABEL" => {
                let got = Value::Array(
                    CONVERSATION_RESET_TRIGGER_LABEL
                        .iter()
                        .map(|(k, v)| json!([k, v]))
                        .collect(),
                );
                check(name.clone(), cases_v, &got);
            }
            "bootGuard" => {
                for c in cases_v.as_array().unwrap() {
                    let scenario = c["name"].as_str().unwrap();
                    let (results, storage) = replay_boot(c);
                    let want = c["results"].as_array().unwrap();
                    assert_eq!(want.len(), results.len(), "{scenario}");
                    for (i, (w, g)) in want.iter().zip(&results).enumerate() {
                        check(format!("bootGuard/{scenario}/{i}"), w, g);
                    }
                    check(
                        format!("bootGuard/{scenario}/storage"),
                        &c["storage"],
                        &storage,
                    );
                }
            }
            _ => {
                for c in cases_v.as_array().unwrap() {
                    let args: Vec<Value> = expand(&c["args"]).as_array().unwrap().clone();
                    let got = replay(name, &args);
                    let id = format!("{name}/{}", c["name"].as_str().unwrap());
                    check(id, &expected(c), &got);
                }
            }
        }
    }
    for (d, _, _) in DIFFS {
        if !diffs_seen.iter().any(|s| s == d) {
            failures.push(format!("{d}: listed in DIFFS but not in the fixture"));
        }
    }
    assert!(cases > 550, "only {cases} cases");
    assert!(
        failures.is_empty(),
        "{} of {cases} cases differ from the TS:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
