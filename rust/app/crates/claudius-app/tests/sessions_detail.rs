//! One session's page model over the bundled fixture, without GPUI: the
//! joined info + transcript load and its errors, the header and meta line,
//! the transcript rows (compaction folding, hidden rows), and each header
//! action's request and outcome. Also the fixture source itself.

use chrono::Utc;
use claudius_app::sessions::data::{
    Reply, SessionsChange, SessionsData, SessionsRequest, action_result, fork_result,
};
use claudius_app::sessions::detail::{DetailCall, DetailEffect, SessionDetail};
use claudius_app::sessions::fixture::FixtureSessionsData;
use claudius_app::sessions::search;
use claudius_app::sessions::transcript::{self, Block, COMPACT_SUMMARY_PREFIX, Row};
use futures::StreamExt as _;
use futures::executor::block_on;
use serde_json::{Value, json};

const ROOT: &str = "/Users/demo/src/claudius";
const ROOT_Q: &str = "%2FUsers%2Fdemo%2Fsrc%2Fclaudius";
const SHELL: &str = "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162";
const UNTITLED: &str = "51c0e8a3-9f7b-4d2c-a1e6-0b9c8d7e6f5a";
const SSE: &str = "e2a96d07-4b1c-4f3e-8d5a-6c7b8a9f0e1d";

/// `SessionsScreen::run_detail`, synchronously.
struct Harness {
    detail: SessionDetail,
    data: FixtureSessionsData,
    opened: Vec<String>,
    saved: Vec<(String, String)>,
}

impl Harness {
    fn new(id: &str, dir: Option<&str>) -> Harness {
        Harness::with(FixtureSessionsData::builtin(), id, dir)
    }

    fn with(data: FixtureSessionsData, id: &str, dir: Option<&str>) -> Harness {
        let mut h = Harness {
            detail: SessionDetail::new(id, dir),
            data,
            opened: Vec::new(),
            saved: Vec::new(),
        };
        h.act(SessionDetail::load);
        h
    }

    fn run(&mut self, effects: Vec<DetailEffect>) {
        for e in effects {
            match e {
                DetailEffect::Send(call, request) => {
                    let reply = block_on(self.data.send(request)).map_err(|e| e.to_string());
                    let more = self.detail.replied(call, reply);
                    self.run(more);
                }
                DetailEffect::Open(url) => self.opened.push(url),
                DetailEffect::Save { filename, text } => self.saved.push((filename, text)),
            }
        }
    }

    fn act(&mut self, f: impl FnOnce(&mut SessionDetail) -> Vec<DetailEffect>) {
        let effects = f(&mut self.detail);
        self.run(effects);
    }

    fn urls(&self) -> Vec<String> {
        self.data.requests().iter().map(|r| r.url()).collect()
    }
}

fn utc(ms: f64) -> String {
    search::locale_string(&Utc, ms)
}

#[test]
fn arrival_reads_info_and_transcript_together() {
    let h = Harness::new(SHELL, Some(ROOT));
    assert_eq!(
        h.urls(),
        [
            format!("/api/sessions/info/{SHELL}?dir={ROOT_Q}"),
            format!("/api/sessions/transcript/{SHELL}?dir={ROOT_Q}"),
        ]
    );
    let d = &h.detail;
    assert!(!d.loading());
    assert_eq!(d.error(), None);
    assert_eq!(d.title(2026), "Port the app shell to GPUI");
    assert_eq!(d.title_draft(), "Port the app shell to GPUI");
    assert_eq!(d.messages().len(), 13);
    assert_eq!(
        d.meta_with(&utc),
        [
            ROOT.to_owned(),
            "branch: feat/rust-port".into(),
            "created 11/26/2026, 7:18:00 PM".into(),
            "updated 11/26/2026, 7:58:00 PM".into(),
            "13 messages".into(),
        ]
    );
    assert_eq!(d.history_error(), None);
    assert!(!d.renaming() && !d.show_raw() && !d.confirming_delete());
}

#[test]
fn an_untitled_session_has_an_empty_rename_box() {
    let h = Harness::new(UNTITLED, Some(ROOT));
    assert!(h.detail.title(2026).contains(" at "));
    assert_eq!(h.detail.title_draft(), "");
    // No `?dir=`: the routes search every project.
    let h = Harness::new(SSE, None);
    assert_eq!(h.urls()[0], format!("/api/sessions/info/{SSE}"));
    assert_eq!(
        h.detail.history_error(),
        Some("ENOENT: the pre-compaction transcript is gone")
    );
    let blank = SessionDetail::new("x", Some(""));
    assert_eq!(blank.dir(), None);
    assert_eq!(blank.title(2026), "(untitled)");
    assert!(blank.meta_with(&utc).is_empty());
    assert!(blank.loading());
}

#[test]
fn load_errors_name_the_route_and_status() {
    let h = Harness::new("no-such-session", Some(ROOT));
    assert_eq!(h.detail.error(), Some("info: 404"));
    assert!(!h.detail.loading());
    let data = FixtureSessionsData::builtin();
    data.answer_next(
        |r| matches!(r, SessionsRequest::Transcript { .. }),
        Ok(Reply::json(500, &json!({"error": "boom"}))),
    );
    let h = Harness::with(data, SHELL, Some(ROOT));
    assert_eq!(h.detail.error(), Some("transcript: 500"));
    // A transport failure says its message, without waiting for the other.
    let data = FixtureSessionsData::builtin();
    data.answer_next(
        |r| matches!(r, SessionsRequest::Info { .. }),
        Err("Failed to fetch".into()),
    );
    let h = Harness::with(data, SHELL, Some(ROOT));
    assert_eq!(h.detail.error(), Some("Failed to fetch"));
    let mut d = SessionDetail::new(SHELL, None);
    let effects = d.load();
    let DetailEffect::Send(info, _) = &effects[0] else {
        panic!()
    };
    d.replied(info.clone(), Err("offline".into()));
    assert_eq!(d.error(), Some("offline"));
    assert!(!d.loading());
}

#[test]
fn a_superseded_load_is_dropped() {
    let mut d = SessionDetail::new(SHELL, None);
    let first = d.load();
    let second = d.load();
    let call = |e: &DetailEffect| match e {
        DetailEffect::Send(c, _) => c.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(call(&second[0]), DetailCall::Info { seq: 2 });
    let info = Reply::json(200, &json!({"sessionId": SHELL, "claudiusTitle": "old"}));
    let tx = Reply::json(200, &json!({"messages": [{"type": "user", "uuid": "u"}]}));
    d.replied(call(&first[0]), Ok(info.clone()));
    d.replied(call(&first[1]), Ok(tx.clone()));
    assert!(d.loading());
    assert!(d.info().is_none());
    // Half an answer waits for the other half.
    d.replied(call(&second[1]), Ok(tx));
    assert!(d.loading());
    d.replied(call(&second[0]), Ok(info));
    assert!(!d.loading());
    assert_eq!(d.title(2026), "old");
    assert_eq!(d.messages().len(), 1);
    // A body that isn't JSON is an error, not a blank page.
    let third = d.load();
    d.replied(
        call(&third[0]),
        Ok(Reply {
            status: 200,
            body: "<html>".into(),
            filename: None,
        }),
    );
    d.replied(
        call(&third[1]),
        Ok(Reply::json(200, &json!({"messages": []}))),
    );
    assert!(d.error().is_some());
    assert_eq!(d.title(2026), "old", "keeps what it had");
}

#[test]
fn transcript_rows_fold_compactions_and_hide_plumbing() {
    let h = Harness::new(SHELL, Some(ROOT));
    let rows = h.detail.rows();
    let kinds: Vec<&str> = rows
        .iter()
        .map(|r| match r {
            Row::Compaction { .. } => "compaction",
            Row::System { .. } => "system",
            Row::User { .. } => "user",
            Row::Assistant { .. } => "assistant",
        })
        .collect();
    // The two tool-result turns, the summary (folded) and the
    // task-notification are gone.
    assert_eq!(
        kinds,
        [
            "user",
            "assistant",
            "assistant",
            "compaction",
            "user",
            "assistant",
            "system",
            "user",
            "assistant"
        ]
    );
    let Row::Assistant { blocks, .. } = &rows[1] else {
        panic!()
    };
    assert_eq!(
        blocks[0],
        Block::Thinking(
            "The shell has three parts. Start with the routes, then the rails, then the tab strip."
                .into()
        )
    );
    assert_eq!(
        blocks[2],
        Block::ToolUse {
            id: "toolu_01".into(),
            name: "Glob".into(),
            input: "{\n  \"pattern\": \"app/**/page.tsx\"\n}".into(),
        }
    );
    let Row::Compaction {
        uuid,
        stats,
        summary,
    } = &rows[3]
    else {
        panic!()
    };
    assert_eq!(uuid, "00000000-0000-4000-8000-000000000006");
    assert_eq!(
        stats.as_deref(),
        Some("167,000\u{2192}42,000 tokens \u{b7} 38s")
    );
    assert!(
        summary
            .as_deref()
            .unwrap()
            .starts_with(COMPACT_SUMMARY_PREFIX)
    );
    assert!(summary.as_deref().unwrap().ends_with("Next: the rails."));
    assert_eq!(
        rows[6],
        Row::System {
            uuid: "00000000-0000-4000-8000-00000000000b".into(),
            text: "\u{2014} api error \u{2014}".into()
        }
    );
    let raw = h.detail.raw();
    assert_eq!(raw.lines().count(), 13);
    assert!(
        raw.lines()
            .all(|l| serde_json::from_str::<Value>(l).is_ok())
    );
}

#[test]
fn transcript_edge_cases() {
    // A summary without its boundary is its own divider; one by prefix.
    let summary = json!({"type": "user", "uuid": "s", "message": {"content": format!("  {COMPACT_SUMMARY_PREFIX}. x ")}});
    assert!(transcript::is_compact_summary(&summary));
    assert_eq!(
        transcript::rows(&[summary]),
        [Row::Compaction {
            uuid: "s".into(),
            stats: None,
            summary: Some(format!("{COMPACT_SUMMARY_PREFIX}. x")),
        }]
    );
    // A user turn between boundary and summary ends the pairing.
    let rows = transcript::rows(&[
        json!({"type": "system", "subtype": "compact_boundary", "uuid": "b"}),
        json!({"type": "user", "uuid": "u", "message": {"content": "hi"}}),
        json!({"type": "user", "uuid": "s", "isCompactSummary": true, "message": {"content": "sum"}}),
    ]);
    assert_eq!(rows.len(), 3);
    assert!(matches!(&rows[0], Row::Compaction { summary: None, .. }));
    // ... but a system row in between doesn't.
    let rows = transcript::rows(&[
        json!({"type": "system", "subtype": "compact_boundary", "uuid": "b", "compactBoundary": {"preTokens": 1000, "postTokens": 10}}),
        json!({"type": "system", "uuid": "x"}),
        json!({"type": "user", "uuid": "s", "isCompactSummary": true, "message": {"content": "sum"}}),
    ]);
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0],
        Row::Compaction {
            uuid: "b".into(),
            stats: Some("1,000\u{2192}10 tokens".into()),
            summary: Some("sum".into())
        }
    );
    assert_eq!(
        rows[1],
        Row::System {
            uuid: "x".into(),
            text: "\u{2014} system \u{2014}".into()
        }
    );
    // Stats: under a second there's no duration; half a second rounds up.
    assert_eq!(transcript::compact_stats(&json!({"durationMs": 999})), None);
    assert_eq!(
        transcript::compact_stats(&json!({"durationMs": 1500})).as_deref(),
        Some("2s")
    );
    assert_eq!(transcript::compact_stats(&json!({"preTokens": 5})), None);
    // A task notification needs the tag's end; other `<task-` text shows.
    let user = |t: &str| json!({"type": "user", "uuid": "u", "message": {"content": t}});
    assert!(transcript::rows(&[user(" \n<task-notification>x")]).is_empty());
    assert!(transcript::rows(&[user("<task-notification id=1>")]).is_empty());
    assert_eq!(transcript::rows(&[user("<task-notifications>")]).len(), 1);
    // Tool results inside assistant turns don't draw; unknown kinds skip.
    let rows = transcript::rows(&[
        json!({"type": "assistant", "uuid": "a", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t", "content": "x"},
            {"type": "image"},
            {"type": "tool_use", "id": "t", "name": "Bash"},
        ]}}),
        json!({"type": "result", "uuid": "r"}),
    ]);
    assert_eq!(
        rows,
        [Row::Assistant {
            uuid: "a".into(),
            blocks: vec![Block::ToolUse {
                id: "t".into(),
                name: "Bash".into(),
                input: "{}".into()
            }]
        }]
    );
    let result = transcript::blocks(Some(&json!([
        {"type": "tool_result", "tool_use_id": "t", "is_error": 1, "content": [{"text": "a"}, {"text": "b"}]}
    ])));
    assert_eq!(
        result,
        [Block::ToolResult {
            id: "t".into(),
            text: "ab".into(),
            is_error: true
        }]
    );
    assert_eq!(
        transcript::plain_text(Some(
            &json!([{"type": "text", "text": "a"}, {"type": "thinking", "thinking": "no"}, {"type": "text", "text": "b"}])
        )),
        "ab"
    );
}

#[test]
fn rename_saves_the_trimmed_title_and_reloads() {
    let mut h = Harness::new(SHELL, Some(ROOT));
    h.detail.start_rename();
    assert!(h.detail.renaming());
    h.detail.set_draft("   ");
    assert!(
        h.detail.save_rename().is_empty(),
        "a blank title does nothing"
    );
    h.detail.set_draft("  Shell, ported  ");
    h.data.clear_requests();
    h.act(|d| d.save_rename());
    let requests = h.data.requests();
    assert_eq!(
        requests[0],
        SessionsRequest::Rename {
            session_id: SHELL.into(),
            title: "Shell, ported".into(),
            dir: Some(ROOT.into())
        }
    );
    assert_eq!(
        requests[0].body().unwrap().to_string(),
        format!(r#"{{"sessionId":"{SHELL}","title":"Shell, ported","dir":"{ROOT}"}}"#)
    );
    // Then the page reads itself again.
    assert!(matches!(requests[1], SessionsRequest::Info { .. }));
    assert!(matches!(requests[2], SessionsRequest::Transcript { .. }));
    assert!(!h.detail.renaming());
    assert_eq!(h.detail.title(2026), "Shell, ported");
    assert_eq!(h.detail.title_draft(), "Shell, ported");
}

#[test]
fn a_failed_rename_keeps_the_box_open() {
    let mut h = Harness::new(SHELL, Some(ROOT));
    h.detail.start_rename();
    h.detail.set_draft("New");
    h.data.answer_next(
        |r| matches!(r, SessionsRequest::Rename { .. }),
        Ok(Reply::json(500, &json!({"error": "index is read-only"}))),
    );
    h.act(|d| d.save_rename());
    assert_eq!(h.detail.error(), Some("Rename failed: index is read-only"));
    assert!(h.detail.renaming());
    assert_eq!(h.detail.title(2026), "Port the app shell to GPUI");
    // Cancel closes it; the draft stays as typed (as the page's state does).
    h.detail.cancel_rename();
    assert!(!h.detail.renaming());
    assert_eq!(h.detail.title_draft(), "New");
    // A good save clears the error.
    h.detail.start_rename();
    h.act(|d| d.save_rename());
    assert_eq!(h.detail.error(), None);
    assert_eq!(h.detail.title(2026), "New");
}

#[test]
fn resume_and_fork_open_where_the_page_goes() {
    let mut h = Harness::new(SHELL, Some(ROOT));
    assert_eq!(
        h.detail.resume(),
        [DetailEffect::Open(format!("/?session={SHELL}"))]
    );
    h.data.clear_requests();
    h.act(|d| d.fork());
    assert_eq!(
        h.data.requests()[0].body().unwrap().to_string(),
        format!(r#"{{"sessionId":"{SHELL}","dir":"{ROOT}"}}"#)
    );
    let new = "f0f0f0f0-0000-4000-8000-000000000001";
    assert_eq!(h.opened, [format!("/sessions/{new}?dir={ROOT_Q}")]);
    let snap = h.data.snapshot();
    assert_eq!(
        snap.transcripts[new]["messages"].as_array().unwrap().len(),
        13
    );
    // Without a dir, the fork's link has none either.
    let mut h = Harness::new(SHELL, None);
    h.act(|d| d.fork());
    assert_eq!(h.opened, [format!("/sessions/{new}")]);
    h.data
        .answer_next(|_| true, Ok(Reply::json(200, &json!({"ok": true}))));
    h.act(|d| d.fork());
    assert_eq!(h.detail.error(), Some("Fork failed"));
    assert_eq!(h.opened.len(), 1);
}

#[test]
fn rewind_forks_up_to_the_message_and_opens_the_chat() {
    let mut h = Harness::new(SHELL, Some(ROOT));
    let at = "00000000-0000-4000-8000-000000000009";
    h.data.clear_requests();
    let effects = h.detail.rewind(at);
    assert_eq!(h.detail.rewinding(), Some(at));
    assert!(h.detail.rewind(at).is_empty(), "a second click waits");
    h.run(effects);
    assert_eq!(
        h.data.requests()[0].body().unwrap().to_string(),
        format!(r#"{{"sessionId":"{SHELL}","upToMessageId":"{at}","dir":"{ROOT}"}}"#)
    );
    let new = "f0f0f0f0-0000-4000-8000-000000000001";
    assert_eq!(h.opened, [format!("/?session={new}")]);
    assert_eq!(h.detail.rewinding(), None);
    let snap = h.data.snapshot();
    assert_eq!(
        snap.transcripts[new]["messages"].as_array().unwrap().len(),
        9
    );
    h.data.answer_next(|_| true, Err("offline".into()));
    h.act(|d| d.rewind(at));
    assert_eq!(h.detail.error(), Some("Fork failed"));
    assert_eq!(h.detail.rewinding(), None);
}

#[test]
fn delete_asks_then_leaves_for_the_list() {
    let mut h = Harness::new(SHELL, Some(ROOT));
    h.detail.ask_delete();
    assert!(h.detail.confirming_delete());
    h.act(|d| d.confirm_delete(false));
    assert!(!h.detail.confirming_delete());
    assert_eq!(h.data.requests().len(), 2);
    assert!(h.detail.confirm_delete(true).is_empty(), "nothing asked");
    h.detail.ask_delete();
    h.act(|d| d.confirm_delete(true));
    let last = h.data.requests().pop().unwrap();
    assert_eq!(last.method(), "DELETE");
    assert_eq!(
        last.url(),
        format!("/api/sessions/file/{SHELL}?dir={ROOT_Q}")
    );
    assert_eq!(h.opened, ["/sessions"]);
    assert!(
        h.data
            .snapshot()
            .sessions
            .iter()
            .all(|s| s.session_id != SHELL)
    );
    assert_eq!(
        SessionDetail::DELETE_QUESTION,
        "Delete this session permanently?"
    );
    // Gone already: the route's error.
    let mut h = Harness::new(SHELL, Some(ROOT));
    h.data.answer_next(
        |r| matches!(r, SessionsRequest::Delete { .. }),
        Ok(Reply::json(500, &json!({"error": "EBUSY"}))),
    );
    h.detail.ask_delete();
    h.act(|d| d.confirm_delete(true));
    assert_eq!(h.detail.error(), Some("Delete failed: EBUSY"));
    assert!(h.opened.is_empty());
}

#[test]
fn export_saves_the_routes_text() {
    let mut h = Harness::new(UNTITLED, Some(ROOT));
    h.act(|d| d.export());
    assert_eq!(
        h.data.requests().last().unwrap().url(),
        format!("/api/sessions/export/{UNTITLED}?dir={ROOT_Q}")
    );
    let (name, text) = &h.saved[0];
    assert_eq!(name, &format!("claudius-session-{UNTITLED}.txt"));
    assert_eq!(
        text,
        "User: what does the scheduler do when the laptop sleeps?\n\nAssistant: Looking into it. \
         First I'll read the code around the task.\n\nAssistant: Found it, and fixed it. The change \
         is in `src/a.ts`."
    );
    h.detail.saved(Ok("/tmp/a.txt".into()));
    assert_eq!(h.detail.notice(), Some("Exported to /tmp/a.txt"));
    h.detail.saved(Err("cancelled".into()));
    assert_eq!(h.detail.error(), Some("Export failed: cancelled"));
    // The next export clears the notice; a plain-text error body shows.
    h.data.answer_next(
        |_| true,
        Ok(Reply {
            status: 500,
            body: "failed to export session".into(),
            filename: None,
        }),
    );
    h.act(|d| d.export());
    assert_eq!(h.detail.notice(), None);
    assert_eq!(
        h.detail.error(),
        Some("Export failed: failed to export session")
    );
    h.data.answer_next(
        |_| true,
        Ok(Reply::json(403, &json!({"error": "outside the root"}))),
    );
    h.act(|d| d.export());
    assert_eq!(h.detail.error(), Some("Export failed: outside the root"));
    h.data.answer_next(|_| true, Err("offline".into()));
    h.act(|d| d.export());
    assert_eq!(h.detail.error(), Some("Export failed: offline"));
    // No filename header: the page's default.
    h.data.answer_next(
        |_| true,
        Ok(Reply {
            status: 200,
            body: "x".into(),
            filename: None,
        }),
    );
    h.act(|d| d.export());
    assert_eq!(h.saved[1].0, format!("claudius-session-{UNTITLED}.txt"));
    h.detail.toggle_raw();
    assert!(h.detail.show_raw());
}

#[test]
fn action_answers_read_as_session_action_reads_them() {
    let ok = Ok(Reply::json(200, &json!({"ok": true})));
    assert_eq!(action_result(&ok), Ok(()));
    let cases: [(Result<Reply, String>, &str); 5] = [
        (
            Ok(Reply::json(400, &json!({"error": "title required"}))),
            "title required",
        ),
        (Ok(Reply::json(500, &json!({"error": ""}))), "HTTP 500"),
        (Ok(Reply::json(500, &json!({"error": 7}))), "HTTP 500"),
        (
            Ok(Reply {
                status: 404,
                body: "Not Found".into(),
                filename: None,
            }),
            "HTTP 404",
        ),
        (Err("Failed to fetch".into()), "Failed to fetch"),
    ];
    for (reply, want) in cases {
        assert_eq!(action_result(&reply), Err(want.to_owned()), "{reply:?}");
    }
    assert_eq!(
        fork_result(&Ok(Reply::json(200, &json!({"sessionId": "n"})))).as_deref(),
        Some("n")
    );
    assert_eq!(
        fork_result(&Ok(Reply::json(500, &json!({"sessionId": "n"})))),
        None
    );
    assert_eq!(
        fork_result(&Ok(Reply::json(200, &json!({"sessionId": 1})))),
        None
    );
    assert_eq!(fork_result(&Err("x".into())), None);
}

#[test]
fn the_fixture_answers_like_the_routes() {
    let data = FixtureSessionsData::builtin();
    let send = |r: SessionsRequest| block_on(data.send(r)).unwrap();
    let all = send(SessionsRequest::List {
        dir: None,
        limit: 5,
    });
    let body = all.parse().unwrap();
    assert_eq!(body["sessions"].as_array().unwrap().len(), 5);
    assert_eq!(body["accountsConfigured"], 2);
    let list = send(SessionsRequest::List {
        dir: Some("/Users/demo/src/docs-site".into()),
        limit: 200,
    });
    let rows = list.parse().unwrap()["sessions"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(rows.len(), 5);
    let times: Vec<f64> = rows
        .iter()
        .map(|r| r["lastModified"].as_f64().unwrap())
        .collect();
    assert!(times.windows(2).all(|w| w[0] >= w[1]), "newest first");
    let missing = send(SessionsRequest::Info {
        id: "nope".into(),
        dir: None,
    });
    assert_eq!(missing.status, 404);
    assert_eq!(missing.body, r#"{"error":"session not found"}"#);
    let empty = send(SessionsRequest::Transcript {
        id: "nope".into(),
        dir: None,
    });
    assert_eq!(empty.parse().unwrap(), json!({"messages": []}));
    let hits = send(SessionsRequest::Search {
        q: "SSE replay".into(),
        dir: ROOT.into(),
    });
    let matches = hits.parse().unwrap()["matches"].clone();
    assert_eq!(matches[0]["sessionId"], SSE);
    let bad = send(SessionsRequest::Rename {
        session_id: SHELL.into(),
        title: " ".into(),
        dir: None,
    });
    assert_eq!(bad.status, 400);
    let unknown = send(SessionsRequest::Rename {
        session_id: "nope".into(),
        title: "x".into(),
        dir: None,
    });
    assert_eq!(unknown.status, 500);
    assert_eq!(
        send(SessionsRequest::Delete {
            id: "nope".into(),
            dir: None
        })
        .status,
        500
    );
    assert_eq!(data.requests().len(), 8);
    data.clear_requests();
    assert!(data.requests().is_empty());
    // An override answers once, the first match only.
    data.answer_next(
        |r| matches!(r, SessionsRequest::Info { .. }),
        Ok(Reply::json(503, &json!({}))),
    );
    let info = || SessionsRequest::Info {
        id: SHELL.into(),
        dir: None,
    };
    assert_eq!(
        send(SessionsRequest::Transcript {
            id: SHELL.into(),
            dir: None
        })
        .status,
        200
    );
    assert_eq!(send(info()).status, 503);
    assert_eq!(send(info()).status, 200);
    data.answer_next(|_| true, Err("down".into()));
    assert_eq!(block_on(data.send(info())).unwrap_err().to_string(), "down");
}

#[test]
fn the_fixture_rebases_its_clock_and_pushes_changes() {
    let data = FixtureSessionsData::builtin();
    let before = data.snapshot();
    let data = data.rebased(before.now + 60_000.);
    let after = data.snapshot();
    assert_eq!(after.now, before.now + 60_000.);
    for (a, b) in before.sessions.iter().zip(&after.sessions) {
        assert_eq!(b.last_modified, a.last_modified + 60_000.);
        assert_eq!(b.created_at, a.created_at.map(|c| c + 60_000.));
    }
    assert_eq!(after.sessions.len(), 30);
    assert!(
        after
            .sessions
            .iter()
            .any(|s| s.claudius_title.as_deref().is_some_and(|t| t.len() > 200))
    );
    let mut rx = data.subscribe();
    // An action changes the data without a push (the pages re-read)...
    block_on(data.send(SessionsRequest::Delete {
        id: SHELL.into(),
        dir: None,
    }))
    .unwrap();
    assert!(rx.try_recv().is_err(), "nothing pushed");
    // ... a change elsewhere pushes.
    data.change(SessionsChange::Session { id: SSE.into() }, |f| {
        f.sessions.retain(|s| s.session_id != SSE)
    });
    assert_eq!(
        block_on(rx.next()),
        Some(SessionsChange::Session { id: SSE.into() })
    );
    assert_eq!(data.snapshot().sessions.len(), 28);
    assert_eq!(data.unread("wks_3f2a9c81d0e4").values().sum::<u32>(), 3);
    assert!(data.unread("wks_nope").is_empty());
    assert!(FixtureSessionsData::from_json("{").is_err());
    assert!(
        FixtureSessionsData::from_path(std::path::Path::new("/nonexistent/sessions.json")).is_err()
    );
}
