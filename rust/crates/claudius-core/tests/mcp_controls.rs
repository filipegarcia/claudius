//! The session's MCP controls (S15a), replayed against the TS recording in
//! `tests/fixtures/mcp_delta_golden.json` (`rust/scripts/mcp-delta-golden.mjs`):
//! - `bodies`: `mcp_delta_reminder_body` on every recorded delta;
//! - `controls`, without a CLI: `set_servers_delta` on every recorded
//!   `mcp_set_servers` reply gives the reminder TS queued;
//! - `controls`, on a real `Session` with the fake CLI answering as the case
//!   scripts it: each call's outcome, the `mcp_*` control requests it wrote
//!   (byte for byte, the request id as `$ID`), and the user message of the
//!   next turn, which starts with the reminders TS queued (the turn after it
//!   carries none).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use claudius_agent::{McpServerConfig, js};
use claudius_core::mcp_delta::{McpDelta, mcp_delta_reminder_body, set_servers_delta};
use claudius_core::paths;
use claudius_core::session::{RuntimeOptions, SendOptions, Session, SessionOptions, Subscription};
use claudius_core::session_manager::SessionManager;
use serde_json::Value;

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("fixtures/mcp_delta_golden.json")).unwrap())
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|s| s.as_str().unwrap().to_owned()).collect())
        .unwrap_or_default()
}

fn delta_of(v: &Value) -> McpDelta {
    McpDelta {
        added: strings(&v["added"]),
        removed: strings(&v["removed"]),
        disabled: strings(&v["disabled"]),
        reconnecting: strings(&v["reconnecting"]),
    }
}

fn wrap(body: &str) -> String {
    format!("<system-reminder>\n{body}\n</system-reminder>\n\n")
}

#[test]
fn reminder_bodies_match_the_ts() {
    let bodies = fixture()["bodies"].as_array().unwrap();
    assert!(bodies.len() >= 30);
    for case in bodies {
        let got = mcp_delta_reminder_body(&delta_of(&case["delta"]));
        assert_eq!(
            got.as_deref(),
            case["body"].as_str(),
            "delta {}",
            case["delta"]
        );
    }
}

/// The scripted `mcp_set_servers` reply of a case, as the fake CLI sends it.
fn scripted_reply(case: &Value) -> Option<Value> {
    let script = match &case["script"] {
        Value::String(text) => serde_json::from_str(text).unwrap(),
        v => v.clone(),
    };
    script["control"].get("mcp_set_servers").cloned()
}

#[test]
fn set_servers_replies_give_the_ts_reminder() {
    let mut n = 0;
    for case in fixture()["controls"].as_array().unwrap() {
        let calls = case["calls"].as_array().unwrap();
        let Some(reply) = scripted_reply(case) else {
            continue;
        };
        if reply.get("$error").is_some() || calls.len() != 1 {
            continue;
        }
        n += 1;
        let got = mcp_delta_reminder_body(&set_servers_delta(&reply)).map(|b| wrap(&b));
        assert_eq!(
            got.as_deref(),
            case["reminder"].as_str(),
            "{}",
            case["name"]
        );
    }
    assert!(n >= 30, "{n} cases");
}

// ─────────────────────────────── fake CLI ───────────────────────────────

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
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let st = std::process::Command::new(cargo)
            .args([
                "build",
                "-q",
                "-p",
                "claudius-agent",
                "--bin",
                "claudius-fake-claude",
            ])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .unwrap();
        assert!(st.success());
        let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/debug/claudius-fake-claude");
        (root, bin)
    })
    .1
}

struct Run {
    cwd: tempfile::TempDir,
    log: PathBuf,
    runtime: RuntimeOptions,
}

impl Run {
    fn new(script: &Value) -> Run {
        let cwd = tempfile::tempdir().unwrap();
        let log = cwd.path().join("stdin.log");
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
        env.insert("FAKE_CLAUDE_LOG".into(), log.display().to_string());
        match script {
            Value::Null => {}
            Value::String(text) => {
                env.insert("FAKE_CLAUDE_SCRIPT".into(), text.clone());
            }
            v => {
                env.insert("FAKE_CLAUDE_SCRIPT".into(), v.to_string());
            }
        }
        Run {
            log,
            runtime: RuntimeOptions {
                claude_bin: Some(fake().clone()),
                env_override: Some(env),
            },
            cwd,
        }
    }

    fn opts(&self) -> SessionOptions {
        SessionOptions {
            cwd: Some(
                self.cwd
                    .path()
                    .canonicalize()
                    .unwrap()
                    .display()
                    .to_string(),
            ),
            runtime: self.runtime.clone(),
            ..Default::default()
        }
    }

    fn lines(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// The `mcp_*` control requests written since line `from`, ids as `$ID`.
    fn wire_since(&self, from: usize) -> Vec<String> {
        self.lines()
            .into_iter()
            .skip(from)
            .filter_map(|l| {
                let m: Value = serde_json::from_str(&l).ok()?;
                let subtype = m["request"]["subtype"].as_str()?;
                (m["type"] == "control_request" && subtype.starts_with("mcp_")).then(|| {
                    let id = serde_json::to_string(&m["request_id"]).unwrap();
                    l.replacen(&id, "\"$ID\"", 1)
                })
            })
            .collect()
    }

    /// The content of the last user message the CLI got.
    fn last_user_content(&self) -> String {
        self.lines()
            .iter()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .rfind(|m| m["type"] == "user")
            .and_then(|m| m["message"]["content"].as_str().map(str::to_owned))
            .expect("a user message")
    }
}

async fn next(sub: &mut Subscription) -> Value {
    tokio::time::timeout(Duration::from_secs(10), sub.recv())
        .await
        .expect("event timeout")
        .expect("stream closed")
}

async fn until(sub: &mut Subscription, pred: impl Fn(&Value) -> bool) {
    while !pred(&next(sub).await) {}
}

async fn turn(s: &Session, sub: &mut Subscription, text: &str) {
    s.send_input(text, &[], SendOptions::default());
    until(sub, |e| {
        e["type"] == "turn_status" && e["status"] == "running"
    })
    .await;
    until(sub, |e| e["type"] == "turn_status" && e["status"] == "idle").await;
}

/// A recorded outcome as text: `ok`, `ok <data>` (JSON text, `null` for the
/// SDK's `undefined`) or `err <message>`.
fn expected_outcome(o: &Value) -> String {
    match (o["ok"].as_bool().unwrap(), o.get("data")) {
        (true, None) => "ok".into(),
        (true, Some(d)) => format!("ok {}", js::stringify(d)),
        (false, _) => format!("err {}", o["error"].as_str().unwrap()),
    }
}

async fn run_call(s: &Session, call: &Value) -> String {
    let unit = |r: Result<(), String>| r.map_or_else(|e| format!("err {e}"), |()| "ok".into());
    let data = |r: Result<Value, String>| {
        r.map_or_else(
            |e| format!("err {e}"),
            |d| format!("ok {}", js::stringify(&d)),
        )
    };
    let arg = |i: usize| call[i].as_str().unwrap();
    match call[0].as_str().unwrap() {
        "mcpServerStatus" => data(s.mcp_server_status().await),
        "reconnectMcp" => unit(s.reconnect_mcp(arg(1)).await),
        "toggleMcp" => unit(s.toggle_mcp(arg(1), call[2].as_bool().unwrap()).await),
        "setMcpServers" => {
            let servers = call[1]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), McpServerConfig::External(v.clone())));
            data(s.set_mcp_servers(servers).await)
        }
        m => panic!("unknown call {m}"),
    }
}

/// Every recorded call against one session, then the next two turns.
async fn replay(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let run = Run::new(&case["script"]);
    let query = case["query"].as_str().unwrap();
    let mgr = Arc::new(SessionManager::default());
    let s = match query {
        "none" => Session::new(run.opts()).unwrap(),
        _ => mgr.create(run.opts()).await.expect("create"),
    };
    let mut sub = s.subscribe(None, None);
    if query == "live" {
        // The startup MCP notices (S15b) ask for the status at the init (as
        // TS does, but TS recorded these calls on a bare session that has
        // none): let them finish, so their two `mcp_status` requests stay
        // out of the first call's window. No turn runs during the calls, so
        // no turn-end re-check does either.
        until(&mut sub, |e| {
            e["type"] == "sdk" && e["message"]["subtype"] == "init"
        })
        .await;
        s.mcp_notices.settled().await;
        assert_eq!(run.wire_since(0).len(), 2, "{name}: the startup checks");
    } else if query == "ended" {
        s.end().await;
        // TS recorded these once the SDK's stream had ended and its cleanup
        // had run. `end()` returns once the CLI has exited and the reader's
        // cleanup follows; until then a call fails with the abort instead.
        let closed = "Query closed before response received";
        let mut settled = false;
        for _ in 0..250 {
            match s.mcp_server_status().await {
                Err(e) if e == closed => {
                    settled = true;
                    break;
                }
                Err(e) => assert_eq!(e, "Operation aborted", "{name}"),
                Ok(v) => panic!("{name}: an ended session answered {v}"),
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(settled, "{name}: the query never closed");
    }
    for (i, c) in case["calls"].as_array().unwrap().iter().enumerate() {
        let from = run.lines().len();
        let got = run_call(&s, &c["call"]).await;
        assert_eq!(
            got,
            expected_outcome(&c["outcome"]),
            "{name} call {i}: {}",
            c["call"]
        );
        assert_eq!(
            run.wire_since(from),
            strings(&c["wire"]),
            "{name} call {i}: wire"
        );
    }
    if query == "ended" {
        return;
    }
    if query == "none" {
        // Nothing was queued while there was no query.
        s.start().await;
        until(&mut sub, |e| e["type"] == "tips").await;
    }
    turn(&s, &mut sub, "probe one").await;
    let reminder = case["reminder"].as_str().unwrap_or("");
    assert_eq!(
        run.last_user_content(),
        format!("{reminder}probe one"),
        "{name}: the next turn"
    );
    turn(&s, &mut sub, "probe two").await;
    assert_eq!(run.last_user_content(), "probe two", "{name}: drained once");
    s.end().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn control_calls_round_trip_the_fake_cli() {
    let cases = fixture()["controls"].as_array().unwrap();
    assert!(cases.len() >= 50);
    // A few at a time: each case is its own CLI.
    for chunk in cases.chunks(8) {
        futures::future::join_all(chunk.iter().map(replay)).await;
    }
}
