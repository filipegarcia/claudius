//! Replays `tests/fixtures/assets_golden.json` (recorded by
//! `rust/scripts/assets-golden.mjs` from the real TS: `asset-store.ts`,
//! `asset-list.ts`, `asset-ingest.ts` and the `image-size` package) against
//! [`image_size`], [`buffer_from_base64`], [`date_parse`], [`ext_for`] and
//! the store, list and ingest functions in the recorded order, in a fresh
//! state home. The route parts are replayed on the real binary by
//! `claudius-server/tests/assets.rs`.
//!
//! Where the recording says `hang` the package never returned (a zero-size
//! entry it loops on forever); the port answers `Err` there. A store read
//! or delete marked `rustRefuses` left the store in TS (a hash another
//! writer stored with `..` in it); the port treats the file as missing.

use std::path::{Path, PathBuf};

use claudius_agent::js;
use claudius_core::asset_ingest::{
    BackfillProgress, backfill_project_with, buffer_from_base64, record_send_uses,
};
use claudius_core::asset_list::{self, UseRow};
use claudius_core::asset_store::{self, ext_for, sha256_hex};
use claudius_core::db::{Mode, open_db, open_path};
use claudius_core::image_size::image_size;
use claudius_core::js_date::date_parse;
use claudius_core::js_num;
use claudius_core::paths::{self, encode_project_dir};
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/assets_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `String(x)`.
fn js_string(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else {
        js::number_to_string(x)
    }
}

fn dim(d: Option<f64>) -> String {
    d.map_or_else(|| "undefined".into(), js_string)
}

/// The recorder's `TZ`, for `Date.parse`'s local time (`chrono::Local`
/// reads `TZ`). Every test sets it first, through one `Once`, before it
/// does anything that could read the environment.
fn pin_tz(fx: &Value) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    let tz = fx["dateParse"]["tz"].as_str().unwrap().to_owned();
    ONCE.call_once(|| {
        // SAFETY: the only write to the environment in this binary, made
        // before any test reads it (each waits on this `Once` first).
        unsafe { std::env::set_var("TZ", tz) };
    });
}

#[test]
fn image_size_matches_the_package() {
    let fx = fixture();
    pin_tz(&fx);
    let mut failures = vec![];
    let cases = fx["imageSize"].as_array().unwrap();
    for c in cases {
        let got = image_size(&unhex(c["hex"].as_str().unwrap()));
        let want = if c["hang"] == true || c["threw"] == true {
            None
        } else {
            Some((
                c["w"].as_str().unwrap().to_owned(),
                c["h"].as_str().unwrap().to_owned(),
            ))
        };
        let got = got.ok().map(|s| (dim(s.width), dim(s.height)));
        if got != want {
            failures.push(format!(
                "{} {}: want {want:?}, got {got:?}",
                c["name"], c["hex"]
            ));
        }
    }
    assert!(cases.len() > 2000);
    assert!(
        failures.is_empty(),
        "{} of {}:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn base64_like_buffer_from() {
    let fx = fixture();
    pin_tz(&fx);
    let mut failures = vec![];
    for c in fx["base64"].as_array().unwrap() {
        let s = c["s"].as_str().unwrap();
        let got = hex(&buffer_from_base64(s));
        if got != c["hex"].as_str().unwrap() {
            failures.push(format!("{s:?}: want {}, got {got}", c["hex"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn date_parse_like_v8() {
    let fx = fixture();
    pin_tz(&fx);
    let mut failures = vec![];
    for c in fx["dateParse"]["cases"].as_array().unwrap() {
        let s = c["s"].as_str().unwrap();
        let got = js_string(date_parse(s).map_or(f64::NAN, |t| t as f64));
        let want = c["ms"].as_str().unwrap();
        // V8's legacy forms included (`2026/01/01`, `January 1, 2026`).
        if got != want {
            failures.push(format!("{s:?}: want {want}, got {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn ext_for_like_the_store() {
    let fx = fixture();
    pin_tz(&fx);
    for c in fx["extFor"].as_array().unwrap() {
        assert_eq!(
            ext_for(c["m"].as_str().unwrap()),
            c["ext"].as_str().unwrap(),
            "{}",
            c["m"]
        );
    }
}

// ─────────────────────────────── the sequence ────────────────────────────────

const ROW_COLS: [(&str, &[&str], &str); 2] = [
    (
        "assets",
        &[
            "hash",
            "media_type",
            "size_bytes",
            "width",
            "height",
            "first_seen_ms",
            "last_seen_ms",
        ],
        "hash",
    ),
    (
        "asset_uses",
        &[
            "asset_hash",
            "session_id",
            "message_uuid",
            "ordinal",
            "occurred_ms",
        ],
        "asset_hash, session_id, message_uuid, ordinal",
    ),
];

/// The recorder's typed dump of a table.
fn dump_sql(table: &str, cols: &[&str], order: &str) -> String {
    let parts: Vec<String> = cols
        .iter()
        .map(|c| format!("typeof({c}), CASE typeof({c}) WHEN 'integer' THEN CAST({c} AS TEXT) WHEN 'blob' THEN hex({c}) ELSE {c} END"))
        .collect();
    format!("SELECT {} FROM {table} ORDER BY {order}", parts.join(", "))
}

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(f) => js_num(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(_) => panic!("the dump hexes blobs"),
    }
}

fn query(conn: &rusqlite::Connection, sql: &str) -> Value {
    let mut st = conn.prepare(sql).unwrap();
    let n = st.column_count();
    let rows: Vec<Value> = st
        .query_map([], |r| {
            (0..n)
                .map(|i| Ok(cell(r.get_ref(i)?)))
                .collect::<rusqlite::Result<Vec<_>>>()
                .map(Value::Array)
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    Value::Array(rows)
}

/// Every file under `dir` as `[relative path, size, sha256]`, by path bytes.
fn walk(dir: &Path) -> Value {
    if !dir.exists() {
        return Value::Null;
    }
    fn go(d: &Path, rel: &str, out: &mut Vec<(String, u64, String)>) {
        for e in std::fs::read_dir(d).unwrap() {
            let e = e.unwrap();
            let name = e.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let meta = std::fs::symlink_metadata(e.path()).unwrap();
            if meta.is_dir() {
                go(&e.path(), &r, out);
            } else {
                out.push((r, meta.len(), sha256_hex(&std::fs::read(e.path()).unwrap())));
            }
        }
    }
    let mut out = vec![];
    go(dir, "", &mut out);
    out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    json!(
        out.into_iter()
            .map(|(p, s, h)| json!([p, s, h]))
            .collect::<Vec<_>>()
    )
}

fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => js::to_number(s),
        v => v.as_f64().unwrap(),
    }
}

fn progress(p: &BackfillProgress) -> String {
    format!(
        r#"{{"total":{},"scanned":{},"ingested":{}}}"#,
        p.total, p.scanned, p.ingested
    )
}

fn threw(e: &dyn std::fmt::Display) -> Value {
    json!({ "threw": e.to_string() })
}

#[test]
fn replays_the_store_list_and_ingest_sequence() {
    let fx = fixture();
    pin_tz(&fx);
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    // The only test in this binary that reads the state home.
    assert!(paths::set_home_override(home.clone()));
    let home_s = home.display().to_string();
    let projects = home.join(".claude/projects");
    let scrub = |s: String| s.replace(&home_s, "{HOME}");

    let mut failures = vec![];
    let mut locked_writable = false;
    for (i, op) in fx["core"].as_array().unwrap().iter().enumerate() {
        let s = |k: &str| op[k].as_str().unwrap_or_default().to_owned();
        let cwd = s("cwd");
        let want = &op["got"];
        let got: Value = match op["op"].as_str().unwrap() {
            "record" => {
                let images = op["images"].as_array().cloned().unwrap();
                let out = record_send_uses(
                    &cwd,
                    &s("sessionId"),
                    &s("messageUuid"),
                    num(&op["occurredMs"]),
                    &images,
                );
                json!(js::stringify(&Value::Array(
                    out.iter().map(|r| r.to_json()).collect()
                )))
            }
            "rows" => {
                let conn = open_path(
                    &projects.join(encode_project_dir(&cwd)).join(".claudius.db"),
                    Mode::ReadWrite,
                )
                .unwrap();
                let [(at, ac, ao), (ut, uc, uo)] = ROW_COLS;
                json!({ "assets": query(&conn, &dump_sql(at, ac, ao)), "uses": query(&conn, &dump_sql(ut, uc, uo)) })
            }
            "metaKeys" => {
                let conn = open_path(
                    &projects.join(encode_project_dir(&cwd)).join(".claudius.db"),
                    Mode::ReadWrite,
                )
                .unwrap();
                query(
                    &conn,
                    "SELECT key, typeof(value) FROM schema_meta WHERE key LIKE 'last_jsonl_scan_%' ORDER BY key",
                )
            }
            "files" => walk(&projects.join(encode_project_dir(&cwd)).join("assets")),
            "ls" => {
                let dir = home.join(s("rel"));
                match std::fs::read_dir(&dir) {
                    Ok(rd) => {
                        let mut names: Vec<String> = rd
                            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                            .collect();
                        names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
                        json!(names)
                    }
                    Err(_) => Value::Null,
                }
            }
            "list" => {
                let o = &op["opts"];
                let limit = if o["limit"].is_null() {
                    60.0
                } else {
                    num(&o["limit"])
                };
                let cursor = (!o["cursor"].is_null()).then(|| num(&o["cursor"]));
                match asset_list::list_assets(
                    o["scope"].as_str().unwrap(),
                    o["cwd"].as_str().unwrap(),
                    o["type"].as_str().unwrap_or("all"),
                    o["q"].as_str().unwrap_or(""),
                    limit,
                    cursor,
                ) {
                    Ok(p) => json!(js::stringify(&p.to_json())),
                    Err(e) => threw(&e),
                }
            }
            "uses" => match asset_list::list_uses(&cwd, &s("hash")) {
                Ok(rows) => json!(js::stringify(&Value::Array(
                    rows.iter().map(UseRow::to_json).collect()
                ))),
                Err(e) => threw(&e),
            },
            "meta" => match asset_list::get_asset_meta(&cwd, &s("hash")) {
                Ok(Some(row)) => json!(js::stringify(&row.to_json())),
                Ok(None) => json!("null"),
                Err(e) => threw(&e),
            },
            "delrow" => match asset_list::delete_asset_row(&cwd, &s("hash")) {
                Ok(b) => json!(b),
                Err(e) => threw(&e),
            },
            "write" => match asset_store::write_if_absent(&cwd, &unhex(&s("hex")), &s("mediaType"))
            {
                Ok(w) => json!(scrub(js::stringify(
                    &json!({ "hash": w.hash, "path": w.path, "bytes": w.bytes, "created": w.created })
                ))),
                Err(e) => json!({ "threw": scrub(e.message) }),
            },
            "read" => match asset_store::read_asset(&cwd, &s("hash"), &s("mediaType")) {
                Some(b) => json!(hex(&b)),
                None => Value::Null,
            },
            "del" => match asset_store::delete_asset(&cwd, &s("hash"), &s("mediaType")) {
                Ok(b) => json!(b),
                Err(e) => json!({ "threw": scrub(e.message) }),
            },
            "backfill" => {
                let clock = op["clock"].as_f64().unwrap();
                match backfill_project_with(&cwd, &|| clock) {
                    Ok(p) => json!(progress(&p)),
                    Err(e) => threw(&e),
                }
            }
            "sql" => {
                let path = projects.join(encode_project_dir(&cwd)).join(".claudius.db");
                if op["fresh"] == true {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    let c = rusqlite::Connection::open(&path).unwrap();
                    c.pragma_update(None, "journal_mode", "WAL").unwrap();
                    c.execute_batch(&s("sql")).unwrap();
                } else {
                    open_db(&cwd, Mode::ReadWrite)
                        .unwrap()
                        .with(|c| c.execute_batch(&s("sql")))
                        .unwrap();
                }
                Value::Null
            }
            "jsonl" => {
                let p = projects.join(encode_project_dir(&cwd)).join(s("name"));
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let bytes = if op["hex"].is_string() {
                    unhex(&s("hex"))
                } else {
                    s("text").into_bytes()
                };
                std::fs::write(p, bytes).unwrap();
                Value::Null
            }
            "mkdir" => {
                std::fs::create_dir_all(home.join(s("rel"))).unwrap();
                Value::Null
            }
            "file" => {
                let p = home.join(s("rel"));
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(p, s("text")).unwrap();
                Value::Null
            }
            "link" => {
                let p = home.join(s("rel"));
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(s("target"), p).unwrap();
                Value::Null
            }
            "chmod" => {
                use std::os::unix::fs::PermissionsExt;
                let p = home.join(s("rel"));
                let mode = op["mode"].as_u64().unwrap() as u32;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
                // Root writes into a read-only folder: a `locked` step can't
                // be replayed there.
                if mode & 0o200 == 0 {
                    let probe = p.join("probe");
                    locked_writable = std::fs::write(&probe, "").is_ok();
                    let _ = std::fs::remove_file(probe);
                }
                Value::Null
            }
            "mtime" => {
                let p = projects.join(encode_project_dir(&cwd)).join(s("name"));
                let t = std::time::UNIX_EPOCH
                    + std::time::Duration::new(
                        op["sec"].as_u64().unwrap(),
                        op["nsec"].as_u64().unwrap() as u32,
                    );
                let f = std::fs::File::options().write(true).open(&p).unwrap();
                f.set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t))
                    .unwrap();
                Value::Null
            }
            "cursors" => {
                let conn = open_path(
                    &projects.join(encode_project_dir(&cwd)).join(".claudius.db"),
                    Mode::ReadWrite,
                )
                .unwrap();
                query(
                    &conn,
                    "SELECT key, value FROM schema_meta WHERE key LIKE 'last_jsonl_scan_%' ORDER BY key",
                )
            }
            other => panic!("unknown op {other}"),
        };
        // The port refuses a path that leaves the store: missing, never deleted.
        let want = if op["rustRefuses"] == true {
            match op["op"].as_str().unwrap() {
                "read" => Value::Null,
                _ => json!(false),
            }
        } else {
            want.clone()
        };
        // Database errors throw in both; their wording is the driver's.
        let same = (op["locked"] == true && locked_writable)
            || match (&want, &got) {
                (Value::Object(w), Value::Object(g))
                    if w.contains_key("threw") && op["op"] != "write" && op["op"] != "del" =>
                {
                    g.contains_key("threw")
                }
                _ => want == got,
            };
        if !same {
            failures.push(format!(
                "#{i} {}\n  want {}\n  got  {}",
                js::stringify(&{
                    let mut o = op.clone();
                    o.as_object_mut().unwrap().remove("got");
                    o
                }),
                js::stringify(&want),
                js::stringify(&got)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
