//! The chat route's composer and prompt cards over the live chat (U07e,
//! U08c), in a headless GPUI window over the engine in this process (a
//! temporary HOME, the fake CLI): a typed prompt goes out through the chat
//! and its promise settles, a draft reaches the server, a prompt typed
//! while a turn runs queues and goes out after it, a tool call's
//! permission card is answered from the card, and Stop interrupts a turn.
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
use claudius_client::state::ChatState;
use claudius_gpui_theme::ThemeName;
use claudius_transport::Request;
use gpui::{Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use world::{slow_turn, world};

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
    what: &str,
    mut f: impl FnMut(&mut VisualTestContext) -> Option<T>,
) -> T {
    let t0 = Instant::now();
    loop {
        settle(cx);
        if let Some(v) = f(cx) {
            return v;
        }
        assert!(t0.elapsed() < LIMIT, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn chat(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<Arc<ChatState>> {
    cx.read(|cx| shell.read(cx).live_chat().map(|c| c.state()))
}

/// The composer's bound session and its box's text.
fn composer(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<(Option<String>, String)> {
    cx.read(|cx| {
        let v = shell.read(cx).composer()?;
        let m = v.read(cx).model();
        Some((m.session_id().map(str::to_owned), m.value().to_owned()))
    })
}

fn transcript_has(st: &ChatState, text: &str) -> bool {
    format!("{:?}", st.messages).contains(text)
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} isn't on screen"));
    cx.simulate_click(b.center(), Modifiers::none());
    settle(cx);
}

#[test]
fn the_composer_drives_the_live_chat() {
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

    // ── boot: the live chat is ready and the composer is bound to it
    let s1 = wait(cx, "the boot's session, ready", |cx| {
        let st = chat(&shell, cx)?;
        (st.ready && !st.pending).then(|| st.session_id.clone())?
    });
    wait(cx, "the composer bound to it", |cx| {
        (composer(&shell, cx)?.0.as_deref() == Some(s1.as_str())).then_some(())
    });
    assert!(cx.debug_bounds("composer-frame").is_some());
    assert!(cx.debug_bounds("transcript").is_some());

    // ── a typed prompt goes out through the chat; the box clears and the
    // send's promise settles (nothing left waiting)
    cx.simulate_input("hello native");
    settle(cx);
    assert_eq!(composer(&shell, cx).unwrap().1, "hello native");
    cx.simulate_keystrokes("enter");
    wait(cx, "the echo", |cx| {
        let st = chat(&shell, cx)?;
        (transcript_has(&st, "echo:hello native") && !st.pending).then_some(())
    });
    assert_eq!(composer(&shell, cx).unwrap().1, "");
    wait(cx, "the send's promise", |cx| {
        cx.read(|cx| shell.read(cx).live_composer_waiting() == Some(0))
            .then_some(())
    });
    assert!(cx.debug_bounds("composer-send-failed-notice").is_none());

    // ── a draft reaches the server (the 500 ms debounced PUT, over the
    // workspace's page)
    cx.simulate_input("a draft");
    let page = w.data.page(&ws);
    let url = format!("/api/sessions/{s1}/prompt-draft");
    world::wait_for("the draft on the server", LIMIT, || {
        // The PUT's 500 ms debounce is a GPUI timer: the test clock moves
        // only when told to.
        cx.executor().advance_clock(Duration::from_millis(100));
        settle(cx);
        let t = page.clone();
        let url = url.clone();
        let res = w
            .backend
            .handle()
            .block_on(async move { t.fetch(Request::get(url)).await })
            .ok()?;
        res.text().contains("a draft").then_some(())
    });
    cx.simulate_keystrokes("cmd-a backspace");
    settle(cx);

    // ── a prompt typed while a turn runs queues, then goes out after it
    cx.simulate_input(&slow_turn(1500));
    cx.simulate_keystrokes("enter");
    wait(cx, "the slow turn running", |cx| {
        let st = chat(&shell, cx)?;
        st.pending.then_some(())
    });
    cx.simulate_input("after the turn");
    cx.simulate_keystrokes("enter");
    wait(cx, "the queue strip", |cx| {
        cx.debug_bounds("composer-queue").map(|_| ())
    });
    wait(cx, "the queued prompt's echo", |cx| {
        let st = chat(&shell, cx)?;
        (transcript_has(&st, "echo:after the turn") && !st.pending).then_some(())
    });

    // ── a tool call asks for permission: the card shows over the chat and
    // Allow answers it (U08c)
    cx.simulate_input("tool: ls -la");
    cx.simulate_keystrokes("enter");
    wait(cx, "the permission card", |cx| {
        cx.debug_bounds("permission-modal").map(|_| ())
    });
    cx.read(|cx| {
        let st = shell.read(cx).live_chat().unwrap().state();
        assert_eq!(st.pending_permissions.len(), 1);
    });
    click(cx, "permission-allow-once");
    wait(cx, "the turn after Allow", |cx| {
        let st = chat(&shell, cx)?;
        (transcript_has(&st, "permission:allow") && !st.pending).then_some(())
    });
    assert!(cx.debug_bounds("permission-modal").is_none());

    // ── Stop interrupts a running turn: the CLI gets the `interrupt`
    // control request (the fake CLI answers it and lets its scripted turn
    // finish, so the turn's end is the script's)
    let interrupts = || w.control_log().matches(r#""subtype":"interrupt""#).count();
    let before = interrupts();
    cx.simulate_input(&slow_turn(1500));
    cx.simulate_keystrokes("enter");
    wait(cx, "the turn running", |cx| {
        cx.debug_bounds("composer-interrupt").map(|_| ())
    });
    click(cx, "composer-interrupt");
    world::wait_for("the interrupt at the CLI", LIMIT, || {
        settle(cx);
        (interrupts() > before).then_some(())
    });
    wait(cx, "the turn over", |cx| {
        let st = chat(&shell, cx)?;
        (!st.pending).then_some(())
    });

    w.shutdown();
}
