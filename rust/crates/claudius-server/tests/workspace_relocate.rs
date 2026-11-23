//! `GET`/`POST /api/workspaces/:id/move-sessions` (G09) on the real binary,
//! replayed against the `routes` groups `rust/scripts/workspace-relocate-golden.mjs`
//! recorded from `app/api/workspaces/[id]/move-sessions/route.ts`
//! (`claudius-core/tests/fixtures/workspace_relocate_golden.json`). Each
//! group gets a fresh world (temp root, `$ROOT/home` as the state home,
//! umask 022) with the store written verbatim and its setup ops applied,
//! then a server; each request checks status, content type and body, and
//! every watched path it changed (the projects dir, `outside` and the
//! store), as `changes` against the tree after the previous request.
//!
//! * `updatedAt`: the recorder pinned the clock; a stamp the server writes
//!   within a request's window reads as the `now` it recorded (everywhere
//!   it shows up later too).
//! * `threw` (Next's empty 500): status 500 and an empty body.
//! * Live sessions: the recorder put stand-ins with a given status in the
//!   session manager (after upserting their `sessions` rows, as `start()`
//!   does). Here they're real sessions on the fake CLI in the same cwd:
//!   `running` holds a scripted turn open, `needs_input` waits on a tool
//!   permission. Their ids read as the recorded ones, and the three time
//!   columns of their `sessions` rows aren't compared. After each request
//!   `GET /api/sessions` says which are still live; the rest were ended.
#![cfg(unix)]

mod common;
#[path = "../../claudius-core/tests/common_wsrel/mod.rs"]
mod common_wsrel;

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use claudius_core::js_string;
use common::{Server, free_port, wait_until};
use common_wsrel::{STORE, World, changes, perm_enforced, runs_here, str_of};
use serde_json::{Value, json};

/// `claudius` for one world under umask 022, with the fake CLI.
fn spawn(w: &World) -> Server {
    let port = free_port();
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg("umask 022 && exec \"$0\" \"$@\"")
        .arg(common::server_bin())
        .args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(common::fake_bin())
        .current_dir(w.path("project"))
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_DEV")
        .env_remove("CLAUDIUS_SCHEDULER")
        .env("CLAUDIUS_STATE_HOME", w.path("home"))
        .env("CLAUDE_CONFIG_DIR", w.path("config"))
        .stdout(std::fs::File::create(w.path("server.out")).unwrap())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().unwrap();
    wait_until("health", Duration::from_secs(60), || {
        if let Ok(Some(st)) = child.try_wait() {
            panic!("claudius exited ({st})");
        }
        TcpStream::connect(("127.0.0.1", port)).is_ok()
            && request(port, "GET", "/api/rust/health", None).0 == 200
    });
    Server { child, port }
}

/// One HTTP/1.1 request → (status, content type, body).
fn request(
    port: u16,
    method: &str,
    url: &str,
    body: Option<&[u8]>,
) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let body = body.unwrap_or(b"");
    write!(
        s,
        "{method} {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .unwrap();
    s.write_all(body).unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8(raw).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let mut ctype = None;
    for line in head.lines().skip(1) {
        let (k, v) = line.split_once(':').unwrap();
        let k = k.to_ascii_lowercase();
        assert_ne!(k, "transfer-encoding", "chunked answer: {head}");
        if k == "content-type" {
            ctype = Some(v.trim().to_owned());
        }
    }
    (status, ctype, body.to_owned())
}

fn json_request(port: u16, method: &str, url: &str, body: &Value) -> (u16, Value) {
    let body = (!body.is_null()).then(|| body.to_string());
    let (st, _, text) = request(port, method, url, body.as_deref().map(str::as_bytes));
    (st, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Each `"updatedAt":` / `"updatedAt": ` number in `s`: (start, end).
fn stamps(s: &str) -> Vec<(usize, usize)> {
    let key = "\"updatedAt\":";
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = s[from..].find(key) {
        let mut start = from + i + key.len();
        if s[start..].starts_with(' ') {
            start += 1;
        }
        let end = start + s[start..].bytes().take_while(u8::is_ascii_digit).count();
        if end > start {
            out.push((start, end));
        }
        from = end.max(start);
    }
    out
}

/// What makes this server's output read as the recording: its session
/// ids as the recorded ones, and the `updatedAt` stamps it wrote as the
/// pinned clock's `now` of their request.
#[derive(Default)]
struct Norm {
    ids: Vec<(String, String)>,
    times: HashMap<String, String>,
}

impl Norm {
    /// Learn the stamps in `s` that fall in a request's window.
    fn learn(&mut self, s: &str, window: (u64, u64), now: u64) {
        for (a, b) in stamps(s) {
            let v: u64 = s[a..b].parse().unwrap();
            if (window.0..=window.1).contains(&v) {
                self.times.insert(s[a..b].to_owned(), now.to_string());
            }
        }
    }

    fn text(&self, s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut last = 0;
        for (a, b) in stamps(s) {
            out.push_str(&s[last..a]);
            out.push_str(self.times.get(&s[a..b]).map_or(&s[a..b], String::as_str));
            last = b;
        }
        out.push_str(&s[last..]);
        for (real, recorded) in &self.ids {
            out = out.replace(real, recorded);
        }
        out
    }

    fn deep(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.deep(x)).collect()),
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, x)| (self.text(k), self.deep(x)))
                    .collect(),
            ),
            v => v.clone(),
        }
    }

    fn snapshot(&self, w: &World) -> BTreeMap<String, Value> {
        w.snapshot(&[STORE])
            .into_iter()
            .map(|(k, v)| (k, self.deep(&v)))
            .collect()
    }
}

/// `changes` with the time columns of the live sessions' `sessions` rows
/// masked: theirs were written at the recorder's clock, ours at the real one.
fn mask_live_rows(changes: &Value, live_ids: &[&str]) -> Value {
    let mut changes = changes.clone();
    for ch in changes.as_array_mut().unwrap() {
        let entry = &mut ch[1];
        if entry["kind"] != "db" {
            continue;
        }
        let Some(tables) = entry["db"]["tables"].as_array_mut() else {
            continue;
        };
        for t in tables.iter_mut().filter(|t| t["name"] == "sessions") {
            let cols: Vec<String> = t["cols"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| str_of(c).to_owned())
                .collect();
            let at = |name: &str| cols.iter().position(|c| c == name).map(|i| 2 * i + 1);
            let id = at("id").unwrap();
            for row in t["rows"].as_array_mut().unwrap() {
                if !row[id].as_str().is_some_and(|v| live_ids.contains(&v)) {
                    continue;
                }
                for c in ["created_at", "updated_at", "last_seen_at"] {
                    if let Some(i) = at(c) {
                        row[i] = json!("<time>");
                    }
                }
            }
        }
    }
    changes
}

/// Start the group's live sessions on the fake CLI and bring each to its
/// status: `(key, real id, recorded id)`.
fn start_sessions(w: &World, port: u16, sessions: &[Value]) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for s in sessions {
        let (st, body) = json_request(
            port,
            "POST",
            "/api/sessions",
            &json!({"cwd": w.abs(str_of(&s["cwd"])), "permissionMode": "default"}),
        );
        assert_eq!(st, 200, "{body}");
        let id = str_of(&body["id"]).to_owned();
        let text = match str_of(&s["status"]) {
            "idle" => None,
            // A turn that never ends.
            "running" => Some(r#"script:{"steps":[],"result":false}"#),
            // A tool call waiting on its permission.
            "needs_input" => Some("tool:ls"),
            other => panic!("unknown status {other}"),
        };
        if let Some(text) = text {
            let (st, body) = json_request(
                port,
                "POST",
                &format!("/api/sessions/{id}/input"),
                &json!({ "text": text }),
            );
            assert_eq!(st, 200, "{body}");
        }
        out.push((
            str_of(&s["key"]).to_owned(),
            id,
            str_of(&s["id"]).to_owned(),
        ));
    }
    let want: HashMap<&str, &str> = out
        .iter()
        .zip(sessions)
        .map(|((_, id, _), s)| (id.as_str(), str_of(&s["status"])))
        .collect();
    wait_until(
        "the live sessions' statuses",
        Duration::from_secs(60),
        || {
            let (_, list) = json_request(port, "GET", "/api/sessions", &Value::Null);
            list.as_array().is_some_and(|l| {
                want.iter()
                    .all(|(id, status)| l.iter().any(|s| s["id"] == *id && s["status"] == *status))
            })
        },
    );
    out
}

/// The live sessions' keys still in the manager, in order.
fn live_keys(port: u16, sessions: &[(String, String, String)]) -> Vec<String> {
    let (st, list) = json_request(port, "GET", "/api/sessions", &Value::Null);
    assert_eq!(st, 200);
    let list = list.as_array().unwrap();
    sessions
        .iter()
        .filter(|(_, id, _)| list.iter().any(|s| s["id"] == *id))
        .map(|(k, _, _)| k.clone())
        .collect()
}

fn run_group(g: &Value) -> usize {
    let name = str_of(&g["name"]);
    let w = World::new();
    let mut dirs: Vec<&str> = g["dirs"].as_array().unwrap().iter().map(str_of).collect();
    dirs.push("project");
    w.build(&dirs);
    std::fs::write(w.path(STORE), w.abs(str_of(&g["store"]))).unwrap();
    for op in g["setup"].as_array().unwrap() {
        w.apply(op);
    }
    let server = spawn(&w);
    let port = server.port;
    let recorded: Vec<Value> = g["sessions"].as_array().cloned().unwrap_or_default();
    let sessions = start_sessions(&w, port, &recorded);
    let mut norm = Norm {
        ids: sessions
            .iter()
            .map(|(_, real, rec)| (real.clone(), rec.clone()))
            .collect(),
        ..Norm::default()
    };
    let live_ids: Vec<&str> = sessions.iter().map(|(_, _, rec)| rec.as_str()).collect();

    let mut prev = norm.snapshot(&w);
    let mut last = 0;
    let mut requests = 0;
    for (i, st) in g["steps"].as_array().unwrap().iter().enumerate() {
        if let Some(ops) = st["setup"].as_array() {
            for op in ops {
                w.apply(op);
            }
            continue;
        }
        let req = &st["request"];
        let (method, id) = (str_of(&req["method"]), str_of(&req["id"]));
        let body: Option<Vec<u8>> = match (req.get("bodyBytes"), req.get("body")) {
            (Some(b), _) => Some(
                b.as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u8)
                    .collect(),
            ),
            (None, Some(b)) => Some(w.abs(str_of(b)).into_bytes()),
            (None, None) => None,
        };
        let url = format!(
            "/api/workspaces/{}/move-sessions",
            js_string::encode_uri_component(id).unwrap()
        );
        // A fresh millisecond per request, so each stamp maps to one `now`.
        while now_ms() <= last {
            std::thread::sleep(Duration::from_millis(1));
        }
        let t0 = now_ms();
        let (status, ctype, text) = request(port, method, &url, body.as_deref());
        let t1 = now_ms();
        last = t1;
        let now = st["now"].as_u64().unwrap();
        norm.learn(&text, (t0, t1), now);
        if let Ok(store) = std::fs::read_to_string(w.path(STORE)) {
            norm.learn(&store, (t0, t1), now);
        }
        let what = format!("{name} #{i} {method} {id} {:?}", req.get("body"));
        let want = &st["got"];
        if want.get("threw").is_some() {
            assert_eq!(
                (status, text.as_str()),
                (500, ""),
                "{what}: want Next's empty 500 ({})",
                want["threw"]
            );
        } else {
            assert_eq!(
                (status, ctype.as_deref()),
                (
                    want["status"].as_u64().unwrap() as u16,
                    want["type"].as_str()
                ),
                "{what}: status / type ({text})"
            );
            assert_eq!(
                norm.text(&w.rel(&text)),
                str_of(&want["body"]),
                "{what}: body"
            );
        }
        let cur = norm.snapshot(&w);
        let ch = mask_live_rows(&changes(&prev, &cur), &live_ids);
        let want_ch = mask_live_rows(&st["changes"], &live_ids);
        assert_eq!(
            ch,
            want_ch,
            "{what}: changes differ\n got: {}\nwant: {}",
            serde_json::to_string_pretty(&ch).unwrap(),
            serde_json::to_string_pretty(&want_ch).unwrap()
        );
        prev = cur;
        if !sessions.is_empty() {
            let live = live_keys(port, &sessions);
            let ended: Vec<String> = sessions
                .iter()
                .map(|(k, _, _)| k.clone())
                .filter(|k| !live.contains(k))
                .collect();
            assert_eq!(json!(live), st["live"], "{what}: live sessions");
            assert_eq!(json!(ended), st["ended"], "{what}: ended sessions");
            // Asking doesn't touch the tree.
            assert_eq!(
                norm.snapshot(&w),
                prev,
                "{what}: GET /api/sessions changed files"
            );
        }
        requests += 1;
    }
    // The server goes before the world.
    drop(server);
    requests
}

#[test]
fn routes_match_the_ts() {
    let perm = perm_enforced();
    let fx = common_wsrel::fixture();
    let (mut groups, mut requests) = (0, 0);
    for g in fx["routes"].as_array().unwrap() {
        if !runs_here(g, perm) {
            continue;
        }
        requests += run_group(g);
        groups += 1;
    }
    assert!(
        groups >= 8 && requests >= 90,
        "only {groups} groups ({requests} requests) ran"
    );
    eprintln!("{groups} groups, {requests} requests replayed");
}
