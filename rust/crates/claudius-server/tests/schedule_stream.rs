//! `GET /api/schedule/:id/runs/:runId/stream`, `GET
//! /api/schedule/session-loops` and `POST /api/schedule/session-loops/cancel`
//! (G07c) against the real binary, replaying
//! `fixtures/schedule_stream_golden.json` (recorded from the TS handlers by
//! `rust/scripts/schedule-stream-golden.mjs`):
//!
//! - `pure`: the `isStaleWakeup` / `scheduledLoopCancelPrompt` cases, on
//!   `session_loops::{is_stale_wakeup, cancel_prompt}`.
//! - `stream`: one server running the scheduler (`CLAUDIUS_SCHEDULER=1`, the
//!   fake CLI, the recorded jobs). The recording ran on a virtual clock; the
//!   replay sleeps each `tick` for real, so every chunk must arrive no
//!   earlier than it did there (ms since its stream opened), with the same
//!   text in the same chunks, and after each step each stream must reach
//!   what it had then (it may be further along, never off the recorded
//!   text). A recorded run id `00000000-0000-4000-8000-<n>` is the `n`th run
//!   started, wherever it shows up.
//! - `loops`: one server without the scheduler (and `CLAUDIUS_DEV=1` for
//!   `dev-reap`, the recorder's `sessionManager.remove`), with live fake-CLI
//!   sessions made over `/api/sessions` (fresh, or resuming the recorded
//!   transcripts). Each step's answer (status, content type, body; a throw is
//!   the empty 500 and its log line) and the user messages each CLI got must
//!   be the recorded ones; a listing is polled until it is (the sessions
//!   settle after the answer). `$S<n>` is the `n`th session made, `$UUID`
//!   any uuid, and `$LIVE` a `startedAt` armed during the replay (the same
//!   one each time).
//!
//! So the loops are answered here without the scheduler, and the stream with
//! it; `schedule_routes.rs` checks the stream goes to Next without it.

mod common;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use claudius_agent::js;
use claudius_core::paths::sdk_project_dir_name;
use claudius_core::session_loops::{self, LoopKind, SessionLoop};
use common::{Server, fake_bin, free_port, wait_until};
use serde_json::{Value, json};

const TZ: &str = "America/New_York";
/// The recorder's run ids: this, then the count as 12 digits.
const PLACEHOLDER: &str = "00000000-0000-4000-8000-";
/// What the cancel route logs a throw under.
const CANCEL_LOG: &str = "[api/schedule/session-loops/cancel] ";
/// How long a step may take to show what the recording had after it.
const SETTLE: Duration = Duration::from_secs(30);

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/schedule_stream_golden.json")).unwrap()
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn run_id(n: usize) -> String {
    format!("{PLACEHOLDER}{n:012}")
}

// ---- pure ---------------------------------------------------------------------

fn a_loop(kind: &str, id: &str, started_at: i64, delay_seconds: Option<f64>) -> SessionLoop {
    SessionLoop {
        kind: match kind {
            "cron" => LoopKind::Cron,
            "wakeup" => LoopKind::Wakeup,
            k => panic!("kind {k}"),
        },
        id: id.to_owned(),
        tool_use_id: "toolu_x".into(),
        cron: None,
        human_schedule: None,
        delay_seconds,
        prompt: String::new(),
        reason: None,
        recurring: false,
        durable: false,
        started_at,
        next_fire_at: None,
        noop: false,
        noop_streak: 0,
        cancelled: false,
    }
}

#[test]
fn the_loop_helpers_answer_as_the_ts_ones() {
    let fx = fixture();
    let stale = fx["pure"]["stale"].as_array().unwrap();
    for c in stale {
        let l = a_loop(
            str_of(&c["kind"]),
            "x",
            c["startedAt"].as_i64().unwrap(),
            c["delaySeconds"].as_f64(),
        );
        let now = c["now"].as_f64().unwrap();
        assert_eq!(
            session_loops::is_stale_wakeup(&l, now),
            c["stale"].as_bool().unwrap(),
            "{c}"
        );
    }
    assert!(stale.iter().any(|c| c["stale"] == true));
    assert!(stale.iter().any(|c| c["stale"] == false));
    for c in fx["pure"]["prompts"].as_array().unwrap() {
        let l = a_loop(str_of(&c["kind"]), str_of(&c["id"]), 0, None);
        assert_eq!(
            session_loops::cancel_prompt(&l),
            str_of(&c["prompt"]),
            "{c}"
        );
    }
}

// ---- HTTP ---------------------------------------------------------------------

#[derive(Debug, PartialEq)]
struct Got {
    status: u16,
    ctype: Option<String>,
    body: String,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Read into `buf` until `until` holds; false at EOF or an error.
fn fill(c: &mut TcpStream, buf: &mut Vec<u8>, until: impl Fn(&[u8]) -> bool) -> bool {
    let mut chunk = [0u8; 8192];
    while !until(buf) {
        match c.read(&mut chunk) {
            Ok(0) | Err(_) => return false,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    true
}

/// A response head: status and headers (lowercased names).
fn head_of(head: &str) -> (u16, Vec<(String, String)>) {
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    (status, headers)
}

fn request(port: u16, method: &str, url: &str, body: &[u8]) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let head = format!(
        "{method} {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let end = find(&raw, b"\r\n\r\n").unwrap();
    let (status, headers) = head_of(&String::from_utf8_lossy(&raw[..end]));
    assert!(
        !headers.iter().any(|(k, _)| k == "transfer-encoding"),
        "{headers:?}"
    );
    Got {
        status,
        ctype: headers
            .iter()
            .find(|(k, _)| k == "content-type")
            .map(|(_, v)| v.clone()),
        body: String::from_utf8(raw[end + 4..].to_vec()).unwrap(),
    }
}

fn json_of(got: &Got) -> Value {
    serde_json::from_str(&got.body).unwrap_or_else(|e| panic!("{e}: {got:?}"))
}

// ---- the world ----------------------------------------------------------------

/// A world as the recorder builds it, under a canonical temp root (so the
/// paths the server reports are the ones `$ROOT` stands for).
struct World {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    fake: PathBuf,
}

impl World {
    fn new(fx: &Value) -> World {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        // `$ROOT` is swapped textually, in JSON text too.
        assert!(
            root.to_str()
                .unwrap()
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c)),
            "root needs escaping: {}",
            root.display()
        );
        std::fs::create_dir_all(root.join("project")).unwrap();
        for d in fx["world"]["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(root.join(str_of(d))).unwrap();
        }
        let world = World {
            _tmp: tmp,
            root,
            fake: fake_bin().canonicalize().unwrap(),
        };
        for f in fx["world"]["files"].as_array().unwrap() {
            std::fs::write(world.root.join(str_of(&f[0])), world.denorm(str_of(&f[1]))).unwrap();
        }
        std::fs::write(world.root.join("script.json"), js::stringify(&fx["script"])).unwrap();
        world
    }

    fn root_text(&self) -> &str {
        self.root.to_str().unwrap()
    }

    fn denorm(&self, s: &str) -> String {
        s.replace("$ROOT", self.root_text())
    }

    fn norm(&self, s: &str) -> String {
        s.replace(self.fake.to_str().unwrap(), "$FAKE")
            .replace(self.root_text(), "$ROOT")
    }

    fn server_out(&self) -> PathBuf {
        self.root.join("server.out")
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.server_out()).unwrap_or_default()
    }

    /// `claudius --no-next` in this world, with `env` on top, logging to
    /// `server.out`.
    fn spawn(&self, env: &[(&str, &str)]) -> Server {
        let port = free_port();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_claudius"));
        cmd.args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
            .arg(&self.fake)
            .current_dir(self.root.join("project"))
            .env_remove("CLAUDIUS_DEBUG_SESSIONS")
            .env_remove("NODE_ENV")
            .env_remove("CLAUDIUS_DEV")
            .env_remove("CLAUDIUS_SCHEDULER")
            .env("RUST_LOG", "claudius=info")
            .env("HOME", self.root.join("home"))
            .env("CLAUDIUS_STATE_HOME", self.root.join("home"))
            .env("CLAUDE_CONFIG_DIR", self.root.join("config"))
            .env("TZ", TZ)
            .env("FAKE_CLAUDE_SCRIPT", self.root.join("script.json"))
            .env("FAKE_CLAUDE_ARGV", "argv.json")
            .env("FAKE_CLAUDE_LOG", "stdin.log")
            .env("FAKE_CLAUDE_EVENTS", "events.jsonl")
            .stdout(std::fs::File::create(self.server_out()).unwrap())
            .stderr(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        wait_until("health", Duration::from_secs(30), || {
            if let Ok(Some(st)) = child.try_wait() {
                panic!("claudius exited ({st})");
            }
            TcpStream::connect(("127.0.0.1", port)).is_ok()
                && request(port, "GET", "/api/rust/health", b"").status == 200
        });
        Server { child, port }
    }

    fn marks(&self, cwd: &str) -> usize {
        std::fs::read_to_string(self.root.join(cwd).join("events.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|l| *l == r#"{"mark":"gate"}"#)
            .count()
    }
}

// ---- stream -------------------------------------------------------------------

/// What a stream has shown: its head, then each chunk with when it came
/// (ms since the request), `end` once it's over.
#[derive(Default)]
struct Seen {
    status: u16,
    headers: Vec<(String, String)>,
    chunks: Vec<(String, u64)>,
    ended: bool,
}

struct Open {
    at: Instant,
    seen: Arc<Mutex<Seen>>,
    sock: TcpStream,
    _reader: JoinHandle<()>,
}

/// Read a chunked SSE response into `seen`, chunk by chunk.
fn read_sse(mut r: TcpStream, at: Instant, seen: &Mutex<Seen>) {
    let mut buf = Vec::new();
    if !fill(&mut r, &mut buf, |b| find(b, b"\r\n\r\n").is_some()) {
        return;
    }
    let end = find(&buf, b"\r\n\r\n").unwrap();
    let (status, headers) = head_of(&String::from_utf8_lossy(&buf[..end]));
    buf.drain(..end + 4);
    assert!(
        headers
            .iter()
            .any(|(k, v)| k == "transfer-encoding" && v == "chunked"),
        "{headers:?}"
    );
    {
        let mut s = seen.lock().unwrap();
        s.status = status;
        s.headers = headers;
    }
    loop {
        if !fill(&mut r, &mut buf, |b| find(b, b"\r\n").is_some()) {
            return;
        }
        let at_crlf = find(&buf, b"\r\n").unwrap();
        let size =
            usize::from_str_radix(String::from_utf8_lossy(&buf[..at_crlf]).trim(), 16).unwrap();
        buf.drain(..at_crlf + 2);
        if !fill(&mut r, &mut buf, |b| b.len() >= size + 2) {
            return;
        }
        let chunk: Vec<u8> = buf.drain(..size).collect();
        buf.drain(..2);
        let ms = at.elapsed().as_millis() as u64;
        let mut s = seen.lock().unwrap();
        if s.ended {
            return;
        }
        if size == 0 {
            s.chunks.push(("end".into(), ms));
            s.ended = true;
            return;
        }
        s.chunks.push((String::from_utf8(chunk).unwrap(), ms));
    }
}

fn open_stream(port: u16, url: &str) -> Open {
    let at = Instant::now();
    let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        sock,
        "GET {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n"
    )
    .unwrap();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let r = sock.try_clone().unwrap();
    let into = seen.clone();
    let reader = std::thread::spawn(move || read_sse(r, at, &into));
    Open {
        at,
        seen,
        sock,
        _reader: reader,
    }
}

struct StreamReplay<'a> {
    world: &'a World,
    port: u16,
    /// Real run ids, the `n`th at `n - 1`.
    runs: Vec<String>,
    streams: HashMap<String, Open>,
    pending: HashMap<String, JoinHandle<Got>>,
}

impl StreamReplay<'_> {
    fn place(&self, s: &str) -> String {
        let mut t = self.world.norm(s);
        for (i, id) in self.runs.iter().enumerate() {
            t = t.replace(id, &run_id(i + 1));
        }
        t
    }

    fn unplace(&self, s: &str) -> String {
        let mut t = s.to_owned();
        for (i, id) in self.runs.iter().enumerate() {
            t = t.replace(&run_id(i + 1), id);
        }
        t
    }

    /// `[id, status, attached ?? null]` per run of `job`.
    fn runs_of(&self, job: &str) -> (u16, Vec<Value>) {
        let got = request(self.port, "GET", &format!("/api/schedule/{job}/runs"), b"");
        let list = if got.status == 200 {
            json_of(&got)["runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    json!([
                        self.place(str_of(&r["id"])),
                        r["status"],
                        r.get("attached").cloned().unwrap_or(Value::Null)
                    ])
                })
                .collect()
        } else {
            Vec::new()
        };
        (got.status, list)
    }

    /// A stream's text so far (placeholders in), and whether it's over.
    fn text_of(&self, name: &str) -> (String, bool) {
        let s = self.streams[name].seen.lock().unwrap();
        let text: String = s
            .chunks
            .iter()
            .filter(|c| c.0 != "end")
            .map(|c| c.0.as_str())
            .collect();
        (self.place(&text), s.ended)
    }

    fn step(&mut self, step: &Value) {
        match str_of(&step["op"]) {
            "open" => {
                let run = self.unplace(str_of(&step["run"]));
                let url = format!("/api/schedule/{}/runs/{run}/stream", str_of(&step["job"]));
                let open = open_stream(self.port, &url);
                self.streams.insert(str_of(&step["name"]).to_owned(), open);
            }
            "close" => {
                let open = &self.streams[str_of(&step["name"])];
                let ms = open.at.elapsed().as_millis() as u64;
                {
                    let mut s = open.seen.lock().unwrap();
                    assert!(!s.ended, "closing an ended stream");
                    s.chunks.push(("end".into(), ms));
                    s.ended = true;
                }
                open.sock.shutdown(Shutdown::Both).unwrap();
            }
            "tick" => std::thread::sleep(Duration::from_millis(step["ms"].as_u64().unwrap())),
            "start" => {
                let (job, cwd) = (str_of(&step["job"]), str_of(&step["cwd"]));
                let n = self.world.marks(cwd) + 1;
                let (port, url) = (self.port, format!("/api/schedule/{job}/run-now"));
                self.pending.insert(
                    job.to_owned(),
                    std::thread::spawn(move || request(port, "POST", &url, b"")),
                );
                wait_until("the gate", SETTLE, || self.world.marks(cwd) >= n);
                // The run it started: the running one not seen yet.
                let mut found = None;
                wait_until("the run", SETTLE, || {
                    let got = request(self.port, "GET", &format!("/api/schedule/{job}/runs"), b"");
                    found = json_of(&got)["runs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|r| r["status"] == "running")
                        .map(|r| str_of(&r["id"]).to_owned())
                        .find(|id| !self.runs.contains(id));
                    found.is_some()
                });
                self.runs.push(found.unwrap());
            }
            "release" => {
                let (job, cwd) = (str_of(&step["job"]), str_of(&step["cwd"]));
                let gate = self.world.root.join(cwd).join("release");
                std::fs::write(&gate, "").unwrap();
                let got = self.pending.remove(job).unwrap().join().unwrap();
                std::fs::remove_file(&gate).unwrap();
                let want = &step["got"];
                assert_eq!(
                    (got.status, self.place(&got.body)),
                    (
                        want["status"].as_u64().unwrap() as u16,
                        str_of(&want["body"]).to_owned()
                    ),
                    "{step}"
                );
                assert_eq!(got.ctype.as_deref(), Some("application/json"));
            }
            "runs" => {
                let job = str_of(&step["job"]);
                let want = (
                    step["got"]["status"].as_u64().unwrap() as u16,
                    step["got"]["runs"].as_array().unwrap().clone(),
                );
                let start = Instant::now();
                loop {
                    let got = self.runs_of(job);
                    if got == want {
                        break;
                    }
                    assert!(start.elapsed() < SETTLE, "{step}: {got:?}");
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            op => panic!("op {op}"),
        }
    }

    /// Each stream reaches what it had after the step, and stays on the
    /// recorded text.
    fn reach(&self, step: &Value, finals: &HashMap<String, String>) {
        for (name, want) in step["after"].as_object().unwrap() {
            let (want_text, want_ended) = (str_of(&want["text"]), want["ended"] == true);
            let fin = &finals[name];
            let start = Instant::now();
            loop {
                let (text, ended) = self.text_of(name);
                assert!(
                    fin.starts_with(&text),
                    "{name} off the recording after {step}:\n{text}\nvs\n{fin}"
                );
                if text.starts_with(want_text) && (ended || !want_ended) {
                    break;
                }
                assert!(
                    start.elapsed() < SETTLE,
                    "{name} after {}: {text:?} ended={ended}, want {want_text:?} ended={want_ended}",
                    step["op"]
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

#[test]
fn the_run_stream_replays_the_ts_handler() {
    let fx = fixture();
    let rec = &fx["stream"];
    let world = World::new(&fx);
    let sched = world.root.join("home/.claude/claudius/schedule");
    std::fs::create_dir_all(&sched).unwrap();
    std::fs::write(
        sched.join("jobs.json"),
        world.denorm(&js::stringify_pretty(&json!({"jobs": rec["jobs"]}))) + "\n",
    )
    .unwrap();
    let server = world.spawn(&[("CLAUDIUS_SCHEDULER", "1")]);
    // Each stream's whole recorded text.
    let finals: HashMap<String, String> = rec["streams"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, s)| {
            let text = s["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c[0] != "end")
                .map(|c| str_of(&c[0]))
                .collect();
            (name.clone(), text)
        })
        .collect();
    let mut rp = StreamReplay {
        world: &world,
        port: server.port,
        runs: Vec::new(),
        streams: HashMap::new(),
        pending: HashMap::new(),
    };
    for step in rec["steps"].as_array().unwrap() {
        rp.step(step);
        rp.reach(step, &finals);
    }
    assert!(rp.pending.is_empty());
    for (name, want) in rec["streams"].as_object().unwrap() {
        let open = &rp.streams[name];
        let s = open.seen.lock().unwrap();
        assert!(s.ended, "{name}");
        assert_eq!(s.status as u64, want["status"].as_u64().unwrap(), "{name}");
        // The recorded headers; hyper adds its framing and a date.
        let mut headers: Vec<Value> = s
            .headers
            .iter()
            .filter(|(k, _)| k != "date" && k != "transfer-encoding")
            .map(|(k, v)| json!([k, v]))
            .collect();
        headers.sort_by_key(|h| h.to_string());
        assert_eq!(Value::Array(headers), want["headers"], "{name}");
        let got: Vec<(String, u64)> = s.chunks.iter().map(|(t, ms)| (rp.place(t), *ms)).collect();
        let want: Vec<(String, u64)> = want["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (str_of(&c[0]).to_owned(), c[1].as_u64().unwrap()))
            .collect();
        assert_eq!(
            got.iter().map(|c| &c.0).collect::<Vec<_>>(),
            want.iter().map(|c| &c.0).collect::<Vec<_>>(),
            "{name}"
        );
        // Never earlier than on the virtual clock.
        for (g, w) in got.iter().zip(&want) {
            assert!(
                g.1 >= w.1,
                "{name}: {:?} at {} ms, recorded at {}",
                g.0,
                g.1,
                w.1
            );
        }
    }
    drop(server);
}

// ---- loops --------------------------------------------------------------------

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn replace_bytes(hay: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < hay.len() {
        if hay[i..].starts_with(from) {
            out.extend_from_slice(to);
            i += from.len();
        } else {
            out.push(hay[i]);
            i += 1;
        }
    }
    out
}

/// `"uuid":"<36 of [0-9a-f-]>"` → `"uuid":"$UUID"`.
fn uuids_out(s: &str) -> String {
    const KEY: &str = "\"uuid\":\"";
    let mut out = String::new();
    let mut rest = s;
    while let Some(at) = rest.find(KEY) {
        out.push_str(&rest[..at + KEY.len()]);
        rest = &rest[at + KEY.len()..];
        let id = rest.as_bytes().get(..37);
        if id.is_some_and(|b| {
            b[36] == b'"' && b[..36].iter().all(|c| c.is_ascii_hexdigit() || *c == b'-')
        }) {
            out.push_str("$UUID");
            rest = &rest[36..];
        }
    }
    out.push_str(rest);
    out
}

struct LoopReplay<'a> {
    world: &'a World,
    port: u16,
    /// Session ids, the `n`th at `n - 1`, with their cwds and how many of
    /// their CLI's user messages were matched so far.
    ids: Vec<String>,
    cwds: Vec<String>,
    wired: Vec<usize>,
    /// When the replay started: a later `startedAt` is a live loop's.
    start: i64,
    live: HashMap<String, Value>,
}

impl LoopReplay<'_> {
    fn place(&self, s: &str) -> String {
        let mut t = self.world.norm(s);
        for (i, id) in self.ids.iter().enumerate() {
            t = t.replace(id, &format!("$S{}", i + 1));
        }
        t
    }

    fn unplace(&self, s: &[u8]) -> Vec<u8> {
        let mut t = replace_bytes(s, b"$ROOT", self.world.root_text().as_bytes());
        // Longest first: `$S1` is a prefix of `$S10`.
        for (i, id) in self.ids.iter().enumerate().rev() {
            t = replace_bytes(&t, format!("$S{}", i + 1).as_bytes(), id.as_bytes());
        }
        t
    }

    fn id_of(&self, s: &Value) -> String {
        String::from_utf8(self.unplace(str_of(s).as_bytes())).unwrap()
    }

    /// A listing's body as recorded: live `startedAt`s as `$LIVE` (each the
    /// same every time), ids as placeholders.
    fn listing(&mut self, body: &str) -> String {
        let mut v = js::json_parse(body).unwrap_or_else(|e| panic!("{e}: {body}"));
        let now = claudius_core::now_ms();
        for l in v["loops"].as_array_mut().unwrap() {
            let Some(at) = l["startedAt"].as_i64() else {
                continue;
            };
            if at >= self.start && at <= now {
                let key = format!("{} {}", str_of(&l["sessionId"]), str_of(&l["id"]));
                let first = self.live.entry(key).or_insert_with(|| json!(at));
                assert_eq!(*first, json!(at), "a live loop's startedAt moved: {l}");
                l["startedAt"] = json!("$LIVE");
            }
        }
        self.place(&js::stringify(&v))
    }

    fn wire(&self, i: usize) -> Vec<String> {
        let f = self.world.root.join(&self.cwds[i]).join("stdin.log");
        std::fs::read_to_string(f)
            .unwrap_or_default()
            .lines()
            .filter(|l| serde_json::from_str::<Value>(l).is_ok_and(|v| v["type"] == "user"))
            .map(|l| uuids_out(&self.place(l)))
            .collect()
    }

    fn all_idle(&self) -> bool {
        let got = request(self.port, "GET", "/api/sessions", b"");
        json_of(&got)
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["status"] == "idle")
    }

    /// The user messages each CLI got during the step, then every session
    /// idle.
    fn settle(&mut self, step: &Value) {
        for i in 0..self.ids.len() {
            let want: Vec<String> = step["wire"][format!("$S{}", i + 1)]
                .as_array()
                .map(|a| a.iter().map(|l| str_of(l).to_owned()).collect())
                .unwrap_or_default();
            let from = self.wired[i];
            wait_until("the CLI's input", SETTLE, || {
                self.wire(i).len() >= from + want.len()
            });
            let got = self.wire(i);
            assert_eq!(got[from..from + want.len()], want[..], "{step}");
            self.wired[i] += want.len();
        }
        wait_until("idle sessions", SETTLE, || self.all_idle());
    }

    fn step(&mut self, step: &Value) {
        match str_of(&step["op"]) {
            "create" => {
                let cwd = str_of(&step["cwd"]);
                let mut body = json!({"cwd": self.world.root.join(cwd)});
                if let Some(r) = step.get("resume") {
                    body["resume"] = r.clone();
                }
                let got = request(
                    self.port,
                    "POST",
                    "/api/sessions",
                    js::stringify(&body).as_bytes(),
                );
                assert_eq!(got.status, 200, "{got:?}");
                self.ids.push(str_of(&json_of(&got)["id"]).to_owned());
                self.cwds.push(cwd.to_owned());
                self.wired.push(0);
                assert_eq!(str_of(&step["session"]), format!("$S{}", self.ids.len()));
            }
            "input" => {
                let id = self.id_of(&step["session"]);
                let body = js::stringify(&json!({"text": step["text"]}));
                let got = request(
                    self.port,
                    "POST",
                    &format!("/api/sessions/{id}/input"),
                    body.as_bytes(),
                );
                assert_eq!(got.status, 200, "{got:?}");
            }
            "rename" => {
                let body =
                    json!({"sessionId": self.id_of(&step["session"]), "title": step["title"]});
                let got = request(
                    self.port,
                    "POST",
                    "/api/sessions/rename",
                    js::stringify(&body).as_bytes(),
                );
                assert_eq!(
                    (got.status, json_of(&got)),
                    (200, step["got"]["result"].clone())
                );
            }
            "reap" => {
                let id = self.id_of(&step["session"]);
                let got = request(
                    self.port,
                    "POST",
                    &format!("/api/sessions/{id}/dev-reap"),
                    b"",
                );
                assert_eq!(
                    (got.status, got.body.as_str()),
                    (200, r#"{"ok":true,"reaped":true}"#)
                );
            }
            "get" => {
                let want = &step["got"];
                let start = Instant::now();
                loop {
                    let got = request(self.port, "GET", "/api/schedule/session-loops", b"");
                    let body = self.listing(&got.body);
                    let ok = got.status as u64 == want["status"].as_u64().unwrap()
                        && got.ctype.as_deref() == want["type"].as_str()
                        && body == str_of(&want["body"]);
                    if ok {
                        break;
                    }
                    if start.elapsed() > SETTLE {
                        assert_eq!(body, str_of(&want["body"]), "{got:?}");
                        panic!("{got:?} vs {want}");
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            "cancel" => {
                let raw = match step.get("hex") {
                    Some(h) => hex(str_of(h)),
                    None => str_of(&step["body"]).as_bytes().to_vec(),
                };
                let body = self.unplace(&raw);
                let before = self.world.log();
                let got = request(
                    self.port,
                    "POST",
                    "/api/schedule/session-loops/cancel",
                    &body,
                );
                let want = &step["got"];
                if let Some(threw) = want.get("threw") {
                    // Next's empty 500, with the throw logged.
                    assert_eq!((got.status, got.body.as_str()), (500, ""), "{step}");
                    let line = format!("{CANCEL_LOG}{}", self.id_of(threw));
                    let n = before.matches(&line).count();
                    wait_until("the throw's log line", SETTLE, || {
                        self.world.log().matches(&line).count() == n + 1
                    });
                } else {
                    assert_eq!(
                        (
                            got.status as u64,
                            got.ctype.as_deref(),
                            self.place(&got.body)
                        ),
                        (
                            want["status"].as_u64().unwrap(),
                            want["type"].as_str(),
                            str_of(&want["body"]).to_owned()
                        ),
                        "{step}"
                    );
                }
            }
            op => panic!("op {op}"),
        }
        self.settle(step);
    }
}

#[test]
fn the_session_loops_replay_the_ts_handlers() {
    let fx = fixture();
    let world = World::new(&fx);
    for t in fx["loops"]["transcripts"].as_array().unwrap() {
        let cwd = world.root.join(str_of(&t["cwd"]));
        let dir = world
            .root
            .join("config/projects")
            .join(sdk_project_dir_name(cwd.to_str().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{}.jsonl", str_of(&t["id"]))),
            world.denorm(str_of(&t["text"])),
        )
        .unwrap();
    }
    // No scheduler: the loops are answered all the same.
    let server = world.spawn(&[("CLAUDIUS_DEV", "1")]);
    let mut rp = LoopReplay {
        world: &world,
        port: server.port,
        ids: Vec::new(),
        cwds: Vec::new(),
        wired: Vec::new(),
        start: claudius_core::now_ms(),
        live: HashMap::new(),
    };
    let steps = fx["loops"]["steps"].as_array().unwrap();
    for step in steps {
        rp.step(step);
    }
    // Nothing more reached a CLI.
    for i in 0..rp.ids.len() {
        assert_eq!(rp.wire(i).len(), rp.wired[i], "$S{}", i + 1);
    }
    assert!(!rp.live.is_empty());
    assert!(!world.log().contains("[scheduler]"), "{}", world.log());
    drop(server);
}
