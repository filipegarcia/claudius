//! `POST /api/sessions/rename` (CC 2.1.309, R05) on the real binary,
//! replayed against what `rust/scripts/cc2309-golden.mjs` recorded from the
//! real handler (`claudius-core/tests/fixtures/cc2309_golden.json`,
//! `renameRoute`).
//!
//! Each case gets a fresh world (the recorded `renameWorld`: a
//! `workspaces.json` written verbatim and per-root SQL through the real
//! database layer) and a fresh server, plus the case's transcript when it
//! has one. Checked: the status and body byte for byte, the `sessions` rows
//! of both workspaces (with the stamps the request wrote read as `$NOW`),
//! and the transcript's lines.
//!
//! Cases Rust knowingly answers differently are in [`KNOWN`] with the
//! reason; a stale entry fails. The two live-session cases drive a stand-in
//! `Session.rename`, which can't be rebuilt here — the live branch runs on
//! the fake CLI in `claudius-core/tests/session_fake.rs`.
#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use claudius_core::db::{Mode, open_path, sqlite_message};
use claudius_core::paths::encode_project_dir;
use common::{Server, World, http};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

/// `(case, reason)`: where Rust knowingly differs from the recording.
const KNOWN: &[(&str, &str)] = &[
    // Pre-existing (the 2.1.309 diff didn't touch the id check): the TS
    // reads any truthy `sessionId`, so a number reaches `retitleIndexed-
    // Session` (bound as a number, matching no TEXT row) and then the SDK's
    // `Invalid sessionId: 5`. Rust's body reader takes a string id only and
    // answers the 400 of a missing one.
    (
        "a number session id",
        "a non-string sessionId is the 400 here",
    ),
    // Same class: `body.dir` of any type reaches the SDK, which throws
    // `e.normalize is not a function`; Rust reads a string `dir` or none, so
    // the lookup falls back to every project dir.
    ("a non-string dir", "a non-string dir reads as no dir here"),
];

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../claudius-core/tests/fixtures/cc2309_golden.json"
    ))
    .unwrap()
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

struct Case<'a> {
    world: &'a World,
    root: String,
}

impl Case<'_> {
    fn abs(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    fn rel(&self, s: &str) -> String {
        s.replace(&self.root, "$ROOT")
    }

    fn db_file(&self, root: &str) -> PathBuf {
        self.world
            .home
            .join(".claude/projects")
            .join(encode_project_dir(root))
            .join(".claudius.db")
    }

    /// The recorded world: the store verbatim, then each root's SQL through
    /// the real `openDb` (so the schema is the shared one).
    fn build(&self, spec: &Value) {
        let store = self.world.home.join(".claude/.claudius/workspaces.json");
        std::fs::create_dir_all(store.parent().unwrap()).unwrap();
        std::fs::write(&store, self.abs(str_of(&spec["store"]))).unwrap();
        for r in spec["roots"].as_array().unwrap() {
            let root = self.abs(str_of(&r["root"]));
            // By path: this process's home isn't the world's, so the
            // database must not be reached through `open_db`.
            let db = open_path(&self.db_file(&root), Mode::ReadWrite).unwrap();
            for sql in r["sql"].as_array().into_iter().flatten() {
                db.execute_batch(&self.abs(str_of(sql))).unwrap();
            }
        }
    }

    /// The recorder's `dump(roots)`.
    fn dump(&self, spec: &Value, window: (i64, i64)) -> Value {
        let mut out = serde_json::Map::new();
        for r in spec["roots"].as_array().unwrap() {
            let key = str_of(&r["root"]).to_owned();
            let file = self.db_file(&self.abs(&key));
            out.insert(key, dump_rows(&file, window));
        }
        Value::Object(out)
    }

    /// The transcript of `id` under the first root, line by line.
    fn transcript(&self, id: &str, spec: &Value) -> Option<Vec<String>> {
        let root = self.abs(str_of(&spec["roots"][0]["root"]));
        let file = self
            .world
            .config
            .join("projects")
            .join(claudius_core::paths::sdk_project_dir_name(&root))
            .join(format!("{id}.jsonl"));
        let text = std::fs::read_to_string(file).ok()?;
        Some(
            text.lines()
                .filter(|l| !l.is_empty())
                .map(|l| self.rel(l))
                .collect(),
        )
    }

    /// Write the case's transcript, as the recorder did.
    fn write_transcript(&self, id: &str, spec: &Value) {
        let root = self.abs(str_of(&spec["roots"][0]["root"]));
        let dir = self
            .world
            .config
            .join("projects")
            .join(claudius_core::paths::sdk_project_dir_name(&root));
        std::fs::create_dir_all(&dir).unwrap();
        let line = json!({"parentUuid": null, "isSidechain": false, "type": "user",
            "message": {"role": "user", "content": "hello"},
            "uuid": format!("{}-0000-4000-8000-000000000001", &id[..8]),
            "timestamp": "2026-10-01T10:00:00.000Z", "cwd": root, "sessionId": id});
        std::fs::write(dir.join(format!("{id}.jsonl")), format!("{line}\n")).unwrap();
    }
}

/// `{rows}` or `{error}` for one database file, as the recorder dumped it.
fn dump_rows(file: &Path, window: (i64, i64)) -> Value {
    let conn = match Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(e) => return json!({"error": sqlite_message(&e)}),
    };
    let mut st = match conn.prepare(
        "SELECT typeof(id), CAST(id AS TEXT), typeof(title), CAST(title AS TEXT), updated_at
           FROM sessions ORDER BY rowid",
    ) {
        Ok(st) => st,
        Err(e) => return json!({"error": sqlite_message(&e)}),
    };
    let rows = st.query_map([], |r| {
        let stamp: Option<i64> = r.get(4)?;
        Ok(json!([
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            match stamp {
                Some(v) if v >= window.0 && v <= window.1 => json!("$NOW"),
                Some(v) => json!(v),
                None => Value::Null,
            }
        ]))
    });
    match rows.and_then(|r| r.collect::<rusqlite::Result<Vec<_>>>()) {
        Ok(rows) => json!({"rows": rows}),
        Err(e) => json!({"error": sqlite_message(&e)}),
    }
}

#[test]
fn rename_route_matches_the_ts() {
    let fx = fixture();
    let spec = &fx["renameWorld"];
    let cases = fx["renameRoute"].as_array().unwrap();
    assert!(cases.len() >= 20);
    let mut ran = 0;
    for c in cases {
        let name = str_of(&c["name"]);
        if c["live"] != Value::Null {
            continue; // the live branch: `session_fake.rs`
        }
        let known = KNOWN.iter().find(|(n, _)| *n == name);
        let world = World::new();
        let root = world
            .root
            .path()
            .canonicalize()
            .unwrap()
            .display()
            .to_string();
        let case = Case {
            world: &world,
            root,
        };
        case.build(spec);
        if let Some(id) = c["jsonl"].as_str() {
            case.write_transcript(id, spec);
        }
        let server = Server::spawn(&world, &[]);
        let body = match c["request"]["raw"].as_str() {
            Some(raw) => raw.to_owned(),
            None => case.abs(str_of(&c["request"]["body"])),
        };
        let t0 = now_ms();
        let (status, text) = http(server.port, "POST", "/api/sessions/rename", &body);
        let t1 = now_ms();
        let got = match c["got"]["threw"].as_str() {
            // Next's answer to a thrown handler: an empty 500.
            Some(_) => json!({"status": status, "empty": text.is_empty()}),
            None => json!({"status": status, "body": case.rel(&text)}),
        };
        let want = match c["got"]["threw"].as_str() {
            Some(_) => json!({"status": 500, "empty": true}),
            None => json!({"status": c["got"]["status"], "body": c["got"]["body"]}),
        };
        if let Some((_, reason)) = known {
            assert_ne!(got, want, "{name}: no longer differs ({reason})");
            drop(server);
            continue;
        }
        assert_eq!(got, want, "{name}");
        let dump = case.dump(spec, (t0, t1));
        assert_eq!(dump, c["rows"], "{name}: rows\n got: {dump}");
        if let Some(id) = c["jsonl"].as_str() {
            let tx = case.transcript(id, spec);
            assert_eq!(
                json!(tx),
                c["transcript"],
                "{name}: transcript\n got: {tx:?}"
            );
        }
        drop(server);
        ran += 1;
    }
    assert!(ran >= 20, "only {ran} cases replayed");
    eprintln!("{ran} rename requests replayed");
}
