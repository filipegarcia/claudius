//! The CC 2.1.309 session set (R05), replayed against what
//! `rust/scripts/cc2309-golden.mjs` recorded from the real TS
//! (`tests/fixtures/cc2309_golden.json`):
//!
//! * `history`: `lib/shared/session-history.ts` `isHistoryWorthyDbRow` over
//!   the row shapes better-sqlite3 hands JS, the `TypeError` on a truthy
//!   non-string title included
//!   ([`session_history::is_history_worthy_db_row`]);
//! * `rm`: `lib/shared/dangerous-rm-deny.ts` `bypassDangerousRmDenial` over
//!   the engine's real `decision_reason` forms, every mode, ANSI, a forced
//!   ask rule, odd types and the 600-code-point cap
//!   ([`dangerous_rm_deny::bypass_dangerous_rm_denial`]);
//! * `retitle`: `sessions-db.ts` `retitleIndexedSession` on the real
//!   database layer — each case's `workspaces.json` and per-root state are
//!   rebuilt in a temp home, then the result (or the thrown message) and
//!   every root's `sessions` rows are compared
//!   ([`sessions_db::retitle_indexed_session`]);
//! * `session`: the `flushPendingTitleMirror` cases' appends, through
//!   [`session_titles::mirror_after_append`] (the rename cases run on the
//!   fake CLI in `session_fake.rs`).
//!
//! The route's own cases replay on the real binary in
//! `claudius-server/tests/cc2309_rename.rs`.
#![cfg(unix)]

use std::path::{Path, PathBuf};

use claudius_core::asset_list::Cell;
use claudius_core::db::{self, Mode};
use claudius_core::session_history::{self, HistoryTitle};
use claudius_core::session_titles::{self, MirrorAfterAppend};
use claudius_core::{dangerous_rm_deny, paths, sessions_db};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/cc2309_golden.json")).unwrap()
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

/// A recorded JS value (`JSON.stringify` text) as the filter reads a title.
fn history_title(v: &Value) -> HistoryTitle<'_> {
    match v {
        Value::Null => HistoryTitle::Falsy,
        Value::String(s) if s.is_empty() => HistoryTitle::Falsy,
        Value::String(s) => HistoryTitle::Text(s),
        Value::Bool(false) => HistoryTitle::Falsy,
        Value::Number(n) if n.as_f64() == Some(0.0) => HistoryTitle::Falsy,
        _ => HistoryTitle::NoTrim,
    }
}

#[test]
fn history_filter_matches_the_ts() {
    let fx = fixture();
    let cases = fx["history"].as_array().unwrap();
    assert!(cases.len() >= 70);
    for c in cases {
        let name = str_of(&c["name"]);
        let title: Value = serde_json::from_str(str_of(&c["title"])).unwrap();
        let id = str_of(&c["id"]);
        let live = c["live"].as_bool().unwrap();
        let mut asked: Vec<Value> = Vec::new();
        let got = session_history::is_history_worthy_db_row(history_title(&title), || {
            asked.push(json!(id));
            live
        });
        match (&got, c.get("throws")) {
            (Err(msg), Some(want)) => assert_eq!(*msg, str_of(want), "{name}"),
            (Err(msg), None) => panic!("{name}: threw {msg}, want {}", c["result"]),
            (Ok(v), None) => assert_eq!(
                claudius_agent::js::stringify(&json!(v)),
                str_of(&c["result"]),
                "{name}"
            ),
            (Ok(v), Some(want)) => panic!("{name}: got {v}, want a throw: {want}"),
        }
        // `isLive(row.id)` is asked only when the title can't decide.
        let want_asked: Vec<Value> = c["asked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| serde_json::from_str(str_of(v)).unwrap())
            .collect();
        assert_eq!(asked, want_asked, "{name}: isLive calls");
    }
}

/// The cells a `sessions.title` column can hold read as the same cases.
#[test]
fn title_cells_classify_like_the_js_values() {
    for (cell, want) in [
        (Cell::Null, HistoryTitle::Falsy),
        (Cell::Text(String::new()), HistoryTitle::Falsy),
        (Cell::Text("x".into()), HistoryTitle::Text("x")),
        (Cell::Num(0.0), HistoryTitle::Falsy),
        (Cell::Num(5.0), HistoryTitle::NoTrim),
        (Cell::Blob(Vec::new()), HistoryTitle::NoTrim),
        (Cell::Blob(b"hi".to_vec()), HistoryTitle::NoTrim),
    ] {
        assert_eq!(session_history::title_of(&cell), want, "{cell:?}");
    }
    // Only a TEXT id can name a live session (the manager's map is keyed by
    // string).
    assert!(session_history::id_is_live(
        &Cell::Text("a".into()),
        |id| id == "a"
    ));
    assert!(!session_history::id_is_live(&Cell::Num(5.0), |_| true));
    assert!(!session_history::id_is_live(
        &Cell::Blob(b"a".to_vec()),
        |_| { true }
    ));
    assert!(!session_history::id_is_live(&Cell::Null, |_| true));
}

#[test]
fn dangerous_rm_denial_matches_the_ts() {
    let fx = fixture();
    let cases = fx["rm"].as_array().unwrap();
    assert!(cases.len() >= 200);
    assert_eq!(
        dangerous_rm_deny::DANGEROUS_RM_REWRITE_HINT,
        str_of(&fx["hint"]),
        "the hint text"
    );
    for c in cases {
        let name = str_of(&c["name"]);
        let ask: Value = serde_json::from_str(str_of(&c["ask"])).unwrap();
        let got = dangerous_rm_deny::bypass_dangerous_rm_denial(
            str_of(&c["permissionMode"]),
            ask["decisionReason"].as_str(),
            ask["decisionReasonType"].as_str(),
            ask.get("matchedAskRule")
                .is_some_and(claudius_agent::js::truthy),
        );
        assert_eq!(
            claudius_agent::js::stringify(&json!(got)),
            str_of(&c["result"]),
            "{name}"
        );
    }
}

// ───────────────────────────── retitle ─────────────────────────────

/// A temp home for the `retitle` cases: `$ROOT/home` is the state home,
/// `$ROOT/config` the SDK's config dir.
struct World {
    _dir: tempfile::TempDir,
    root: String,
}

impl World {
    fn new() -> World {
        let dir = tempfile::Builder::new()
            .prefix("cc2309-golden-")
            .tempdir()
            .unwrap();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        std::fs::create_dir_all(format!("{root}/home")).unwrap();
        std::fs::create_dir_all(format!("{root}/config")).unwrap();
        assert!(paths::set_home_override(PathBuf::from(format!(
            "{root}/home"
        ))));
        assert!(paths::set_config_dir_override(PathBuf::from(format!(
            "{root}/config"
        ))));
        World { _dir: dir, root }
    }

    fn abs(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    fn store_path(&self) -> PathBuf {
        PathBuf::from(format!(
            "{}/home/.claude/.claudius/workspaces.json",
            self.root
        ))
    }

    fn projects(&self) -> PathBuf {
        PathBuf::from(format!("{}/home/.claude/projects", self.root))
    }

    fn db_file(&self, root: &str) -> PathBuf {
        self.projects()
            .join(paths::encode_project_dir(root))
            .join(".claudius.db")
    }

    /// The recorder's `reset()` + `build(spec)`.
    fn build(&self, spec: &Value, roots: &[Value]) {
        for r in roots {
            db::close_db(&self.abs(str_of(&r["root"])));
        }
        let _ = std::fs::remove_dir_all(self.projects());
        let _ = std::fs::remove_dir_all(self.store_path().parent().unwrap());
        std::fs::create_dir_all(self.store_path().parent().unwrap()).unwrap();
        if let Some(store) = spec.as_str() {
            std::fs::write(self.store_path(), self.abs(store)).unwrap();
        }
        for r in roots {
            let root = self.abs(str_of(&r["root"]));
            if let Some(raw) = r.get("raw") {
                let file = self.db_file(&root);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                match raw {
                    Value::Null => {
                        std::fs::write(&file, "not a database, just text\n".repeat(40)).unwrap()
                    }
                    sql => {
                        let c = Connection::open(&file).unwrap();
                        c.pragma_update(None, "journal_mode", "WAL").unwrap();
                        c.execute_batch(&self.abs(str_of(sql))).unwrap();
                    }
                }
                continue;
            }
            if r["dir"] == json!(true) {
                std::fs::create_dir_all(self.db_file(&root).parent().unwrap()).unwrap();
                continue;
            }
            let db = db::open_db(&root, Mode::ReadWrite).unwrap();
            for sql in r["sql"].as_array().into_iter().flatten() {
                db.with(|c| c.execute_batch(&self.abs(str_of(sql))))
                    .unwrap();
            }
            db::close_db(&root);
        }
    }

    /// The recorder's `dump(roots)`: each root's `sessions` rows as
    /// `[typeof(id), id, typeof(title), title, updated_at]`, or the error.
    fn dump(&self, roots: &[Value], window: (i64, i64)) -> Value {
        let mut out = serde_json::Map::new();
        for r in roots {
            let key = str_of(&r["root"]).to_owned();
            let file = self.db_file(&self.abs(&key));
            out.insert(key, dump_rows(&file, window));
        }
        Value::Object(out)
    }
}

/// `{rows}` or `{error}` for one database file.
fn dump_rows(file: &Path, window: (i64, i64)) -> Value {
    let open = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY);
    let conn = match open {
        Ok(c) => c,
        Err(e) => return json!({"error": db::sqlite_message(&e)}),
    };
    let rows = conn.prepare(
        "SELECT typeof(id), CAST(id AS TEXT), typeof(title), CAST(title AS TEXT), updated_at
           FROM sessions ORDER BY rowid",
    );
    let mut st = match rows {
        Ok(st) => st,
        Err(e) => return json!({"error": db::sqlite_message(&e)}),
    };
    let got = st.query_map([], |r| {
        let stamp: Option<i64> = r.get(4)?;
        Ok(json!([
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            match stamp {
                // Written during the call: the recorder's "$NOW".
                Some(v) if v >= window.0 && v <= window.1 => json!("$NOW"),
                Some(v) => json!(v),
                None => Value::Null,
            }
        ]))
    });
    match got.and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>()) {
        Ok(rows) => json!({"rows": rows}),
        Err(e) => json!({"error": db::sqlite_message(&e)}),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// The one test of this binary: `homedir()` can be pinned only once.
#[test]
fn retitle_matches_the_ts_on_the_real_db_layer() {
    let fx = fixture();
    let cases = fx["retitle"].as_array().unwrap();
    assert!(cases.len() >= 20);
    let w = World::new();
    for c in cases {
        let name = str_of(&c["name"]);
        let roots: Vec<Value> = c["roots"].as_array().cloned().unwrap_or_default();
        w.build(&c["store"], &roots);
        let t0 = now_ms();
        let got = sessions_db::retitle_indexed_session(str_of(&c["id"]), str_of(&c["title"]));
        let t1 = now_ms();
        for r in &roots {
            db::close_db(&w.abs(str_of(&r["root"])));
        }
        match (&got, c.get("throws")) {
            (Ok(n), None) => {
                assert_eq!(n.to_string(), str_of(&c["result"]), "{name}: updated rows")
            }
            (Err(msg), Some(want)) => assert_eq!(msg, str_of(want), "{name}"),
            (Ok(n), Some(want)) => panic!("{name}: got {n}, want a throw: {want}"),
            (Err(msg), None) => panic!("{name}: threw {msg}, want {}", c["result"]),
        }
        let dump = w.dump(&roots, (t0, t1));
        assert_eq!(
            dump, c["rows"],
            "{name}: rows differ\n got: {dump}\nwant: {}",
            c["rows"]
        );
    }
    eprintln!("{} retitle cases replayed", cases.len());
}

// ──────────────────────── the pending title mirror ────────────────────────

/// The `session` cases' flush half: what `flushPendingTitleMirror` appends.
/// The recorder's `racedTo` is what the field reads *after* the append (a
/// newer rename landing while it was in flight); `$none` means it reads the
/// same pending name.
#[test]
fn the_mirror_flush_appends_what_the_ts_appended() {
    let fx = fixture();
    let cases: Vec<&Value> = fx["session"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["name"].as_str().is_some_and(|n| n.starts_with("a flush")))
        .collect();
    assert!(cases.len() >= 7);
    for c in cases {
        let name = str_of(&c["name"]);
        let pending = c["pending"].as_str();
        let title: Value = serde_json::from_str(str_of(&c["after"])).unwrap();
        let had_transcript = c["jsonl"] == json!(true);
        // What the TS appended: the custom-title lines of the transcript
        // (the SDK trims each title as it writes it).
        let appended: Vec<String> = c["transcript"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| serde_json::from_str::<Value>(str_of(l)).ok())
            .filter(|m| m["type"] == "custom-title")
            .map(|m| m["customTitle"].as_str().unwrap_or_default().to_owned())
            .collect();
        let Some(pending) = pending.filter(|_| had_transcript) else {
            // No pending name, or no transcript to append to: nothing lands.
            assert!(appended.is_empty(), "{name}: {appended:?}");
            continue;
        };
        let after: Option<String> = match str_of(&c["racedTo"]) {
            "$none" => Some(pending.to_owned()),
            raced => serde_json::from_str::<Value>(raced)
                .unwrap()
                .as_str()
                .map(str::to_owned),
        };
        let next = session_titles::mirror_after_append(after.as_deref(), pending, title.as_str());
        let mut want = vec![claudius_agent::js::trim(pending).to_owned()];
        if let MirrorAfterAppend::Reassert(t) = &next {
            want.push(claudius_agent::js::trim(t).to_owned());
        }
        assert_eq!(appended, want, "{name}: {next:?}");
    }
}
