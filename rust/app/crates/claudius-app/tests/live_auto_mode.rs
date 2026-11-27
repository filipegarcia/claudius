//! The permission card's auto-mode tip over the live chat (U08f), in a
//! headless GPUI window over the engine in this process (a temporary
//! HOME, the fake CLI): the user settings' `disableAutoMode` hides the
//! tip, as `useDisableAutoMode(session.cwd)` does in ChatSurface. The
//! other way round (no setting, the tip shows) is in `live_composer`.
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
use gpui::{Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use world::world;

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

fn transcript_has(st: &ChatState, text: &str) -> bool {
    format!("{:?}", st.messages).contains(text)
}

#[test]
fn disable_auto_mode_hides_the_tip_over_the_live_chat() {
    let w = world(test_bins::fake_claude(), &["Alpha"]);
    // The user scope is `homedir()/.claude/settings.json`: the world's
    // temporary HOME.
    let user = w.root.path().join("home").join(".claude");
    std::fs::create_dir_all(&user).unwrap();
    std::fs::write(
        user.join("settings.json"),
        r#"{ "disableAutoMode": "disable" }"#,
    )
    .unwrap();

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

    wait(cx, "the boot's session, ready", |cx| {
        let st = chat(&shell, cx)?;
        (st.ready && !st.pending).then_some(())
    });
    wait(cx, "the composer", |cx| {
        cx.debug_bounds("composer-frame").map(|_| ())
    });

    // ── a Bash call asks for permission: the card shows without the tip
    // (the tip needs Auto mode, which the setting takes away)
    cx.simulate_input("tool: ls -la");
    cx.simulate_keystrokes("enter");
    wait(cx, "the card, without the auto-mode tip", |cx| {
        let card = cx.debug_bounds("permission-modal").is_some();
        let tip = cx.debug_bounds("permission-auto-mode-tip").is_some();
        (card && !tip).then_some(())
    });

    // ── the card still answers
    let b = cx.debug_bounds("permission-allow-once").unwrap();
    cx.simulate_click(b.center(), Modifiers::none());
    wait(cx, "the turn after Allow", |cx| {
        let st = chat(&shell, cx)?;
        (transcript_has(&st, "permission:allow") && !st.pending).then_some(())
    });
    assert!(cx.debug_bounds("permission-modal").is_none());

    w.shutdown();
}
