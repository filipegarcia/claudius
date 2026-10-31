//! `GET/PUT/DELETE /api/splash-examples` against the real binary, replaying
//! `fixtures/splash_examples_route_golden.json` (recorded by
//! `rust/scripts/splash-examples-route-golden.mjs` from the real TS route in
//! Next's request scope, through Next's own method table and `vary` header,
//! on the real `splash-examples-db.ts`, `splash-fallback-name.ts` and
//! `resolveActiveCwd`).
//!
//! Each phase runs on a fresh world and server: the same store files under
//! the home (workspaces, customizations, accounts, `~/.claude.json`), the
//! same hand-written SQL and broken DB files in between, the same Cookie
//! headers and bodies; every request must answer the same status, headers
//! (all but the transport ones) and body text, every dump the same rows and
//! files. Concurrent PUTs (no lock in TS either) are checked by their
//! answers and by the row holding one of the racing values.
//!
//! Also replays D21's recorded `cookies` (Next's `RequestCookies`) through
//! the cookie parser this route uses (D01's `workspaces::parse_cookie_header`).
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::db::{Mode, open_path};
use claudius_core::paths;
use claudius_server::heartbeat::VARY;
use claudius_server::workspaces::parse_cookie_header;
use common::{Server, World};
use serde_json::{Value, json};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name);
    js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

const URL: &str = "/api/splash-examples";

const TRANSPORT: [&str; 5] = [
    "date",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
];

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

fn remove(path: &Path) {
    if path.is_dir() {
        std::fs::remove_dir_all(path).unwrap();
    } else if path.exists() {
        std::fs::remove_file(path).unwrap();
    }
}

const ROWS_SQL: &str = "SELECT key, typeof(value), hex(value) FROM ui_state ORDER BY key, rowid";

/// The rows through a separate read-only connection, like the recorder's.
fn rows_at(path: &Path) -> Value {
    if !path.exists() {
        return json!({"nodb": true});
    }
    let read = || -> rusqlite::Result<Vec<Vec<String>>> {
        let c = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut st = c.prepare(ROWS_SQL)?;
        let rows = st.query_map([], |r| (0..3).map(|i| r.get(i)).collect())?;
        rows.collect()
    };
    match read() {
        Ok(r) => json!(r),
        Err(rusqlite::Error::SqliteFailure(_, Some(m))) => json!({"error": m}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

struct Replay<'a> {
    world: &'a World,
    port: u16,
}

impl Replay<'_> {
    fn sym(&self, s: &str) -> String {
        s.replace(&self.world.project.display().to_string(), "$PROC")
            .replace(&self.world.home.display().to_string(), "$HOME")
    }

    fn unsym(&self, s: &str) -> String {
        s.replace("$PROC", &self.world.project.display().to_string())
            .replace("$HOME", &self.world.home.display().to_string())
    }

    fn db_path(&self, s: &Value) -> PathBuf {
        let cwd = self.unsym(s["cwd"].as_str().unwrap());
        self.world
            .home
            .join(".claude/projects")
            .join(paths::encode_project_dir(&cwd))
            .join(".claudius.db")
    }

    /// One request, viewed as the recorder viewed it: status, headers but
    /// the transport ones (lowercased, sorted), body.
    fn call(&self, s: &Value) -> Value {
        let method = s["method"].as_str().unwrap();
        let body = match (&s["hex"], &s["body"]) {
            (Value::String(h), _) => Some(unhex(h)),
            (_, Value::String(b)) => Some(b.as_bytes().to_vec()),
            _ => None,
        };
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        let mut head = format!(
            "{method} {URL}{} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n",
            s["query"].as_str().unwrap_or_default()
        );
        if let Some(c) = s["cookie"].as_str() {
            head.push_str(&format!("Cookie: {c}\r\n"));
        }
        if let Some(b) = &body {
            head.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                b.len()
            ));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).unwrap();
        stream
            .write_all(body.as_deref().unwrap_or_default())
            .unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).unwrap();
        let at = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8(out[..at].to_vec()).unwrap();
        let mut lines = head.split("\r\n");
        let status: u16 = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let mut headers: Vec<(String, String)> = lines
            .map(|l| {
                let (k, v) = l.split_once(':').unwrap();
                (k.trim().to_ascii_lowercase(), v.trim().to_owned())
            })
            .filter(|(k, _)| !TRANSPORT.contains(&k.as_str()))
            .collect();
        headers.sort();
        let body = String::from_utf8(out[at + 4..].to_vec()).unwrap();
        json!({"status": status, "headers": headers, "body": self.sym(&body)})
    }

    /// Replays one step; `Some((want, got))` when it has an answer to check.
    fn step(&self, s: &Value) -> Option<(Value, Value)> {
        let got = match s["op"].as_str().unwrap() {
            "file" => {
                let path = self.world.home.join(s["path"].as_str().unwrap());
                remove(&path);
                if s["rm"] != true {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    if s["dir"] == true {
                        std::fs::create_dir(&path).unwrap();
                    } else if let Some(hex) = s["hex"].as_str() {
                        std::fs::write(&path, unhex(hex)).unwrap();
                    } else {
                        std::fs::write(&path, s["text"].as_str().unwrap()).unwrap();
                    }
                }
                return None;
            }
            "sql" => {
                let path = self.db_path(s);
                let sql = s["sql"].as_str().unwrap();
                if s["fresh"] == true {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    let c = rusqlite::Connection::open(&path).unwrap();
                    if s["journal"] != "delete" {
                        c.pragma_update(None, "journal_mode", "WAL").unwrap();
                    }
                    c.execute_batch(sql).unwrap();
                } else {
                    open_path(&path, Mode::ReadWrite)
                        .unwrap()
                        .execute_batch(sql)
                        .unwrap();
                }
                return None;
            }
            "dbfile" => {
                let path = self.db_path(s);
                remove(&path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                if s["dir"] == true {
                    std::fs::create_dir(&path).unwrap();
                } else {
                    std::fs::write(&path, s["text"].as_str().unwrap()).unwrap();
                }
                return None;
            }
            "rows" => rows_at(&self.db_path(s)),
            "exists" => {
                let path = self.db_path(s);
                json!({"dir": path.parent().unwrap().exists(), "db": path.exists()})
            }
            "rowsOneOf" => {
                let got = rows_at(&self.db_path(s));
                let keys = s["keys"].as_object().unwrap();
                let ok = got.as_array().is_some_and(|rows| {
                    let names: Vec<&str> = rows.iter().map(|r| r[0].as_str().unwrap()).collect();
                    let mut want: Vec<&str> = keys.keys().map(String::as_str).collect();
                    want.sort_unstable();
                    names == want
                        && rows.iter().all(|r| {
                            r[1] == "text"
                                && keys[r[0].as_str().unwrap()]
                                    .as_array()
                                    .unwrap()
                                    .contains(&r[2])
                        })
                });
                return (!ok).then(|| (s["keys"].clone(), got));
            }
            "concurrent" => {
                let steps = s["steps"].as_array().unwrap();
                std::thread::scope(|scope| {
                    let calls: Vec<_> = steps
                        .iter()
                        .map(|c| scope.spawn(move || self.call(c)))
                        .collect();
                    Value::Array(calls.into_iter().map(|h| h.join().unwrap()).collect())
                })
            }
            "req" => self.call(s),
            op => panic!("op {op}"),
        };
        Some((recorded(&s["got"]), got))
    }
}

/// The recorded answer(s) without `threw` (the message of a thrown handler,
/// which Next doesn't send).
fn recorded(got: &Value) -> Value {
    match got {
        Value::Array(items) => Value::Array(items.iter().map(recorded).collect()),
        Value::Object(m) => {
            let mut m = m.clone();
            m.remove("threw");
            Value::Object(m)
        }
        v => v.clone(),
    }
}

/// Where Rust is known to differ, and why (each one must still differ): a
/// body nested past serde_json's 127 levels, which V8 parses, is a 400
/// "invalid JSON" here, so its chips aren't written until the next PUT.
fn known_difference(s: &Value, tainted: &mut Option<&'static str>) -> Option<&'static str> {
    match s["op"].as_str() {
        Some("req") if s["method"] == "PUT" => {
            let deep = s["body"]
                .as_str()
                .is_some_and(|b| b.contains(&"[".repeat(150)));
            *tainted = deep.then_some("nesting past 127 levels");
            *tainted
        }
        Some("rows" | "req") => *tainted,
        _ => None,
    }
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture("tests/fixtures/splash_examples_route_golden.json");
    assert_eq!(fx["vary"], VARY);
    assert_eq!(fx["allow"], "DELETE, GET, HEAD, OPTIONS, PUT");
    let phases = fx["phases"].as_array().unwrap();
    assert_eq!(phases.len(), 3);
    let (mut failures, mut known, mut requests) = (vec![], vec![], 0);
    for phase in phases {
        let name = phase["name"].as_str().unwrap();
        let world = World::new();
        // The home's `accounts.json` and `.claude.json`, whatever the env says.
        let server = Server::spawn(
            &world,
            &[
                ("CLAUDIUS_ACCOUNTS_DIR", ""),
                ("CLAUDIUS_CLAUDE_CONFIG_PATH", ""),
            ],
        );
        let replay = Replay {
            world: &world,
            port: server.port,
        };
        // Set by a PUT Rust is known to answer differently, until the next PUT.
        let mut tainted: Option<&str> = None;
        for (i, s) in phase["steps"].as_array().unwrap().iter().enumerate() {
            let why = known_difference(s, &mut tainted);
            requests += match s["op"].as_str() {
                Some("req") => 1,
                Some("concurrent") => s["steps"].as_array().unwrap().len(),
                _ => 0,
            };
            let Some((want, got)) = replay.step(s) else {
                continue;
            };
            let what = json!({"op": s["op"], "method": s["method"], "cwd": s["cwd"], "cookie": s["cookie"], "body": s["body"], "hex": s["hex"]});
            match (js::stringify(&want) == js::stringify(&got), why) {
                (true, None) => {}
                (false, Some(why)) => known.push(format!("{name} #{i}: {why}")),
                (true, Some(why)) => {
                    failures.push(format!("{name} #{i}: listed ({why}) but equal"))
                }
                (false, None) => failures.push(format!(
                    "{name} #{i} {}\n  want {}\n  got  {}",
                    js::stringify(&what),
                    js::stringify(&want),
                    js::stringify(&got)
                )),
            }
        }
        server.stop(Duration::from_secs(30));
    }
    assert!(
        failures.is_empty(),
        "{} steps differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(known.len(), 2, "{known:?}");
    assert!(requests >= 180, "only {requests} requests");
}

/// This route reads cookies with D01's parser; D21 recorded Next's
/// `RequestCookies` on 46 raw headers.
#[test]
fn cookies_parse_like_next() {
    let fx = fixture("../claudius-core/tests/fixtures/open_tabs_golden.json");
    let cases = fx["cookies"].as_array().unwrap();
    assert!(cases.len() >= 40);
    let mut failures = vec![];
    for c in cases {
        let header = c["header"].as_str().unwrap();
        let got = json!(parse_cookie_header(header));
        if got != c["got"] {
            failures.push(format!("{header:?}: want {} got {got}", c["got"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
