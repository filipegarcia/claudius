//! `GET /api/settings`, `GET/PUT /api/settings/full`, `GET/POST
//! /api/settings/permissions`, `GET/POST/DELETE /api/settings/auto-mode`,
//! `POST /api/settings/additional-dirs` and `GET/POST
//! /api/settings/skill-overrides` (D10) against the real binary, replaying
//! the TS handlers' recorded groups (`tests/fixtures/
//! settings_routes_golden.json`, recorded by
//! `rust/scripts/settings-routes-golden.mjs`) in order, one world and one
//! server per group. The server runs with its cwd at `<root>/project` (the
//! first trusted root), `CLAUDIUS_STATE_HOME` at `<root>/home` (so the user
//! scope is `<root>/home/.claude`), `CLAUDE_CONFIG_DIR` at `<root>/config`
//! (a decoy) and umask 022, like the recorder.
//!
//! Each request checks the status, content type and body byte for byte
//! (`threw` is Next's empty 500, and the error must be the
//! `<name>: <message>` the server logs) and every watched path the request
//! changed (kind, mode, bytes, symlink target). Each group's watched paths
//! must end as the TS left them.
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use common::{Server, free_port, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/settings_routes_golden.json")).unwrap()
}

/// Recorded sections (a labelled setup and the requests up to the next
/// setup) where Rust differs, and why. Each must still differ somewhere, so
/// a fix shows up here.
const GAPS: &[(&str, &str, &str)] = &[
    (
        "gaps",
        "lone surrogate / user",
        "a `\\ud800` escape in a settings file reads as U+FFFD (JSON.parse keeps the lone surrogate and JSON.stringify writes the escape back), in GET bodies and in every rewrite; a lone-surrogate skillOverrides key is a different key",
    ),
    (
        "gaps",
        "lone surrogate / project",
        "a `\\ud800` escape in a settings file reads as U+FFFD (JSON.parse keeps the lone surrogate and JSON.stringify writes the escape back), in GET bodies and in every rewrite; a lone-surrogate skillOverrides key is a different key",
    ),
    (
        "gaps",
        "lone surrogate / local",
        "a `\\ud800` escape in a settings file reads as U+FFFD (JSON.parse keeps the lone surrogate and JSON.stringify writes the escape back), in GET bodies and in every rewrite; a lone-surrogate skillOverrides key is a different key",
    ),
    (
        "gaps",
        "astral string / user",
        "a string settings file spreads into one key per UTF-16 unit; a Rust string can't hold the two halves of an emoji, so they are written as U+FFFD where JSON.stringify writes `\\ud83d` / `\\ude00`",
    ),
    (
        "gaps",
        "astral string / project",
        "a string settings file spreads into one key per UTF-16 unit; a Rust string can't hold the two halves of an emoji, so they are written as U+FFFD where JSON.stringify writes `\\ud83d` / `\\ude00`",
    ),
    (
        "gaps",
        "astral string / local",
        "a string settings file spreads into one key per UTF-16 unit; a Rust string can't hold the two halves of an emoji, so they are written as U+FFFD where JSON.stringify writes `\\ud83d` / `\\ude00`",
    ),
    (
        "gaps",
        "nested past 128 levels / user",
        "serde_json refuses nesting past 128 levels, so the file doesn't load (SettingsParseError, the empty 500) where V8 reads and rewrites it",
    ),
    (
        "gaps",
        "nested past 128 levels / project",
        "serde_json refuses nesting past 128 levels, so the file doesn't load (SettingsParseError, the empty 500) where V8 reads and rewrites it",
    ),
    (
        "gaps",
        "nested past 128 levels / local",
        "serde_json refuses nesting past 128 levels, so the file doesn't load (SettingsParseError, the empty 500) where V8 reads and rewrites it",
    ),
];

/// Watched paths, as the recorder walks them.
const WATCH: &[&str] = &[
    "home",
    "project",
    "ws",
    "ws-extra",
    "untrusted",
    "config",
    "shared",
];
const SKIP: &[&str] = &["home/.claude/.claudius", "home/.claude/projects"];

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    root_text: String,
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
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
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
            let Ok(entries) = std::fs::read_dir(&abs) else {
                return;
            };
            let mut names: Vec<String> = entries
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            for n in names {
                self.visit(&format!("{rel}/{n}"), snap);
            }
        } else {
            let Ok(bytes) = std::fs::read(&abs) else {
                snap.insert(rel.into(), json!({"kind": "file", "mode": mode}));
                return;
            };
            let entry = match String::from_utf8(bytes) {
                Ok(text) => json!({"kind": "file", "mode": mode, "text": self.rel(&text)}),
                Err(e) => json!({"kind": "file", "mode": mode, "bytes": e.into_bytes()}),
            };
            snap.insert(rel.into(), entry);
        }
    }

    /// Give back every permission a group took away, so the temp dir goes.
    fn unlock(&self) {
        let _ = Command::new("chmod")
            .args(["-R", "u+rwx"])
            .arg(&self.root)
            .status();
    }
}

impl Drop for World {
    fn drop(&mut self) {
        self.unlock();
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

/// `claudius` for one world under umask 022, with no CLI (no session is
/// started).
fn spawn(world: &World) -> Server {
    let port = free_port();
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg("umask 022 && exec \"$0\" \"$@\"")
        .arg(common::server_bin())
        .args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(world.path("no-such-claude"))
        .current_dir(world.path("project"))
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_DEV")
        .env_remove("CLAUDIUS_SCHEDULER")
        .env("CLAUDIUS_STATE_HOME", world.path("home"))
        .env("CLAUDE_CONFIG_DIR", world.path("config"))
        .stdout(std::fs::File::create(world.path("server.out")).unwrap())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_until("health", Duration::from_secs(20), || {
        if let Ok(Some(st)) = child.try_wait() {
            panic!("claudius exited ({st})");
        }
        TcpStream::connect(("127.0.0.1", port)).is_ok()
            && request(port, "GET", "/api/rust/health", b"").0 == 200
    });
    Server { child, port }
}

/// One HTTP/1.1 request → (status, content type, body).
fn request(port: u16, method: &str, url: &str, body: &[u8]) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut req = format!(
        "{method} {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    req.extend_from_slice(body);
    s.write_all(&req).unwrap();
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

/// The server's output from byte `from` on, with temp-file names as the
/// recorder writes them (`.tmp-$PID-$SEQ`).
fn output_since(path: &Path, from: usize) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    normalize_tmp(&String::from_utf8_lossy(
        bytes.get(from..).unwrap_or_default(),
    ))
}

/// `.tmp-<digits>-<digits>` → `.tmp-$PID-$SEQ`.
fn normalize_tmp(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(".tmp-") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 5..];
        let pid = after.bytes().take_while(u8::is_ascii_digit).count();
        let seq = after[pid..]
            .strip_prefix('-')
            .map_or(0, |t| t.bytes().take_while(u8::is_ascii_digit).count());
        if pid > 0 && seq > 0 {
            out.push_str(".tmp-$PID-$SEQ");
            rest = &after[pid + 1 + seq..];
        } else {
            out.push_str(".tmp-");
            rest = after;
        }
    }
    out.push_str(rest);
    out
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
    let world = World::new(&fx["world"]);
    let out = world.path("server.out");
    let server = spawn(&world);
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
    for (i, step) in group["steps"].as_array().unwrap().iter().enumerate() {
        if let Some(ops) = step.get("setup") {
            if let Some(label) = step["label"].as_str() {
                close_section(section, section_differs, &mut tally);
                section = Some(label);
                section_differs = false;
            }
            for op in ops.as_array().unwrap() {
                world.apply(op);
            }
            continue;
        }
        let req = &step["request"];
        let method = req["method"].as_str().unwrap();
        let url = world.sub(req["url"].as_str().unwrap());
        let body = match (req.get("body"), req.get("bodyBytes")) {
            (Some(b), _) => world.sub(b.as_str().unwrap()).into_bytes(),
            (None, Some(b)) => b
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u8)
                .collect(),
            (None, None) => Vec::new(),
        };
        let before = world.snapshot();
        let out_from = std::fs::metadata(&out).map_or(0, |m| m.len() as usize);
        let (status, ctype, text) = request(server.port, method, &url, &body);
        let after = world.snapshot();
        let want_error = step["got"]["threw"].as_str().map(|t| world.sub(t));
        let logged = want_error.as_ref().map(|t| {
            // The line is written before the response goes out.
            let o = output_since(&out, out_from);
            if o.contains(&format!("] {t}\n")) {
                t.clone()
            } else {
                o
            }
        });
        let got = (
            (status, ctype, world.rel(&text)),
            changes(&before, &after),
            logged,
        );
        let want = (expected(&step["got"]), step["changes"].clone(), want_error);
        tally.requests += 1;
        let gap = GAPS
            .iter()
            .any(|(g, label, _)| *g == name && section == Some(*label));
        if gap {
            section_differs |= got != want;
            tally.matched += usize::from(got == want);
        } else if std::env::var_os("SETTINGS_ROUTES_LIST").is_some() {
            if got != want {
                println!(
                    "DIFF {name} [{}] step {i}: {method} {} {}\n  got  {got:?}\n  want {want:?}",
                    section.unwrap_or(""),
                    req["url"],
                    req.get("body").unwrap_or(&Value::Null)
                );
            }
            tally.matched += usize::from(got == want);
        } else {
            assert_eq!(
                got,
                want,
                "{name} [{}] step {i}: {method} {} {}",
                section.unwrap_or(""),
                req["url"],
                req.get("body").unwrap_or(&Value::Null)
            );
            tally.matched += 1;
        }
    }
    close_section(section, section_differs, &mut tally);
    let end: Value = world
        .snapshot()
        .into_iter()
        .collect::<serde_json::Map<String, Value>>()
        .into();
    if std::env::var_os("SETTINGS_ROUTES_LIST").is_none() {
        assert_eq!(end, group["final"], "{name}: the watched paths at the end");
    }
    drop(server);
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
    assert!(requests >= 1800, "{requests} requests");
    println!("{matched} of {requests} recorded requests match");
}
