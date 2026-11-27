//! The chat route's status line (U09a) in a headless GPUI window over the
//! engine in this process (a temporary HOME, the fake CLI): it mounts on
//! top of the live chat, picking a permission mode from its menu reaches
//! the server, the server's own `mode_changed` (another tab's change)
//! comes back to the trigger, a turn runs the working label, and the model
//! picker lists the session's models over the chat's transport.
//! macOS (the CoreText text system). One test: one world per process.

#![cfg(target_os = "macos")]

#[path = "../../../../crates/claudius-agent/tests/support/test_bins.rs"]
mod test_bins;
#[path = "support/world.rs"]
mod world;

use std::sync::Arc;
use std::time::{Duration, Instant};

use claudius_app::data::ShellData;
use claudius_app::shell::{Appearance, Shell};
use claudius_app::store::LocalStore;
use claudius_gpui_theme::ThemeName;
use claudius_status::line::{Status, StatusLineModel};
use claudius_transport::Request;
use gpui::{Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use serde_json::{Value, json};
use world::{World, slow_turn, world};

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

/// The status line as it draws now.
fn line(s: &Shell, cx: &gpui::App) -> Option<StatusLineModel> {
    s.status_view()?.read(cx).model()
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

#[test]
fn the_status_line_runs_over_the_in_process_engine() {
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

    // ── boot: the status line on top of the chat, idle in default mode
    let sid = wait(cx, &shell, "the session ready", |s, _| {
        let st = s.live_chat()?.state();
        (st.ready && !st.pending).then_some(st.session_id.clone()?)
    });
    let m = wait(cx, &shell, "the status line", line);
    assert_eq!(m.status, Status::Idle);
    assert_eq!(m.mode.meta.mode, "default");
    for sel in [
        "status-line",
        "mode-selector-trigger",
        "status-line-dot-idle",
        "transcript",
    ] {
        assert!(cx.debug_bounds(sel).is_some(), "{sel}");
    }
    let top = |cx: &mut VisualTestContext, sel: &'static str| cx.debug_bounds(sel).unwrap().top();
    assert!(
        top(cx, "status-line") < top(cx, "transcript"),
        "the status line is above the transcript"
    );

    // ── a mode from the menu reaches the server
    click(cx, "mode-selector-trigger");
    assert!(cx.debug_bounds("mode-selector-menu").is_some());
    click(cx, "mode-selector-option-plan");
    assert!(cx.debug_bounds("mode-selector-menu").is_none(), "closed");
    let mode_url = format!("/api/sessions/{sid}/mode");
    world::wait_for("the server in plan mode", LIMIT, || {
        let v = fetch(&w, &ws, Request::get(mode_url.clone()));
        (v["mode"] == "plan").then_some(())
    });
    wait(cx, &shell, "the trigger on plan", |s, cx| {
        (line(s, cx)?.mode.meta.mode == "plan").then_some(())
    });

    // ── another tab's change: the server's `mode_changed` comes back
    let body = json!({ "mode": "acceptEdits" }).to_string();
    fetch(&w, &ws, Request::post(mode_url.clone()).json(body));
    wait(cx, &shell, "the trigger on acceptEdits", |s, cx| {
        let st = s.live_chat()?.state();
        let on = st.permission_mode.as_ref().and_then(Value::as_str) == Some("acceptEdits");
        (on && line(s, cx)?.mode.meta.mode == "acceptEdits").then_some(())
    });
    assert!(
        cx.debug_bounds("mode-selector-label").is_some(),
        "wide: labelled"
    );

    // ── a turn: the working label, then idle with the done time
    w.input(&ws, &sid, &slow_turn(1500));
    wait(cx, &shell, "working", |s, cx| {
        let m = line(s, cx)?;
        (m.status == Status::Working && m.label == "Working" && m.elapsed.is_some()).then_some(())
    });
    assert!(cx.debug_bounds("status-line-dot-working").is_some());
    assert!(cx.debug_bounds("status-line-elapsed").is_some());
    wait(cx, &shell, "idle after the turn", |s, cx| {
        let m = line(s, cx)?;
        (m.status == Status::Idle && m.done_at.is_some()).then_some(())
    });
    assert!(cx.debug_bounds("status-line-done").is_some());

    // ── the model picker lists the session's models over the transport
    let model = cx.read(|cx| line(shell.read(cx), cx).and_then(|m| m.model));
    assert_eq!(
        model.map(|m| m.model),
        Some("fake-model".into()),
        "the chip"
    );
    click(cx, "status-line-model");
    wait(cx, &shell, "the model list", |s, cx| {
        let v = s.status_view()?;
        match v.read(cx).models() {
            claudius_status::picker::ModelList::Loaded(l) => {
                l.iter().any(|m| m.value == "fake-model").then_some(())
            }
            _ => None,
        }
    });
    assert!(cx.debug_bounds("model-picker-option-fake-model").is_some());

    w.shutdown();
}
