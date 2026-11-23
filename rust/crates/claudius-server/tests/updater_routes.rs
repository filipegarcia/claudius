//! `/api/updater/{settings,status,log,check,changelog}` (D27a) against the
//! real binary, replaying the `phases` of
//! `claudius-core/tests/fixtures/updater_golden.json` (recorded by
//! `rust/scripts/updater-golden.mjs` from the real TS route handlers).
//!
//! One world for every phase, as in the recorder: a temp root with the
//! settings file under `home/`, the install root `current` (a symlink the
//! steps re-point at a plain dir, real throwaway repos, or a dir served by a
//! fake `git` at `home/.bun/bin`, which `extendedPath` puts first), and the
//! server's cwd `servercwd`. Each phase is a fresh server with that phase's
//! `CLAUDIUS_INSTALL_ROOT`, the recorder's pinned environment, and
//! `CLAUDIUS_DEV_FETCH_BASE` at a local fake of api.github.com that answers
//! the recorded raw responses. Every request must answer the same status,
//! content type and body text ("threw" is Next's empty 500), leave the same
//! `updater.json`, make the same upstream requests, and make the fake `git`
//! log the same calls (cwd, argv, `GIT_TERMINAL_PROMPT`, `GIT_ASKPASS`,
//! `PATH`'s first entry).
//!
//! The recorder ran on a counter clock; this server runs on the real one,
//! so timestamps compare as `$T`. On a git other than the recorder's, the
//! steps whose recorded answer quotes git's own error text compare their
//! status only. Steps tagged `nonRoot` (a 000 mode) are skipped as root.
#![cfg(unix)]

mod common;

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_core::{js_string, now_ms};
use common::Server;
use serde_json::Value;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/updater_golden.json");
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// `(status, content type, body)`.
fn request(port: u16, method: &str, path: &str, body: &[u8]) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut out = vec![];
    s.read_to_end(&mut out).unwrap();
    let at = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&out[..at]).into_owned();
    let body = String::from_utf8_lossy(&out[at + 4..]).into_owned();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let content_type = head.split("\r\n").find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, content_type, body)
}

// ---- the fake api.github.com ----------------------------------------------------

/// One request the fake upstream got.
struct Served {
    method: String,
    path: String,
    /// Lower-cased names, in order.
    headers: Vec<(String, String)>,
    /// No response was scripted for it (it was hung up on).
    unscripted: bool,
}

#[derive(Default)]
struct Upstream {
    queue: VecDeque<Value>,
    served: Vec<Served>,
}

fn upstream() -> (String, Arc<Mutex<Upstream>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let state = Arc::new(Mutex::new(Upstream::default()));
    let st = state.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            let st = st.clone();
            std::thread::spawn(move || answer(conn, &st));
        }
    });
    (base, state)
}

fn answer(mut conn: TcpStream, st: &Mutex<Upstream>) {
    let mut head = Vec::new();
    let mut buf = [0u8; 4096];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match conn.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let (method, path) = (
        first.next().unwrap_or_default().to_owned(),
        first.next().unwrap_or_default().to_owned(),
    );
    let headers = lines
        .take_while(|l| !l.is_empty())
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k.to_ascii_lowercase(), v.trim().to_owned()))
        })
        .collect();
    let next = {
        let mut st = st.lock().unwrap();
        let next = st.queue.pop_front();
        st.served.push(Served {
            method,
            path,
            headers,
            unscripted: next.is_none(),
        });
        next
    };
    // `close` and `refuse` (a closed port in the recorder) both hang up.
    match next.as_ref().and_then(|r| r["wireHex"].as_str()) {
        Some(h) => {
            let _ = conn.write_all(&hex(h));
            let _ = conn.shutdown(Shutdown::Write);
            let _ = conn.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = conn.read(&mut buf);
        }
        None => {
            let _ = conn.shutdown(Shutdown::Both);
        }
    }
}

// ---- the world --------------------------------------------------------------------

struct Replay {
    root: String,
    env: Vec<(String, String)>,
    real_git: String,
    same_git: bool,
    is_root: bool,
    /// The test's first and last possible `Date.now()`.
    t_start: i64,
    failures: Vec<String>,
}

const SETTINGS: &str = "home/.claude/.claudius/updater.json";
const CALLS: &str = "home/.bun/bin/calls.log";

impl Replay {
    fn p(&self, rel: &str) -> String {
        if rel.is_empty() {
            self.root.clone()
        } else {
            format!("{}/{rel}", self.root)
        }
    }

    /// The recorder's `sub`: the root as `$ROOT`, timestamps as `$T`.
    fn norm(&self, s: &str) -> String {
        let s = s.replace(&self.root, "$ROOT");
        let (lo, hi) = (self.t_start - 1, now_ms() + 1);
        let b = s.as_bytes();
        let mut out = String::with_capacity(s.len());
        let mut i = 0;
        while i < b.len() {
            if b[i].is_ascii_digit() && (i == 0 || !b[i - 1].is_ascii_digit()) {
                let n = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
                if n == 13
                    && let Ok(v) = s[i..i + n].parse::<i64>()
                    && (lo..=hi).contains(&v)
                {
                    out.push_str("$T");
                    i += n;
                    continue;
                }
            }
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
        out
    }

    fn file_state(&self) -> Value {
        let p = self.p(SETTINGS);
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() => Value::String("<dir>".into()),
            Ok(_) => match std::fs::read(&p) {
                Ok(b) => Value::String(self.norm(&String::from_utf8_lossy(&b))),
                Err(_) => Value::Null,
            },
            Err(_) => Value::Null,
        }
    }

    fn fail(&mut self, label: &str, what: String) {
        self.failures.push(format!("{label}: {what}"));
    }

    fn world_op(&mut self, s: &Value) {
        let path = s["path"].as_str().map(|p| self.p(p));
        match s["op"].as_str().unwrap() {
            "git" => {
                let args: Vec<String> = s["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap().replace("$ROOT", &self.root))
                    .collect();
                let status = Command::new(&self.real_git)
                    .args(&args)
                    .current_dir(self.p(s["cwd"].as_str().unwrap()))
                    .env_clear()
                    .envs(self.env.iter().map(|(k, v)| (k, v)))
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .unwrap();
                if !status.success() != (s["fails"] == true) {
                    self.fail("git", format!("{args:?} exited {status}"));
                }
            }
            "write" | "hex" | "gen" => {
                let path = path.unwrap();
                std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
                let bytes = match s["op"].as_str().unwrap() {
                    "write" => js_string::lossy(s["text"].as_str().unwrap())
                        .into_owned()
                        .into_bytes(),
                    "hex" => hex(s["hex"].as_str().unwrap()),
                    _ => {
                        let mut t = String::new();
                        for i in 0..s["count"].as_u64().unwrap() {
                            t.push_str(&format!("line {i}\n"));
                        }
                        t.push_str(s["tail"].as_str().unwrap());
                        t.into_bytes()
                    }
                };
                std::fs::write(&path, bytes).unwrap();
            }
            "rm" => {
                let path = path.unwrap();
                match std::fs::symlink_metadata(&path) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(&path).unwrap(),
                    Ok(_) => std::fs::remove_file(&path).unwrap(),
                    Err(_) => {}
                }
            }
            "mkdir" => std::fs::create_dir_all(path.unwrap()).unwrap(),
            "link" => {
                let path = path.unwrap();
                let _ = std::fs::remove_file(&path);
                std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
                let to = s["to"].as_str().unwrap().replace("$ROOT", &self.root);
                std::os::unix::fs::symlink(to, &path).unwrap();
            }
            "chmod" => {
                use std::os::unix::fs::PermissionsExt;
                let mode = u32::from_str_radix(s["mode"].as_str().unwrap(), 8).unwrap();
                std::fs::set_permissions(path.unwrap(), std::fs::Permissions::from_mode(mode))
                    .unwrap();
            }
            "calls" => {
                let p = self.p(CALLS);
                let text = std::fs::read_to_string(&p).unwrap_or_default();
                let _ = std::fs::remove_file(&p);
                let got = self.norm(&text);
                let want = s["text"].as_str().unwrap();
                if got != want {
                    self.fail("calls", format!("\n got: {got}\nwant: {want}"));
                }
            }
            op => panic!("unknown op {op}"),
        }
    }

    /// One answer against the recorded `got`.
    fn compare(&mut self, label: &str, want: &Value, got: &(u16, Option<String>, String)) {
        let (status, ctype, body) = got;
        if let Some(threw) = want.get("threw") {
            if *status != 500 || !body.is_empty() || ctype.is_some() {
                self.fail(
                    label,
                    format!("want the empty 500 ({threw}), got {status} {ctype:?} {body}"),
                );
            }
            return;
        }
        let want_status = want["status"].as_u64().unwrap() as u16;
        let quotes_git = |v: &Value| {
            let t = js_string::stringify(v);
            ["fatal:", "error:", "Command failed", "warning:"]
                .iter()
                .any(|m| t.contains(m))
        };
        if *status != want_status {
            self.fail(
                label,
                format!("status {status}, want {want_status}: {body}"),
            );
            return;
        }
        if !self.same_git && quotes_git(want) {
            return;
        }
        if ctype.as_deref() != want["type"].as_str() {
            self.fail(
                label,
                format!("content type {ctype:?}, want {}", want["type"]),
            );
        }
        if let Some(want_body) = want["body"].as_str() {
            let got_body = self.norm(body);
            if got_body != want_fixture(want_body) {
                self.fail(label, format!("\n got: {got_body}\nwant: {want_body}"));
            }
        } else {
            let len = want["bodyLen"].as_u64().unwrap() as usize;
            let fnv = want["bodyFnv"].as_str().unwrap();
            let units = js_string::units(body);
            let head = self.norm(&js_string::from_units(&units[..units.len().min(200)]));
            if body.len() != len
                || fnv64(body) != fnv
                || head != want_fixture(want["head"].as_str().unwrap())
            {
                self.fail(
                    label,
                    format!(
                        "big body: {} bytes, fnv {}, head {head}",
                        body.len(),
                        fnv64(body)
                    ),
                );
            }
        }
    }

    fn compare_file(&mut self, label: &str, want: &Value) {
        let got = self.file_state();
        let want = match want {
            Value::String(s) => Value::String(want_fixture(s)),
            v => v.clone(),
        };
        if !self.same_git && js_string::stringify(&want).contains("fatal:") {
            return;
        }
        if got != want {
            self.fail(label, format!("updater.json\n got: {got}\nwant: {want}"));
        }
    }
}

/// The fixture's text with its `$T<n>` clock tokens as `$T`.
fn want_fixture(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find("$T") {
        out.push_str(&rest[..at + 2]);
        rest = rest[at + 2..].trim_start_matches(|c: char| c.is_ascii_digit());
    }
    out.push_str(rest);
    out
}

/// FNV-1a 64 of the UTF-8 bytes, as the recorder prints it.
fn fnv64(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn spawn(replay: &Replay, install_root: Option<&str>, base: &str) -> Server {
    let port = common::free_port();
    let mut cmd = Command::new(common::server_bin());
    cmd.args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(common::fake_bin())
        .current_dir(replay.p("servercwd"))
        .env_clear()
        .envs(replay.env.iter().map(|(k, v)| (k, v)))
        .env("CLAUDIUS_STATE_HOME", replay.p("home"))
        .env("CLAUDIUS_DEV", "1")
        .env("CLAUDIUS_DEV_FETCH_BASE", base)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Ok(t) = std::env::var("TMPDIR") {
        cmd.env("TMPDIR", t);
    }
    if let Some(r) = install_root {
        cmd.env("CLAUDIUS_INSTALL_ROOT", r.replace("$ROOT", &replay.root));
    }
    let child = cmd.spawn().unwrap();
    let server = Server { child, port };
    common::wait_until("health", Duration::from_secs(20), || {
        TcpStream::connect(("127.0.0.1", port)).is_ok()
            && common::http(port, "GET", "/api/rust/health", "").0 == 200
    });
    server
}

#[test]
fn updater_routes_replay_the_ts_golden() {
    let fx = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let abs: Vec<&str> = fx["abs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let path = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        .into_iter()
        .chain(abs.iter().copied())
        .collect::<Vec<_>>()
        .join(":");
    let real_git = String::from_utf8(
        Command::new("/bin/sh")
            .args(["-c", "command -v git"])
            .env_clear()
            .env("PATH", &path)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    assert!(!real_git.is_empty(), "no git on {path}");
    let version = String::from_utf8(
        Command::new(&real_git)
            .arg("--version")
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    let mut env: Vec<(String, String)> = fx["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().replace("$ROOT", &root)))
        .collect();
    env.push(("PATH".into(), path));
    env.push(("REAL_GIT".into(), real_git.clone()));
    let is_root = Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false);
    let mut replay = Replay {
        root,
        env,
        real_git,
        same_git: fx["git"].as_str() == Some(version.as_str()),
        is_root,
        t_start: now_ms(),
        failures: vec![],
    };
    std::fs::create_dir_all(replay.p("home")).unwrap();
    std::fs::create_dir_all(replay.p("servercwd")).unwrap();
    let (base, up) = upstream();
    let mut requests = 0;
    for phase in fx["phases"].as_array().unwrap() {
        let name = phase["name"].as_str().unwrap();
        let install_root = phase["env"]["CLAUDIUS_INSTALL_ROOT"].as_str();
        let server = spawn(&replay, install_root, &base);
        for s in phase["steps"].as_array().unwrap() {
            let op = s["op"].as_str().unwrap();
            if op != "req" && op != "together" {
                replay.world_op(s);
                continue;
            }
            let label = format!("{name}: {}", s["label"].as_str().unwrap());
            let (method, url) = (s["method"].as_str().unwrap(), s["url"].as_str().unwrap());
            if s["nonRoot"] == true && replay.is_root {
                continue;
            }
            if op == "together" {
                let n = s["n"].as_u64().unwrap() as usize;
                let port = server.port;
                let handles: Vec<_> = (0..n)
                    .map(|_| {
                        let (m, u) = (method.to_owned(), url.to_owned());
                        std::thread::spawn(move || request(port, &m, &u, b""))
                    })
                    .collect();
                let got: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
                for (i, g) in got.iter().enumerate() {
                    replay.compare(&format!("{label} #{i}"), &s["got"][i], g);
                }
                replay.compare_file(&label, &s["file"]);
                requests += n;
                continue;
            }
            let body = match (s["body"].as_str(), s["bodyHex"].as_str()) {
                (Some(b), _) => js_string::lossy(b).into_owned().into_bytes(),
                (None, Some(h)) => hex(h),
                _ => vec![],
            };
            let scripted = s.get("responses").is_some();
            if scripted {
                let mut u = up.lock().unwrap();
                u.served.clear();
                u.queue = s["responses"].as_array().unwrap().clone().into();
            }
            let got = request(server.port, method, url, &body);
            requests += 1;
            replay.compare(&label, &s["got"], &got);
            replay.compare_file(&label, &s["file"]);
            if scripted {
                let u = up.lock().unwrap();
                let wire = s["wire"].as_array().unwrap();
                let refused = s["responses"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|r| r["refuse"] == true)
                    .count();
                let mut problems = vec![];
                if !u.queue.is_empty() {
                    problems.push(format!("{} responses unused", u.queue.len()));
                }
                if u.served.len() != wire.len() + refused {
                    problems.push(format!(
                        "{} upstream requests, want {}",
                        u.served.len(),
                        wire.len() + refused
                    ));
                }
                for (w, got) in wire.iter().zip(u.served.iter()) {
                    let (m, p, headers, unscripted) =
                        (&got.method, &got.path, &got.headers, &got.unscripted);
                    if w["method"].as_str() != Some(m) || w["path"].as_str() != Some(p) {
                        problems.push(format!("{m} {p}, want {} {}", w["method"], w["path"]));
                    }
                    if (w["unscripted"] == true) != *unscripted {
                        problems.push(format!("{p}: unscripted {unscripted}"));
                    }
                    // The caller's own headers (the client's defaults differ
                    // by design, see `claudius_core::fetch`).
                    for name in [
                        "accept",
                        "user-agent",
                        "x-github-api-version",
                        "pragma",
                        "cache-control",
                    ] {
                        let want = w["headers"].as_array().unwrap().iter().find_map(|h| {
                            (h[0].as_str()?.eq_ignore_ascii_case(name))
                                .then(|| h[1].as_str().unwrap().to_owned())
                        });
                        let got = headers
                            .iter()
                            .find(|(k, _)| k == name)
                            .map(|(_, v)| v.clone());
                        if got != want {
                            problems.push(format!("{name}: {got:?}, want {want:?}"));
                        }
                    }
                }
                drop(u);
                if !problems.is_empty() {
                    replay.fail(&label, problems.join("; "));
                }
            }
        }
        drop(server);
    }
    assert!(requests >= 340, "only {requests} requests replayed");
    assert!(
        replay.failures.is_empty(),
        "{} of {requests} requests differ:\n{}",
        replay.failures.len(),
        replay.failures.join("\n")
    );
}
