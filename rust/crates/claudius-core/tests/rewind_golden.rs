//! Rewind (S13), replayed against the TS recording in
//! `tests/fixtures/rewind_golden.json` (`rust/scripts/rewind-golden.mjs`):
//! - `controls`: `Session::rewind_files` on a real `Session` with the fake
//!   CLI answering as the case scripts it (or without a query, or after
//!   `end()`): each call's outcome, and the `rewind_files` control request it
//!   wrote, byte for byte (the request id as `$ID`);
//! - `resume`: a session resumed from the recorded transcript with the
//!   case's `resumeSessionAt` replays the transcript messages TS replayed, in
//!   order, and passes the CLI the same `--resume*` / `--session-id`
//!   arguments.
//!
//! The route's cases run on the real binary in
//! `claudius-server/tests/rewind.rs`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::paths;
use claudius_core::session::{RuntimeOptions, Session, SessionOptions, Subscription};
use claudius_core::session_manager::SessionManager;
use serde_json::Value;

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("fixtures/rewind_golden.json")).unwrap())
}

struct Env {
    _root: tempfile::TempDir,
    fake: PathBuf,
    config: PathBuf,
}

/// One isolated `$HOME` + config dir per test binary, and the fake CLI built.
fn env() -> &'static Env {
    static E: OnceLock<Env> = OnceLock::new();
    E.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let config = root.path().join("config");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(config.clone()));
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let st = std::process::Command::new(cargo)
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
        Env {
            _root: root,
            fake: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/debug/claudius-fake-claude"),
            config,
        }
    })
}

/// A project dir and the fake CLI's env for one case.
struct Run {
    cwd: tempfile::TempDir,
    log: PathBuf,
    argv: PathBuf,
    runtime: RuntimeOptions,
}

impl Run {
    fn new(script: &Value) -> Run {
        let cwd = tempfile::tempdir().unwrap();
        let log = cwd.path().join("stdin.log");
        let argv = cwd.path().join("argv.json");
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
        vars.insert("FAKE_CLAUDE_LOG".into(), log.display().to_string());
        vars.insert("FAKE_CLAUDE_ARGV".into(), argv.display().to_string());
        match script {
            Value::Null => {}
            Value::String(text) => {
                vars.insert("FAKE_CLAUDE_SCRIPT".into(), text.clone());
            }
            v => {
                vars.insert("FAKE_CLAUDE_SCRIPT".into(), v.to_string());
            }
        }
        Run {
            log,
            argv,
            runtime: RuntimeOptions {
                claude_bin: Some(env().fake.clone()),
                env_override: Some(vars),
            },
            cwd,
        }
    }

    fn cwd(&self) -> String {
        self.cwd
            .path()
            .canonicalize()
            .unwrap()
            .display()
            .to_string()
    }

    fn opts(&self) -> SessionOptions {
        SessionOptions {
            cwd: Some(self.cwd()),
            runtime: self.runtime.clone(),
            ..Default::default()
        }
    }

    fn lines(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// The `rewind_files` control requests written since line `from`, ids
    /// as `$ID`.
    fn wire_since(&self, from: usize) -> Vec<String> {
        self.lines()
            .into_iter()
            .skip(from)
            .filter_map(|l| {
                let m: Value = serde_json::from_str(&l).ok()?;
                (m["type"] == "control_request" && m["request"]["subtype"] == "rewind_files").then(
                    || {
                        let id = serde_json::to_string(&m["request_id"]).unwrap();
                        l.replacen(&id, "\"$ID\"", 1)
                    },
                )
            })
            .collect()
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

async fn next(sub: &mut Subscription) -> Value {
    tokio::time::timeout(Duration::from_secs(10), sub.recv())
        .await
        .expect("event timeout")
        .expect("stream closed")
}

/// Read until `pred` matches; returns everything seen (inclusive).
async fn until(sub: &mut Subscription, pred: impl Fn(&Value) -> bool) -> Vec<Value> {
    let mut seen = vec![];
    loop {
        let ev = next(sub).await;
        let done = pred(&ev);
        seen.push(ev);
        if done {
            return seen;
        }
    }
}

// ─────────────────────────────── controls ───────────────────────────────

/// A recorded outcome as text: `ok <data>` (JSON text) or `err <message>`.
fn expected_outcome(o: &Value) -> String {
    assert!(o.get("dataUndefined").is_none(), "{o}");
    match o["ok"].as_bool().unwrap() {
        true => format!("ok {}", js::stringify(&o["data"])),
        false => format!("err {}", o["error"].as_str().unwrap()),
    }
}

/// `rewindFiles(id, opts?)`'s arguments: `opts?.dryRun` is all the SDK reads.
fn call_args(args: &Value) -> (&str, Option<bool>) {
    let dry_run = args.get(1).and_then(|o| o.get("dryRun")).map(|d| {
        d.as_bool()
            .unwrap_or_else(|| panic!("a non-boolean dryRun: {args}"))
    });
    (args[0].as_str().unwrap(), dry_run)
}

async fn replay_controls(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let run = Run::new(&case["script"]);
    let query = case["query"].as_str().unwrap();
    let mgr = Arc::new(SessionManager::default());
    let s = match query {
        "none" => Session::new(run.opts()).unwrap(),
        _ => mgr.create(run.opts()).await.expect("create"),
    };
    let mut sub = s.subscribe(None, None);
    if query == "live" {
        until(&mut sub, |e| e["type"] == "tips").await;
    } else if query == "ended" {
        s.end().await;
        // TS recorded these once the SDK's stream had ended and its cleanup
        // had run; until the reader's cleanup a call fails with the abort.
        let closed = "Query closed before response received";
        let mut settled = false;
        for _ in 0..250 {
            match s.rewind_files("probe", None).await {
                Err(e) if e == closed => {
                    settled = true;
                    break;
                }
                Err(e) => assert_eq!(e, "Operation aborted", "{name}"),
                Ok(v) => panic!("{name}: an ended session answered {v}"),
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(settled, "{name}: the query never closed");
    }
    for (i, c) in case["calls"].as_array().unwrap().iter().enumerate() {
        let (id, dry_run) = call_args(&c["args"]);
        let from = run.lines().len();
        let got = s.rewind_files(id, dry_run).await.map_or_else(
            |e| format!("err {e}"),
            |d| format!("ok {}", js::stringify(&d)),
        );
        assert_eq!(got, expected_outcome(&c["outcome"]), "{name} call {i}");
        assert_eq!(
            run.wire_since(from),
            strings(&c["wire"]),
            "{name} call {i}: wire"
        );
    }
    if query == "live" {
        s.end().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rewind_files_round_trips_the_fake_cli() {
    env();
    let cases = fixture()["controls"].as_array().unwrap();
    assert!(cases.len() >= 10, "{} cases", cases.len());
    for chunk in cases.chunks(6) {
        futures::future::join_all(chunk.iter().map(replay_controls)).await;
    }
}

// ──────────────────────────────── resume ────────────────────────────────

/// Waits for the fake CLI to write its argv; the `--resume*` / `--session-id`
/// arguments.
async fn resume_args(file: &Path) -> Vec<String> {
    for _ in 0..500 {
        if let Ok(text) = std::fs::read_to_string(file)
            && let Ok(Value::Array(args)) = serde_json::from_str::<Value>(&text)
        {
            return args
                .iter()
                .filter_map(Value::as_str)
                .filter(|a| a.starts_with("--resume") || a.starts_with("--session-id"))
                .map(str::to_owned)
                .collect();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no argv in {}", file.display());
}

/// One recorded resume: a session resumed from the transcript at the case's
/// `resumeSessionAt`, in its own project dir.
async fn replay_resume(case: &Value) {
    let fx = fixture();
    let id = fx["resumeId"].as_str().unwrap();
    let lines = strings(&fx["transcript"]);
    let uuids: HashSet<String> = lines
        .iter()
        .map(|l| {
            serde_json::from_str::<Value>(l).unwrap()["uuid"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    let name = case["name"].as_str().unwrap();
    let run = Run::new(&Value::Null);
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&run.cwd()));
    std::fs::create_dir_all(&dir).unwrap();
    let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();

    let mgr = Arc::new(SessionManager::default());
    let s = mgr
        .create(SessionOptions {
            resume: Some(id.to_owned()),
            resume_session_at: case["resumeSessionAt"].as_str().map(str::to_owned),
            ..run.opts()
        })
        .await
        .expect("create");
    let mut sub = s.subscribe(None, None);
    let head = until(&mut sub, |e| e["type"] == "replay_done").await;
    let replayed: Vec<&str> = head
        .iter()
        .filter(|e| e["type"] == "sdk")
        .filter_map(|e| e["message"]["uuid"].as_str())
        .filter(|u| uuids.contains(*u))
        .collect();
    assert_eq!(replayed, strings(&case["replayed"]), "{name}: replay");
    assert_eq!(
        resume_args(&run.argv).await,
        strings(&case["argv"]),
        "{name}: argv"
    );
    mgr.remove(id).await;
}

/// All at once: a resumed session starts and stops a JSONL watcher, which
/// on macOS (FSEvents) can take seconds each under load.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resume_session_at_slices_the_replay_like_ts() {
    env();
    let cases = fixture()["resume"].as_array().unwrap();
    assert!(cases.len() >= 8, "{} cases", cases.len());
    futures::future::join_all(cases.iter().map(replay_resume)).await;
}
