//! The sessions browser (U11b) over the engine in this process: the
//! sessions data is `TransportSessionsData` over the engine's transport, as
//! `main.rs` wires it. A temp HOME (its `.claude` the config dir, the
//! default layout) and the fake CLI, never `~/.claude` or the real
//! `claude`; three sessions are made by real turns, whose scripts write
//! their transcripts as the CLI does (`support/sessions_seed.rs`).
//!
//! First the pages' models, driven as the screen drives them: the list
//! shows the sessions, the turns' notifications badge them, a session's
//! info and transcript read, the transcript search finds a phrase (and
//! takes a pattern literally), rename shows the new title and announces
//! the listing, fork and rewind add sessions, export returns the text,
//! delete removes a session and its file. Then the shell's sessions screen
//! in a headless GPUI window over the same data: a rename made elsewhere
//! re-reads its list once, and a turn's notification moves a row's badge.
//! macOS (the CoreText text system). One test: one world per process.

#![cfg(target_os = "macos")]

#[path = "support/sessions_seed.rs"]
mod sessions_seed;
#[path = "../../../../crates/claudius-agent/tests/support/test_bins.rs"]
mod test_bins;
#[path = "support/world.rs"]
mod world;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use claudius_app::data::{DataFuture, OpenTabsPut, ShellData};
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::sessions::data::{Reply, SessionsChange, SessionsData, SessionsRequest};
use claudius_app::sessions::detail::{DetailEffect, SessionDetail};
use claudius_app::sessions::list::{ListEffect, SessionsList};
use claudius_app::sessions::live::TransportSessionsData;
use claudius_app::shell::{Appearance, Shell};
use claudius_app::store::LocalStore;
use claudius_gpui_theme::ThemeName;
use claudius_transport::CookieJar;
use futures::channel::mpsc::UnboundedReceiver;
use futures::executor::block_on;
use gpui::{Entity, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use sessions_seed::{Seeded, Spec, project_dir, seed};
use world::{wait_for, world_with};

const LIMIT: Duration = Duration::from_secs(30);
const YEAR: i32 = 2026;

/// What a page asked for besides its requests.
#[derive(Debug, Default)]
struct Out {
    opened: Vec<String>,
    saved: Vec<(String, String)>,
}

fn answer(data: &dyn SessionsData, request: SessionsRequest) -> Result<Reply, String> {
    block_on(data.send(request)).map_err(|e| e.to_string())
}

/// Runs the list's effects to quiescence, as the screen does (`drive`
/// after each batch).
fn run_list(list: &mut SessionsList, data: &dyn SessionsData, fx: Vec<ListEffect>) -> Out {
    let mut out = Out::default();
    let mut queue: VecDeque<ListEffect> = fx.into();
    loop {
        while let Some(e) = queue.pop_front() {
            match e {
                ListEffect::Send(call, request) => {
                    let reply = answer(data, request);
                    queue.extend(list.replied(call, reply));
                }
                ListEffect::Open(url) => out.opened.push(url),
                ListEffect::Save { filename, text } => out.saved.push((filename, text)),
            }
        }
        let more = list.drive();
        if more.is_empty() {
            return out;
        }
        queue.extend(more);
    }
}

fn run_detail(detail: &mut SessionDetail, data: &dyn SessionsData, fx: Vec<DetailEffect>) -> Out {
    let mut out = Out::default();
    let mut queue: VecDeque<DetailEffect> = fx.into();
    while let Some(e) = queue.pop_front() {
        match e {
            DetailEffect::Send(call, request) => {
                let reply = answer(data, request);
                queue.extend(detail.replied(call, reply));
            }
            DetailEffect::Open(url) => out.opened.push(url),
            DetailEffect::Save { filename, text } => out.saved.push((filename, text)),
        }
    }
    out
}

fn ids(list: &SessionsList) -> Vec<String> {
    let mut ids: Vec<String> = list.scoped().iter().map(|s| s.session_id.clone()).collect();
    ids.sort();
    ids
}

fn sorted(v: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = v.iter().map(|s| (*s).to_owned()).collect();
    v.sort();
    v
}

fn title_of(list: &SessionsList, id: &str) -> Option<String> {
    list.rows(0., YEAR)
        .into_iter()
        .find(|r| r.id == id)
        .map(|r| r.title)
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn drain(rx: &mut UnboundedReceiver<SessionsChange>) -> Vec<SessionsChange> {
    let mut out = Vec::new();
    while let Ok(c) = rx.try_recv() {
        out.push(c);
    }
    out
}

/// The live data, counting the listings the screen asks for.
struct Counted {
    inner: Arc<TransportSessionsData>,
    lists: Mutex<u32>,
}

impl SessionsData for Counted {
    fn send(&self, request: SessionsRequest) -> DataFuture<Reply> {
        if matches!(request, SessionsRequest::List { .. }) {
            *self.lists.lock().unwrap() += 1;
        }
        self.inner.send(request)
    }
    fn unread(&self, workspace_id: &str) -> BTreeMap<String, u32> {
        self.inner.unread(workspace_id)
    }
    fn subscribe(&self) -> UnboundedReceiver<SessionsChange> {
        self.inner.subscribe()
    }
}

/// Runs the GPUI tasks and draws.
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

/// Settles until `f` answers over the screen's list (the engine works on
/// its own threads).
fn wait_list<T>(
    cx: &mut VisualTestContext,
    shell: &Entity<Shell>,
    what: &str,
    mut f: impl FnMut(&mut VisualTestContext, &SessionsList) -> Option<T>,
) -> T {
    let t0 = Instant::now();
    loop {
        settle(cx);
        let screen = cx.read(|cx| shell.read(cx).sessions_screen().cloned());
        let list = screen.and_then(|s| cx.read(|cx| s.read(cx).list().cloned()));
        if let Some(v) = list.as_ref().and_then(|l| f(cx, l)) {
            return v;
        }
        assert!(t0.elapsed() < LIMIT, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_sessions_browser_runs_over_the_in_process_engine() {
    let w = world_with(test_bins::fake_claude(), &["Sessions Live"], true);
    let ws = w.workspaces[0].clone();
    let root = ws.root_path.clone();
    let specs = [
        Spec {
            ago: Duration::ZERO,
            branch: "main",
            turns: &[
                (
                    "Port the sessions browser to GPUI",
                    "The list, the search and the one-session page are in.",
                ),
                (
                    "Now wire it to the engine",
                    "Every request goes through the transport now.",
                ),
            ],
        },
        Spec {
            ago: Duration::ZERO,
            branch: "feat/unread",
            turns: &[(
                "Find the flaky unread badge",
                "The badge reads the notifications stream, marmalade and all.",
            )],
        },
        Spec {
            ago: Duration::ZERO,
            branch: "main",
            turns: &[("Write the export", "Plain text, one block per message.")],
        },
    ];
    let seeded: Vec<Seeded> = specs
        .iter()
        .enumerate()
        .map(|(n, spec)| seed(&w, &ws, n, spec, LIMIT))
        .collect();
    let (s0, s1, s2) = (&seeded[0], &seeded[1], &seeded[2]);

    let live = Arc::new(TransportSessionsData::new(
        w.backend.transport(Arc::new(CookieJar::new())),
        w.backend.handle(),
    ));
    let data: &dyn SessionsData = live.as_ref();
    let mut changes = data.subscribe();

    // ── the list: the three sessions the turns wrote, scoped to the root
    let mut list = SessionsList::new(&ws.id, Some(&root));
    let fx = list.start();
    run_list(&mut list, data, fx);
    assert_eq!(list.error(), None);
    assert!(!list.loading());
    assert_eq!(ids(&list), sorted(&[&s0.id, &s1.id, &s2.id]));
    let first = list
        .scoped()
        .into_iter()
        .find(|s| s.session_id == s0.id)
        .cloned()
        .unwrap();
    assert_eq!(first.cwd.as_deref(), Some(root.as_str()));
    assert_eq!(
        first.first_prompt.as_deref(),
        Some("Port the sessions browser to GPUI")
    );
    assert_eq!(
        list.branches(),
        vec![("main".to_owned(), 2), ("feat/unread".to_owned(), 1)]
    );

    // ── each turn's "finished a turn" notification badges its row
    let unread = wait_for("the unread counts", LIMIT, || {
        let u = data.unread(&ws.id);
        seeded
            .iter()
            .all(|s| u.get(&s.id).is_some_and(|n| *n > 0))
            .then_some(u)
    });
    assert!(drain(&mut changes).contains(&SessionsChange::Unread {
        workspace_id: ws.id.clone()
    }));
    list.set_unread(unread);
    assert_eq!(list.unread_summary(), (3, 3));

    // ── one session: its info and its transcript
    let mut detail = SessionDetail::new(&s0.id, Some(&root));
    let fx = detail.load();
    run_detail(&mut detail, data, fx);
    assert_eq!(detail.error(), None);
    assert_eq!(detail.info().unwrap().session_id, s0.id);
    assert_eq!(detail.messages().len(), 4);
    let meta = detail.meta();
    assert!(meta.contains(&root), "{meta:?}");
    assert!(meta.contains(&"branch: main".to_owned()), "{meta:?}");
    assert!(meta.contains(&"4 messages".to_owned()), "{meta:?}");
    let raw = detail.raw();
    assert!(raw.contains("Every request goes through the transport now."));
    // An unknown session is the info route's 404.
    let mut missing = SessionDetail::new("00000000-0000-4000-8000-00000000dead", Some(&root));
    let fx = missing.load();
    run_detail(&mut missing, data, fx);
    assert_eq!(missing.error(), Some("info: 404"));

    // ── "Search in transcripts" finds the phrase; a pattern is a literal
    list.set_search_transcripts(true);
    list.set_filter("MARMALADE");
    let fx = list.content_search_due();
    assert_eq!(fx.len(), 1);
    run_list(&mut list, data, fx);
    assert!(!list.content_searching());
    let rows = list.rows(0., YEAR);
    assert_eq!(
        rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec![s1.id.as_str()]
    );
    assert!(
        rows[0].snippet.as_deref().unwrap().contains("marmalade"),
        "{rows:?}"
    );
    for pattern in [".*", "(a+)+$", "[mM]armalade"] {
        list.set_filter(pattern);
        let fx = list.content_search_due();
        run_list(&mut list, data, fx);
        assert!(list.rows(0., YEAR).is_empty(), "{pattern}");
    }
    list.set_filter("");
    list.set_search_transcripts(false);
    let fx = list.content_search_due();
    run_list(&mut list, data, fx);
    assert_eq!(list.rows(0., YEAR).len(), 3);
    drain(&mut changes);

    // ── rename: the page shows the new title, and the listing is announced
    detail.start_rename();
    detail.set_draft("  Wire the sessions browser  ");
    let fx = detail.save_rename();
    run_detail(&mut detail, data, fx);
    assert_eq!(detail.error(), None);
    assert!(!detail.renaming());
    assert_eq!(detail.title(YEAR), "Wire the sessions browser");
    let announced = drain(&mut changes);
    assert!(
        announced.contains(&SessionsChange::List {
            dir: Some(root.clone())
        }),
        "{announced:?}"
    );
    // What the screen does on it: the list re-reads.
    let fx = list.changed();
    run_list(&mut list, data, fx);
    assert_eq!(
        title_of(&list, &s0.id).as_deref(),
        Some("Wire the sessions browser")
    );

    // ── fork: a new session, opened on its page; the listing announced
    let fx = detail.fork();
    let out = run_detail(&mut detail, data, fx);
    assert_eq!(detail.error(), None);
    let qs = format!("?dir={}", encode_uri_component(&root));
    let fork = out.opened[0]
        .strip_prefix("/sessions/")
        .and_then(|r| r.strip_suffix(qs.as_str()))
        .unwrap_or_else(|| panic!("{:?}", out.opened))
        .to_owned();
    assert!(project_dir(&root).join(format!("{fork}.jsonl")).is_file());
    assert!(drain(&mut changes).contains(&SessionsChange::List {
        dir: Some(root.clone())
    }));
    // "Rewind here" at the first answer: a fork up to it, in the chat.
    let fx = detail.rewind(&s0.uuids[1]);
    let out = run_detail(&mut detail, data, fx);
    assert_eq!(detail.error(), None);
    assert_eq!(detail.rewinding(), None);
    let rewound = out.opened[0]
        .strip_prefix("/?session=")
        .unwrap_or_else(|| panic!("{:?}", out.opened))
        .to_owned();
    let mut short = SessionDetail::new(&rewound, Some(&root));
    let fx = short.load();
    run_detail(&mut short, data, fx);
    assert_eq!(short.error(), None);
    assert_eq!(short.messages().len(), 2);
    let fx = list.changed();
    run_list(&mut list, data, fx);
    assert_eq!(
        ids(&list),
        sorted(&[&s0.id, &s1.id, &s2.id, &fork, &rewound])
    );

    // ── export: the plain-text transcript, as its attachment
    let fx = list.export(&s0.id);
    let out = run_list(&mut list, data, fx);
    assert_eq!(list.action_error(), None);
    let (filename, text) = &out.saved[0];
    assert_eq!(filename, &format!("claudius-session-{}.txt", s0.id));
    assert!(
        text.contains("Port the sessions browser to GPUI")
            && text.contains("Every request goes through the transport now."),
        "{text}"
    );
    let fx = detail.export();
    let out = run_detail(&mut detail, data, fx);
    assert_eq!(out.saved[0].1, *text);
    // A session that isn't there exports nothing (TS and Rust alike: an
    // empty text, as its attachment).
    let gone = "00000000-0000-4000-8000-00000000dead";
    let fx = list.export(gone);
    let out = run_list(&mut list, data, fx);
    assert_eq!(list.action_error(), None);
    assert_eq!(
        out.saved,
        vec![(format!("claudius-session-{gone}.txt"), String::new())]
    );
    // An id the header can't carry is the route's 500 text.
    let fx = list.export("\u{4e2d}");
    run_list(&mut list, data, fx);
    assert_eq!(
        list.action_error(),
        Some("Export failed (\u{4e2d}): failed to export session")
    );

    // ── delete: from the list (the rewind) and from its page (the fork)
    drain(&mut changes);
    list.ask_delete(&rewound);
    let fx = list.confirm_delete(true);
    run_list(&mut list, data, fx);
    assert_eq!(list.action_error(), None);
    assert!(!ids(&list).contains(&rewound));
    assert!(!project_dir(&root).join(format!("{rewound}.jsonl")).exists());
    let mut doomed = SessionDetail::new(&fork, Some(&root));
    let fx = doomed.load();
    run_detail(&mut doomed, data, fx);
    doomed.ask_delete();
    let fx = doomed.confirm_delete(true);
    let out = run_detail(&mut doomed, data, fx);
    assert_eq!(out.opened, vec!["/sessions".to_owned()]);
    assert!(!project_dir(&root).join(format!("{fork}.jsonl")).exists());
    assert_eq!(
        drain(&mut changes),
        vec![
            SessionsChange::List {
                dir: Some(root.clone())
            };
            2
        ]
    );
    let fx = list.refresh();
    run_list(&mut list, data, fx);
    assert_eq!(ids(&list), sorted(&[&s0.id, &s1.id, &s2.id]));

    // ── the screen, over the same data, in the shell
    // The chat binds the first session rather than making a new one.
    block_on(w.data.put_open_tabs(
        &ws.id,
        OpenTabsPut {
            tabs: Some(vec![s0.id.clone()]),
            active_id: Some(Some(s0.id.clone())),
            pinned: Some(vec![]),
            label_max_width: None,
        },
    ))
    .unwrap();
    let counted = Arc::new(Counted {
        inner: live.clone(),
        lists: Mutex::new(0),
    });
    let mut app = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    app.update(|cx| claudius_app::init(ThemeName::Light, cx));
    let shell_data: Arc<dyn ShellData> = w.data.clone();
    let sessions: Arc<dyn SessionsData> = counted.clone();
    let store_path = w.root.path().join("local-storage.json");
    let store = LocalStore::open(&store_path);
    let (shell, cx) = app.add_window_view(|window, cx| {
        Shell::with_store(
            shell_data,
            Appearance::Fixed(ThemeName::Light),
            store,
            window,
            cx,
        )
        .with_sessions(sessions, window, cx)
    });
    cx.simulate_resize(size(px(1440.), px(900.)));
    let t0 = Instant::now();
    loop {
        settle(cx);
        if cx.read(|cx| shell.read(cx).state().active_workspace().is_some()) {
            break;
        }
        assert!(t0.elapsed() < LIMIT, "timed out waiting for the workspace");
        std::thread::sleep(Duration::from_millis(20));
    }
    shell.update(cx, |s, cx| {
        s.navigate(Route::page(&ws.id, WorkspacePage::Sessions), cx)
    });
    wait_list(cx, &shell, "the screen's rows", |_, l| {
        let rows = l.rows(0., YEAR);
        let s1_row = rows.iter().find(|r| r.id == s1.id)?;
        (!l.loading() && rows.iter().any(|r| r.id == s0.id) && s1_row.unread > 0).then_some(())
    });
    assert!(cx.debug_bounds("sessions-screen").is_some());
    let lists = *counted.lists.lock().unwrap();
    assert!(lists >= 1);

    // A rename made elsewhere (another page, say): one re-read, and the
    // screen's row shows it.
    let reply = answer(
        data,
        SessionsRequest::Rename {
            session_id: s1.id.clone(),
            title: "Hunt the flaky badge".into(),
            dir: Some(root.clone()),
        },
    )
    .unwrap();
    assert!(reply.ok(), "{reply:?}");
    wait_list(cx, &shell, "the renamed row", |_, l| {
        (!l.loading() && title_of(l, &s1.id).as_deref() == Some("Hunt the flaky badge"))
            .then_some(())
    });
    assert_eq!(*counted.lists.lock().unwrap(), lists + 1);

    // Another turn's notification: the row's badge moves, no re-read.
    let before = wait_list(cx, &shell, "s2's badge", |_, l| {
        l.rows(0., YEAR)
            .into_iter()
            .find(|r| r.id == s2.id)
            .map(|r| r.unread)
    });
    w.input(&ws.id, &s2.id, "one more turn");
    let (after, row) = wait_list(cx, &shell, "s2's badge to move", |_, l| {
        let rows = l.rows(0., YEAR);
        let i = rows.iter().position(|r| r.id == s2.id)?;
        (rows[i].unread > before).then_some((rows[i].unread, i))
    });
    assert_eq!(after, before + 1);
    let badge: &'static str = Box::leak(format!("session-row-unread-{row}").into_boxed_str());
    assert!(cx.debug_bounds(badge).is_some(), "{badge}");
    assert_eq!(*counted.lists.lock().unwrap(), lists + 1);

    drop(changes);
    w.shutdown();
}
