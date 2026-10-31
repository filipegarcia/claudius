//! The dev-only `dev-*` routes answer exactly like their TS handlers: on in a
//! dev run, refused with each handler's own status and error when
//! `NODE_ENV=production`, the TS condition. The refusal comes before the
//! session lookup and body parse. `CLAUDIUS_DEV` overrides both ways (I10).
//! The real binary is used so the env decision is covered too.
#![cfg(unix)]

mod common;

use std::io::Read;
use std::time::{Duration, Instant};

use common::{Server, World, http};
use serde_json::{Value, json};

const MISSING: &str = "00000000-0000-4000-8000-000000000000";

fn post(server: &Server, route: &str, body: &str) -> (u16, Value) {
    let (st, b) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{MISSING}/{route}"),
        body,
    );
    (st, serde_json::from_str(&b).unwrap_or(Value::Null))
}

fn assert_refused(server: &Server, why: &str) {
    for body in ["", "{", r#"{"event":{"type":"x"}}"#] {
        for route in ["dev-broadcast", "dev-reap"] {
            assert_eq!(
                post(server, route, body),
                (404, json!({"error": "dev-only endpoint"})),
                "{why}: {route} {body:?}"
            );
        }
        assert_eq!(
            post(server, "dev-inject-denial", body),
            (403, json!({"error": "dev only"})),
            "{why}: dev-inject-denial {body:?}"
        );
    }
}

/// Enabled, on an unknown session id: each route's own validation order.
fn assert_enabled(server: &Server, why: &str) {
    let br = |body| post(server, "dev-broadcast", body);
    // Body is checked before the session lookup; a malformed body reads as `{}`.
    for body in [
        "",
        "{",
        "{}",
        r#"{"event":null}"#,
        r#"{"event":0}"#,
        r#"{"event":""}"#,
    ] {
        assert_eq!(
            br(body),
            (400, json!({"error": "event required"})),
            "{why}: {body:?}"
        );
    }
    // `body.event` on a literal `null` body throws → Next's bare 500.
    assert_eq!(br("null"), (500, Value::Null), "{why}");
    assert_eq!(
        br(r#"{"event":{"type":"x"}}"#),
        (404, json!({"error": "session not bound"})),
        "{why}"
    );
    assert_eq!(
        post(server, "dev-reap", ""),
        (200, json!({"ok": true, "reaped": false})),
        "{why}"
    );
    // The session lookup comes first here, so even a `null` body is a 404.
    for body in ["{}", "null"] {
        assert_eq!(
            post(server, "dev-inject-denial", body),
            (404, json!({"error": "session not found"})),
            "{why}: {body:?}"
        );
    }
}

#[test]
fn dev_routes_follow_node_env_and_claudius_dev() {
    let world = World::new();

    // Debug build, no env: a dev run, like `next dev`.
    let s = Server::spawn(&world, &[]);
    assert_enabled(&s, "debug default");
    // POST-only, like the TS route files.
    assert_eq!(
        http(
            s.port,
            "GET",
            &format!("/api/sessions/{MISSING}/dev-reap"),
            ""
        )
        .0,
        405
    );
    let (_, log, _) = s.stop(Duration::from_secs(15));
    assert!(
        log.contains("dev-only test routes (dev-*) enabled"),
        "{log}"
    );

    let s = Server::spawn(&world, &[("NODE_ENV", "production")]);
    assert_refused(&s, "NODE_ENV=production");
    // Nothing else is gated.
    assert_eq!(http(s.port, "GET", "/api/rust/health", "").0, 200);
    let (_, log, _) = s.stop(Duration::from_secs(15));
    assert!(!log.contains("dev-only test routes"), "{log}");

    let s = Server::spawn(&world, &[("CLAUDIUS_DEV", "0")]);
    assert_refused(&s, "CLAUDIUS_DEV=0");
    s.stop(Duration::from_secs(15));

    let s = Server::spawn(&world, &[("CLAUDIUS_DEV", "1"), ("NODE_ENV", "production")]);
    assert_enabled(&s, "CLAUDIUS_DEV=1 beats NODE_ENV");
    s.stop(Duration::from_secs(15));
}

fn on(server: &Server, id: &str, method: &str, route: &str, body: &str) -> (u16, Value) {
    let (st, b) = http(
        server.port,
        method,
        &format!("/api/sessions/{id}/{route}"),
        body,
    );
    (st, serde_json::from_str(&b).unwrap_or(Value::Null))
}

/// Read the session's SSE stream until `needle` shows up (replay included).
fn stream_contains(server: &Server, id: &str, needle: &str) -> bool {
    let mut sse = server.open_stream(id);
    sse.set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let (start, mut seen, mut buf) = (Instant::now(), String::new(), [0u8; 8192]);
    while start.elapsed() < Duration::from_secs(5) {
        match sse.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => seen.push_str(&String::from_utf8_lossy(&buf[..n])),
            Err(_) => {}
        }
        if seen.contains(needle) {
            return true;
        }
    }
    false
}

#[test]
fn dev_routes_drive_a_live_session() {
    let world = World::new();
    let s = Server::spawn(&world, &[]);
    let id = s.create_session(&world);
    let cwd = world.project.display().to_string();

    // dev-broadcast: goes through Session::broadcast (buffered → replayed to
    // a new subscriber) and echoes the session's cwd + id.
    let probe = "broadcast-probe-0451";
    assert_eq!(
        on(
            &s,
            &id,
            "POST",
            "dev-broadcast",
            &json!({"event": {"type": "error", "message": probe}}).to_string()
        ),
        (200, json!({"ok": true, "sessionCwd": cwd, "sessionId": id}))
    );
    assert!(
        stream_contains(&s, &id, probe),
        "broadcast event not replayed"
    );
    // S28: the SSE `data:` line is `JSON.stringify(event)`, JS number text.
    let body = r#"{"event": {"type": "error", "message": "numbers-0452", "n": [1e21, 2.0, 1e16, 0.000001, 1e-7, 18446744073709551616, -0.0]}}"#;
    assert_eq!(on(&s, &id, "POST", "dev-broadcast", body).0, 200);
    let line = r#"data: {"type":"error","message":"numbers-0452","n":[1e+21,2,10000000000000000,0.000001,1e-7,18446744073709552000,0]}"#;
    assert!(stream_contains(&s, &id, line), "SSE number text isn't JS's");

    // dev-inject-denial: defaults and non-string fields fall back to Bash / auto_deny.
    for body in [
        r#"{"toolName":"Write"}"#,
        "{}",
        r#"{"toolName":5,"reasonType":"policy"}"#,
        "{",
    ] {
        assert_eq!(
            on(&s, &id, "POST", "dev-inject-denial", body),
            (200, json!({"ok": true})),
            "{body:?}"
        );
    }
    assert_eq!(
        on(&s, &id, "POST", "dev-inject-denial", "null"),
        (500, Value::Null)
    );
    let (st, d) = on(&s, &id, "GET", "denials", "");
    assert_eq!(st, 200);
    let got: Vec<(String, String)> = d["denials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| {
            assert!(x["at"].as_i64().is_some_and(|t| t > 0), "{x}");
            (
                x["toolName"].as_str().unwrap().into(),
                x["reasonType"].as_str().unwrap().into(),
            )
        })
        .collect();
    let want: Vec<(String, String)> = [
        ("Write", "auto_deny"),
        ("Bash", "auto_deny"),
        ("Bash", "policy"),
        ("Bash", "auto_deny"),
    ]
    .map(|(a, b)| (a.into(), b.into()))
    .into();
    assert_eq!(got, want);
    // The ring keeps the newest 20.
    for i in 0..25 {
        on(
            &s,
            &id,
            "POST",
            "dev-inject-denial",
            &json!({"toolName": format!("T{i}")}).to_string(),
        );
    }
    let (_, d) = on(&s, &id, "GET", "denials", "");
    let names: Vec<&str> = d["denials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["toolName"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 20);
    assert_eq!((names[0], names[19]), ("T5", "T24"));

    // dev-reap: evicts the live session (and its in-memory denials); a second reap is a no-op.
    assert_eq!(
        on(&s, &id, "POST", "dev-reap", ""),
        (200, json!({"ok": true, "reaped": true}))
    );
    assert_eq!(
        on(&s, &id, "GET", "denials", "").0,
        404,
        "session still in memory"
    );
    assert_eq!(
        on(&s, &id, "POST", "dev-reap", ""),
        (200, json!({"ok": true, "reaped": false}))
    );
    s.stop(Duration::from_secs(15));
}
