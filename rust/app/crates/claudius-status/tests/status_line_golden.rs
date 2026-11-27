//! Replays `fixtures/status_line_golden.json`, recorded from the real TS by
//! `rust/scripts/status-line-golden.mjs`, through the status line's
//! helpers (`claudius_status::{line, modes, picker}`) and the
//! `statusParts` rules cut out of `StatusLine.tsx` through
//! [`line::status_line`].

use claudius_status::line::{self, StatusProps};
use claudius_status::modes;
use claudius_status::picker::{self, ModelInfo};
use claudius_status::tone::Tone;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("fixtures/status_line_golden.json");

/// The fixture's clock (`statusParts`' turn starts this long before now).
const NOW: f64 = 1_795_683_600_000.0;

fn opt_s(v: &Value) -> Option<&str> {
    v.as_str()
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn opt(o: Option<impl Into<Value>>) -> Value {
    o.map_or(Value::Null, Into::into)
}

fn tone_class(t: Tone) -> &'static str {
    match t {
        Tone::Muted => "text-[var(--muted)]",
        Tone::Emerald400 => "text-emerald-400",
        Tone::Sky400 => "text-sky-400",
        Tone::Violet400 => "text-violet-400",
        Tone::Amber400 => "text-amber-400",
        Tone::Red400 => "text-red-400",
        other => panic!("no mode has {other:?}"),
    }
}

/// `statusParts(p)` through the model: the props a chat would pass.
fn status_parts(p: &Value) -> Value {
    let b = |k: &str| p.get(k).and_then(Value::as_bool).unwrap_or(false);
    let n = |k: &str| p.get(k).and_then(Value::as_f64);
    let props = StatusProps {
        session_id: Some("s1".into()),
        ready: b("ready"),
        pending: b("pending"),
        stream_status: "live".into(),
        // `backgroundTasks = 0`: the default applies to `undefined`.
        background_tasks: p.get("backgroundTasks").cloned().unwrap_or(json!(0)),
        // `useElapsedSeconds`: whole seconds since the start.
        turn_started_at: n("turnElapsedSec").map(|s| NOW - s * 1000.0),
        running_hook: Value::Null,
        tool_active: b("toolActive"),
        resuming_thought: b("resumingThought"),
        last_turn_completed_at: None,
        permission_mode: "default".into(),
        model: None,
        main_agent: None,
        account: None,
        session_root: None,
        agent_cwd: None,
        context_percent: n("contextPercent"),
        fast_mode_state: Value::Null,
        fast_mode_disabled_reason: None,
        total_cost_usd: n("totalCostUsd"),
        output_tokens: n("outputTokens"),
        disabled_modes: Vec::new(),
        zen: false,
    };
    let m = line::status_line(&props, NOW, &chrono::Utc);
    let (ctx, level, title) = match &m.context {
        Some(c) => (
            claudius_core::js_num(c.percent),
            c.level.as_str(),
            json!(c.level.title()),
        ),
        None => (Value::Null, "ok", Value::Null),
    };
    json!({
        "status": m.status.as_str(),
        "statusLabel": m.label,
        "labelTitle": opt(m.label_title),
        "ctx": ctx,
        "ctxLevel": level,
        "ctxTitle": title,
        "costText": opt(m.cost.as_ref().map(|c| c.cost.clone())),
        "tokensText": opt(m.cost.as_ref().and_then(|c| c.tokens.clone())),
    })
}

fn models(v: &Value) -> Vec<ModelInfo> {
    v.as_array()
        .map(|a| a.iter().filter_map(ModelInfo::parse).collect())
        .unwrap_or_default()
}

/// The helper `name` on `args`, as the recorder wrote its result.
fn call(name: &str, args: &[Value]) -> Value {
    let a = |i: usize| &args[i];
    match name {
        "workingStatusLabel" => {
            let o = a(1);
            let flag = |k: &str| o.get(k).and_then(Value::as_bool).unwrap_or(false);
            json!(line::working_status_label(
                a(0).as_f64(),
                flag("toolActive"),
                flag("resumingThought")
            ))
        }
        "formatElapsed" => json!(claudius_chat::tool_text::format_elapsed(
            a(0).as_f64().unwrap()
        )),
        "worktreeBadge" => opt(line::worktree_badge(opt_s(a(0)), opt_s(a(1)))),
        "worktreeBadgeLabel" => json!(line::worktree_badge_label(
            opt_s(a(0)).unwrap(),
            opt_s(a(1)).unwrap()
        )),
        "modelDeprecationDate" => opt(line::model_deprecation_date(opt_s(a(0)))),
        "prettyModelName" => json!(claudius_client::shared::pretty_model_name(opt_s(a(0)))),
        "fastModeLabel" => json!(picker::fast_mode_label(opt_s(a(0)))),
        "fastModeDisabledReasonLabel" => json!(line::fast_mode_disabled_reason_label(opt_s(a(0)))),
        "nextPermissionMode" => json!(modes::next_permission_mode(
            opt_s(a(0)).unwrap(),
            &strs(a(1))
        )),
        "visibleOrder" => json!(modes::visible_order(opt_s(a(0)).unwrap(), &strs(a(1)))),
        "permissionModeMeta" => modes::MODE_META
            .iter()
            .map(|m| {
                json!({
                    "mode": m.mode,
                    "label": m.label,
                    "description": m.description,
                    "icon": m.icon,
                    "tone": tone_class(m.tone),
                })
            })
            .collect(),
        "statusParts" => status_parts(a(0)),
        "findModelEntry" => {
            let list = models(a(0));
            opt(picker::find_model_entry(&list, opt_s(a(1))).map(|m| m.value.clone()))
        }
        "capEffortLevels" => json!(picker::cap_effort_levels(&strs(a(0)), opt_s(a(1)))),
        "formatClockTime" => opt(a(0)
            .as_f64()
            .and_then(|at| line::format_clock_time(at, &chrono::Utc))),
        "toFixed" => json!(line::to_fixed(
            a(0).as_f64().unwrap(),
            a(1).as_u64().unwrap() as u32
        )),
        other => panic!("no replay for {other}"),
    }
}

#[test]
fn the_helpers_replay_the_ts() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let sections = fixture["sections"].as_object().unwrap();
    let mut checked = 0;
    let mut failures = Vec::new();
    for (name, cases) in sections {
        for case in cases.as_array().unwrap() {
            let args = case["args"].as_array().unwrap();
            let got = call(name, args);
            if got != case["out"] {
                failures.push(format!(
                    "{name}({}): got {got}, want {}",
                    Value::Array(args.clone()),
                    case["out"]
                ));
            }
            checked += 1;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(checked, 398, "the fixture's case count");
}
