//! The shell in a headless GPUI window over the engine in this process
//! (a temporary HOME, the fake CLI): the chat route mounts a live
//! `ChatState` that boots a session into the strip and goes live, its
//! tab's dot follows a turn, "+" and a tab switch mid-turn drive the chat,
//! the strip persists, the chat remounts after a page away, another
//! workspace gets its own chat, and focus mode and the route memory reach
//! the store.
//! macOS (the CoreText text system). One test: one world per process.

#![cfg(target_os = "macos")]

#[path = "../../../../crates/claudius-agent/tests/support/test_bins.rs"]
mod test_bins;
#[path = "support/world.rs"]
mod world;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use claudius_app::chat::ChatPage;
use claudius_app::data::{
    ActiveSessionState, DataFuture, IconImage, OpenTabs, OpenTabsPut, SessionSummary, ShellChange,
    ShellData, TabStatus, WorkspaceList,
};
use claudius_app::live::TransportShellData;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::shell::{Appearance, Shell};
use claudius_app::store::{FOCUS_KEY, LAST_PATH_KEY, LocalStore};
use claudius_gpui_theme::ThemeName;
use futures::channel::mpsc::UnboundedReceiver;
use futures::executor::block_on;
use gpui::{Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use world::{slow_turn, world};

const LIMIT: Duration = Duration::from_secs(30);

/// The engine's data, keeping the active tab of each strip the shell
/// persists, and which workspaces' session lists the shell fetched.
struct Recorded {
    inner: Arc<TransportShellData>,
    actives: Mutex<Vec<Option<String>>>,
    session_reads: Mutex<Vec<String>>,
}

impl ShellData for Recorded {
    fn workspaces(&self) -> DataFuture<WorkspaceList> {
        self.inner.workspaces()
    }
    fn select_workspace(&self, id: &str) -> DataFuture<()> {
        self.inner.select_workspace(id)
    }
    fn open_tabs(&self, ws: &str) -> DataFuture<OpenTabs> {
        self.inner.open_tabs(ws)
    }
    fn put_open_tabs(&self, ws: &str, body: OpenTabsPut) -> DataFuture<()> {
        if let Some(active) = &body.active_id {
            self.actives.lock().unwrap().push(active.clone());
        }
        self.inner.put_open_tabs(ws, body)
    }
    fn sessions(&self, ws: &str) -> DataFuture<Vec<SessionSummary>> {
        self.session_reads.lock().unwrap().push(ws.to_owned());
        self.inner.sessions(ws)
    }
    fn create_session(&self, ws: &str) -> DataFuture<String> {
        self.inner.create_session(ws)
    }
    fn active_session_state(&self, ws: &str) -> Option<ActiveSessionState> {
        self.inner.active_session_state(ws)
    }
    fn workspace_icon(&self, id: &str) -> DataFuture<Option<IconImage>> {
        self.inner.workspace_icon(id)
    }
    fn customizations(&self) -> DataFuture<Option<Vec<String>>> {
        self.inner.customizations()
    }
    fn open_chat(&self, ws: &str, href: &str, pathname: &str) -> Option<ChatPage> {
        self.inner.open_chat(ws, href, pathname)
    }
    fn has_live_chat(&self) -> bool {
        self.inner.has_live_chat()
    }
    fn subscribe(&self) -> UnboundedReceiver<ShellChange> {
        self.inner.subscribe()
    }
}

/// Runs the GPUI tasks and draws (the strip measures, then fits).
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
    mut f: impl FnMut(&Shell) -> Option<T>,
) -> T {
    let t0 = Instant::now();
    loop {
        settle(cx);
        if let Some(v) = cx.read(|cx| f(shell.read(cx))) {
            // Draw what `f` saw: the last park may have run tasks after
            // the last frame.
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            });
            return v;
        }
        if t0.elapsed() >= LIMIT {
            let seen = cx.read(|cx| {
                let s = shell.read(cx);
                let chat = s.live_chat().map(|c| {
                    let st = c.state();
                    (
                        st.session_id.clone(),
                        st.pending,
                        st.ready,
                        st.messages.len(),
                    )
                });
                format!("tabs {:?}, chat {chat:?}", tabs(s))
            });
            panic!("timed out waiting for {what}: {seen}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Settles until `selector` is drawn (`on`) or gone: the transcript view
/// reads the chat a frame after the tab dot does.
fn wait_drawn(cx: &mut VisualTestContext, selector: &'static str, on: bool) {
    let t0 = Instant::now();
    loop {
        settle(cx);
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        if cx.debug_bounds(selector).is_some() == on {
            return;
        }
        assert!(
            t0.elapsed() < LIMIT,
            "timed out waiting for {selector} to be {}",
            if on { "drawn" } else { "gone" }
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} isn't on screen"));
    cx.simulate_click(b.center(), Modifiers::none());
    settle(cx);
}

/// The active workspace's tabs: (id, status, active).
fn tabs(shell: &Shell) -> Vec<(String, TabStatus, bool)> {
    let Some(ws) = shell.state().active_workspace() else {
        return Vec::new();
    };
    shell
        .state()
        .tab_views(shell.bound_state(&ws.id), 2026)
        .into_iter()
        .map(|t| (t.id, t.status, t.active))
        .collect()
}

fn chat_session(shell: &Shell) -> Option<String> {
    shell.live_chat()?.session_id()
}

/// A fake-CLI turn that streams `n` chunks, `ms` apart.
fn stream_turn(n: usize, ms: u64) -> String {
    let steps: Vec<serde_json::Value> = (0..n)
        .flat_map(|i| {
            [
                serde_json::json!({ "$text": format!("chunk {i} ") }),
                serde_json::json!({ "$delay_ms": ms }),
            ]
        })
        .collect();
    format!(
        "script:{}",
        serde_json::json!({ "steps": steps, "result": "done" })
    )
}

#[test]
fn the_shell_runs_over_the_in_process_engine() {
    let w = world(test_bins::fake_claude(), &["Alpha", "Beta"]);
    let (w1, w2) = (w.workspaces[0].clone(), w.workspaces[1].clone());
    // An uploaded icon for the second workspace (a 2x2 PNG).
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(2, 2, image::Rgba([200, 80, 40, 255]))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    claudius_core::workspaces::write_icon(&w2.id, "png", png.get_ref()).unwrap();
    claudius_core::workspaces::update(
        &w2.id,
        serde_json::json!({"icon": {"kind": "image", "ext": "png"}})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    let store_path = w.root.path().join("local-storage.json");

    let mut app = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    app.update(|cx| claudius_app::init(ThemeName::Dark, cx));
    let recorded = Arc::new(Recorded {
        inner: w.data.clone(),
        actives: Mutex::default(),
        session_reads: Mutex::default(),
    });
    let data: Arc<dyn ShellData> = recorded.clone();
    let store = LocalStore::open(&store_path);
    let (shell, cx) = app.add_window_view(|window, cx| {
        Shell::with_store(data, Appearance::Fixed(ThemeName::Dark), store, window, cx)
    });
    cx.simulate_resize(size(px(1440.), px(900.)));

    // ── boot: the chat of the first workspace, a fresh session in its strip
    let s1 = wait(cx, &shell, "the boot's session in the strip", |s| {
        let id = chat_session(s)?;
        let t = tabs(s);
        (t.len() == 1 && t[0].0 == id && t[0].2).then_some(id)
    });
    let reads_at_mount = recorded.session_reads.lock().unwrap().len();
    cx.read(|cx| {
        let s = shell.read(cx);
        assert_eq!(s.state().route(), &Route::chat(&w1.id));
        assert_eq!(s.live_chat().unwrap().workspace_id(), w1.id);
        assert!(s.chat_for_session(&s1).is_some());
        assert!(s.chat_for_session("nope").is_none());
    });
    wait(cx, &shell, "ready: idle", |s| {
        (tabs(s)[0].1 == TabStatus::Idle).then_some(())
    });
    // The chat's `?session=` writer (500 ms) replaced the route.
    let with_session = Route::page(
        &w1.id,
        WorkspacePage::Chat {
            session: Some(s1.clone()),
        },
    );
    wait(cx, &shell, "the route's ?session=", |s| {
        (s.state().route() == &with_session).then_some(())
    });
    cx.read(|cx| assert!(!shell.read(cx).state().can_go_back(), "replaced"));
    // The uploaded icon is read and drawn.
    wait(cx, &shell, "the icon", |s| s.icon_image(&w2.id).map(|_| ()));
    assert!(cx.debug_bounds("ws-icon-image").is_some());
    // The bound session's transcript (U04h), not the live card.
    for sel in ["chat-session", "transcript", "session-tabs", "tab-0"] {
        assert!(cx.debug_bounds(sel).is_some(), "{sel}");
    }
    assert!(cx.debug_bounds("chat-live").is_none());
    assert!(cx.debug_bounds("chat-reconnecting").is_none());
    // The gated tiles: `/api/customizations` answered, nothing published.
    cx.read(|cx| {
        assert_eq!(
            shell.read(cx).state().enabled_customizations(),
            Some(&[][..])
        );
    });

    // ── a turn: the dot runs, the chat shows it, then idle
    w.input(&w1.id, &s1, &slow_turn(1500));
    wait(cx, &shell, "running", |s| {
        (tabs(s)[0].1 == TabStatus::Running).then_some(())
    });
    // The transcript's working row, then the reply.
    wait_drawn(cx, "working-row", true);
    wait(cx, &shell, "idle after the turn", |s| {
        let st = s.live_chat()?.state();
        (tabs(s)[0].1 == TabStatus::Idle && !st.messages.is_empty()).then_some(())
    });
    wait_drawn(cx, "working-row", false);
    assert!(cx.debug_bounds("assistant-message").is_some());
    cx.read(|cx| assert!(shell.read(cx).has_transcript(&s1)));

    // ── "+": the chat makes a session, the strip follows
    click(cx, "tabs-new");
    let s2 = wait(cx, &shell, "a second session bound", |s| {
        let id = chat_session(s).filter(|id| *id != s1)?;
        let t = tabs(s);
        (t.len() == 2 && t[1].0 == id && t[1].2).then_some(id)
    });
    // The transcript follows the chat to the new session: the first one's
    // tab no longer reads it.
    cx.read(|cx| {
        let s = shell.read(cx);
        assert!(s.has_transcript(&s2));
        assert!(!s.has_transcript(&s1));
    });
    // The other tab's dot is the server's list (the chat refreshed it).
    wait(cx, &shell, "the first tab idle from the list", |s| {
        (tabs(s)[0].1 == TabStatus::Idle).then_some(())
    });
    // U04e: those dots read the chat's merged list (`session.sessions`),
    // not a re-fetch of the workspace's: no read of w1's list since the
    // chat mounted, and the strip's rows are the chat's.
    assert!(
        !recorded.session_reads.lock().unwrap()[reads_at_mount..].contains(&w1.id),
        "{:?}",
        recorded.session_reads.lock().unwrap()
    );
    cx.read(|cx| {
        let s = shell.read(cx);
        let merged = claudius_app::chat::session_rows(&s.live_chat().unwrap().state().sessions);
        assert!(merged.iter().any(|r| r.id == s1));
        assert_eq!(s.state().sessions(&w1.id), merged.as_slice());
    });

    // ── selecting the other tab mid-turn switches the chat. While it
    // streams, the chat publishes the old session: a snapshot from before
    // the switch mustn't pull the strip back, and until the chat is on the
    // tab the strip bound, that tab reads as starting, not as the old
    // session's dot.
    // 80 ms apart: the transcript and the rail (its token meter) draw
    // each chunk, and a busier stream under a loaded CPU keeps the test's
    // executor from ever parking.
    w.input(&w1.id, &s2, &stream_turn(150, 80));
    wait(cx, &shell, "the second session streaming", |s| {
        let st = s.live_chat()?.state();
        (tabs(s)[1].1 == TabStatus::Running && !st.messages.is_empty()).then_some(())
    });
    // Snapshots the shell hasn't read yet pile up.
    std::thread::sleep(Duration::from_millis(80));
    // ⌘⇧1, and the strip read at once (the chat is still on the old
    // session then, but for a race of microseconds that skips the check).
    let from = recorded.actives.lock().unwrap().len();
    let (first, on) = cx.update(|_, cx| {
        shell.update(cx, |s, cx| {
            s.update_state(cx, |st| st.select_tab_by_number(1));
            (tabs(s)[0].clone(), chat_session(s))
        })
    });
    assert!(first.2, "the first tab is the strip's");
    if on.as_deref() == Some(s2.as_str()) {
        assert_eq!(first.1, TabStatus::Starting, "not the old session's dot");
    }
    // The snapshots from before the switch reach the shell now, and leave
    // the strip where it is.
    cx.run_until_parked();
    cx.read(|cx| assert!(tabs(shell.read(cx))[0].2, "moved back by an old snapshot"));
    wait(cx, &shell, "switched to the first", |s| {
        (chat_session(s).as_deref() == Some(s1.as_str()) && tabs(s)[0].2).then_some(())
    });
    world::wait_for("the strip persisted", LIMIT, || {
        let t = block_on(w.data.open_tabs(&w1.id)).ok()?;
        (t.tabs == [s1.clone(), s2.clone()] && t.active_id.as_deref() == Some(s1.as_str()))
            .then_some(())
    });
    // Each strip the shell persisted since: the first tab, never the old
    // one back.
    let actives = recorded.actives.lock().unwrap()[from..].to_vec();
    assert_eq!(actives.first(), Some(&Some(s1.clone())), "{actives:?}");
    assert!(!actives.contains(&Some(s2.clone())), "{actives:?}");

    // ── focus mode persists
    cx.simulate_keystrokes("cmd-.");
    settle(cx);
    assert_eq!(LocalStore::open(&store_path).get(FOCUS_KEY), Some("focus"));
    cx.simulate_keystrokes("cmd-. cmd-.");
    settle(cx);
    assert_eq!(LocalStore::open(&store_path).get(FOCUS_KEY), Some("off"));

    // ── away and back: the chat unmounts, then boots the saved tab again
    click(cx, "nav-nav.git");
    cx.read(|cx| {
        let s = shell.read(cx);
        assert_eq!(s.state().route(), &Route::page(&w1.id, WorkspacePage::Git));
        assert!(s.live_chat().is_none(), "unmounted off the chat");
    });
    assert_eq!(
        LocalStore::open(&store_path).last_path(&w1.id),
        Some(format!("/{}/git", w1.id))
    );
    click(cx, "nav-nav.chat");
    wait(cx, &shell, "the chat back on the saved tab", |s| {
        let st = s.live_chat()?.state();
        (st.session_id.as_deref() == Some(s1.as_str()) && st.ready && tabs(s).len() == 2)
            .then_some(())
    });

    // ── another workspace: its own chat, its own session in its own cwd
    click(cx, "ws-1");
    let s3 = wait(cx, &shell, "the second workspace's session", |s| {
        let chat = s.live_chat()?;
        let id = chat.session_id()?;
        (chat.workspace_id() == w2.id && tabs(s).len() == 1).then_some(id)
    });
    assert!(s3 != s1 && s3 != s2);
    let rows = block_on(w.data.sessions(&w2.id)).unwrap();
    assert_eq!(
        rows.iter().find(|r| r.id == s3).map(|r| r.cwd.as_str()),
        Some(w2.root_path.as_str())
    );
    // The first workspace's strip is untouched.
    assert_eq!(block_on(w.data.open_tabs(&w1.id)).unwrap().tabs.len(), 2);
    let stored = LocalStore::open(&store_path);
    assert!(stored.get(LAST_PATH_KEY).is_some());
    assert_eq!(stored.last_path(&w2.id), Some(format!("/{}", w2.id)));

    // A CLI that dies mid-turn: the bound tab's dot reads the chat's error.
    w.input(&w2.id, &s3, "exit:3");
    wait(cx, &shell, "the error dot", |s| {
        (tabs(s)[0].1 == TabStatus::Error).then_some(())
    });

    // A remembered page brings the first workspace back where it was: its
    // chat (the remounted chat may already have written its `?session=`
    // back, so the session is whichever it binds).
    click(cx, "ws-0");
    cx.read(|cx| {
        let route = shell.read(cx).state().route();
        assert!(
            matches!(
                route,
                Route::Workspace { id, page: WorkspacePage::Chat { .. } } if *id == w1.id
            ),
            "the chat was the last page there: {route:?}"
        );
    });

    w.shutdown();
}
