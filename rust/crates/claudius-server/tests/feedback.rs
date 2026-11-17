//! `POST/GET /api/feedback` (G10) against the real binary and the fake CLI,
//! replaying the `groups` of
//! `claudius-core/tests/fixtures/feedback_golden.json` (recorded by
//! `rust/scripts/feedback-golden.mjs` from the real TS route, over SDK
//! queries against the same fake CLI). One world and server per group, its
//! sessions created (their CLIs started, or not, or exited) in the world's
//! project. In order, every request must answer the recorded status, content
//! type and body text ("threw" is Next's empty 500), write the recorded
//! `submit_feedback` request to the CLI (byte for byte, the request id as
//! `$ID`) and add the recorded row to the database file; the hand-written
//! SQL runs in between, and each row dump must hold the same stored types
//! and values. The `lone surrogates` group's wire and rows are compared
//! with each lone surrogate as U+FFFD ([`LONE_SURROGATES`]).
//!
//! The recorder pinned `Date.now` and `randomUUID`; this server runs on the
//! real ones. A row a POST added must carry a v4 UUID and a `created_at`
//! within the request, and from then on those stand in for the recorded
//! ones. Requests are at least a millisecond apart, so `ORDER BY created_at`
//! sorts the rows as it did in TS. The recorded session ids (and their
//! upper-cased forms) stand for the created sessions'.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::db::{Mode, open_path};
use claudius_core::{is_uuid, js_num, now_ms, paths};
use common::{Server, World, free_port, http, read_until, wait_until};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/feedback_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Recorded requests where Rust differs, by a piece of the request body,
/// and why. Each must still differ, so a fix shows up here.
const GAPS: &[(&str, &str)] = &[(
    "\"deep\":[[[[",
    "V8 parses nesting past 128 levels; serde_json refuses it, so the body reads as \
     null (400 `empty feedback`) instead of the 409 for a session that isn't live",
)];

/// The group that forwards lone-surrogate escapes to a live CLI (the fake
/// reads them as `JSON.parse` does, so TS gets its reply). `JsonBody` reads
/// each as U+FFFD, so the CLI gets U+FFFD where TS forwards the escape, and
/// the row holds U+FFFD's bytes where better-sqlite3 binds the surrogate's
/// own three (`ED A0 80`, read back as three U+FFFD; I15). The answers must
/// match as recorded; the wire once the recorded line is read the same way
/// ([`lossy_line`]), and the rows once each three U+FFFD read as one
/// ([`lossy_cell`]).
const LONE_SURROGATES: &str = "lone surrogates";

/// A recorded wire line as the Rust host writes it: each lone surrogate as
/// U+FFFD (`js::json_parse`).
fn lossy_line(line: &Value) -> Value {
    json!(js::stringify(
        &js::json_parse(line.as_str().unwrap()).unwrap()
    ))
}

/// A recorded row cell with each lone surrogate's three U+FFFD as one.
fn lossy_cell(v: &mut Value) {
    if let Value::String(t) = v {
        *t = t.replace("\u{fffd}\u{fffd}\u{fffd}", "\u{fffd}");
    }
}

/// `(status, content type, body)`; `body: None` sends none (no
/// `Content-Length`).
fn request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let length = body.map_or_else(String::new, |b| {
        format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        )
    });
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{length}Connection: close\r\n\r\n"
    )
    .unwrap();
    s.write_all(body.unwrap_or_default()).unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let content_type = head.split("\r\n").find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, content_type, body.to_owned())
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// `bytes` with every `from` replaced by `to`.
fn replace_bytes(bytes: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(from) {
            out.extend_from_slice(to);
            i += from.len();
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

fn log_lines(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// The `submit_feedback` control requests written since line `from`, ids as
/// `$ID`.
fn wire_since(log: &Path, from: usize) -> Vec<Value> {
    log_lines(log)
        .into_iter()
        .skip(from)
        .filter_map(|l| {
            let m: Value = serde_json::from_str(&l).ok()?;
            (m["type"] == "control_request" && m["request"]["subtype"] == "submit_feedback").then(
                || {
                    let id = serde_json::to_string(&m["request_id"]).unwrap();
                    json!(l.replacen(&id, "\"$ID\"", 1))
                },
            )
        })
        .collect()
}

/// The recorder's row dump, column by column.
fn rows_sql() -> String {
    let cols = [
        "id",
        "session_id",
        "cwd",
        "rating",
        "comment",
        "surface",
        "forwarded",
        "attach_transcript",
        "created_at",
    ];
    let cells: Vec<String> = cols
        .iter()
        .map(|c| {
            format!(
                "typeof({c}), CASE typeof({c}) WHEN 'integer' THEN CAST({c} AS TEXT) WHEN 'blob' THEN hex({c}) ELSE {c} END"
            )
        })
        .collect();
    format!("SELECT {} FROM feedback ORDER BY rowid", cells.join(", "))
}

/// A cell as better-sqlite3 hands it to JS, then `JSON.stringify`'s view.
fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => js_num(n as f64),
        ValueRef::Real(f) => js_num(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!({"type": "Buffer", "data": b}),
    }
}

/// `sql`'s rows in the file on disk through a fresh read-only connection, as
/// the recorder read them; `None` when the file or the statement fails.
fn on_disk(db: &Path, sql: &str, width: usize) -> Option<Vec<Vec<Value>>> {
    let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut st = c.prepare(sql).ok()?;
    st.query_map([], |r| {
        (0..width).map(|i| Ok(cell(r.get_ref(i)?))).collect()
    })
    .ok()?
    .collect::<rusqlite::Result<_>>()
    .ok()
}

/// `(id, created_at)` of every row on disk.
fn disk_keys(db: &Path) -> Vec<(Value, Value)> {
    on_disk(db, "SELECT id, created_at FROM feedback", 2)
        .unwrap_or_default()
        .into_iter()
        .map(|r| (r[0].clone(), r[1].clone()))
        .collect()
}

/// What the replay has learnt maps recorded values to: session ids, row ids
/// and `created_at`s.
#[derive(Default)]
struct Subst {
    /// Whole strings (ids; a row dump's cwd and INTEGER text).
    text: Vec<(String, String)>,
    /// `created_at` as recorded → as stored here.
    clocks: Vec<(i64, i64)>,
}

impl Subst {
    /// A recorded request body or query.
    fn request(&self, bytes: &[u8]) -> Vec<u8> {
        self.text.iter().fold(bytes.to_vec(), |b, (x, y)| {
            replace_bytes(&b, x.as_bytes(), y.as_bytes())
        })
    }

    /// A recorded response body.
    fn body(&self, text: &str) -> String {
        let mut text = self
            .text
            .iter()
            .fold(text.to_owned(), |t, (x, y)| t.replace(x, y));
        for (x, y) in &self.clocks {
            text = text.replace(
                &format!("\"createdAt\":{x}}}"),
                &format!("\"createdAt\":{y}}}"),
            );
        }
        text
    }

    /// A recorded row dump's cell.
    fn cell(&self, v: &mut Value) {
        match v {
            Value::String(t) => {
                if let Some((_, y)) = self.text.iter().find(|(x, _)| x == t) {
                    *t = y.clone();
                } else if let Some((_, y)) = self.clocks.iter().find(|(x, _)| x.to_string() == *t) {
                    *t = y.to_string();
                }
            }
            Value::Number(n) => {
                if let Some((_, y)) = self
                    .clocks
                    .iter()
                    .find(|(x, _)| n.as_f64() == Some(*x as f64))
                {
                    *v = js_num(*y as f64);
                }
            }
            _ => {}
        }
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

/// The recorded group on a fresh world and server. Returns `(requests,
/// matched)`; differences go to `failures`.
fn replay_group(group: &Value, failures: &mut Vec<String>) -> (usize, usize) {
    let name = group["name"].as_str().unwrap();
    let query = group["query"].as_str().unwrap();
    let world = World::new();
    let log = world.root.path().join("stdin.log");
    let log_env = log.display().to_string();
    let server = if query == "none" {
        spawn_without_cli(&world)
    } else {
        let script = group["script"].to_string();
        let mut env = vec![("FAKE_CLAUDE_LOG", log_env.as_str())];
        if !group["script"].is_null() {
            env.push(("FAKE_CLAUDE_SCRIPT", &script));
        }
        Server::spawn(&world, &env)
    };
    let project = world.project.display().to_string();
    let db = world
        .home
        .join(".claude/projects")
        .join(paths::encode_project_dir(&project))
        .join(".claudius.db");
    let mut subst = Subst::default();
    subst
        .text
        .push((group["cwd"].as_str().unwrap().to_owned(), project.clone()));
    // Each session subscribed to, as the recorder modelled them (its
    // database open read-only too: `subscribe()` reads the session's tasks).
    let mut streams = vec![];
    for recorded in group["sessions"].as_array().unwrap() {
        let recorded = recorded.as_str().unwrap();
        let id = server.create_session(&world);
        subst.text.push((recorded.to_owned(), id.clone()));
        subst
            .text
            .push((recorded.to_uppercase(), id.to_uppercase()));
        let mut sse = server.open_stream(&id);
        match query {
            "live" => {
                read_until(&mut sse, r#""type":"tips""#, Duration::from_secs(10));
            }
            // The session reports the exit once the SDK host's cleanup has run.
            "exited" => {
                read_until(&mut sse, "exited with code 3", Duration::from_secs(10));
            }
            _ => {}
        }
        streams.push(sse);
    }

    let (mut requests, mut matched) = (0, 0);
    let mut last = 0;
    for (i, s) in group["steps"].as_array().unwrap().iter().enumerate() {
        let here = format!("{name} #{i}");
        match s["op"].as_str().unwrap() {
            "sql" => open_path(&db, Mode::ReadWrite)
                .unwrap()
                .execute_batch(s["sql"].as_str().unwrap())
                .unwrap(),
            "rows" => {
                let got = on_disk(&db, &rows_sql(), 18).expect("a row dump");
                let mut want = s["got"].clone();
                let mut lossy = false;
                for row in want.as_array_mut().unwrap() {
                    for v in row.as_array_mut().unwrap() {
                        subst.cell(v);
                        if name == LONE_SURROGATES {
                            let recorded = v.clone();
                            lossy_cell(v);
                            lossy |= *v != recorded;
                        }
                    }
                }
                if name == LONE_SURROGATES && !lossy {
                    failures.push(format!("{here} rows: no lone surrogate"));
                }
                if js::stringify(&json!(got)) != js::stringify(&want) {
                    failures.push(format!(
                        "{here} rows\n  want {}\n  got  {}",
                        js::stringify(&want),
                        js::stringify(&json!(got))
                    ));
                }
            }
            op => {
                requests += 1;
                let (method, path, bytes) = if op == "get" {
                    let q = s["query"]
                        .as_str()
                        .map(|q| String::from_utf8(subst.request(q.as_bytes())).unwrap());
                    let path = q.map_or_else(
                        || "/api/feedback".to_owned(),
                        |q| format!("/api/feedback?{q}"),
                    );
                    ("GET", path, None)
                } else {
                    let bytes = s["bodyHex"].as_str().map(|h| subst.request(&unhex(h)));
                    ("POST", "/api/feedback".to_owned(), bytes)
                };
                let shown =
                    String::from_utf8_lossy(bytes.as_deref().unwrap_or_default()).into_owned();
                // A millisecond after the previous request: no two rows share a
                // `created_at`.
                while now_ms() <= last {
                    std::thread::sleep(Duration::from_micros(200));
                }
                let before = disk_keys(&db);
                let from = log_lines(&log).len();
                let t0 = now_ms();
                let (status, content_type, text) =
                    request(server.port, method, &path, bytes.as_deref());
                let t1 = now_ms();
                last = t1;
                let wire = wire_since(&log, from);
                let added: Vec<(Value, Value)> = disk_keys(&db)
                    .into_iter()
                    .filter(|k| !before.contains(k))
                    .collect();

                // The row: recorded → this server's id and clock.
                let mut row_ok = true;
                match (&s["inserted"], added.as_slice()) {
                    (Value::Null, []) => {}
                    (Value::Object(rec), [(Value::String(id), Value::Number(at))]) => {
                        let at = at.as_i64().unwrap_or(-1);
                        if !(is_uuid(id) && id.as_bytes()[14] == b'4' && (t0..=t1).contains(&at)) {
                            row_ok = false;
                        }
                        subst
                            .text
                            .push((rec["id"].as_str().unwrap().to_owned(), id.clone()));
                        subst.clocks.push((rec["createdAt"].as_i64().unwrap(), at));
                    }
                    _ => row_ok = false,
                }
                if !row_ok {
                    failures.push(format!(
                        "{here} {method} {path} {shown:?}: row {} recorded, {added:?} added within {t0}..={t1}",
                        s["inserted"]
                    ));
                }

                let want = &s["got"];
                let got = if status == 500 && text.is_empty() && content_type.is_none() {
                    json!({"threw": want["threw"]})
                } else {
                    json!({"status": status, "type": content_type, "body": text})
                };
                let mut want = want.clone();
                if let Some(t) = want["body"].as_str() {
                    want["body"] = json!(subst.body(t));
                }
                let mut want_wire: Vec<Value> = s["wire"]
                    .as_array()
                    .map(|w| {
                        w.iter()
                            .map(|l| json!(subst.body(l.as_str().unwrap())))
                            .collect()
                    })
                    .unwrap_or_default();
                if name == LONE_SURROGATES {
                    let lossy: Vec<Value> = want_wire.iter().map(lossy_line).collect();
                    if lossy == want_wire {
                        failures.push(format!("{here}: no lone surrogate on the wire"));
                    }
                    want_wire = lossy;
                }
                let same = got == want && wire == want_wire;
                match GAPS.iter().find(|(piece, _)| shown.contains(piece)) {
                    Some((_, why)) => {
                        if same {
                            failures.push(format!("{here}: stale gap: {why}"));
                        }
                    }
                    None if same => matched += 1,
                    None => failures.push(format!(
                        "{here} {method} {path} {shown:?}\n  want {want} {want_wire:?}\n  got  {got} {wire:?}"
                    )),
                }
            }
        }
    }
    drop(streams);
    server.stop(Duration::from_secs(30));
    (requests, matched)
}

#[test]
fn the_route_replays_the_ts_handler() {
    let fx = fixture();
    let mut failures = vec![];
    let (mut requests, mut matched) = (0, 0);
    for group in fx["groups"].as_array().unwrap() {
        let (r, m) = replay_group(group, &mut failures);
        requests += r;
        matched += m;
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(matched + GAPS.len(), requests);
    assert!(requests >= 160, "{requests} requests");
}

/// GET and POST only, like the TS route module: other methods get axum's
/// 405 (Next's answer for a method the module doesn't export).
#[test]
fn other_methods_are_405() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    for method in ["PUT", "PATCH", "DELETE"] {
        let (status, _, _) = request(server.port, method, "/api/feedback", Some(b"{}"));
        assert_eq!(status, 405, "{method}");
    }
    server.stop(Duration::from_secs(30));
}
