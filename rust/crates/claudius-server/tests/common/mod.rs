//! Helpers for tests that drive the real `claudius` binary over plain TCP.
#![allow(dead_code)] // each test binary uses a different subset

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

pub fn fake_bin() -> PathBuf {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let st = Command::new(cargo)
        .args([
            "build",
            "-q",
            "-p",
            "claudius-agent",
            "--bin",
            "claudius-fake-claude",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .unwrap();
    assert!(st.success());
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/claudius-fake-claude")
}

pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Minimal blocking HTTP/1.1 request → (status, body).
pub fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status = out
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = out
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_owned())
        .unwrap_or_default();
    (status, body)
}

pub fn wait_until(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < timeout, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Read an open stream (see [`Server::open_stream`]) until `needle` shows
/// up; everything read so far.
pub fn read_until(sse: &mut TcpStream, needle: &str, timeout: Duration) -> String {
    read_until_nudging(sse, needle, timeout, || {})
}

/// [`read_until`], calling `nudge` about once a second while it waits (e.g.
/// to touch a file again until a watcher that is still starting sees it).
pub fn read_until_nudging(
    sse: &mut TcpStream,
    needle: &str,
    timeout: Duration,
    mut nudge: impl FnMut(),
) -> String {
    sse.set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut nudged = Instant::now();
    let start = Instant::now();
    let mut seen = Vec::new();
    let mut buf = [0u8; 8192];
    while !String::from_utf8_lossy(&seen).contains(needle) {
        assert!(
            start.elapsed() < timeout,
            "no {needle} on the stream:\n{}",
            String::from_utf8_lossy(&seen)
        );
        if nudged.elapsed() >= Duration::from_secs(1) {
            nudge();
            nudged = Instant::now();
        }
        match sse.read(&mut buf) {
            Ok(0) => panic!("stream closed:\n{}", String::from_utf8_lossy(&seen)),
            Ok(n) => seen.extend_from_slice(&buf[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => panic!("{e}"),
        }
    }
    String::from_utf8_lossy(&seen).into_owned()
}

pub fn process_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

pub fn read_pid(p: &Path) -> Option<u32> {
    std::fs::read_to_string(p).ok()?.trim().parse().ok()
}

/// An isolated world: state home, CLI config dir and a project dir (the
/// server's cwd, hence a trusted root).
pub struct World {
    pub root: tempfile::TempDir,
    pub home: PathBuf,
    pub config: PathBuf,
    pub project: PathBuf,
}

impl World {
    pub fn new() -> World {
        let root = tempfile::tempdir().unwrap();
        let (home, config, project) = (
            root.path().join("home"),
            root.path().join("config"),
            root.path().join("project"),
        );
        for d in [&home, &config, &project] {
            std::fs::create_dir_all(d).unwrap();
        }
        let project = project.canonicalize().unwrap();
        World {
            root,
            home,
            config,
            project,
        }
    }
}

/// The `claudius` binary on a free port with the fake CLI (`--no-next`).
/// `RUST_LOG`, `CLAUDIUS_DEBUG_SESSIONS`, `NODE_ENV`, `CLAUDIUS_DEV` and
/// `CLAUDIUS_SCHEDULER` are removed unless given in `env`, and so is a parent
/// Claude session's environment (`CLAUDE_*`, `CLAUDECODE`, `__NEXT_PRIVATE_*`,
/// `CLAUDIUS_PACKAGED`, `CLAUDIUS_ELECTRON`, as `rust/scripts/clean-env.sh`
/// strips it), so the CLI env a test sees doesn't depend on where it runs.
pub struct Server {
    pub child: Child,
    pub port: u16,
}

impl Server {
    pub fn spawn(world: &World, env: &[(&str, &str)]) -> Server {
        let port = free_port();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_claudius"));
        for (k, _) in std::env::vars_os() {
            let k = k.to_string_lossy();
            if k.starts_with("CLAUDE_")
                || k == "CLAUDECODE"
                || k.starts_with("__NEXT_PRIVATE_")
                || k == "CLAUDIUS_PACKAGED"
                || k == "CLAUDIUS_ELECTRON"
            {
                cmd.env_remove(&*k);
            }
        }
        cmd.args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
            .arg(fake_bin())
            .current_dir(&world.project)
            .env_remove("RUST_LOG")
            .env_remove("CLAUDIUS_DEBUG_SESSIONS")
            .env_remove("NODE_ENV")
            .env_remove("CLAUDIUS_DEV")
            .env_remove("CLAUDIUS_SCHEDULER")
            .env("CLAUDIUS_STATE_HOME", &world.home)
            .env("CLAUDE_CONFIG_DIR", &world.config)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let child = cmd.spawn().unwrap();
        let server = Server { child, port };
        wait_until("health", Duration::from_secs(20), || {
            TcpStream::connect(("127.0.0.1", port)).is_ok()
                && http(port, "GET", "/api/rust/health", "").0 == 200
        });
        server
    }

    /// POST /api/sessions in the world's project → session id.
    pub fn create_session(&self, world: &World) -> String {
        let (st, body) = http(
            self.port,
            "POST",
            "/api/sessions",
            &format!(r#"{{"cwd":{:?}}}"#, world.project.display().to_string()),
        );
        assert_eq!(st, 200, "{body}");
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// Open the session's SSE stream and wait for its 200 header; the stream
    /// stays open until the returned socket is dropped.
    pub fn open_stream(&self, id: &str) -> TcpStream {
        let mut sse = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        write!(
            sse,
            "GET /api/sessions/{id}/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
        )
        .unwrap();
        let mut first = [0u8; 64];
        let n = sse.read(&mut first).unwrap();
        assert!(String::from_utf8_lossy(&first[..n]).starts_with("HTTP/1.1 200"));
        sse
    }

    /// SIGTERM, wait for exit (≤ `timeout`), and return status + stdout log.
    pub fn stop(mut self, timeout: Duration) -> (ExitStatus, String, Duration) {
        let t0 = Instant::now();
        assert!(
            Command::new("kill")
                .args(["-TERM", &self.child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let mut status = None;
        wait_until("server exit", timeout, || {
            status = self.child.try_wait().unwrap();
            status.is_some()
        });
        let took = t0.elapsed();
        let mut log = String::new();
        self.child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        (status.unwrap(), log, took)
    }
}

/// A server that outlives its test would keep running with its CLIs (the
/// test binary exits, it doesn't): SIGTERM so it ends its sessions, then
/// SIGKILL if it hasn't exited within 3 s, and reap it.
impl Drop for Server {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(None)) {
            return;
        }
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .stderr(Stdio::null())
            .status();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
