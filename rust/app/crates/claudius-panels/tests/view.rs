//! The rail and the goal banner in a headless GPUI window
//! (`TestAppContext`, CoreText for real glyph widths) over a
//! [`FixtureRail`], beside the status line whose model picker the session
//! card opens: the to-dos follow `TodoWrite`, a todo's checkbox and the
//! eraser call their actions, the add form sends the append prompt (and
//! keeps its error), a running task's and a shell's timers tick and their
//! stops POST, a loop cancels, the plan usage bars, the goal banner shows,
//! hides (its stored setting too), edits and clears. macOS (the CoreText
//! text system).

#![cfg(target_os = "macos")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_client::state::{ChatState, GoalState};
use claudius_gpui_theme::ThemeName;
use claudius_panels::goal::Banner;
use claudius_panels::rail::Prefs;
use claudius_panels::usage::PlanCard;
use claudius_panels::{FixtureRail, GoalBannerView, RailEvent, RailPanel, RailTarget};
use claudius_status::view::Popup;
use claudius_status::{FixtureStatus, StatusLineView, StatusTarget};
use gpui::{
    AppContext as _, Context, Entity, IntoElement, Modifiers, ParentElement as _, Render,
    Styled as _, TestAppContext, TestDispatcher, VisualTestContext, Window, div, px, size,
};
use gpui_apple::AppleTextSystem;
use serde_json::{Value, json};

/// The fixture's clock.
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

/// The status line over the chat, the goal row and the rail beside it.
struct Host {
    status: Entity<StatusLineView>,
    goal: Entity<GoalBannerView>,
    rail: Entity<RailPanel>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(self.status.clone())
                    .child(self.goal.clone()),
            )
            .child(self.rail.clone())
    }
}

struct Opened<'a> {
    rail: Entity<RailPanel>,
    goal: Entity<GoalBannerView>,
    status: Entity<StatusLineView>,
    events: Arc<Mutex<Vec<RailEvent>>>,
    /// The rail's `cx.notify()`s (each asks for a redraw).
    notifies: Arc<AtomicUsize>,
    cx: &'a mut VisualTestContext,
}

fn open<'a>(app: &'a mut TestAppContext, chat: &Arc<FixtureRail>, prefs: Prefs) -> Opened<'a> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    let notifies = Arc::new(AtomicUsize::new(0));
    let n = notifies.clone();
    let target: Arc<dyn RailTarget> = chat.clone();
    let status_target: Arc<dyn StatusTarget> = chat.clone();
    let goal_pref = prefs.get(claudius_panels::goal::GOAL_HIDDEN_KEY).cloned();
    let (host, cx) = app.add_window_view(move |_, cx| {
        let status = cx.new(|cx| StatusLineView::new(status_target, ThemeName::Dark, cx));
        let rail = cx.new(|cx| {
            let mut r = RailPanel::new(
                target.clone(),
                Some(status.clone()),
                ThemeName::Dark,
                prefs,
                cx,
            );
            r.set_now(T0, cx);
            r
        });
        let goal =
            cx.new(|cx| GoalBannerView::new(target, ThemeName::Dark, goal_pref.as_deref(), cx));
        let (e1, e2) = (ev.clone(), ev.clone());
        cx.subscribe(&rail, move |_, _, e: &RailEvent, _| {
            e1.lock().unwrap().push(e.clone())
        })
        .detach();
        cx.subscribe(&goal, move |_, _, e: &RailEvent, _| {
            e2.lock().unwrap().push(e.clone())
        })
        .detach();
        cx.observe(&rail, move |_, _, _| {
            n.fetch_add(1, Ordering::SeqCst);
        })
        .detach();
        Host { status, goal, rail }
    });
    cx.simulate_resize(size(px(1280.), px(900.)));
    settle(cx);
    let (rail, goal, status) = host.read_with(cx, |h, _| {
        (h.rail.clone(), h.goal.clone(), h.status.clone())
    });
    Opened {
        rail,
        goal,
        status,
        events,
        notifies,
        cx,
    }
}

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

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn drawn(cx: &mut VisualTestContext, selector: &str) -> bool {
    cx.debug_bounds(leak(selector.to_owned())).is_some()
}

fn click(cx: &mut VisualTestContext, selector: &str) {
    let b = cx
        .debug_bounds(leak(selector.to_owned()))
        .unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(b.center(), Modifiers::default());
    settle(cx);
}

fn advance(cx: &mut VisualTestContext, ms: u64) {
    cx.executor().advance_clock(Duration::from_millis(ms));
    settle(cx);
}

/// A chat bound to `s1`, ready, idle.
fn chat() -> Arc<FixtureRail> {
    FixtureRail::new(FixtureStatus::new("s1"))
}

fn update(chat: &FixtureRail, f: impl FnOnce(&mut ChatState)) {
    chat.status.update(f);
}

fn body(b: &Option<String>) -> Value {
    serde_json::from_str(b.as_deref().expect("a body")).unwrap()
}

/// The chat actions' POSTs to `/api/sessions/s1/<what>`, their bodies.
fn posted(chat: &FixtureRail, what: &str) -> Vec<Value> {
    let url = format!("POST /api/sessions/s1/{what}");
    chat.status
        .posts()
        .iter()
        .filter(|(u, _)| *u == url)
        .map(|(_, b)| {
            b.as_deref()
                .map_or(Value::Null, |b| serde_json::from_str(b).unwrap())
        })
        .collect()
}

/// The rail's own POSTs to `/api/sessions/s1/<what>`.
fn requested(chat: &FixtureRail, what: &str) -> Vec<Value> {
    let url = format!("POST /api/sessions/s1/{what}");
    chat.requests()
        .iter()
        .filter(|(u, _)| *u == url)
        .map(|(_, b)| body(b))
        .collect()
}

fn todo_write(chat: &FixtureRail, todos: Value) {
    chat.status.event(json!({
        "type": "sdk",
        "at": 5,
        "message": {
            "type": "assistant",
            "uuid": "a-todo",
            "message": {
                "id": "m-todo",
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": "toolu_todo", "name": "TodoWrite", "input": { "todos": todos } }]
            }
        }
    }));
}

fn three_todos() -> Value {
    json!([
        { "content": "Port the rail", "status": "completed", "activeForm": "Porting the rail" },
        { "content": "Write the tests", "status": "in_progress", "activeForm": "Writing the tests" },
        { "content": "Take the screenshots", "status": "pending", "activeForm": "Taking the screenshots" }
    ])
}

fn model(o: &mut Opened<'_>) -> claudius_panels::rail::RailModel {
    o.rail
        .read_with(o.cx, |r, _| r.model().cloned().expect("a chat"))
}

#[gpui::test]
fn todos_follow_todo_write() {
    let mut app = app();
    let chat = chat();
    let mut o = open(&mut app, &chat, Prefs::new());
    assert!(drawn(o.cx, "right-rail"));
    assert!(drawn(o.cx, "todos-empty"), "no todos: the empty line");
    assert_eq!(model(&mut o).todos.badge.as_deref(), Some("(0)"));

    todo_write(&chat, three_todos());
    settle(o.cx);
    assert!(!drawn(o.cx, "todos-empty"));
    for sel in [
        "rail-todo-completed-t0",
        "rail-todo-in_progress-t1",
        "rail-todo-pending-t2",
    ] {
        assert!(drawn(o.cx, sel), "{sel}");
    }
    let m = model(&mut o);
    assert_eq!(m.todos.badge.as_deref(), Some("(3)"));
    let texts: Vec<_> = m.todos.body.rows.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(
        texts,
        ["Port the rail", "Writing the tests", "Take the screenshots"]
    );
    assert!(drawn(o.cx, "todos-clear-button"), "something to clear");

    // A later TodoWrite replaces the list.
    todo_write(
        &chat,
        json!([{ "content": "Only this", "status": "pending" }]),
    );
    settle(o.cx);
    assert!(drawn(o.cx, "rail-todo-pending-t0"));
    assert!(!drawn(o.cx, "rail-todo-pending-t2"));
    assert_eq!(model(&mut o).todos.badge.as_deref(), Some("(1)"));
}

#[gpui::test]
fn a_todos_checkbox_and_the_eraser_call_their_actions() {
    let mut app = app();
    let chat = chat();
    todo_write(&chat, three_todos());
    let o = open(&mut app, &chat, Prefs::new());

    click(o.cx, "rail-todo-toggle-t2");
    assert_eq!(
        posted(&chat, "todos/t2"),
        vec![json!({ "action": "complete" })]
    );
    click(o.cx, "rail-todo-toggle-t0");
    assert_eq!(
        posted(&chat, "todos/t0"),
        vec![json!({ "action": "reopen" })]
    );
    o.rail.update(o.cx, |r, _| r.delete_todo("t1"));
    assert_eq!(
        posted(&chat, "todos/t1"),
        vec![json!({ "action": "delete" })]
    );

    click(o.cx, "todos-clear-button");
    assert_eq!(posted(&chat, "clear-todos").len(), 1);
}

#[gpui::test]
fn adding_todos_sends_the_append_prompt_then_closes() {
    let mut app = app();
    let chat = chat();
    let o = open(&mut app, &chat, Prefs::new());
    let rail = o.rail.clone();

    click(o.cx, "todos-add-button");
    assert!(drawn(o.cx, "add-todos-form"));
    assert!(
        !drawn(o.cx, "todos-empty"),
        "the form replaces the empty line"
    );
    // Nothing typed: Add says so.
    rail.update(o.cx, |r, cx| r.submit_add(cx));
    settle(o.cx);
    assert!(drawn(o.cx, "add-todos-error"));
    assert!(chat.held().is_empty());

    o.cx.update(|w, cx| rail.update(cx, |r, cx| r.set_add_row(0, "  Write tests ", w, cx)));
    click(o.cx, "add-todo-another");
    assert!(drawn(o.cx, "add-todo-input-1"));
    o.cx.update(|w, cx| rail.update(cx, |r, cx| r.set_add_row(1, "Ship", w, cx)));
    settle(o.cx);
    click(o.cx, "add-todos-submit");
    let held = chat.held();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].0, "send");
    assert_eq!(
        held[0].1,
        "Use the TodoWrite tool to APPEND these item(s) to your current todo list.\n\
         Preserve every existing item unchanged. New items have status `pending`.\n\
         Do not run any other tool and do not write any text in your reply.\n\
         \n\
         Items to add:\n\
         - Write tests\n\
         - Ship"
    );
    assert!(rail.read_with(o.cx, |r, _| r.add_form().is_some_and(|f| f.submitting)));

    // Not delivered: the form stays, with the error.
    chat.answer(json!({ "ok": false, "error": "no active session" }));
    settle(o.cx);
    assert!(drawn(o.cx, "add-todos-form"));
    assert_eq!(
        rail.read_with(o.cx, |r, _| r.add_form().and_then(|f| f.error.clone())),
        Some("couldn't add todos: no active session".into())
    );

    // Sent: the form closes.
    click(o.cx, "add-todos-submit");
    chat.answer(json!({ "ok": true }));
    settle(o.cx);
    assert!(!drawn(o.cx, "add-todos-form"));
    assert!(drawn(o.cx, "todos-empty"));
}

fn task(id: &str, status: &str, extra: Value) -> claudius_client::task_status::TaskInfo {
    let mut v = json!({ "taskId": id, "description": format!("desc {id}"), "status": status });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn running_work(s: &mut ChatState) {
    s.tasks.insert(
        "a1".into(),
        task(
            "a1",
            "running",
            json!({ "taskType": "local_agent", "startedAt": T0 - 5000.0, "toolUseId": "tu_a1" }),
        ),
    );
    s.tasks.insert(
        "b1".into(),
        task(
            "b1",
            "running",
            json!({ "taskType": "local_bash", "toolUseId": "tb1" }),
        ),
    );
    s.background_bashes.insert(
        "tb1".into(),
        serde_json::from_value(
            json!({ "toolUseId": "tb1", "command": "bun run dev", "startedAt": T0 - 65_000.0 }),
        )
        .unwrap(),
    );
}

#[gpui::test]
fn a_running_task_and_a_shell_tick_and_stop() {
    let mut app = app();
    let chat = chat();
    update(&chat, running_work);
    let mut o = open(&mut app, &chat, Prefs::new());
    assert!(drawn(o.cx, "task-row-a1"));
    assert!(drawn(o.cx, "bash-row-tb1"));
    let m = model(&mut o);
    assert_eq!(
        m.tasks.as_ref().unwrap().body[0].elapsed.as_deref(),
        Some("5s")
    );
    assert_eq!(m.running.as_ref().unwrap().body.bashes[0].right, "1m 5s");
    assert_eq!(m.header.running.as_ref().map(|r| r.count), Some(2));
    assert!(drawn(o.cx, "activity-running-cue"));

    // The 1 Hz clock.
    assert!(o.rail.read_with(o.cx, |r, _| r.ticking()));
    advance(o.cx, 1000);
    let m = model(&mut o);
    assert_eq!(
        m.tasks.as_ref().unwrap().body[0].elapsed.as_deref(),
        Some("6s")
    );
    assert_eq!(m.running.as_ref().unwrap().body.bashes[0].right, "1m 6s");

    click(o.cx, "task-stop-a1");
    assert_eq!(
        requested(&chat, "stop-task"),
        vec![json!({ "taskId": "a1" })]
    );
    // The shell stops through its task.
    click(o.cx, "bash-stop-tb1");
    assert_eq!(
        requested(&chat, "stop-task"),
        vec![json!({ "taskId": "a1" }), json!({ "taskId": "b1" })]
    );

    // Stop all asks first.
    click(o.cx, "stop-all-tasks");
    assert!(drawn(o.cx, "stop-all-confirm"));
    click(o.cx, "stop-all-no");
    assert!(!drawn(o.cx, "stop-all-confirm"));
    assert_eq!(requested(&chat, "stop-task").len(), 2);
    click(o.cx, "stop-all-tasks");
    click(o.cx, "stop-all-yes");
    let ids: Vec<Value> = requested(&chat, "stop-task")[2..].to_vec();
    assert_eq!(
        ids,
        vec![json!({ "taskId": "a1" }), json!({ "taskId": "b1" })]
    );

    // The shell's command opens its viewer (a seam).
    click(o.cx, "bash-command-tb1");
    assert!(
        o.events
            .lock()
            .unwrap()
            .contains(&RailEvent::OpenBash("tb1".into()))
    );

    // The task ends: it leaves Tasks and lands in Earlier; the shell goes.
    update(&chat, |s| {
        s.tasks.get_mut("a1").unwrap().status = "completed".into();
        s.tasks.get_mut("b1").unwrap().status = "completed".into();
    });
    settle(o.cx);
    assert!(!drawn(o.cx, "task-row-a1"));
    assert!(!drawn(o.cx, "bash-row-tb1"));
    assert!(drawn(o.cx, "earlier-subagent-row-a1"));
    assert!(drawn(o.cx, "earlier-subagent-open-a1"));
    assert!(
        !drawn(o.cx, "earlier-subagent-message-a1"),
        "Message needs the host"
    );
}

fn a_loop(id: &str, kind: &str) -> claudius_client::loops::ScheduledLoop {
    serde_json::from_value(json!({
        "kind": kind, "id": id, "toolUseId": format!("tu_{id}"), "cron": "*/5 * * * *",
        "humanSchedule": "Every 5 minutes", "delaySeconds": null, "prompt": "check the build",
        "recurring": true, "durable": false, "startedAt": T0 - 120_000.0,
    }))
    .unwrap()
}

#[gpui::test]
fn a_loop_cancels() {
    let mut app = app();
    let chat = chat();
    update(&chat, |s| {
        s.scheduled_loops.insert("c1".into(), a_loop("c1", "cron"));
    });
    let mut o = open(&mut app, &chat, Prefs::new());
    assert!(drawn(o.cx, "scheduled-loop-c1"));
    assert_eq!(
        model(&mut o).loops.as_ref().unwrap().badge.as_deref(),
        Some("(1)")
    );

    click(o.cx, "scheduled-loop-cancel-c1");
    let held = chat.held();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].0, "send");
    assert!(
        held[0].1.contains("CronDelete") && held[0].1.contains("c1"),
        "{}",
        held[0].1
    );
    // Cancelling at once: muted, no ×.
    assert!(!drawn(o.cx, "scheduled-loop-cancel-c1"));
    assert!(drawn(o.cx, "scheduled-loop-cancelled-c1"));
    assert_eq!(
        model(&mut o).loops.as_ref().unwrap().body[0].state,
        Some("cancelling\u{2026}")
    );
    // A second click can't send twice.
    o.rail.update(o.cx, |r, cx| r.cancel_loop("c1", cx));
    assert_eq!(chat.held().len(), 1);

    // The agent ran CronDelete.
    update(&chat, |s| {
        s.scheduled_loops.get_mut("c1").unwrap().cancelled = Some(true)
    });
    settle(o.cx);
    let m = model(&mut o);
    assert_eq!(m.loops.as_ref().unwrap().body[0].state, Some("cancelled"));
    assert_eq!(m.loops.as_ref().unwrap().badge.as_deref(), Some("(1)"));
}

fn plan(s: &mut ChatState) {
    s.plan_usage = json!({
        "subscriptionType": "max",
        "rateLimitsAvailable": true,
        "rateLimits": {
            "fiveHour": { "utilization": 12, "resetsAt": "2026-11-27T10:00:00.000Z" },
            "sevenDay": { "utilization": 81, "resetsAt": "2026-11-30T09:00:00.000Z" }
        }
    });
    s.model = json!("claude-opus-4-5");
}

#[gpui::test]
fn the_plan_usage_bars() {
    let mut app = app();
    let chat = chat();
    update(&chat, plan);
    let mut o = open(&mut app, &chat, Prefs::new());
    assert!(drawn(o.cx, "plan-usage-card"));
    for key in ["fiveHour", "sevenDay"] {
        let row =
            o.cx.debug_bounds(leak(format!("plan-usage-window-{key}")))
                .unwrap();
        let bar =
            o.cx.debug_bounds(leak(format!("plan-usage-bar-{key}")))
                .unwrap();
        let ratio = f32::from(bar.size.width) / f32::from(row.size.width);
        let want = if key == "fiveHour" { 0.12 } else { 0.81 };
        assert!((ratio - want).abs() < 0.02, "{key}: {ratio}");
    }
    let Some(PlanCard::Open {
        worst,
        rows,
        sonnet,
        threshold,
        ..
    }) = model(&mut o).plan
    else {
        panic!("the open card");
    };
    assert_eq!(worst.as_str(), "warning", "81% is past the 50% threshold");
    assert_eq!(rows[1].value, "81% used");
    assert!(
        rows[0]
            .reset
            .as_ref()
            .is_some_and(|(at, cd)| at == "resets Fri 10:00 AM" && cd.is_some())
    );
    assert!(sonnet && threshold);

    // "/model sonnet".
    click(o.cx, "plan-usage-sonnet");
    assert_eq!(posted(&chat, "model").len(), 1);

    // Minimize: one line, remembered.
    click(o.cx, "plan-usage-minimize");
    assert!(matches!(
        model(&mut o).plan,
        Some(PlanCard::Collapsed { .. })
    ));
    assert!(drawn(o.cx, "plan-usage-mini-window-fiveHour"));
    assert!(!drawn(o.cx, "plan-usage-window-fiveHour"));
    assert!(o.events.lock().unwrap().contains(&RailEvent::Pref {
        key: "claudius.activity.plan-usage.collapsed".into(),
        value: "1".into()
    }));
    click(o.cx, "plan-usage-card");
    assert!(drawn(o.cx, "plan-usage-window-fiveHour"));

    // A higher threshold calms it.
    let mut prefs = Prefs::new();
    prefs.insert("claudius.rateLimitWarningPct".into(), "90".into());
    let mut app2 = self::app();
    let mut o2 = open(&mut app2, &chat, prefs);
    let Some(PlanCard::Open { worst, sonnet, .. }) = model(&mut o2).plan else {
        panic!("the open card");
    };
    assert_eq!(worst.as_str(), "ok");
    assert!(!sonnet);
}

#[gpui::test]
fn sections_collapse_and_remember() {
    let mut app = app();
    let chat = chat();
    let mut o = open(&mut app, &chat, Prefs::new());
    assert!(drawn(o.cx, "tools-empty"));
    click(o.cx, "activity-section-toggle-tools");
    assert!(!drawn(o.cx, "tools-empty"));
    assert!(model(&mut o).tools.collapsed);
    assert_eq!(
        o.events.lock().unwrap().last(),
        Some(&RailEvent::Pref {
            key: "claudius.activity.tools.collapsed".into(),
            value: "1".into()
        })
    );
    // Again: open, and remembered open.
    click(o.cx, "activity-section-toggle-tools");
    assert!(drawn(o.cx, "tools-empty"));
    assert!(!model(&mut o).tools.collapsed);
    assert_eq!(
        o.events.lock().unwrap().last(),
        Some(&RailEvent::Pref {
            key: "claudius.activity.tools.collapsed".into(),
            value: "0".into()
        })
    );
    // A stored "1" starts collapsed.
    let mut prefs = Prefs::new();
    prefs.insert("claudius.activity.todos.collapsed".into(), "1".into());
    let mut app2 = self::app();
    let o2 = open(&mut app2, &chat, prefs);
    assert!(!drawn(o2.cx, "todos-empty"));
    assert!(drawn(o2.cx, "activity-section-todos"));
}

#[gpui::test]
fn the_card_opens_the_status_lines_model_picker() {
    let mut app = app();
    let chat = chat();
    update(&chat, |s| {
        s.model = json!("claude-opus-4-5");
        s.cwd = json!("/Users/demo/projects/claudius/rust/app");
    });
    let mut o = open(&mut app, &chat, Prefs::new());
    assert_eq!(model(&mut o).card.model, "Opus 4.5");
    assert!(drawn(o.cx, "session-card-cwd"));
    click(o.cx, "model-picker-trigger");
    assert_eq!(
        o.status.read_with(o.cx, |s, _| s.open()),
        Some(Popup::Model)
    );
    // Again: closed (the press outside the popover closes it, the click
    // doesn't reopen it).
    click(o.cx, "model-picker-trigger");
    assert_eq!(o.status.read_with(o.cx, |s, _| s.open()), None);
}

#[gpui::test]
fn the_rail_redraws_only_when_what_it_shows_changes() {
    let mut app = app();
    let chat = chat();
    let o = open(&mut app, &chat, Prefs::new());
    let before = o.notifies.load(Ordering::SeqCst);
    // Something the rail doesn't show.
    update(&chat, |s| s.session_title = json!("A new title"));
    settle(o.cx);
    assert_eq!(o.notifies.load(Ordering::SeqCst), before);
    todo_write(&chat, three_todos());
    settle(o.cx);
    assert_eq!(o.notifies.load(Ordering::SeqCst), before + 1);
    // A tick: the card's session timer moved, one redraw.
    advance(o.cx, 1000);
    assert_eq!(o.rail.read_with(o.cx, |r, _| r.ticks()), 1);
    assert_eq!(o.notifies.load(Ordering::SeqCst), before + 2);
}

/// The rail alone (no status line to follow): it reads the chat's change
/// feed itself. And the width the shell sizes its cached box with.
#[gpui::test]
fn a_rail_without_a_status_line_follows_the_chat_itself() {
    let mut app = app();
    let chat = chat();
    let target: Arc<dyn RailTarget> = chat.clone();
    let (rail, cx) = app.add_window_view(move |_, cx| {
        let mut r = RailPanel::new(target, None, ThemeName::Dark, Prefs::new(), cx);
        r.set_now(T0, cx);
        r
    });
    cx.simulate_resize(size(px(1280.), px(900.)));
    settle(cx);
    assert!(drawn(cx, "todos-empty"));
    todo_write(&chat, three_todos());
    settle(cx);
    let rows = rail.read_with(cx, |r, _| r.model().unwrap().todos.body.rows.len());
    assert_eq!(rows, 3);
    assert!(!drawn(cx, "todos-empty"));

    // `w-64 lg:w-72`.
    assert_eq!(rail.read_with(cx, |r, _| r.width()), 288.);
    rail.update(cx, |r, _| r.set_viewport_width(1023.));
    assert_eq!(rail.read_with(cx, |r, _| r.width()), 256.);
    rail.update(cx, |r, _| r.set_viewport_width(1024.));
    assert_eq!(rail.read_with(cx, |r, _| r.width()), 288.);
}

#[gpui::test]
fn the_goal_banner_shows_hides_edits_and_clears() {
    let mut app = app();
    let chat = chat();
    let o = open(&mut app, &chat, Prefs::new());
    let goal = o.goal.clone();
    assert!(drawn(o.cx, "goal-banner-empty"));
    assert!(drawn(o.cx, "session-header"));

    // The ×: hidden, and remembered.
    click(o.cx, "goal-banner-hide");
    assert!(!drawn(o.cx, "goal-banner-empty"));
    assert!(!drawn(o.cx, "session-header"));
    assert!(o.events.lock().unwrap().contains(&RailEvent::Pref {
        key: "claudius.goalBannerHidden".into(),
        value: "1".into()
    }));
    goal.update(o.cx, |g, cx| g.set_hidden(false, cx));
    settle(o.cx);
    assert!(drawn(o.cx, "goal-banner-empty"));
    // Shown again: the setting cleared (`removeItem`, a "0" here).
    assert_eq!(
        o.events.lock().unwrap().last(),
        Some(&RailEvent::Pref {
            key: "claudius.goalBannerHidden".into(),
            value: "0".into()
        })
    );

    // Set a goal: setGoal, then the opening prompt.
    click(o.cx, "goal-banner-set");
    assert!(drawn(o.cx, "goal-banner-editor"));
    o.cx.update(|w, cx| goal.update(cx, |g, cx| g.set_draft("  Ship the rail  ", w, cx)));
    goal.update(o.cx, |g, cx| g.submit(cx));
    settle(o.cx);
    assert_eq!(chat.held(), vec![("setGoal", "Ship the rail".to_owned())]);
    assert!(drawn(o.cx, "goal-banner"), "the goal shows at once");
    assert_eq!(posted(&chat, "goal").len(), 1);
    chat.answer(json!({ "ok": true }));
    settle(o.cx);
    assert_eq!(chat.held(), vec![("send", "Ship the rail".to_owned())]);
    assert!(chat.held_opts().is_some_and(|o| o.from_goal));

    // Achieved: the summary.
    update(&chat, |s| {
        s.goal = Some(GoalState {
            text: json!("Ship the rail"),
            achieved: true,
            summary: json!("Shipped with screenshots"),
            set_at: json!(T0),
            achieved_at: json!(T0),
        })
    });
    settle(o.cx);
    assert!(drawn(o.cx, "goal-banner-achieved"));
    assert!(drawn(o.cx, "goal-banner-summary"));
    let edit = goal.read_with(o.cx, |g, _| g.banner().cloned());
    assert!(matches!(
        edit,
        Some(Banner::Goal {
            edit_label: "Set a new goal",
            ..
        })
    ));

    // The pencil prefills the editor; Escape-style cancel goes back.
    click(o.cx, "goal-banner-edit");
    assert_eq!(
        goal.read_with(o.cx, |g, cx| g.draft(cx)),
        Some("Ship the rail".into())
    );
    click(o.cx, "goal-banner-cancel");
    assert!(drawn(o.cx, "goal-banner"));

    // Clear.
    click(o.cx, "goal-banner-clear");
    assert_eq!(posted(&chat, "goal").len(), 2);
}

#[gpui::test]
fn a_hidden_goal_banner_stays_hidden_but_a_goal_shows() {
    let mut app = app();
    let chat = chat();
    let mut prefs = Prefs::new();
    prefs.insert("claudius.goalBannerHidden".into(), "1".into());
    let o = open(&mut app, &chat, prefs.clone());
    assert!(!drawn(o.cx, "goal-banner-empty"));
    assert!(o.goal.read_with(o.cx, |g, _| g.hidden()));
    // Only "1" hides.
    let mut app2 = self::app();
    let mut p2 = Prefs::new();
    p2.insert("claudius.goalBannerHidden".into(), "true".into());
    let o2 = open(&mut app2, &chat, p2);
    assert!(drawn(o2.cx, "goal-banner-empty"));
    // A goal shows whatever the setting.
    update(&chat, |s| {
        s.goal = Some(GoalState {
            text: json!("Ship"),
            achieved: false,
            summary: Value::Null,
            set_at: json!(T0),
            achieved_at: Value::Null,
        })
    });
    let mut app3 = self::app();
    let o3 = open(&mut app3, &chat, prefs);
    assert!(drawn(o3.cx, "goal-banner"));
}
