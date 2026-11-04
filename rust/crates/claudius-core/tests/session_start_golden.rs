//! The `start()` audit (S27), replayed against the TS recording in
//! `tests/fixtures/session_start_golden.json`
//! (`rust/scripts/session-start-golden.mjs`): each case is the real
//! `new Session(options).start()` against the fake CLI, with the case's user
//! settings.json, a seeded goal or `db_agents` rows, a registered git root
//! and its worktree, a missing / odd cwd, a missing binary or a resumed
//! transcript. The same world is rebuilt here under a temp `$HOME`, the
//! session is created through [`SessionManager::create`], and the test
//! compares what TS recorded:
//! - whether start failed and with what message (TS: `start()` rejects, so
//!   `create` does);
//! - every buffered event that isn't an `sdk` message, the replayed
//!   transcript messages with their `at`, and the `ready`s a late
//!   subscriber gets, as `JSON.stringify` text;
//! - the CLI's argv, what its env adds to / changes in / drops from the env
//!   the session was given, and the `initialize` line byte for byte;
//! - the user settings.json text afterwards;
//! - where the case sets them up (S27a): the queue rows afterwards and the
//!   queued messages the session sent, whether the JSONL watcher is up, and
//!   what its resync broadcast (with `at`) after an external writer
//!   appended to the transcript;
//! - the session row's `state` text afterwards, and for the account cases
//!   (S30) the account store's `profiles/` tree: which profile the session
//!   pinned (a persisted pin, else the active profile), the CLI env built for
//!   it, `ready.account` and the token-expiry nudge of the pinned profile.
//!
//! The replayed and resynced `at`s read the transcripts' timestamps through
//! `Date.parse` (S27c), so `TZ` is pinned to the recorder's zone.
//!
//! Paths under the temp root read `$ROOT` on both sides. Where Rust is known
//! to differ the case is in [`KNOWN`] with its reason; a stale entry fails.
#![cfg(unix)]

use std::collections::{BTreeMap, HashMap};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::db::{self, Mode};
use claudius_core::queue_db::{self, NewQueued};
use claudius_core::session::{RuntimeOptions, SessionOptions};
use claudius_core::session_manager::SessionManager;
use claudius_core::{paths, sessions_db, settings};
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/session_start_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// `(case, field, reason)`: where Rust knowingly differs from the recording.
const KNOWN: &[(&str, &str, &str)] = &[];

/// The recorder's `TZ`, for the local-time `Date.parse` forms. Every test
/// sets it first, through one `Once`, before anything reads the environment
/// or jiff caches the system zone.
fn pin_tz() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let tz = fixture()["tz"].as_str().unwrap().to_owned();
        // SAFETY: the only write to the environment in this binary, made
        // before any test reads it (each waits on this `Once` first).
        unsafe { std::env::set_var("TZ", tz) };
    });
}

struct Env {
    _tmp: tempfile::TempDir,
    root: String,
    home: PathBuf,
    config: PathBuf,
    fake: PathBuf,
}

/// One isolated `$HOME` + config dir per test binary, the fake CLI built, and
/// the registered git root with its worktree.
fn env() -> &'static Env {
    static E: OnceLock<Env> = OnceLock::new();
    E.get_or_init(|| {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let home = root.join("home");
        let config = root.join("config");
        std::fs::create_dir_all(home.join(".claude/.claudius")).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home.clone()));
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
        let root_s = root.display().to_string();
        let git_root = root.join("repo");
        std::fs::create_dir_all(&git_root).unwrap();
        let git = |args: &[&str]| {
            let st = std::process::Command::new("git")
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "init.defaultBranch=main",
                ])
                .args(args)
                .current_dir(&git_root)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(st.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = root.join("repo-wt").display().to_string();
        git(&["worktree", "add", "-q", "-b", "wt", &wt]);
        let ws = denorm(&fixture()["workspaces"], &root_s);
        std::fs::write(
            home.join(".claude/.claudius/workspaces.json"),
            format!("{}\n", js::stringify_pretty(&ws)),
        )
        .unwrap();
        Env {
            _tmp: tmp,
            root: root_s,
            home,
            config,
            fake: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/debug/claudius-fake-claude"),
        }
    })
}

/// `$ROOT` → the temp root in every string of `v`.
fn denorm(v: &Value, root: &str) -> Value {
    serde_json::from_str(&v.to_string().replace("$ROOT", root)).unwrap()
}

fn norm(s: &str) -> String {
    s.replace(&env().root, "$ROOT")
}

/// The recorder's `cwdFor`.
fn cwd_for(i: usize, kind: Option<&str>) -> String {
    let e = env();
    let base = Path::new(&e.root).join("cases").join(i.to_string());
    let s = |p: &Path| p.display().to_string();
    match kind {
        None => {
            std::fs::create_dir_all(&base).unwrap();
            s(&base)
        }
        Some("worktree") => format!("{}/repo-wt", e.root),
        Some("root") => format!("{}/repo", e.root),
        Some("missing") => s(&base),
        Some("file") => {
            std::fs::create_dir_all(base.parent().unwrap()).unwrap();
            std::fs::write(&base, "not a dir").unwrap();
            s(&base)
        }
        Some("relative") => "rel/dir".into(),
        Some("enotdir") => {
            std::fs::create_dir_all(base.parent().unwrap()).unwrap();
            std::fs::write(&base, "not a dir").unwrap();
            s(&base.join("sub"))
        }
        Some("toolong") => {
            std::fs::create_dir_all(&base).unwrap();
            s(&base.join("x".repeat(300)))
        }
        Some(k) => panic!("cwd kind {k}"),
    }
}

fn read_text(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok()
}

/// The recorder's `profilesTree()`: every entry under `dir` (links not
/// followed) with its type, mode, text or link target; `None` without `dir`.
fn profiles_tree(dir: &Path) -> Value {
    fn walk(root: &Path, rel: &str, out: &mut Map<String, Value>) -> std::io::Result<()> {
        let dir = if rel.is_empty() {
            root.to_path_buf()
        } else {
            root.join(rel)
        };
        let mut names: Vec<String> = std::fs::read_dir(&dir)?
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<Result<_, _>>()?;
        names.sort();
        for name in names {
            let r = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let full = root.join(&r);
            let md = std::fs::symlink_metadata(&full)?;
            let m = format!("{:o}", md.permissions().mode() & 0o777);
            if md.file_type().is_symlink() {
                let to = std::fs::read_link(&full)?.display().to_string();
                out.insert(r, json!({"t": "l", "to": norm(&to)}));
            } else if md.is_dir() {
                out.insert(r.clone(), json!({"t": "d", "m": m}));
                walk(root, &r, out)?;
            } else {
                let x = std::fs::read_to_string(&full)?;
                out.insert(r, json!({"t": "f", "m": m, "x": norm(&x)}));
            }
        }
        Ok(())
    }
    let mut out = Map::new();
    match walk(dir, "", &mut out) {
        Ok(()) => Value::Object(out),
        Err(_) => Value::Null,
    }
}

/// The session row's `state` text (null without a row or a database).
fn state_after(cwd: &str, id: &str) -> Value {
    let Ok(db) = db::open_db(cwd, Mode::ReadOnly) else {
        return Value::Null;
    };
    db.with(|c| {
        c.query_row("SELECT state FROM sessions WHERE id = ?", [id], |r| {
            r.get::<_, Option<String>>(0)
        })
    })
    .ok()
    .flatten()
    .map_or(Value::Null, Value::String)
}

/// The `initialize` control request as written, its request id `$ID`.
fn initialize_line(log: &Path) -> Option<String> {
    let text = read_text(log)?;
    let line = text
        .lines()
        .find(|l| l.contains("\"subtype\":\"initialize\""))?;
    let v: Value = serde_json::from_str(line).unwrap();
    let id = serde_json::to_string(&v["request_id"]).unwrap();
    Some(line.replacen(&format!("\"request_id\":{id}"), "\"request_id\":\"$ID\"", 1))
}

/// What the CLI's env adds to / changes in (`added`) or drops from
/// (`removed`) `base`.
fn env_delta(base: &HashMap<String, String>, seen: &BTreeMap<String, String>) -> Value {
    let added: Map<String, Value> = seen
        .iter()
        .filter(|(k, v)| base.get(*k) != Some(*v))
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    let mut removed: Vec<&String> = base.keys().filter(|k| !seen.contains_key(*k)).collect();
    removed.sort();
    json!({"added": added, "removed": removed})
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

async fn wait_for(mut pred: impl FnMut() -> bool, ms: u64) -> bool {
    for _ in 0..ms / 10 {
        if pred() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    pred()
}

/// One case, recorded the way the recorder records it.
async fn run(i: usize, case: &Value) -> Map<String, Value> {
    let e = env();
    let name = case["name"].as_str().unwrap();
    let id = case["id"].as_str().unwrap();
    let cwd = cwd_for(i, case["cwd"].as_str());
    let dir = Path::new(&e.root).join("io").join(i.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    let (argv, envf, log) = (
        dir.join("argv.json"),
        dir.join("env.json"),
        dir.join("stdin.log"),
    );
    let settings = e.home.join(".claude/settings.json");
    match case["settings"].as_str() {
        Some(text) => std::fs::write(&settings, text).unwrap(),
        None => {
            let _ = std::fs::remove_file(&settings);
        }
    }
    if let Some(goal) = case["goal"].as_str() {
        sessions_db::set_session_goal(&cwd, id, goal).unwrap();
        db::open_db(&cwd, Mode::ReadWrite)
            .unwrap()
            .with(|c| {
                c.execute(
                    "UPDATE sessions SET goal_set_at = ? WHERE id = ?",
                    rusqlite::params![1_767_225_600_000_i64, id],
                )
            })
            .unwrap();
    }
    for a in case["dbAgents"].as_array().unwrap() {
        db::open_db(&cwd, Mode::ReadWrite)
            .unwrap()
            .with(|c| {
                c.execute(
                    "INSERT INTO db_agents(name, definition_json, updated_at) VALUES (?, ?, ?)",
                    rusqlite::params![
                        a["name"].as_str().unwrap(),
                        js::stringify(&a["definition"]),
                        1_767_225_600_000_i64
                    ],
                )
            })
            .unwrap();
    }
    for q in case["queued"].as_array().into_iter().flatten() {
        let (uuid, text) = (q[0].as_str().unwrap(), q[1].as_str().unwrap());
        queue_db::enqueue_tail(
            &cwd,
            NewQueued {
                session_id: id,
                uuid,
                text,
                images: None,
                slash: false,
                from_suggestion: false,
                from_goal: false,
            },
        )
        .unwrap();
        db::open_db(&cwd, Mode::ReadWrite)
            .unwrap()
            .with(|c| {
                c.execute(
                    "UPDATE queued_messages SET created_at_ms = ? WHERE uuid = ?",
                    rusqlite::params![1_767_225_600_000_i64, uuid],
                )
            })
            .unwrap();
    }
    let projects = e
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    if case["projects"] == true {
        std::fs::create_dir_all(&projects).unwrap();
        // The recorder's link from `$HOME/.claude/projects`, where TS
        // watches, to the config dir's, where the CLI writes.
        let watched = e
            .home
            .join(".claude/projects")
            .join(projects.file_name().unwrap());
        std::fs::create_dir_all(watched.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&projects, watched).unwrap();
    }
    // Account pinning (S30): the store, the session's state text, a file
    // where a profile's config dir goes, and a relative expiry.
    let store_dir = e.home.join(".claude/.claudius");
    let accounts_file = store_dir.join("accounts.json");
    let profiles_dir = store_dir.join("profiles");
    let account_case = case.get("accounts").is_some();
    let expires_at = case["expiresIn"]
        .as_i64()
        .map(|ms| claudius_core::now_ms() + ms);
    let norm_exp = |v: Value| -> Value {
        match expires_at {
            Some(at) => {
                serde_json::from_str(&v.to_string().replace(&at.to_string(), "\"$EXPIRES\""))
                    .unwrap()
            }
            None => v,
        }
    };
    if account_case {
        let _ = std::fs::remove_dir_all(&accounts_file);
        let _ = std::fs::remove_file(&accounts_file);
        match &case["accounts"] {
            Value::String(d) if d == "$DIR" => std::fs::create_dir(&accounts_file).unwrap(),
            Value::String(text) => std::fs::write(
                &accounts_file,
                text.replace(
                    "\"$EXPIRES\"",
                    &expires_at.map(|a| a.to_string()).unwrap_or_default(),
                ),
            )
            .unwrap(),
            _ => {}
        }
    }
    if let Some(state) = case["state"].as_str() {
        db::open_db(&cwd, Mode::ReadWrite)
            .unwrap()
            .with(|c| {
                c.execute(
                    "INSERT INTO sessions(id, cwd, state, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state",
                    rusqlite::params![id, cwd, state, 1_767_225_600_000_i64, 1_767_225_600_000_i64, 1_767_225_600_000_i64],
                )
            })
            .unwrap();
    }
    if let Some(blocked) = case["blockProfile"].as_str() {
        std::fs::create_dir_all(&profiles_dir).unwrap();
        std::fs::write(profiles_dir.join(blocked), "not a dir").unwrap();
    }
    if let Some(bytes) = case["transcriptHex"].as_str() {
        std::fs::create_dir_all(&projects).unwrap();
        let file = projects.join(format!("{id}.jsonl"));
        std::fs::write(&file, hex(bytes)).unwrap();
        if case["resume"] == "unreadable" {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        }
    }
    let mut base: HashMap<String, String> = [
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("NODE_OPTIONS", "--no-warnings".into()),
        ("FAKE_CLAUDE_ARGV", argv.display().to_string()),
        ("FAKE_CLAUDE_ENV", envf.display().to_string()),
        ("FAKE_CLAUDE_LOG", log.display().to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    if let Some(parent) = case["parentEnv"].as_object() {
        for (k, v) in parent {
            base.insert(k.clone(), v.as_str().unwrap().to_owned());
        }
    }
    let mut options = case["options"].as_object().unwrap().clone();
    options.insert("id".into(), json!(id));
    options.insert("cwd".into(), json!(cwd));
    let mut opts: SessionOptions = serde_json::from_value(Value::Object(options))
        .unwrap_or_else(|err| panic!("{name}: options: {err}"));
    opts.runtime = RuntimeOptions {
        claude_bin: Some(
            case["bin"]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or_else(|| e.fake.clone()),
        ),
        env_override: Some(base.clone()),
    };

    let mgr = Arc::new(SessionManager::default());
    let created = mgr.create(opts).await;
    let mut extra = Map::new();
    let (threw, events, replayed, late_ready) = match &created {
        // The create route's `{error, name}`.
        Err(err) => (
            json!({"name": err.name(), "message": norm(&err.to_string())}),
            vec![],
            vec![],
            vec![],
        ),
        Ok(s) => {
            if case["projects"] == true {
                // TS sets its watcher in start(); Rust's starts on a thread.
                extra.insert("watching".into(), json!(s.wait_jsonl_watcher().await));
            }
            if Path::new(&cwd).is_dir() && case["bin"].is_null() {
                // Or the spawn failed (the session is done).
                assert!(
                    wait_for(|| initialize_line(&log).is_some() || s.is_done(), 10_000).await,
                    "{name}: no initialize"
                );
            }
            // As long as the recorder waits for the advisor notice.
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Some(bytes) = case["externalHex"].as_str() {
                let lines = hex(bytes).iter().filter(|&&b| b == b'\n').count();
                let file = projects.join(format!("{id}.jsonl"));
                std::fs::write(&file, hex(bytes)).unwrap();
                let resynced = || {
                    s.buffer_snapshot()
                        .iter()
                        .filter(|e| is_external(e))
                        .count()
                };
                // The recorder's touch loop.
                for t in 0.. {
                    if resynced() >= lines {
                        break;
                    }
                    assert!(t < 40, "{name}: no resync");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if resynced() < lines {
                        std::fs::File::options()
                            .write(true)
                            .open(&file)
                            .unwrap()
                            .set_modified(std::time::SystemTime::now())
                            .unwrap();
                    }
                }
            }
            let buffer = s.buffer_snapshot();
            if case["externalHex"].is_string() {
                let resynced: Vec<Value> = buffer
                    .iter()
                    .filter(|e| is_external(e))
                    .map(|e| json!({"at": e.get("at").cloned().unwrap_or(Value::Null), "message": e["message"]}))
                    .collect();
                extra.insert("resynced".into(), Value::Array(resynced));
            }
            if let Some(queued) = case["queued"].as_array() {
                let uuids: Vec<&str> = queued.iter().map(|q| q[0].as_str().unwrap()).collect();
                let sent: Vec<Value> = buffer
                    .iter()
                    .filter(|e| {
                        e["type"] == "sdk"
                            && e["message"]["uuid"]
                                .as_str()
                                .is_some_and(|u| uuids.contains(&u))
                    })
                    .map(|e| e["message"].clone())
                    .collect();
                extra.insert("sent".into(), Value::Array(sent));
            }
            let events: Vec<Value> = buffer
                .iter()
                .filter(|e| e["type"] != "sdk")
                .cloned()
                .collect();
            let replayed: Vec<Value> = buffer
                .iter()
                .filter(|e| {
                    e["type"] == "sdk"
                        && e["message"]["uuid"]
                            .as_str()
                            .is_some_and(|u| matches!(u, "u-1" | "a-1") || u.starts_with("d-"))
                })
                .map(|e| json!({"at": e.get("at").cloned().unwrap_or(Value::Null), "message": e["message"]}))
                .collect();
            // A late subscriber's `ready`s: the replay is sent synchronously.
            let mut late = s.subscribe(None, None);
            let mut late_ready = Vec::new();
            while let Ok(e) = late.rx.try_recv() {
                if e["type"] == "ready" {
                    late_ready.push(e);
                }
            }
            drop(late);
            (Value::Null, events, replayed, late_ready)
        }
    };
    let mut got = Map::new();
    got.insert("threw".into(), threw);
    got.insert(
        "events".into(),
        norm_exp(serde_json::from_str(&norm(&Value::Array(events).to_string())).unwrap()),
    );
    got.insert("replayed".into(), Value::Array(replayed));
    got.insert("lateReady".into(), norm_exp(Value::Array(late_ready)));
    got.insert(
        "argv".into(),
        read_text(&argv).map_or(Value::Null, |a| serde_json::from_str(&norm(&a)).unwrap()),
    );
    got.insert(
        "env".into(),
        read_text(&envf).map_or(Value::Null, |text| {
            let seen: BTreeMap<String, String> = serde_json::from_str(&text).unwrap();
            serde_json::from_str(&norm(&env_delta(&base, &seen).to_string())).unwrap()
        }),
    );
    got.insert(
        "initialize".into(),
        initialize_line(&log).map_or(Value::Null, |l| json!(norm(&l))),
    );
    got.insert(
        "settingsAfter".into(),
        read_text(&settings).map_or(Value::Null, Value::String),
    );
    got.insert("stateAfter".into(), state_after(&cwd, id));
    if account_case {
        got.insert("profiles".into(), profiles_tree(&profiles_dir));
        if let Some(blocked) = case["blockProfile"].as_str() {
            std::fs::remove_file(profiles_dir.join(blocked)).unwrap();
        }
        let _ = std::fs::remove_dir_all(&accounts_file);
        let _ = std::fs::remove_file(&accounts_file);
    }
    if case["queued"].is_array() {
        let rows: Vec<Value> = queue_db::list_queue(&cwd, id)
            .into_iter()
            .map(|r| json!({"uuid": r.uuid, "text": r.text, "createdAtMs": r.created_at_ms}))
            .collect();
        got.insert("queueAfter".into(), Value::Array(rows));
    }
    got.extend(extra);
    if let Ok(s) = created {
        s.end().await;
    }
    got
}

const FIELDS: [&str; 10] = [
    "threw",
    "events",
    "replayed",
    "lateReady",
    "argv",
    "env",
    "initialize",
    "settingsAfter",
    "stateAfter",
    // Account cases only.
    "profiles",
];

/// Recorded only for the cases that set them up (S27a).
const CASE_FIELDS: [&str; 4] = ["queueAfter", "sent", "watching", "resynced"];

/// A line the recorder's external writer appended (`e-01`, …).
fn is_external(e: &Value) -> bool {
    e["type"] == "sdk"
        && e["message"]["uuid"]
            .as_str()
            .is_some_and(|u| u.starts_with("e-"))
}

/// The tests share `$HOME/.claude/settings.json`.
static HOME_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn start_matches_ts() {
    pin_tz();
    let _home = HOME_LOCK.lock().await;
    env();
    let cases = fixture()["cases"].as_array().unwrap();
    assert!(cases.len() >= 125, "{} cases", cases.len());
    let accounts = cases.iter().filter(|c| c.get("accounts").is_some()).count();
    assert!(accounts >= 38, "{accounts} account cases");
    let mut diffs: Vec<(String, String, String)> = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let got = run(i, case).await;
        let present = CASE_FIELDS.into_iter().filter(|f| case.get(*f).is_some());
        for field in FIELDS.into_iter().chain(present) {
            if case.get(field).is_none() && got.get(field).is_none() {
                continue;
            }
            // `JSON.stringify` text on both sides.
            let (want, have) = (js::stringify(&case[field]), js::stringify(&got[field]));
            if want != have {
                diffs.push((
                    name.to_owned(),
                    field.to_owned(),
                    format!("\n  TS:   {want}\n  Rust: {have}"),
                ));
            }
        }
    }
    let _ = std::fs::remove_file(env().home.join(".claude/settings.json"));
    let mut unexpected = Vec::new();
    for (name, field, detail) in &diffs {
        if !KNOWN.iter().any(|(n, f, _)| n == name && f == field) {
            unexpected.push(format!("{name} / {field}:{detail}"));
        }
    }
    let stale: Vec<_> = KNOWN
        .iter()
        .filter(|(n, f, _)| !diffs.iter().any(|(dn, df, _)| dn == n && df == f))
        .collect();
    assert!(
        unexpected.is_empty() && stale.is_empty(),
        "{} unexpected differences:\n{}\nstale KNOWN entries: {stale:?}",
        unexpected.len(),
        unexpected.join("\n")
    );
}

/// `enforceAdvisorModelCompatibility` clears the file with the same
/// `delete` and `writeSettings` as start()'s fable clear, so the fable
/// cases' TS text is its golden too.
#[test]
fn advisor_compat_clear_matches_ts() {
    pin_tz();
    let _home = HOME_LOCK.blocking_lock();
    let file = env().home.join(".claude/settings.json");
    let cases = fixture()["cases"].as_array().unwrap();
    let mut got = Vec::new();
    for name in ["fable clears advisor", "fable keeps empty advisor"] {
        let case = cases.iter().find(|c| c["name"] == name).unwrap();
        std::fs::write(&file, case["settings"].as_str().unwrap()).unwrap();
        settings::clear_user_advisor_model("/").unwrap();
        let after = std::fs::read_to_string(&file).unwrap();
        got.push((
            name,
            after,
            case["settingsAfter"].as_str().unwrap().to_owned(),
        ));
    }
    std::fs::remove_file(&file).unwrap();
    for (name, after, want) in got {
        assert_eq!(after, want, "{name}");
    }
}

/// TS `create` forgets a rejected start (`finally`), so the next create for
/// the same resume id starts afresh instead of joining the failure.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_start_is_not_joined() {
    pin_tz();
    let _home = HOME_LOCK.lock().await;
    let e = env();
    let _ = std::fs::remove_file(e.home.join(".claude/settings.json"));
    let cwd = Path::new(&e.root).join("rejected");
    std::fs::create_dir_all(&cwd).unwrap();
    let opts = |fallback: &str| {
        let mut o: SessionOptions = serde_json::from_value(json!({
            "cwd": cwd.display().to_string(),
            "resume": "0b6f3c1d-2e4a-4b5c-8d7e-9f0a1b2c3d4e",
            "model": "m",
            "fallbackModel": fallback,
        }))
        .unwrap();
        o.runtime = RuntimeOptions {
            claude_bin: Some(e.fake.clone()),
            env_override: Some(HashMap::from([(
                "PATH".to_owned(),
                std::env::var("PATH").unwrap_or_default(),
            )])),
        };
        o
    };
    let mgr = Arc::new(SessionManager::default());
    let err = mgr.create(opts("m")).await.err().expect("rejected");
    assert!(
        err.to_string()
            .starts_with("Fallback model cannot be the same"),
        "{err}"
    );
    assert_eq!(err.name(), "Error");
    assert!(mgr.get("0b6f3c1d-2e4a-4b5c-8d7e-9f0a1b2c3d4e").is_none());
    let s = mgr.create(opts("n")).await.expect("a fresh start");
    s.end().await;
}

/// A create that joins a start in flight gets the rejection's own name and
/// message.
/// The first start replays a long transcript, so the second create almost
/// always joins it; one that starts afresh is rejected the same way.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_joined_rejected_start_reports_its_message() {
    pin_tz();
    let _home = HOME_LOCK.lock().await;
    let e = env();
    let _ = std::fs::remove_file(e.home.join(".claude/settings.json"));
    let cwd = Path::new(&e.root).join("joined");
    std::fs::create_dir_all(&cwd).unwrap();
    let id = "7d2e4f60-1a3b-4c5d-8e9f-0a1b2c3d4e5f";
    let projects = e
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd.display().to_string()));
    std::fs::create_dir_all(&projects).unwrap();
    let line = |i: usize| {
        format!(
            "{}\n",
            json!({"type": "user", "uuid": format!("j-{i}"), "parentUuid": if i == 0 { Value::Null } else { json!(format!("j-{}", i - 1)) },
                "sessionId": id, "timestamp": "2026-01-02T03:04:05.000Z", "message": {"role": "user", "content": "x".repeat(200)}})
        )
    };
    std::fs::write(
        projects.join(format!("{id}.jsonl")),
        (0..5_000).map(line).collect::<String>(),
    )
    .unwrap();
    let opts = || {
        let mut o: SessionOptions = serde_json::from_value(json!({
            "cwd": cwd.display().to_string(), "resume": id, "model": "m", "fallbackModel": "m",
        }))
        .unwrap();
        o.runtime = RuntimeOptions {
            claude_bin: Some(e.fake.clone()),
            env_override: Some(HashMap::new()),
        };
        o
    };
    let mgr = Arc::new(SessionManager::default());
    let first = tokio::spawn({
        let (mgr, o) = (mgr.clone(), opts());
        async move { mgr.create(o).await.map(|_| ()) }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let second = mgr.create(opts()).await.map(|_| ());
    let first = first.await.unwrap();
    let want = "Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.";
    for r in [first, second] {
        // The joiner gets the `CreateError::Threw` the first create sent.
        let e = r.err();
        assert_eq!(e.as_ref().map(|e| e.to_string()).as_deref(), Some(want));
        assert_eq!(e.as_ref().map(|e| e.name()), Some("Error"));
    }
}
