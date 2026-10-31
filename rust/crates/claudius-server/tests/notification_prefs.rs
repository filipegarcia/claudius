//! `GET/POST /api/sessions/:id/notification-prefs` against the real binary,
//! replaying the `steps` of
//! `claudius-core/tests/fixtures/notification_prefs_golden.json` (recorded
//! by `rust/scripts/notification-prefs-golden.mjs` from the real TS route):
//! the same transcripts under `<config>/projects` (each reaped session's
//! cwd, hence its per-project DB), the same live session (`live`, resumed
//! in the world's project while its transcript names another cwd), the same
//! hand-written SQL in between, and every request must answer the same
//! status, content type and body text ("threw" is Next's empty 500), and
//! every row dump the same stored types and values.
//!
//! The recorder ran each request at a pinned clock; this server runs on the
//! real one. A POST that computed a snooze therefore has to answer
//! `snooze_until(t, minutes)` for some `t` within the request (the formula
//! itself is pinned against the TS in `claudius-core`'s golden), and from
//! then on that value stands in for the recorded one.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use claudius_agent::js;
use claudius_core::db::{Mode, open_path};
use claudius_core::notifications_db::snooze_until;
use claudius_core::{js_num, now_ms, paths};
use common::{Server, World, http};
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/notification_prefs_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `(status, content type, body)`; `body: None` sends no body.
fn request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let body = body.unwrap_or("");
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let content_type = head.split("\r\n").find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, content_type, body.to_owned())
}

const ROWS_SQL: &str = "SELECT session_id,
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

/// The raw `snoozeUntil` text of a prefs body (its last field).
fn snooze_text(body: &str) -> Option<&str> {
    let at = body.find("\"snoozeUntil\":")? + "\"snoozeUntil\":".len();
    body.get(at..body.len().checked_sub(1)?)
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new();
    for t in fx["transcripts"].as_array().unwrap() {
        let dir = world
            .config
            .join("projects")
            .join(t["dir"].as_str().unwrap());
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{}.jsonl", t["id"].as_str().unwrap()));
        std::fs::write(file, t["text"].as_str().unwrap()).unwrap();
    }
    let server = Server::spawn(&world, &[]);
    let live = fx["live"]["id"].as_str().unwrap();
    let project = world.project.display().to_string();
    let (st, out) = http(
        server.port,
        "POST",
        "/api/sessions",
        &json!({"resume": live, "cwd": project}).to_string(),
    );
    assert_eq!(
        (
            st,
            serde_json::from_str::<Value>(&out).unwrap()["id"].as_str()
        ),
        (200, Some(live)),
        "{out}"
    );

    // The recorder's cwds; the live one is this world's project.
    let cwd = |step: &Value| {
        let c = step["cwd"].as_str().unwrap();
        if c == fx["live"]["cwd"] {
            project.clone()
        } else {
            c.to_owned()
        }
    };
    let db_path = |cwd: &str| {
        world
            .home
            .join(".claude/projects")
            .join(paths::encode_project_dir(cwd))
            .join(".claudius.db")
    };
    // Recorded snooze text → the one this server computed.
    let mut subst: Vec<(String, String)> = vec![];
    let mut snoozed = 0;
    let mut failures = vec![];
    let steps = fx["steps"].as_array().unwrap();
    for (i, s) in steps.iter().enumerate() {
        match s["op"].as_str().unwrap() {
            "sql" => {
                let path = db_path(&cwd(s));
                let sql = s["sql"].as_str().unwrap();
                if s["fresh"] == true {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    let c = rusqlite::Connection::open(&path).unwrap();
                    c.pragma_update(None, "journal_mode", "WAL").unwrap();
                    c.execute_batch(sql).unwrap();
                } else {
                    open_path(&path, Mode::ReadWrite)
                        .unwrap()
                        .execute_batch(sql)
                        .unwrap();
                }
            }
            "rows" => {
                let c = open_path(&db_path(&cwd(s)), Mode::ReadWrite).unwrap();
                let mut st = c.prepare(ROWS_SQL).unwrap();
                let got: Vec<Vec<Value>> = st
                    .query_map([], |r| (0..5).map(|i| Ok(cell(r.get_ref(i)?))).collect())
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                let mut want = s["got"].clone();
                for row in want.as_array_mut().unwrap() {
                    let v = &mut row[4];
                    // An INTEGER cell is its exact decimal text, which past
                    // 2^53 isn't the JS number text the substitutions use.
                    for (x, y) in &subst {
                        match v {
                            Value::String(t)
                                if t.parse::<f64>()
                                    .is_ok_and(|n| js::number_to_string(n) == *x) =>
                            {
                                *v = json!((y.parse::<f64>().unwrap() as i64).to_string());
                            }
                            Value::Number(n) if js::number_to_string(n.as_f64().unwrap()) == *x => {
                                *v = js_num(y.parse().unwrap());
                            }
                            _ => {}
                        }
                    }
                }
                if js::stringify(&json!(got)) != js::stringify(&want) {
                    failures.push(format!(
                        "#{i} rows {}\n  want {}\n  got  {}",
                        s["cwd"],
                        js::stringify(&want),
                        js::stringify(&json!(got))
                    ));
                }
            }
            op => {
                let id = s["id"].as_str().unwrap();
                let path = format!("/api/sessions/{id}/notification-prefs");
                let method = if op == "get" { "GET" } else { "POST" };
                let t0 = now_ms();
                let (status, content_type, body) =
                    request(server.port, method, &path, s["body"].as_str());
                let t1 = now_ms();
                let want = &s["got"];
                let got = if status == 500 && body.is_empty() && content_type.is_none() {
                    json!({"threw": want["threw"]})
                } else {
                    json!({"status": status, "type": content_type, "body": body})
                };
                let mut want = want.clone();
                if let Some(m) = s["snoozeMinutes"].as_f64() {
                    snoozed += 1;
                    let x = snooze_text(want["body"].as_str().unwrap())
                        .unwrap()
                        .to_owned();
                    let clock = s["clock"].as_f64().unwrap();
                    assert_eq!(
                        x,
                        js::number_to_string(snooze_until(clock, m)),
                        "#{i}: the fixture's own arithmetic"
                    );
                    let y = snooze_text(&body).unwrap_or("<none>").to_owned();
                    if !(t0..=t1).any(|t| js::number_to_string(snooze_until(t as f64, m)) == y) {
                        failures.push(format!(
                            "#{i} {path} {m} min: {y} is not {t0}..={t1} + {m} min"
                        ));
                    }
                    if x != y {
                        subst.push((x, y));
                    }
                }
                if let Some(text) = want["body"].as_str() {
                    let mut text = text.to_owned();
                    for (x, y) in &subst {
                        text = text.replace(
                            &format!("\"snoozeUntil\":{x}}}"),
                            &format!("\"snoozeUntil\":{y}}}"),
                        );
                    }
                    want["body"] = json!(text);
                }
                if got != want {
                    failures.push(format!(
                        "#{i} {method} {path} {}\n  want {want}\n  got  {got}",
                        s["body"]
                    ));
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} steps differ:\n{}",
        failures.len(),
        steps.len(),
        failures.join("\n")
    );
    assert!(steps.len() >= 140);
    // 17 computed snoozes; past ~1e308 minutes the clock no longer shows.
    assert!(
        snoozed >= 17 && subst.len() >= 15,
        "{snoozed} snoozes, {} moved",
        subst.len()
    );

    // GETs open the DB read-only, like TS: a cwd only ever read has none.
    assert!(db_path("/claudius-golden/nodb").parent().unwrap().is_dir());
    assert!(!db_path("/claudius-golden/nodb").exists());

    // GET and POST only, like the TS route module.
    for method in ["PUT", "PATCH", "DELETE"] {
        let (st, _, _) = request(
            server.port,
            method,
            &format!("/api/sessions/{live}/notification-prefs"),
            Some("{}"),
        );
        assert_eq!(st, 405, "{method}");
    }
    server.stop(Duration::from_secs(30));
}
