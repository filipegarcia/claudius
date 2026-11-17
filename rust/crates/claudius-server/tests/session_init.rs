//! The live-`system/init` hooks on the real binary (S28a, S28b), replayed
//! from `rust/scripts/session-init-golden.mjs` (the real TS Session, session
//! manager and dev-broadcast route against the fake CLI).
//!
//! `broadcast` cases: an init sent through `dev-broadcast` runs TS
//! `broadcast()`'s init hooks, as one from the CLI does. Once per session the
//! MCP needs-auth / disconnected notices, on every one the advisor check
//! against its model and the effort refresh. Each step compares the route's
//! answer, the events a subscriber that was already open gets (the init
//! first, then the async ones in any order), the control requests the session
//! sent (in any order) and settings.json afterwards.
//!
//! `consume` case: the CLI's own init with a fable model, and its
//! `apply_flag_settings` reply 1.5 s late. The CLI's next messages reach
//! subscribers before `advisor_disabled_on_model_change` does.
#![cfg(unix)]

mod common;

use std::io::Read;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::{Server, World, http, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/session_init_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The control requests in `cwd/control.log` (each `request`). The CLI may
/// be mid-write: an incomplete last line isn't one yet.
fn wire(cwd: &Path) -> Vec<Value> {
    std::fs::read_to_string(cwd.join("control.log"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|m| m["type"] == "control_request")
        .map(|m| m["request"].clone())
        .collect()
}

fn sorted(v: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = v.iter().map(Value::to_string).collect();
    out.sort();
    out
}

/// An open SSE stream, read as `data:` events.
struct Sse {
    sock: TcpStream,
    raw: Vec<u8>,
    taken: usize,
}

impl Sse {
    fn open(server: &Server, id: &str) -> Sse {
        let sock = server.open_stream(id);
        sock.set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        Sse {
            sock,
            raw: Vec::new(),
            taken: 0,
        }
    }

    fn pump(&mut self) -> bool {
        let mut buf = [0u8; 16384];
        match self.sock.read(&mut buf) {
            Ok(0) => panic!("stream closed"),
            Ok(n) => {
                self.raw.extend_from_slice(&buf[..n]);
                true
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                false
            }
            Err(e) => panic!("{e}"),
        }
    }

    /// Every complete event read so far that wasn't taken yet.
    fn take(&mut self) -> Vec<Value> {
        let text = String::from_utf8_lossy(&self.raw).into_owned();
        let mut out = Vec::new();
        let mut pos = self.taken;
        while let Some(at) = text[pos..].find("data: ") {
            let start = pos + at + "data: ".len();
            let Some(end) = text[start..].find('\n') else {
                break;
            };
            out.push(serde_json::from_str(&text[start..start + end]).unwrap());
            pos = start + end;
        }
        self.taken = pos;
        out
    }

    /// Events until nothing new arrived for `quiet` (at most `max`), and at
    /// least until `want` of them came.
    fn until_quiet(&mut self, want: usize, quiet: Duration, max: Duration) -> Vec<Value> {
        let (start, mut last) = (Instant::now(), Instant::now());
        let mut got = Vec::new();
        while start.elapsed() < max {
            if self.pump() {
                last = Instant::now();
            }
            got.extend(self.take());
            if got.len() >= want && last.elapsed() >= quiet {
                break;
            }
        }
        got
    }
}

/// An event as the fixture records it: an `sdk` event without its `at`.
fn pick(e: &Value) -> Value {
    if e["type"] == "sdk" {
        json!({"type": "sdk", "message": e["message"]})
    } else {
        e.clone()
    }
}

/// What `$ROOT` and `$ID` stand for in this run.
struct Norm {
    root: String,
}

impl Norm {
    fn apply(&self, v: &Value, id: &str) -> Value {
        serde_json::from_str(
            &v.to_string()
                .replace(&self.root, "$ROOT")
                .replace(id, "$ID"),
        )
        .unwrap()
    }
}

fn run_broadcast(server: &Server, norm: &Norm, case: &Value, cwd: &Path) {
    let name = case["name"].as_str().unwrap();
    let (st, body) = http(
        server.port,
        "POST",
        "/api/sessions",
        &json!({"cwd": cwd.display().to_string()}).to_string(),
    );
    assert_eq!(st, 200, "{name}: {body}");
    let id = serde_json::from_str::<Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_until("initialize", Duration::from_secs(10), || {
        wire(cwd).iter().any(|r| r["subtype"] == "initialize")
    });
    let mut sse = Sse::open(server, &id);
    // What subscribe replays and re-emits.
    sse.until_quiet(1, Duration::from_millis(400), Duration::from_secs(5));
    let mut offset = wire(cwd).len();
    for (n, step) in case["steps"].as_array().unwrap().iter().enumerate() {
        let what = format!("{name} / step {n}");
        let (st, body) = http(
            server.port,
            "POST",
            &format!("/api/sessions/{id}/dev-broadcast"),
            &json!({"event": step["event"]}).to_string(),
        );
        assert_eq!(st as u64, step["status"].as_u64().unwrap(), "{what}");
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(norm.apply(&body, &id), step["body"], "{what}: route answer");
        let want = step["events"].as_array().unwrap();
        let got: Vec<Value> = sse
            .until_quiet(
                want.len(),
                Duration::from_millis(400),
                Duration::from_secs(8),
            )
            .iter()
            .map(|e| norm.apply(&pick(e), &id))
            .collect();
        assert_eq!(got.first(), want.first(), "{what}: the broadcast first");
        assert_eq!(sorted(&got), sorted(want), "{what}: events");
        let all = wire(cwd);
        assert_eq!(
            sorted(&all[offset..]),
            sorted(step["wire"].as_array().unwrap()),
            "{what}: control requests"
        );
        offset = all.len();
    }
    drop(sse);
    http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/dev-reap"),
        "",
    );
}

fn run_consume(server: &Server, case: &Value, cwd: &Path) {
    let name = case["name"].as_str().unwrap();
    let (st, body) = http(
        server.port,
        "POST",
        "/api/sessions",
        &json!({"cwd": cwd.display().to_string()}).to_string(),
    );
    assert_eq!(st, 200, "{name}: {body}");
    let id = serde_json::from_str::<Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut sse = Sse::open(server, &id);
    let mut events = Vec::new();
    let start = Instant::now();
    while !events
        .iter()
        .any(|e: &Value| e["type"] == "advisor_disabled_on_model_change")
    {
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "{name}: no notice: {events:?}"
        );
        sse.pump();
        events.extend(sse.take());
    }
    events.extend(sse.until_quiet(0, Duration::from_millis(400), Duration::from_secs(5)));
    let order: Vec<Value> = events
        .iter()
        .filter_map(|e| {
            if e["type"] == "sdk" && e["message"]["type"] == "system" {
                Some(json!(format!(
                    "sdk:{}",
                    e["message"]["subtype"].as_str().unwrap_or("")
                )))
            } else if e["type"] == "advisor_disabled_on_model_change" {
                Some(e["type"].clone())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(&Value::Array(order), &case["order"], "{name}: order");
    let notice = events
        .iter()
        .find(|e| e["type"] == "advisor_disabled_on_model_change")
        .unwrap();
    assert_eq!(notice, &case["notice"], "{name}");
    let not_init = |v: &[Value]| -> Vec<Value> {
        v.iter()
            .filter(|r| r["subtype"] != "initialize")
            .cloned()
            .collect()
    };
    assert_eq!(
        sorted(&not_init(&wire(cwd))),
        sorted(&not_init(case["wire"].as_array().unwrap())),
        "{name}: control requests"
    );
    drop(sse);
    http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/dev-reap"),
        "",
    );
}

#[test]
fn live_init_hooks_match_the_ts() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    let world = World::new();
    let root: PathBuf = world.root.path().canonicalize().unwrap();
    let norm = Norm {
        root: root.display().to_string(),
    };
    let cwd = |i: usize| root.join("cases").join(i.to_string());
    // Each case's dir is a registered workspace, so a trusted cwd.
    let workspaces: Vec<Value> = (0..cases.len())
        .map(|i| {
            std::fs::create_dir_all(cwd(i)).unwrap();
            json!({
                "id": format!("wks_case{i}"),
                "name": format!("case {i}"),
                "rootPath": cwd(i).display().to_string(),
                "icon": {"kind": "letter", "letter": "C", "color": "#d97757"},
                "createdAt": 1767225600000_i64,
                "updatedAt": 1767225600000_i64,
            })
        })
        .collect();
    let state = world.home.join(".claude/.claudius");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(
        state.join("workspaces.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({"version": 1, "workspaces": workspaces})).unwrap()
        ),
    )
    .unwrap();
    let settings = world.home.join(".claude/settings.json");
    let server = Server::spawn(
        &world,
        &[
            ("FAKE_CLAUDE_SCRIPT", "fake-script.json"),
            ("FAKE_CLAUDE_CONTROL_LOG", "control.log"),
        ],
    );
    for (i, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        std::fs::write(cwd(i).join("fake-script.json"), case["script"].to_string()).unwrap();
        match case["settings"].as_str() {
            Some(text) => std::fs::write(&settings, text).unwrap(),
            None => {
                let _ = std::fs::remove_file(&settings);
            }
        }
        match case["kind"].as_str().unwrap() {
            "broadcast" => run_broadcast(&server, &norm, case, &cwd(i)),
            "consume" => run_consume(&server, case, &cwd(i)),
            k => panic!("{name}: kind {k}"),
        }
        let after = std::fs::read_to_string(&settings).ok();
        assert_eq!(
            after.as_deref(),
            case["settingsAfter"].as_str(),
            "{name}: settings.json afterwards"
        );
    }
    server.stop(Duration::from_secs(15));
}
