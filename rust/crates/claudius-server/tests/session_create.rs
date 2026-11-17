//! The create route's body types on the real binary (S27d), replayed from
//! `rust/scripts/session-create-golden.mjs` (the real TS `POST
//! /api/sessions`, session manager and `new Session(...).start()` against the
//! fake CLI).
//!
//! TS hands the merged body to `new Session` untyped, so an odd-typed option
//! is dropped, printed with `${}` or fails the start — it is never a 400.
//! Each case POSTs its body and compares the route's status and answer, the
//! CLI arguments the body decides, the `initialize` request's prompt options,
//! the CLI's `CLAUDE_CODE_RESTRICTED`, the `ready` events a subscriber gets
//! and the user settings.json afterwards.
#![cfg(unix)]

mod common;

use std::io::Read;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::{Server, World, http, wait_until};
use serde_json::{Map, Value, json};

/// Cases whose Rust answer differs from the TS on purpose, with what the
/// binary does instead (a stale entry fails the test).
fn known(name: &str) -> Option<(u16, Value)> {
    match name {
        // TS compares `fallbackModel === model` on the body's own values, so
        // `5` and `"5"` differ and both flags go out; the port compares the
        // text each prints as, which the SDK rejects.
        "fallback equal as text" => Some((
            500,
            json!({
                "error": "Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.",
                "name": "Error",
            }),
        )),
        _ => None,
    }
}

/// The CLI arguments a create body decides: the recorder's `FLAGS`.
const FLAGS: [&str; 16] = [
    "--model",
    "--agent",
    "--betas",
    "--max-turns",
    "--max-budget-usd",
    "--task-budget",
    "--fallback-model",
    "--permission-mode",
    "--disallowedTools",
    "--no-session-persistence",
    "--add-dir",
    "--project-config-root",
    "--resume",
    "--resume-session-at",
    "--session-id",
    "--settings",
];

fn fixture() -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/session_create_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The one flag above the SDK passes as two arguments (`--settings <json>`).
const TWO_ARG: [&str; 1] = ["--settings"];

fn flags_of(argv: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str().unwrap_or_default();
        if TWO_ARG.contains(&a) {
            out.push(argv[i].clone());
            if let Some(v) = argv.get(i + 1) {
                out.push(v.clone());
            }
            i += 1;
        } else if FLAGS.contains(&a) || FLAGS.iter().any(|f| a.starts_with(&format!("{f}="))) {
            out.push(argv[i].clone());
        }
        i += 1;
    }
    out
}

/// The `initialize` control request's prompt options.
fn init_config(cwd: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(cwd.join("control.log")).ok()?;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(m) = serde_json::from_str::<Value>(line) else {
            continue; // the CLI may be mid-write
        };
        if m["type"] == "control_request" && m["request"]["subtype"] == "initialize" {
            let r = &m["request"];
            return Some(json!({
                "systemPrompt": r.get("systemPrompt").cloned().unwrap_or(Value::Null),
                "appendSystemPrompt": r.get("appendSystemPrompt").cloned().unwrap_or(Value::Null),
                "planModeInstructions": r.get("planModeInstructions").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    None
}

/// The `ready` / `error` events an SSE subscriber gets, once they stop
/// arriving.
fn ready_events(server: &Server, id: &str) -> Vec<Value> {
    let mut sock: TcpStream = server.open_stream(id);
    sock.set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let mut raw = Vec::new();
    let (start, mut last) = (Instant::now(), Instant::now());
    let mut buf = [0u8; 16384];
    while start.elapsed() < Duration::from_secs(5) && last.elapsed() < Duration::from_millis(400) {
        match sock.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                last = Instant::now();
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => panic!("{e}"),
        }
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    text.lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|e| e["type"] == "ready" || e["type"] == "error")
        .collect()
}

/// What `$ROOT`, `$PROC` and `$ID` stand for in this run.
struct Norm {
    root: String,
    proc: String,
}

impl Norm {
    fn apply(&self, v: &Value, id: &str) -> Value {
        // The project dir sits inside the root, so it reads first.
        let text = v
            .to_string()
            .replace(&self.proc, "$PROC")
            .replace(&self.root, "$ROOT");
        let text = if id.is_empty() {
            text
        } else {
            text.replace(id, "$ID")
        };
        serde_json::from_str(&text).unwrap()
    }
}

#[test]
fn create_body_types_match_the_ts() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    let world = World::new();
    let root: PathBuf = world.root.path().canonicalize().unwrap();
    let norm = Norm {
        root: root.display().to_string(),
        proc: world.project.display().to_string(),
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
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let server = Server::spawn(
        &world,
        &[
            ("FAKE_CLAUDE_SCRIPT", "{}"),
            ("FAKE_CLAUDE_ARGV", "argv.json"),
            ("FAKE_CLAUDE_ENV", "env.json"),
            ("FAKE_CLAUDE_CONTROL_LOG", "control.log"),
        ],
    );
    for (i, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        match case["settings"].as_str() {
            Some(text) => std::fs::write(&settings, text).unwrap(),
            None => {
                let _ = std::fs::remove_file(&settings);
            }
        }
        // The CLI writes next to its cwd: clear what an earlier case left
        // where this one's session may land.
        for dir in (0..cases.len()).map(cwd).chain([world.project.clone()]) {
            for f in ["argv.json", "env.json", "control.log"] {
                let _ = std::fs::remove_file(dir.join(f));
            }
        }
        let mut body: Map<String, Value> = case["body"].as_object().unwrap().clone();
        if body.get("cwd") == Some(&json!("$CASE")) {
            body.insert("cwd".into(), json!(cwd(i).display().to_string()));
        }
        let (st, text) = http(
            server.port,
            "POST",
            "/api/sessions",
            &Value::Object(body).to_string(),
        );
        let answer: Value = serde_json::from_str(&text).unwrap();
        let id = answer["id"].as_str().unwrap_or_default().to_owned();
        let (want_status, want_body) = match known(name) {
            Some((s, b)) => (s, b),
            None => (
                case["status"].as_u64().unwrap() as u16,
                case["response"].clone(),
            ),
        };
        assert_eq!(st, want_status, "{name}: {text}");
        assert_eq!(norm.apply(&answer, &id), want_body, "{name}: route answer");
        if id.is_empty() {
            continue;
        }
        let session_cwd = PathBuf::from(answer["cwd"].as_str().unwrap());
        let argv_file = session_cwd.join("argv.json");
        // This session's own argv, not a previous case's leftovers.
        let mine = || {
            std::fs::read_to_string(&argv_file)
                .ok()
                .is_some_and(|t| t.contains(&id))
        };
        wait_until("argv", Duration::from_secs(15), mine);
        let argv: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(&argv_file).unwrap()).unwrap();
        assert_eq!(
            norm.apply(&json!(flags_of(&argv)), &id),
            case["flags"],
            "{name}: CLI arguments"
        );
        wait_until("initialize", Duration::from_secs(15), || {
            init_config(&session_cwd).is_some()
        });
        assert_eq!(
            init_config(&session_cwd),
            Some(case["initConfig"].clone()),
            "{name}: initialize"
        );
        let env: Value =
            serde_json::from_str(&std::fs::read_to_string(session_cwd.join("env.json")).unwrap())
                .unwrap();
        assert_eq!(
            env.get("CLAUDE_CODE_RESTRICTED")
                .cloned()
                .unwrap_or(Value::Null),
            case["restrictedEnv"],
            "{name}: CLAUDE_CODE_RESTRICTED"
        );
        let mut ready: Vec<Value> = ready_events(&server, &id)
            .iter()
            .map(|e| norm.apply(e, &id))
            .collect();
        // The stream route appends a bare `ready` of its own after the
        // subscribe snapshot (HMR belt and braces, in TS too); the recorder
        // subscribed to the Session directly, so it never saw one.
        assert_eq!(
            ready.pop(),
            Some(json!({"type": "ready", "sessionId": "$ID"})),
            "{name}: the route's own ready last"
        );
        assert_eq!(Value::Array(ready), case["ready"], "{name}: ready events");
        http(
            server.port,
            "POST",
            &format!("/api/sessions/{id}/dev-reap"),
            "",
        );
        let after = std::fs::read_to_string(&settings).ok();
        assert_eq!(
            after.as_deref(),
            case["settingsAfter"].as_str(),
            "{name}: settings.json afterwards"
        );
    }
    server.stop(Duration::from_secs(15));
}
