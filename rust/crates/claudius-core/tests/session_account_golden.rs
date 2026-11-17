//! Account pinning (S30), replayed against the TS recording in
//! `tests/fixtures/session_account_golden.json`
//! (`rust/scripts/session-account-golden.mjs`):
//! - `rotate`: `noteAccountAutoRotateObservation` on live sessions whose
//!   fake CLI emits rate-limit walls (and other messages) at init: where the
//!   `account_auto_rotated` events land among the assistant texts, the
//!   account store afterwards, and the session's own pin (which a rotation
//!   doesn't move);
//! - `rateLimit`: `isRateLimitHitSdkMessage` on odd messages, and the prefix
//!   list;
//! - `listing`: `resolveSessionAccounts` / `lookupSessionAccount` over
//!   seeded project databases, a workspaces store and an account store.
//!
//! The route (`GET/POST /api/sessions/:id/account`) replays on the binary,
//! `claudius-server/tests/session_account.rs`; the start-time pin is in
//! `tests/session_start_golden.rs`.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::account_pinning::{USAGE_LIMIT_ERROR_PREFIXES, is_rate_limit_hit_sdk_message};
use claudius_core::accounts::AccountsStore;
use claudius_core::db::{self, Mode};
use claudius_core::paths;
use claudius_core::session::{RuntimeOptions, SessionOptions};
use claudius_core::session_accounts::{lookup_session_account, resolve_session_accounts};
use claudius_core::session_manager::SessionManager;
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/session_account_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

struct Env {
    _tmp: tempfile::TempDir,
    root: String,
    home: PathBuf,
    fake: PathBuf,
}

/// One isolated `$HOME` (`<root>/home`) and config dir per test binary, and
/// the fake CLI built.
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
        assert!(paths::set_config_dir_override(config));
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
            root: root.display().to_string(),
            _tmp: tmp,
            home,
            fake: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/debug/claudius-fake-claude"),
        }
    })
}

/// The tests share the account store and the workspaces store.
static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn store_dir() -> PathBuf {
    env().home.join(".claude/.claudius")
}

/// The recorder's `writeStore`: the text, `$DIR` for a directory, null for
/// no file.
fn write_store(text: &Value) {
    let file = store_dir().join("accounts.json");
    let _ = std::fs::remove_dir_all(&file);
    let _ = std::fs::remove_file(&file);
    match text {
        Value::String(d) if d == "$DIR" => std::fs::create_dir(&file).unwrap(),
        Value::String(t) => std::fs::write(&file, t).unwrap(),
        _ => {}
    }
}

fn read_text(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok()
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

#[test]
fn rate_limit_detection_matches_ts() {
    let rl = &fixture()["rateLimit"];
    let prefixes: Vec<&str> = rl["prefixes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    assert_eq!(prefixes, USAGE_LIMIT_ERROR_PREFIXES);
    let messages = rl["messages"].as_array().unwrap();
    assert!(messages.len() >= 70, "{} messages", messages.len());
    let mut wrong = Vec::new();
    for m in messages {
        let hit = is_rate_limit_hit_sdk_message(&m["message"]);
        if json!(hit) != m["hit"] {
            wrong.push(format!("{} -> TS {}", m["message"], m["hit"]));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_listing_join_matches_ts() {
    let _lock = STORE_LOCK.lock().await;
    let e = env();
    let scenarios = fixture()["listing"].as_array().unwrap();
    assert!(scenarios.len() >= 16, "{} listings", scenarios.len());
    let workspaces_file = store_dir().join("workspaces.json");
    // The recorder's `$CWD:<db name>` placeholders in the workspaces store.
    let placeholder = regex::Regex::new(r"\$CWD:([a-z]+)").unwrap();
    let mut wrong = Vec::new();
    for (i, sc) in scenarios.iter().enumerate() {
        let name = sc["name"].as_str().unwrap();
        let base = format!("{}/list/{i}", e.root);
        let cwd_of = |n: &Value| -> Option<String> {
            n.as_str().map(|n| {
                if n.is_empty() {
                    String::new()
                } else {
                    format!("{base}/{n}")
                }
            })
        };
        write_store(&sc["store"]);
        match sc["workspaces"].as_str() {
            None => {
                let _ = std::fs::remove_file(&workspaces_file);
            }
            Some(text) => {
                let text = placeholder
                    .replace_all(text, |c: &regex::Captures| format!("{base}/{}", &c[1]));
                std::fs::write(&workspaces_file, text.as_ref()).unwrap();
            }
        }
        for (db_name, rows) in sc["dbs"].as_object().unwrap() {
            // The empty name is the empty cwd, whose database sits at
            // `~/.claude/projects/.claudius.db`.
            let cwd = cwd_of(&json!(db_name)).unwrap();
            if let Some(bytes) = rows.as_str() {
                let file = paths::db_path(&cwd);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(&file, bytes).unwrap();
                continue;
            }
            // `{sql}`: a foreign database, that SQL on a new file.
            if let Some(sql) = rows["sql"].as_str() {
                let file = paths::db_path(&cwd);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                rusqlite::Connection::open(&file)
                    .unwrap()
                    .execute_batch(sql)
                    .unwrap();
                continue;
            }
            let db = db::open_db(&cwd, Mode::ReadWrite).unwrap();
            db.with(|c| {
                let tx = c.unchecked_transaction()?;
                for r in rows.as_array().unwrap() {
                    tx.execute(
                        "INSERT INTO sessions(id, cwd, state, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
                        rusqlite::params![
                            r[0].as_str().unwrap(),
                            cwd,
                            r[1].as_str().unwrap(),
                            1_767_225_600_000_i64,
                            1_767_225_600_000_i64,
                            1_767_225_600_000_i64
                        ],
                    )?;
                }
                tx.commit()
            })
            .unwrap();
        }
        let owned: Vec<(Option<String>, String)> = sc["pairs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (cwd_of(&p[0]), p[1].as_str().unwrap().to_owned()))
            .collect();
        let pairs: Vec<(Option<&str>, &str)> = owned
            .iter()
            .map(|(c, id)| (c.as_deref(), id.as_str()))
            .collect();
        let (by_key, configured) = resolve_session_accounts(&AccountsStore::from_env(), &pairs);
        let entries: Vec<Value> = by_key
            .iter()
            .map(|(k, v)| json!([k.replace(&e.root, "$ROOT"), v.to_json()]))
            .collect();
        let lookups: Vec<Value> = pairs
            .iter()
            .map(|(cwd, id)| {
                lookup_session_account(&by_key, *cwd, id).map_or(Value::Null, |a| a.to_json())
            })
            .collect();
        for (field, have) in [
            ("entries", Value::Array(entries)),
            ("accountsConfigured", json!(configured)),
            ("lookups", Value::Array(lookups)),
        ] {
            let (want, have) = (js::stringify(&sc[field]), js::stringify(&have));
            if want != have {
                wrong.push(format!("{name} / {field}:\n  TS:   {want}\n  Rust: {have}"));
            }
        }
    }
    write_store(&Value::Null);
    let _ = std::fs::remove_file(&workspaces_file);
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// The assistant texts (the first block's) and `account_auto_rotated`
/// events in the buffer, in order.
fn rotate_seq(buffer: &[Value]) -> Vec<Value> {
    buffer
        .iter()
        .filter_map(|e| {
            if e["type"] == "sdk" && e["message"]["type"] == "assistant" {
                let text = e["message"]["message"]["content"][0]["text"].clone();
                Some(json!({"text": text}))
            } else if e["type"] == "account_auto_rotated" {
                Some(e.clone())
            } else {
                None
            }
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn auto_rotate_matches_ts() {
    let _lock = STORE_LOCK.lock().await;
    let e = env();
    let scenarios = fixture()["rotate"].as_array().unwrap();
    assert!(scenarios.len() >= 20, "{} scenarios", scenarios.len());
    let accounts_file = store_dir().join("accounts.json");
    let mut wrong = Vec::new();
    let mut rotations = 0;
    for (i, sc) in scenarios.iter().enumerate() {
        let name = sc["name"].as_str().unwrap();
        let cwd = Path::new(&e.root).join("rotate").join(i.to_string());
        std::fs::create_dir_all(&cwd).unwrap();
        write_store(&sc["store"]);
        let base = HashMap::from([
            ("PATH".to_owned(), std::env::var("PATH").unwrap_or_default()),
            ("FAKE_CLAUDE_SCRIPT".to_owned(), sc["script"].to_string()),
        ]);
        let opts = SessionOptions {
            cwd: Some(cwd.display().to_string()),
            runtime: RuntimeOptions {
                claude_bin: Some(e.fake.clone()),
                env_override: Some(base),
            },
            ..Default::default()
        };
        let mgr = Arc::new(SessionManager::default());
        let s = mgr
            .create(opts)
            .await
            .unwrap_or_else(|err| panic!("{name}: {err}"));
        let texts = || {
            rotate_seq(&s.buffer_snapshot())
                .iter()
                .filter(|v| v.get("text").is_some())
                .count()
        };
        let on_init = sc["script"]["on_init"].as_array().unwrap();
        for gate in sc["gates"].as_array().unwrap() {
            let file = gate[0].as_str().unwrap();
            let at = on_init
                .iter()
                .position(|st| st["$wait_file"] == file)
                .unwrap();
            let before = on_init[..at]
                .iter()
                .filter(|st| st.get("type").is_some() || st.get("$text").is_some())
                .count();
            assert!(
                wait_for(|| texts() >= before, 10_000).await,
                "{name}: {file}"
            );
            tokio::time::sleep(Duration::from_millis(300)).await;
            write_store(&gate[1]);
            std::fs::write(cwd.join(file), "").unwrap();
        }
        let done = || {
            rotate_seq(&s.buffer_snapshot())
                .iter()
                .any(|v| v["text"] == "s30-done")
        };
        assert!(wait_for(done, 15_000).await, "{name}: no s30-done");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let seq = rotate_seq(&s.buffer_snapshot());
        rotations += seq.iter().filter(|v| v.get("type").is_some()).count();
        let pin = s.account_pin();
        let pin = json!({
            "id": pin.id,
            "label": pin.label,
            "drift": pin.drift_from_active.as_ref().map(|d| json!({"id": d.id, "label": d.label})),
        });
        let store_after = read_text(&accounts_file).map_or(Value::Null, Value::String);
        for (field, have) in [
            ("seq", Value::Array(seq)),
            ("storeAfter", store_after),
            ("pin", pin),
        ] {
            let (want, have) = (js::stringify(&sc[field]), js::stringify(&have));
            if want != have {
                wrong.push(format!("{name} / {field}:\n  TS:   {want}\n  Rust: {have}"));
            }
        }
        mgr.remove(&s.id).await;
    }
    write_store(&Value::Null);
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    assert!(rotations >= 10, "{rotations} rotations");
}
