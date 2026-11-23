//! `POST /api/updater/apply` (D27b) against the real binary, replaying the
//! `phases` of `claudius-core/tests/fixtures/updater_apply_golden.json`
//! (recorded by `rust/scripts/updater-apply-golden.mjs` from the real TS
//! route and `lib/server/updater/{apply,restart,git,detect,settings}.ts`).
//!
//! The world is the recorder's: a temp root with a bare upstream, a seed
//! clone that pushes to it, and one throwaway install clone per scenario
//! that the install root `$ROOT/current` (a symlink) points at. A logging
//! pass-through `git` and a fake `bun` sit at `home/.bun/bin` (which
//! `extendedPath` puts first); `$ROOT/claude-wrap` is the server's
//! `--claude-bin`, which runs some real git (a merge, a resolve) and then
//! the fake CLI. The server runs with `CLAUDIUS_DEV=1` and
//! `CLAUDIUS_DEV_RESTART_LOG`, so a daemon-mode restart is written down,
//! not run.
//!
//! SAFETY: every request first checks that the install root resolves
//! under the test's temp dir; the fake `git` and `bun` refuse to run
//! outside it.
//!
//! Each request must answer the same status, content type and body
//! ("threw" is Next's empty 500), leave the same `updater.json`, append
//! the same apply log, record the same restart, make the same git / bun /
//! claude calls (cwd, argv, the env the updater sets), send the fake CLI
//! the same prompts and argv, and leave the install's git state the same.
//! The recorder ran on a counter clock and pid; times compare as `$T` /
//! `$ISO`, the server's pid as `$PID`. On a git other than the recorder's,
//! the steps whose recorded text quotes git's own error text compare their
//! status only.
//!
//! `UPDATER_APPLY_ONLY=<text>` sends only the scenarios (a `begin` marker
//! up to the next) with a request label containing `<text>`; the others'
//! world ops still run, their recorded failures unchecked.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use claudius_core::{js_string, now_ms};
use common::Server;
use serde_json::Value;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/updater_apply_golden.json");
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// `(status, content type, body)`.
fn request(port: u16, body: &[u8]) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(180))).unwrap();
    let head = format!(
        "POST /api/updater/apply HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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

/// `DDDD-DD-DDTDD:DD:DD.DDDZ` at the start of `b`.
fn is_iso(b: &[u8]) -> bool {
    const SHAPE: &[u8] = b"dddd-dd-ddTdd:dd:dd.dddZ";
    b.len() >= SHAPE.len()
        && SHAPE.iter().zip(b).all(|(want, got)| match want {
            b'd' => got.is_ascii_digit(),
            c => c == got,
        })
}

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// `s` with each whole-word `word` as `with`.
fn replace_word(s: &str, word: &str, with: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i..].starts_with(word.as_bytes())
            && (i == 0 || !is_word(b[i - 1]))
            && b.get(i + word.len()).is_none_or(|&c| !is_word(c))
        {
            out.push_str(with);
            i += word.len();
            continue;
        }
        let c = s[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
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

fn want_value(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(want_fixture(s)),
        Value::Array(a) => Value::Array(a.iter().map(want_value).collect()),
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), want_value(v))).collect())
        }
        v => v.clone(),
    }
}

fn quotes_git(v: &Value) -> bool {
    let t = js_string::stringify(v);
    [
        "fatal:",
        "error:",
        "Command failed",
        "warning:",
        "CONFLICT",
        "hint:",
    ]
    .iter()
    .any(|m| t.contains(m))
}

struct Replay {
    root: String,
    env: Vec<(String, String)>,
    real_git: String,
    same_git: bool,
    /// A real `setsid` on the base PATH: the restarts recorded with
    /// `nohup` would pick it.
    real_setsid: bool,
    /// A real `bun` on the base PATH: the missing-bun step would find it.
    real_bun: bool,
    /// In a scenario `UPDATER_APPLY_ONLY` leaves out.
    skipping: bool,
    t_start: i64,
    pid: u32,
    failures: Vec<String>,
}

const SETTINGS: &str = "home/.claude/.claudius/updater.json";
const CALLS: &str = "home/.bun/bin/calls.log";
const LOG: &str = "current/.claudius/logs/updater.log";

impl Replay {
    fn p(&self, rel: &str) -> String {
        if rel.is_empty() {
            self.root.clone()
        } else {
            format!("{}/{rel}", self.root)
        }
    }

    /// The recorder's `sub`: the root as `$ROOT`, timestamps as `$T`, ISO
    /// dates as `$ISO` (and with `pid`, the server's pid as `$PID`).
    fn norm(&self, s: &str, pid: bool) -> String {
        let s = s.replace(&self.root, "$ROOT");
        let (lo, hi) = (self.t_start - 1, now_ms() + 1);
        let b = s.as_bytes();
        let mut out = String::with_capacity(s.len());
        let mut i = 0;
        while i < b.len() {
            if b[i].is_ascii_digit() && (i == 0 || !b[i - 1].is_ascii_digit()) {
                if is_iso(&b[i..]) {
                    out.push_str("$ISO");
                    i += 24;
                    continue;
                }
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
        if pid {
            replace_word(&out, &self.pid.to_string(), "$PID")
        } else {
            out
        }
    }

    fn norm_value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.norm(s, false)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.norm_value(x)).collect()),
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, v)| (k.clone(), self.norm_value(v)))
                    .collect(),
            ),
            v => v.clone(),
        }
    }

    /// Refuse to send a request unless the install root is a clone under
    /// this test's temp dir.
    fn assert_safe(&self) {
        let ir = self.p("current");
        let real = std::fs::canonicalize(&ir).unwrap();
        assert!(
            real.starts_with(&self.root) && real != Path::new(&self.root),
            "install root {ir} resolves to {} outside {}",
            real.display(),
            self.root
        );
    }

    fn file_state(&self) -> Value {
        let p = self.p(SETTINGS);
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() => Value::String("<dir>".into()),
            Ok(_) => match std::fs::read(&p) {
                Ok(b) => Value::String(self.norm(&String::from_utf8_lossy(&b), false)),
                Err(_) => Value::Null,
            },
            Err(_) => Value::Null,
        }
    }

    /// A file's text (null when missing), then the file is gone.
    fn take(&self, rel: &str, pid: bool) -> Value {
        let p = self.p(rel);
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_file() => {
                let text = String::from_utf8_lossy(&std::fs::read(&p).unwrap()).into_owned();
                std::fs::remove_file(&p).unwrap();
                Value::String(self.norm(&text, pid))
            }
            _ => Value::Null,
        }
    }

    /// The prompts the fake CLI was sent and its last argv.
    fn take_claude(&self) -> Value {
        let raw = |rel: &str| {
            let p = self.p(rel);
            let text = std::fs::read_to_string(&p).ok()?;
            std::fs::remove_file(&p).unwrap();
            Some(text)
        };
        let (log, argv) = (raw("claude-stdin.log"), raw("claude-argv.json"));
        if log.is_none() && argv.is_none() {
            return Value::Null;
        }
        let mut prompts = vec![];
        for line in log.unwrap_or_default().lines() {
            if line.trim().is_empty() {
                continue;
            }
            let m: Value = serde_json::from_str(line).unwrap();
            if m["type"] != "user" {
                continue;
            }
            match &m["message"]["content"] {
                Value::String(c) => prompts.push(Value::String(self.norm(c, false))),
                Value::Array(blocks) => {
                    for b in blocks {
                        if b["type"] == "text" {
                            prompts
                                .push(Value::String(self.norm(b["text"].as_str().unwrap(), false)));
                        }
                    }
                }
                _ => {}
            }
        }
        let argv = argv
            .map(|a| self.norm_value(&serde_json::from_str(&a).unwrap()))
            .unwrap_or(Value::Null);
        serde_json::json!({ "prompts": prompts, "argv": argv })
    }

    fn git_out(&self, args: &[&str]) -> (bool, String) {
        let out = Command::new(&self.real_git)
            .args(args)
            .current_dir(self.p("current"))
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stderr(Stdio::null())
            .output()
            .unwrap();
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        )
    }

    /// The recorder's `treeState`.
    fn tree_state(&self) -> Value {
        if !self.git_out(&["rev-parse", "--is-inside-work-tree"]).0 {
            return Value::Null;
        }
        let parts: Vec<String> = [
            &["status", "--porcelain", "-b", "-uall"][..],
            &["stash", "list", "--format=%gd %s"],
            &["log", "--format=%h %s", "-3"],
        ]
        .iter()
        .map(|args| match self.git_out(args) {
            (true, out) => out,
            (false, _) => "<exit 1>\n".to_owned(),
        })
        .collect();
        Value::String(self.norm(&parts.join("--\n"), false))
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
                let cwd = self.p(s["cwd"].as_str().unwrap());
                // A skipped scenario's install clone isn't made (upstream's
                // commits still are).
                if self.skipping && (args[0] == "clone" || !Path::new(&cwd).is_dir()) {
                    return;
                }
                let status = Command::new(&self.real_git)
                    .args(&args)
                    .current_dir(cwd)
                    .env_clear()
                    .envs(self.env.iter().map(|(k, v)| (k, v)))
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .unwrap();
                if !self.skipping && !status.success() != (s["fails"] == true) {
                    self.fail("git", format!("{args:?} exited {status}"));
                }
            }
            "write" => {
                let path = path.unwrap();
                let _ = std::fs::create_dir_all(Path::new(&path).parent().unwrap());
                let text = js_string::lossy(s["text"].as_str().unwrap()).into_owned();
                // A clone a skipped scenario never made: nothing to write into.
                if let Err(e) = std::fs::write(&path, text)
                    && !self.skipping
                {
                    panic!("write {path}: {e}");
                }
            }
            "begin" => {}
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
                std::fs::create_dir_all(Path::new(&path).parent().unwrap()).unwrap();
                let to = s["to"].as_str().unwrap().replace("$ROOT", &self.root);
                std::os::unix::fs::symlink(to, &path).unwrap();
            }
            "chmod" => {
                use std::os::unix::fs::PermissionsExt;
                let mode = u32::from_str_radix(s["mode"].as_str().unwrap(), 8).unwrap();
                std::fs::set_permissions(path.unwrap(), std::fs::Permissions::from_mode(mode))
                    .unwrap();
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
        if *status != want_status {
            self.fail(
                label,
                format!("status {status}, want {want_status}: {body}"),
            );
            return;
        }
        if ctype.as_deref() != want["type"].as_str() {
            self.fail(
                label,
                format!("content type {ctype:?}, want {}", want["type"]),
            );
        }
        if !self.same_git && quotes_git(want) {
            return;
        }
        let got_body = self.norm(body, true);
        let want_body = want_fixture(want["body"].as_str().unwrap());
        if got_body != want_body {
            self.fail(label, format!("body\n got: {got_body}\nwant: {want_body}"));
        }
    }

    /// The state a request left, against the step's record.
    fn compare_after(&mut self, label: &str, s: &Value) {
        let got = [
            ("tree", self.tree_state()),
            ("file", self.file_state()),
            ("log", self.take(LOG, false)),
            ("restart", self.take("restart.log", true)),
            ("calls", self.take(CALLS, false)),
            ("claude", self.take_claude()),
        ];
        for (key, got) in got {
            let want = want_value(&s[key]);
            if !self.same_git && matches!(key, "file" | "log") && quotes_git(&want) {
                continue;
            }
            if key == "restart" && self.real_setsid && want.to_string().contains("nohup") {
                continue;
            }
            if got != want {
                let show = |v: &Value| match v {
                    Value::String(s) => s.clone(),
                    v => v.to_string(),
                };
                self.fail(
                    label,
                    format!("{key}\n got: {}\nwant: {}", show(&got), show(&want)),
                );
            }
        }
    }
}

fn which(path: &str, cmd: &str) -> Option<String> {
    let out = Command::new("/bin/sh")
        .args(["-c", &format!("command -v {cmd}")])
        .env_clear()
        .env("PATH", path)
        .output()
        .unwrap();
    let found = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !found.is_empty()).then_some(found)
}

fn spawn(replay: &Replay, phase: &Value, fx: &Value) -> Server {
    let port = common::free_port();
    let install_root = phase["env"]["CLAUDIUS_INSTALL_ROOT"].as_str().unwrap();
    assert!(
        install_root.starts_with("$ROOT/"),
        "the fixture's install root {install_root} isn't under the temp root"
    );
    let mut cmd = Command::new(common::server_bin());
    cmd.args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(replay.p("claude-wrap"))
        .current_dir(replay.p("servercwd"))
        .env_clear()
        .envs(replay.env.iter().map(|(k, v)| (k, v)))
        .envs(
            fx["scrub"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k, v.as_str().unwrap())),
        )
        .env("GOLDEN_FAKE_CLI", common::fake_bin())
        .env("CLAUDIUS_STATE_HOME", replay.p("home"))
        .env("CLAUDIUS_DEV", "1")
        .env("CLAUDIUS_DEV_RESTART_LOG", replay.p("restart.log"))
        .env(
            "CLAUDIUS_INSTALL_ROOT",
            install_root.replace("$ROOT", &replay.root),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Ok(t) = std::env::var("TMPDIR") {
        cmd.env("TMPDIR", t);
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
fn updater_apply_replays_the_ts_golden() {
    let fx = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let temp_dir = std::env::temp_dir().canonicalize().unwrap();
    assert!(
        Path::new(&root).starts_with(&temp_dir),
        "{root} is not under {}",
        temp_dir.display()
    );
    let strs = |k: &str| -> Vec<String> {
        fx[k]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    };
    let base = [strs("sys"), strs("abs")].concat().join(":");
    let real_git = which(&base, "git").expect("no git on the base PATH");
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
    env.push(("PATH".into(), format!("{root}/xbin:{base}")));
    env.push(("REAL_GIT".into(), real_git.clone()));
    let mut replay = Replay {
        real_setsid: which(&base, "setsid").is_some(),
        real_bun: which(&base, "bun").is_some(),
        skipping: false,
        root,
        env,
        real_git,
        same_git: fx["git"].as_str() == Some(version.as_str()),
        t_start: now_ms(),
        pid: 0,
        failures: vec![],
    };
    for d in ["home", "servercwd", "xbin"] {
        std::fs::create_dir_all(replay.p(d)).unwrap();
    }
    let only = std::env::var("UPDATER_APPLY_ONLY").ok();
    let mut requests = 0;
    for phase in fx["phases"].as_array().unwrap() {
        let name = phase["name"].as_str().unwrap();
        let steps = phase["steps"].as_array().unwrap();
        // Each step's scenario is picked when one of its requests matches.
        let mut picked = vec![true; steps.len()];
        if let Some(only) = &only {
            let mut start = 0;
            for end in 1..=steps.len() {
                if end == steps.len() || steps[end]["op"] == "begin" {
                    let hit = steps[start..end].iter().any(|s| {
                        s["label"]
                            .as_str()
                            .is_some_and(|l| l.contains(only.as_str()))
                    });
                    picked[start..end].fill(hit);
                    start = end;
                }
            }
        }
        let mut server: Option<Server> = None;
        for (s, picked) in steps.iter().zip(picked) {
            let op = s["op"].as_str().unwrap();
            replay.skipping = !picked;
            if op != "req" && op != "together" {
                replay.world_op(s);
                continue;
            }
            if !picked {
                continue;
            }
            // Started at the first request, once the fakes exist.
            let port = match &server {
                Some(server) => server.port,
                None => {
                    let started = spawn(&replay, phase, &fx);
                    replay.pid = started.child.id();
                    let port = started.port;
                    server = Some(started);
                    port
                }
            };
            let label = format!("{name}: {}", s["label"].as_str().unwrap());
            replay.assert_safe();
            if replay.real_bun && label.contains("no bun on PATH") {
                let _ = request(port, b"");
                for rel in [
                    LOG,
                    "restart.log",
                    CALLS,
                    "claude-stdin.log",
                    "claude-argv.json",
                ] {
                    let _ = std::fs::remove_file(replay.p(rel));
                }
                continue;
            }
            if op == "together" {
                let n = s["n"].as_u64().unwrap() as usize;
                let handles: Vec<_> = (0..n)
                    .map(|_| std::thread::spawn(move || request(port, b"")))
                    .collect();
                let got: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
                for (i, g) in got.iter().enumerate() {
                    replay.compare(&format!("{label} #{i}"), &s["got"][i], g);
                }
                replay.compare_after(&label, s);
                requests += n;
                continue;
            }
            let body = match (s["body"].as_str(), s["bodyHex"].as_str()) {
                (Some(b), _) => js_string::lossy(b).into_owned().into_bytes(),
                (None, Some(h)) => hex(h),
                _ => vec![],
            };
            let got = request(port, &body);
            requests += 1;
            replay.compare(&label, &s["got"], &got);
            replay.compare_after(&label, s);
        }
        drop(server);
    }
    assert!(
        requests >= 80 || only.is_some(),
        "only {requests} requests replayed"
    );
    assert!(
        replay.failures.is_empty(),
        "{} of {requests} requests differ:\n{}",
        replay.failures.len(),
        replay.failures.join("\n")
    );
}
