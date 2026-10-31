//! `GET /api/sessions/search` against the real binary, replaying
//! `claudius-core/tests/fixtures/session_search_golden.json` (recorded by
//! `rust/scripts/session-search-golden.mjs` from the real TS handler): the
//! recorded transcript folders are rebuilt under the server's home
//! (`CLAUDIUS_STATE_HOME`, which stands for `homedir()`), and every step must
//! answer the same status, content type and body, byte for byte. Plus the
//! ReDoS checks: the query is a literal, never a pattern.
#![cfg(unix)]

mod common;
#[path = "../../claudius-core/tests/common_search/mod.rs"]
mod common_search;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use common::{Server, World, http};
use common_search::{build, fixture, needs_perms, perms_enforced};
use serde_json::Value;

/// GET `target` → (status, content type, body).
fn get(port: u16, target: &str) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let raw = String::from_utf8(raw).unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let ty = head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, ty, body.to_owned())
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new();
    let built = build(&world.home, &fx);
    let perms = perms_enforced();
    let server = Server::spawn(&world, &[]);
    let steps = fx["steps"].as_array().unwrap();
    let (mut failures, mut skipped) = (Vec::new(), 0);
    for s in steps {
        if !perms && needs_perms(&fx, s) {
            skipped += 1;
            continue;
        }
        let target = match s["query"].as_str() {
            Some(q) => format!("/api/sessions/search?{q}"),
            None => "/api/sessions/search".to_owned(),
        };
        let (status, ty, body) = get(server.port, &target);
        let got = serde_json::json!({"status": status, "type": ty, "body": body});
        if got != s["got"] {
            failures.push(format!("{target}\n  want {}\n  got  {got}", s["got"]));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} steps differ:\n{}",
        failures.len(),
        steps.len(),
        failures.join("\n")
    );
    assert!(steps.len() >= 140);
    if skipped > 0 {
        eprintln!("{skipped} steps skipped: this disk doesn't enforce modes");
    }
    server.stop(Duration::from_secs(30));
    drop(built);
}

#[test]
fn queries_are_literal_never_patterns() {
    let world = World::new();
    let base = world.home.join(".claude/projects/-w");
    std::fs::create_dir_all(&base).unwrap();
    let evil = format!(
        "{{\"type\":\"user\",\"message\":{{\"content\":\"{}!\"}}}}\n",
        "a".repeat(1_000_000)
    );
    std::fs::write(base.join("evil.jsonl"), evil).unwrap();
    std::fs::write(
        base.join("plain.jsonl"),
        "{\"type\":\"user\",\"message\":{\"content\":\"literal (a+)+$ here\"}}\n",
    )
    .unwrap();
    let server = Server::spawn(&world, &[]);
    let enc = |q: &str| -> String {
        q.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect()
    };
    let search = |q: &str| -> Vec<String> {
        let (st, ty, body) = get(
            server.port,
            &format!("/api/sessions/search?dir=%2Fw&q={}", enc(q)),
        );
        assert_eq!(
            (st, ty.as_deref()),
            (200, Some("application/json")),
            "{body}"
        );
        let v: Value = serde_json::from_str(&body).unwrap();
        v["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["sessionId"].as_str().unwrap().to_owned())
            .collect()
    };
    // Catastrophic-backtracking patterns over a million `a`s: no regex runs.
    let t0 = Instant::now();
    assert!(search("(a+)+b").is_empty());
    assert!(search("^(a|a)*$").is_empty());
    assert!(search(&format!("{}b", "a".repeat(5000))).is_empty());
    assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
    assert_eq!(search("(a+)+$"), ["plain"]);
    assert_eq!(search("a.*"), Vec::<String>::new());
    assert_eq!(search("A!"), ["evil"]);
    // V8 refuses a 32 768-unit literal ("Regular expression too large"); node's
    // 16 KiB request head never lets one reach the TS. Rust just searches.
    assert_eq!(search(&"A".repeat(40_000)), ["evil"]);
    // GET only, like the TS route module.
    let (st, _) = http(
        server.port,
        "POST",
        "/api/sessions/search?q=a&dir=%2Fw",
        "{}",
    );
    assert_eq!(st, 405);
    server.stop(Duration::from_secs(30));
}
