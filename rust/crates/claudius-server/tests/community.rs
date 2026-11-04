//! The community routes (D24) on the real binary, replaying
//! `tests/fixtures/community_golden.json`, which
//! `rust/scripts/community-golden.mjs` recorded from the real TS routes
//! (`app/api/community/prefs`, `admin/check`, `admin/[...path]`) over node's
//! real fetch:
//!
//! - prefs: one server and the recorded GET / PUT requests and settings-file
//!   states in order; per step the status, content type and body (an empty
//!   500 where TS threw, the thrown message in the server's log) and the
//!   `home` tree.
//! - admin: a server per recorded env group: its `admin/check` answer, then
//!   each proxied request against a local raw fake of the chat server that
//!   answers the very bytes undici got: the answer, the params Next would
//!   hand the route, and every request that reached the fake (method, path,
//!   body; headers as undici sent them, minus the known differences). The
//!   default server is reached through `CLAUDIUS_DEV_FETCH_BASE`, as the
//!   recorder's fetch shim did.
//! - the client ids, `withCommunityClientParam` and the release counter (in
//!   temp git repos) against `claudius_core::community`.
//! - what these routes leave to Next: the other methods, and the catch-all
//!   paths Next redirects, refuses or rewrites.
//!
//! Nothing here leaves 127.0.0.1.
#![cfg(unix)]

mod common;

use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_core::community;
use claudius_core::tcc_protected::platform;
use common::{Server, free_port, http, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/community_golden.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

/// Bytes as undici reads header bytes: one latin1 character each.
fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| char::from(c)).collect()
}

// ---- the fake chat server -------------------------------------------------------

#[derive(Default)]
struct Fake {
    queue: VecDeque<Value>,
    log: Vec<Value>,
}

/// A raw HTTP/1.1 listener: logs each request as the recorder's fake did and
/// answers it with the next scripted response, byte for byte.
fn fake_chat_server() -> (u16, Arc<Mutex<Fake>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Mutex::new(Fake::default()));
    let st = state.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            let st = st.clone();
            std::thread::spawn(move || serve(conn, &st));
        }
    });
    (port, state)
}

fn serve(mut conn: TcpStream, st: &Mutex<Fake>) {
    conn.set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let (head_end, len) = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = latin1(&buf[..at]);
            let len = head
                .split("\r\n")
                .skip(1)
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if buf.len() >= at + 4 + len {
                break (at, len);
            }
        }
        match conn.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = latin1(&buf[..head_end]);
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap().split(' ');
    let (method, path) = (first.next().unwrap(), first.next().unwrap());
    let headers: Vec<Value> = lines
        .map(|l| {
            let (k, v) = l.split_once(':').unwrap();
            let v = v.trim();
            let v = match v.rsplit_once(':') {
                Some((host, port))
                    if k.eq_ignore_ascii_case("host")
                        && !port.is_empty()
                        && port.bytes().all(|b| b.is_ascii_digit()) =>
                {
                    format!("{host}:$PORT")
                }
                _ => v.to_owned(),
            };
            json!([k, v])
        })
        .collect();
    let body = &buf[head_end + 4..head_end + 4 + len];
    let mut entry = json!({"method": method, "path": path, "headers": headers});
    match std::str::from_utf8(body) {
        Ok(t) => entry["body"] = json!(t),
        Err(_) => entry["bodyHex"] = json!(to_hex(body)),
    }
    let next = {
        let mut st = st.lock().unwrap();
        st.log.push(entry);
        st.queue.pop_front()
    };
    let Some(next) = next else {
        return; // unscripted: hang up (the replay then sees one request too many)
    };
    if next["close"] == true {
        let _ = conn.shutdown(Shutdown::Both);
        return;
    }
    let bytes = match next["wireHex"].as_str() {
        Some(h) => hex(h),
        None => next["wire"].as_str().unwrap().as_bytes().to_vec(),
    };
    let _ = conn.write_all(&bytes);
    let _ = conn.flush();
    let _ = conn.shutdown(Shutdown::Write);
    let _ = conn.read_to_end(&mut Vec::new());
}

// ---- the fake Next ---------------------------------------------------------------

/// Answers every request `299` with `x-fake-next: 1` and logs its request
/// line.
fn fake_next() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let list = seen.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { continue };
            let list = list.clone();
            std::thread::spawn(move || {
                conn.set_read_timeout(Some(Duration::from_secs(30)))
                    .unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match conn.read(&mut chunk) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = latin1(&buf);
                list.lock()
                    .unwrap()
                    .push(head.split("\r\n").next().unwrap().to_owned());
                let _ = conn.write_all(
                    b"HTTP/1.1 299 Fake\r\nx-fake-next: 1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                );
                let _ = conn.shutdown(Shutdown::Write);
            });
        }
    });
    (port, seen)
}

// ---- the server ------------------------------------------------------------------

const PROXY_VARS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

/// Everything these routes or the outbound client read, removed before a
/// spawn sets what it means to.
const REMOVED: [&str; 15] = [
    "RUST_LOG",
    "CLAUDIUS_DEBUG_SESSIONS",
    "NODE_ENV",
    "CLAUDIUS_SCHEDULER",
    "CLAUDIUS_ACCOUNTS_DIR",
    "CLAUDIUS_DEV",
    "CLAUDIUS_DEV_FETCH_BASE",
    "NODE_USE_ENV_PROXY",
    "NO_PROXY",
    "no_proxy",
    community::CHAT_SERVER_URL_ENV,
    community::ADMIN_TOKEN_ENV,
    community::ELECTRON_ENV,
    community::RELEASE_ENV,
    "CLAUDIUS_PACKAGED",
];

/// A server with its stdout log in a file.
struct Proc {
    server: Server,
    log: PathBuf,
}

impl Proc {
    fn log(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

/// The binary under `umask 022` (as the recorder ran), with `home` as its
/// home, the release counter at the recorded value, `env` on top, outbound
/// requests to `dev_base` when given, and Next at `next` when given.
///
/// `free_port` can hand two servers starting at once the same port, and then
/// the one that lost the bind exits while the health check passes on the
/// other (whose answers are nothing like these). So each spawn proves the
/// server is its own, through a nickname only this home holds, and spawns
/// again if a stranger answered.
fn spawn(
    root: &Path,
    home: &Path,
    release: &str,
    env: &[(String, String)],
    dev_base: Option<&str>,
    next: Option<u16>,
) -> Proc {
    for _ in 0..5 {
        let proc = spawn_once(root, home, release, env, dev_base, next);
        if probe(proc.server.port, home) {
            return proc;
        }
    }
    panic!("no server of this test's own answered");
}

/// Whether `port` is the server for `home`: a nickname only this home's
/// settings file holds, read back through `GET /api/community/prefs`. The
/// file is put back as it was (missing) afterwards.
fn probe(port: u16, home: &Path) -> bool {
    static PROBES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = PROBES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nick = format!("probe-{}-{n}", std::process::id());
    let dir = home.join(".claude");
    let file = dir.join("settings.json");
    let had_dir = dir.is_dir();
    mkdirs(&dir);
    std::fs::write(&file, format!("{{\"communityNick\":\"{nick}\"}}")).unwrap();
    let got = http(port, "GET", "/api/community/prefs", "");
    std::fs::remove_file(&file).unwrap();
    if !had_dir {
        std::fs::remove_dir(&dir).unwrap();
    }
    got.0 == 200 && got.1.contains(&nick)
}

fn spawn_once(
    root: &Path,
    home: &Path,
    release: &str,
    env: &[(String, String)],
    dev_base: Option<&str>,
    next: Option<u16>,
) -> Proc {
    static SPAWNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = SPAWNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let port = free_port();
    let log = root.join(format!("server-{n}.log"));
    for d in ["config", "project"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg("umask 022 && exec \"$0\" \"$@\"")
        .arg(env!("CARGO_BIN_EXE_claudius"))
        .args(["--port", &port.to_string()]);
    match next {
        Some(up) => cmd.args(["--next", &format!("http://127.0.0.1:{up}")]),
        None => cmd.arg("--no-next"),
    };
    cmd.current_dir(root.join("project"));
    for k in REMOVED {
        cmd.env_remove(k);
    }
    cmd.env("HOME", home)
        .env("CLAUDIUS_STATE_HOME", home)
        .env("CLAUDE_CONFIG_DIR", root.join("config"))
        .env(community::RELEASE_ENV, release)
        .stdout(std::fs::File::create(&log).unwrap())
        .stderr(Stdio::null());
    // Proxies to nowhere: undici ignores them without NODE_USE_ENV_PROXY=1.
    let nowhere = format!("http://127.0.0.1:{}", free_port());
    for k in PROXY_VARS {
        cmd.env(k, &nowhere);
    }
    if let Some(base) = dev_base {
        cmd.env("CLAUDIUS_DEV", "1")
            .env("CLAUDIUS_DEV_FETCH_BASE", base);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let server = Server {
        child: cmd.spawn().unwrap(),
        port,
    };
    wait_until("health", Duration::from_secs(20), || {
        TcpStream::connect(("127.0.0.1", port)).is_ok()
            && http(port, "GET", "/api/rust/health", "").0 == 200
    });
    Proc { server, log }
}

/// An answer off the wire.
#[derive(Debug)]
struct Got {
    status: u16,
    /// `content-type`, latin1, when there is one.
    ctype: Option<String>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn request(port: u16, method: &str, path: &str, body: Option<&[u8]>) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let body = body.unwrap_or_default();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    req.extend_from_slice(body);
    s.write_all(&req).unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let at = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = latin1(&out[..at]);
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let headers: Vec<(String, String)> = head
        .split("\r\n")
        .skip(1)
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let header = |k: &str| headers.iter().find(|(h, _)| h == k).map(|(_, v)| v.clone());
    let mut body = out[at + 4..].to_vec();
    if header("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        body = dechunk(&body);
    }
    Got {
        status,
        ctype: header("content-type"),
        headers,
        body,
    }
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let at = b.windows(2).position(|w| w == b"\r\n").unwrap();
        let size =
            usize::from_str_radix(std::str::from_utf8(&b[..at]).unwrap().trim(), 16).unwrap();
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&b[at + 2..at + 2 + size]);
        b = &b[at + 2 + size + 2..];
    }
}

/// A step's request body: `bodyHex`, `body`, or none.
fn step_body(step: &Value) -> Option<Vec<u8>> {
    match (step["bodyHex"].as_str(), step["body"].as_str()) {
        (Some(h), _) => Some(hex(h)),
        (None, Some(t)) => Some(t.as_bytes().to_vec()),
        _ => None,
    }
}

/// The recorded answer `want` against `got`, after `sub` on what came back.
fn check_answer(at: &str, got: &Got, want: &Value, sub: &dyn Fn(&str) -> String) {
    if want.get("threw").is_some() {
        // Next's answer to a throw: an empty 500.
        assert_eq!(got.status, 500, "{at}: {got:?}");
        assert!(got.body.is_empty(), "{at}: {got:?}");
        return;
    }
    assert_eq!(
        u64::from(got.status),
        want["status"].as_u64().unwrap(),
        "{at}: status"
    );
    assert_eq!(
        got.ctype.as_deref().map(sub),
        want["type"].as_str().map(str::to_owned),
        "{at}: content-type"
    );
    let text = String::from_utf8(got.body.clone()).unwrap();
    assert_eq!(sub(&text), want["body"].as_str().unwrap(), "{at}: body");
}

// ---- the world on disk ------------------------------------------------------------

/// Make everything under `p` deletable again.
fn unlock(p: &Path) {
    let Ok(st) = std::fs::symlink_metadata(p) else {
        return;
    };
    if st.file_type().is_symlink() {
        return;
    }
    let mode = if st.is_dir() { 0o700 } else { 0o600 };
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
    if st.is_dir()
        && let Ok(rd) = std::fs::read_dir(p)
    {
        for e in rd.flatten() {
            unlock(&e.path());
        }
    }
}

fn chmod(p: &Path, mode: u32) {
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// `mkdir -p`, each new directory 755 (the recorder's umask, whatever this
/// process's is).
fn mkdirs(p: &Path) {
    if p.exists() {
        return;
    }
    mkdirs(p.parent().unwrap());
    std::fs::create_dir(p).unwrap();
    chmod(p, 0o755);
}

/// The recorder's `buildFiles` under `w`.
fn build(w: &Path, files: &Value) {
    let wt = w.display().to_string();
    let entries = files.as_object().unwrap();
    for (rel, spec) in entries {
        let p = w.join(rel);
        unlock(&p);
        let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
        if spec["delete"] == true {
            continue;
        }
        mkdirs(p.parent().unwrap());
        if spec["dir"] == true {
            std::fs::create_dir(&p).unwrap();
            chmod(&p, 0o755);
        } else if let Some(target) = spec["symlink"].as_str() {
            std::os::unix::fs::symlink(target.replace("$W", &wt), &p).unwrap();
        } else {
            let bytes = match spec["hex"].as_str() {
                Some(h) => hex(h),
                None => spec["text"].as_str().unwrap().as_bytes().to_vec(),
            };
            std::fs::write(&p, bytes).unwrap();
            chmod(&p, 0o644);
        }
    }
    for (rel, spec) in entries.iter().rev() {
        if let Some(m) = spec["mode"].as_str()
            && spec["delete"] != true
        {
            chmod(&w.join(rel), u32::from_str_radix(m, 8).unwrap());
        }
    }
}

/// The recorder's `tree` of `w/home`.
fn tree(w: &Path) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    walk(w, "home", &mut out);
    out
}

fn walk(w: &Path, rel: &str, out: &mut BTreeMap<String, Value>) {
    let Ok(rd) = std::fs::read_dir(w.join(rel)) else {
        return;
    };
    let mut names: Vec<String> = rd
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        let r = format!("{rel}/{name}");
        let full = w.join(&r);
        let st = std::fs::symlink_metadata(&full).unwrap();
        let m = format!("{:o}", st.permissions().mode() & 0o777);
        if st.file_type().is_symlink() {
            let to = std::fs::read_link(&full).unwrap().display().to_string();
            out.insert(
                r,
                json!({"t": "l", "to": to.replace(&w.display().to_string(), "$W")}),
            );
        } else if st.is_dir() {
            out.insert(r.clone(), json!({"t": "d", "m": m}));
            walk(w, &r, out);
        } else {
            let entry = match std::fs::read(&full) {
                Err(_) => json!({"t": "f", "m": m}),
                Ok(b) => match String::from_utf8(b) {
                    Ok(x) => json!({"t": "f", "m": m, "x": x}),
                    Err(e) => json!({"t": "f", "m": m, "h": to_hex(e.as_bytes())}),
                },
            };
            out.insert(r, entry);
        }
    }
}

fn recorded_tree(v: &Value) -> BTreeMap<String, Value> {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// The recorder's `subPrefs`: the world as `$W`, a settings temp file's
/// `.tmp-<pid>-<n>` as `.tmp-$PID-$N`.
fn sub_prefs(w: &str, s: &str) -> String {
    let s = s.replace(w, "$W");
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(at) = rest.find(".tmp-") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 5..];
        let digits = |t: &str| t.bytes().take_while(u8::is_ascii_digit).count();
        let a = digits(tail);
        let b = if tail[a..].starts_with('-') {
            digits(&tail[a + 1..])
        } else {
            0
        };
        if a > 0 && b > 0 {
            out.push_str(".tmp-$PID-$N");
            rest = &tail[a + 1 + b..];
        } else {
            out.push_str(".tmp-");
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

// ---- the replays --------------------------------------------------------------------

const PREFS_LOG: &str = "[api/community/prefs] ";

#[test]
fn prefs_replays_the_ts_golden() {
    let fx = fixture();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let w = root.join("w");
    let home = w.join("home");
    mkdirs(&home.join(".claude"));
    let wt = w.display().to_string();
    let proc = spawn(
        &root,
        &home,
        fx["release"].as_str().unwrap(),
        &[],
        None,
        None,
    );
    let port = proc.server.port;
    let mut want_tree = recorded_tree(&fx["prefsStart"]);
    assert_eq!(tree(&w), want_tree, "the start");
    let mut thrown = 0;
    for (i, step) in fx["prefs"].as_array().unwrap().iter().enumerate() {
        let at = format!(
            "prefs step {i} ({} {})",
            step["op"],
            step.get("body")
                .or(step.get("bodyHex"))
                .unwrap_or(&Value::Null)
        );
        match step["op"].as_str().unwrap() {
            "files" => build(&w, &step["files"]),
            op => {
                let got = match op {
                    "get" => request(port, "GET", "/api/community/prefs", None),
                    "put" => request(
                        port,
                        "PUT",
                        "/api/community/prefs",
                        step_body(step).as_deref(),
                    ),
                    other => panic!("{other}"),
                };
                check_answer(&at, &got, &step["got"], &|s: &str| s.to_owned());
                if let Some(message) = step["got"]["threw"].as_str() {
                    thrown += 1;
                    let mut lines = Vec::new();
                    wait_until(
                        "the thrown message in the log",
                        Duration::from_secs(10),
                        || {
                            lines = proc
                                .log()
                                .lines()
                                .filter_map(|l| {
                                    l.split_once(PREFS_LOG).map(|(_, m)| sub_prefs(&wt, m))
                                })
                                .collect();
                            lines.len() >= thrown
                        },
                    );
                    assert_eq!(lines[thrown - 1], message, "{at}: the thrown message");
                }
            }
        }
        if let Some(t) = step.get("tree") {
            want_tree = recorded_tree(t);
        }
        assert_eq!(tree(&w), want_tree, "{at}: the tree");
    }
    let logged = proc.log().matches(PREFS_LOG).count();
    assert_eq!(logged, thrown, "a log line per throw, no more");
    unlock(&w);
}

/// Request headers as compared: in order, names lowercased (hyper writes
/// every name in lower case, undici keeps the route's `X-Admin-Token` /
/// `Content-Type`), without the ones the clients differ on by design and
/// without `host` / `content-length`, which are checked on their own.
fn compared_headers(v: &Value) -> Vec<(String, String)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|h| {
            (
                h[0].as_str().unwrap().to_ascii_lowercase(),
                h[1].as_str().unwrap().to_owned(),
            )
        })
        .filter(|(k, _)| {
            !["host", "content-length"].contains(&k.as_str())
                && !KNOWN_HEADER_DIFFERENCES.iter().any(|(n, _)| n == k)
        })
        .collect()
}

/// Request headers undici and the Rust client send differently.
const KNOWN_HEADER_DIFFERENCES: &[(&str, &str)] = &[
    (
        "connection",
        "undici sends `keep-alive`; hyper sends none (HTTP/1.1 keeps the connection by default)",
    ),
    (
        "accept-encoding",
        "undici asks for `gzip, deflate` (`br, gzip, deflate` over HTTPS) and decodes; the Rust client asks for `identity` and decodes nothing",
    ),
];

fn header<'a>(entry: &'a Value, name: &str) -> Option<&'a str> {
    entry["headers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h[0].as_str().unwrap().eq_ignore_ascii_case(name))
        .map(|h| h[1].as_str().unwrap())
}

fn check_wire(at: &str, log: &[Value], recorded: &[Value], sub: &dyn Fn(&str) -> String) {
    assert_eq!(
        log.len(),
        recorded.len(),
        "{at}: requests at the chat server: {log:#?}"
    );
    for (a, r) in log.iter().zip(recorded) {
        assert_eq!(
            (
                a["method"].as_str().unwrap(),
                sub(a["path"].as_str().unwrap())
            ),
            (
                r["method"].as_str().unwrap(),
                r["path"].as_str().unwrap().to_owned()
            ),
            "{at}: request line"
        );
        assert_eq!(
            compared_headers(&a["headers"]),
            compared_headers(&r["headers"]),
            "{at}: headers"
        );
        assert_eq!(header(a, "host"), header(r, "host"), "{at}: host");
        assert_eq!(header(a, "accept-encoding"), Some("identity"), "{at}");
        let sent = a["body"]
            .as_str()
            .map(str::len)
            .or(a["bodyHex"].as_str().map(|h| h.len() / 2))
            .unwrap();
        assert_eq!(
            header(a, "content-length").map(|_| ()),
            header(r, "content-length").map(|_| ()),
            "{at}: a content-length on both or neither"
        );
        if let Some(n) = header(a, "content-length") {
            assert_eq!(n.parse::<usize>().unwrap(), sent, "{at}: content-length");
        }
        assert_eq!(
            (&a["body"], &a["bodyHex"]),
            (&r["body"], &r["bodyHex"]),
            "{at}: request body"
        );
    }
}

#[test]
fn admin_replays_the_ts_golden() {
    let fx = fixture();
    let release = fx["release"].as_str().unwrap();
    let version = format!("{}.{release}", community::package_version());
    let (fake_port, fake) = fake_chat_server();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let home = root.join("home");
    mkdirs(&home);
    for g in fx["admin"].as_array().unwrap() {
        let name = g["name"].as_str().unwrap();
        let closed = free_port();
        let fill = |s: &str| {
            s.replace("$PORT", &fake_port.to_string())
                .replace("$CLOSED", &closed.to_string())
        };
        let genv = g["env"].as_object().unwrap();
        let env: Vec<(String, String)> = genv
            .iter()
            .map(|(k, v)| (k.clone(), fill(v.as_str().unwrap())))
            .collect();
        // Unset, the URL is next.config.ts's default: sent to the fake as
        // the recorder's fetch shim did.
        let default = !genv.contains_key(community::CHAT_SERVER_URL_ENV);
        let base = format!("http://127.0.0.1:{fake_port}");
        let proc = spawn(
            &root,
            &home,
            release,
            &env,
            default.then_some(base.as_str()),
            None,
        );
        let port = proc.server.port;
        assert_eq!(
            community::configured_chat_server_url(
                genv.get(community::CHAT_SERVER_URL_ENV)
                    .map(|v| fill(v.as_str().unwrap()))
            ),
            fill(g["inlined"].as_str().unwrap()),
            "{name}: the inlined URL"
        );
        let got = request(port, "GET", "/api/community/admin/check", None);
        check_answer(&format!("{name}: check"), &got, &g["check"], &|s: &str| {
            s.to_owned()
        });

        let client = community::community_client(
            genv.get(community::ELECTRON_ENV).and_then(Value::as_str),
            platform(),
            &version,
        );
        if fx["platform"] == platform() {
            assert_eq!(
                client.replace(&version, "$VERSION"),
                g["client"],
                "{name}: client id"
            );
        }
        let encoded = community::with_client_param("", &client)
            .strip_prefix("?client=")
            .unwrap()
            .to_owned();
        let sub = |s: &str| {
            s.replace(&format!("127.0.0.1:{fake_port}"), "127.0.0.1:$PORT")
                .replace(&format!("127.0.0.1:{closed}"), "127.0.0.1:$CLOSED")
                .replace(&encoded, "$CLIENT")
                .replace(&version, "$VERSION")
        };
        for (i, step) in g["steps"].as_array().unwrap().iter().enumerate() {
            let method = step["method"].as_str().unwrap();
            let path = step["path"].as_str().unwrap();
            let at = format!("{name}: step {i} ({method} {path})");
            let params: Vec<String> = step["params"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap().to_owned())
                .collect();
            assert_eq!(
                community::catch_all_segments(path.split('?').next().unwrap()),
                Some(params),
                "{at}: Next's params"
            );
            {
                let mut f = fake.lock().unwrap();
                f.queue = step["responses"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned()
                    .collect();
                f.log.clear();
            }
            let got = request(
                port,
                method,
                &format!("/api/community/admin/{path}"),
                step_body(step).as_deref(),
            );
            check_answer(&at, &got, &step["got"], &sub);
            let recorded = step["wire"].as_array().cloned().unwrap_or_default();
            let mut log = Vec::new();
            // The fake logs a request before it answers; a hang-up's log
            // line can trail the server's answer.
            wait_until(
                &format!("{at}: the chat server's log"),
                Duration::from_secs(10),
                || {
                    log = fake.lock().unwrap().log.clone();
                    log.len() >= recorded.len()
                },
            );
            check_wire(&at, &log, &recorded, &sub);
            assert!(
                fake.lock().unwrap().queue.is_empty(),
                "{at}: responses unused"
            );
        }
        drop(proc);
    }
}

#[test]
fn client_ids_and_the_release_counter_match_ts() {
    let fx = fixture();
    let version = "9.8.7.6";
    for row in fx["clients"].as_array().unwrap() {
        let platform = row["platform"].as_str().unwrap();
        assert_eq!(
            community::community_client(row["electron"].as_str(), platform, version),
            row["client"].as_str().unwrap().replace("$VERSION", version),
            "{row}"
        );
    }
    for u in fx["clientUrls"].as_array().unwrap() {
        let web = community::community_client(None, platform(), version);
        assert_eq!(
            community::with_client_param(u["url"].as_str().unwrap(), &web),
            u["out"].as_str().unwrap().replace("$VERSION", version),
            "{u}"
        );
    }
    let git = |dir: &Path, args: &[&str]| {
        let st = Command::new("git")
            .args([
                "-c",
                "user.name=golden",
                "-c",
                "user.email=golden@example.invalid",
            ])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(st.success(), "git {args:?}");
    };
    for s in fx["releases"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let version = s["version"].as_str().unwrap();
        if s["git"] != false {
            git(dir.path(), &["init", "-q"]);
            git(
                dir.path(),
                &["commit", "-q", "--allow-empty", "-m", "golden"],
            );
            for t in s["tags"].as_array().unwrap() {
                git(dir.path(), &["tag", t.as_str().unwrap()]);
            }
        }
        assert_eq!(
            community::git_release(dir.path(), version),
            s["release"].as_str().unwrap(),
            "{}",
            s["name"]
        );
    }
}

#[test]
fn leaves_the_rest_to_next() {
    let fx = fixture();
    let (chat_port, chat) = fake_chat_server();
    let (next_port, seen) = fake_next();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let home = root.join("home");
    mkdirs(&home);
    let env = [
        (
            community::CHAT_SERVER_URL_ENV.to_owned(),
            format!("http://127.0.0.1:{chat_port}"),
        ),
        (community::ADMIN_TOKEN_ENV.to_owned(), "tok".to_owned()),
    ];
    let proc = spawn(
        &root,
        &home,
        fx["release"].as_str().unwrap(),
        &env,
        None,
        Some(next_port),
    );
    let port = proc.server.port;
    let admin = "/api/community/admin";
    let mut cases: Vec<(&str, String)> = Vec::new();
    for m in ["HEAD", "OPTIONS", "POST", "PATCH", "DELETE"] {
        cases.push((m, "/api/community/prefs".to_owned()));
    }
    for m in ["HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] {
        cases.push((m, format!("{admin}/check")));
    }
    for m in ["HEAD", "OPTIONS", "PUT", "PATCH"] {
        cases.push((m, format!("{admin}/bans")));
    }
    for rest in [
        "",
        "/",
        "/bans/",
        "/a//b",
        "/a/./b",
        "/a/../b",
        "/a/%2e%2E/b",
        "/%2E",
        "/%E0%A4%A",
        "/%",
        "/x.rsc",
        "/a%2Ersc",
        "/%5B...path%5D",
        "/a[b",
    ] {
        cases.push(("GET", format!("{admin}{rest}")));
        cases.push(("POST", format!("{admin}{rest}")));
    }
    for (method, path) in &cases {
        let before = seen.lock().unwrap().len();
        let got = request(port, method, path, None);
        assert_eq!(got.status, 299, "{method} {path}: {got:?}");
        assert!(
            got.headers.iter().any(|(k, _)| k == "x-fake-next"),
            "{method} {path}: {got:?}"
        );
        assert!(
            !got.headers.iter().any(|(k, _)| k == "allow"),
            "{method} {path}: an Allow of axum's: {got:?}"
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), before + 1, "{method} {path}");
        assert_eq!(
            seen[before],
            format!("{method} {path} HTTP/1.1"),
            "{method} {path}"
        );
    }
    assert!(
        chat.lock().unwrap().log.is_empty(),
        "nothing reached the chat server"
    );
    // The ported ones stay here.
    let got = request(port, "GET", &format!("{admin}/check"), None);
    assert_eq!(
        String::from_utf8(got.body).unwrap(),
        r#"{"configured":true}"#
    );
    assert_eq!(
        request(port, "GET", "/api/community/prefs", None).status,
        200
    );
    let n = seen.lock().unwrap().len();
    chat.lock().unwrap().queue.push_back(
        json!({"wire": "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"}),
    );
    let got = request(port, "GET", &format!("{admin}/%2e%2e%2e/a%25"), None);
    assert_eq!(
        (got.status, String::from_utf8(got.body).unwrap()),
        (200, "{}".to_owned())
    );
    assert_eq!(seen.lock().unwrap().len(), n, "proxied here, not by Next");
    let log = chat.lock().unwrap().log.clone();
    assert_eq!(log.len(), 1);
    assert!(
        log[0]["path"]
            .as_str()
            .unwrap()
            .starts_with("/admin/.../a%25?client=claudius%2F"),
        "{log:?}"
    );
}
