//! The customization preview routes (`/api/customizations/[id]/preview`
//! GET / POST / DELETE, `[id]/preview/restart` POST, and the preview stop
//! of `[id]` DELETE) against the real binary, replaying the `groups` of
//! `tests/fixtures/customization_preview_golden.json` (recorded by
//! `rust/scripts/customization-preview-golden.mjs` from the real
//! `preview-server.ts` and route handlers run inside Next's route module).
//!
//! Each group runs in a fresh world (the fixture's `world`: the fakes, the
//! live `node_modules`) with a server of its own, started with exactly the
//! env the recorder's child had: the group's `PATH` and leaked variables,
//! `HOME`, the state and config dirs, `CLAUDIUS_LIVE_SOURCE`, the fakes'
//! dirs and `CLAUDIUS_PREVIEW_PORTS` (a free 8-port block, the recorder's
//! patched `PORT_START` / `PORT_END`). `next dev` is `claudius-fake-next`
//! behind the fixture's shell wrapper, and `lsof` the fixture's fake, which
//! lists only the live pids registered for a port: nothing outside the test
//! is ever signalled, and the real 3100-3199 range is never touched.
//!
//! Every request must answer the same status, content type and body
//! ("threw" is Next's empty 500; a JSON body must also be exactly
//! `JSON.stringify` of itself), make the same `lsof` calls in the same
//! order, run the same `bun` with the same argv, cwd and env, leave the same
//! customizations tree (modes and link targets included) and kill exactly
//! the squatters the recording saw die. Every `wait` must see the fake
//! `next` launched with the same argv, cwd and env, after the same output
//! got the preview to the same state.
//!
//! The mapping, as the recorder normalized: the temp root is `$ROOT`, the
//! fake binary `$FAKE`, `resolveNodeDir`'s system fallback dir (followed by
//! `:`) `$SYSNODE:`; a whole number inside the block is `$P<k>` (k from the
//! block start) wherever it shows up; a body's `pid` is `$PID<n>` and its
//! `startedAt` `$T<n>`, numbered by first appearance within a group, and a
//! new `$T` must be a time within its own request.
//!
//! The recording has one deliberate difference ([`expected_difference`]):
//! POST and `restart` for an id whose mirror is outside the root (`../x`)
//! answer 403 here, before any `lsof`. Two more behaviors are this port's
//! own and have tests of their own: [`shutdown_ends_every_preview`] and
//! [`the_servers_own_port_is_never_offered`].
#![cfg(unix)]

mod common;

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use claudius_core::{js_string, node_fs, now_ms};
use common::{fake_bin, wait_until};
use serde_json::{Map, Value, json};

/// Ports per preview block, as recorded (`block`).
const BLOCK: u16 = 8;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/customization_preview_golden.json");
    let fx = js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(fx["block"], json!(BLOCK));
    fx
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

/// `claudius-fake-next`, built once per test binary.
fn fake_next() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let st = Command::new(cargo)
            .args([
                "build",
                "-q",
                "-p",
                "claudius-agent",
                "--bin",
                "claudius-fake-next",
            ])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .unwrap();
        assert!(st.success());
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/debug/claudius-fake-next")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    })
}

/// The recorder's `SYSNODE`: the first system dir with a `node`.
fn sys_node() -> Option<String> {
    ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        .into_iter()
        .find(|d| Path::new(d).join("node").exists())
        .map(str::to_owned)
}

fn port_free(p: u16) -> bool {
    let v6 = match TcpListener::bind(("::", p)) {
        Ok(_) => true,
        Err(e) => e.kind() != ErrorKind::AddrInUse,
    };
    v6 && TcpListener::bind(("127.0.0.1", p)).is_ok()
}

/// A start port whose block is free on `::` and 127.0.0.1, below the
/// ephemeral range and clear of the blocks other tests here hold.
fn free_block() -> u16 {
    static TAKEN: Mutex<Vec<u16>> = Mutex::new(Vec::new());
    let mut taken = TAKEN.lock().unwrap();
    let mut seed = (u64::from(std::process::id()) << 20) ^ now_ms() as u64 ^ 0x9e37_79b9;
    for _ in 0..500 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let start = 21_000 + (seed % 18_000) as u16;
        if taken.iter().any(|t| t.abs_diff(start) < BLOCK) {
            continue;
        }
        if (start..start + BLOCK).all(port_free) {
            taken.push(start);
            return start;
        }
    }
    panic!("no free port block");
}

fn alive(pid: u32) -> bool {
    let Ok(p) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(p, 0) == 0 }
}

fn sigkill(pid: u32) {
    if let Ok(p) = i32::try_from(pid) {
        // SAFETY: a pid this test started or registered and saw alive.
        unsafe { libc::kill(p, libc::SIGKILL) };
    }
}

/// `encodeURIComponent`.
fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent` of a well-formed segment.
fn decode_component(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

// ---- the world ----------------------------------------------------------------

struct World {
    _tmp: tempfile::TempDir,
    root: String,
    start: u16,
    sysnode: Option<String>,
}

impl World {
    fn new(fx: &Value, start: u16) -> World {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let w = World {
            _tmp: tmp,
            root: root.to_str().unwrap().to_owned(),
            start,
            sysnode: sys_node(),
        };
        for s in fx["world"].as_array().unwrap() {
            w.apply(s);
        }
        w
    }

    fn path(&self, rel: &str) -> PathBuf {
        Path::new(&self.root).join(rel)
    }

    /// The recorder's `real`: `$ROOT` and `$P<k>` back to this run's.
    fn real(&self, s: &str) -> String {
        let s = s.replace("$ROOT", &self.root);
        let mut out = String::new();
        let mut rest = s.as_str();
        while let Some(i) = rest.find("$P") {
            out.push_str(&rest[..i]);
            let digits: String = rest[i + 2..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if digits.is_empty() {
                out.push_str("$P");
            } else {
                out.push_str(&(self.start + digits.parse::<u16>().unwrap()).to_string());
            }
            rest = &rest[i + 2 + digits.len()..];
        }
        out.push_str(rest);
        out
    }

    /// The recorder's `normStr`: `$ROOT`, `$FAKE`, `$SYSNODE:`, then every
    /// whole number in the block as `$P<k>` (`String(Number(m)) === m`: no
    /// leading zeros).
    fn norm(&self, s: &str) -> String {
        let mut t = s.replace(&self.root, "$ROOT").replace(fake_next(), "$FAKE");
        if let Some(d) = &self.sysnode {
            t = t.replace(&format!("{d}:"), "$SYSNODE:");
        }
        let end = self.start + BLOCK - 1;
        let mut out = String::with_capacity(t.len());
        let mut chars = t.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            if !c.is_ascii_digit() {
                out.push(c);
                continue;
            }
            let mut j = i + 1;
            while let Some(&(k, d)) = chars.peek() {
                if !d.is_ascii_digit() {
                    break;
                }
                j = k + 1;
                chars.next();
            }
            let run = &t[i..j];
            let canonical = run == "0" || !run.starts_with('0');
            match run.parse::<u32>() {
                Ok(n) if canonical && (u32::from(self.start)..=u32::from(end)).contains(&n) => {
                    out.push_str(&format!("$P{}", n - u32::from(self.start)));
                }
                _ => out.push_str(run),
            }
        }
        out
    }

    /// The recorder's `applyFs`.
    fn apply(&self, s: &Value) {
        if str_of(&s["act"]) == "systool" {
            let name = str_of(&s["name"]);
            let from = ["/bin", "/usr/bin"]
                .into_iter()
                .map(|d| Path::new(d).join(name))
                .find(|p| p.exists())
                .unwrap_or_else(|| panic!("no {name}"));
            std::os::unix::fs::symlink(from, self.path("sysbin").join(name)).unwrap();
            return;
        }
        let p = self.real(str_of(&s["path"]));
        let parent = || std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
        let mode = |m: &Value| std::fs::Permissions::from_mode(m.as_u64().unwrap() as u32);
        match str_of(&s["act"]) {
            "write" => {
                parent();
                std::fs::write(&p, str_of(&s["text"])).unwrap();
                if let Some(m) = s.get("mode") {
                    std::fs::set_permissions(&p, mode(m)).unwrap();
                }
            }
            "mkdir" => std::fs::create_dir_all(&p).unwrap(),
            "rm" => node_fs::rm_recursive_force(&p).unwrap(),
            "symlink" => {
                parent();
                std::os::unix::fs::symlink(self.real(str_of(&s["target"])), &p).unwrap();
            }
            "chmod" => std::fs::set_permissions(&p, mode(&s["mode"])).unwrap(),
            other => panic!("fs act {other}"),
        }
    }

    fn customizations(&self) -> PathBuf {
        self.path("home/.claude/.claudius/customizations")
    }

    /// The recorder's `tree()`: nested names (normalized), `l>target` for a
    /// link, a file's normalized text (`x:` first when executable;
    /// `sha256:<hex>:<UTF-16 length>` past 2000 units).
    fn tree(&self, path: &Path) -> Value {
        let Ok(st) = std::fs::symlink_metadata(path) else {
            return Value::Null;
        };
        if st.file_type().is_symlink() {
            let target = std::fs::read_link(path).unwrap();
            return json!(format!("l>{}", self.norm(&target.to_string_lossy())));
        }
        if !st.is_dir() {
            let Ok(bytes) = std::fs::read(path) else {
                return json!("f!");
            };
            let text = self.norm(&String::from_utf8_lossy(&bytes));
            let mode = if st.permissions().mode() & 0o111 != 0 {
                "x:"
            } else {
                ""
            };
            let len = text.encode_utf16().count();
            return json!(if len <= 2000 {
                format!("{mode}{text}")
            } else {
                format!(
                    "{mode}sha256:{}:{len}",
                    claudius_core::asset_store::sha256_hex(text.as_bytes())
                )
            });
        }
        let Ok(rd) = std::fs::read_dir(path) else {
            return json!("d!");
        };
        let mut names: Vec<String> = rd
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let mut out = Map::new();
        for name in names {
            out.insert(self.norm(&name), self.tree(&path.join(&name)));
        }
        Value::Object(out)
    }

    fn tree_text(&self) -> String {
        js_string::stringify(&self.tree(&self.customizations()))
    }

    /// The pid files the fake `lsof` reads (not the `.exit` codes).
    fn lsof_files(&self) -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(self.path("lsof")) else {
            return Vec::new();
        };
        rd.flatten()
            .map(|e| e.path())
            .filter(|p| !p.to_string_lossy().ends_with(".exit"))
            .collect()
    }

    /// The pids in the lsof files.
    fn registered(&self) -> Vec<u32> {
        let mut pids = Vec::new();
        for f in self.lsof_files() {
            for l in std::fs::read_to_string(f).unwrap_or_default().split('\n') {
                if !l.is_empty() && l.bytes().all(|b| b.is_ascii_digit()) {
                    pids.extend(l.parse::<u32>().ok());
                }
            }
        }
        pids
    }

    /// The recorder's `prune`: dead pids out of the lsof files, so no pid
    /// left there can have been reused by the time cleanup kills it.
    fn prune(&self) {
        for f in self.lsof_files() {
            let Ok(text) = std::fs::read_to_string(&f) else {
                continue;
            };
            let mut lines: Vec<&str> = text.split('\n').collect();
            if lines.last() == Some(&"") {
                lines.pop();
            }
            let keep: Vec<&str> = lines
                .iter()
                .copied()
                .filter(|l| {
                    l.is_empty()
                        || !l.bytes().all(|b| b.is_ascii_digit())
                        || l.parse::<u32>().is_ok_and(alive)
                })
                .collect();
            if keep.len() != lines.len() {
                let body: String = keep.iter().map(|l| format!("{l}\n")).collect();
                std::fs::write(&f, body).unwrap();
            }
        }
    }
}

// ---- the server and what it leaves ----------------------------------------------

/// A `sleep 600` squatting on a port, reaped as soon as it dies (as Node
/// reaps its children), so the fake `lsof` never lists a zombie.
struct Sleeper {
    child: Arc<Mutex<Child>>,
    dead: Arc<AtomicBool>,
}

impl Sleeper {
    fn spawn() -> Sleeper {
        let child = Command::new("/bin/sleep")
            .arg("600")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let child = Arc::new(Mutex::new(child));
        let dead = Arc::new(AtomicBool::new(false));
        let (c, d) = (child.clone(), dead.clone());
        std::thread::spawn(move || {
            loop {
                if c.lock().unwrap().try_wait().unwrap().is_some() {
                    d.store(true, Ordering::SeqCst);
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        Sleeper { child, dead }
    }

    fn pid(&self) -> u32 {
        self.child.lock().unwrap().id()
    }
}

/// One server in one world, and everything it may leave running. Dropping
/// it SIGTERMs the server (which ends its previews, see
/// [`shutdown_ends_every_preview`]), SIGKILLs it if it hasn't exited in
/// 10 s, then kills the squatters, any live pid an lsof file holds (a
/// worker grandchild) and the `previews` a test noted (one that holds no
/// port is in no lsof file), and waits for them.
struct Run {
    child: Child,
    port: u16,
    sleepers: Vec<Sleeper>,
    listeners: Vec<TcpListener>,
    previews: Vec<u32>,
    w: World,
}

impl Run {
    /// `path`, `env`: the group's (`$ROOT` / `$P` mapped). `port`: where the
    /// server listens (a free one by default).
    fn spawn(w: World, path: &[String], env: &Map<String, Value>, port: Option<u16>) -> Run {
        let port = port.unwrap_or_else(common::free_port);
        let mut cmd = Command::new(common::server_bin());
        cmd.args(["--port", &port.to_string(), "--no-next", "--no-scheduler"])
            .arg("--claude-bin")
            .arg(fake_bin())
            .current_dir(w.path("project"))
            .env_clear()
            .env("PATH", path.join(":"))
            .env("HOME", w.path("home"))
            .env("CLAUDIUS_STATE_HOME", w.path("home"))
            .env("CLAUDE_CONFIG_DIR", w.path("config"))
            .env("CLAUDIUS_LIVE_SOURCE", w.path("live"))
            .env(
                "CLAUDIUS_PREVIEW_PORTS",
                format!("{}-{}", w.start, w.start + BLOCK - 1),
            )
            .env("FAKE_NEXT_BIN", fake_next())
            .env("FAKE_LSOF_DIR", w.path("lsof"))
            .env("FAKE_LOG_DIR", w.path("logs"))
            .env("TZ", "UTC")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (k, v) in env {
            cmd.env(k, w.real(str_of(v)));
        }
        let mut child = cmd.spawn().unwrap();
        wait_until("health", Duration::from_secs(30), || {
            if let Ok(Some(st)) = child.try_wait() {
                panic!("claudius exited ({st})");
            }
            TcpStream::connect(("127.0.0.1", port)).is_ok()
                && request(port, "GET", "/api/rust/health").status == 200
        });
        Run {
            child,
            port,
            sleepers: Vec::new(),
            listeners: Vec::new(),
            previews: Vec::new(),
            w,
        }
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// SIGTERM; the time it took to exit (≤ `timeout`), or `None`.
    fn stop(&mut self, timeout: Duration) -> Option<Duration> {
        let t0 = Instant::now();
        if !matches!(self.child.try_wait(), Ok(None)) {
            return Some(Duration::ZERO);
        }
        // SAFETY: our own child, not yet reaped.
        unsafe { libc::kill(self.pid() as i32, libc::SIGTERM) };
        while t0.elapsed() < timeout {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return Some(t0.elapsed());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }

    fn sleepers_alive(&self) -> Vec<bool> {
        self.sleepers
            .iter()
            .map(|s| !s.dead.load(Ordering::SeqCst))
            .collect()
    }

    fn state(&self, id: &str) -> Value {
        let path = format!("/api/customizations/{}/preview", encode_component(id));
        let got = request(self.port, "GET", &path);
        assert_eq!(got.status, 200, "GET {path}: {}", got.body);
        js_string::parse(&got.body).unwrap()
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        if self.stop(Duration::from_secs(10)).is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        for s in &self.sleepers {
            let _ = s.child.lock().unwrap().kill();
        }
        let me = std::process::id();
        let left: Vec<u32> = self
            .w
            .registered()
            .into_iter()
            .chain(self.previews.iter().copied())
            .filter(|&p| p != me && alive(p))
            .collect();
        for &p in &left {
            sigkill(p);
        }
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5)
            && (self.sleepers.iter().any(|s| !s.dead.load(Ordering::SeqCst))
                || left.iter().any(|&p| alive(p)))
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        self.listeners.clear();
    }
}

struct Got {
    status: u16,
    types: Vec<String>,
    body: String,
}

fn request(port: u16, method: &str, path: &str) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(120))).unwrap();
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    )
    .unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&out[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let types = lines
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.trim().to_owned())
        .collect();
    Got {
        status,
        types,
        body: String::from_utf8_lossy(&out[split + 4..]).into_owned(),
    }
}

// ---- the replay -----------------------------------------------------------------

/// The recorded request this port answers differently, on purpose: POST
/// and `restart` for `../x`, whose mirror `<root>/../x/src` is outside the
/// customizations root. TS stats it, and would mirror into, clean and spawn
/// in it (its restart sweeps the range first: 8 `lsof` calls); here it is
/// 403 before anything runs. GET and DELETE answer as TS does.
fn expected_difference(method: &str, id: &str) -> bool {
    method == "POST" && id == "../x"
}

/// `$PID<n>` / `$T<n>` by first appearance within a group.
#[derive(Default)]
struct Tokens {
    pids: HashMap<u64, String>,
    times: HashMap<i64, String>,
}

impl Tokens {
    /// The recorder's `normValue`: `pid`, `port` and `startedAt` only at
    /// the top level, every string normalized.
    fn value(&mut self, w: &World, v: &Value, top: bool, window: (i64, i64)) -> Value {
        match v {
            Value::Array(a) => {
                Value::Array(a.iter().map(|x| self.value(w, x, false, window)).collect())
            }
            Value::Object(m) => {
                let mut o = Map::new();
                for (k, x) in m {
                    let y = match (top, k.as_str(), x) {
                        (true, "pid", Value::Number(n)) => {
                            let pid = n.as_u64().unwrap();
                            let next = self.pids.len();
                            json!(
                                self.pids
                                    .entry(pid)
                                    .or_insert_with(|| format!("$PID{next}"))
                            )
                        }
                        (true, "port", Value::Number(n)) => json!(w.norm(&n.to_string())),
                        (true, "startedAt", Value::Number(n)) => {
                            let t = n.as_i64().unwrap();
                            let next = self.times.len();
                            json!(self.times.entry(t).or_insert_with(|| {
                                assert!(
                                    (window.0..=window.1).contains(&t),
                                    "startedAt {t} outside its request {window:?}"
                                );
                                format!("$T{next}")
                            }))
                        }
                        _ => self.value(w, x, false, window),
                    };
                    o.insert(k.clone(), y);
                }
                Value::Object(o)
            }
            Value::String(s) => json!(w.norm(s)),
            other => other.clone(),
        }
    }
}

/// The fakes' logs, read on from where the last read stopped.
#[derive(Default)]
struct Logs(HashMap<&'static str, usize>);

impl Logs {
    fn take(&mut self, w: &World, name: &'static str) -> Vec<String> {
        let text = std::fs::read_to_string(w.path("logs").join(name)).unwrap_or_default();
        let from = self.0.get(name).copied().unwrap_or(0);
        self.0.insert(name, text.len());
        text[from..]
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

/// What a group replayed: requests compared, and those that were the
/// expected difference.
struct Replayed {
    requests: usize,
    differences: usize,
}

/// The JSON array `step[key]` as text (`[]` when the step has none).
fn recorded_lines(step: &Value, key: &str) -> String {
    js_string::stringify(step.get(key).unwrap_or(&json!([])))
}

fn replay(name: &str) -> Option<Replayed> {
    let fx = fixture();
    let g = fx["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == name)
        .unwrap_or_else(|| panic!("no group {name}"));
    if fx["sysNode"].as_bool() != Some(sys_node().is_some()) {
        // `$SYSNODE` (and with it every PATH a preview gets once no `node`
        // is on PATH) would not line up with the recording's.
        eprintln!("skipped: a system node here differs from the recording's");
        return None;
    }
    let w = World::new(&fx, free_block());
    let path: Vec<String> = g["path"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| w.real(str_of(p)))
        .collect();
    let mut run = Run::spawn(w, &path, g["env"].as_object().unwrap(), None);
    let mut tokens = Tokens::default();
    let mut logs = Logs::default();
    let mut last_pid: HashMap<String, u32> = HashMap::new();
    let mut last_tree = run.w.tree_text();
    let mut last_sleepers: Vec<bool> = Vec::new();
    let mut done = Replayed {
        requests: 0,
        differences: 0,
    };
    for (i, step) in g["steps"].as_array().unwrap().iter().enumerate() {
        let op = str_of(&step["op"]);
        let ctx = format!(
            "{name} step {i} {op} {} {}",
            step["method"].as_str().unwrap_or(""),
            step["path"].as_str().or(step["id"].as_str()).unwrap_or("")
        );
        match op {
            "fs" => {
                run.w.apply(step);
                last_tree = run.w.tree_text();
                run.w.prune();
                continue;
            }
            "req" => {
                done.requests += 1;
                let (method, path) = (str_of(&step["method"]), str_of(&step["path"]));
                let id = decode_component(path.split('/').nth(3).unwrap());
                let t0 = now_ms();
                let got = request(run.port, method, path);
                let window = (t0, now_ms());
                let rec = &step["got"];
                let (lsof, bun) = (logs.take(&run.w, "lsof.log"), logs.take(&run.w, "bun.log"));
                let lines = |l: Vec<String>| {
                    js_string::stringify(&json!(
                        l.iter().map(|s| run.w.norm(s)).collect::<Vec<_>>()
                    ))
                };
                if expected_difference(method, &id) {
                    done.differences += 1;
                    assert_eq!(
                        (got.status, got.types.clone(), got.body.as_str()),
                        (
                            403,
                            vec!["application/json".to_owned()],
                            r#"{"error":"path outside allowed root"}"#
                        ),
                        "{ctx}: refused"
                    );
                    assert!(lsof.is_empty() && bun.is_empty(), "{ctx}: nothing ran");
                } else {
                    if rec.get("threw").is_some() {
                        assert_eq!(
                            (got.status, got.body.as_str(), got.types.clone()),
                            (500, "", vec![]),
                            "{ctx}: Next's empty 500"
                        );
                    } else {
                        assert_eq!(
                            u64::from(got.status),
                            rec["status"].as_u64().unwrap(),
                            "{ctx}: {}",
                            got.body
                        );
                        assert_eq!(
                            got.types,
                            vec![str_of(&rec["type"]).to_owned()],
                            "{ctx}: type"
                        );
                        let have = match js_string::parse(&got.body) {
                            Ok(v) => {
                                assert_eq!(
                                    js_string::stringify(&v),
                                    got.body,
                                    "{ctx}: JSON.stringify"
                                );
                                if let Some(pid) = v["pid"].as_u64() {
                                    last_pid.insert(id.clone(), pid as u32);
                                }
                                js_string::stringify(&tokens.value(&run.w, &v, true, window))
                            }
                            Err(_) => run.w.norm(&got.body),
                        };
                        assert_eq!(have, str_of(&rec["body"]), "{ctx}: body");
                    }
                    assert_eq!(
                        lines(lsof),
                        recorded_lines(step, "lsof"),
                        "{ctx}: lsof calls"
                    );
                    assert_eq!(lines(bun), recorded_lines(step, "bun"), "{ctx}: bun runs");
                }
            }
            "wait" => {
                let id = str_of(&step["id"]);
                let until = &step["until"];
                wait_until(&format!("{ctx} {until}"), Duration::from_secs(30), || {
                    let st = run.state(id);
                    let status = until.get("status").is_none_or(|s| st["status"] == *s);
                    let count = st["logs"].as_array().unwrap().len() as u64;
                    let logs = until
                        .get("logs")
                        .is_none_or(|n| count >= n.as_u64().unwrap());
                    status && logs
                });
                let next: Vec<Value> = logs
                    .take(&run.w, "next.log")
                    .iter()
                    .map(|l| {
                        let v = js_string::parse(l).unwrap();
                        let m: Map<String, Value> = v
                            .as_object()
                            .unwrap()
                            .iter()
                            .filter(|(k, _)| *k != "pid")
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect();
                        tokens.value(&run.w, &Value::Object(m), false, (0, 0))
                    })
                    .collect();
                assert_eq!(
                    js_string::stringify(&json!(next)),
                    recorded_lines(step, "next"),
                    "{ctx}: next dev's argv, cwd and env"
                );
            }
            "sleep" => std::thread::sleep(Duration::from_millis(step["ms"].as_u64().unwrap())),
            "squat" => {
                let s = Sleeper::spawn();
                let f = run
                    .w
                    .path("lsof")
                    .join((run.w.start + step["port"].as_u64().unwrap() as u16).to_string());
                let before = std::fs::read_to_string(&f).unwrap_or_default();
                std::fs::write(&f, format!("{before}{}\n", s.pid())).unwrap();
                run.sleepers.push(s);
            }
            "plant" => {
                let server = run.pid().to_string();
                let body: String = step["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| match str_of(l) {
                        "self" => format!("{server}\n"),
                        l => format!("{l}\n"),
                    })
                    .collect();
                let f = run
                    .w
                    .path("lsof")
                    .join((run.w.start + step["port"].as_u64().unwrap() as u16).to_string());
                std::fs::write(f, body).unwrap();
            }
            "listen" => {
                let port = run.w.start + step["port"].as_u64().unwrap() as u16;
                let l = TcpListener::bind((str_of(&step["host"]), port)).unwrap();
                run.listeners.push(l);
            }
            "unlisten" => run.listeners.clear(),
            "gone" => {
                let pid = last_pid[str_of(&step["id"])];
                wait_until(
                    &format!("{ctx}: pid {pid} gone"),
                    Duration::from_secs(10),
                    || !alive(pid),
                );
            }
            other => panic!("{ctx}: op {other}"),
        }
        // After every other step: the tree as recorded (where it changed)
        // or as it was; after a request, which squatters are still alive.
        let now = run.w.tree_text();
        let want = step
            .get("tree")
            .map_or_else(|| last_tree.clone(), js_string::stringify);
        assert_eq!(now, want, "{ctx}: the customizations tree");
        last_tree = now;
        if op == "req" {
            let want: Vec<bool> = step.get("sleepers").map_or_else(
                || last_sleepers.clone(),
                |v| {
                    v.as_array()
                        .unwrap()
                        .iter()
                        .map(|b| b.as_bool().unwrap())
                        .collect()
                },
            );
            // A killed squatter is reaped a moment after the request; one
            // that should live can't come back.
            wait_until(
                &format!("{ctx}: squatters {want:?}"),
                Duration::from_secs(3),
                || {
                    let have = run.sleepers_alive();
                    have == want || have.iter().zip(&want).any(|(h, w)| !h && *w)
                },
            );
            assert_eq!(run.sleepers_alive(), want, "{ctx}: squatters alive");
        }
        last_sleepers = run.sleepers_alive();
        run.w.prune();
    }
    Some(done)
}

#[test]
fn main_group_matches_the_ts_routes() {
    let Some(done) = replay("main") else { return };
    assert_eq!((done.requests, done.differences), (MAIN_REQUESTS, 2));
}

#[test]
fn without_node_on_path_the_system_dir_comes_first() {
    let Some(done) = replay("nonode") else { return };
    assert_eq!((done.requests, done.differences), (NONODE_REQUESTS, 0));
}

#[test]
fn an_odd_path_is_kept_as_written() {
    let Some(done) = replay("oddpath") else {
        return;
    };
    assert_eq!((done.requests, done.differences), (ODDPATH_REQUESTS, 0));
}

/// macOS only: there a listener on 127.0.0.1 alone leaves the port free to
/// the probe's dual-stack `::` bind (on Linux it doesn't).
#[cfg(target_os = "macos")]
#[test]
fn the_probe_sees_only_dual_stack_listeners() {
    let Some(done) = replay("darwin") else { return };
    assert_eq!((done.requests, done.differences), (DARWIN_REQUESTS, 0));
}

// The recorded requests per group.
const MAIN_REQUESTS: usize = 108;
const NONODE_REQUESTS: usize = 5;
const ODDPATH_REQUESTS: usize = 3;
#[cfg(target_os = "macos")]
const DARWIN_REQUESTS: usize = 6;

// ---- this port's own --------------------------------------------------------------

/// A world with the main group's `PATH` and `n` customizations `c1`…, each
/// with a mirror and the given `fake-next.json`.
fn own_run(confs: &[Value], port: impl FnOnce(u16) -> Option<u16>) -> Run {
    let fx = fixture();
    let w = World::new(&fx, free_block());
    let ids: Vec<String> = (1..=confs.len()).map(|n| format!("c{n}")).collect();
    let index = json!({
        "version": 1,
        "customizations": ids.iter().map(|id| json!({"id": id, "name": id})).collect::<Vec<_>>(),
        "publishes": [],
    });
    std::fs::create_dir_all(w.customizations()).unwrap();
    std::fs::write(
        w.customizations().join("index.json"),
        js_string::stringify(&index),
    )
    .unwrap();
    for (id, conf) in ids.iter().zip(confs) {
        let src = w.customizations().join(id).join("src");
        std::fs::create_dir_all(src.join("app")).unwrap();
        std::fs::write(src.join("app/page.tsx"), "export default 1;\n").unwrap();
        std::fs::write(src.join("fake-next.json"), js_string::stringify(conf)).unwrap();
    }
    let path = vec![w.real("$ROOT/fakebin"), w.real("$ROOT/sysbin")];
    let own = port(w.start);
    Run::spawn(w, &path, &Map::new(), own)
}

fn post(run: &Run, path: &str) -> Value {
    let got = request(run.port, "POST", path);
    assert_eq!(got.status, 200, "POST {path}: {}", got.body);
    js_string::parse(&got.body).unwrap()
}

fn wait_ready(run: &Run, id: &str) -> u32 {
    wait_until(&format!("{id} ready"), Duration::from_secs(30), || {
        run.state(id)["status"] == "ready"
    });
    run.state(id)["pid"].as_u64().unwrap() as u32
}

/// The server's SIGTERM ends every preview it started: the tracked ones,
/// one that ignores SIGTERM (SIGKILLed 3 s on), and one a restart replaced
/// but couldn't kill (it ignores SIGTERM and holds no port, so the reap's
/// `lsof` never lists it). TS SIGTERMs only the tracked ones at exit and
/// leaves the other two running.
#[test]
fn shutdown_ends_every_preview() {
    let stubborn = json!({"term": "ignore", "listen": false});
    let mut run = own_run(&[json!({}), json!({"term": "ignore"}), stubborn], |_| None);
    let mut pids = Vec::new();
    for id in ["c1", "c2", "c3"] {
        post(&run, &format!("/api/customizations/{id}/preview"));
        pids.push(wait_ready(&run, id));
    }
    run.previews.extend(&pids);
    post(&run, "/api/customizations/c3/preview/restart");
    pids.push(wait_ready(&run, "c3"));
    run.previews.push(pids[3]);
    assert_ne!(pids[2], pids[3]);
    assert!(alive(pids[2]), "the replaced c3 outlives its restart");
    let took = run.stop(Duration::from_secs(10)).expect("the server exits");
    assert!(
        took >= Duration::from_secs(3),
        "SIGKILL only after the grace: {took:?}"
    );
    for pid in pids {
        wait_until(
            &format!("preview {pid} gone"),
            Duration::from_secs(5),
            || !alive(pid),
        );
    }
}

/// The port the server listens on is never a preview's, even inside the
/// range (the front door's default 3100 is): TS's probe can't see a
/// listener on 127.0.0.1 (macOS) and would hand it out.
#[test]
fn the_servers_own_port_is_never_offered() {
    let run = own_run(&[json!({})], Some);
    assert_eq!(run.port, run.w.start);
    let st = post(&run, "/api/customizations/c1/preview");
    assert_eq!(st["port"], json!(run.w.start + 1));
    wait_ready(&run, "c1");
    let mut s = TcpStream::connect(("127.0.0.1", run.w.start + 1)).unwrap();
    write!(s, "GET / HTTP/1.0\r\n\r\n").unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert!(
        out.ends_with(&format!("fake next {}", run.w.start + 1)),
        "{out}"
    );
    // And the server still answers on its own.
    assert_eq!(request(run.port, "GET", "/api/rust/health").status, 200);
}
