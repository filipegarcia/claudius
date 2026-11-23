//! Helpers for tests that drive the real `claudius` binary over plain TCP.
//!
//! The transport lives here, so every test binary gets the same fixes
//! (I24): a request goes out in one write, a reset that only stands in for
//! the end of a complete response is that end, and a server is started on a
//! port no leaked listener holds.
#![allow(dead_code)] // each test binary uses a different subset

#[path = "../../../claudius-agent/tests/support/test_bins.rs"]
mod test_bins;

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// The fake CLI: built once per test process (I24) and spawned from a copy
/// no `cargo build` replaces (I35); see `claudius-agent/tests/support`.
pub fn fake_bin() -> PathBuf {
    test_bins::fake_claude()
}

/// The `claudius` binary to spawn: a copy no `cargo build` replaces (I36).
pub fn server_bin() -> PathBuf {
    test_bins::private_copy(env!("CARGO_BIN_EXE_claudius"))
}

/// A port for a server to bind next: the kernel's pick for a listener that
/// is closed again, unless something still listens on it then.
///
/// macOS has no `SOCK_CLOEXEC`: std marks a new socket close-on-exec with a
/// second call, so a child another test thread spawns in between inherits
/// the listener, and it outlives this drop in that child. A server started
/// on the port can't bind it and exits, while connects to it still succeed
/// (the kernel queues them on the inherited listener) and hang until the
/// child exits and resets them: the `ConnectionReset` health checks of I24.
pub fn free_port() -> u16 {
    loop {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        if TcpStream::connect(("127.0.0.1", port)).is_err() {
            return port;
        }
    }
}

/// What follows a [`request`]'s head.
#[derive(Debug, Clone, Copy)]
pub enum Payload<'a> {
    /// No body, and no body headers.
    None,
    /// `Content-Type: application/json` and `Content-Length`, then the bytes.
    Json(&'a [u8]),
    /// `Content-Length` only, then the bytes.
    Bytes(&'a [u8]),
}

/// The bytes of a `Connection: close` request.
pub fn request_bytes(method: &str, path: &str, payload: Payload) -> Vec<u8> {
    let (headers, body) = match payload {
        Payload::None => (String::new(), &[][..]),
        Payload::Json(b) => (
            format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                b.len()
            ),
            b,
        ),
        Payload::Bytes(b) => (format!("Content-Length: {}\r\n", b.len()), b),
    };
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{headers}Connection: close\r\n\r\n"
    )
    .into_bytes();
    req.extend_from_slice(body);
    req
}

/// A response read to the server's close.
#[derive(Debug)]
pub struct Response {
    /// 0 when there is no status line.
    pub status: u16,
    /// The status line and headers, without the blank line.
    pub head: String,
    /// Everything after the blank line, as sent (a chunked body undecoded).
    pub body: Vec<u8>,
}

impl Response {
    pub fn parse(raw: Vec<u8>) -> Response {
        let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
            return Response {
                status: 0,
                head: String::from_utf8_lossy(&raw).into_owned(),
                body: Vec::new(),
            };
        };
        let head = String::from_utf8_lossy(&raw[..end]).into_owned();
        let status = head
            .split(' ')
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        Response {
            status,
            head,
            body: raw[end + 4..].to_vec(),
        }
    }

    /// A header's value (the first, trimmed), by case-insensitive name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.head.split("\r\n").skip(1).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim())
        })
    }

    pub fn content_type(&self) -> Option<String> {
        self.header("content-type").map(str::to_owned)
    }

    /// `(status, content type, body)`.
    pub fn parts(&self) -> (u16, Option<String>, String) {
        (self.status, self.content_type(), self.text())
    }

    /// The body as UTF-8.
    pub fn text(&self) -> String {
        String::from_utf8(self.body.clone())
            .unwrap_or_else(|e| panic!("not UTF-8: {e}\n{}", self.head))
    }

    /// Whether the body is all there: as long as `Content-Length` says, or
    /// a chunked body through its last chunk. One that ends with the
    /// connection can't tell.
    pub fn complete(&self) -> bool {
        if self.status == 0 {
            return false;
        }
        if self
            .header("transfer-encoding")
            .is_some_and(|t| t.eq_ignore_ascii_case("chunked"))
        {
            return chunked_end(&self.body);
        }
        self.header("content-length")
            .and_then(|n| n.parse::<usize>().ok())
            .is_some_and(|n| self.body.len() >= n)
    }
}

/// Whether `body` (chunked, undecoded) runs through its last chunk.
fn chunked_end(mut body: &[u8]) -> bool {
    loop {
        let Some(line) = body.windows(2).position(|w| w == b"\r\n") else {
            return false;
        };
        let size = std::str::from_utf8(&body[..line])
            .ok()
            .and_then(|l| usize::from_str_radix(l.split(';').next()?.trim(), 16).ok());
        let Some(size) = size else {
            return false;
        };
        if size == 0 {
            return body[line + 2..].windows(2).any(|w| w == b"\r\n");
        }
        let Some(rest) = body.get(line + 2 + size + 2..) else {
            return false;
        };
        body = rest;
    }
}

/// Read a response off `s` to the server's close. A reset after the whole
/// response is that close: a server that closes with request bytes still
/// unread gets the kernel to answer them with RST, and macOS then hands the
/// reader `ECONNRESET` once the response is read, not EOF. A reset before
/// that is a failure.
pub fn read_response(s: &mut TcpStream) -> Response {
    let mut raw = Vec::new();
    let res = s.read_to_end(&mut raw);
    let resp = Response::parse(raw);
    match res {
        Ok(_) => resp,
        Err(e) if e.kind() == ErrorKind::ConnectionReset && resp.complete() => resp,
        Err(e) => panic!(
            "{e} reading {:?}: {}\n{}",
            s.peer_addr(),
            resp.head,
            String::from_utf8_lossy(&resp.body)
        ),
    }
}

/// Send `raw` on a new connection, in one write, and read the response.
pub fn exchange(port: u16, raw: &[u8]) -> Response {
    let mut s = TcpStream::connect(("127.0.0.1", port))
        .unwrap_or_else(|e| panic!("connect to port {port}: {e}"));
    s.write_all(raw)
        .unwrap_or_else(|e| panic!("send to port {port}: {e}"));
    read_response(&mut s)
}

/// One `Connection: close` request → its response.
pub fn send(port: u16, method: &str, path: &str, payload: Payload) -> Response {
    exchange(port, &request_bytes(method, path, payload))
}

/// `(status, content type, body)` of a request with exactly `body` (and
/// its JSON headers), or with no body at all (`None`: not even a
/// `Content-Length`).
pub fn request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> (u16, Option<String>, String) {
    send(
        port,
        method,
        path,
        body.map_or(Payload::None, Payload::Json),
    )
    .parts()
}

/// Minimal blocking HTTP/1.1 request (always a JSON `Content-Type` and a
/// `Content-Length`) → (status, body).
pub fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let r = send(port, method, path, Payload::Json(body.as_bytes()));
    (r.status, r.text())
}

/// Whether `/api/rust/health` answers 200 on `port` now. Any I/O error (a
/// server still starting, a read that takes over 5 s) is a no.
pub fn healthy(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let mut out = Vec::new();
    s.set_read_timeout(Some(Duration::from_secs(5)))
        .and_then(|()| {
            s.write_all(
                b"GET /api/rust/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            )
        })
        .and_then(|()| s.read_to_end(&mut out))
        .is_ok()
        && out.starts_with(b"HTTP/1.1 200 ")
}

/// A child's stderr, read as it comes and to its end (kept only while
/// [`Stderr`] lives), so the server never blocks on a full pipe or writes
/// to a closed one.
struct Stderr(
    std::sync::mpsc::Receiver<Vec<u8>>,
    std::cell::RefCell<Vec<u8>>,
);

impl Stderr {
    fn drain(child: &mut Child) -> Option<Stderr> {
        let mut pipe = child.stderr.take()?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n @ 1..) = pipe.read(&mut buf) {
                let _ = tx.send(buf[..n].to_vec());
            }
        });
        Some(Stderr(rx, Default::default()))
    }

    /// What it printed so far, waiting up to 1 s for more (a process that
    /// just exited).
    fn text(&self) -> String {
        let mut got = self.1.borrow_mut();
        while let Ok(chunk) = self.0.recv_timeout(Duration::from_secs(1)) {
            got.extend_from_slice(&chunk);
        }
        String::from_utf8_lossy(&got).into_owned()
    }
}

/// Wait (≤ `timeout`) until the server `child` started on `port` is
/// healthy. Panics if it exits first (a lost bind), with what it printed on
/// a stderr or stdout that is a pipe here; a piped stderr is read from now
/// on.
pub fn wait_healthy(child: &mut Child, port: u16, timeout: Duration) {
    let stderr = Stderr::drain(child);
    wait_until("health", timeout, || {
        if let Ok(Some(st)) = child.try_wait() {
            let mut out = stderr.as_ref().map(Stderr::text).unwrap_or_default();
            if let Some(mut o) = child.stdout.take() {
                let _ = o.read_to_string(&mut out);
            }
            panic!("claudius exited ({st}) before it was healthy:\n{out}");
        }
        healthy(port)
    });
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
/// The scheduler is on by default (G07d), so it boots on the world's store
/// (no `jobs.json`: nothing armed, nothing written).
pub struct Server {
    pub child: Child,
    pub port: u16,
}

impl Server {
    pub fn spawn(world: &World, env: &[(&str, &str)]) -> Server {
        Server::spawn_with(world, &fake_bin(), env)
    }

    /// `claudius` with a `claude` that doesn't exist: sessions are created,
    /// but their CLI never starts, so they have no query.
    pub fn spawn_without_cli(world: &World) -> Server {
        Server::spawn_with(world, &world.root.path().join("no-such-claude"), &[])
    }

    /// [`Server::spawn`] with `claude_bin` as the CLI. What it prints on
    /// stderr is shown if it exits before it is healthy (a lost bind).
    pub fn spawn_with(world: &World, claude_bin: &Path, env: &[(&str, &str)]) -> Server {
        Server::spawn_args(world, claude_bin, &[], env)
    }

    /// [`Server::spawn_with`] with `args` after the usual ones (so e.g.
    /// `--next URL` overrides `--no-next`).
    pub fn spawn_args(
        world: &World,
        claude_bin: &Path,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> Server {
        let port = free_port();
        let mut cmd = Command::new(server_bin());
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
            .arg(claude_bin)
            .args(args)
            .current_dir(&world.project)
            .env_remove("RUST_LOG")
            .env_remove("CLAUDIUS_DEBUG_SESSIONS")
            .env_remove("NODE_ENV")
            .env_remove("CLAUDIUS_DEV")
            .env_remove("CLAUDIUS_SCHEDULER")
            .env("CLAUDIUS_STATE_HOME", &world.home)
            .env("CLAUDE_CONFIG_DIR", &world.config)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut server = Server {
            child: cmd.spawn().unwrap(),
            port,
        };
        wait_healthy(&mut server.child, port, Duration::from_secs(20));
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
