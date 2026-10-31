//! Replays the `snooze` and `db` parts of
//! `fixtures/notification_prefs_golden.json`, recorded from the TS sources
//! by `rust/scripts/notification-prefs-golden.mjs`:
//! * `snooze`: the route's `Date.now() + Math.floor(m) * 60_000` for every
//!   (clock, minutes) pair, as the raw `snoozeUntil` text it answered;
//! * `db`: `setSessionPrefs` / `getSessionPrefs` / `isSessionMuted` (at a
//!   pinned clock) in order, with hand-written SQL and dumps of the stored
//!   rows (SQLite type + value), including foreign column values, a table
//!   created with other column types, and a DB whose schema lacks the table.
//!
//! The `steps` part (the route) replays against the real binary in
//! `claudius-server/tests/notification_prefs.rs`.

use std::path::PathBuf;
use std::sync::LazyLock;

use claudius_agent::js;
use claudius_core::db::{Mode, open_db};
use claudius_core::notifications_db::{
    PrefsPatch, get_session_prefs, is_session_muted, is_session_muted_at, set_session_prefs,
    snooze_until,
};
use claudius_core::{js_num, paths};
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/notification_prefs_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A private home (where the per-project databases live) for this binary.
static HOME: LazyLock<tempfile::TempDir> = LazyLock::new(|| {
    let d = tempfile::tempdir().unwrap();
    assert!(paths::set_home_override(d.path().to_path_buf()));
    d
});

/// The recorder's row dump: `[session_id, typeof, value, typeof, value]`,
/// integers as their decimal text, blobs as hex.
pub const ROWS_SQL: &str = "SELECT session_id,
    typeof(blocked), CASE typeof(blocked) WHEN 'integer' THEN CAST(blocked AS TEXT) WHEN 'blob' THEN hex(blocked) ELSE blocked END,
    typeof(snooze_until), CASE typeof(snooze_until) WHEN 'integer' THEN CAST(snooze_until AS TEXT) WHEN 'blob' THEN hex(snooze_until) ELSE snooze_until END
  FROM session_notification_prefs ORDER BY session_id";

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(f) => js_num(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(_) => panic!("the dump hexes blobs"),
    }
}

fn rows(cwd: &str) -> Value {
    open_db(cwd, Mode::ReadWrite)
        .unwrap()
        .with(|c| {
            let mut st = c.prepare(ROWS_SQL)?;
            let rows = st.query_map([], |r| (0..5).map(|i| Ok(cell(r.get_ref(i)?))).collect())?;
            rows.collect::<rusqlite::Result<Vec<Vec<Value>>>>()
        })
        .map(|r| json!(r))
        .unwrap()
}

/// The recorder's `runSql`: on the migrated DB, or (`fresh`) on a bare file.
fn run_sql(cwd: &str, sql: &str, fresh: bool) {
    if fresh {
        let path = paths::db_path(cwd);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let c = rusqlite::Connection::open(path).unwrap();
        c.pragma_update(None, "journal_mode", "WAL").unwrap();
        c.execute_batch(sql).unwrap();
    } else {
        open_db(cwd, Mode::ReadWrite)
            .unwrap()
            .with(|c| c.execute_batch(sql))
            .unwrap();
    }
}

fn patch(v: &Value) -> PrefsPatch {
    PrefsPatch {
        blocked: v.get("blocked").map(|b| b.as_bool().unwrap()),
        snooze_until: v.get("snoozeUntil").map(|s| match s {
            Value::Null => None,
            Value::String(s) if s == "Infinity" => Some(f64::INFINITY),
            n => Some(n.as_f64().unwrap()),
        }),
    }
}

fn threw(e: &anyhow::Error) -> Value {
    json!({"threw": e.to_string()})
}

#[test]
fn snooze_arithmetic_matches_the_route() {
    let fx = fixture();
    let cases = fx["snooze"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let (now, minutes) = (c["now"].as_f64().unwrap(), c["minutes"].as_f64().unwrap());
        let got = js::number_to_string(snooze_until(now, minutes));
        if got != c["got"].as_str().unwrap() {
            failures.push(format!(
                "{now} + {minutes} min: want {} got {got}",
                c["got"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(cases.len() >= 200);
}

#[test]
fn db_functions_replay_the_ts() {
    let _ = &*HOME;
    let fx = fixture();
    let steps = fx["db"].as_array().unwrap();
    let mut failures = vec![];
    for (i, s) in steps.iter().enumerate() {
        let cwd = s["cwd"].as_str().unwrap_or("/claudius-golden/db");
        let id = s["id"].as_str().unwrap_or_default();
        let got = match s["fn"].as_str().unwrap() {
            "sql" => {
                run_sql(cwd, s["sql"].as_str().unwrap(), s["fresh"] == true);
                continue;
            }
            "rows" => rows(cwd),
            "get" => match get_session_prefs(cwd, id) {
                Ok(p) => p.map_or(Value::Null, |p| p.to_json()),
                Err(e) => threw(&e),
            },
            "set" => match set_session_prefs(cwd, id, &patch(&s["patch"])) {
                Ok(p) => p.to_json(),
                Err(e) => threw(&e),
            },
            "muted" => match is_session_muted_at(cwd, id, s["now"].as_f64().unwrap()) {
                Ok(b) => json!(b),
                Err(e) => threw(&e),
            },
            other => panic!("fn {other}"),
        };
        if js::stringify(&got) != js::stringify(&s["got"]) {
            failures.push(format!(
                "#{i} {} {id} {}\n  want {}\n  got  {}",
                s["fn"],
                s.get("patch").or(s.get("now")).unwrap_or(&Value::Null),
                js::stringify(&s["got"]),
                js::stringify(&got)
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
    assert!(steps.len() >= 160);
}

/// `isSessionMuted` on the real clock (the golden pins it).
#[test]
fn muted_on_the_real_clock() {
    let _ = &*HOME;
    let cwd = "/claudius-golden/real-clock";
    let id = |n: u32| format!("00000000-0000-4000-8000-{n:012}");
    assert!(!is_session_muted(cwd, &id(1)).unwrap(), "no DB");
    assert_eq!(get_session_prefs(cwd, &id(1)).unwrap(), None);
    assert!(
        !paths::db_path(cwd).exists(),
        "reading opens read-only: no DB is created"
    );
    let set = |n, blocked, snooze| {
        set_session_prefs(
            cwd,
            &id(n),
            &PrefsPatch {
                blocked,
                snooze_until: snooze,
            },
        )
        .unwrap()
    };
    set(1, Some(false), None);
    assert!(!is_session_muted(cwd, &id(1)).unwrap());
    assert!(!is_session_muted(cwd, &id(9)).unwrap(), "no row");
    set(2, Some(true), None);
    assert!(is_session_muted(cwd, &id(2)).unwrap());
    let now = claudius_core::now_ms() as f64;
    set(3, None, Some(Some(now + 3_600_000.0)));
    assert!(
        is_session_muted(cwd, &id(3)).unwrap(),
        "snoozed for an hour"
    );
    set(4, None, Some(Some(now - 1.0)));
    assert!(!is_session_muted(cwd, &id(4)).unwrap(), "snooze over");
    set(3, None, Some(None));
    assert!(!is_session_muted(cwd, &id(3)).unwrap(), "snooze cleared");
}
