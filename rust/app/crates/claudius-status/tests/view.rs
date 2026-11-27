//! The status line in a headless GPUI window (`TestAppContext`, CoreText
//! for real glyph widths) over a [`FixtureStatus`]: picking a mode, a
//! model, an effort or fast mode calls the chat's action with the value
//! picked; a disabled mode can't be picked; the working label and the
//! elapsed time follow a running turn; the context and cost meters; the
//! Reconnecting badge. macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;
use std::time::Duration;

use claudius_gpui_theme::ThemeName;
use claudius_status::line::{CtxLevel, Status};
use claudius_status::picker::{self, ModelList, Pick};
use claudius_status::view::Popup;
use claudius_status::{FixtureStatus, StatusLineView, StatusTarget};
use gpui::{Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use serde_json::{Value, json};

/// The fixture's clock: when its turns start and end.
const T0: f64 = 1_795_683_600_000.0;

fn app() -> TestAppContext {
    let cx = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        claudius_gpui_theme::init(ThemeName::Dark, cx);
    });
    cx
}

fn open<'a>(
    app: &'a mut TestAppContext,
    chat: &Arc<FixtureStatus>,
    width: f32,
) -> (Entity<StatusLineView>, &'a mut VisualTestContext) {
    let target: Arc<dyn StatusTarget> = chat.clone();
    let (view, cx) = app.add_window_view(|_, cx| {
        let mut v = StatusLineView::new(target, ThemeName::Dark, cx);
        v.set_now(T0, cx);
        v
    });
    cx.simulate_resize(size(px(width), px(720.)));
    settle(cx);
    (view, cx)
}

/// Runs the tasks (change notifications, fetch replies), then draws
/// (twice: the first draw measures the row's width).
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }
    cx.run_until_parked();
}

fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    cx.debug_bounds(selector).is_some()
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(b.center(), Modifiers::default());
    settle(cx);
}

fn now(view: &Entity<StatusLineView>, cx: &mut VisualTestContext, at: f64) {
    view.update(cx, |v, cx| v.set_now(at, cx));
    settle(cx);
}

fn advance(cx: &mut VisualTestContext, ms: u64) {
    cx.executor().advance_clock(Duration::from_millis(ms));
    settle(cx);
}

fn model(
    view: &Entity<StatusLineView>,
    cx: &mut VisualTestContext,
) -> claudius_status::line::StatusLineModel {
    view.read_with(cx, |v, _| v.model().expect("a chat"))
}

fn body(b: &Option<String>) -> Value {
    serde_json::from_str(b.as_deref().expect("a body")).unwrap()
}

/// The POSTs the actions made to `/api/sessions/s1/<what>`, their bodies.
fn posted(chat: &FixtureStatus, what: &str) -> Vec<Value> {
    let url = format!("POST /api/sessions/s1/{what}");
    chat.posts()
        .iter()
        .filter(|(u, _)| *u == url)
        .map(|(_, b)| body(b))
        .collect()
}

fn turn(chat: &FixtureStatus, status: &str) {
    chat.event(json!({ "type": "turn_status", "status": status }));
}

#[gpui::test]
fn picking_a_mode_posts_it_and_closes_the_menu() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    let (view, cx) = open(&mut app, &chat, 1200.);
    assert!(drawn(cx, "mode-selector-label"), "wide: the label shows");
    assert!(!drawn(cx, "mode-selector-menu"));

    click(cx, "mode-selector-trigger");
    assert_eq!(view.read_with(cx, |v, _| v.open()), Some(Popup::Mode));
    assert!(drawn(cx, "mode-selector-menu"));
    for m in [
        "default",
        "acceptEdits",
        "plan",
        "auto",
        "dontAsk",
        "bypassPermissions",
    ] {
        let sel: &'static str = Box::leak(format!("mode-selector-option-{m}").into_boxed_str());
        assert!(drawn(cx, sel), "{m} is listed");
    }

    click(cx, "mode-selector-option-plan");
    assert_eq!(posted(&chat, "mode"), vec![json!({ "mode": "plan" })]);
    assert!(!drawn(cx, "mode-selector-menu"), "the menu closes");
    assert_eq!(view.read_with(cx, |v, _| v.open()), None);
    assert_eq!(
        model(&view, cx).mode.meta.mode,
        "plan",
        "the trigger shows it"
    );

    // The server's `mode_changed` is what the trigger follows.
    chat.event(json!({ "type": "mode_changed", "mode": "acceptEdits" }));
    settle(cx);
    assert_eq!(model(&view, cx).mode.meta.mode, "acceptEdits");
}

#[gpui::test]
fn a_disabled_mode_is_not_listed_and_cannot_be_picked() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    chat.reply(
        &picker::settings_url(Some("/work")).unwrap(),
        200,
        json!({ "settings": { "disableAutoMode": "disable" } }),
    );
    chat.update(|s| s.cwd = json!("/work"));
    let (view, cx) = open(&mut app, &chat, 1200.);
    assert!(view.read_with(cx, |v, _| v.settings().auto_mode_disabled));

    click(cx, "mode-selector-trigger");
    assert!(drawn(cx, "mode-selector-option-plan"));
    assert!(
        !drawn(cx, "mode-selector-option-auto"),
        "auto is not listed"
    );

    view.update(cx, |v, cx| v.pick_mode("auto", cx));
    settle(cx);
    assert!(posted(&chat, "mode").is_empty(), "auto can't be picked");
    assert_eq!(view.read_with(cx, |v, _| v.open()), Some(Popup::Mode));

    // Shift+Tab's cycle skips it: acceptEdits → plan.
    chat.event(json!({ "type": "mode_changed", "mode": "acceptEdits" }));
    settle(cx);
    view.update(cx, |v, cx| v.cycle_mode(cx));
    settle(cx);
    assert_eq!(posted(&chat, "mode"), vec![json!({ "mode": "plan" })]);
}

#[gpui::test]
fn without_the_setting_auto_is_listed() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    chat.update(|s| s.cwd = json!("/work"));
    let (_view, cx) = open(&mut app, &chat, 1200.);
    click(cx, "mode-selector-trigger");
    assert!(drawn(cx, "mode-selector-option-auto"));
    assert_eq!(
        chat.fetched(),
        vec![picker::settings_url(Some("/work")).unwrap()],
        "the settings are read once for the cwd"
    );
}

#[gpui::test]
fn the_working_label_and_elapsed_follow_a_running_turn() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    let (view, cx) = open(&mut app, &chat, 1200.);
    assert!(drawn(cx, "status-line-dot-idle"));
    assert!(!drawn(cx, "status-line-dot-halo"), "idle: no pulse");
    assert_eq!(model(&view, cx).label, "Idle");
    assert!(!drawn(cx, "status-line-elapsed"));
    assert!(!view.read_with(cx, |v, _| v.ticking()));

    turn(&chat, "running");
    now(&view, cx, T0 + 12_000.);
    assert!(drawn(cx, "status-line-dot-working"));
    assert!(drawn(cx, "status-line-dot-halo"), "busy: the pulse's halo");
    let m = model(&view, cx);
    assert_eq!((m.status, m.label.as_str()), (Status::Working, "Working"));
    assert_eq!(m.elapsed.as_deref(), Some("12s"));
    assert!(drawn(cx, "status-line-elapsed"));

    // The one-second tick runs while the timer shows.
    assert!(view.read_with(cx, |v, _| v.ticking()));
    let before = view.read_with(cx, |v, _| v.ticks());
    advance(cx, 3_000);
    assert!(view.read_with(cx, |v, _| v.ticks()) >= before + 3);

    now(&view, cx, T0 + 45_000.);
    let m = model(&view, cx);
    assert_eq!(m.label, "Deep in thought");
    assert_eq!(m.elapsed.as_deref(), Some("45s"));

    now(&view, cx, T0 + 125_000.);
    assert_eq!(model(&view, cx).elapsed.as_deref(), Some("2m 5s"));

    turn(&chat, "idle");
    settle(cx);
    let m = model(&view, cx);
    assert_eq!((m.status, m.label.as_str()), (Status::Idle, "Idle"));
    assert!(m.elapsed.is_none());
    assert!(!drawn(cx, "status-line-elapsed"));
    assert!(drawn(cx, "status-line-done"), "the last turn's end shows");
    assert!(!view.read_with(cx, |v, _| v.ticking()), "the tick stops");
}

#[gpui::test]
fn a_narrow_line_hides_the_mode_label_and_the_elapsed_time() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    turn(&chat, "running");
    let (view, cx) = open(&mut app, &chat, 600.);
    now(&view, cx, T0 + 5_000.);
    assert!(!view.read_with(cx, |v, _| v.wide()));
    assert!(drawn(cx, "mode-selector-trigger"));
    assert!(!drawn(cx, "mode-selector-label"));
    assert!(!drawn(cx, "status-line-elapsed"));
    assert_eq!(model(&view, cx).elapsed.as_deref(), Some("5s"));
}

#[gpui::test]
fn the_context_meter_reads_the_poll() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    let url = picker::context_url("s1");
    chat.reply(&url, 200, json!({ "percentage": 80.4 }));
    let (view, cx) = open(&mut app, &chat, 1200.);
    assert!(
        !drawn(cx, "status-line-context"),
        "nothing before the first poll"
    );

    advance(cx, picker::CONTEXT_FIRST_POLL_MS);
    let ctx = model(&view, cx).context.expect("a reading");
    assert_eq!((ctx.text.as_str(), ctx.level), ("80%", CtxLevel::Warn));
    assert!(drawn(cx, "status-line-context"));

    chat.reply(&url, 200, json!({ "percentage": 95 }));
    advance(cx, picker::context_poll_delay_ms(false));
    let ctx = model(&view, cx).context.expect("a reading");
    assert_eq!((ctx.text.as_str(), ctx.level), ("95%", CtxLevel::Danger));

    // A failed poll keeps the reading.
    chat.reply(&url, 500, json!({}));
    advance(cx, picker::context_poll_delay_ms(false));
    assert_eq!(
        model(&view, cx).context.map(|c| c.level),
        Some(CtxLevel::Danger)
    );

    // A running turn polls every 8 s.
    chat.reply(&url, 200, json!({ "percentage": 10 }));
    turn(&chat, "running");
    advance(cx, picker::CONTEXT_FIRST_POLL_MS);
    assert_eq!(
        model(&view, cx).context.map(|c| c.level),
        Some(CtxLevel::Ok)
    );
    let polls = chat.fetched().iter().filter(|u| **u == url).count();
    advance(cx, picker::context_poll_delay_ms(true));
    assert_eq!(
        chat.fetched().iter().filter(|u| **u == url).count(),
        polls + 1
    );
}

#[gpui::test]
fn the_cost_meter_shows_the_cost_and_the_output_tokens() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    let (view, cx) = open(&mut app, &chat, 1200.);
    assert!(model(&view, cx).cost.is_none());
    assert!(!drawn(cx, "status-line-cost"), "no cost yet");

    chat.update(|s| s.usage = json!({ "totalCostUsd": 0.1234, "outputTokens": 12_345 }));
    settle(cx);
    let cost = model(&view, cx).cost.expect("a cost");
    assert_eq!(cost.cost, "$0.123");
    assert_eq!(cost.tokens.as_deref(), Some("12.3K tok"));
    assert!(drawn(cx, "status-line-cost"));

    chat.update(|s| s.usage = json!({ "totalCostUsd": 0.0042, "outputTokens": 999 }));
    settle(cx);
    let cost = model(&view, cx).cost.expect("a cost");
    assert_eq!(
        (cost.cost.as_str(), cost.tokens.as_deref()),
        ("$0.0042", Some("999 tok"))
    );
}

#[gpui::test]
fn the_reconnecting_badge_shows_while_the_stream_is_down() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    let (view, cx) = open(&mut app, &chat, 1200.);
    assert!(!drawn(cx, "status-line-stream"));

    chat.update(|s| s.stream_status = "reconnecting");
    settle(cx);
    assert!(drawn(cx, "status-line-stream"));
    assert_eq!(
        model(&view, cx).reconnecting,
        Some(claudius_status::line::RECONNECTING_TITLE)
    );

    chat.update(|s| s.stream_status = "live");
    settle(cx);
    assert!(!drawn(cx, "status-line-stream"));
}

fn models_reply() -> Value {
    json!({ "models": [
        {
            "value": "opus",
            "displayName": "Opus",
            "description": "The most capable",
            "supportsEffort": true,
            "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
            "supportsFastMode": true,
        },
        { "value": "sonnet", "displayName": "Sonnet", "description": "Fast and capable" },
    ] })
}

#[gpui::test]
fn picking_a_model_an_effort_and_fast_mode() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    chat.update(|s| s.model = json!("opus"));
    chat.reply(
        &picker::models_url(Some("s1")).unwrap(),
        200,
        models_reply(),
    );
    let (view, cx) = open(&mut app, &chat, 1200.);
    assert_eq!(model(&view, cx).model.map(|m| m.model), Some("opus".into()));

    // The effort chip: posts the level with the ultracode state, closes.
    click(cx, "status-line-model");
    assert!(drawn(cx, "model-picker-panel"));
    assert!(
        matches!(view.read_with(cx, |v, _| v.models().clone()), ModelList::Loaded(l) if l.len() == 2)
    );
    for t in [
        "adaptive",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultracode",
    ] {
        let sel: &'static str = Box::leak(format!("model-picker-effort-{t}").into_boxed_str());
        assert!(drawn(cx, sel), "the {t} chip");
    }
    click(cx, "model-picker-effort-high");
    assert_eq!(
        posted(&chat, "effort"),
        vec![json!({ "level": "high", "ultracode": false })]
    );
    assert!(!drawn(cx, "model-picker-panel"), "an effort pick closes it");

    // Fast mode: toggles on, closes.
    click(cx, "status-line-model");
    click(cx, "model-picker-fast-off");
    assert_eq!(posted(&chat, "fast"), vec![json!({ "enabled": true })]);
    assert!(!drawn(cx, "model-picker-panel"));
    click(cx, "status-line-model");
    assert!(drawn(cx, "model-picker-fast-on"), "the toggle shows it on");

    // Ultracode's row toggles it.
    click(cx, "model-picker-ultracode-off");
    assert_eq!(posted(&chat, "ultracode"), vec![json!({ "enabled": true })]);

    // A model: posts it from the picker, and the panel stays open.
    click(cx, "status-line-model");
    click(cx, "model-picker-option-sonnet");
    assert_eq!(
        posted(&chat, "model"),
        vec![json!({ "model": "sonnet", "source": "picker" })]
    );
    assert!(
        drawn(cx, "model-picker-panel"),
        "a model pick keeps it open"
    );
    assert_eq!(
        model(&view, cx).model.map(|m| m.model),
        Some("sonnet".into())
    );
    assert!(
        !drawn(cx, "model-picker-effort-high"),
        "sonnet has no effort"
    );

    // The list loads on each open.
    let url = picker::models_url(Some("s1")).unwrap();
    assert_eq!(chat.fetched().iter().filter(|u| **u == url).count(), 4);
}

#[gpui::test]
fn the_model_picker_shows_a_failed_load() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    chat.update(|s| s.model = json!("opus"));
    chat.reply(
        &picker::models_url(Some("s1")).unwrap(),
        503,
        json!({ "error": "session not running" }),
    );
    let (view, cx) = open(&mut app, &chat, 1200.);
    click(cx, "status-line-model");
    assert!(drawn(cx, "model-picker-error"));
    assert_eq!(
        view.read_with(cx, |v, _| v.models().clone()),
        ModelList::Failed("session not running".into())
    );
    view.update(cx, |v, cx| v.pick(Pick::Fast(true), cx));
    assert_eq!(posted(&chat, "fast"), vec![json!({ "enabled": true })]);
}

#[gpui::test]
fn a_deprecated_model_shows_its_warning_chip() {
    let mut app = app();
    let chat = FixtureStatus::new("s1");
    chat.update(|s| s.model = json!("claude-3-opus-20240229"));
    let (view, cx) = open(&mut app, &chat, 1200.);
    assert!(drawn(cx, "status-line-model-deprecated"));
    assert!(!drawn(cx, "status-line-model"));
    assert!(model(&view, cx).model.unwrap().deprecated);
}

#[gpui::test]
fn no_chat_draws_nothing() {
    let mut app = app();
    let chat = FixtureStatus::with_state(None);
    let (view, cx) = open(&mut app, &chat, 1200.);
    assert!(!drawn(cx, "status-line"));
    assert!(view.read_with(cx, |v, _| v.model().is_none()));
}
