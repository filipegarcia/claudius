//! The session's MCP notices (S15b), replayed against the TS recording in
//! `tests/fixtures/mcp_notices_golden.json` (`rust/scripts/mcp-notices-golden.mjs`):
//! - `due`: `mcp_recheck_due` at the edges of `mcpRecheckDue`;
//! - `db`: `sync_notifications` over the recorded observation sequences,
//!   with the rows of both tables after every step (fail-open and throwing
//!   databases, foreign rows, colliding cwds);
//! - `sessions`: real `Session`s against the fake CLI answering `mcp_status`
//!   as recorded. After the init and after each turn, once the checks it
//!   started have settled: the notices a subscriber got, the `mcp_status`
//!   requests the CLI got (byte for byte, ids as `$ID`) and the rows.
//!
//! Plus the paths the golden can't show: the real clock through the
//! session manager, and the notices reaching every tab once (never
//! replayed).

#[path = "../../claudius-agent/tests/support/test_bins.rs"]
mod test_bins;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::db::{Mode, open_db};
use claudius_core::mcp_notices::{
    MCP_RECHECK_INTERVAL_MS, McpNotice, mcp_recheck_due, notice_event, servers_in_status,
    sync_disconnected_notifications, sync_needs_auth_notifications, sync_notifications,
};
use claudius_core::paths;
use claudius_core::session::{RuntimeOptions, SendOptions, Session, SessionOptions, Subscription};
use claudius_core::session_manager::SessionManager;
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/mcp_notices_golden.json")).unwrap()
    })
}

/// One isolated `$HOME` + config dir per test binary, and the fake CLI built.
fn fake() -> &'static PathBuf {
    static E: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    &E.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let config = root.path().join("config");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(config));
        let bin = test_bins::fake_claude();
        (root, bin)
    })
    .1
}

/// A recorded JS number (`"NaN"`, `"Infinity"` and `"-Infinity"` as text).
fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => panic!("number {s}"),
        },
        v => v.as_f64().unwrap(),
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn recheck_due_matches_the_ts() {
    let cases = fixture()["due"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for c in cases {
        let interval = c.get("interval").map_or(MCP_RECHECK_INTERVAL_MS, num);
        assert_eq!(
            mcp_recheck_due(num(&c["now"]), num(&c["lastAt"]), interval),
            c["due"].as_bool().unwrap(),
            "{c}"
        );
    }
}

// ─────────────────────────────── the DB modules ───────────────────────────────

/// `[rowid, typeof(server_name), hex(server_name), notified_at,
/// typeof(notified_at)]` by rowid; `Null` when it can't be read.
fn table_rows(cwd: &str, table: &str) -> Value {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return Value::Null;
    };
    db.with(|c| {
        let mut q = c.prepare(&format!(
            "SELECT rowid, typeof(server_name), hex(server_name), notified_at, typeof(notified_at) FROM {table} ORDER BY rowid"
        ))?;
        let rows = q
            .query_map([], |r| {
                Ok(json!([
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?
                ]))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Value::Array(rows))
    })
    .unwrap_or(Value::Null)
}

fn rows_of(cwd: &str) -> Value {
    json!({
        "needsAuth": table_rows(cwd, McpNotice::NeedsAuth.table()),
        "disconnected": table_rows(cwd, McpNotice::Disconnected.table()),
    })
}

/// A recorded seed, on `cwd`: `block` its project dir with a file, a `v999`
/// database without tables, or `sql` on the opened database.
fn seed(s: &Value, cwd: &str) {
    let db = paths::db_path(cwd);
    let dir = db.parent().unwrap();
    match s["kind"].as_str().unwrap() {
        "block" => {
            std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
            std::fs::write(dir, "").unwrap();
        }
        "v999" => {
            std::fs::create_dir_all(dir).unwrap();
            rusqlite::Connection::open(&db)
                .unwrap()
                .execute_batch(
                    "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES('version', '999');",
                )
                .unwrap();
        }
        "sql" => open_db(cwd, Mode::ReadWrite)
            .unwrap()
            .with(|c| c.execute_batch(s["sql"].as_str().unwrap()))
            .unwrap(),
        k => panic!("seed {k}"),
    }
}

#[test]
fn db_sync_matches_the_ts() {
    fake();
    let cases = fixture()["db"].as_array().unwrap();
    assert!(cases.len() >= 15);
    let mut steps = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        for s in case["seed"].as_array().unwrap() {
            seed(s, s["cwd"].as_str().unwrap());
        }
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            steps += 1;
            let cwd = step["cwd"].as_str().unwrap();
            let servers = strings(&step["servers"]);
            let now = step["clock"].as_i64().unwrap();
            let got = match step["fn"].as_str().unwrap() {
                "needsAuth" => sync_needs_auth_notifications(cwd, &servers, now),
                _ => sync_disconnected_notifications(cwd, &servers, now),
            };
            match &got {
                Ok(announce) => assert_eq!(
                    Some(announce.clone()),
                    step.get("announce").map(strings),
                    "{name} step {i}"
                ),
                Err(e) => assert_eq!(step["threw"], true, "{name} step {i}: {e}"),
            }
            for w in case["cwds"].as_array().unwrap() {
                let w = w.as_str().unwrap();
                assert_eq!(
                    js::stringify(&rows_of(w)),
                    js::stringify(&step["rows"][w]),
                    "{name} step {i}: rows of {w}"
                );
            }
        }
    }
    assert!(steps >= 60, "{steps} steps");
}

/// A session's startup sync and its other first open of the database can
/// race: every caller still opens, and gets the one cached connection (the
/// loser of a race used to fail its open, "database is locked" or
/// "duplicate column" from migrating twice, so the sync failed open and
/// announced again, or got a second writer of its own).
#[test]
fn racing_first_opens_share_one_connection() {
    fake();
    for round in 0..5 {
        let cwd = format!("/golden-mcp/race-{round}");
        let gate = Arc::new(std::sync::Barrier::new(8));
        let opened: Vec<_> = (0..8)
            .map(|_| {
                let (gate, cwd) = (gate.clone(), cwd.clone());
                std::thread::spawn(move || {
                    gate.wait();
                    open_db(&cwd, Mode::ReadWrite).unwrap()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        let cached = open_db(&cwd, Mode::ReadWrite).unwrap();
        for db in &opened {
            assert!(Arc::ptr_eq(db, &cached), "round {round}");
        }
    }
}

/// What the session layer reads out of a status reply, on the recorded
/// replies: the names a session syncs (or none), and the event it sends.
#[test]
fn status_replies_and_events() {
    let reply = json!([
        {"name": "a", "status": "needs-auth"},
        {"status": "needs-auth"},
        {"name": 5, "status": "failed"},
        null,
        {"name": "b", "status": "failed"},
        {"name": "c", "status": "connected"},
    ]);
    assert_eq!(
        servers_in_status(McpNotice::NeedsAuth, &reply),
        Some(vec!["a".to_owned(), "unknown".to_owned()])
    );
    assert_eq!(
        servers_in_status(McpNotice::Disconnected, &reply),
        Some(vec!["unknown".to_owned(), "b".to_owned()])
    );
    for not_a_list in [json!(null), json!({}), json!("x"), json!(5)] {
        assert_eq!(servers_in_status(McpNotice::NeedsAuth, &not_a_list), None);
    }
    assert_eq!(
        serde_json::to_string(&notice_event(McpNotice::Disconnected, &["x".to_owned()])).unwrap(),
        r#"{"type":"mcp_disconnected_notice","servers":["x"]}"#
    );
    // Both entry points share one implementation per table.
    let cwd = "/golden-mcp/rust/entry";
    fake();
    assert_eq!(
        sync_notifications(McpNotice::Disconnected, cwd, &["z".to_owned()], 7).unwrap(),
        ["z"]
    );
    assert_eq!(
        sync_disconnected_notifications(cwd, &["z".to_owned()], 8).unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(
        sync_needs_auth_notifications(cwd, &["z".to_owned()], 9).unwrap(),
        ["z"]
    );
}

// ─────────────────────────────── sessions ───────────────────────────────

async fn next(sub: &mut Subscription) -> Value {
    tokio::time::timeout(Duration::from_secs(10), sub.recv())
        .await
        .expect("event timeout")
        .expect("stream closed")
}

/// `settled()`, bounded: a check that never ends fails the test.
async fn settle(s: &Session) {
    tokio::time::timeout(Duration::from_secs(10), s.mcp_notices.settled())
        .await
        .expect("the MCP checks never settled");
}

fn is_notice(e: &Value) -> bool {
    e["type"] == "mcp_needs_auth_notice" || e["type"] == "mcp_disconnected_notice"
}

/// Reads until `pred` matches, keeping the notices seen on the way.
async fn until(sub: &mut Subscription, notices: &mut Vec<Value>, pred: impl Fn(&Value) -> bool) {
    loop {
        let e = next(sub).await;
        if is_notice(&e) {
            notices.push(e.clone());
        }
        if pred(&e) {
            return;
        }
    }
}

/// The notices already queued on `sub`.
fn drain(sub: &mut Subscription, notices: &mut Vec<Value>) {
    while let Ok(e) = sub.rx.try_recv() {
        if is_notice(&e) {
            notices.push(e);
        }
    }
}

fn is_init(e: &Value) -> bool {
    e["type"] == "sdk" && e["message"]["subtype"] == "init"
}

fn lines(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// The `mcp_status` control requests among `lines`, ids as `$ID`.
fn status_wire(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .filter_map(|l| {
            let m: Value = serde_json::from_str(l).ok()?;
            (m["type"] == "control_request" && m["request"]["subtype"] == "mcp_status").then(|| {
                let id = serde_json::to_string(&m["request_id"]).unwrap();
                l.replacen(&id, "\"$ID\"", 1)
            })
        })
        .collect()
}

fn runtime(script: &Value, log: &Path) -> RuntimeOptions {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    env.insert("FAKE_CLAUDE_LOG".into(), log.display().to_string());
    env.insert("FAKE_CLAUDE_SCRIPT".into(), script.to_string());
    RuntimeOptions {
        claude_bin: Some(fake().clone()),
        env_override: Some(env),
    }
}

/// One recorded session on `cwd`, step by step.
async fn replay_session(case: &str, sess: &Value, cwd: &str) {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("stdin.log");
    let script = json!({
        "control": {"mcp_status": {"$sequence": sess["replies"]}},
        "turns": sess["script"],
    });
    let s = Session::new(SessionOptions {
        cwd: Some(cwd.to_owned()),
        runtime: runtime(&script, &log),
        ..Default::default()
    })
    .unwrap();
    let steps = sess["steps"].as_array().unwrap();
    let clock = Arc::new(AtomicI64::new(steps[0]["clock"].as_i64().unwrap()));
    let c = clock.clone();
    s.mcp_notices.set_clock(move || c.load(Ordering::SeqCst));
    let mut sub = s.subscribe(None, None);
    s.start().await;
    let mut from = 0;
    for (i, step) in steps.iter().enumerate() {
        let mut notices = vec![];
        if step["step"] == "start" {
            until(&mut sub, &mut notices, is_init).await;
        } else {
            clock.store(step["clock"].as_i64().unwrap(), Ordering::SeqCst);
            s.send_input(
                step["prompt"].as_str().unwrap(),
                &[],
                SendOptions::default(),
            );
            until(&mut sub, &mut notices, |e| {
                e["type"] == "turn_status" && e["status"] == "running"
            })
            .await;
            until(&mut sub, &mut notices, |e| {
                e["type"] == "turn_status" && e["status"] == "idle"
            })
            .await;
        }
        settle(&s).await;
        drain(&mut sub, &mut notices);
        let at = format!("{case} ({cwd}) step {i} ({})", step["step"]);
        let got: Vec<String> = notices.iter().map(js::stringify).collect();
        let want: Vec<String> = step["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(js::stringify)
            .collect();
        assert_eq!(got, want, "{at}: events");
        let all = lines(&log);
        assert_eq!(
            status_wire(&all[from..]),
            strings(&step["wire"]),
            "{at}: wire"
        );
        from = all.len();
        assert_eq!(
            js::stringify(&rows_of(cwd)),
            js::stringify(&step["rows"]),
            "{at}: rows"
        );
    }
    s.end().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sessions_match_the_ts() {
    fake();
    let cases = fixture()["sessions"].as_array().unwrap();
    assert!(cases.len() >= 13);
    let mut n = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let base = tempfile::tempdir().unwrap();
        let base = base.path().canonicalize().unwrap();
        let cwd = |label: &Value| {
            let p = base.join(label.as_str().unwrap());
            std::fs::create_dir_all(&p).unwrap();
            p.display().to_string()
        };
        for s in case["seed"].as_array().unwrap() {
            seed(s, &cwd(&s["cwd"]));
        }
        for sess in case["sessions"].as_array().unwrap() {
            n += 1;
            replay_session(name, sess, &cwd(&sess["cwd"])).await;
        }
    }
    assert!(n >= 18, "{n} sessions");
}

/// The production clock: the first turn's re-check is due (`lastMcpRecheckAt`
/// starts at 0), the next one, right after, isn't. Through the manager.
#[tokio::test]
async fn the_real_clock_rechecks_once_per_window() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("stdin.log");
    let mgr = Arc::new(SessionManager::default());
    *mgr.runtime.lock().unwrap() = runtime(
        &json!({"control": {"mcp_status": {"mcpServers": [{"name": "gh", "status": "needs-auth"}]}}}),
        &log,
    );
    let cwd = dir.path().canonicalize().unwrap().display().to_string();
    let s = mgr
        .create(SessionOptions {
            cwd: Some(cwd),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut sub = s.subscribe(None, None);
    let mut notices = vec![];
    until(&mut sub, &mut notices, is_init).await;
    settle(&s).await;
    drain(&mut sub, &mut notices);
    assert_eq!(
        notices,
        [json!({"type": "mcp_needs_auth_notice", "servers": ["gh"]})]
    );
    assert_eq!(status_wire(&lines(&log)).len(), 2);
    for (turn, wire) in [("one", 4), ("two", 4)] {
        s.send_input(turn, &[], SendOptions::default());
        until(&mut sub, &mut notices, |e| {
            e["type"] == "turn_status" && e["status"] == "idle"
        })
        .await;
        settle(&s).await;
        drain(&mut sub, &mut notices);
        assert_eq!(status_wire(&lines(&log)).len(), wire, "after {turn}");
    }
    assert_eq!(notices.len(), 1);
    mgr.remove(&s.id).await;
}

/// Every open tab gets a notice once; it's never replayed to a later one.
#[tokio::test]
async fn every_tab_gets_the_notice_once_and_it_is_not_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("stdin.log");
    let script = json!({"control": {"mcp_status": {"mcpServers": [
        {"name": "gh", "status": "needs-auth"},
        {"name": "sl", "status": "failed"},
    ]}}});
    let s = Session::new(SessionOptions {
        cwd: Some(dir.path().canonicalize().unwrap().display().to_string()),
        runtime: runtime(&script, &log),
        ..Default::default()
    })
    .unwrap();
    let mut tabs = [
        s.subscribe(None, None),
        s.subscribe(None, Some("t2".into())),
    ];
    s.start().await;
    let want = vec![
        json!({"type": "mcp_needs_auth_notice", "servers": ["gh"]}),
        json!({"type": "mcp_disconnected_notice", "servers": ["sl"]}),
    ];
    for tab in &mut tabs {
        let mut notices = vec![];
        until(tab, &mut notices, is_init).await;
        settle(&s).await;
        drain(tab, &mut notices);
        assert_eq!(notices, want);
    }
    let mut late = s.subscribe(None, Some("t3".into()));
    let mut notices = vec![];
    until(&mut late, &mut notices, |e| e["type"] == "replay_done").await;
    assert_eq!(notices, Vec::<Value>::new());
    s.end().await;
}

/// The startup checks are independent, as TS's two `void` calls: a status
/// request the CLI never answers holds up only its own check.
#[tokio::test]
async fn an_unanswered_status_request_holds_up_only_its_own_check() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("stdin.log");
    let script = json!({"control": {"mcp_status": {"$sequence": [
        {"$no_reply": true},
        {"mcpServers": [{"name": "sl", "status": "failed"}]},
    ]}}});
    let s = Session::new(SessionOptions {
        cwd: Some(dir.path().canonicalize().unwrap().display().to_string()),
        runtime: runtime(&script, &log),
        ..Default::default()
    })
    .unwrap();
    let mut sub = s.subscribe(None, None);
    s.start().await;
    let mut notices = vec![];
    until(&mut sub, &mut notices, |e| {
        e["type"] == "mcp_disconnected_notice"
    })
    .await;
    assert_eq!(
        notices,
        [json!({"type": "mcp_disconnected_notice", "servers": ["sl"]})]
    );
    // Ending the session fails the unanswered request; the check ends.
    s.end().await;
    settle(&s).await;
}
