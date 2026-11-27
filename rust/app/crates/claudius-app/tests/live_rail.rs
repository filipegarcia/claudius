//! The chat's right rail and goal banner (U09b) in a headless GPUI window
//! over the engine in this process (a temporary HOME, the fake CLI): the
//! rail mounts beside the live chat, a turn whose tool call is
//! `TodoWrite` fills its To-dos, the add form's prompt goes through the
//! composer's queue and closes the form once sent, the goal banner sets a
//! goal on the server, and the focus levels hide the rail (focus) and the
//! goal row (zen). macOS (the CoreText text system). One test: one world
//! per process.

#![cfg(target_os = "macos")]

#[path = "../../../../crates/claudius-agent/tests/support/test_bins.rs"]
mod test_bins;
#[path = "support/world.rs"]
mod world;

use std::sync::Arc;
use std::time::{Duration, Instant};

use claudius_app::data::ShellData;
use claudius_app::nav::FocusLevel;
use claudius_app::shell::{Appearance, Shell};
use claudius_app::store::LocalStore;
use claudius_gpui_theme::ThemeName;
use claudius_panels::rail::RailModel;
use claudius_transport::Request;
use gpui::{Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use serde_json::{Value, json};
use world::{World, world};

const LIMIT: Duration = Duration::from_secs(30);

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

/// Settles until `f` answers, the engine working on its own threads.
fn wait<T>(
    cx: &mut VisualTestContext,
    shell: &Entity<Shell>,
    what: &str,
    mut f: impl FnMut(&Shell, &gpui::App) -> Option<T>,
) -> T {
    let t0 = Instant::now();
    loop {
        settle(cx);
        if let Some(v) = cx.read(|cx| f(shell.read(cx), cx)) {
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            });
            return v;
        }
        assert!(t0.elapsed() < LIMIT, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The rail as it draws now.
fn rail(s: &Shell, cx: &gpui::App) -> Option<RailModel> {
    s.rail_view()?.read(cx).model().cloned()
}

fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    cx.debug_bounds(selector).is_some()
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} isn't on screen"));
    cx.simulate_click(b.center(), Modifiers::none());
    settle(cx);
}

/// A request to the engine as another page would make it.
fn fetch(w: &World, ws: &str, req: Request) -> Value {
    let t = w.data.page(ws);
    let res = w
        .backend
        .handle()
        .block_on(async move { t.fetch(req).await })
        .unwrap();
    assert_eq!(res.status, 200, "{}", res.text());
    serde_json::from_str(&res.text()).unwrap()
}

/// A turn whose one tool call is `TodoWrite`.
fn todo_turn() -> String {
    let todos = json!([
        { "content": "Port the rail", "status": "completed", "activeForm": "Porting the rail" },
        { "content": "Write the live test", "status": "in_progress", "activeForm": "Writing the live test" },
        { "content": "Take the screenshots", "status": "pending", "activeForm": "Taking the screenshots" }
    ]);
    let step = json!({
        "type": "assistant",
        "parent_tool_use_id": null,
        "message": {
            "id": "msg_todo",
            "type": "message",
            "role": "assistant",
            "model": "fake-model",
            "content": [{ "type": "tool_use", "id": "toolu_todo", "name": "TodoWrite", "input": { "todos": todos } }]
        }
    });
    format!("script:{}", json!({ "steps": [step], "result": "done" }))
}

fn set_focus(cx: &mut VisualTestContext, shell: &Entity<Shell>, level: FocusLevel) {
    shell.update(cx, |s, cx| {
        s.update_state(cx, |st| {
            st.set_focus(level);
            Vec::new()
        })
    });
    settle(cx);
}

#[test]
fn the_rail_runs_over_the_in_process_engine() {
    let w = world(test_bins::fake_claude(), &["Alpha"]);
    let ws = w.workspaces[0].id.clone();
    let mut app = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    app.update(|cx| claudius_app::init(ThemeName::Dark, cx));
    let data: Arc<dyn ShellData> = w.data.clone();
    let store = LocalStore::open(w.root.path().join("local-storage.json"));
    let (shell, cx) = app.add_window_view(|window, cx| {
        Shell::with_store(data, Appearance::Fixed(ThemeName::Dark), store, window, cx)
    });
    cx.simulate_resize(size(px(1440.), px(900.)));

    // ── boot: the rail beside the chat, its to-dos empty
    let sid = wait(cx, &shell, "the session ready", |s, _| {
        let st = s.live_chat()?.state();
        (st.ready && !st.pending).then_some(st.session_id.clone()?)
    });
    let m = wait(cx, &shell, "the rail", rail);
    assert!(m.todos.body.rows.is_empty());
    for sel in [
        "right-rail",
        "activity-header",
        "todos-empty",
        "session-card",
        "transcript",
    ] {
        assert!(drawn(cx, sel), "{sel}");
    }
    let rail_box = cx.debug_bounds("right-rail").unwrap();
    let transcript = cx.debug_bounds("transcript").unwrap();
    assert!(
        transcript.right() <= rail_box.left(),
        "the rail is right of the chat"
    );
    assert_eq!(f32::from(rail_box.size.width), 288., "lg:w-72");

    // ── a TodoWrite turn fills the To-dos
    w.input(&ws, &sid, &todo_turn());
    let m = wait(cx, &shell, "the todos", |s, cx| {
        rail(s, cx).filter(|m| m.todos.body.rows.len() == 3)
    });
    let texts: Vec<_> = m.todos.body.rows.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(
        texts,
        [
            "Port the rail",
            "Writing the live test",
            "Take the screenshots"
        ]
    );
    assert_eq!(m.todos.badge.as_deref(), Some("(3)"));
    wait(cx, &shell, "idle after the turn", |s, _| {
        let st = s.live_chat()?.state();
        (!st.pending).then_some(())
    });
    assert!(drawn(cx, "rail-todo-in_progress-t1"));
    assert!(!drawn(cx, "todos-empty"));
    // The Tools section saw the call.
    let m = cx.read(|cx| rail(shell.read(cx), cx)).unwrap();
    assert!(
        m.tools.body.iter().any(|t| t.name == "TodoWrite"),
        "{:?}",
        m.tools.body
    );

    // ── add-todos: the prompt goes through the composer's queue
    click(cx, "todos-add-button");
    assert!(drawn(cx, "add-todos-form"));
    let rail_view = cx.read(|cx| shell.read(cx).rail_view()).unwrap();
    cx.update(|window, cx| rail_view.update(cx, |r, cx| r.set_add_row(0, "Ship it", window, cx)));
    settle(cx);
    click(cx, "add-todos-submit");
    wait(cx, &shell, "the form closed once sent", |s, cx| {
        let open = s.rail_view()?.read(cx).add_form().is_some();
        (!open).then_some(())
    });
    wait(cx, &shell, "the append prompt in the transcript", |s, _| {
        let st = s.live_chat()?.state();
        st.messages
            .iter()
            .any(|m| format!("{:?}", m.blocks).contains("Items to add:\\n- Ship it"))
            .then_some(())
    });

    // ── the goal banner: set a goal, which the server records
    wait(cx, &shell, "idle", |s, _| {
        (!s.live_chat()?.state().pending).then_some(())
    });
    assert!(drawn(cx, "goal-banner-empty"));
    click(cx, "goal-banner-set");
    let goal = cx.read(|cx| shell.read(cx).goal_view()).unwrap();
    cx.update(|window, cx| {
        goal.update(cx, |g, cx| g.set_draft("Ship the native rail", window, cx))
    });
    goal.update(cx, |g, cx| g.submit(cx));
    wait(cx, &shell, "the goal on screen", |s, cx| {
        let g = s.goal_view()?;
        matches!(
            g.read(cx).banner(),
            Some(claudius_panels::goal::Banner::Goal { .. })
        )
        .then_some(())
    });
    wait(cx, &shell, "setGoal answered", |s, _| {
        (s.live_rail_waiting() == Some(0)).then_some(())
    });
    // Then the opening prompt, `fromGoal`: the server tags it.
    let tagged = format!("/api/sessions/{sid}/goal-messages");
    world::wait_for("the goal's opening prompt", LIMIT, || {
        let v = fetch(&w, &ws, Request::get(tagged.clone()));
        v["uuids"]
            .as_array()
            .is_some_and(|u| !u.is_empty())
            .then_some(())
    });

    // ── the focus levels: focus hides the rail, zen the goal row too
    wait(cx, &shell, "idle again", |s, _| {
        (!s.live_chat()?.state().pending).then_some(())
    });
    set_focus(cx, &shell, FocusLevel::Focus);
    assert!(!drawn(cx, "right-rail"), "focus hides the rail");
    assert!(drawn(cx, "session-header"), "the goal row stays");
    set_focus(cx, &shell, FocusLevel::Zen);
    assert!(!drawn(cx, "right-rail"));
    assert!(!drawn(cx, "session-header"), "zen hides the goal row");
    set_focus(cx, &shell, FocusLevel::Off);
    assert!(drawn(cx, "right-rail"));
    assert!(drawn(cx, "session-header"));

    // ── a section's collapse lands in the store
    click(cx, "activity-section-toggle-tools");
    let stored = cx.read(|cx| {
        shell
            .read(cx)
            .store()
            .get("claudius.activity.tools.collapsed")
            .map(str::to_owned)
    });
    assert_eq!(stored.as_deref(), Some("1"));

    w.shutdown();
}
