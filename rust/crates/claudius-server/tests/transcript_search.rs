//! `GET /api/sessions/:id/transcript` and `GET /api/sessions/:id/search`
//! against the real binary, replaying
//! `claudius-core/tests/fixtures/transcript_golden.json` (recorded by
//! `rust/scripts/transcript-golden.mjs` from the real TS handlers): the same
//! transcript bytes under `<config>/projects/` (odd number forms and key
//! orders, invalid UTF-8, a torn last line), the same live session (`live`,
//! resumed in `$B`, the `dir` fallback), and every case must answer the
//! same status and the same body text, byte for byte ("threw" is Next's
//! empty 500). Plus the regex-metacharacter / ReDoS checks the task asks
//! for: the query is a literal, never a pattern.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use claudius_agent::js;
use claudius_core::paths::sdk_project_dir_name;
use common::{Server, World, http};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/transcript_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `encodeURIComponent`.
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' => (b as char).to_string(),
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn transcript_path(world: &World, project: &Path, id: &str) -> PathBuf {
    world
        .config
        .join("projects")
        .join(sdk_project_dir_name(&project.display().to_string()))
        .join(format!("{id}.jsonl"))
}

fn write_file(world: &World, project: &Path, id: &str, bytes: &[u8]) {
    let file = transcript_path(world, project, id);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, bytes).unwrap();
}

fn write_transcript(world: &World, project: &Path, id: &str, entries: &[Value]) {
    let lines: String = entries
        .iter()
        .map(|e| format!("{}\n", js::stringify(e)))
        .collect();
    write_file(world, project, id, lines.as_bytes());
}

/// The recorder's `fileBytes`: a session's `file` text with each
/// JSON-escaped `\u0001BAD\u0001` marker as the invalid UTF-8 bytes FF 20 E2 82.
fn file_bytes(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for (i, part) in text.split(r"\u0001BAD\u0001").enumerate() {
        if i > 0 {
            out.extend([0xff, 0x20, 0xe2, 0x82]);
        }
        out.extend(part.as_bytes());
    }
    out
}

/// A live session resumed from `id`'s transcript in `cwd`.
fn resume(server: &Server, id: &str, cwd: &Path) {
    let body = json!({"resume": id, "cwd": cwd}).to_string();
    let (st, out) = http(server.port, "POST", "/api/sessions", &body);
    assert_eq!(st, 200, "{out}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["id"], id, "{out}");
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new();
    let a = world.root.path().join("projA");
    std::fs::create_dir_all(&a).unwrap();
    let a = a.canonicalize().unwrap();
    let b = world.project.clone();
    let project = |p: &Value| match p.as_str().unwrap() {
        "$A" => a.clone(),
        "$B" => b.clone(),
        other => panic!("project {other}"),
    };
    for s in fx["sessions"].as_array().unwrap() {
        write_file(
            &world,
            &project(&s["project"]),
            s["id"].as_str().unwrap(),
            &file_bytes(s["file"].as_str().unwrap()),
        );
    }
    let server = Server::spawn(&world, &[]);
    let live = fx["live"].as_str().unwrap();
    let live_file = transcript_path(&world, &b, live);
    let before = std::fs::read(&live_file).unwrap();
    resume(&server, live, &b);

    let (ea, eb) = (enc(&a.display().to_string()), enc(&b.display().to_string()));
    let cases = fx["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for c in cases {
        let query = c["query"]
            .as_str()
            .unwrap()
            .replace("%24A", &ea)
            .replace("%24B", &eb);
        let path = format!(
            "/api/sessions/{}/{}{query}",
            c["id"].as_str().unwrap(),
            c["route"].as_str().unwrap()
        );
        let (st, text) = http(server.port, "GET", &path, "");
        let got = if st == 500 && text.is_empty() {
            json!({"threw": c["got"]["threw"]})
        } else {
            json!({"status": st, "body": text})
        };
        if got != c["got"] {
            failures.push(format!("{path}\n  want {}\n  got  {got}", c["got"]));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    assert!(cases.len() >= 120);
    assert_eq!(
        std::fs::read(&live_file).unwrap(),
        before,
        "reading never writes"
    );
    server.stop(Duration::from_secs(30));
}

#[test]
fn queries_are_literal_never_patterns() {
    let world = World::new();
    let id = "abcdef01-2345-4678-89ab-cdef01234567";
    let turn = |i: usize, content: Value| {
        json!({"type": if i % 2 == 0 { "user" } else { "assistant" },
               "uuid": format!("00000000-0000-4000-8000-{i:012}"),
               "parentUuid": if i == 0 { Value::Null } else { json!(format!("00000000-0000-4000-8000-{:012}", i - 1)) },
               "sessionId": id, "timestamp": format!("2026-01-01T00:00:{i:02}.000Z"),
               "message": {"role": if i % 2 == 0 { "user" } else { "assistant" }, "content": content}})
    };
    let evil = format!("{}!", "a".repeat(100_000));
    write_transcript(
        &world,
        &world.project,
        id,
        &[
            turn(0, json!(evil)),
            turn(
                1,
                json!([{"type": "text", "text": "cost $5.00 (approx) [x] a+b|c ^ \\d"}]),
            ),
            turn(2, json!("literal (a+)+$ here")),
        ],
    );
    let server = Server::spawn(&world, &[]);
    let dir = enc(&world.project.display().to_string());
    let search = |q: &str| {
        let (st, body) = http(
            server.port,
            "GET",
            &format!("/api/sessions/{id}/search?dir={dir}&q={}", enc(q)),
            "",
        );
        assert_eq!(st, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        v["hits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["snippet"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    // Catastrophic-backtracking patterns over 100k `a`s: no regex runs.
    let t0 = Instant::now();
    assert!(search("(a+)+b").is_empty());
    assert!(search("^(a|a)*$").is_empty());
    assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
    assert_eq!(search("(a+)+$"), ["literal (a+)+$ here"]);
    // Each only in the one turn that holds it literally (`.` isn't "any
    // character", so the 100k-`a` turn never matches).
    for meta in [
        "$5.00", ".", "(approx)", "[x]", "a+b", "|c", "^", "\\d", "\\",
    ] {
        let hits = search(meta);
        assert!(
            hits.len() == 1 && hits[0].starts_with("cost $5.00"),
            "{meta:?} → {hits:?}"
        );
    }
    assert!(search("a.b").is_empty());
    assert!(search("[a]").is_empty());
    // GET only, like the TS route modules.
    for route in ["transcript", "search"] {
        let (st, _) = http(
            server.port,
            "POST",
            &format!("/api/sessions/{id}/{route}"),
            "{}",
        );
        assert_eq!(st, 405, "{route}");
        // `NextResponse.json` → `content-type: application/json`.
        let mut sock = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        write!(
            sock,
            "GET /api/sessions/{id}/{route}?q=x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut head = String::new();
        sock.read_to_string(&mut head).unwrap();
        let head = head.to_ascii_lowercase();
        assert!(
            head.starts_with("http/1.1 200")
                && head.contains("\r\ncontent-type: application/json\r\n"),
            "{head}"
        );
    }
    server.stop(Duration::from_secs(30));
}
