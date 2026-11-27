//! The status line's pure rules, each test named after the rule it pins
//! (StatusLine.tsx, ModeSelector.tsx, ModelPicker.tsx, useContextWatcher,
//! useDisableAutoMode / useMaxEffortLevel). The helpers the TS exports
//! replay against it in `status_line_golden.rs`.

use claudius_client::effect::FetchOutcome;
use claudius_client::state::ChatState;
use claudius_status::line::{self, CtxLevel, Status, StatusProps};
use claudius_status::modes;
use claudius_status::picker::{self, ModelInfo, ModelList, Pick, PickerInputs, StatusSettings};
use serde_json::{Value, json};

const NOW: f64 = 1_795_683_600_000.0;

fn chat() -> ChatState {
    let mut s = ChatState::new("tab-s1");
    s.session_id = Some("s1".into());
    s.ready = true;
    s
}

fn props(f: impl FnOnce(&mut ChatState)) -> StatusProps {
    let mut s = chat();
    f(&mut s);
    StatusProps::of(&s)
}

fn line_of(p: &StatusProps) -> line::StatusLineModel {
    line::status_line(p, NOW, &chrono::Utc)
}

fn ok(body: Value) -> FetchOutcome {
    FetchOutcome::Response {
        status: 200,
        body: body.to_string(),
    }
}

fn reply(status: u16, body: &str) -> FetchOutcome {
    FetchOutcome::Response {
        status,
        body: body.into(),
    }
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

// ------------------------------------------------------------ the status

#[test]
fn not_ready_is_starting_before_anything_else() {
    let p = props(|s| {
        s.ready = false;
        s.pending = true;
    });
    let m = line_of(&p);
    assert_eq!((m.status, m.label.as_str()), (Status::Starting, "Starting"));
    assert!(m.busy && m.compact_disabled);
}

#[test]
fn pending_is_working_and_disables_compact() {
    let m = line_of(&props(|s| s.pending = true));
    assert_eq!((m.status, m.label.as_str()), (Status::Working, "Working"));
    assert!(m.busy && m.compact_disabled);
}

#[test]
fn idle_with_background_tasks_is_background_with_its_count() {
    let m = line_of(&props(|s| s.background_tasks = json!(2)));
    assert_eq!(m.status, Status::Background);
    assert_eq!(m.label, "Idle \u{b7} 2 running");
    assert_eq!(
        m.label_title.as_deref(),
        Some(
            "2 background tasks are still running \u{2014} the turn is idle but work continues. See the Activity panel."
        )
    );
    let one = line_of(&props(|s| s.background_tasks = json!(1)));
    assert!(
        one.label_title
            .unwrap()
            .starts_with("1 background task is still")
    );
}

#[test]
fn idle_has_no_pulse_and_compact_is_enabled() {
    let m = line_of(&props(|_| {}));
    assert_eq!((m.status, m.label.as_str()), (Status::Idle, "Idle"));
    assert!(!m.busy && !m.compact_disabled);
    assert_eq!(m.label_title, None);
}

#[test]
fn the_elapsed_time_shows_only_while_working() {
    let started = Some(NOW - 61_000.);
    let working = line_of(&props(|s| {
        s.pending = true;
        s.turn_started_at = started;
    }));
    assert_eq!(working.elapsed.as_deref(), Some("1m 1s"));
    let idle = line_of(&props(|s| s.turn_started_at = started));
    assert_eq!(idle.elapsed, None);
}

#[test]
fn deep_in_thought_after_45_seconds_with_its_title() {
    let m = line_of(&props(|s| {
        s.pending = true;
        s.turn_started_at = Some(NOW - 45_000.);
    }));
    assert_eq!(m.label, "Deep in thought");
    assert_eq!(
        m.label_title.as_deref(),
        Some("Still working \u{2014} this turn has been running for 45s without a break.")
    );
}

#[test]
fn an_open_tool_keeps_the_label_working() {
    let mut p = props(|s| {
        s.pending = true;
        s.turn_started_at = Some(NOW - 90_000.);
    });
    p.tool_active = true;
    assert_eq!(line_of(&p).label, "Working");
}

#[test]
fn a_max_output_tokens_retry_is_picking_the_thought_back_up() {
    let mut p = props(|s| s.pending = true);
    p.resuming_thought = true;
    assert_eq!(line_of(&p).label, "Picking the thought back up");
}

#[test]
fn the_done_time_shows_unless_working() {
    let at = Some(NOW - 60_000.);
    let idle = line_of(&props(|s| s.last_turn_completed_at = at));
    assert!(idle.done_at.is_some());
    assert_eq!(
        idle.done_at,
        line::format_clock_time(NOW - 60_000., &chrono::Utc)
    );
    let working = line_of(&props(|s| {
        s.last_turn_completed_at = at;
        s.pending = true;
    }));
    assert_eq!(working.done_at, None);
}

#[test]
fn reconnecting_shows_only_for_a_reconnecting_stream() {
    for (status, shown) in [
        ("live", false),
        ("connecting", false),
        ("reconnecting", true),
    ] {
        let m = line_of(&props(|s| s.stream_status = status));
        assert_eq!(m.reconnecting.is_some(), shown, "{status}");
    }
}

#[test]
fn the_worktree_badge_names_the_agents_cwd_under_the_root() {
    let m = line_of(&props(|s| {
        s.cwd = json!("/repo/");
        s.agent_cwd = Some(json!("/repo/.claude/worktrees/feat"));
    }));
    let w = m.worktree.expect("a badge");
    assert_eq!(w.text, ".claude/worktrees/feat");
    assert!(w.title.contains("\n/repo/.claude/worktrees/feat\n"));
    let same = line_of(&props(|s| {
        s.cwd = json!("/repo");
        s.agent_cwd = Some(json!("/repo/"));
    }));
    assert_eq!(same.worktree, None);
}

#[test]
fn the_model_chip_prints_the_pretty_name_and_warns_on_a_deprecated_model() {
    assert_eq!(line_of(&props(|_| {})).model, None, "no model, no chip");
    assert_eq!(line_of(&props(|s| s.model = json!(""))).model, None);
    let m = line_of(&props(|s| s.model = json!("claude-3-opus-20240229")))
        .model
        .unwrap();
    assert!(m.deprecated);
    assert_eq!(
        m.title,
        "Model claude-3-opus-20240229 reaches end-of-life on January 5th, 2026. Switch to a current model to avoid an automatic fallback."
    );
    let cur = line_of(&props(|s| s.model = json!("claude-opus-4-5")))
        .model
        .unwrap();
    assert!(!cur.deprecated);
    assert_eq!(cur.title, "claude-opus-4-5");
    assert_eq!(
        cur.text,
        claudius_client::shared::pretty_model_name(Some("claude-opus-4-5"))
    );
}

#[test]
fn the_agent_pill_is_default_without_a_main_agent() {
    let d = line_of(&props(|_| {})).agent;
    assert_eq!((d.text.as_str(), d.named), ("Default", false));
    assert_eq!(d.title, line::DEFAULT_AGENT_TITLE);
    let n = line_of(&props(|s| s.main_agent = Some(json!("reviewer")))).agent;
    assert_eq!((n.text.as_str(), n.named), ("reviewer", true));
    assert!(n.title.starts_with("Main-thread agent: reviewer"));
    // An empty name prints empty, as the default agent.
    let e = line_of(&props(|s| s.main_agent = Some(json!("")))).agent;
    assert_eq!((e.text.as_str(), e.named), ("", false));
}

#[test]
fn the_account_badge_drifts_when_the_default_account_moved() {
    let plain = line_of(&props(|s| {
        s.account = Some(json!({ "id": "a1", "label": "Work" }))
    }))
    .account
    .unwrap();
    assert_eq!((plain.text.as_str(), plain.drift), ("Work", false));
    assert_eq!(plain.title, "Running under account: Work");
    let drift = line_of(&props(|s| {
        s.account = Some(json!({
            "id": "a1",
            "label": "Work",
            "driftFromActive": { "label": "Home" },
        }))
    }))
    .account
    .unwrap();
    assert!(drift.drift);
    assert!(
        drift
            .title
            .contains("switched the default account to \"Home\"")
    );
    // `account.driftFromActive && …`: a falsy value is no drift.
    for falsy in [json!(false), json!(0), json!(""), Value::Null] {
        let a = line_of(&props(|s| {
            s.account = Some(json!({ "id": "a1", "label": "Work", "driftFromActive": falsy }))
        }))
        .account
        .unwrap();
        assert!(!a.drift, "{falsy}");
    }
}

#[test]
fn the_cost_chip_shows_with_a_cost_or_tokens() {
    assert_eq!(line_of(&props(|_| {})).cost, None);
    let tokens_only = line_of(&props(|s| s.usage = json!({ "outputTokens": 500 })))
        .cost
        .unwrap();
    assert_eq!(tokens_only.cost, "\u{2014}");
    assert_eq!(tokens_only.tokens.as_deref(), Some("500 tok"));
    let cost = line_of(&props(|s| s.usage = json!({ "totalCostUsd": 1.5 })))
        .cost
        .unwrap();
    assert_eq!((cost.cost.as_str(), cost.tokens), ("$1.500", None));
}

#[test]
fn the_fast_chip_shows_for_a_state_other_than_off() {
    assert_eq!(line_of(&props(|_| {})).fast, None);
    assert_eq!(
        line_of(&props(|s| s.fast_mode_state = json!("off"))).fast,
        None
    );
    let on = line_of(&props(|s| s.fast_mode_state = json!("on")))
        .fast
        .unwrap();
    assert!(on.on);
    assert_eq!(on.text, "\u{26a1} on");
    assert_eq!(
        on.title,
        "Fast mode active \u{2014} draws from usage credits"
    );
    let cool = line_of(&props(|s| {
        s.fast_mode_state = json!("cooldown");
        s.fast_mode_disabled_reason = json!("rate_limit");
    }))
    .fast
    .unwrap();
    assert!(!cool.on);
    assert_eq!(
        cool.title,
        line::fast_mode_disabled_reason_label(Some("rate_limit"))
    );
}

#[test]
fn the_context_chip_warns_from_75_and_is_danger_from_90() {
    for (pct, shown, level) in [
        (0.0, 0.0, CtxLevel::Ok),
        (74.4, 74.0, CtxLevel::Ok),
        (74.5, 75.0, CtxLevel::Warn),
        (89.4, 89.0, CtxLevel::Warn),
        (89.5, 90.0, CtxLevel::Danger),
        (130.0, 130.0, CtxLevel::Danger),
    ] {
        assert_eq!(line::context_level(pct), (shown, level), "{pct}");
    }
    let mut p = props(|_| {});
    assert_eq!(line_of(&p).context, None, "no reading, no chip");
    p.context_percent = Some(80.4);
    let c = line_of(&p).context.unwrap();
    assert_eq!((c.text.as_str(), c.level), ("80%", CtxLevel::Warn));
}

#[test]
fn a_running_hook_shows_its_event_and_time() {
    let m = line_of(&props(|s| {
        s.running_hook = json!({ "event": "PreToolUse", "startedAt": NOW - 3_000. })
    }));
    let h = m.hook.unwrap();
    assert_eq!(h.text, "Running PreToolUse hook \u{b7} 3s");
    assert_eq!(h.title, "A PreToolUse hook is running");
    assert_eq!(line_of(&props(|_| {})).hook, None);
}

#[test]
fn zen_hides_the_right_cluster() {
    let mut p = props(|_| {});
    p.zen = true;
    assert!(line_of(&p).zen);
}

#[test]
fn the_props_read_the_chats_state() {
    let p = props(|s| {
        s.permission_mode = Some(json!("plan"));
        s.cwd = json!("/w");
        s.usage = json!({ "totalCostUsd": 0.5, "outputTokens": 10 });
    });
    assert_eq!(p.permission_mode, "plan");
    assert_eq!(p.session_root.as_deref(), Some("/w"));
    assert_eq!((p.total_cost_usd, p.output_tokens), (Some(0.5), Some(10.)));
    // No mode yet reads as `default`.
    assert_eq!(props(|_| {}).permission_mode, "default");
}

fn retry(error: &str) -> claudius_client::api_retry::ApiRetryState {
    serde_json::from_value(json!({
        "attempt": 1,
        "maxRetries": 10,
        "retryDelayMs": 1000,
        "errorStatus": null,
        "error": error,
    }))
    .unwrap()
}

#[test]
fn only_a_max_output_tokens_retry_resumes_the_thought() {
    assert!(props(|s| s.api_retry = Some(retry("max_output_tokens"))).resuming_thought);
    assert!(!props(|s| s.api_retry = Some(retry("overloaded"))).resuming_thought);
    assert!(!props(|_| {}).resuming_thought);
}

// ------------------------------------------------------------- the modes

#[test]
fn the_menu_lists_every_mode_in_cycle_order_the_current_one_marked() {
    let rows = modes::menu("plan", &[]);
    let names: Vec<_> = rows.iter().map(|o| o.meta.mode).collect();
    assert_eq!(names, modes::PERMISSION_MODE_ORDER);
    let active: Vec<_> = rows
        .iter()
        .filter(|o| o.active)
        .map(|o| o.meta.mode)
        .collect();
    assert_eq!(active, ["plan"]);
}

#[test]
fn a_disabled_mode_leaves_the_menu_unless_it_is_the_current_one() {
    let disabled = strings(&["auto"]);
    let rows = modes::menu("default", &disabled);
    assert!(rows.iter().all(|o| o.meta.mode != "auto"));
    assert_eq!(rows.len(), 5);
    let current = modes::menu("auto", &disabled);
    assert!(current.iter().any(|o| o.meta.mode == "auto" && o.active));
}

#[test]
fn the_cycle_skips_a_disabled_mode_and_wraps() {
    let disabled = strings(&["auto"]);
    assert_eq!(
        modes::next_permission_mode("acceptEdits", &disabled),
        "plan"
    );
    assert_eq!(modes::next_permission_mode("acceptEdits", &[]), "auto");
    // The current mode stays in the cycle even when disabled.
    assert_eq!(modes::next_permission_mode("auto", &disabled), "plan");
    assert_eq!(
        modes::next_permission_mode("bypassPermissions", &[]),
        "default"
    );
    assert_eq!(modes::next_permission_mode("nonsense", &[]), "default");
}

#[test]
fn an_unknown_mode_shows_the_default_trigger() {
    assert_eq!(modes::trigger_meta("nonsense").mode, "default");
    assert_eq!(modes::trigger_meta("plan").label, "Plan");
    assert_eq!(
        modes::trigger_title(modes::trigger_meta("plan")),
        format!(
            "Permission mode: Plan \u{2014} {}\nShift+Tab to cycle",
            modes::mode_meta("plan").unwrap().description
        )
    );
}

// ------------------------------------------------------------ the picker

fn opus() -> Value {
    json!({
        "value": "opus",
        "resolvedModel": "claude-opus-4-5",
        "displayName": "Opus",
        "description": "The most capable",
        "supportsEffort": true,
        "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
        "supportsFastMode": true,
    })
}

fn listed(models: Value) -> Vec<ModelInfo> {
    match picker::models_from(&ok(json!({ "models": models }))) {
        ModelList::Loaded(l) => l,
        other => panic!("{other:?}"),
    }
}

fn inputs(current: &str) -> PickerInputs {
    PickerInputs {
        current_model: Some(current.into()),
        now_ms: NOW,
        ..PickerInputs::default()
    }
}

#[test]
fn the_model_list_skips_rows_without_a_value() {
    let l = listed(json!([opus(), { "displayName": "No value" }, { "value": "sonnet" }]));
    let values: Vec<_> = l.iter().map(|m| m.value.as_str()).collect();
    assert_eq!(values, ["opus", "sonnet"]);
    assert_eq!(l[1].label(), "sonnet", "no display name: the value");
    assert_eq!(l[0].active_id(), "claude-opus-4-5");
}

#[test]
fn a_failed_list_shows_the_error_or_the_status() {
    assert_eq!(
        picker::models_from(&FetchOutcome::Failed("Failed to fetch".into())),
        ModelList::Failed("Failed to fetch".into())
    );
    assert_eq!(
        picker::models_from(&reply(503, r#"{"error":"not running"}"#)),
        ModelList::Failed("not running".into())
    );
    assert_eq!(
        picker::models_from(&reply(500, "oops")),
        ModelList::Failed("HTTP 500".into())
    );
    assert_eq!(
        picker::models_from(&reply(200, "{}")),
        ModelList::Loaded(vec![])
    );
    assert_eq!(picker::models_url(None), None);
    assert_eq!(picker::models_url(Some("")), None);
    assert_eq!(
        picker::models_url(Some("s1")).as_deref(),
        Some("/api/sessions/s1/model")
    );
    assert_eq!(
        picker::no_session(),
        ModelList::Failed("No active session".into())
    );
}

#[test]
fn the_current_row_is_checked_and_tags_effort_and_fast() {
    let l = listed(json!([opus(), { "value": "sonnet" }]));
    let pm = picker::picker(&l, &inputs("claude-opus-4-5[1m]"));
    assert!(pm.rows[0].current, "found through the resolved id");
    assert!(!pm.rows[1].current);
    assert!(pm.rows[0].effort_tag && pm.rows[0].fast_tag);
    assert!(!pm.rows[1].effort_tag && !pm.rows[1].fast_tag);
    assert!(!pm.rows[0].credits, "credits only with fast mode on");
    let fast = picker::picker(
        &l,
        &PickerInputs {
            fast_mode: true,
            ..inputs("opus")
        },
    );
    assert!(fast.rows[0].credits && !fast.rows[1].credits);
}

#[test]
fn the_effort_chips_are_auto_the_levels_and_ultracode() {
    let l = listed(json!([opus()]));
    let (name, chips) = picker::picker(&l, &inputs("opus")).effort.unwrap();
    assert_eq!(name, "Opus");
    let labels: Vec<_> = chips.iter().map(|c| c.label).collect();
    assert_eq!(
        labels,
        [
            "Auto",
            "Low",
            "Medium",
            "High",
            "Very High",
            "Max",
            "Ultracode"
        ]
    );
    assert_eq!(chips[0].pick, Pick::Effort("auto".into()));
    assert_eq!(chips[6].pick, Pick::Ultracode(true));
}

#[test]
fn the_effort_chips_stop_at_the_max_effort_setting() {
    let l = listed(json!([opus()]));
    let capped = PickerInputs {
        max_effort_level: Some("high".into()),
        ..inputs("opus")
    };
    let (_, chips) = picker::picker(&l, &capped).effort.unwrap();
    let tones: Vec<_> = chips.iter().map(|c| c.tone.as_str()).collect();
    assert_eq!(tones, ["adaptive", "low", "medium", "high", "ultracode"]);
}

#[test]
fn no_adaptive_thinking_drops_auto() {
    let mut m = opus();
    m["supportsAdaptiveThinking"] = json!(false);
    let (_, chips) = picker::picker(&listed(json!([m])), &inputs("opus"))
        .effort
        .unwrap();
    assert_eq!(chips[0].label, "Low");
}

#[test]
fn a_model_without_effort_has_no_effort_section() {
    let l = listed(json!([{ "value": "sonnet", "supportedEffortLevels": ["low"] }]));
    let pm = picker::picker(&l, &inputs("sonnet"));
    assert_eq!(pm.effort, None);
    assert_eq!(pm.ultracode, None);
    assert_eq!(pm.fast, None);
}

#[test]
fn the_ultracode_and_fast_toggles_flip_the_current_value() {
    let l = listed(json!([opus()]));
    let pm = picker::picker(
        &l,
        &PickerInputs {
            ultracode: true,
            ..inputs("opus")
        },
    );
    let u = pm.ultracode.unwrap();
    assert!(u.enabled);
    assert_eq!(u.pick, Pick::Ultracode(false));
    let f = pm.fast.unwrap();
    assert!(!f.enabled);
    assert_eq!(f.pick, Pick::Fast(true));
    assert_eq!(f.label, picker::fast_mode_label(Some("claude-opus-4-5")));
}

#[test]
fn a_model_pick_keeps_the_picker_open_the_rest_close_it() {
    assert!(!Pick::Model("opus".into()).closes());
    assert!(Pick::Effort("high".into()).closes());
    assert!(Pick::Ultracode(true).closes());
    assert!(Pick::Fast(false).closes());
}

// ------------------------------------------------------ settings, context

#[test]
fn the_settings_are_read_for_the_cwd_encoded() {
    assert_eq!(picker::settings_url(None), None);
    assert_eq!(
        picker::settings_url(Some("/a b/c&d")).as_deref(),
        Some("/api/settings?scope=user&cwd=%2Fa%20b%2Fc%26d")
    );
}

#[test]
fn disable_auto_mode_disables_auto_and_max_effort_caps() {
    let s = picker::settings_from(&ok(json!({
        "settings": { "disableAutoMode": "disable", "maxEffortLevel": "high" }
    })));
    assert_eq!(
        s,
        StatusSettings {
            auto_mode_disabled: true,
            max_effort_level: Some("high".into()),
        }
    );
    assert_eq!(s.disabled_modes(), strings(&["auto"]));
    assert!(StatusSettings::default().disabled_modes().is_empty());
}

#[test]
fn unreadable_settings_leave_the_defaults() {
    for o in [
        FetchOutcome::Failed("Failed to fetch".into()),
        reply(500, r#"{"settings":{"disableAutoMode":"disable"}}"#),
        reply(200, "not json"),
        reply(200, "null"),
    ] {
        assert_eq!(
            picker::settings_from(&o),
            StatusSettings::default(),
            "{o:?}"
        );
    }
}

#[test]
fn the_context_poll_waits_then_polls_faster_mid_turn() {
    assert_eq!(picker::CONTEXT_FIRST_POLL_MS, 1_500);
    assert_eq!(picker::context_poll_delay_ms(true), 8_000);
    assert_eq!(picker::context_poll_delay_ms(false), 30_000);
    assert_eq!(
        picker::context_url("s1"),
        "/api/sessions/s1/context?detail=summary"
    );
}

#[test]
fn the_context_reply_reads_percentage_or_zero_and_keeps_the_last_on_failure() {
    assert_eq!(
        picker::context_from(&ok(json!({ "percentage": 42.5 }))),
        Some(Some(42.5))
    );
    assert_eq!(picker::context_from(&ok(json!({}))), Some(Some(0.0)));
    assert_eq!(
        picker::context_from(&ok(json!({ "percentage": null }))),
        Some(Some(0.0))
    );
    assert_eq!(
        picker::context_from(&ok(json!({ "percentage": "x" }))),
        Some(None)
    );
    assert_eq!(picker::context_from(&reply(500, "{}")), None);
    assert_eq!(picker::context_from(&reply(200, "null")), None);
    assert_eq!(
        picker::context_from(&FetchOutcome::Failed("x".into())),
        None
    );
}
