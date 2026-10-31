//! Replays the database half of `fixtures/tasks_golden.json`, recorded from
//! the TS sources by `rust/scripts/tasks-golden.mjs`: `saveSessionTask` →
//! the stored rows (values and SQLite types) and `listSessionTasks` after
//! each save, and `listSessionTasks` over hand-written rows. The capture
//! half (`captureTaskState` + `persistTask`) replays in src/session.rs.

use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

use claudius_core::db::{Mode, open_db};
use claudius_core::session_tasks_db::{TaskEntry, list_session_tasks, save_session_task};
use claudius_core::{js_num, paths};
use rusqlite::types::{Value as Sql, ValueRef};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tasks_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A private home (where the per-project databases live) for this binary.
static HOME: LazyLock<tempfile::TempDir> = LazyLock::new(|| {
    let d = tempfile::tempdir().unwrap();
    assert!(paths::set_home_override(d.path().to_path_buf()));
    d
});

fn cwd(name: &str) -> String {
    HOME.path().join(name).display().to_string()
}

/// A `TaskSnapshotEntry` (the camelCase JSON) as the Rust struct.
fn entry(v: &Value) -> TaskEntry {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let n = |k: &str| v.get(k).and_then(Value::as_f64);
    let b = |k: &str| v.get(k).and_then(Value::as_bool);
    TaskEntry {
        task_id: s("taskId").unwrap(),
        tool_use_id: s("toolUseId"),
        subagent_type: s("subagentType"),
        description: s("description"),
        task_type: s("taskType"),
        workflow_name: s("workflowName"),
        status: s("status").unwrap(),
        total_tokens: n("totalTokens"),
        tool_uses: n("toolUses"),
        duration_ms: n("durationMs"),
        summary: s("summary"),
        error: s("error"),
        is_backgrounded: b("isBackgrounded"),
        spawn_depth: n("spawnDepth"),
        ambient: b("ambient"),
        resource_links: v.get("resourceLinks").cloned(),
        reason: s("reason"),
        output_file: s("outputFile"),
        inner_messages: v["innerMessages"].as_array().cloned().unwrap_or_default(),
    }
}

fn listed(cwd: &str, sid: &str) -> String {
    let tasks: Vec<Value> = list_session_tasks(cwd, sid)
        .iter()
        .map(TaskEntry::to_json)
        .collect();
    Value::Array(tasks).to_string()
}

/// A cell as better-sqlite3 hands it to JS, with its `typeof()`.
fn cell(v: ValueRef) -> (Value, &'static str) {
    match v {
        ValueRef::Null => (Value::Null, "null"),
        ValueRef::Integer(n) => (json!(n), "integer"),
        ValueRef::Real(f) => (js_num(f), "real"),
        ValueRef::Text(t) => (json!(String::from_utf8_lossy(t)), "text"),
        ValueRef::Blob(_) => panic!("no blobs expected"),
    }
}

/// The session's rows in rowid order, as the recorder reads them: every
/// column then its SQLite type (`updated_at`: the type only).
fn stored_rows(cwd: &str, sid: &str) -> String {
    let db = open_db(cwd, Mode::ReadWrite).unwrap();
    let rows = db
        .with(|c| {
            let cols: Vec<String> = c
                .prepare("PRAGMA table_info(session_tasks)")?
                .query_map([], |r| r.get(1))?
                .collect::<rusqlite::Result<_>>()?;
            let mut st =
                c.prepare("SELECT * FROM session_tasks WHERE session_id = ? ORDER BY rowid")?;
            st.query_map([sid], |r| {
                let mut m = Map::new();
                for (i, col) in cols.iter().enumerate() {
                    let (v, t) = cell(r.get_ref(i)?);
                    if col != "updated_at" {
                        m.insert(col.clone(), v);
                    }
                    m.insert(format!("{col}:type"), json!(t));
                }
                Ok(Value::Object(m))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    Value::Array(rows).to_string()
}

fn sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::String(s) => Sql::Text(s.clone()),
        Value::Number(n) => n
            .as_i64()
            .map_or_else(|| Sql::Real(n.as_f64().unwrap()), Sql::Integer),
        other => panic!("unexpected cell {other}"),
    }
}

/// Insert hand-written rows (column → value) the way the recorder does.
fn insert_rows(cwd: &str, sid: &str, rows: &[Value]) {
    let db = open_db(cwd, Mode::ReadWrite).unwrap();
    for (i, row) in rows.iter().enumerate() {
        let row = row.as_object().unwrap();
        let cols: Vec<&str> = row.keys().map(String::as_str).collect();
        let marks = vec!["?"; cols.len()].join(", ");
        let mut vals = vec![Sql::Text(sid.into())];
        vals.extend(row.values().map(sql));
        vals.push(Sql::Integer(1000 + i as i64));
        db.with(|c| {
            c.execute(
                &format!(
                    "INSERT INTO session_tasks(session_id, {}, updated_at) VALUES (?, {marks}, ?)",
                    cols.join(", ")
                ),
                rusqlite::params_from_iter(vals),
            )
        })
        .unwrap();
    }
}

#[test]
fn saves_store_and_list_like_ts() {
    let fx = fixture();
    let save = &fx["save"];
    let (cwd, sid) = (cwd("save"), "golden-save");
    let entries = save["entries"].as_array().unwrap();
    let after = save["after"].as_array().unwrap();
    assert_eq!(entries.len(), after.len());
    for (i, (e, want)) in entries.iter().zip(after).enumerate() {
        save_session_task(&cwd, sid, &entry(e)).unwrap();
        assert_eq!(
            stored_rows(&cwd, sid),
            want["rows"].to_string(),
            "rows after save {i}"
        );
        assert_eq!(
            listed(&cwd, sid),
            want["list"].to_string(),
            "list after save {i}"
        );
        // Distinct `updated_at`s: the list is oldest update first.
        std::thread::sleep(Duration::from_millis(3));
    }
}

#[test]
fn hand_written_rows_list_like_ts() {
    let fx = fixture();
    let raw = &fx["raw"];
    let (cwd, sid) = (cwd("raw"), "golden-raw");
    insert_rows(&cwd, sid, raw["rows"].as_array().unwrap());
    assert_eq!(listed(&cwd, sid), raw["list"].to_string());
}

/// Text SQLite kept in a number column (TS would hand it back raw) reads
/// as no number, a set flag, and doesn't sink the rest of the list.
#[test]
fn text_in_number_columns_reads_leniently() {
    let (cwd, sid) = (cwd("lenient"), "lenient");
    insert_rows(
        &cwd,
        sid,
        &[
            json!({"task_id": "odd", "status": "running", "inner_messages": "[]",
                   "total_tokens": "many", "tool_uses": "", "duration_ms": 2.5,
                   "is_backgrounded": "yes", "ambient": "", "spawn_depth": "deep"}),
            json!({"task_id": "ok", "status": "completed", "inner_messages": "[]", "ambient": 0}),
        ],
    );
    let tasks = list_session_tasks(&cwd, sid);
    assert_eq!(tasks.len(), 2);
    let odd = &tasks[0];
    assert_eq!(
        (
            odd.total_tokens,
            odd.tool_uses,
            odd.duration_ms,
            odd.spawn_depth
        ),
        (None, None, Some(2.5), None)
    );
    assert_eq!((odd.is_backgrounded, odd.ambient), (Some(true), Some(true)));
    assert_eq!(
        (tasks[1].task_id.as_str(), tasks[1].ambient),
        ("ok", Some(false))
    );
}

/// No database yet: nothing listed, and listing doesn't create one.
#[test]
fn no_database_lists_nothing() {
    let cwd = cwd("never-opened");
    assert!(list_session_tasks(&cwd, "s").is_empty());
    assert!(!paths::db_path(&cwd).exists());
}
