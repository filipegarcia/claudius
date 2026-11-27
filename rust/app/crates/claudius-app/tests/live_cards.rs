//! The transcript cards' host over the live chat (U06a), in a headless
//! GPUI window over the engine in this process (a temporary HOME, the
//! fake CLI): the cards link files into the route's workspace, and the
//! workflow size follows the user settings' `workflowSizeGuideline`
//! (`useWorkflowSizeGuideline(fileLink.cwd)`, asked over the chat's
//! transport). The fixture side is `cards_host`. macOS (the CoreText text
//! system). One test: one world per process.

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
use claudius_chat::cards::FileLink;
use claudius_gpui_theme::ThemeName;
use gpui::{Entity, TestAppContext, TestDispatcher, VisualTestContext, px, size};
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

/// The shown chat view's file link and workflow size.
fn cards(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<(Option<FileLink>, String)> {
    cx.read(|cx| {
        let s = shell.read(cx);
        let tab = s.chat_tab()?;
        let view = s.chat_view(&tab)?;
        let o = view.read(cx).options();
        Some((o.file_link.clone(), o.workflow_size.clone()))
    })
}

#[test]
fn the_cards_follow_the_workspace_and_the_user_settings() {
    let w = world(test_bins::fake_claude(), &["Alpha"]);
    // The user scope is `homedir()/.claude/settings.json`: the world's
    // temporary HOME.
    let user = w.root.path().join("home").join(".claude");
    std::fs::create_dir_all(&user).unwrap();
    std::fs::write(
        user.join("settings.json"),
        r#"{ "workflowSizeGuideline": "large" }"#,
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

    // ── the boot's chat: its cards link into the route's workspace, and
    // the workflow size lands from the user settings
    let ws = &w.workspaces[0];
    let (link, size) = wait(cx, "the user settings' workflow size", |cx| {
        let (link, size) = cards(&shell, cx)?;
        (size == "large").then_some((link, size))
    });
    assert_eq!(
        link,
        Some(FileLink {
            workspace_id: ws.id.clone(),
            cwd: ws.root_path.clone(),
        })
    );
    assert_eq!(size, "large");

    w.shutdown();
}
