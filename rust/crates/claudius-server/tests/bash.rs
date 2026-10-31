//! `POST /api/sessions/:id/bash` (`!` mode) against the real binary, replaying
//! the `route` half of `claudius-core/tests/fixtures/bash_golden.json`
//! (recorded by `rust/scripts/bash-golden.mjs` from the real TS handler and
//! `Session.runBashCommand` on a real shell). The same request bodies, in
//! order, on one live session, with the same fake `sudo` first on PATH:
//! every status and body must match (a random uuid reads `<uuid>`; "threw"
//! is Next's empty 500), the chat must get the same synthetic user messages,
//! and the next prompt must carry the same `<bash-*>` blocks.
#![cfg(unix)]

mod common;

use std::io::Read;
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use common::{Server, World, http, process_alive, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/bash_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn is_v4(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|u| u.get_version_num() == 4)
        && s == uuid::Uuid::parse_str(s).unwrap().hyphenated().to_string()
}

/// The recorder's normalization: a v4 uuid the request didn't send.
fn norm_uuid(v: &mut Value, request: &str) {
    if let Some(s) = v.as_str()
        && is_v4(s)
        && !request.contains(s)
    {
        *v = json!("<uuid>");
    }
}

/// The `!` echoes on the session's stream: synthetic user messages whose
/// content opens with `<bash-input>`.
fn bash_events(sse: &mut TcpStream, want: usize, session_id: &str, fx_id: &str) -> Vec<Value> {
    sse.set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let start = Instant::now();
    let mut raw = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        let text = String::from_utf8_lossy(&raw).into_owned();
        let events: Vec<Value> = text
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|d| serde_json::from_str::<Value>(d).ok())
            .filter(|e| {
                e["type"] == "sdk"
                    && e["message"]["type"] == "user"
                    && e["message"]["message"]["content"]
                        .as_str()
                        .is_some_and(|c| c.starts_with("<bash-input>"))
            })
            .map(|mut e| {
                // `broadcast()` stamps `sdk` events with `at` (TS too); the
                // recorder captured them before that.
                assert!(e["at"].is_u64(), "{e}");
                e.as_object_mut().unwrap().remove("at");
                assert_eq!(e["message"]["session_id"], session_id);
                e["message"]["session_id"] = json!(fx_id);
                let mut u = e["message"]["uuid"].take();
                norm_uuid(&mut u, "");
                e["message"]["uuid"] = u;
                e
            })
            .collect();
        if events.len() >= want {
            return events;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "only {} of {want} bash events",
            events.len()
        );
        match sse.read(&mut buf) {
            Ok(0) => panic!("stream closed"),
            Ok(n) => raw.extend_from_slice(&buf[..n]),
            Err(_) => {}
        }
    }
}

#[test]
fn the_route_matches_the_ts_handler_case_by_case() {
    let fx = fixture();
    let route = &fx["route"];
    let world = World::new();
    let bin = world.root.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let sudo = bin.join("sudo");
    std::fs::write(&sudo, fx["fakeSudo"].as_str().unwrap()).unwrap();
    std::fs::set_permissions(&sudo, std::fs::Permissions::from_mode(0o755)).unwrap();
    let stdin_log = world.root.path().join("stdin.log");
    let path = format!("{}:/usr/bin:/bin", bin.display());
    let server = Server::spawn(
        &world,
        &[
            ("PATH", &path),
            ("FAKE_CLAUDE_LOG", &stdin_log.display().to_string()),
        ],
    );
    let id = server.create_session(&world);
    let mut sse = server.open_stream(&id);

    let mut failures = Vec::new();
    for case in route["cases"].as_array().unwrap() {
        let body = case["body"].as_str().unwrap();
        let target = if case["id"] == "live" { &id } else { "missing" };
        let (st, text) = http(
            server.port,
            "POST",
            &format!("/api/sessions/{target}/bash"),
            body,
        );
        let got = if st == 500 && text.is_empty() {
            json!({"threw": case["got"]["threw"]})
        } else {
            let mut b: Value =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{body}: {e}: {text:?}"));
            if let Some(u) = b.get_mut("uuid") {
                norm_uuid(u, body);
            }
            json!({"status": st, "body": b})
        };
        if got != case["got"] {
            failures.push(format!("{body}\n  ts:   {}\n  rust: {got}", case["got"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));

    // The chat's BashIO rows, in order.
    let want = route["events"].as_array().unwrap();
    let fx_id = route["sessionId"].as_str().unwrap();
    let got = bash_events(&mut sse, want.len(), &id, fx_id);
    assert_eq!(&got, want);

    // The next prompt carries every block, ahead of the typed text.
    let (st, _) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/input"),
        r#"{"text":"hi"}"#,
    );
    assert_eq!(st, 200);
    let want = format!("{}hi", route["pending"].as_str().unwrap());
    let user_contents = || -> Vec<Value> {
        std::fs::read_to_string(&stdin_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|m| m["type"] == "user")
            .map(|m| m["message"]["content"].clone())
            .collect()
    };
    wait_until(
        "the prompt reached the CLI",
        Duration::from_secs(10),
        || !user_contents().is_empty(),
    );
    assert_eq!(user_contents(), vec![json!(want)]);

    // Drained: the following prompt is bare.
    let (st, _) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/input"),
        r#"{"text":"again"}"#,
    );
    assert_eq!(st, 200);
    wait_until("the second prompt", Duration::from_secs(10), || {
        user_contents().len() == 2
    });
    assert_eq!(user_contents()[1], json!("again"));
    server.stop(Duration::from_secs(15));
}

/// The shell (and anything it started) goes with the session.
#[test]
fn ending_the_session_kills_the_shell() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let id = server.create_session(&world);
    let (st, text) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/bash"),
        r#"{"command":"sleep 300 & echo $! $$"}"#,
    );
    assert_eq!(st, 200, "{text}");
    let body: Value = serde_json::from_str(&text).unwrap();
    let pids: Vec<u32> = body["stdout"]
        .as_str()
        .unwrap()
        .split_whitespace()
        .map(|p| p.parse().unwrap())
        .collect();
    assert!(pids.iter().all(|&p| process_alive(p)), "{pids:?}");
    let (st, _) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/dev-reap"),
        "{}",
    );
    assert_eq!(st, 200);
    wait_until(
        "the shell and its job are gone",
        Duration::from_secs(10),
        || pids.iter().all(|&p| !process_alive(p)),
    );
    server.stop(Duration::from_secs(15));
}
