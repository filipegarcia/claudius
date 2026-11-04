//! Feedback parity (G10), replayed against what the TS recorded in
//! `tests/fixtures/feedback_golden.json` (`rust/scripts/feedback-golden.mjs`):
//! - `refusals`: `feedback_refusal_reason` and `interpret_feedback_response`
//!   against `feedbackRefusalReason` / `interpretFeedbackResponse`
//!   (lib/shared/feedback-refusal.ts): reason strings (ANSI escapes, control
//!   and whitespace runs, the CLI's "Report issues at" pointer, the
//!   200-code-point cap), odd types, and CLI replies of every shape;
//! - `store`: `insert_feedback` / `list_feedback` against `insertFeedback` /
//!   `listFeedback` called directly, step by step, under a pinned home: the
//!   values bound and read back, the statements' errors, a database that
//!   can't be opened (none yet, a folder), one removed under its cached
//!   handles, and what each step leaves at the database path.
//!
//! The route half (`groups`) is replayed on the real binary by
//! `claudius-server/tests/feedback.rs`.

use std::path::Path;

use claudius_agent::js;
use claudius_core::db::{Mode, open_db};
use claudius_core::feedback_refusal::{feedback_refusal_reason, interpret_feedback_response};
use claudius_core::feedback_store::{FeedbackRecord, insert_feedback, list_feedback};
use claudius_core::{js_num, paths};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/feedback_golden.json")).unwrap()
}

#[test]
fn refusals_match_the_ts() {
    let fx = fixture();
    let cases = fx["refusals"].as_array().unwrap();
    let mut failures = vec![];
    for (i, c) in cases.iter().enumerate() {
        let v = &c["v"];
        let reason = feedback_refusal_reason(v).map_or(Value::Null, Value::String);
        if reason != c["reason"] {
            failures.push(format!(
                "#{i} reason({v})\n  want {}\n  got  {reason}",
                c["reason"]
            ));
        }
        let interpret = interpret_feedback_response(v).to_json();
        if interpret != c["interpret"] {
            failures.push(format!(
                "#{i} interpret({v})\n  want {}\n  got  {interpret}",
                c["interpret"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    assert!(cases.len() >= 100, "{} cases", cases.len());
    // The fixture exercises each outcome.
    let some = |k: &str, f: &dyn Fn(&Value) -> bool| cases.iter().filter(|c| f(&c[k])).count();
    assert!(some("reason", &Value::is_string) >= 40);
    assert!(some("reason", &Value::is_null) >= 30);
    assert!(some("interpret", &|v| v["forwarded"] == false) >= 15);
    assert!(some("interpret", &|v| v.get("reason").is_some()) >= 5);
}

/// The recorder's row dump, column by column.
fn rows_sql() -> String {
    let cols = [
        "id",
        "session_id",
        "cwd",
        "rating",
        "comment",
        "surface",
        "forwarded",
        "attach_transcript",
        "created_at",
    ];
    let cells: Vec<String> = cols
        .iter()
        .map(|c| {
            format!(
                "typeof({c}), CASE typeof({c}) WHEN 'integer' THEN CAST({c} AS TEXT) WHEN 'blob' THEN hex({c}) ELSE {c} END"
            )
        })
        .collect();
    format!("SELECT {} FROM feedback ORDER BY rowid", cells.join(", "))
}

/// Every row in the file on disk, through a fresh read-only connection (the
/// dump's cells are TEXT, REAL or NULL); `null` when that fails.
fn rows(db: &Path) -> Value {
    let dump = || -> rusqlite::Result<Vec<Vec<Value>>> {
        let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut st = c.prepare(&rows_sql())?;
        st.query_map([], |r| {
            (0..18)
                .map(|i| {
                    Ok(match r.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Real(f) => js_num(f),
                        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                        other => panic!("{other:?} in the dump"),
                    })
                })
                .collect()
        })?
        .collect()
    };
    dump().map_or(Value::Null, |rows| json!(rows))
}

/// What is at the database path: `none`, `file` or `dir`.
fn state(db: &Path) -> &'static str {
    match std::fs::metadata(db) {
        Ok(m) if m.is_dir() => "dir",
        Ok(_) => "file",
        Err(_) => "none",
    }
}

fn record(r: &Value) -> FeedbackRecord {
    let text = |k: &str| r[k].as_str().map(str::to_owned);
    FeedbackRecord {
        id: text("id").unwrap(),
        session_id: text("sessionId"),
        rating: text("rating"),
        comment: text("comment").unwrap(),
        surface: text("surface"),
        forwarded: r["forwarded"] == true,
        attach_transcript: r["attachTranscript"] == true,
        created_at: r["createdAt"].as_f64().unwrap(),
    }
}

#[test]
fn the_store_matches_the_ts() {
    let home = tempfile::tempdir().unwrap();
    assert!(
        paths::set_home_override(home.path().to_path_buf()),
        "the home was pinned already"
    );
    let fx = fixture();
    let steps = fx["store"].as_array().unwrap();
    let mut failures = vec![];
    for (i, s) in steps.iter().enumerate() {
        let cwd = s["cwd"].as_str().unwrap();
        let db = paths::db_path(cwd);
        let mut got = Map::new();
        match s["op"].as_str().unwrap() {
            "insert" => {
                let (k, v) = match insert_feedback(cwd, &record(&s["record"])) {
                    Ok(()) => ("ok", json!(true)),
                    Err(e) => ("threw", json!(e.to_string())),
                };
                got.insert(k.into(), v);
            }
            "list" => {
                let (k, v) = match list_feedback(cwd, s["limit"].as_f64().unwrap()) {
                    Ok(items) => ("items", json!(js::stringify(&Value::Array(items)))),
                    Err(e) => ("threw", json!(e.to_string())),
                };
                got.insert(k.into(), v);
            }
            "rows" => {
                got.insert("got".into(), rows(&db));
            }
            "sql" => open_db(cwd, Mode::ReadWrite)
                .unwrap()
                .with(|c| c.execute_batch(s["sql"].as_str().unwrap()))
                .unwrap(),
            "dbdir" => std::fs::create_dir_all(&db).unwrap(),
            "rmdb" => {
                for suffix in ["", "-wal", "-shm"] {
                    let p = format!("{}{suffix}", db.display());
                    let _ = std::fs::remove_file(&p).or_else(|_| std::fs::remove_dir_all(&p));
                }
            }
            op => panic!("{op}"),
        }
        got.insert("state".into(), json!(state(&db)));
        let want: Map<String, Value> = s
            .as_object()
            .unwrap()
            .iter()
            .filter(|(k, _)| !["op", "cwd", "record", "limit", "sql"].contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if js::stringify(&Value::Object(want.clone())) != js::stringify(&Value::Object(got.clone()))
        {
            failures.push(format!(
                "#{i} {} {cwd}\n  want {}\n  got  {}",
                s["op"],
                js::stringify(&Value::Object(want)),
                js::stringify(&Value::Object(got))
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} steps differ:\n{}",
        failures.len(),
        steps.len(),
        failures.join("\n")
    );
    assert!(steps.len() >= 40, "{} steps", steps.len());
}
