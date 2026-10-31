//! `GET/POST /api/mcp`, `DELETE /api/mcp/:name` and
//! `POST /api/mcp/:name/{toggle,reconnect}` (G03) against the real binary,
//! replaying the TS handlers' recorded groups
//! (`claudius-core/tests/fixtures/mcp_config_golden.json`, recorded by
//! `rust/scripts/mcp-config-golden.mjs`) in order, one world and one
//! server per group. The server runs with its cwd at `<root>/project` (the
//! first trusted root), `CLAUDIUS_STATE_HOME` at `<root>/home` (so the user
//! scope is `<root>/home/.claude`) and umask 022, like the recorder.
//!
//! Each request checks the status, content type and body byte for byte
//! (`threw` is Next's empty 500, and a V8 `TypeError` / `SyntaxError` must
//! be the text the server logs), every watched path the request changed
//! (kind, mode, bytes, symlink target), the `mcp_*` control requests the
//! session's CLI got (ids as `$ID`) and the reminder its next turn carries
//! (a probe turn after each request in the `probes` group; elsewhere one
//! probe at the end, which drains them all). Each group's watched paths must
//! end as the TS left them.
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
        "../../claudius-core/tests/fixtures/mcp_config_golden.json"
    ))
    .unwrap()
}

/// Recorded sections (a labelled setup and the requests up to the next
/// setup) where Rust differs, and why. Each must still differ somewhere, so
/// a fix shows up here.
const GAPS: &[(&str, &str, &str)] = &[
    (
        "config",
        "astral string spread",
        "a string `mcpServers` spreads into one entry per UTF-16 unit; a Rust string can't \
         hold the two halves of an emoji, so they are written as U+FFFD where JSON.stringify \
         writes `\\ud83d` / `\\ude00`",
    ),
    (
        "config",
        "lone surrogate escapes",
        "a `\\ud800` escape in a settings file reads as U+FFFD (JSON.parse keeps the lone \
         surrogate and JSON.stringify writes the escape back), in the GET body and the rewrite",
    ),
    (
        "config",
        "nested past 128 levels",
        "serde_json refuses nesting past 128 levels, so the settings file doesn't load (500); \
         V8 parses and rewrites it",
    ),
    (
        "config",
        "lone surrogate escape",
        "the GET body has U+FFFD where TS writes the `\\ud83d` escape",
    ),
    (
        "config",
        "lone surrogate body",
        "a `\\ud800` escape in the request body reaches the file as U+FFFD (TS writes the \
         escape back); an escaped pair is the same character on both sides",
    ),
    (
        "config",
        "body nested past 128 levels",
        "serde_json refuses the body (the empty 500); V8 parses it and the server is written",
    ),
];

/// Watched paths, as the recorder walks them.
const WATCH: &[&str] = &[
    "home",
    "project",
    "ws",
    "ws-extra",
    "untrusted",
    "shared",
    "config/settings.json",
    "config/mcp.json",
];
const SKIP: &[&str] = &["home/.claude/.claudius", "home/.claude/projects"];

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    root_text: String,
    /// The live session's id, once created.
    live: String,
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
            live: String::new(),
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
    }

    fn rel(&self, s: &str) -> String {
        s.replace(&self.root_text, "$ROOT")
    }

    fn apply(&self, op: &Value) {
        let p = self.path(op["path"].as_str().unwrap());
        match op["op"].as_str().unwrap() {
            "write" => {
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
                Ok(m) if m.is_dir() => std::fs::remove_dir_all(p).unwrap(),
                Ok(_) => std::fs::remove_file(p).unwrap(),
                Err(_) => {}
            },
            "symlink" => {
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
            let mut names: Vec<String> = std::fs::read_dir(&abs)
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            for n in names {
                self.visit(&format!("{rel}/{n}"), snap);
            }
        } else {
            let bytes = std::fs::read(&abs).unwrap();
            let entry = match String::from_utf8(bytes) {
                Ok(text) => json!({"kind": "file", "mode": mode, "text": self.rel(&text)}),
                Err(e) => json!({"kind": "file", "mode": mode, "bytes": e.into_bytes()}),
            };
            snap.insert(rel.into(), entry);
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
        .env("CLAUDIUS_STATE_HOME", world.path("home"))
        .env("CLAUDE_CONFIG_DIR", world.path("config"))
        .env("FAKE_CLAUDE_LOG", log)
        .stdout(std::fs::File::create(world.path("server.out")).unwrap())
        .stderr(Stdio::null());
    if let Some(s) = script {
        cmd.env("FAKE_CLAUDE_SCRIPT", s);
    }
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

fn log_lines(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// The `mcp_*` control requests written since line `from`, ids as `$ID`;
/// `mcp_status` too unless `with_status` is off (the session's own
/// background checks send it after each probe turn).
fn wire_since(log: &Path, from: usize, with_status: bool) -> Vec<String> {
    log_lines(log)
        .into_iter()
        .skip(from)
        .filter_map(|l| {
            let m: Value = serde_json::from_str(&l).ok()?;
            let subtype = m["request"]["subtype"].as_str()?;
            (m["type"] == "control_request"
                && subtype.starts_with("mcp_")
                && (with_status || subtype != "mcp_status"))
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

/// Post `probe <n>`, wait for the turn to end, and return what the CLI's
/// user message carried before the prompt.
fn probe(server: &Server, sse: &mut TcpStream, id: &str, log: &Path, n: usize) -> String {
    let text = format!("probe {n}");
    let (st, _, _) = request(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/input"),
        Some(&json!({ "text": text }).to_string()),
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
    content[..content.len() - text.len()].to_owned()
}

fn open_stream(port: u16, id: &str) -> TcpStream {
    let mut sse = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        sse,
        "GET /api/sessions/{id}/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
    )
    .unwrap();
    read_until(&mut sse, r#""type":"tips""#, Duration::from_secs(10));
    sse
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

/// A group's tally: requests replayed, and how many matched.
struct Tally {
    requests: usize,
    matched: usize,
    gap_sections_differing: Vec<String>,
}

fn replay_group(fx: &Value, group: &Value) -> Tally {
    let name = group["name"].as_str().unwrap();
    let mut world = World::new(&fx["world"]);
    let log = world.path("stdin.log");
    let out = world.path("server.out");
    let session = group["session"].as_str();
    let probes = group["probes"].as_bool().unwrap();
    let script = match &group["script"] {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        v => Some(v.to_string()),
    };
    let server = spawn(&world, &log, script, session != Some("none"));
    let mut sse = None;
    if session.is_some() {
        let (st, _, body) = request(
            server.port,
            "POST",
            "/api/sessions",
            Some(&json!({"cwd": world.path("project")}).to_string()),
        );
        assert_eq!(st, 200, "{name}: {body}");
        world.live = serde_json::from_str::<Value>(&body).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        if session == Some("live") {
            sse = Some(open_stream(server.port, &world.live));
            // The startup MCP notices (S15b) send two `mcp_status` requests
            // at the init; TS recorded on a bare session that has none.
            wait_until("the startup checks", Duration::from_secs(10), || {
                wire_since(&log, 0, true).len() == 2
            });
        }
    }

    let mut tally = Tally {
        requests: 0,
        matched: 0,
        gap_sections_differing: Vec::new(),
    };
    let mut section: Option<&str> = None;
    let mut section_differs = false;
    let close_section = |label: Option<&str>, differs: bool, tally: &mut Tally| {
        if let Some(l) = label
            && differs
        {
            tally.gap_sections_differing.push(l.to_owned());
        }
    };
    let mut pending_reminders = String::new();
    for (i, step) in group["steps"].as_array().unwrap().iter().enumerate() {
        if let Some(ops) = step.get("setup") {
            close_section(section, section_differs, &mut tally);
            section = step["label"].as_str();
            section_differs = false;
            for op in ops.as_array().unwrap() {
                world.apply(op);
            }
            continue;
        }
        let req = &step["request"];
        let method = req["method"].as_str().unwrap();
        let url = world.sub(req["url"].as_str().unwrap());
        let body = req.get("body").map(|b| world.sub(b.as_str().unwrap()));
        let before = world.snapshot();
        let from = log_lines(&log).len();
        let out_from = std::fs::metadata(&out).map_or(0, |m| m.len() as usize);
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
        let wire = wire_since(&log, from, !probes);
        let after = world.snapshot();
        let reminder = if probes {
            probe(&server, sse.as_mut().unwrap(), &world.live, &log, i)
        } else {
            String::new()
        };
        let got = (
            (status, ctype, world.rel(&text)),
            changes(&before, &after),
            wire,
            reminder,
            logged,
        );
        let mut want_wire = strings(&step["wire"]);
        if probes {
            want_wire.retain(|l| !l.contains(r#""subtype":"mcp_status""#));
        }
        let want_reminder = step["reminder"].as_str().unwrap_or("").to_owned();
        if !probes {
            pending_reminders.push_str(&want_reminder);
        }
        let want = (
            expected(&step["got"]),
            step["changes"].clone(),
            want_wire,
            if probes { want_reminder } else { String::new() },
            want_error,
        );
        tally.requests += 1;
        let gap = GAPS
            .iter()
            .any(|(g, label, _)| *g == name && section == Some(*label));
        if gap {
            section_differs |= got != want;
            tally.matched += usize::from(got == want);
        } else {
            assert_eq!(
                got,
                want,
                "{name} step {i}: {method} {} {}",
                req["url"],
                req.get("body").unwrap_or(&Value::Null)
            );
            tally.matched += 1;
        }
    }
    close_section(section, section_differs, &mut tally);

    // Without per-request probes, one turn drains whatever was queued.
    if session == Some("live") && !probes {
        let n = group["steps"].as_array().unwrap().len();
        let got = probe(&server, sse.as_mut().unwrap(), &world.live, &log, n);
        assert_eq!(got, pending_reminders, "{name}: the reminders queued");
    }
    let end: Value = world
        .snapshot()
        .into_iter()
        .collect::<serde_json::Map<String, Value>>()
        .into();
    assert_eq!(end, group["final"], "{name}: the watched paths at the end");
    tally
}

#[test]
fn the_routes_replay_the_ts_handlers() {
    let fx = fixture();
    let (mut requests, mut matched) = (0, 0);
    let mut differing = Vec::new();
    for group in fx["groups"].as_array().unwrap() {
        let t = replay_group(&fx, group);
        requests += t.requests;
        matched += t.matched;
        let name = group["name"].as_str().unwrap();
        differing.extend(
            t.gap_sections_differing
                .into_iter()
                .map(|l| (name.to_owned(), l)),
        );
    }
    for (g, label, why) in GAPS {
        assert!(
            differing.iter().any(|(dg, dl)| dg == g && dl == label),
            "stale gap {g} / {label}: {why}"
        );
    }
    assert!(requests >= 400, "{requests} requests");
    println!("{matched} of {requests} recorded requests match");
}
