//! The Sessions page's model over the bundled fixture, without GPUI: the
//! scoped listing, search and ranking, the branch / unread / transcript
//! filters, paging and the older-session search, errors, the keyboard
//! selection, and each row action's request. The effects run against
//! `FixtureSessionsData` the way `SessionsScreen` runs them.

use chrono::Utc;
use claudius_app::sessions::data::{
    Reply, SessionsData, SessionsPage, SessionsRequest, StoredSession,
};
use claudius_app::sessions::fixture::FixtureSessionsData;
use claudius_app::sessions::list::{
    EmptyState, ListCall, ListEffect, SessionsList, badge_count, resume_href,
};
use claudius_app::sessions::search::{self, OlderSearch};
use futures::executor::block_on;
use serde_json::json;

const W1: &str = "wks_3f2a9c81d0e4";
const ROOT: &str = "/Users/demo/src/claudius";
const ROOT_Q: &str = "%2FUsers%2Fdemo%2Fsrc%2Fclaudius";
const NOW: f64 = 1_795_723_200_000.;
const SHELL: &str = "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162";
const FLAKY: &str = "b7d24f19-6c3e-4a5b-9d8e-7f6a5b4c3d2e";
const UNTITLED: &str = "51c0e8a3-9f7b-4d2c-a1e6-0b9c8d7e6f5a";
const SSE: &str = "e2a96d07-4b1c-4f3e-8d5a-6c7b8a9f0e1d";
const LOGIN_FIX: &str = "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b";
const LOGIN_PAGE: &str = "d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a";

/// `SessionsScreen::run_list`, synchronously.
struct Harness {
    list: SessionsList,
    data: FixtureSessionsData,
    opened: Vec<String>,
    saved: Vec<(String, String)>,
}

impl Harness {
    fn new(root: Option<&str>) -> Harness {
        Harness::with(FixtureSessionsData::builtin(), root)
    }

    fn with(data: FixtureSessionsData, root: Option<&str>) -> Harness {
        let mut list = SessionsList::new(W1, root);
        list.set_unread(data.unread(W1));
        let mut h = Harness {
            list,
            data,
            opened: Vec::new(),
            saved: Vec::new(),
        };
        let start = h.list.start();
        h.run(start);
        h
    }

    fn run(&mut self, effects: Vec<ListEffect>) {
        for e in effects {
            match e {
                ListEffect::Send(call, request) => {
                    let reply = block_on(self.data.send(request)).map_err(|e| e.to_string());
                    let more = self.list.replied(call, reply);
                    self.run(more);
                }
                ListEffect::Open(url) => self.opened.push(url),
                ListEffect::Save { filename, text } => self.saved.push((filename, text)),
            }
        }
        let more = self.list.drive();
        if !more.is_empty() {
            self.run(more);
        }
    }

    fn act(&mut self, f: impl FnOnce(&mut SessionsList) -> Vec<ListEffect>) {
        let effects = f(&mut self.list);
        self.run(effects);
    }

    /// Types a query and lets both debounces fire.
    fn search(&mut self, q: &str) {
        self.list.set_filter(q);
        self.list.settle();
        let e = self.list.content_search_due();
        self.run(e);
    }

    fn ids(&self) -> Vec<String> {
        self.list
            .filtered()
            .iter()
            .map(|s| s.session_id.clone())
            .collect()
    }

    fn urls(&self) -> Vec<String> {
        self.data.requests().iter().map(|r| r.url()).collect()
    }
}

fn utc_date(ms: f64) -> String {
    search::locale_date(&Utc, ms)
}

#[test]
fn the_first_fetch_is_scoped_to_the_workspace() {
    let h = Harness::new(Some(ROOT));
    assert_eq!(
        h.urls(),
        [format!("/api/sessions/all?dir={ROOT_Q}&limit=200")]
    );
    assert!(!h.list.loading());
    assert_eq!(h.list.error(), None);
    // The fixture's 16 sessions in this workspace, newest first.
    assert_eq!(h.list.scoped().len(), 16);
    let ids = h.ids();
    assert_eq!(ids[0], SHELL);
    assert_eq!(ids[1], FLAKY);
    assert!(h.list.show_accounts());
    assert!(!h.list.has_more());
    assert_eq!(h.list.load_more_button(), None);
    assert_eq!(h.list.empty_state(), None);
}

#[test]
fn rows_carry_the_pages_columns() {
    let h = Harness::new(Some(ROOT));
    let rows = h.list.rows_with(NOW, 2026, &utc_date);
    let shell = &rows[0];
    assert_eq!(shell.title, "Port the app shell to GPUI");
    assert_eq!(shell.short_id, "3e9a7c41");
    assert_eq!(shell.relative, "2m ago");
    assert_eq!(shell.bytes, "1.8 MB");
    assert_eq!(shell.branch.as_deref(), Some("feat/rust-port"));
    assert_eq!(shell.cwd.as_deref(), Some(ROOT));
    assert_eq!(shell.account.as_deref(), Some("Work"));
    assert!(
        shell
            .first_prompt
            .as_deref()
            .unwrap()
            .starts_with("Port the Next.js")
    );
    assert_eq!(shell.snippet, None);
    assert_eq!(shell.unread, 0);
    assert_eq!(shell.href, format!("/sessions/{SHELL}?dir={ROOT_Q}"));
    // The SDK's title when Claudius has none; unread from the provider.
    assert_eq!(rows[1].title, "Fix flaky e2e: session tabs");
    assert_eq!(rows[1].unread, 2);
    assert_eq!(rows[1].relative, "14m ago");
    // No title at all: the creation time, never the prompt.
    let untitled = rows.iter().find(|r| r.id == UNTITLED).unwrap();
    assert!(untitled.title.contains(" at "), "{}", untitled.title);
    assert_eq!(untitled.bytes, "17.8 KB");
    // Older than a day: the date.
    let old = rows.iter().find(|r| r.relative.contains('/')).unwrap();
    assert_eq!(old.relative, "11/25/2026");
    // A long and a non-ASCII title come through whole.
    assert!(rows.iter().any(|r| r.title.len() > 200));
    assert!(rows.iter().any(|r| r.title.contains('\u{8bbe}')));
    assert_eq!(badge_count(100), "99+");
    assert_eq!(badge_count(99), "99");
}

#[test]
fn an_unknown_root_lists_every_session() {
    let h = Harness::new(None);
    assert_eq!(h.urls(), ["/api/sessions/all?limit=200"]);
    assert_eq!(h.list.scoped().len(), 30);
}

#[test]
fn a_second_root_refetches_with_the_page_size_reset() {
    let mut h = Harness::new(None);
    h.act(|l| l.load_more());
    assert_eq!(h.list.limit(), 400);
    h.act(|l| l.set_root(Some(ROOT)));
    assert_eq!(h.list.limit(), 200);
    assert_eq!(
        h.urls().last().unwrap(),
        &format!("/api/sessions/all?dir={ROOT_Q}&limit=200")
    );
    assert_eq!(h.list.scoped().len(), 16);
    // The same root again does nothing.
    assert!(h.list.set_root(Some(ROOT)).is_empty());
}

#[test]
fn search_ranks_titles_over_prompts_over_ids() {
    let mut h = Harness::new(Some(ROOT));
    h.search("login");
    // "Fix the login bug" (title, substring 60) and "Login page redesign"
    // (title, prefix 80) before any prompt hit.
    assert_eq!(h.ids()[..2], [LOGIN_PAGE, LOGIN_FIX]);
    h.search("LOGIN PAGE REDESIGN");
    assert_eq!(h.ids(), [LOGIN_PAGE]);
    // An id fragment, except with `n:`.
    h.search("3e9a7c");
    assert_eq!(h.ids(), [SHELL]);
    h.search("n:3e9a7c");
    assert!(h.ids().is_empty());
    // Names only still reads the first prompt.
    h.search("n: OAuth callback");
    assert_eq!(h.ids(), [LOGIN_FIX]);
    // Enter opens the best match.
    h.search("login");
    let best = h.list.open_best();
    assert_eq!(
        best,
        [ListEffect::Open(format!(
            "/sessions/{LOGIN_PAGE}?dir={ROOT_Q}"
        ))]
    );
    h.search("zzz-nothing");
    assert!(h.list.open_best().is_empty());
    assert_eq!(h.list.empty_state(), Some(EmptyState::NoMatch));
    assert_eq!(
        h.list.empty_state().unwrap().message(),
        "No sessions match."
    );
    // Clearing keeps the fetched order.
    h.search("  ");
    assert_eq!(h.ids().len(), 16);
    assert_eq!(h.ids()[0], SHELL);
}

#[test]
fn branch_chips_count_and_filter() {
    let mut h = Harness::new(Some(ROOT));
    let branches = h.list.branches();
    assert_eq!(branches[0], ("main".into(), 4));
    assert_eq!(branches[1], ("feat/rust-port".into(), 2));
    // Ties keep the order the rows came in.
    assert_eq!(branches[2], ("fix/e2e-tabs".into(), 1));
    assert_eq!(branches.iter().map(|b| b.1).sum::<usize>(), 15);
    h.list.set_branch(Some("feat/rust-port"));
    assert_eq!(h.ids().len(), 2);
    h.search("fork");
    assert_eq!(h.ids().len(), 1);
    h.list.set_branch(None);
    assert_eq!(h.ids().len(), 1);
}

#[test]
fn a_branch_with_spaces_counts_trimmed_but_filters_as_written() {
    let data = FixtureSessionsData::builtin();
    data.change(
        claudius_app::sessions::data::SessionsChange::List { dir: None },
        |f| {
            let row = f
                .sessions
                .iter_mut()
                .find(|s| s.session_id == SHELL)
                .unwrap();
            row.git_branch = Some(" padded ".into());
        },
    );
    let mut h = Harness::with(data, Some(ROOT));
    assert!(
        h.list
            .branches()
            .iter()
            .any(|(b, n)| b == "padded" && *n == 1)
    );
    h.list.set_branch(Some("padded"));
    assert!(h.ids().is_empty(), "the page compares the untrimmed branch");
}

#[test]
fn the_unread_pill_filters_and_lets_go_at_zero() {
    let mut h = Harness::new(Some(ROOT));
    let (label, title) = h.list.unread_pill().unwrap();
    assert_eq!(label, "3 new");
    assert_eq!(
        title,
        "3 new notifications across 2 sessions — click to filter"
    );
    h.list.toggle_unread_only();
    assert!(h.list.filter_unread());
    assert_eq!(h.ids(), [FLAKY, SSE]);
    assert_eq!(
        h.list.unread_pill().unwrap().1,
        "Showing only sessions with new notifications — click to show all"
    );
    // Opening them clears the badges: the filter stops applying.
    h.list.set_unread(Default::default());
    assert!(!h.list.filter_unread());
    assert_eq!(h.list.unread_pill(), None);
    assert_eq!(h.ids().len(), 16);
    // The toggle stays latched (the page derives, it doesn't reset): a new
    // notification brings the filter back.
    let mut one = std::collections::BTreeMap::new();
    one.insert(SHELL.to_owned(), 1);
    h.list.set_unread(one);
    assert!(h.list.filter_unread());
    assert_eq!(h.ids(), [SHELL]);
    h.list.toggle_unread_only();
    assert_eq!(
        h.list.unread_pill().unwrap(),
        (
            "1 new".to_owned(),
            "1 new notification across 1 session — click to filter".to_owned()
        )
    );
    let mut lots = std::collections::BTreeMap::new();
    lots.insert(SHELL.to_owned(), 120);
    h.list.set_unread(lots);
    assert_eq!(h.list.unread_pill().unwrap().0, "99+ new");
}

#[test]
fn transcript_search_adds_body_hits_below_field_hits() {
    let mut h = Harness::new(Some(ROOT));
    // Off: no request, the field search alone.
    h.search("bare scoped");
    assert!(h.ids().is_empty());
    assert_eq!(h.data.requests().len(), 1);
    h.list.set_search_transcripts(true);
    h.search("bare scoped");
    assert_eq!(
        h.urls().last().unwrap(),
        &format!("/api/sessions/search?q=bare%20scoped&dir={ROOT_Q}")
    );
    assert!(!h.list.content_searching());
    assert_eq!(h.ids(), [SHELL]);
    let rows = h.list.rows_with(NOW, 2026, &utc_date);
    assert!(
        rows[0]
            .snippet
            .as_deref()
            .unwrap()
            .contains("bare scoped paths")
    );
    // Names only ignores body hits.
    h.search("n:bare scoped");
    assert!(h.ids().is_empty());
    // Under two UTF-16 units there's no scan, and the hits go.
    h.search("b");
    assert!(!h.urls().last().unwrap().contains("q=b&"));
    assert!(
        h.list
            .rows_with(NOW, 2026, &utc_date)
            .iter()
            .all(|r| r.snippet.is_none())
    );
    // Toggled off, the matches stop counting at once.
    h.search("bare scoped");
    assert_eq!(h.ids(), [SHELL]);
    h.list.set_search_transcripts(false);
    assert!(h.ids().is_empty());
}

#[test]
fn a_stale_transcript_search_is_dropped() {
    let mut h = Harness::new(Some(ROOT));
    h.list.set_search_transcripts(true);
    h.list.set_filter("bare scoped");
    let first = h.list.content_search_due();
    assert!(h.list.content_searching());
    // The query changes before the answer lands.
    h.list.set_filter("bare scopedx");
    let [ListEffect::Send(call, _)] = first.as_slice() else {
        panic!("{first:?}");
    };
    let reply = Reply::json(
        200,
        &json!({"matches": [{"sessionId": SHELL, "snippet": "x"}]}),
    );
    h.list.replied(call.clone(), Ok(reply));
    assert!(
        h.list.content_searching(),
        "the aborted fetch leaves the flag"
    );
    assert!(h.ids().is_empty());
    // An error answer clears the matches.
    let e = h.list.content_search_due();
    let [ListEffect::Send(call, _)] = e.as_slice() else {
        panic!()
    };
    h.list
        .replied(call.clone(), Ok(Reply::json(500, &json!({}))));
    assert!(!h.list.content_searching());
    assert_eq!(h.list.empty_state(), Some(EmptyState::NoMatch));
    // While a scan runs the empty list says so.
    h.list.content_search_due();
    assert_eq!(
        h.list.empty_state().unwrap().message(),
        "Searching transcripts…"
    );
}

/// A fixture with `n` sessions in the workspace.
fn many(n: usize) -> FixtureSessionsData {
    let data = FixtureSessionsData::builtin();
    data.change(
        claudius_app::sessions::data::SessionsChange::List { dir: None },
        |f| {
            let template = f.sessions[0].clone();
            f.sessions.clear();
            for i in 0..n {
                let mut s = template.clone();
                s.session_id = format!("00000000-0000-4000-8000-{i:012}");
                s.claudius_title = Some(format!("Session {i}"));
                s.first_prompt = None;
                s.last_modified = NOW - i as f64 * 60_000.;
                f.sessions.push(s);
            }
            // The oldest one is the only "needle".
            f.sessions[n - 1].claudius_title = Some("needle".into());
        },
    );
    data
}

#[test]
fn load_more_grows_the_page() {
    let mut h = Harness::with(many(450), Some(ROOT));
    assert_eq!(h.list.sessions().len(), 200);
    assert!(h.list.has_more());
    assert_eq!(h.list.load_more_button(), Some(true));
    h.act(|l| l.load_more());
    assert_eq!(h.list.sessions().len(), 400);
    assert_eq!(
        h.urls().last().unwrap(),
        &format!("/api/sessions/all?dir={ROOT_Q}&limit=400")
    );
    h.act(|l| l.load_more());
    assert_eq!(h.list.sessions().len(), 450);
    assert!(!h.list.has_more());
    assert_eq!(h.list.load_more_button(), None);
}

#[test]
fn a_no_match_query_loads_older_pages_up_to_the_ceiling() {
    let mut h = Harness::with(many(1500), Some(ROOT));
    // Typed but not settled: "searching older" while more exist; no
    // "Load more" competing with it.
    h.list.set_filter("needle");
    assert!(h.list.query_pending());
    assert_eq!(h.list.empty_state(), Some(EmptyState::SearchingOlder));
    assert_eq!(h.list.load_more_button(), None);
    // Settled: the pages load on their own up to 1000 sessions.
    h.list.settle();
    h.run(Vec::new());
    assert_eq!(h.list.sessions().len(), 1000);
    assert_eq!(h.list.older_search(), OlderSearch::Capped);
    let capped = h.list.empty_state().unwrap();
    assert_eq!(
        capped.message(),
        "No matches in the 1000 most recent sessions."
    );
    assert_eq!(capped.button(), Some("Search older"));
    // "Search older": the next step, which finds it.
    h.act(|l| l.search_older());
    assert_eq!(h.list.older_ceiling(), 2000);
    assert_eq!(h.list.sessions().len(), 1500);
    assert_eq!(h.ids().len(), 1);
    assert_eq!(h.list.older_search(), OlderSearch::Idle);
    // A new query starts from the default ceiling.
    h.list.set_filter("other");
    h.list.settle();
    assert_eq!(h.list.older_ceiling(), 1000);
    assert_eq!(h.list.older_search(), OlderSearch::None);
    assert_eq!(h.list.empty_state(), Some(EmptyState::NoMatch));
}

#[test]
fn a_failed_page_caps_the_older_search_with_retry() {
    let data = many(450);
    let mut h = Harness::with(data, Some(ROOT));
    h.data.answer_next(
        |r| matches!(r, SessionsRequest::List { .. }),
        Ok(Reply::json(500, &json!({"error": "boom"}))),
    );
    h.list.set_filter("needle");
    h.list.settle();
    h.run(Vec::new());
    // The hook says `HTTP 500` (it doesn't read the body), and keeps the
    // list it had.
    assert_eq!(h.list.error(), Some("HTTP 500"));
    assert_eq!(h.list.sessions().len(), 200);
    let capped = h.list.empty_state().unwrap();
    assert_eq!(capped.message(), "Couldn't load older sessions.");
    assert_eq!(capped.button(), Some("Retry"));
    h.act(|l| l.search_older());
    assert_eq!(h.list.error(), None);
    assert_eq!(h.ids().len(), 1);
}

#[test]
fn listing_errors_read_as_the_hook_reads_them() {
    let mut h = Harness::new(Some(ROOT));
    h.data.answer_next(
        |_| true,
        Ok(Reply::json(200, &json!({"error": "database is locked"}))),
    );
    h.act(|l| l.refresh());
    assert_eq!(h.list.error(), Some("database is locked"));
    assert_eq!(h.list.scoped().len(), 16);
    h.data.answer_next(|_| true, Err("Failed to fetch".into()));
    h.act(|l| l.refresh());
    assert_eq!(h.list.error(), Some("Failed to fetch"));
    assert!(!h.list.loading());
    h.data.answer_next(
        |_| true,
        Ok(Reply {
            status: 200,
            body: "<html>".into(),
            filename: None,
        }),
    );
    h.act(|l| l.refresh());
    assert!(h.list.error().unwrap().starts_with("invalid JSON"));
    // A good answer clears it.
    h.act(|l| l.refresh());
    assert_eq!(h.list.error(), None);
}

#[test]
fn a_stale_listing_is_dropped() {
    let mut list = SessionsList::new(W1, Some(ROOT));
    let first = list.start();
    let second = list.refresh();
    assert!(list.loading());
    let call = |e: &[ListEffect]| match e {
        [ListEffect::Send(c, _)] => c.clone(),
        other => panic!("{other:?}"),
    };
    let body = |n: usize| {
        let rows: Vec<_> = (0..n)
            .map(|i| json!({"sessionId": format!("s{i}"), "lastModified": NOW, "cwd": ROOT}))
            .collect();
        Ok(Reply::json(200, &json!({"sessions": rows})))
    };
    list.replied(call(&first), body(3));
    assert!(list.loading(), "the aborted fetch changes nothing");
    assert!(list.sessions().is_empty());
    list.replied(call(&second), body(2));
    assert!(!list.loading());
    assert_eq!(list.sessions().len(), 2);
    assert_eq!(call(&second), ListCall::List { seq: 2 });
    // A row that isn't a session object is skipped.
    let third = list.refresh();
    list.replied(
        call(&third),
        Ok(Reply::json(
            200,
            &json!({"sessions": [{"sessionId": "ok", "lastModified": "x"}, 7, {"summary": "no id"}]}),
        )),
    );
    assert_eq!(list.sessions().len(), 1);
    assert!(list.sessions()[0].last_modified.is_nan());
    assert!(!list.show_accounts());
}

#[test]
fn while_the_first_page_loads_the_list_is_blank() {
    let mut list = SessionsList::new(W1, Some(ROOT));
    let _ = list.start();
    assert!(list.loading());
    assert_eq!(list.empty_state(), None);
    assert_eq!(list.load_more_button(), None);
}

#[test]
fn arrows_move_the_selection_and_enter_opens_it() {
    let mut h = Harness::new(Some(ROOT));
    assert_eq!(h.list.selected(), None);
    assert!(h.list.open_selected().is_empty());
    h.list.move_selection(true);
    assert_eq!(h.list.selected(), Some(SHELL));
    h.list.move_selection(true);
    assert_eq!(h.list.selected(), Some(FLAKY));
    h.list.move_selection(false);
    h.list.move_selection(false);
    assert_eq!(h.list.selected(), Some(SHELL), "stays on the first");
    h.list.select_edge(true);
    let last = h.ids().last().cloned().unwrap();
    assert_eq!(h.list.selected(), Some(last.as_str()));
    h.list.move_selection(true);
    assert_eq!(h.list.selected(), Some(last.as_str()), "stays on the last");
    h.list.select_edge(false);
    assert_eq!(
        h.list.open_selected(),
        [ListEffect::Open(format!("/sessions/{SHELL}?dir={ROOT_Q}"))]
    );
    let rows = h.list.rows_with(NOW, 2026, &utc_date);
    assert!(rows[0].selected && !rows[1].selected);
    // A search that hides the selection drops it; ↑ starts from the end.
    h.search("login");
    assert_eq!(h.list.selected(), None);
    h.list.move_selection(false);
    assert_eq!(h.list.selected(), h.ids().last().map(String::as_str));
    h.search("zzz");
    h.list.move_selection(true);
    assert_eq!(h.list.selected(), None);
}

#[test]
fn resume_opens_the_chat_on_the_session() {
    let h = Harness::new(Some(ROOT));
    assert_eq!(
        h.list.resume(SHELL),
        [ListEffect::Open(format!("/?session={SHELL}"))]
    );
    assert_eq!(resume_href("x"), "/?session=x");
}

#[test]
fn delete_asks_then_deletes_and_refreshes() {
    let mut h = Harness::new(Some(ROOT));
    h.list.ask_delete(SHELL);
    assert_eq!(
        h.list.delete_question().as_deref(),
        Some("Delete session 3e9a7c41?")
    );
    h.act(|l| l.confirm_delete(false));
    assert_eq!(h.list.confirming_delete(), None);
    assert_eq!(h.data.requests().len(), 1);
    h.list.ask_delete(SHELL);
    h.data.clear_requests();
    h.act(|l| l.confirm_delete(true));
    let requests = h.data.requests();
    assert_eq!(
        requests[0],
        SessionsRequest::Delete {
            id: SHELL.into(),
            dir: Some(ROOT.into())
        }
    );
    assert_eq!(requests[0].method(), "DELETE");
    assert_eq!(
        requests[0].url(),
        format!("/api/sessions/file/{SHELL}?dir={ROOT_Q}")
    );
    // Then the listing again, without it.
    assert!(matches!(requests[1], SessionsRequest::List { .. }));
    assert_eq!(requests.len(), 2);
    assert!(!h.ids().contains(&SHELL.to_owned()));
    assert_eq!(h.list.action_error(), None);
    // A second answer with nothing to confirm does nothing.
    assert!(h.list.confirm_delete(true).is_empty());
}

#[test]
fn a_failed_delete_says_why() {
    let mut h = Harness::new(Some(ROOT));
    for (reply, want) in [
        (
            Ok(Reply::json(
                500,
                &json!({"error": "EACCES: permission denied"}),
            )),
            "Delete failed (3e9a7c41): EACCES: permission denied",
        ),
        (
            Ok(Reply::json(500, &json!({"error": ""}))),
            "Delete failed (3e9a7c41): HTTP 500",
        ),
        (
            Ok(Reply {
                status: 502,
                body: "Bad gateway".into(),
                filename: None,
            }),
            "Delete failed (3e9a7c41): HTTP 502",
        ),
        (
            Err("Failed to fetch".to_owned()),
            "Delete failed (3e9a7c41): Failed to fetch",
        ),
    ] {
        h.data
            .answer_next(|r| matches!(r, SessionsRequest::Delete { .. }), reply);
        h.list.ask_delete(SHELL);
        h.act(|l| l.confirm_delete(true));
        assert_eq!(h.list.action_error(), Some(want));
        assert!(h.ids().contains(&SHELL.to_owned()));
    }
    // The next try clears it first.
    h.list.ask_delete(SHELL);
    h.act(|l| l.confirm_delete(true));
    assert_eq!(h.list.action_error(), None);
}

#[test]
fn a_session_without_a_cwd_deletes_without_dir() {
    let data = FixtureSessionsData::builtin();
    data.change(
        claudius_app::sessions::data::SessionsChange::List { dir: None },
        |f| {
            f.sessions
                .iter_mut()
                .find(|s| s.session_id == SHELL)
                .unwrap()
                .cwd = Some(String::new());
        },
    );
    let mut h = Harness::with(data, None);
    h.list.ask_delete(SHELL);
    h.data.clear_requests();
    h.act(|l| l.confirm_delete(true));
    assert_eq!(h.urls()[0], format!("/api/sessions/file/{SHELL}"));
    let row = h.list.rows_with(NOW, 2026, &utc_date);
    assert!(row.iter().all(|r| r.id != SHELL));
}

#[test]
fn export_fetches_the_text_and_saves_it() {
    let mut h = Harness::new(Some(ROOT));
    h.data.clear_requests();
    h.act(|l| l.export(SHELL));
    assert_eq!(
        h.urls(),
        [format!("/api/sessions/export/{SHELL}?dir={ROOT_Q}")]
    );
    let (name, text) = &h.saved[0];
    assert_eq!(name, &format!("claudius-session-{SHELL}.txt"));
    assert!(text.starts_with("User: Port the Next.js"));
    h.list.saved(Ok("/tmp/x.txt".into()));
    assert_eq!(h.list.notice(), Some("Exported to /tmp/x.txt"));
    h.list.saved(Err("disk full".into()));
    assert_eq!(h.list.action_error(), Some("Export failed: disk full"));
    // A failed export says what the route said.
    h.act(|l| l.export("no-such-session"));
    assert_eq!(
        h.list.action_error(),
        Some("Export failed (no-such-): failed to export session")
    );
    assert_eq!(h.list.notice(), None);
    h.data.answer_next(|_| true, Err("offline".into()));
    h.act(|l| l.export(SHELL));
    assert_eq!(
        h.list.action_error(),
        Some("Export failed (3e9a7c41): offline")
    );
}

#[test]
fn requests_are_shaped_as_the_ts_sends_them() {
    let dir = Some("/Users/demo/a b&c".to_owned());
    let cases = [
        (
            SessionsRequest::List {
                dir: dir.clone(),
                limit: 200,
            },
            "GET",
            "/api/sessions/all?dir=%2FUsers%2Fdemo%2Fa+b%26c&limit=200",
        ),
        (
            SessionsRequest::List {
                dir: Some(String::new()),
                limit: 400,
            },
            "GET",
            "/api/sessions/all?limit=400",
        ),
        (
            SessionsRequest::Info {
                id: "s1".into(),
                dir: dir.clone(),
            },
            "GET",
            "/api/sessions/info/s1?dir=%2FUsers%2Fdemo%2Fa%20b%26c",
        ),
        (
            SessionsRequest::Transcript {
                id: "s1".into(),
                dir: None,
            },
            "GET",
            "/api/sessions/transcript/s1",
        ),
        (
            SessionsRequest::Search {
                q: "n:a b".into(),
                dir: "/x".into(),
            },
            "GET",
            "/api/sessions/search?q=n%3Aa%20b&dir=%2Fx",
        ),
        (
            SessionsRequest::Export {
                id: "s1".into(),
                dir: dir.clone(),
            },
            "GET",
            "/api/sessions/export/s1?dir=%2FUsers%2Fdemo%2Fa%20b%26c",
        ),
        (
            SessionsRequest::Delete {
                id: "s1".into(),
                dir: None,
            },
            "DELETE",
            "/api/sessions/file/s1",
        ),
    ];
    for (r, method, url) in cases {
        assert_eq!(r.method(), method, "{r:?}");
        assert_eq!(r.url(), url, "{r:?}");
        assert_eq!(r.body(), None);
    }
    let rename = SessionsRequest::Rename {
        session_id: "s1".into(),
        title: "T".into(),
        dir: None,
    };
    assert_eq!(
        (rename.method(), rename.url().as_str()),
        ("POST", "/api/sessions/rename")
    );
    assert_eq!(
        rename.body().unwrap().to_string(),
        r#"{"sessionId":"s1","title":"T"}"#
    );
    let rename = SessionsRequest::Rename {
        session_id: "s1".into(),
        title: "T".into(),
        dir: Some("/d".into()),
    };
    assert_eq!(
        rename.body().unwrap().to_string(),
        r#"{"sessionId":"s1","title":"T","dir":"/d"}"#
    );
    let fork = SessionsRequest::Fork {
        session_id: "s1".into(),
        up_to_message_id: Some("m1".into()),
        dir: Some("/d".into()),
    };
    assert_eq!(
        (fork.method(), fork.url().as_str()),
        ("POST", "/api/sessions/fork")
    );
    assert_eq!(
        fork.body().unwrap().to_string(),
        r#"{"sessionId":"s1","upToMessageId":"m1","dir":"/d"}"#
    );
    let fork = SessionsRequest::Fork {
        session_id: "s1".into(),
        up_to_message_id: None,
        dir: None,
    };
    assert_eq!(fork.body().unwrap().to_string(), r#"{"sessionId":"s1"}"#);
}

#[test]
fn a_200_error_counts_only_when_truthy() {
    for (error, want) in [
        (json!(""), None),
        (json!(0), None),
        (json!(null), None),
        (json!(false), None),
        (json!("database is locked"), Some("database is locked")),
        (json!(7), Some("7")),
        (json!(true), Some("true")),
        (json!({"code": 1}), Some("[object Object]")),
        (json!(["a", 1, null]), Some("a,1,")),
    ] {
        let page = SessionsPage::from_json(&json!({"error": error, "sessions": []}));
        assert_eq!(page.error.as_deref(), want, "{error}");
    }
    // An empty one is no error: the rows load.
    let mut list = SessionsList::new(W1, Some(ROOT));
    let e = list.start();
    let [ListEffect::Send(call, _)] = e.as_slice() else {
        panic!("{e:?}")
    };
    let body =
        json!({"error": "", "sessions": [{"sessionId": "a", "lastModified": NOW, "cwd": ROOT}]});
    list.replied(call.clone(), Ok(Reply::json(200, &body)));
    assert_eq!(list.error(), None);
    assert_eq!(list.sessions().len(), 1);
}

#[test]
fn claudius_title_wins_over_the_sdk_title() {
    let row = |v: serde_json::Value| -> StoredSession { serde_json::from_value(v).unwrap() };
    let both = row(json!({
        "sessionId": "a", "claudiusTitle": "Ours", "customTitle": "SDK",
        "summary": "the summary", "firstPrompt": "the prompt", "createdAt": NOW
    }));
    assert_eq!(both.display_title(2026), "Ours");
    assert_eq!(both.title_draft(), "Ours");
    // An empty Claudius title falls through for the label, not the box
    // (`??` keeps an empty string).
    let blank = row(json!({"sessionId": "a", "claudiusTitle": "", "customTitle": "SDK"}));
    assert_eq!(blank.display_title(2026), "SDK");
    assert_eq!(blank.title_draft(), "");
    let sdk = row(json!({"sessionId": "a", "customTitle": "SDK"}));
    assert_eq!(sdk.title_draft(), "SDK");
    // Never the summary or the prompt.
    let none = row(json!({"sessionId": "a", "summary": "s", "firstPrompt": "p"}));
    assert_eq!(none.display_title(2026), "(untitled)");
}

#[test]
fn while_a_page_loads_load_more_waits_and_the_older_search_says_so() {
    let mut h = Harness::with(many(450), Some(ROOT));
    // A refetch in flight: "Load more" shows, disabled. (Its own fetch
    // hides it: the limit grows first, as `setLimit` does.)
    let pending = h.list.refresh();
    assert!(h.list.loading());
    assert_eq!(h.list.load_more_button(), Some(false));
    h.run(pending);
    assert_eq!(h.list.load_more_button(), Some(true));
    let pending = h.list.load_more();
    assert_eq!(h.list.load_more_button(), None);
    h.run(pending);
    assert_eq!(h.list.sessions().len(), 400);
    assert_eq!(h.list.load_more_button(), Some(true));
    // A settled no-match query with its next page in flight.
    h.list.set_filter("needle");
    h.list.settle();
    let next = h.list.drive();
    assert!(h.list.loading());
    assert_eq!(h.list.older_search(), OlderSearch::Searching);
    assert_eq!(h.list.empty_state(), Some(EmptyState::SearchingOlder));
    assert_eq!(
        h.list.empty_state().unwrap().message(),
        "Searching older sessions…"
    );
    h.run(next);
    assert_eq!(h.ids().len(), 1);
    assert_eq!(h.list.empty_state(), None);
}
