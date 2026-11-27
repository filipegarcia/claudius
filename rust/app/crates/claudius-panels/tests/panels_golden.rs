//! Replays `fixtures/panels_golden.json`, recorded from the real TS by
//! `rust/scripts/panels-golden.mjs`, through the rail's helpers
//! (`claudius_panels::{format, tasks, rows, usage, card, todos, rail}`):
//! format.ts, usage-windows.ts, task-status.ts, session-loops.ts and the
//! rules cut out of BackgroundTasksPanel.tsx, ScheduledLoops.tsx,
//! PlanUsageCard.tsx, SessionCard.tsx, use-countdown.ts,
//! useRateLimitWarning.ts and ChatSurface.tsx.

use std::collections::HashSet;

use claudius_client::idle_reconcile::ToolHistoryEntry;
use claudius_client::loops::ScheduledLoop;
use claudius_client::task_status::TaskInfo;
use claudius_client::types::{BackgroundBash, JsRecord, RateLimitInfo};
use claudius_panels::tasks::{self, Lists, ListsInput};
use claudius_panels::usage::{self, UsageWindow};
use claudius_panels::{card, format, rail, rows, todos};
use indexmap::IndexSet;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("fixtures/panels_golden.json");

fn section(name: &str) -> Vec<(Vec<Value>, Value)> {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    let cases = f["sections"][name]
        .as_array()
        .unwrap_or_else(|| panic!("no section {name}"));
    assert!(!cases.is_empty(), "{name} is empty");
    cases
        .iter()
        .map(|c| (c["args"].as_array().unwrap().clone(), c["out"].clone()))
        .collect()
}

/// Runs every case of `name` through `f`; a case `f` can't express (a
/// type the Rust side never sees) returns `None` and is counted out.
fn replay(name: &str, f: impl Fn(&[Value]) -> Option<Value>) {
    let cases = section(name);
    let mut bad = Vec::new();
    let mut ran = 0;
    for (args, want) in &cases {
        let Some(got) = f(args) else { continue };
        ran += 1;
        if norm(&got) != norm(want) {
            bad.push(format!("  {args:?}\n    want {want}\n    got  {got}"));
        }
    }
    assert!(ran > 0, "{name}: no case ran");
    assert!(
        bad.is_empty(),
        "{name}: {} of {ran} differ\n{}",
        bad.len(),
        bad.join("\n")
    );
}

fn opt_f(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn opt<T: Into<Value>>(o: Option<T>) -> Value {
    o.map_or(Value::Null, Into::into)
}

/// A `TaskInfo` from a partial row (the required fields filled in), or
/// none when a flag isn't a boolean (the client's types hold booleans).
fn task(v: &Value) -> Option<TaskInfo> {
    let mut o = json!({ "taskId": "x", "description": "d", "status": "running" });
    for (k, x) in v.as_object()? {
        if matches!(k.as_str(), "skipTranscript" | "ambient") && !x.is_boolean() {
            return None;
        }
        o[k] = x.clone();
    }
    Some(serde_json::from_value(o).unwrap())
}

fn sched(v: &Value) -> ScheduledLoop {
    let mut o = json!({
        "kind": "cron", "id": "x", "toolUseId": "tu", "cron": null, "humanSchedule": null,
        "delaySeconds": null, "prompt": "p", "recurring": false, "durable": false, "startedAt": 0,
    });
    for (k, x) in v.as_object().unwrap() {
        o[k] = x.clone();
    }
    serde_json::from_value(o).unwrap()
}

fn window(v: &Value) -> UsageWindow {
    UsageWindow {
        key: v["key"].as_str().unwrap().into(),
        label: v["label"].as_str().unwrap().into(),
        pct: v["pct"].as_f64().unwrap(),
        resets_at_sec: v.get("resetsAtSec").and_then(Value::as_f64),
        rejected: v["rejected"].as_bool().unwrap(),
    }
}

fn window_json(w: &UsageWindow) -> Value {
    let mut o = json!({ "key": w.key, "label": w.label, "pct": w.pct });
    if let Some(s) = w.resets_at_sec {
        o["resetsAtSec"] = json!(s);
    }
    o["rejected"] = json!(w.rejected);
    o
}

fn num(n: f64) -> Value {
    json!(n)
}

/// Numbers compare as `f64`: JS has one number type, so `12` and `12.0`
/// read the same.
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), norm(x))).collect()),
        x => x.clone(),
    }
}

#[test]
fn format_ts() {
    replay("fmtUsd", |a| Some(json!(format::fmt_usd(opt_f(&a[0])))));
    replay("fmtTokens", |a| {
        Some(json!(format::fmt_tokens(opt_f(&a[0]))))
    });
    replay("fmtElapsedSec", |a| {
        Some(json!(format::fmt_elapsed_sec(a[0].as_f64().unwrap())))
    });
    replay("fmtMs", |a| Some(json!(format::fmt_ms(opt_f(&a[0])))));
    replay("fmtPath", |a| {
        let max = a[1].as_i64().unwrap_or(36);
        Some(json!(format::fmt_path(a[0].as_str().unwrap(), max)))
    });
}

#[test]
fn the_panels_inline_helpers() {
    replay("fmtElapsed", |a| {
        Some(json!(format::fmt_elapsed(a[0].as_f64().unwrap())))
    });
    replay("taskElapsedSeconds", |a| {
        let t = task(&a[0])?;
        Some(opt(
            tasks::task_elapsed_seconds(&t, a[1].as_f64().unwrap()).map(num)
        ))
    });
    replay("taskStatusLabel", |a| {
        Some(json!(tasks::task_status_label(&task(&a[0])?)))
    });
    replay("taskStatusTitle", |a| {
        Some(opt(tasks::task_status_title(&task(&a[0])?)))
    });
    replay("taskIcon", |a| Some(json!(tasks::task_icon(a[0].as_str()))));
    replay("compactArg", |a| {
        Some(json!(format::compact_arg(
            a[0].as_str().unwrap(),
            a[1].as_str().unwrap()
        )))
    });
}

#[test]
fn task_status_predicates() {
    replay("isSystemTask", |a| {
        Some(json!(tasks::is_system_task(&task(&a[0])?)))
    });
    replay("isActivityCountableTask", |a| {
        Some(json!(tasks::is_activity_countable_task(&task(&a[0])?)))
    });
    replay("isBackgroundTaskLive", |a| {
        let ids: Option<IndexSet<String>> = serde_json::from_value(a[1].clone()).unwrap();
        Some(json!(tasks::is_background_task_live(
            &task(&a[0])?,
            ids.as_ref()
        )))
    });
}

#[test]
fn the_panels_lists() {
    replay("lists", |a| {
        let c = &a[0];
        let tasks_: JsRecord<TaskInfo> = serde_json::from_value(c["tasks"].clone()).unwrap();
        let live: Option<IndexSet<String>> =
            serde_json::from_value(c["liveBackgroundTaskIds"].clone()).unwrap();
        let bashes: JsRecord<BackgroundBash> =
            serde_json::from_value(c["backgroundBashes"].clone()).unwrap();
        let loops: JsRecord<ScheduledLoop> =
            serde_json::from_value(c["scheduledLoops"].clone()).unwrap();
        let history: Vec<ToolHistoryEntry> =
            serde_json::from_value(c["toolHistory"].clone()).unwrap();
        let l = Lists::of(
            ListsInput {
                tasks: &tasks_,
                live_background_task_ids: live.as_ref(),
                background_bashes: &bashes,
                scheduled_loops: &loops,
                tool_history: &history,
                pending_permission: c["pendingPermission"].as_bool().unwrap(),
                ready: c["ready"].as_bool().unwrap(),
                pending: c["pending"].as_bool().unwrap(),
                session_id: c["sessionId"].as_str(),
            },
            c["now"].as_f64().unwrap(),
        );
        Some(json!({
            "runningCount": l.running_count,
            "subagents": l.subagents,
            "systemTasks": l.system_tasks,
            "earlier": l.earlier,
            "recent": l.recent,
            "runningBashes": l.running_bashes,
            "runningProcessTasks": l.running_process_tasks,
            "runningProcs": l.running_procs,
            "stoppable": l.stoppable,
            "loops": l.loops,
            "activeLoopCount": l.active_loop_count,
            "nonAmbientSubagents": l.non_ambient_subagents,
            "attention": l.attention,
            "runningBg": l.running_bg,
            "busy": l.busy,
        }))
    });
}

#[test]
fn scheduled_loops() {
    let none = HashSet::new();
    replay("cadence", |a| {
        let l = sched(&a[0]);
        let row = rows::loop_row(&l, true, &none, a[1].as_f64().unwrap(), &chrono::Utc);
        Some(json!(row.cadence))
    });
    replay("isStaleWakeup", |a| {
        Some(json!(tasks::is_stale_wakeup(
            &sched(&a[0]),
            a[1].as_f64().unwrap()
        )))
    });
    replay("scheduledLoopCancelPrompt", |a| {
        Some(json!(tasks::scheduled_loop_cancel_prompt(&sched(&a[0]))))
    });
}

#[test]
fn usage_windows() {
    replay("collectUsageWindows", |a| {
        let events: Vec<RateLimitInfo> = serde_json::from_value(a[1].clone()).unwrap();
        let ws = usage::collect_usage_windows(&a[0], &events, a[2].as_f64().unwrap());
        Some(Value::Array(ws.iter().map(window_json).collect()))
    });
    replay("shortUsageLabel", |a| {
        Some(json!(usage::short_usage_label(&window(&a[0]))))
    });
    replay("displayUsagePct", |a| {
        Some(num(usage::display_usage_pct(&window(&a[0]))))
    });
    replay("usageTone", |a| {
        Some(json!(
            usage::usage_tone(&window(&a[0]), a[1].as_f64().unwrap()).as_str()
        ))
    });
}

#[test]
fn the_countdown() {
    replay("formatRemaining", |a| {
        Some(json!(usage::format_remaining(a[0].as_f64().unwrap())))
    });
    replay("limitHasReset", |a| {
        Some(json!(usage::limit_has_reset(
            opt_f(&a[0]),
            a[1].as_f64().unwrap()
        )))
    });
    replay("countdown", |a| {
        let (r, now) = (opt_f(&a[0]), a[1].as_f64().unwrap());
        // `hasReset` only once there's a reset to count down to.
        let has_reset = r.is_some_and(|r| r != 0.0) && usage::limit_has_reset(r, now);
        Some(json!({ "countdown": usage::countdown(r, now), "hasReset": has_reset }))
    });
    replay("formatReset", |a| {
        Some(json!(usage::format_reset(
            a[0].as_f64().unwrap(),
            &chrono::Utc
        )))
    });
    replay("warningPct", |a| {
        Some(num(usage::rate_limit_warning_pct(a[0].as_str())))
    });
}

#[test]
fn the_session_card() {
    replay("effortPill", |a| {
        let p = card::effort_pill(
            a[0].as_str().unwrap(),
            a[1].as_str(),
            a[2].as_bool().unwrap(),
        );
        Some(json!({ "label": p.label, "shown": p.shown, "title": p.title }))
    });
    replay("modeLabel", |a| {
        Some(json!(card::mode_label(a[0].as_str().unwrap())))
    });
    replay("badgeAdvisorLabel", |a| {
        // A number never reaches the badge: the client holds strings.
        if a[0].is_number() {
            return None;
        }
        Some(opt(card::badge_advisor_label(a[0].as_str())))
    });
    replay("prettyModelName", |a| {
        Some(json!(claudius_client::shared::pretty_model_name(
            a[0].as_str()
        )))
    });
}

#[test]
fn todos_and_subagent_prompts() {
    replay("addTodosPrompt", |a| {
        let texts: Vec<String> = serde_json::from_value(a[0].clone()).unwrap();
        Some(opt(todos::add_todos_prompt(&texts)))
    });
    replay("messageSubagentDraft", |a| {
        Some(json!(rail::message_subagent_draft(a[0].as_str().unwrap())))
    });
}
