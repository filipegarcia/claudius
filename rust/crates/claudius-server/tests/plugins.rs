//! `GET/POST /api/plugins`, `GET /api/plugins/available` and
//! `POST /api/plugins/reload` (G04) against the real binary, replaying the
//! TS handlers' recorded groups (`claudius-core/tests/fixtures/
//! plugins_golden.json`, recorded by `rust/scripts/plugins-golden.mjs`) in
//! order, one world and one server per group. The server runs with its cwd
//! at `<root>/project` (the first trusted root), `CLAUDIUS_STATE_HOME` at
//! `<root>/home` (so the user scope is `<root>/home/.claude`, and so is the
//! marketplaces' home) and umask 022, like the recorder.
//!
//! Each request checks the status, content type and body byte for byte
//! (`threw` is Next's empty 500, and a V8 `TypeError` / `SyntaxError` must
//! be the text the server logs), every watched path the request changed
//! (kind, mode, bytes, symlink target) and the `reload_plugins` control
//! requests the sessions' CLIs got (ids as `$ID`, sorted). Sessions are
//! real ones in `<root>/sess` against the fake CLI with the group's script
//! (`$ROOT` swapped in); `none` runs the server with a missing CLI, so its
//! session has no query. Each group's watched paths must end as the TS left
//! them.
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use common::{Server, free_port, read_until, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../claudius-core/tests/fixtures/plugins_golden.json"
    ))
    .unwrap()
}

/// Watched paths, as the recorder walks them.
const WATCH: &[&str] = &["home", "project", "ws", "ws-extra", "untrusted"];
const SKIP: &[&str] = &[
    "home/.claude/.claudius",
    "home/.claude/projects",
    "project/lib",
];

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    root_text: String,
    /// The sessions' ids, once created (`$LIVE`, `$OTHER`).
    live: String,
    other: String,
}

impl World {
    fn new(layout: &Value) -> World {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let root_text = root.display().to_string();
        assert!(
            root_text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b)),
            "placeholders are swapped textually: {root_text}"
        );
        let w = World {
            _dir: dir,
            root,
            root_text,
            live: "$LIVE".into(),
            other: "$OTHER".into(),
        };
        for d in layout["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(w.path(d.as_str().unwrap())).unwrap();
        }
        for f in layout["files"].as_array().unwrap() {
            let p = w.path(f[0].as_str().unwrap());
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, w.sub(f[1].as_str().unwrap())).unwrap();
        }
        w
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn sub(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root_text)
            .replace("$LIVE", &self.live)
            .replace("$OTHER", &self.other)
    }

    fn rel(&self, s: &str) -> String {
        s.replace(&self.root_text, "$ROOT")
            .replace(&self.live, "$LIVE")
            .replace(&self.other, "$OTHER")
    }

    fn apply(&self, op: &Value) {
        let p = self.path(op["path"].as_str().unwrap());
        match op["op"].as_str().unwrap() {
            "write" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let bytes = match op.get("bytes") {
                    Some(b) => b
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_u64().unwrap() as u8)
                        .collect(),
                    None => self.sub(op["text"].as_str().unwrap()).into_bytes(),
                };
                std::fs::write(p, bytes).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(p).unwrap(),
            "rm" => match std::fs::symlink_metadata(&p) {
                Ok(m) if m.is_dir() => {
                    unlock(&p);
                    std::fs::remove_dir_all(p).unwrap();
                }
                Ok(_) => std::fs::remove_file(p).unwrap(),
                Err(_) => {}
            },
            "symlink" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(self.sub(op["target"].as_str().unwrap()), p).unwrap()
            }
            "chmod" => std::fs::set_permissions(
                p,
                std::fs::Permissions::from_mode(op["mode"].as_u64().unwrap() as u32),
            )
            .unwrap(),
            other => panic!("unknown op {other}"),
        }
    }

    /// Every watched path, as the recorder's `snapshot()` records it.
    fn snapshot(&self) -> BTreeMap<String, Value> {
        let mut snap = BTreeMap::new();
        for w in WATCH {
            self.visit(w, &mut snap);
        }
        snap
    }

    fn visit(&self, rel: &str, snap: &mut BTreeMap<String, Value>) {
        if SKIP.contains(&rel) {
            return;
        }
        let abs = self.path(rel);
        let Ok(meta) = std::fs::symlink_metadata(&abs) else {
            return;
        };
        let mode = meta.permissions().mode() & 0o777;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&abs).unwrap().display().to_string();
            snap.insert(
                rel.into(),
                json!({"kind": "symlink", "target": self.rel(&target)}),
            );
        } else if meta.is_dir() {
            snap.insert(rel.into(), json!({"kind": "dir", "mode": mode}));
            // An unreadable dir is recorded without its entries.
            let mut names: Vec<String> = std::fs::read_dir(&abs)
                .map(|d| {
                    d.map(|e| e.unwrap().file_name().into_string().unwrap())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            for n in names {
                self.visit(&format!("{rel}/{n}"), snap);
            }
        } else {
            let mut entry = json!({"kind": "file", "mode": mode});
            // An unreadable file is recorded without its content.
            if let Ok(bytes) = std::fs::read(&abs) {
                match String::from_utf8(bytes) {
                    Ok(text) => entry["text"] = json!(self.rel(&text)),
                    Err(e) => entry["bytes"] = json!(e.into_bytes()),
                }
            }
            snap.insert(rel.into(), entry);
        }
    }
}

/// Make everything under `dir` removable again.
fn unlock(dir: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(dir) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
    if meta.is_dir() {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            unlock(&e.path());
        }
    }
}

/// The paths whose entries differ, sorted, each with its new entry (`null`
/// when it is gone): the recorder's `changes`.
fn changes(before: &BTreeMap<String, Value>, after: &BTreeMap<String, Value>) -> Value {
    let mut keys: Vec<&String> = before.keys().chain(after.keys()).collect();
    keys.sort();
    keys.dedup();
    Value::Array(
        keys.into_iter()
            .filter(|k| before.get(*k) != after.get(*k))
            .map(|k| json!([k, after.get(k).cloned().unwrap_or(Value::Null)]))
            .collect(),
    )
}

/// `claudius` for one world under umask 022, with the fake CLI (or a
/// missing one, so sessions have no query).
fn spawn(world: &World, log: &Path, script: Option<String>, cli: bool) -> Server {
    let port = free_port();
    let claude = if cli {
        common::fake_bin()
    } else {
        world.path("no-such-claude")
    };
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg("umask 022 && exec \"$0\" \"$@\"")
        .arg(env!("CARGO_BIN_EXE_claudius"))
        .args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(claude)
        .current_dir(world.path("project"))
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_DEV")
        .env_remove("CLAUDIUS_SCHEDULER")
        .env("CLAUDIUS_STATE_HOME", world.path("home"))
        .env("CLAUDE_CONFIG_DIR", world.path("config"))
        .env("FAKE_CLAUDE_LOG", log)
        .stdout(std::fs::File::create(world.path("server.out")).unwrap())
        .stderr(Stdio::null());
    match script {
        Some(s) => cmd.env("FAKE_CLAUDE_SCRIPT", world.sub(&s)),
        None => cmd.env_remove("FAKE_CLAUDE_SCRIPT"),
    };
    let mut child = cmd.spawn().unwrap();
    wait_until("health", Duration::from_secs(20), || {
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
    body: Option<&str>,
) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let body = body.unwrap_or("");
    write!(
        s,
        "{method} {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8(raw).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let ctype = lines.find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, ctype, body.to_owned())
}

/// The `reload_plugins` control requests in `log` past byte `from`, ids as
/// `$ID`, sorted. The CLIs append to the same file, and the fake writes a
/// line and its newline separately, so lines can run together: read the
/// text as a stream of JSON values instead.
fn reload_wire(log: &Path, from: usize) -> Vec<String> {
    let text = std::fs::read(log).unwrap_or_default();
    let text = String::from_utf8_lossy(&text[from.min(text.len())..]).into_owned();
    let mut it = serde_json::Deserializer::from_str(&text).into_iter::<Value>();
    let (mut start, mut v) = (0, Vec::new());
    while let Some(Ok(m)) = it.next() {
        let end = it.byte_offset();
        let raw = text[start..end].trim_start();
        start = end;
        if m["type"] == "control_request" && m["request"]["subtype"] == "reload_plugins" {
            let id = serde_json::to_string(&m["request_id"]).unwrap();
            v.push(raw.replacen(&id, "\"$ID\"", 1));
        }
    }
    v.sort();
    v
}

fn file_len(p: &Path) -> usize {
    std::fs::metadata(p).map_or(0, |m| m.len() as usize)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

/// A recorded throw whose text Rust words the same (V8's `TypeError` and
/// `SyntaxError`), which the server logs with the route's prefix.
fn v8_error(got: &Value) -> Option<&str> {
    got["threw"]
        .as_str()
        .filter(|t| t.starts_with("TypeError: ") || t.starts_with("SyntaxError: "))
}

/// The server's output from byte `from` on.
fn output_since(path: &Path, from: usize) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    String::from_utf8_lossy(bytes.get(from..).unwrap_or_default()).into_owned()
}

/// `(status, content type, body)` of a recorded `got`; `threw` is Next's
/// empty 500.
fn expected(got: &Value) -> (u16, Option<String>, String) {
    if got.get("threw").is_some() {
        return (500, None, String::new());
    }
    (
        got["status"].as_u64().unwrap() as u16,
        got["type"].as_str().map(str::to_owned),
        got["body"].as_str().unwrap().to_owned(),
    )
}

/// A session's SSE stream and everything read from it so far.
struct Stream {
    sse: TcpStream,
    seen: String,
}

const INIT: &str = r#""subtype":"init""#;

impl Stream {
    fn open(server: &Server, id: &str) -> Stream {
        let mut sse = server.open_stream(id);
        let seen = read_until(&mut sse, r#""type":"tips""#, Duration::from_secs(10));
        Stream { sse, seen }
    }

    /// Read until `needle` has shown up `n` times.
    fn wait_for(&mut self, needle: &str, n: usize) {
        while self.seen.matches(needle).count() < n {
            let more = read_until(&mut self.sse, needle, Duration::from_secs(10));
            self.seen.push_str(&more);
        }
    }
}

/// POST /api/sessions in `<root>/sess` → its id.
fn create_session(server: &Server, world: &World) -> String {
    let (st, _, body) = request(
        server.port,
        "POST",
        "/api/sessions",
        Some(&json!({"cwd": world.path("sess")}).to_string()),
    );
    assert_eq!(st, 200, "{body}");
    serde_json::from_str::<Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Replay one group; returns how many requests it made.
fn replay_group(fx: &Value, group: &Value) -> usize {
    let name = group["name"].as_str().unwrap();
    let mut world = World::new(&fx["world"]);
    let log = world.path("stdin.log");
    let out = world.path("server.out");
    let session = group["session"].as_str();
    let script = group["script"].as_str().map(str::to_owned);
    let server = spawn(&world, &log, script, session != Some("none"));
    let mut live = None;
    match session {
        None => {}
        Some("two") => {
            world.live = create_session(&server, &world);
            let mut s = Stream::open(&server, &world.live);
            s.wait_for(INIT, 1);
            live = Some(s);
            world.other = create_session(&server, &world);
            Stream::open(&server, &world.other).wait_for(INIT, 1);
        }
        Some("none") => world.live = create_session(&server, &world),
        Some("exited") => {
            world.live = create_session(&server, &world);
            let mut s = Stream::open(&server, &world.live);
            s.wait_for(INIT, 1);
            s.wait_for("exited with code 3", 1);
        }
        Some(other) => panic!("unknown session kind {other}"),
    }

    let mut requests = 0;
    for (i, step) in group["steps"].as_array().unwrap().iter().enumerate() {
        if let Some(ops) = step.get("setup") {
            for op in ops.as_array().unwrap() {
                world.apply(op);
            }
            continue;
        }
        if let Some(w) = step.get("wait") {
            assert_eq!(w["session"], "$LIVE");
            let n = w["count"].as_u64().unwrap() as usize;
            live.as_mut().unwrap().wait_for(INIT, n);
            continue;
        }
        let req = &step["request"];
        let method = req["method"].as_str().unwrap();
        let url = world.sub(req["url"].as_str().unwrap());
        let body = req.get("body").map(|b| world.sub(b.as_str().unwrap()));
        let before = world.snapshot();
        let from = file_len(&log);
        let out_from = file_len(&out);
        let (status, ctype, text) = request(server.port, method, &url, body.as_deref());
        let want_error = v8_error(&step["got"]).map(|t| world.sub(t));
        let logged = want_error.as_ref().map(|t| {
            let o = output_since(&out, out_from);
            if o.contains(&format!("] {t}\n")) {
                t.clone()
            } else {
                o
            }
        });
        let got = (
            (status, ctype, world.rel(&text)),
            changes(&before, &world.snapshot()),
            reload_wire(&log, from),
            logged,
        );
        let want = (
            expected(&step["got"]),
            step["changes"].clone(),
            strings(&step["wire"]),
            want_error,
        );
        assert_eq!(
            got,
            want,
            "{name} step {i}: {method} {} {}",
            req["url"],
            req.get("body").unwrap_or(&Value::Null)
        );
        requests += 1;
    }

    let end: Value = world
        .snapshot()
        .into_iter()
        .collect::<serde_json::Map<String, Value>>()
        .into();
    assert_eq!(end, group["final"], "{name}: the watched paths at the end");
    unlock(&world.root);
    requests
}

fn replay(name: &str, min: usize) {
    let fx = fixture();
    let group = fx["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == name)
        .unwrap();
    let n = replay_group(&fx, group);
    assert!(n >= min, "{name}: {n} requests");
}

#[test]
fn listing_replays_the_ts() {
    replay("listing", 40);
}

#[test]
fn writes_replay_the_ts() {
    replay("writes", 150);
}

#[test]
fn available_replays_the_ts() {
    replay("available", 5);
}

#[test]
fn live_sessions_replay_the_ts() {
    replay("live", 30);
}

#[test]
fn a_session_without_a_query_replays_the_ts() {
    replay("no query", 3);
}

#[test]
fn an_exited_cli_replays_the_ts() {
    replay("exited", 3);
}

#[test]
fn every_group_is_replayed() {
    let fx = fixture();
    let names: Vec<&str> = fx["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "listing",
            "writes",
            "available",
            "live",
            "no query",
            "exited"
        ]
    );
}
