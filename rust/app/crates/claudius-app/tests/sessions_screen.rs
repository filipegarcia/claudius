//! The sessions browser in the shell's headless window (`TestAppContext`,
//! CoreText): the Sessions route draws the list, typing narrows it, the
//! keys move and open, rename and delete ask and send, and resume opens a
//! chat tab. macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_app::data::{DataFuture, ShellData};
use claudius_app::fixture::FixtureShellData;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::sessions::data::{Reply, SessionsChange, SessionsData, SessionsRequest};
use claudius_app::sessions::fixture::FixtureSessionsData;
use claudius_app::sessions::view::SessionsScreen;
use claudius_app::shell::{Appearance, Shell};
use claudius_gpui_theme::ThemeName;
use futures::FutureExt as _;
use futures::channel::mpsc::UnboundedReceiver;
use gpui::{
    AppContext as _, Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext,
    WindowOptions, px, size,
};
use gpui_apple::AppleTextSystem;
use serde_json::json;

const W1: &str = "wks_3f2a9c81d0e4";
const W2: &str = "wks_7b41e05c92aa";
const ROOT: &str = "/Users/demo/src/claudius";
const ROOT_Q: &str = "%2FUsers%2Fdemo%2Fsrc%2Fclaudius";
const SHELL: &str = "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162";
const FLAKY: &str = "b7d24f19-6c3e-4a5b-9d8e-7f6a5b4c3d2e";
const LOGIN_PAGE: &str = "d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a";
const LOGIN_FIX: &str = "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b";

struct Ui {
    shell: Entity<Shell>,
    screen: Entity<SessionsScreen>,
    data: Arc<FixtureSessionsData>,
    cx: VisualTestContext,
}

fn app() -> TestAppContext {
    app_in(ThemeName::Dark)
}

fn app_in(theme: ThemeName) -> TestAppContext {
    let cx = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    cx.update(|cx| claudius_app::init(theme, cx));
    cx
}

/// The shell (in the app's `Root`, as `open_main_window` opens it) with the
/// sessions browser over the bundled fixture.
fn open(app: &mut TestAppContext) -> Ui {
    open_in(app, ThemeName::Dark)
}

fn open_in(app: &mut TestAppContext, theme: ThemeName) -> Ui {
    let data = Arc::new(FixtureSessionsData::builtin());
    let sessions: Arc<dyn SessionsData> = data.clone();
    open_with(app, theme, data, sessions)
}

/// Over `sessions`, which `data` (the fixture it records into) answers.
fn open_with(
    app: &mut TestAppContext,
    theme: ThemeName,
    data: Arc<FixtureSessionsData>,
    sessions: Arc<dyn SessionsData>,
) -> Ui {
    let now = data.now();
    let shell_data: Arc<dyn ShellData> = Arc::new(FixtureShellData::builtin());
    let (handle, shell) = app
        .update(|cx| {
            gpui_kit::open_window(WindowOptions::default(), cx, |window, cx| {
                cx.new(|cx| {
                    Shell::new(shell_data, Appearance::Fixed(theme), window, cx)
                        .with_sessions(sessions, window, cx)
                })
            })
        })
        .unwrap();
    let mut cx = VisualTestContext::from_window(handle, app);
    cx.simulate_resize(size(px(1440.), px(900.)));
    let screen = cx.read(|cx| shell.read(cx).sessions_screen().cloned().unwrap());
    cx.update(|_, cx| screen.update(cx, |s, cx| s.set_clock(now, cx)));
    let mut ui = Ui {
        shell,
        screen,
        data,
        cx,
    };
    ui.settle();
    ui
}

/// Opened on the workspace's Sessions page.
fn on_list(app: &mut TestAppContext) -> Ui {
    let mut ui = open(app);
    ui.click("nav-nav.sessions");
    assert!(ui.drawn("sessions-screen"));
    ui.data.clear_requests();
    ui
}

/// Opened on the rich session's page.
fn on_session(app: &mut TestAppContext) -> Ui {
    let mut ui = open(app);
    ui.open(&format!("/{W1}/sessions/{SHELL}?dir={ROOT_Q}"));
    assert!(ui.drawn("session-header"));
    ui.data.clear_requests();
    ui
}

impl Ui {
    fn settle(&mut self) {
        for _ in 0..3 {
            self.cx.run_until_parked();
            self.cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            });
        }
        self.cx.run_until_parked();
    }

    /// Past the search's debounces.
    fn wait(&mut self) {
        self.cx.executor().advance_clock(Duration::from_millis(350));
        self.settle();
    }

    fn drawn(&mut self, selector: &'static str) -> bool {
        self.cx.debug_bounds(selector).is_some()
    }

    fn click(&mut self, selector: &'static str) {
        let b = self
            .cx
            .debug_bounds(selector)
            .unwrap_or_else(|| panic!("{selector} isn't on screen"));
        self.cx.simulate_click(b.center(), Modifiers::none());
        self.settle();
    }

    fn keys(&mut self, keystrokes: &str) {
        self.cx.simulate_keystrokes(keystrokes);
        self.settle();
    }

    fn type_text(&mut self, text: &str) {
        self.cx.simulate_input(text);
        self.settle();
    }

    fn open(&mut self, url: &str) {
        let shell = self.shell.clone();
        self.cx
            .update(|_, cx| shell.update(cx, |s, cx| s.open_url(url, cx)));
        self.settle();
    }

    fn route(&mut self) -> Route {
        let shell = self.shell.clone();
        self.cx.read(|cx| shell.read(cx).state().route().clone())
    }

    fn screen<T>(&mut self, f: impl FnOnce(&SessionsScreen) -> T) -> T {
        let screen = self.screen.clone();
        self.cx.read(|cx| f(screen.read(cx)))
    }

    fn listed(&mut self) -> Vec<String> {
        self.screen(|s| {
            s.list()
                .expect("the list page")
                .filtered()
                .iter()
                .map(|r| r.session_id.clone())
                .collect()
        })
    }

    fn selected(&mut self) -> Option<String> {
        self.screen(|s| s.list().and_then(|l| l.selected().map(str::to_owned)))
    }

    fn active_tab(&mut self) -> Option<String> {
        let shell = self.shell.clone();
        self.cx.read(|cx| {
            let s = shell.read(cx).state();
            let ws = s.active_workspace()?.id.clone();
            s.strip(&ws)?.active().map(str::to_owned)
        })
    }

    fn tabs(&mut self) -> Vec<String> {
        let shell = self.shell.clone();
        self.cx.read(|cx| {
            let s = shell.read(cx).state();
            s.strip(W1).unwrap().tabs().to_vec()
        })
    }
}

fn session_route(id: &str) -> Route {
    Route::page(
        W1,
        WorkspacePage::Session {
            id: id.into(),
            dir: Some(ROOT.into()),
        },
    )
}

#[test]
fn the_sessions_route_draws_the_workspaces_list() {
    let mut app = app();
    let mut ui = open(&mut app);
    // Elsewhere the screen isn't drawn and fetches nothing.
    assert!(!ui.drawn("sessions-screen"));
    assert!(ui.data.requests().is_empty());
    ui.click("nav-nav.sessions");
    assert_eq!(ui.route(), Route::page(W1, WorkspacePage::Sessions));
    assert_eq!(
        ui.data.requests(),
        [SessionsRequest::List {
            dir: Some(ROOT.into()),
            limit: 200
        }]
    );
    for sel in [
        "sessions-header",
        "sessions-search",
        "sessions-search-transcripts",
        "sessions-refresh",
        "sessions-branches",
        "branch-all",
        "sessions-unread-filter",
        "sessions-list",
        "session-row-0",
        "session-open-0",
        "session-account-0",
        "session-row-unread-1",
    ] {
        assert!(ui.drawn(sel), "{sel}");
    }
    assert!(!ui.drawn("sessions-confirm"));
    assert!(!ui.drawn("sessions-search-status"));
    assert!(!ui.drawn("sessions-load-more"));
    assert_eq!(ui.listed().len(), 16);
    // The list is laid out top to bottom.
    let a = ui.cx.debug_bounds("session-row-0").unwrap();
    let b = ui.cx.debug_bounds("session-row-1").unwrap();
    assert!(b.origin.y >= a.origin.y + a.size.height);
    // A click on a row opens its page.
    ui.click("session-open-1");
    assert_eq!(ui.route(), session_route(FLAKY));
    assert!(ui.drawn("session-header") && ui.drawn("session-transcript"));
    assert!(!ui.drawn("sessions-list"));
}

#[test]
fn typing_in_the_search_box_narrows_the_list_and_enter_opens_the_best() {
    let mut app = app();
    let mut ui = on_list(&mut app);
    ui.click("sessions-search");
    ui.type_text("login");
    // The field search is immediate.
    assert_eq!(ui.listed()[..2], [LOGIN_PAGE, LOGIN_FIX]);
    assert!(ui.drawn("session-row-1"));
    ui.wait();
    // "Search in transcripts" is off: no content scan.
    assert!(ui.data.requests().is_empty());
    ui.type_text(" page");
    assert_eq!(ui.listed(), [LOGIN_PAGE]);
    assert!(!ui.drawn("session-row-1"));
    ui.keys("enter");
    assert_eq!(ui.route(), session_route(LOGIN_PAGE));
}

#[test]
fn a_query_with_no_match_says_so() {
    let mut app = app();
    let mut ui = on_list(&mut app);
    ui.click("sessions-search");
    ui.type_text("n:zzz-nothing");
    assert!(ui.screen(|s| s.list().unwrap().query_pending()));
    ui.wait();
    // Settled: the older search has nothing more to load.
    assert!(!ui.screen(|s| s.list().unwrap().query_pending()));
    assert!(ui.listed().is_empty());
    assert!(ui.drawn("sessions-search-status"));
    assert!(!ui.drawn("session-row-0"));
    // Coming back to the page starts over, the box emptied.
    ui.keys("cmd-alt-g");
    ui.keys("cmd-alt-s");
    assert_eq!(ui.route(), Route::page(W1, WorkspacePage::Sessions));
    assert_eq!(ui.listed().len(), 16);
    assert_eq!(ui.screen(|s| s.list().unwrap().filter().to_owned()), "");
    ui.click("sessions-search");
    ui.type_text("login");
    assert_eq!(
        ui.screen(|s| s.list().unwrap().filter().to_owned()),
        "login"
    );
}

#[test]
fn search_in_transcripts_asks_the_server_after_the_debounce() {
    let mut app = app();
    let mut ui = on_list(&mut app);
    ui.click("sessions-search-transcripts");
    ui.click("sessions-search");
    ui.type_text("bare scoped");
    assert!(ui.listed().is_empty());
    ui.wait();
    assert_eq!(
        ui.data.requests(),
        [SessionsRequest::Search {
            q: "bare scoped".into(),
            dir: ROOT.into()
        }]
    );
    assert_eq!(ui.listed(), [SHELL]);
    assert!(ui.drawn("session-snippet-0"));
}

#[test]
fn the_keys_move_the_selection_and_open_it() {
    let mut app = app();
    let mut ui = on_list(&mut app);
    // The page has the keyboard on arrival.
    ui.keys("down");
    assert_eq!(ui.selected().as_deref(), Some(SHELL));
    ui.keys("down");
    assert_eq!(ui.selected().as_deref(), Some(FLAKY));
    ui.keys("end");
    let last = ui.listed().last().cloned();
    assert_eq!(ui.selected(), last);
    ui.keys("home");
    ui.keys("down");
    assert_eq!(ui.selected().as_deref(), Some(FLAKY));
    ui.keys("enter");
    assert_eq!(ui.route(), session_route(FLAKY));
    // The shell's shortcuts still work from the page, and after it.
    ui.keys("cmd-alt-g");
    assert_eq!(ui.route(), Route::page(W1, WorkspacePage::Git));
    ui.keys("cmd-alt-s");
    assert_eq!(ui.route(), Route::page(W1, WorkspacePage::Sessions));
    ui.keys("cmd-alt-c");
    assert_eq!(ui.route(), Route::chat(W1));
    ui.keys("cmd-alt-s");
    assert_eq!(ui.route(), Route::page(W1, WorkspacePage::Sessions));
}

#[test]
fn find_session_focuses_the_search_box() {
    let mut app = app();
    let mut ui = on_list(&mut app);
    ui.keys("down");
    ui.keys("cmd-f");
    ui.type_text("fork");
    assert_eq!(ui.screen(|s| s.list().unwrap().filter().to_owned()), "fork");
    assert!(ui.listed().len() < 16);
}

#[test]
fn resume_opens_the_session_in_a_chat_tab() {
    let mut app = app();
    let mut ui = on_list(&mut app);
    assert!(!ui.tabs().contains(&LOGIN_PAGE.to_owned()));
    ui.click("sessions-search");
    ui.type_text("Login page redesign");
    ui.click("session-resume-0");
    let route = ui.route();
    assert!(
        matches!(&route, Route::Workspace { id, page: WorkspacePage::Chat { .. } } if id == W1),
        "{route:?}"
    );
    assert_eq!(ui.active_tab().as_deref(), Some(LOGIN_PAGE));
    assert!(ui.tabs().contains(&LOGIN_PAGE.to_owned()));
    assert!(!ui.drawn("sessions-screen"));
    // Resume is navigation only.
    assert!(ui.data.requests().is_empty());
}

#[test]
fn delete_on_the_list_asks_first() {
    let mut app = app();
    let mut ui = on_list(&mut app);
    let third = ui.listed()[2].clone();
    ui.click("session-delete-2");
    assert!(ui.drawn("sessions-confirm"));
    ui.click("sessions-confirm-no");
    assert!(!ui.drawn("sessions-confirm"));
    assert!(ui.data.requests().is_empty());
    // Escape dismisses too.
    ui.click("session-delete-2");
    ui.keys("escape");
    assert!(!ui.drawn("sessions-confirm"));
    assert!(ui.data.requests().is_empty());
    ui.click("session-delete-2");
    ui.click("sessions-confirm-yes");
    let requests = ui.data.requests();
    assert_eq!(
        requests[0],
        SessionsRequest::Delete {
            id: third.clone(),
            dir: Some(ROOT.into())
        }
    );
    assert!(matches!(requests[1], SessionsRequest::List { .. }));
    assert_eq!(ui.listed().len(), 15);
    assert!(!ui.listed().contains(&third));
    // Enter answers yes.
    let next = ui.listed()[2].clone();
    ui.click("session-delete-2");
    ui.keys("enter");
    assert!(!ui.listed().contains(&next));
    assert_eq!(ui.route(), Route::page(W1, WorkspacePage::Sessions));
}

#[test]
fn a_failed_delete_shows_the_error() {
    let mut app = app();
    let mut ui = on_list(&mut app);
    ui.data.answer_next(
        |r| matches!(r, SessionsRequest::Delete { .. }),
        Ok(Reply::json(
            500,
            &json!({"error": "EACCES: permission denied"}),
        )),
    );
    assert!(!ui.drawn("sessions-action-error"));
    ui.click("session-delete-0");
    ui.click("sessions-confirm-yes");
    assert!(ui.drawn("sessions-action-error"));
    assert_eq!(
        ui.screen(|s| s.list().unwrap().action_error().map(str::to_owned)),
        Some("Delete failed (3e9a7c41): EACCES: permission denied".into())
    );
    assert_eq!(ui.listed().len(), 16);
}

#[test]
fn a_change_elsewhere_rereads_the_list() {
    let mut app = app();
    let mut ui = on_list(&mut app);
    ui.data.change(SessionsChange::List { dir: None }, |f| {
        f.sessions.retain(|s| s.session_id != FLAKY)
    });
    ui.settle();
    assert_eq!(ui.data.requests().len(), 1);
    assert_eq!(ui.listed().len(), 15);
    // New notifications: the provider's counts.
    ui.data.change(
        SessionsChange::Unread {
            workspace_id: W1.into(),
        },
        |f| {
            f.unread.get_mut(W1).unwrap().insert(SHELL.into(), 4);
        },
    );
    ui.settle();
    assert!(ui.drawn("session-row-unread-0"));
}

#[test]
fn the_session_page_draws_its_header_and_transcript() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.data.clear_requests();
    ui.open(&format!("/{W1}/sessions/{SHELL}?dir={ROOT_Q}"));
    assert_eq!(ui.route(), session_route(SHELL));
    assert_eq!(
        ui.data.requests(),
        [
            SessionsRequest::Info {
                id: SHELL.into(),
                dir: Some(ROOT.into())
            },
            SessionsRequest::Transcript {
                id: SHELL.into(),
                dir: Some(ROOT.into())
            },
        ]
    );
    for sel in [
        "session-header",
        "session-back",
        "session-title",
        "session-rename",
        "session-resume",
        "session-fork",
        "session-export",
        "session-raw",
        "session-delete",
        "session-meta",
        "session-transcript",
        "transcript-user-0",
        "transcript-assistant-1",
        "transcript-compaction-3",
        "transcript-rewind-0",
    ] {
        assert!(ui.drawn(sel), "{sel}");
    }
    assert!(!ui.drawn("session-detail-error"));
    // The divider folds the summary away until asked.
    let folded = ui.cx.debug_bounds("transcript-compaction-3").unwrap();
    ui.click("transcript-summary-3");
    let open = ui.cx.debug_bounds("transcript-compaction-3").unwrap();
    assert!(open.size.height > folded.size.height + px(20.));
    ui.click("transcript-summary-3");
    let closed = ui.cx.debug_bounds("transcript-compaction-3").unwrap();
    assert_eq!(closed.size.height, folded.size.height);
    // "Raw" swaps the rows for the JSON lines.
    ui.click("session-raw");
    assert!(ui.drawn("session-raw-text") && !ui.drawn("transcript-user-0"));
    ui.click("session-raw");
    assert!(ui.drawn("transcript-user-0"));
    // ← goes back to the list.
    ui.click("session-back");
    assert_eq!(ui.route(), Route::page(W1, WorkspacePage::Sessions));
    assert!(ui.drawn("sessions-list"));
}

#[test]
fn an_unknown_session_says_why() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.open(&format!("/{W1}/sessions/no-such-session"));
    assert!(ui.drawn("session-detail-error"));
    assert_eq!(
        ui.screen(|s| s.detail().unwrap().error().map(str::to_owned)),
        Some("info: 404".into())
    );
}

#[test]
fn rename_saves_the_new_title() {
    let mut app = app();
    let mut ui = on_session(&mut app);
    assert!(!ui.drawn("session-rename-input"));
    ui.click("session-rename");
    assert!(ui.drawn("session-rename-input"));
    assert!(ui.drawn("session-rename-save") && ui.drawn("session-rename-cancel"));
    // The box has the title, and the keyboard.
    ui.keys("cmd-a");
    ui.type_text("Shell, ported");
    ui.click("session-rename-save");
    let requests = ui.data.requests();
    assert_eq!(
        requests[0],
        SessionsRequest::Rename {
            session_id: SHELL.into(),
            title: "Shell, ported".into(),
            dir: Some(ROOT.into())
        }
    );
    // Then it reads itself again.
    assert_eq!(requests.len(), 3);
    assert!(!ui.drawn("session-rename-input"));
    assert_eq!(
        ui.screen(|s| s.detail().unwrap().title(2026)),
        "Shell, ported"
    );
    // Enter saves too.
    ui.click("session-rename");
    ui.keys("cmd-a");
    ui.type_text("Again");
    ui.keys("enter");
    assert_eq!(ui.screen(|s| s.detail().unwrap().title(2026)), "Again");
    assert!(!ui.drawn("session-rename-input"));
}

#[test]
fn rename_cancels_on_escape_and_on_cancel() {
    let mut app = app();
    let mut ui = on_session(&mut app);
    ui.click("session-rename");
    ui.type_text(" (draft)");
    ui.keys("escape");
    assert!(!ui.drawn("session-rename-input"));
    ui.click("session-rename");
    ui.click("session-rename-cancel");
    assert!(!ui.drawn("session-rename-input"));
    assert!(ui.data.requests().is_empty());
    assert_eq!(
        ui.screen(|s| s.detail().unwrap().title(2026)),
        "Port the app shell to GPUI"
    );
    // The page has the keyboard back: Escape on the page does nothing,
    // the shell's shortcuts work.
    ui.keys("cmd-alt-s");
    assert_eq!(ui.route(), Route::page(W1, WorkspacePage::Sessions));
}

#[test]
fn a_failed_rename_shows_the_error() {
    let mut app = app();
    let mut ui = on_session(&mut app);
    ui.data.answer_next(
        |r| matches!(r, SessionsRequest::Rename { .. }),
        Ok(Reply::json(500, &json!({"error": "index is read-only"}))),
    );
    ui.click("session-rename");
    ui.keys("enter");
    assert!(ui.drawn("session-detail-error"));
    assert!(ui.drawn("session-rename-input"), "the box stays open");
    assert_eq!(
        ui.screen(|s| s.detail().unwrap().error().map(str::to_owned)),
        Some("Rename failed: index is read-only".into())
    );
}

#[test]
fn delete_on_the_session_page_asks_then_returns_to_the_list() {
    let mut app = app();
    let mut ui = on_session(&mut app);
    ui.click("session-delete");
    assert!(ui.drawn("sessions-confirm"));
    ui.click("sessions-confirm-no");
    assert!(!ui.drawn("sessions-confirm"));
    ui.click("session-delete");
    ui.keys("escape");
    assert!(!ui.drawn("sessions-confirm"));
    assert!(ui.data.requests().is_empty());
    // Enter answers yes.
    ui.click("session-delete");
    ui.keys("enter");
    assert_eq!(
        ui.data.requests()[0],
        SessionsRequest::Delete {
            id: SHELL.into(),
            dir: Some(ROOT.into())
        }
    );
    assert_eq!(ui.route(), Route::page(W1, WorkspacePage::Sessions));
    assert!(!ui.listed().contains(&SHELL.to_owned()));
}

#[test]
fn fork_opens_the_copy_and_resume_the_chat() {
    let mut app = app();
    let mut ui = on_session(&mut app);
    ui.click("session-fork");
    let new = "f0f0f0f0-0000-4000-8000-000000000001";
    assert_eq!(ui.route(), session_route(new));
    assert_eq!(ui.screen(|s| s.detail().unwrap().messages().len()), 13);
    ui.click("session-resume");
    assert_eq!(ui.active_tab().as_deref(), Some(new));
}

#[test]
fn rewind_forks_up_to_the_turn_into_the_chat() {
    let mut app = app();
    let mut ui = on_session(&mut app);
    ui.click("transcript-rewind-0");
    let new = "f0f0f0f0-0000-4000-8000-000000000001";
    assert_eq!(
        ui.data.requests()[0],
        SessionsRequest::Fork {
            session_id: SHELL.into(),
            up_to_message_id: Some("00000000-0000-4000-8000-000000000001".into()),
            dir: Some(ROOT.into())
        }
    );
    assert_eq!(ui.active_tab().as_deref(), Some(new));
}

#[test]
fn export_writes_the_text_where_it_was_told() {
    let mut app = app();
    let mut ui = on_session(&mut app);
    let dir = std::env::temp_dir().join(format!("claudius-sessions-export-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let screen = ui.screen.clone();
    let d = dir.clone();
    ui.cx
        .update(|_, cx| screen.update(cx, |s, _| s.set_export_dir(d)));
    ui.click("session-export");
    let file = dir.join(format!("claudius-session-{SHELL}.txt"));
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("User: Port the Next.js"));
    assert!(ui.drawn("session-notice"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_light_theme_draws_the_same_screen() {
    let mut app = app_in(ThemeName::Light);
    let mut ui = open_in(&mut app, ThemeName::Light);
    ui.click("nav-nav.sessions");
    assert!(ui.drawn("session-row-0"));
    let shell = ui.shell.clone();
    assert_eq!(ui.cx.read(|cx| shell.read(cx).theme()), ThemeName::Light);
    ui.click("session-open-0");
    assert!(ui.drawn("transcript-user-0"));
}

/// A source that holds the answers `hold` picks until released (a slow
/// server), the rest answered at once.
struct Held {
    inner: Arc<FixtureSessionsData>,
    hold: fn(&SessionsRequest) -> bool,
    gates: Mutex<Vec<futures::channel::oneshot::Sender<()>>>,
}

impl Held {
    fn new(inner: Arc<FixtureSessionsData>, hold: fn(&SessionsRequest) -> bool) -> Arc<Held> {
        Arc::new(Held {
            inner,
            hold,
            gates: Mutex::new(Vec::new()),
        })
    }

    fn take(&self) -> Vec<futures::channel::oneshot::Sender<()>> {
        std::mem::take(&mut *self.gates.lock().unwrap())
    }
}

impl SessionsData for Held {
    fn send(&self, request: SessionsRequest) -> DataFuture<Reply> {
        let held = (self.hold)(&request);
        let reply = self.inner.send(request);
        if !held {
            return reply;
        }
        let (tx, rx) = futures::channel::oneshot::channel();
        self.gates.lock().unwrap().push(tx);
        async move {
            rx.await.ok();
            reply.await
        }
        .boxed()
    }

    fn unread(&self, workspace_id: &str) -> BTreeMap<String, u32> {
        self.inner.unread(workspace_id)
    }

    fn subscribe(&self) -> UnboundedReceiver<SessionsChange> {
        self.inner.subscribe()
    }
}

#[test]
fn a_late_answer_for_a_page_left_behind_is_dropped() {
    let mut app = app();
    let inner = Arc::new(FixtureSessionsData::builtin());
    let held = Held::new(inner.clone(), |r| matches!(r, SessionsRequest::List { .. }));
    let sessions: Arc<dyn SessionsData> = held.clone();
    let mut ui = open_with(&mut app, ThemeName::Dark, inner, sessions);
    ui.click("nav-nav.sessions");
    assert!(ui.screen(|s| s.list().unwrap().loading()));
    // Another workspace's Sessions page before the first answer lands:
    // both are their list's first fetch.
    ui.open(&format!("/{W2}/sessions"));
    let gates = held.take();
    assert_eq!(gates.len(), 2);
    let mut gates = gates.into_iter();
    gates.next().unwrap().send(()).unwrap();
    ui.settle();
    assert!(ui.screen(|s| s.list().unwrap().loading()));
    assert!(
        ui.listed().is_empty(),
        "the first workspace's rows stay out"
    );
    gates.next().unwrap().send(()).unwrap();
    ui.settle();
    assert_eq!(ui.listed().len(), 9);
    assert!(!ui.screen(|s| s.list().unwrap().loading()));
}

#[test]
fn a_late_answer_for_a_session_left_behind_is_dropped() {
    let mut app = app();
    let inner = Arc::new(FixtureSessionsData::builtin());
    let held = Held::new(inner.clone(), |r| {
        matches!(
            r,
            SessionsRequest::Info { .. } | SessionsRequest::Transcript { .. }
        )
    });
    let sessions: Arc<dyn SessionsData> = held.clone();
    let mut ui = open_with(&mut app, ThemeName::Dark, inner, sessions);
    ui.open(&format!("/{W1}/sessions/{SHELL}?dir={ROOT_Q}"));
    // Another session's page before the first one's answers land: both
    // are their page's first load.
    ui.open(&format!("/{W1}/sessions/{FLAKY}?dir={ROOT_Q}"));
    let gates = held.take();
    assert_eq!(gates.len(), 4);
    let mut gates = gates.into_iter();
    for gate in gates.by_ref().take(2) {
        gate.send(()).unwrap();
    }
    ui.settle();
    assert!(ui.screen(|s| s.detail().unwrap().loading()));
    assert!(ui.screen(|s| s.detail().unwrap().info().is_none()));
    for gate in gates {
        gate.send(()).unwrap();
    }
    ui.settle();
    assert_eq!(
        ui.screen(|s| s.detail().unwrap().title(2026)),
        "Fix flaky e2e: session tabs"
    );
}
