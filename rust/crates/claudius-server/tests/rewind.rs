//! `POST /api/sessions/:id/rewind` (S13) against the real binary and the
//! fake CLI: the fake-CLI rewind round trip. Replays the TS handler's
//! recorded cases (`claudius-core/tests/fixtures/rewind_golden.json`,
//! recorded by `rust/scripts/rewind-golden.mjs`) in order, one session per
//! group: the request bytes as recorded, the status and body byte for byte,
//! and the `rewind_files` request the CLI got (byte for byte, the request id
//! as `$ID`). Groups: request validation and the fake's canned reply;
//! replies scripted per session (`canRewind: false`, an error, odd shapes,
//! number text); a session whose CLI never started (`session not active`);
//! one whose CLI exited after `initialize`; and lone-surrogate escapes in
//! `userMessageId`, whose wire is compared with each lone surrogate as
//! U+FFFD ([`LONE_SURROGATES`]).
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use common::{Server, World, free_port, http, read_until, wait_until};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../claudius-core/tests/fixtures/rewind_golden.json"
    ))
    .unwrap()
}

/// Recorded cases where Rust differs, by request body, and why. Each must
/// still differ, so a fix shows up here.
const GAPS: &[(&str, &str)] = &[(
    "{\"userMessageId\":\"u1\",\"deep\":[[[[[[[[[[",
    "V8 parses nesting past 128 levels; serde_json refuses it, so the body is a 503 \
     with serde's recursion-limit message instead of a rewind",
)];

/// The group whose `userMessageId`s hold lone-surrogate escapes (I20; the
/// fake reads them as `JSON.parse` does, so TS gets its reply). `JsonBody`
/// reads each as U+FFFD, so the CLI gets U+FFFD's bytes where the SDK writes
/// the lone surrogate back as its escape. The answers must match as
/// recorded, the wire once each escape is read as U+FFFD ([`lossy_line`]).
const LONE_SURROGATES: &str = "lone surrogates";

/// A recorded wire line with each `\udXXX` escape as U+FFFD: what the Rust
/// host writes. `JSON.stringify` escapes only lone surrogates that way (a
/// pair is written as its character), and an escaped backslash stays.
fn lossy_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find('\\') {
        out.push_str(&rest[..at]);
        let escape = &rest[at..];
        let unit = escape
            .strip_prefix("\\u")
            .and_then(|hex| hex.get(..4))
            .and_then(|hex| u16::from_str_radix(hex, 16).ok());
        let len = if unit.is_some_and(|u| (0xd800..=0xdfff).contains(&u)) {
            out.push('\u{fffd}');
            6
        } else {
            // The escaped character too, so `\\` doesn't start an escape.
            let len = escape[1..].chars().next().map_or(1, |c| 1 + c.len_utf8());
            out.push_str(&escape[..len]);
            len
        };
        rest = &escape[len..];
    }
    out.push_str(rest);
    out
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// `POST path` with exactly these body bytes, or none at all (no
/// `Content-Length`) → (status, body).
fn post_bytes(port: u16, path: &str, body: Option<&[u8]>) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let length = body.map_or_else(String::new, |b| {
        format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        )
    });
    write!(
        s,
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{length}Connection: close\r\n\r\n"
    )
    .unwrap();
    s.write_all(body.unwrap_or_default()).unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let status = out
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = out
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_owned())
        .unwrap_or_default();
    (status, body)
}

fn log_lines(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// The `rewind_files` control requests written since line `from`, ids as
/// `$ID`.
fn wire_since(log: &Path, from: usize) -> Vec<String> {
    log_lines(log)
        .into_iter()
        .skip(from)
        .filter_map(|l| {
            let m: Value = serde_json::from_str(&l).ok()?;
            (m["type"] == "control_request" && m["request"]["subtype"] == "rewind_files").then(
                || {
                    let id = serde_json::to_string(&m["request_id"]).unwrap();
                    l.replacen(&id, "\"$ID\"", 1)
                },
            )
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

/// `(status, body, wire)` of one recorded case.
type Outcome = (u16, String, Vec<String>);

fn expected(case: &Value) -> Outcome {
    assert!(case.get("threw").is_none(), "{case}");
    (
        case["status"].as_u64().unwrap() as u16,
        case["body"].as_str().unwrap().to_owned(),
        strings(&case["wire"]),
    )
}

/// One recorded group on `server`'s one session. Returns how many cases
/// matched.
fn replay_group(server: &Server, world: &World, log: &Path, group: &Value) -> usize {
    let name = group["name"].as_str().unwrap();
    let id = server.create_session(world);
    let mut sse = server.open_stream(&id);
    match group["query"].as_str().unwrap() {
        "live" => {
            read_until(&mut sse, r#""type":"tips""#, Duration::from_secs(10));
        }
        // The session reports the exit once the SDK host's cleanup has run.
        "exited" => {
            read_until(&mut sse, "exited with code 3", Duration::from_secs(10));
        }
        _ => {}
    }
    let mut matched = 0;
    let mut lossy = 0;
    for (i, case) in group["cases"].as_array().unwrap().iter().enumerate() {
        let bytes = case["requestHex"].as_str().map(unhex);
        let shown = String::from_utf8_lossy(bytes.as_deref().unwrap_or_default());
        let target = if case["id"] == "live" {
            id.as_str()
        } else {
            case["id"].as_str().unwrap()
        };
        let from = log_lines(log).len();
        let (status, text) = post_bytes(
            server.port,
            &format!("/api/sessions/{target}/rewind"),
            bytes.as_deref(),
        );
        let got = (status, text, wire_since(log, from));
        let mut want = expected(case);
        if name == LONE_SURROGATES {
            let wire: Vec<String> = want.2.iter().map(|l| lossy_line(l)).collect();
            lossy += usize::from(wire != want.2);
            want.2 = wire;
        }
        match GAPS.iter().find(|(prefix, _)| shown.starts_with(prefix)) {
            Some((_, why)) => assert_ne!(got, want, "{name} case {i}: stale gap: {why}"),
            None => {
                assert_eq!(got, want, "{name} case {i}: {shown:?}");
                matched += 1;
            }
        }
    }
    if name == LONE_SURROGATES {
        assert!(
            lossy >= 8,
            "{name}: only {lossy} cases put a lone surrogate on the wire"
        );
    }
    matched
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
        let server = match group["query"].as_str().unwrap() {
            "none" => spawn_without_cli(&world),
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
                Server::spawn(&world, &env)
            }
        };
        matched += replay_group(&server, &world, &log, group);
    }
    assert_eq!(matched + GAPS.len(), total);
    assert!(total >= 110, "{total} cases");
    assert!(
        groups.iter().any(|g| g["name"] == LONE_SURROGATES),
        "no {LONE_SURROGATES:?} group"
    );
}

#[test]
fn lossy_line_reads_only_lone_surrogate_escapes() {
    assert_eq!(
        lossy_line(r#"{"a":"x\ud800y\uDC00","b":"\\ud800\\\udfff\u00e9\n"}"#),
        "{\"a\":\"x\u{fffd}y\u{fffd}\",\"b\":\"\\\\ud800\\\\\u{fffd}\\u00e9\\n\"}"
    );
    assert_eq!(lossy_line(r"\ud80"), r"\ud80");
}

/// `sessionManager.get`, not `getOrResume`: a session that isn't live is a
/// 404 even with its transcript on disk, and no CLI is started for it.
#[test]
fn a_session_on_disk_is_not_resumed() {
    let world = World::new();
    let log = world.root.path().join("stdin.log");
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_LOG", &log.display().to_string())]);
    let id = "7c2e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b31";
    let project = world.project.display().to_string();
    let dir = world
        .config
        .join("projects")
        .join(claudius_core::paths::sdk_project_dir_name(&project));
    std::fs::create_dir_all(&dir).unwrap();
    let line = serde_json::json!({"type": "user", "uuid": "u1", "parentUuid": null, "sessionId": id,
        "cwd": project, "timestamp": "2026-01-02T03:04:05.000Z",
        "message": {"role": "user", "content": "hi"}});
    std::fs::write(dir.join(format!("{id}.jsonl")), format!("{line}\n")).unwrap();
    let (status, body) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/rewind"),
        r#"{"userMessageId":"u1"}"#,
    );
    assert_eq!(
        (status, body.as_str()),
        (404, r#"{"error":"session not found"}"#)
    );
    assert!(!log.exists(), "a CLI was started");
}

/// Only POST is routed: other methods get axum's 405 (Next's answer for a
/// method the route doesn't export), not the 501 guard.
#[test]
fn other_methods_are_405() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let id = server.create_session(&world);
    for method in ["GET", "PUT", "PATCH", "DELETE"] {
        let (status, _) = http(
            server.port,
            method,
            &format!("/api/sessions/{id}/rewind"),
            "",
        );
        assert_eq!(status, 405, "{method}");
    }
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
