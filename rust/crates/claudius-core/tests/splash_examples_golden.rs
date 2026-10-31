//! Replays `fixtures/splash_examples_golden.json`, recorded by
//! `rust/scripts/splash-examples-golden.mjs` from the real TS:
//! `splash-examples-db.ts` on the real DB layer (`db.ts`: `openDb`, its
//! migrations and cached handles) and `splash-fallback-name.ts` on the real
//! accounts store and global config.
//!
//! `db` is one sequence over several cwds under a temp `$HOME`: the module's
//! calls (their `JSON.stringify` text, lone surrogates as `\udXXX`, or the
//! thrown message), the same world changes (migrated databases, rows and
//! schemas another writer made, files that aren't databases, read-only files
//! and folders, a database file removed under its open handles) and the same
//! dumps of `ui_state` / `schema_meta` (types and bytes) and of what is on
//! disk. `fallback` rebuilds each case's `accounts.json` and `~/.claude.json`
//! before each call, with a fresh global-config cache per case.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use claudius_agent::js;
use claudius_core::accounts::{AccountsStore, accounts_dir_for};
use claudius_core::claude_global_config::{ClaudeGlobalConfig, config_path_for};
use claudius_core::db::{self, Mode};
use claudius_core::paths;
use claudius_core::splash_examples::{
    get_splash_display_name, get_splash_examples, json_array, reset_splash_examples,
    set_splash_display_name, set_splash_examples,
};
use claudius_core::splash_fallback_name::resolve_splash_fallback_name_with;
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/splash_examples_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

struct World {
    _dir: tempfile::TempDir,
    home: PathBuf,
}

impl World {
    fn new() -> World {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap().join("home");
        std::fs::create_dir_all(&home).unwrap();
        assert!(paths::set_home_override(home.clone()));
        World { _dir: dir, home }
    }

    fn home_str(&self) -> String {
        self.home.display().to_string()
    }

    fn scrub(&self, s: &str) -> String {
        s.replace(&self.home_str(), "$HOME")
    }

    fn threw(&self, e: &anyhow::Error) -> Value {
        json!({"threw": self.scrub(&e.to_string())})
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::process::Command::new("chmod")
            .args(["-R", "u+rwx"])
            .arg(&self.home)
            .status();
    }
}

fn kind(p: &Path) -> &'static str {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => "dir",
        Ok(_) => "file",
        Err(_) => "missing",
    }
}

fn chmod(p: &Path, mode: u32) {
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn text_cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        other => panic!("the dump selects text, got {other:?}"),
    }
}

/// `rows` / `meta`: the recorder's dump through a bare read-only connection.
fn dump(w: &World, cwd: &str, sql: &str) -> Value {
    let path = paths::db_path(cwd);
    if kind(&path) != "file" {
        return json!("missing");
    }
    let run = || -> rusqlite::Result<Vec<Value>> {
        let c = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut st = c.prepare(sql)?;
        st.query_map([], |r| {
            Ok(json!([
                text_cell(r.get_ref(0)?),
                text_cell(r.get_ref(1)?),
                text_cell(r.get_ref(2)?)
            ]))
        })?
        .collect()
    };
    match run() {
        Ok(rows) => Value::Array(rows),
        Err(e) => json!({"threw": w.scrub(&db::sqlite_message(&e))}),
    }
}

/// The recorder's `fill`: `$UTF8HEX`, `$HEX` and `$LAST` are the newest
/// migration id (the hex of its digits, hex, decimal).
fn fill(sql: &str) -> String {
    let last = db::latest_version().to_string();
    let utf8_hex: String = last.bytes().map(|b| format!("{b:02x}")).collect();
    sql.replace("$UTF8HEX", &utf8_hex)
        .replace("$HEX", &format!("{:x}", db::latest_version()))
        .replace("$LAST", &last)
}

/// `raw`: SQL on the DB file through a bare connection, no migrations.
fn raw(cwd: &str, sql: &str, wal: bool) {
    let path = paths::db_path(cwd);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let c = rusqlite::Connection::open(&path).unwrap();
    if wal {
        c.pragma_update(None, "journal_mode", "WAL").unwrap();
    }
    c.execute_batch(sql).unwrap();
}

fn file_op(cwd: &str, spec: &Value) {
    let path = paths::db_path(cwd);
    let project = path.parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&project).unwrap();
    if spec["rm"] == true {
        let _ = std::fs::remove_file(&path);
    }
    if let Some(t) = spec["text"].as_str() {
        std::fs::write(&path, t).unwrap();
    }
    if let Some(h) = spec["hex"].as_str() {
        std::fs::write(&path, hex(h)).unwrap();
    }
    if spec["dir"] == true {
        std::fs::create_dir(&path).unwrap();
    }
    if let Some(mode) = spec["mode"].as_u64() {
        let target = if spec["target"] == "project" {
            &project
        } else {
            &path
        };
        chmod(target, mode as u32);
    }
}

fn run_db_step(w: &World, s: &Value) -> Value {
    let cwd = s["cwd"].as_str().unwrap();
    let text = |t: String| json!(t);
    match s["op"].as_str().unwrap() {
        "get" => text(get_splash_examples(cwd).to_json()),
        "set" => match set_splash_examples(cwd, s["examples"].as_array().unwrap()) {
            Ok(v) => text(json_array(&v)),
            Err(e) => w.threw(&e),
        },
        "reset" => match reset_splash_examples(cwd) {
            Ok(()) => json!("undefined"),
            Err(e) => w.threw(&e),
        },
        "getName" => {
            text(get_splash_display_name(cwd).map_or_else(|| "null".into(), |n| n.to_json()))
        }
        "setName" => match set_splash_display_name(cwd, s["name"].as_str()) {
            Ok(v) => text(v.map_or_else(|| "null".into(), |n| n.to_json())),
            Err(e) => w.threw(&e),
        },
        "open" => match db::open_db(cwd, Mode::ReadWrite) {
            Ok(handle) => {
                drop(handle);
                db::close_db(cwd);
                json!("ok")
            }
            Err(e) => w.threw(&e),
        },
        "raw" => {
            raw(cwd, &fill(s["sql"].as_str().unwrap()), s["wal"] == true);
            json!("ok")
        }
        "file" => {
            file_op(cwd, &s["spec"]);
            json!("ok")
        }
        "projectFile" => {
            let project = paths::project_root(cwd);
            std::fs::create_dir_all(project.parent().unwrap()).unwrap();
            std::fs::write(&project, "a file, not a directory\n").unwrap();
            json!("ok")
        }
        "rows" => dump(
            w,
            cwd,
            "SELECT key, typeof(value), hex(value) FROM ui_state ORDER BY key, rowid",
        ),
        "meta" => dump(
            w,
            cwd,
            "SELECT key, typeof(value), quote(value) FROM schema_meta ORDER BY key, rowid",
        ),
        "flag" => dump(
            w,
            cwd,
            "SELECT key, typeof(value), quote(value) FROM schema_meta WHERE key <> 'version' ORDER BY key, rowid",
        ),
        "files" => json!({
            "dir": kind(&paths::project_root(cwd)),
            "db": kind(&paths::db_path(cwd)),
        }),
        op => panic!("unknown op {op}"),
    }
}

/// `writeSpec`: replace the file with a spec's content (`null`: remove it).
fn write_spec(path: &Path, spec: &Value) {
    if spec.is_null() && !path.exists() && !path.is_symlink() {
        return;
    }
    if path.exists() {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644));
        if path.is_dir() {
            std::fs::remove_dir_all(path).unwrap();
        } else {
            std::fs::remove_file(path).unwrap();
        }
    }
    if spec.is_null() {
        return;
    }
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    if spec["dir"] == true {
        std::fs::create_dir(path).unwrap();
        return;
    }
    let text = match spec.get("json") {
        Some(v) => js::stringify_pretty(v),
        None => spec["text"].as_str().unwrap().to_owned(),
    };
    std::fs::write(path, text).unwrap();
    if let Some(mode) = spec["mode"].as_u64() {
        chmod(path, mode as u32);
    }
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let w = World::new();
    let mut failures = vec![];

    let steps = fx["db"].as_array().unwrap();
    for (i, s) in steps.iter().enumerate() {
        let got = run_db_step(&w, s);
        if got != s["got"] {
            failures.push(format!(
                "db #{i} {} {} {}\n  want {}\n  got  {got}",
                s["op"],
                s["cwd"],
                js::stringify(
                    &json!({"examples": s["examples"], "name": s["name"], "sql": s["sql"]})
                ),
                s["got"]
            ));
        }
    }

    let home = w.home_str();
    let accounts_path = PathBuf::from(accounts_dir_for(None, &home)).join("accounts.json");
    let global_path = PathBuf::from(config_path_for(None, &home));
    let store = AccountsStore::new(accounts_dir_for(None, &home), home.clone());
    let cases = fx["fallback"].as_array().unwrap();
    let mut calls = 0;
    for c in cases {
        write_spec(&accounts_path, &Value::Null);
        write_spec(&global_path, &Value::Null);
        let global = ClaudeGlobalConfig::new(global_path.to_string_lossy());
        for (j, call) in c["calls"].as_array().unwrap().iter().enumerate() {
            calls += 1;
            if let Some(spec) = call.get("accounts") {
                write_spec(&accounts_path, spec);
            }
            if let Some(spec) = call.get("global") {
                write_spec(&global_path, spec);
            }
            if call["reset"] == true {
                global.reset_cache();
            }
            let got = js::stringify(&json!(resolve_splash_fallback_name_with(&store, &global)));
            if json!(got) != call["got"] {
                failures.push(format!(
                    "fallback {} call {j}\n  want {}\n  got  {got}",
                    c["name"], call["got"]
                ));
            }
        }
    }
    write_spec(&accounts_path, &Value::Null);
    write_spec(&global_path, &Value::Null);

    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(steps.len() >= 470, "{} db steps", steps.len());
    assert!(
        cases.len() >= 50 && calls >= 59,
        "{} cases, {calls} calls",
        cases.len()
    );
}
