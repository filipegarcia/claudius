//! Replays `fixtures/loops_golden.json`, recorded from the TS sources by
//! `rust/scripts/loops-golden.mjs`:
//! - `recordLoopTick` / `attachLoopTickTokens` → the stored `loop_ticks`
//!   rows (values and SQLite types) after each step;
//! - `listLoopBreakdown` over hand-written rows, and without a database;
//! - `trackScheduledLoops` over scripted SDK messages: after each step, the
//!   loops, the pending CronCreate entries, the in-flight CronList ids, the
//!   applied stops, the ticks awaiting usage and the session's tick rows
//!   (the tracker's effects run against the database as the session runs
//!   them).

use std::path::PathBuf;
use std::sync::LazyLock;

use claudius_core::db::{Mode, open_db};
use claudius_core::loop_ticks_db::{
    LoopBreakdownRow, LoopTick, attach_loop_tick_tokens, list_loop_breakdown, record_loop_tick,
};
use claudius_core::session_loops::{LoopEffect, LoopTracker, SessionLoop};
use claudius_core::{js_num, paths};
use rusqlite::types::ValueRef;
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/loops_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A private home (where the per-project databases live) for this binary.
static HOME: LazyLock<tempfile::TempDir> = LazyLock::new(|| {
    let d = tempfile::tempdir().unwrap();
    assert!(paths::set_home_override(d.path().to_path_buf()));
    d
});

fn cwd(name: &str) -> String {
    let p = HOME.path().join(name);
    std::fs::create_dir_all(&p).unwrap();
    p.display().to_string()
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

/// The session's rows in id order, as the recorder reads them: every
/// column with its type, minus `id` and `created_at` (types only).
fn stored_rows(cwd: &str, session_id: &str) -> Value {
    let db = open_db(cwd, Mode::ReadWrite).unwrap();
    db.with(|c| {
        let cols: Vec<String> = c
            .prepare("PRAGMA table_info(loop_ticks)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<_>>()?;
        let mut st = c.prepare("SELECT * FROM loop_ticks WHERE session_id = ? ORDER BY id")?;
        let rows = st
            .query_map([session_id], |r| {
                let mut row = Map::new();
                for (i, col) in cols.iter().enumerate() {
                    let (v, t) = cell(r.get_ref(i)?);
                    if col != "id" && col != "created_at" {
                        row.insert(col.clone(), v);
                    }
                    row.insert(format!("{col}:type"), json!(t));
                }
                Ok(Value::Object(row))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Value::Array(rows))
    })
    .unwrap()
}

#[test]
fn ticks_are_stored_like_the_ts_db_layer() {
    let fx = fixture();
    let db = &fx["db"];
    let sid = db["sessionId"].as_str().unwrap();
    let dir = cwd("db");
    for (i, (step, want)) in db["steps"]
        .as_array()
        .unwrap()
        .iter()
        .zip(db["after"].as_array().unwrap())
        .enumerate()
    {
        match step[0].as_str().unwrap() {
            "record" => {
                let t = &step[1];
                record_loop_tick(
                    &dir,
                    &LoopTick {
                        session_id: t["sessionId"].as_str().unwrap().into(),
                        session_title: t["sessionTitle"].as_str().map(str::to_owned),
                        tool_use_id: t["toolUseId"].as_str().unwrap().into(),
                        prompt: t["prompt"].as_str().unwrap().into(),
                        fired_at: t["firedAt"].as_f64().unwrap(),
                        noop: t["noop"].as_bool().unwrap(),
                    },
                );
            }
            "attach" => {
                attach_loop_tick_tokens(&dir, step[1].as_str().unwrap(), step[2].as_f64().unwrap())
            }
            other => panic!("unknown step {other}"),
        }
        assert_eq!(&stored_rows(&dir, sid), want, "after step {i}: {step}");
    }
}

#[test]
fn the_breakdown_matches_list_loop_breakdown() {
    let fx = fixture();
    let b = &fx["breakdown"];
    let dir = cwd("raw");
    let db = open_db(&dir, Mode::ReadWrite).unwrap();
    for row in b["rows"].as_array().unwrap() {
        let o = row.as_object().unwrap();
        let cols: Vec<&String> = o.keys().collect();
        let sql = format!(
            "INSERT INTO loop_ticks({}, created_at) VALUES ({}, 0)",
            cols.iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            vec!["?"; cols.len()].join(", ")
        );
        let vals: Vec<rusqlite::types::Value> = o
            .values()
            .map(|v| match v {
                Value::Null => rusqlite::types::Value::Null,
                Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                Value::Number(n) if n.is_i64() => {
                    rusqlite::types::Value::Integer(n.as_i64().unwrap())
                }
                Value::Number(n) => rusqlite::types::Value::Real(n.as_f64().unwrap()),
                other => panic!("unexpected {other}"),
            })
            .collect();
        db.with(|c| c.execute(&sql, rusqlite::params_from_iter(vals)))
            .unwrap();
    }
    let got: Vec<Value> = list_loop_breakdown(&dir)
        .iter()
        .map(LoopBreakdownRow::to_json)
        .collect();
    assert_eq!(Value::Array(got), b["list"]);
    let none: Vec<Value> = list_loop_breakdown(&cwd("nodb"))
        .iter()
        .map(LoopBreakdownRow::to_json)
        .collect();
    assert_eq!(Value::Array(none), b["noDb"]);
}

fn loops_json(loops: Vec<SessionLoop>) -> Value {
    Value::Array(loops.iter().map(SessionLoop::to_json).collect())
}

#[test]
fn the_tracker_follows_track_scheduled_loops() {
    let fx = fixture();
    let dir = cwd("proj");
    let mut failures = Vec::new();
    for sc in fx["scenarios"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let sid = sc["sessionId"].as_str().unwrap();
        let title = sc["title"].as_str().map(str::to_owned);
        let mut t = LoopTracker::default();
        for (i, (step, want)) in sc["steps"]
            .as_array()
            .unwrap()
            .iter()
            .zip(sc["after"].as_array().unwrap())
            .enumerate()
        {
            // `at`, else the stubbed `Date.now()`.
            let at = step["at"]
                .as_i64()
                .unwrap_or_else(|| step["clock"].as_i64().unwrap());
            for effect in t.track(&step["message"], at) {
                match effect {
                    LoopEffect::RecordTick {
                        tool_use_id,
                        prompt,
                        fired_at,
                        noop,
                    } => record_loop_tick(
                        &dir,
                        &LoopTick {
                            session_id: sid.into(),
                            session_title: title.clone(),
                            tool_use_id,
                            prompt,
                            fired_at: fired_at as f64,
                            noop,
                        },
                    ),
                    LoopEffect::AttachTokens {
                        tool_use_id,
                        tokens,
                    } => attach_loop_tick_tokens(&dir, &tool_use_id, tokens),
                }
            }
            let got = json!({
                "loops": loops_json(t.loops()),
                "pending": loops_json(t.pending()),
                "cronLists": t.pending_cron_lists(),
                "stops": t.applied_wakeup_stops(),
                "attribution": t.pending_tick_attribution(),
                "ticks": stored_rows(&dir, sid),
            });
            // As text, so the loops' key order counts too.
            let (got_text, want_text) = (got.to_string(), want.to_string());
            if got_text != want_text {
                failures.push(format!(
                    "{name} step {i}: {}\n  ts:   {want}\n  rust: {got}",
                    step["message"]
                ));
            }
        }
        t.clear();
        assert!(t.loops().is_empty() && t.pending().is_empty());
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
