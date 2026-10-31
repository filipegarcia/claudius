//! Replays the `db`, `clamp`, `titles` and `active` parts of
//! `fixtures/open_tabs_golden.json`, recorded from the TS sources by
//! `rust/scripts/open-tabs-golden.mjs`:
//! * `db`: `open-tabs-db.ts`'s getters and setters in order over seeded
//!   rows (foreign values in the migrated table, a typeless table, one
//!   without a unique key, other key types, newer / older / broken / non-WAL
//!   DBs), with dumps of the stored rows (SQLite type + value);
//! * `clamp`: the text `setTabLabelMaxWidth` stores for odd numbers;
//! * `titles`: `getSessionTitlesByCwd` (per-cwd probes, the workspace
//!   fan-out, the legacy `session-titles.json` shadow read) as Map entries;
//! * `active`: `resolveActiveCwd()` under the customization / workspace
//!   cookies, over odd store files.
//!
//! The four run in this order on one world (one home), as recorded. The
//! `steps` part (the route) replays against the real binary in
//! `claudius-server/tests/open_tabs.rs`.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use claudius_agent::js;
use claudius_core::active_cwd::resolve_active_cwd;
use claudius_core::db::{Mode, open_db};
use claudius_core::{js_num, open_tabs, paths, sessions_db};
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

/// The fixture, parsed as `JSON.parse` would (it holds lone-surrogate
/// escapes, which become U+FFFD).
fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/open_tabs_golden.json");
    js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A private home (where the per-project databases and the stores live).
static HOME: LazyLock<tempfile::TempDir> = LazyLock::new(|| {
    let d = tempfile::tempdir().unwrap();
    assert!(paths::set_home_override(d.path().to_path_buf()));
    d
});

fn home() -> String {
    HOME.path().display().to_string()
}

/// The fallback cwd (`process.cwd()`), this test's own.
fn proc_dir() -> String {
    std::env::current_dir().unwrap().display().to_string()
}

fn sym(s: &str) -> String {
    s.replace(&proc_dir(), "$PROC").replace(&home(), "$HOME")
}

fn unsym(s: &str) -> String {
    s.replace("$PROC", &proc_dir()).replace("$HOME", &home())
}

/// The recorder's row dump: `[typeof(key), key, typeof(value), value]`,
/// integers as their decimal text, blobs as hex.
const ROWS_SQL: &str = "SELECT
    typeof(key), CASE typeof(key) WHEN 'integer' THEN CAST(key AS TEXT) WHEN 'blob' THEN hex(key) ELSE key END,
    typeof(value), CASE typeof(value) WHEN 'integer' THEN CAST(value AS TEXT) WHEN 'blob' THEN hex(value) ELSE value END
  FROM ui_state ORDER BY rowid";

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(f) => js_num(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(_) => panic!("the dump hexes blobs"),
    }
}

/// The rows through a separate read-only connection, like the recorder's.
pub fn rows_at(path: &Path) -> Value {
    if !path.exists() {
        return json!({"nodb": true});
    }
    let read = || -> rusqlite::Result<Vec<Vec<Value>>> {
        let c = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut st = c.prepare(ROWS_SQL)?;
        let rows = st.query_map([], |r| (0..4).map(|i| Ok(cell(r.get_ref(i)?))).collect())?;
        rows.collect()
    };
    match read() {
        Ok(r) => json!(r),
        Err(e) => json!({"error": sqlite_message(&e)}),
    }
}

/// better-sqlite3's `SqliteError.message`: SQLite's own text.
fn sqlite_message(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(m)) => m.clone(),
        e => e.to_string(),
    }
}

fn exists(cwd: &str) -> Value {
    let path = paths::db_path(cwd);
    json!({"dir": path.parent().unwrap().exists(), "db": path.exists()})
}

/// The recorder's `runSql`: on the migrated DB, or (`fresh`) on a bare file
/// (left out of WAL mode with `journal: "delete"`).
fn run_sql(s: &Value) {
    let cwd = unsym(s["cwd"].as_str().unwrap());
    let sql = s["sql"].as_str().unwrap();
    if s["fresh"] == true {
        let path = paths::db_path(&cwd);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let c = rusqlite::Connection::open(path).unwrap();
        if s["journal"] != "delete" {
            c.pragma_update(None, "journal_mode", "WAL").unwrap();
        }
        c.execute_batch(sql).unwrap();
    } else {
        open_db(&cwd, Mode::ReadWrite)
            .unwrap()
            .with(|c| c.execute_batch(sql))
            .unwrap();
    }
}

/// The recorder's world edits: a file under the home, or garbage at a DB
/// path. `false` for any other step.
fn world(s: &Value) -> bool {
    match s["op"].as_str() {
        Some("file") => {
            let path = HOME.path().join(s["path"].as_str().unwrap());
            remove(&path);
            if s["rm"] == true {
                return true;
            }
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            if s["dir"] == true {
                std::fs::create_dir(&path).unwrap();
            } else if let Some(hex) = s["hex"].as_str() {
                std::fs::write(&path, unhex(hex)).unwrap();
            } else {
                std::fs::write(&path, s["text"].as_str().unwrap()).unwrap();
            }
            true
        }
        Some("sql") => {
            run_sql(s);
            true
        }
        Some("dbfile") => {
            dbfile(s);
            true
        }
        _ => false,
    }
}

fn dbfile(s: &Value) {
    let path = paths::db_path(&unsym(s["cwd"].as_str().unwrap()));
    remove(&path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    if s["dir"] == true {
        std::fs::create_dir(&path).unwrap();
    } else {
        std::fs::write(&path, s["text"].as_str().unwrap()).unwrap();
    }
}

fn remove(path: &Path) {
    if path.is_dir() {
        std::fs::remove_dir_all(path).unwrap();
    } else if path.exists() {
        std::fs::remove_file(path).unwrap();
    }
}

pub fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// The recorder's `readAll`: all four getters.
fn read_all(cwd: &str) -> Value {
    json!({
        "openTabs": open_tabs::get_open_tabs(cwd),
        "pinned": open_tabs::get_pinned_tabs(cwd),
        "active": open_tabs::get_active_tab(cwd),
        "width": open_tabs::get_tab_label_max_width(cwd).map(js_num),
    })
}

/// A setter's result as the recorder views it. rusqlite appends the path to
/// SQLite's "unable to open database file"; better-sqlite3 doesn't.
fn done(cwd: &str, r: anyhow::Result<()>) -> Value {
    match r {
        Ok(()) => json!({"undefined": true}),
        Err(e) => {
            let msg = e.to_string();
            let suffix = format!(": {}", paths::db_path(cwd).display());
            json!({"threw": msg.strip_suffix(&suffix).unwrap_or(&msg)})
        }
    }
}

fn ids(arg: &Value) -> Vec<&str> {
    arg.as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

/// Where Rust is known to differ, and why. Each one must still differ, so
/// the list can't go stale.
fn known_difference(s: &Value, previous: &[Value]) -> Option<&'static str> {
    let lit = s["lit"].as_str().unwrap_or_default();
    if s["fn"] == "lit" && lit.contains(&"[".repeat(150)) && lit.contains("\"x\"") {
        // serde_json stops at 127 levels: the deep array doesn't parse, so
        // the "x" beside it isn't read either.
        return Some("nesting past 127 levels");
    }
    // A lone surrogate in the id: JS's `JSON.stringify` writes it as a
    // `\ud800` escape; a Rust string holds U+FFFD, which is written as is.
    let after_lone_active = previous
        .iter()
        .rev()
        .find(|p| p["fn"] != "readAll")
        .is_some_and(|p| {
            p["fn"] == "setActiveTab" && p["arg"].as_str().is_some_and(|a| a.contains('\u{fffd}'))
        });
    if s["fn"] == "rows" && after_lone_active {
        return Some("lone surrogate written as U+FFFD");
    }
    None
}

#[test]
fn module_parts_replay_the_ts_in_order() {
    let _ = &*HOME;
    let fx = fixture();
    let mut failures = vec![];
    let mut known = vec![];
    let mut check = |part: &str, i: usize, s: &Value, got: Value, why: Option<&str>| {
        let (want, got) = (js::stringify(&s["got"]), js::stringify(&got));
        match (want == got, why) {
            (true, None) => {}
            (false, Some(why)) => known.push(format!("{part} #{i}: {why}")),
            (true, Some(why)) => failures.push(format!("{part} #{i}: listed ({why}) but equal")),
            (false, None) => failures.push(format!(
                "{part} #{i} {}\n  want {want}\n  got  {got}",
                js::stringify(&json!({"fn": s["fn"], "op": s["op"], "cwd": s["cwd"], "arg": s["arg"], "lit": s["lit"], "pairs": s["pairs"], "cust": s["cust"], "ws": s["ws"]}))
            )),
        }
    };

    // ---- db ----
    let steps = fx["db"].as_array().unwrap();
    assert!(steps.len() >= 200, "only {} db steps", steps.len());
    for (i, s) in steps.iter().enumerate() {
        let cwd = unsym(s["cwd"].as_str().unwrap());
        let got = match s["fn"].as_str().unwrap() {
            "sql" => {
                run_sql(s);
                continue;
            }
            "dbfile" => {
                dbfile(s);
                continue;
            }
            "rows" => rows_at(&paths::db_path(&cwd)),
            "exists" => exists(&cwd),
            "readAll" | "lit" => read_all(&cwd),
            "setOpenTabs" => done(&cwd, open_tabs::set_open_tabs(&cwd, &ids(&s["arg"]))),
            "setPinnedTabs" => done(&cwd, open_tabs::set_pinned_tabs(&cwd, &ids(&s["arg"]))),
            "setActiveTab" => done(&cwd, open_tabs::set_active_tab(&cwd, s["arg"].as_str())),
            "setTabLabelMaxWidth" => done(
                &cwd,
                open_tabs::set_tab_label_max_width(&cwd, s["arg"].as_f64().unwrap()),
            ),
            other => panic!("fn {other}"),
        };
        check("db", i, s, got, known_difference(s, &steps[..i]));
    }

    // ---- clamp ----
    let cases = fx["clamp"].as_array().unwrap();
    assert!(cases.len() >= 30);
    let clamp_cwd = "/claudius-golden/db-clamp";
    for (i, c) in cases.iter().enumerate() {
        let n: f64 = match c["n"].as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            s => s.parse().unwrap(),
        };
        open_tabs::set_tab_label_max_width(clamp_cwd, n).unwrap();
        let rows = rows_at(&paths::db_path(clamp_cwd));
        let stored = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r[1] == "tab_label_max_width")
            .map(|r| r[3].clone())
            .unwrap();
        check(
            "clamp",
            i,
            &json!({"arg": c["n"], "got": c["stored"]}),
            stored,
            None,
        );
    }

    // ---- titles ----
    let steps = fx["titles"].as_array().unwrap();
    assert!(steps.len() >= 60);
    for (i, s) in steps.iter().enumerate() {
        if world(s) {
            continue;
        }
        let owned: Vec<(Option<String>, String)> = s["pairs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["cwd"].as_str().map(unsym),
                    p["id"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        let pairs: Vec<(Option<&str>, &str)> = owned
            .iter()
            .map(|(c, id)| (c.as_deref(), id.as_str()))
            .collect();
        let got = match sessions_db::get_session_titles_by_cwd(&pairs) {
            Ok(m) => Value::Array(m.iter().map(|(k, v)| json!([sym(k), v])).collect()),
            Err(e) => json!({"threw": e.to_string()}),
        };
        check("titles", i, s, got, None);
    }

    // ---- active ----
    let steps = fx["active"].as_array().unwrap();
    assert!(steps.len() >= 80);
    for (i, s) in steps.iter().enumerate() {
        if world(s) {
            continue;
        }
        let r = resolve_active_cwd(s["cust"].as_str(), s["ws"].as_str());
        let cwd = match &r.cwd {
            Some(Value::String(c)) => json!(sym(c)),
            Some(v) => json!({"nonString": js::stringify(v)}),
            None => json!({"nonString": "undefined"}),
        };
        let got = json!({"cwd": cwd, "customizationId": r.customization_id, "ws": r.workspace});
        check("active", i, s, got, None);
    }

    eprintln!("known differences:\n  {}", known.join("\n  "));
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(known.len(), 2, "{known:?}");
}
