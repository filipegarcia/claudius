//! Replays `fixtures/session_titles_golden.json`, recorded by
//! `rust/scripts/session-titles-golden.mjs` from the real TS: `getSessionTitle`
//! with its legacy `session-titles.json` fallback and row migration
//! (sessions-db.ts), `resolveSessionTitle`, `start()`'s title statements and
//! `Session.prototype.sendFreshTitle` (session.ts), `setSessionTitle` and the
//! SDK's `renameSession`. (`Session.prototype.rename`'s cases replay on a
//! live session in `session_fake.rs`.) Each case's world (the legacy file, a
//! seeded `sessions` row, a transcript for the SDK's `getSessionInfo`, or a
//! database file that isn't one) is rebuilt under a temp `$HOME`; results are
//! compared as `JSON.stringify` text, and the row afterwards as the recorder
//! reads it. The legacy file must come out untouched.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use claudius_agent::js;
use claudius_core::db::{self, Mode};
use claudius_core::session_titles::{FreshTitle, fresh_title, resolve_session_title, start_title};
use claudius_core::{now_ms, paths, sessions_db, sessions_store};
use rusqlite::types::Value as Sql;
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/session_titles_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// Where Rust knowingly differs from the recording: in `group`'s case
/// `name`, `field` reads as the TS text with `from` replaced by `to` (`*`:
/// the whole value).
const KNOWN: &[(&str, &str, &str, &str, &str, &str)] = &[
    (
        "get",
        "titles a string, a high surrogate",
        "result",
        "\\ud83e",
        "\u{fffd}",
        "a Rust string can't hold the lone surrogate JS indexes out of the string `titles`; it is U+FFFD",
    ),
    (
        "get",
        "titles a string, a high surrogate",
        "second",
        "\u{fffd}\u{fffd}\u{fffd}",
        "\u{fffd}",
        "better-sqlite3 stores the lone surrogate as 3 WTF-8 bytes, which read back as 3 U+FFFD; Rust stored one",
    ),
    (
        "get",
        "titles a string, a high surrogate",
        "row",
        "EDA0BE",
        "EFBFBD",
        "the migrated row holds U+FFFD, not the surrogate's WTF-8 bytes",
    ),
    (
        "get",
        "titles a string, a low surrogate",
        "result",
        "\\udd80",
        "\u{fffd}",
        "as for the high surrogate",
    ),
    (
        "get",
        "titles a string, a low surrogate",
        "second",
        "\u{fffd}\u{fffd}\u{fffd}",
        "\u{fffd}",
        "as for the high surrogate",
    ),
    (
        "get",
        "titles a string, a low surrogate",
        "row",
        "EDB680",
        "EFBFBD",
        "as for the high surrogate",
    ),
    (
        "get",
        "value a lone surrogate escape",
        "result",
        "\\ud800",
        "\u{fffd}",
        "js::json_parse reads a lone-surrogate escape as U+FFFD",
    ),
    (
        "get",
        "value a lone surrogate escape",
        "second",
        "\u{fffd}\u{fffd}\u{fffd}",
        "\u{fffd}",
        "as for the string `titles`",
    ),
    (
        "get",
        "value a lone surrogate escape",
        "row",
        "EDA080",
        "EFBFBD",
        "as for the string `titles`",
    ),
    (
        "get",
        "file nested 200 deep elsewhere",
        "result",
        "*",
        "null",
        "serde_json stops at 128 levels of nesting, so the file doesn't parse",
    ),
    (
        "get",
        "file nested 200 deep elsewhere",
        "second",
        "*",
        "null",
        "as above",
    ),
    (
        "get",
        "file nested 200 deep elsewhere",
        "row",
        "*",
        "null",
        "as above: nothing to migrate",
    ),
    (
        "get",
        "a BLOB row title",
        "result",
        "*",
        "{\"throws\":true}",
        "TS returns the BLOB as a Buffer (truthy, so the legacy file is never read); Rust fails the read",
    ),
    (
        "get",
        "a BLOB row title",
        "second",
        "*",
        "{\"throws\":true}",
        "as above",
    ),
    (
        "get",
        "an empty BLOB row title",
        "result",
        "*",
        "{\"throws\":true}",
        "as above (an empty Buffer is still truthy)",
    ),
    (
        "get",
        "an empty BLOB row title",
        "second",
        "*",
        "{\"throws\":true}",
        "as above",
    ),
];

struct World {
    _dir: tempfile::TempDir,
    root: String,
    config: PathBuf,
}

/// One temp `$HOME` + config dir for the binary (the path overrides are
/// process-wide and first-call-wins). Cases share the legacy file, so they
/// run one at a time.
fn world() -> (&'static World, MutexGuard<'static, ()>) {
    static W: OnceLock<World> = OnceLock::new();
    static SERIAL: Mutex<()> = Mutex::new(());
    let w = W.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (home, config) = (root.join("home"), root.join("config"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(config.clone()));
        World {
            _dir: dir,
            root: root.display().to_string(),
            config,
        }
    });
    (w, SERIAL.lock().unwrap_or_else(|e| e.into_inner()))
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// The legacy file from the case's `legacy` spec; its bytes when it is a
/// plain file.
fn set_legacy(spec: &Value) -> Option<Vec<u8>> {
    let file = sessions_db::legacy_titles_path();
    let dir = file.parent().unwrap();
    if dir.exists() {
        std::fs::remove_dir_all(dir).unwrap();
    }
    if spec.is_null() {
        return None;
    }
    std::fs::create_dir_all(dir).unwrap();
    if spec["dir"] == true {
        std::fs::create_dir(&file).unwrap();
        return None;
    }
    if let Some(kind) = spec["symlink"].as_str() {
        let target = dir.join("target.json");
        if kind == "file" {
            std::fs::write(&target, spec["text"].as_str().unwrap()).unwrap();
        }
        std::os::unix::fs::symlink(target, &file).unwrap();
        return None;
    }
    let bytes = match spec["hex"].as_str() {
        Some(h) => hex(h),
        None => spec["text"].as_str().unwrap().as_bytes().to_vec(),
    };
    std::fs::write(&file, &bytes).unwrap();
    if spec["unreadable"] == true {
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
    }
    Some(bytes)
}

/// Nothing wrote the legacy store: same bytes, and no temp file beside it.
fn check_legacy(name: &str, spec: &Value, bytes: Option<Vec<u8>>) {
    let file = sessions_db::legacy_titles_path();
    if let Some(bytes) = bytes {
        if spec["unreadable"] == true {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(
            std::fs::read(&file).unwrap(),
            bytes,
            "{name}: the legacy file changed"
        );
    }
    if let Ok(rd) = std::fs::read_dir(file.parent().unwrap()) {
        let extra: Vec<String> = rd
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n != "session-titles.json" && n != "target.json")
            .collect();
        assert!(
            extra.is_empty(),
            "{name}: files appeared next to the legacy store: {extra:?}"
        );
    }
}

fn seed(cwd: &str, id: &str, row: &Value, broken: bool) {
    if broken {
        let p = paths::db_path(cwd);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "this is not a database, just text\n".repeat(64)).unwrap();
        return;
    }
    if row.is_null() {
        return;
    }
    let (title, value) = match (row["titleHex"].as_str(), row["textHex"].as_str()) {
        (Some(h), _) => (Sql::Blob(hex(h)), "?"),
        (_, Some(h)) => (Sql::Blob(hex(h)), "CAST(? AS TEXT)"),
        _ => (
            row["title"]
                .as_str()
                .map_or(Sql::Null, |t| Sql::Text(t.into())),
            "?",
        ),
    };
    let model = row["model"]
        .as_str()
        .map_or(Sql::Null, |m| Sql::Text(m.into()));
    let sql = format!(
        "INSERT INTO sessions(id, cwd, title, model, created_at, updated_at, last_seen_at) VALUES (?, ?, {value}, ?, 1000, 2000, 3000)"
    );
    db::open_db(cwd, Mode::ReadWrite)
        .unwrap()
        .with(|c| c.execute(&sql, rusqlite::params![id, "/seeded", title, model]))
        .unwrap();
}

fn write_transcript(w: &World, cwd: &str, id: &str, lines: &Value) {
    let Some(lines) = lines.as_array() else {
        return;
    };
    let dir = w
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let body: String = lines
        .iter()
        .map(|l| {
            let l = l.as_str().unwrap();
            format!("{}\n", l.replace("$ID", id).replace("$CWD", cwd))
        })
        .collect();
    std::fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();
}

/// A case's world; returns its cwd and the legacy bytes written.
fn build(w: &World, c: &Value) -> (String, Option<Vec<u8>>) {
    let cwd = c["cwd"].as_str().unwrap().replace("$ROOT", &w.root);
    std::fs::create_dir_all(&cwd).unwrap();
    let id = c["id"].as_str().unwrap();
    let bytes = set_legacy(&c["legacy"]);
    seed(&cwd, id, &c["seed"], c["brokenDb"] == true);
    write_transcript(w, &cwd, id, &c["jsonl"]);
    (cwd, bytes)
}

/// The row as the recorder reads it.
fn read_row(w: &World, cwd: &str, id: &str, t0: i64, t1: i64) -> String {
    let Ok(db) = db::open_db(cwd, Mode::ReadWrite) else {
        return "\"unreadable\"".into();
    };
    let row = db.with(|c| {
        use rusqlite::OptionalExtension;
        c.query_row(
            "SELECT id, cwd, typeof(title), hex(title), quote(model), created_at, updated_at, last_seen_at FROM sessions WHERE id = ?",
            [id],
            |r| {
                let mut m = Map::new();
                let time = |n: i64| {
                    if (t0..=t1).contains(&n) {
                        json!("$NOW")
                    } else {
                        json!(n)
                    }
                };
                let row_cwd: String = r.get(1)?;
                m.insert("id".into(), json!(r.get::<_, String>(0)?));
                m.insert(
                    "cwd".into(),
                    json!(match row_cwd.strip_prefix(&w.root) {
                        Some(rest) => format!("$ROOT{rest}"),
                        None => row_cwd,
                    }),
                );
                m.insert("titleType".into(), json!(r.get::<_, String>(2)?));
                m.insert("titleHex".into(), json!(r.get::<_, String>(3)?));
                m.insert("model".into(), json!(r.get::<_, String>(4)?));
                m.insert("created_at".into(), time(r.get(5)?));
                m.insert("updated_at".into(), time(r.get(6)?));
                m.insert("last_seen_at".into(), time(r.get(7)?));
                Ok(Value::Object(m))
            },
        )
        .optional()
    });
    match row {
        Ok(Some(v)) => js::stringify(&v),
        Ok(None) => "null".into(),
        Err(_) => "\"unreadable\"".into(),
    }
}

fn text(v: Option<&str>) -> String {
    js::stringify(&v.map_or(Value::Null, Value::from))
}

fn result(r: anyhow::Result<Option<String>>) -> String {
    match r {
        Ok(v) => text(v.as_deref()),
        Err(_) => "{\"throws\":true}".into(),
    }
}

/// Compare one case's fields with the recording, applying [`KNOWN`].
fn compare(group: &str, c: &Value, got: &[(&str, String)], failures: &mut Vec<String>) {
    let name = c["name"].as_str().unwrap();
    for (field, rust) in got {
        let ts = c[*field].as_str().unwrap();
        let known = KNOWN
            .iter()
            .find(|k| k.0 == group && k.1 == name && k.2 == *field);
        let want = match known {
            Some((.., from, to, _)) if *from == "*" => (*to).to_owned(),
            Some((.., from, to, _)) => {
                assert!(
                    ts.contains(from),
                    "{group} {name:?} {field}: the KNOWN pattern {from:?} isn't in the recording {ts}"
                );
                ts.replace(from, to)
            }
            None => ts.to_owned(),
        };
        if known.is_some() {
            assert_ne!(
                want, ts,
                "{group} {name:?} {field}: listed in KNOWN but the patch is a no-op"
            );
        }
        if *rust != want {
            failures.push(format!(
                "{group} {name:?} {field}:\n   ts: {ts}\n want: {want}\n rust: {rust}"
            ));
        }
    }
}

fn finish(group: &str, n: usize, failures: Vec<String>) {
    assert!(n > 0, "no {group} cases");
    assert!(
        failures.is_empty(),
        "{} of the {group} fields differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    for k in KNOWN.iter().filter(|k| k.0 == group) {
        assert!(
            fixture()[group]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["name"] == k.1),
            "KNOWN {group} case {:?} is missing from the fixture",
            k.1
        );
    }
}

#[test]
fn resolve_session_title_matches_ts() {
    let cases = fixture()["resolve"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let custom = c["info"]["customTitle"].as_str();
        let got = text(resolve_session_title(c["local"].as_str(), custom).as_deref());
        if got != c["result"].as_str().unwrap() {
            failures.push(format!("{c}: rust {got}"));
        }
    }
    finish("resolve", cases.len(), failures);
}

#[test]
fn get_session_title_matches_ts() {
    let (w, _serial) = world();
    let cases = fixture()["get"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let id = c["id"].as_str().unwrap();
        let t0 = now_ms();
        let (cwd, bytes) = build(w, c);
        let first = result(sessions_db::get_session_title(&cwd, id));
        let second = result(sessions_db::get_session_title(&cwd, id));
        let t1 = now_ms();
        let row = read_row(w, &cwd, id, t0, t1);
        check_legacy(name, &c["legacy"], bytes);
        let got = [("result", first), ("second", second), ("row", row)];
        compare("get", c, &got, &mut failures);
    }
    finish("get", cases.len(), failures);
}

#[test]
fn start_title_matches_ts() {
    let (w, _serial) = world();
    let cases = fixture()["start"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let t0 = now_ms();
        let (cwd, bytes) = build(w, c);
        let resume = (c["resume"] == true).then_some(id);
        let title = start_title(&cwd, c["thisId"].as_str().unwrap(), resume);
        let t1 = now_ms();
        let row = read_row(w, &cwd, id, t0, t1);
        check_legacy(c["name"].as_str().unwrap(), &c["legacy"], bytes);
        let got = [("title", text(title.as_deref())), ("row", row)];
        compare("start", c, &got, &mut failures);
    }
    finish("start", cases.len(), failures);
}

/// `fresh_title` decides; the effects are `send_fresh_title`'s (session.rs):
/// adopt + broadcast + `upsert_session` on `Moved`, the one-subscriber echo
/// on `Echo`.
#[test]
fn fresh_title_matches_ts() {
    let (w, _serial) = world();
    let cases = fixture()["fresh"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let current = c["current"].as_str();
        let t0 = now_ms();
        let (cwd, bytes) = build(w, c);
        let event = |t: &str| vec![json!({"type": "session_title", "title": t})];
        let (broadcasts, sent, title) = match fresh_title(&cwd, id, current) {
            FreshTitle::Moved(n) => {
                let _ = sessions_db::upsert_session(id, &cwd, c["model"].as_str(), Some(&n));
                (event(&n), vec![], Some(n))
            }
            FreshTitle::Echo(t) => (vec![], event(&t), current.map(str::to_owned)),
            FreshTitle::Quiet => (vec![], vec![], current.map(str::to_owned)),
        };
        let t1 = now_ms();
        let row = read_row(w, &cwd, id, t0, t1);
        check_legacy(c["name"].as_str().unwrap(), &c["legacy"], bytes);
        let got = [
            ("broadcasts", js::stringify(&Value::from(broadcasts))),
            ("sent", js::stringify(&Value::from(sent))),
            ("title", text(title.as_deref())),
            ("row", row),
        ];
        compare("fresh", c, &got, &mut failures);
    }
    finish("fresh", cases.len(), failures);
}

#[test]
fn set_session_title_matches_ts() {
    let (w, _serial) = world();
    let cases = fixture()["set"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let t0 = now_ms();
        let (cwd, _) = build(w, c);
        let r = sessions_db::set_session_title(&cwd, id, c["title"].as_str().unwrap());
        let t1 = now_ms();
        let r = r.map_or_else(|_| "{\"throws\":true}".to_owned(), |()| "null".to_owned());
        let got = [("result", r), ("row", read_row(w, &cwd, id, t0, t1))];
        compare("set", c, &got, &mut failures);
    }
    finish("set", cases.len(), failures);
}

/// The SDK's `renameSession` (`sessions_store::rename`): the line it
/// appends, or its error.
#[test]
fn sdk_rename_session_matches_ts() {
    let (w, _serial) = world();
    let cases = fixture()["sdkRename"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let (cwd, _) = build(w, c);
        let file = w
            .config
            .join("projects")
            .join(paths::sdk_project_dir_name(&cwd))
            .join(format!("{id}.jsonl"));
        let before = std::fs::read_to_string(&file).unwrap_or_default();
        let result = match sessions_store::rename(id, c["title"].as_str().unwrap(), Some(&cwd)) {
            Ok(()) => {
                let after = std::fs::read_to_string(&file).unwrap();
                json!({"appended": after[before.len()..]})
            }
            Err(e) => json!({"throws": e.to_string().replace(&w.root, "$ROOT")}),
        };
        compare(
            "sdkRename",
            c,
            &[("result", js::stringify(&result))],
            &mut failures,
        );
    }
    finish("sdkRename", cases.len(), failures);
}

#[test]
fn every_known_difference_is_used() {
    for k in KNOWN {
        let case = fixture()[k.0]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == k.1);
        assert!(
            case.is_some(),
            "KNOWN {} case {:?} isn't recorded",
            k.0,
            k.1
        );
        assert!(
            case.unwrap()[k.2].is_string(),
            "KNOWN {} {:?}: no field {}",
            k.0,
            k.1,
            k.2
        );
    }
}
