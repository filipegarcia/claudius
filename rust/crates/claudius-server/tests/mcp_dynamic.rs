//! `POST /api/sessions/:id/mcp-dynamic` (S15a) against the real binary and
//! the fake CLI, replaying the TS handler's recorded cases
//! (`claudius-core/tests/fixtures/mcp_delta_golden.json`, recorded by
//! `rust/scripts/mcp-delta-golden.mjs`) in order, one session per group:
//! the status and body byte for byte, the `mcp_set_servers` request the CLI
//! got (byte for byte, the request id as `$ID`), and the reminder the next
//! turn's user message starts with. Groups: request validation and the
//! CLI's own add/remove diff on one session; CLI replies scripted per
//! session (an error, odd shapes, number text); and a session whose CLI
//! never started (`no active query`).
#![cfg(unix)]

mod common;

use std::io::Read;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use common::{Server, World, free_port, http, read_until, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../claudius-core/tests/fixtures/mcp_delta_golden.json"
    ))
    .unwrap()
}

/// Recorded cases where Rust differs, by request body, and why. Each must
/// still differ, so a fix shows up here.
const GAPS: &[(&str, &str)] = &[
    (
        r#"{"servers":{"x":{"type":"sdk","instance":{}}}}"#,
        "the SDK takes `type: \"sdk\"` + `instance` for an in-process server and throws \
         connecting it (503, a minified `t.instance.connect is not a function`); Rust sends it \
         to the CLI as a config",
    ),
    (
        r#"{"servers":{"x":{"type":"sdk","instance":null}}}"#,
        "the same, with `Cannot read properties of null (reading 'connect')`",
    ),
];

/// Case `n`'s probe turn: post `probe <n>`, wait for the turn to end, and
/// return the content of the user message the CLI got.
fn probe(server: &Server, sse: &mut TcpStream, id: &str, log: &Path, n: usize) -> String {
    let text = format!("probe {n}");
    let (st, _) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/input"),
        &json!({ "text": text }).to_string(),
    );
    assert_eq!(st, 200);
    let running = r#""status":"running""#;
    let idle = r#""status":"idle""#;
    let seen = read_until(sse, running, Duration::from_secs(10));
    if !seen[seen.find(running).unwrap()..].contains(idle) {
        read_until(sse, idle, Duration::from_secs(10));
    }
    let content = std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .rfind(|m| m["type"] == "user")
        .and_then(|m| m["message"]["content"].as_str().map(str::to_owned))
        .unwrap();
    assert!(content.ends_with(&text), "{content}");
    content
}

fn log_lines(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// The `mcp_*` control requests written since line `from`, ids as `$ID`.
/// The session's own `mcp_status` checks (S15b: at the init, and after a
/// probe turn at most every 30 s) run in the background and are left out:
/// the route never sends one (`no_recorded_route_wire_has_a_status_check`).
fn wire_since(log: &Path, from: usize) -> Vec<String> {
    log_lines(log)
        .into_iter()
        .skip(from)
        .filter_map(|l| {
            let m: Value = serde_json::from_str(&l).ok()?;
            let subtype = m["request"]["subtype"].as_str()?;
            (m["type"] == "control_request"
                && subtype.starts_with("mcp_")
                && subtype != "mcp_status")
                .then(|| {
                    let id = serde_json::to_string(&m["request_id"]).unwrap();
                    l.replacen(&id, "\"$ID\"", 1)
                })
        })
        .collect()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

/// `(status, body, wire, reminder)` of one recorded case.
type Outcome = (u16, String, Vec<String>, String);

fn expected(case: &Value) -> Outcome {
    (
        case["status"].as_u64().unwrap() as u16,
        case["body"].as_str().unwrap().to_owned(),
        strings(&case["wire"]),
        case["reminder"].as_str().unwrap_or("").to_owned(),
    )
}

/// One recorded group on `server`'s one session; `live` sessions get a probe
/// turn after each case. Returns how many cases matched.
fn replay_group(server: &Server, world: &World, log: &Path, group: &Value, live: bool) -> usize {
    let name = group["name"].as_str().unwrap();
    let id = server.create_session(world);
    let mut sse = server.open_stream(&id);
    read_until(&mut sse, r#""type":"tips""#, Duration::from_secs(10));
    let mut matched = 0;
    for (i, case) in group["cases"].as_array().unwrap().iter().enumerate() {
        let body = case["body"].as_str().unwrap();
        let req = case_request(case);
        let target = if case["id"] == "live" {
            id.as_str()
        } else {
            case["id"].as_str().unwrap()
        };
        let from = log_lines(log).len();
        let (status, text) = http(
            server.port,
            "POST",
            &format!("/api/sessions/{target}/mcp-dynamic"),
            req,
        );
        let wire = wire_since(log, from);
        let reminder = if live {
            let content = probe(server, &mut sse, &id, log, i);
            content[..content.len() - format!("probe {i}").len()].to_owned()
        } else {
            String::new()
        };
        let got = (status, text, wire, reminder);
        let want = expected(case);
        match GAPS.iter().find(|(b, _)| *b == req) {
            Some((_, why)) => assert_ne!(got, want, "{name} case {i} ({req}): stale gap: {why}"),
            None => {
                assert_eq!(got, want, "{name} case {i}: {req}\n(response {body})");
                matched += 1;
            }
        }
    }
    matched
}

/// The request body a recorded case sent (the fixture's `body` is the
/// response; the request is kept beside it).
fn case_request(case: &Value) -> &str {
    case["request"].as_str().unwrap()
}

#[test]
fn the_route_replays_the_ts_handler() {
    let fx = fixture();
    let groups = fx["route"].as_array().unwrap();
    let mut matched = 0;
    let mut total = 0;
    for group in groups {
        total += group["cases"].as_array().unwrap().len();
        let world = World::new();
        let log = world.root.path().join("stdin.log");
        let log_env = log.display().to_string();
        match group["query"].as_str().unwrap() {
            "none" => {
                let server = spawn_without_cli(&world);
                matched += replay_group(&server, &world, &log, group, false);
            }
            _ => {
                let script = match &group["script"] {
                    Value::Null => None,
                    Value::String(s) => Some(s.clone()),
                    v => Some(v.to_string()),
                };
                let mut env = vec![("FAKE_CLAUDE_LOG", log_env.as_str())];
                if let Some(s) = &script {
                    env.push(("FAKE_CLAUDE_SCRIPT", s));
                }
                let server = Server::spawn(&world, &env);
                matched += replay_group(&server, &world, &log, group, true);
            }
        }
    }
    assert_eq!(matched + GAPS.len(), total);
    assert!(total >= 55, "{total} cases");
}

/// `claudius` with a `claude` that doesn't exist: sessions are created, but
/// their CLI never starts, so they have no query.
fn spawn_without_cli(world: &World) -> Server {
    let port = free_port();
    let missing: PathBuf = world.root.path().join("no-such-claude");
    let mut child = Command::new(env!("CARGO_BIN_EXE_claudius"))
        .args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(&missing)
        .current_dir(&world.project)
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_DEV")
        .env("CLAUDIUS_STATE_HOME", &world.home)
        .env("CLAUDE_CONFIG_DIR", &world.config)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_until("health", Duration::from_secs(20), || {
        if let Ok(Some(st)) = child.try_wait() {
            let mut out = String::new();
            child
                .stdout
                .take()
                .unwrap()
                .read_to_string(&mut out)
                .unwrap();
            panic!("claudius exited ({st}):\n{out}");
        }
        TcpStream::connect(("127.0.0.1", port)).is_ok()
            && http(port, "GET", "/api/rust/health", "").0 == 200
    });
    Server { child, port }
}

/// What `wire_since` leaves out never belongs to the route.
#[test]
fn no_recorded_route_wire_has_a_status_check() {
    let fx = fixture();
    let mut lines = 0;
    for group in fx["route"].as_array().unwrap() {
        for case in group["cases"].as_array().unwrap() {
            for line in strings(&case["wire"]) {
                lines += 1;
                let m: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(m["request"]["subtype"], "mcp_set_servers", "{line}");
            }
        }
    }
    assert!(lines >= 20, "{lines} wire lines");
}
