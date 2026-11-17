//! `GET/PUT /api/sessions/open-tabs` against the real binary, replaying the
//! `steps` of `claudius-core/tests/fixtures/open_tabs_golden.json`
//! (recorded by `rust/scripts/open-tabs-golden.mjs` from the real TS route
//! in Next's request scope): the same store files under the home
//! (workspaces, customizations, the legacy titles), the same hand-written
//! SQL and broken DB files in between, the same Cookie headers, and every
//! request must answer the same status, content type and body text
//! ("threw" is Next's empty 500), every row dump the same stored types and
//! values. Concurrent PUTs (no lock in TS either) are checked by their
//! answers and by each row holding one of the racing values.
//!
//! Also replays the fixture's `cookies` (Next's `RequestCookies`) through
//! the route's cookie parser, and checks the route's place among the
//! `/api/sessions/:id/*` routes.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use claudius_core::db::{Mode, open_path};
use claudius_core::{js_num, js_string, paths};
use claudius_server::workspaces::parse_cookie_header;
use common::{Server, World, http};
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

/// The fixture, parsed as `JSON.parse` would: its lone-surrogate escapes
/// are JS strings' lone surrogates ([`js_string`] stand-ins).
fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/open_tabs_golden.json");
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

const URL: &str = "/api/sessions/open-tabs";

/// `(status, content type, body)`; `body: None` sends none.
fn request(
    port: u16,
    method: &str,
    cookie: Option<&str>,
    body: Option<&[u8]>,
) -> (u16, Option<String>, Vec<u8>) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut head = format!("{method} {URL} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(c) = cookie {
        head.push_str(&format!("Cookie: {c}\r\n"));
    }
    let body = body.unwrap_or_default();
    if method != "GET" {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let at = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&out[..at]).into_owned();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let content_type = head.split("\r\n").find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, content_type, out[at + 4..].to_vec())
}

const ROWS_SQL: &str = "SELECT
    typeof(key), CASE typeof(key) WHEN 'integer' THEN CAST(key AS TEXT) WHEN 'blob' THEN hex(key) ELSE key END,
    typeof(value), CASE typeof(value) WHEN 'integer' THEN CAST(value AS TEXT) WHEN 'blob' THEN hex(value) ELSE value END
  FROM ui_state ORDER BY rowid";

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(f) => js_num(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(_) => panic!("the dump hexes blobs"),
    }
}

/// The rows through a separate read-only connection, like the recorder's.
fn rows_at(path: &Path) -> Value {
    if !path.exists() {
        return json!({"nodb": true});
    }
    let read = || -> rusqlite::Result<Vec<Vec<Value>>> {
        let c = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut st = c.prepare(ROWS_SQL)?;
        let rows = st.query_map([], |r| (0..4).map(|i| Ok(cell(r.get_ref(i)?))).collect())?;
        rows.collect()
    };
    match read() {
        Ok(r) => json!(r),
        Err(rusqlite::Error::SqliteFailure(_, Some(m))) => json!({"error": m}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

fn remove(path: &Path) {
    if path.is_dir() {
        std::fs::remove_dir_all(path).unwrap();
    } else if path.exists() {
        std::fs::remove_file(path).unwrap();
    }
}

struct Replay<'a> {
    world: &'a World,
    port: u16,
}

impl Replay<'_> {
    fn proc_dir(&self) -> String {
        self.world.project.display().to_string()
    }

    fn home(&self) -> String {
        self.world.home.display().to_string()
    }

    fn sym(&self, s: &str) -> String {
        s.replace(&self.proc_dir(), "$PROC")
            .replace(&self.home(), "$HOME")
    }

    fn unsym(&self, s: &str) -> String {
        s.replace("$PROC", &self.proc_dir())
            .replace("$HOME", &self.home())
    }

    fn db_path(&self, s: &Value) -> PathBuf {
        let cwd = self.unsym(s["cwd"].as_str().unwrap());
        self.world
            .home
            .join(".claude/projects")
            .join(paths::encode_project_dir(&cwd))
            .join(".claudius.db")
    }

    /// One request step, viewed as the recorder viewed it.
    fn call(&self, s: &Value) -> Value {
        let method = if s["op"] == "get" { "GET" } else { "PUT" };
        let body = match (&s["hex"], &s["body"]) {
            (Value::String(h), _) => Some(unhex(h)),
            // `new Request(_, {body})` sends a lone surrogate as U+FFFD.
            (_, Value::String(b)) => Some(js_string::lossy(b).as_bytes().to_vec()),
            _ => None,
        };
        let (status, content_type, body) =
            request(self.port, method, s["cookie"].as_str(), body.as_deref());
        if status == 500 && body.is_empty() && content_type.is_none() {
            // Next's empty 500; the recorder kept the thrown message.
            return json!({"threw": s["got"]["threw"]});
        }
        json!({
            "status": status,
            "type": content_type,
            "body": self.sym(&String::from_utf8(body).unwrap()),
        })
    }

    /// Replays one step; `Some((want, got))` when it has an answer to check.
    fn step(&self, s: &Value) -> Option<(Value, Value)> {
        let got = match s["op"].as_str().unwrap() {
            "file" => {
                let path = self.world.home.join(s["path"].as_str().unwrap());
                remove(&path);
                if s["rm"] != true {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    if s["dir"] == true {
                        std::fs::create_dir(&path).unwrap();
                    } else if let Some(hex) = s["hex"].as_str() {
                        std::fs::write(&path, unhex(hex)).unwrap();
                    } else {
                        let text = s["text"].as_str().unwrap();
                        std::fs::write(&path, js_string::lossy(text).as_ref()).unwrap();
                    }
                }
                return None;
            }
            "sql" => {
                let path = self.db_path(s);
                let sql = s["sql"].as_str().unwrap();
                if s["fresh"] == true {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    let c = rusqlite::Connection::open(&path).unwrap();
                    if s["journal"] != "delete" {
                        c.pragma_update(None, "journal_mode", "WAL").unwrap();
                    }
                    c.execute_batch(sql).unwrap();
                } else {
                    open_path(&path, Mode::ReadWrite)
                        .unwrap()
                        .execute_batch(sql)
                        .unwrap();
                }
                return None;
            }
            "dbfile" => {
                let path = self.db_path(s);
                remove(&path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                if s["dir"] == true {
                    std::fs::create_dir(&path).unwrap();
                } else {
                    std::fs::write(&path, s["text"].as_str().unwrap()).unwrap();
                }
                return None;
            }
            "rows" => rows_at(&self.db_path(s)),
            "exists" => {
                let path = self.db_path(s);
                json!({"dir": path.parent().unwrap().exists(), "db": path.exists()})
            }
            "rowsOneOf" => {
                let got = rows_at(&self.db_path(s));
                let keys = s["keys"].as_object().unwrap();
                let rows = got.as_array().unwrap();
                let mut seen: Vec<&str> = rows.iter().map(|r| r[1].as_str().unwrap()).collect();
                seen.sort_unstable();
                let mut want: Vec<&str> = keys.keys().map(String::as_str).collect();
                want.sort_unstable();
                let ok = seen == want
                    && rows.iter().all(|r| {
                        r[0] == "text"
                            && r[2] == "text"
                            && keys[r[1].as_str().unwrap()]
                                .as_array()
                                .unwrap()
                                .contains(&r[3])
                    });
                return (!ok).then(|| (json!(s["keys"]), got));
            }
            "concurrent" => {
                let steps = s["steps"].as_array().unwrap();
                std::thread::scope(|scope| {
                    let calls: Vec<_> = steps
                        .iter()
                        .map(|c| scope.spawn(move || self.call(c)))
                        .collect();
                    Value::Array(calls.into_iter().map(|h| h.join().unwrap()).collect())
                })
            }
            "get" | "put" => self.call(s),
            op => panic!("op {op}"),
        };
        Some((s["got"].clone(), got))
    }
}

/// Where Rust is known to differ, and why (each one must still differ): a
/// body nested past serde_json's 127 levels, which V8 parses, is a 400
/// "invalid JSON" here, so its tabs aren't written until the next PUT.
fn known_difference(s: &Value, tainted: &mut Option<&'static str>) -> Option<&'static str> {
    if s["op"] == "put" {
        let body = s["body"].as_str().unwrap_or_default();
        *tainted = body
            .contains(&"[".repeat(150))
            .then_some("nesting past 127 levels");
        return *tainted;
    }
    if s["op"] == "rows" || s["op"] == "get" {
        return *tainted;
    }
    None
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let replay = Replay {
        world: &world,
        port: server.port,
    };
    let steps = fx["steps"].as_array().unwrap();
    let mut failures = vec![];
    let mut known = vec![];
    // Set by a PUT Rust is known to store differently, until the next PUT.
    let mut tainted: Option<&str> = None;
    for (i, s) in steps.iter().enumerate() {
        let why = known_difference(s, &mut tainted);
        let Some((want, got)) = replay.step(s) else {
            continue;
        };
        let what = json!({"op": s["op"], "cwd": s["cwd"], "cookie": s["cookie"], "body": s["body"], "hex": s["hex"]});
        match (
            js_string::stringify(&want) == js_string::stringify(&got),
            why,
        ) {
            (true, None) => {}
            (false, Some(why)) => known.push(format!("#{i}: {why}")),
            (true, Some(why)) => failures.push(format!("#{i}: listed ({why}) but equal")),
            (false, None) => failures.push(format!(
                "#{i} {}\n  want {}\n  got  {}",
                js_string::stringify(&what),
                js_string::stringify(&want),
                js_string::stringify(&got)
            )),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} steps differ:\n{}",
        failures.len(),
        steps.len(),
        failures.join("\n")
    );
    assert_eq!(known.len(), 2, "{known:?}");
    let requests = steps
        .iter()
        .filter(|s| s["op"] == "get" || s["op"] == "put")
        .count();
    assert!(requests >= 250, "only {requests} requests");
    server.stop(Duration::from_secs(30));
}

#[test]
fn cookies_parse_like_next() {
    let fx = fixture();
    let cases = fx["cookies"].as_array().unwrap();
    assert!(cases.len() >= 40);
    let mut failures = vec![];
    for c in cases {
        let header = c["header"].as_str().unwrap();
        let got = json!(parse_cookie_header(header));
        if got != c["got"] {
            failures.push(format!("{header:?}: want {} got {got}", c["got"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The static `open-tabs` segment and the `:id` routes don't shadow each
/// other: the strip answers at its path, a live session's id still reaches
/// the session routes, and `open-tabs` as an id is just an unknown session.
/// Only GET and PUT are routed, like the TS route module.
#[test]
fn sits_beside_the_session_routes() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let (st, ct, body) = request(server.port, "GET", None, None);
    assert_eq!((st, ct.as_deref()), (200, Some("application/json")));
    assert_eq!(
        String::from_utf8(body).unwrap(),
        r#"{"tabs":[],"activeId":null,"labelMaxWidth":180,"titles":{},"pinned":[]}"#
    );

    let id = server.create_session(&world);
    let (st, body) = http(
        server.port,
        "PUT",
        URL,
        &json!({"tabs": [id, "other"], "activeId": id}).to_string(),
    );
    assert_eq!((st, body.as_str()), (200, r#"{"ok":true}"#));
    let (st, body) = http(
        server.port,
        "GET",
        &format!("/api/sessions/{id}/notification-prefs"),
        "",
    );
    assert_eq!(st, 200, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["sessionId"],
        json!(id)
    );
    let (st, body) = http(
        server.port,
        "GET",
        "/api/sessions/open-tabs/notification-prefs",
        "",
    );
    assert_eq!(
        (st, body.as_str()),
        (404, r#"{"error":"session not found"}"#)
    );
    let (st, body) = http(server.port, "GET", URL, "");
    assert_eq!(st, 200);
    let got: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(got["tabs"], json!([id, "other"]));
    assert_eq!(got["activeId"], json!(id));

    for method in ["POST", "PATCH", "DELETE"] {
        let (st, _, _) = request(server.port, method, None, Some(b"{}"));
        assert_eq!(st, 405, "{method}");
    }
    server.stop(Duration::from_secs(30));
}
