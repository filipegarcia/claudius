//! `GET /api/cost`, `GET /api/cost/loops` and `GET /api/cost/overview`
//! against the real binary, replaying the `routes` steps of
//! `claudius-core/tests/fixtures/cost_golden.json` (recorded by
//! `rust/scripts/cost-golden.mjs` from the real TS routes): the same
//! `workspaces.json` (fake roots under `/claudius-golden/`), account store,
//! transcripts, project databases (`loop_ticks` rows of every SQLite type,
//! a database without the table) and price cache, in one root padded to the
//! recorded length. Every request must answer the same status, content type
//! and body text, and change the same folders and cost caches under
//! `home/.claude`.
//!
//! The recorder ran on a pinned clock (2001-12-15), after every recorded
//! turn's 30-day window, so today / week / month are 0 on the real clock
//! too; the overview's `generatedAt` has to be a time within the request.
//!
//! Then a Rust-only check: a `cost/refresh-prices` POST reprices
//! `GET /api/cost` at once (both routes read the process's one table).
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use claudius_core::db::{self, Mode};
use claudius_core::{now_ms, paths};
use common::{Server, World};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/cost_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `(status, content type, body)`.
fn request(port: u16, method: &str, path: &str) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    s.write_all(head.as_bytes()).unwrap();
    let mut out = vec![];
    s.read_to_end(&mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let content_type = head.split("\r\n").find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, content_type, body.to_owned())
}

/// A recorded response ("threw" is Next's empty 500).
fn expected(got: &Value) -> (u16, Option<String>, String) {
    if got.get("threw").is_some() {
        return (500, None, String::new());
    }
    (
        got["status"].as_u64().unwrap() as u16,
        got["type"].as_str().map(str::to_owned),
        got["body"].as_str().unwrap_or_default().to_owned(),
    )
}

/// A root padded to `len` characters, with `home`, `config` and `project`
/// (the server's cwd) in it.
fn padded_world(len: usize) -> World {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let base_len = base.to_str().unwrap().len();
    assert!(base_len <= len - 3, "tmpdir too long: {}", base.display());
    let root = base.join("r".repeat(len - base_len - 1));
    let (home, config, project) = (root.join("home"), root.join("config"), root.join("project"));
    for d in [&home, &config, &project] {
        std::fs::create_dir_all(d).unwrap();
    }
    World {
        root: tmp,
        home,
        config,
        project,
    }
}

struct Norm {
    root: String,
    eroot: String,
}

impl Norm {
    fn new(root: &Path) -> Norm {
        let root = root.to_str().unwrap().to_owned();
        Norm {
            eroot: paths::encode_project_dir(&root),
            root,
        }
    }

    fn norm(&self, s: &str) -> String {
        s.replace(&self.root, "$ROOT")
            .replace(&self.eroot, "$EROOT")
    }

    fn unnorm(&self, s: &str) -> String {
        s.replace("$EROOT", &self.eroot)
            .replace("$ROOT", &self.root)
    }
}

/// The recorder's `snap()`: every folder under `home/.claude` ("d", "d?"
/// when it can't be read), each cost cache's text; symlinks skipped.
fn snap(n: &Norm, root: &Path) -> BTreeMap<String, String> {
    fn walk(n: &Norm, p: &Path, rel: String, depth: u32, out: &mut BTreeMap<String, String>) {
        let Ok(m) = std::fs::symlink_metadata(p) else {
            return;
        };
        if m.file_type().is_symlink() {
            return;
        }
        if m.is_dir() {
            let Ok(rd) = std::fs::read_dir(p) else {
                out.insert(n.norm(&rel), "d?".into());
                return;
            };
            out.insert(n.norm(&rel), "d".into());
            if depth < 14 {
                for e in rd.flatten() {
                    let name = e.file_name().into_string().unwrap();
                    walk(n, &p.join(&name), format!("{rel}/{name}"), depth + 1, out);
                }
            }
        } else if rel.ends_with("/.claudius-cost-cache.json") {
            let text = String::from_utf8_lossy(&std::fs::read(p).unwrap()).into_owned();
            out.insert(n.norm(&rel), n.norm(&text));
        }
    }
    let mut out = BTreeMap::new();
    walk(
        n,
        &root.join("home/.claude"),
        "home/.claude".into(),
        0,
        &mut out,
    );
    out
}

fn changes(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> Value {
    let mut keys: Vec<&String> = before.keys().chain(after.keys()).collect();
    keys.sort();
    keys.dedup();
    Value::Array(
        keys.into_iter()
            .filter(|k| before.get(*k) != after.get(*k))
            .map(|k| json!([k, after.get(k)]))
            .collect(),
    )
}

fn set_mtime(p: &Path, secs: f64) {
    let d = Duration::from_secs_f64(secs.abs());
    let t = if secs >= 0.0 {
        UNIX_EPOCH + d
    } else {
        UNIX_EPOCH - d
    };
    std::fs::File::open(p).unwrap().set_modified(t).unwrap();
}

/// A setup op of the recorder (`write`, `rm`, `chmod`, `sql`, `rawdb`).
fn apply(s: &Value, n: &Norm, root: &Path, home: &Path) {
    let p = s["path"].as_str().map(|r| root.join(n.unnorm(r)));
    match s["op"].as_str().unwrap() {
        "write" => {
            let p = p.unwrap();
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, n.unnorm(s["text"].as_str().unwrap())).unwrap();
            if let Some(t) = s["mtime"].as_f64() {
                set_mtime(&p, t);
            }
        }
        "rm" => {
            let p = p.unwrap();
            match std::fs::symlink_metadata(&p) {
                Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p).unwrap(),
                Ok(_) => std::fs::remove_file(&p).unwrap(),
                Err(_) => {}
            }
        }
        "chmod" => {
            let mode = s["mode"].as_u64().unwrap() as u32;
            std::fs::set_permissions(p.unwrap(), std::fs::Permissions::from_mode(mode)).unwrap();
        }
        // `openDb(cwd).exec(sql)`: the migrated project database.
        "sql" => {
            let cwd = s["cwd"].as_str().unwrap();
            let file = home
                .join(".claude/projects")
                .join(paths::encode_project_dir(cwd))
                .join(".claudius.db");
            db::open_path(&file, Mode::ReadWrite)
                .unwrap()
                .execute_batch(s["sql"].as_str().unwrap())
                .unwrap();
        }
        // better-sqlite3 on a bare file, WAL.
        "rawdb" => {
            let p = p.unwrap();
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            let c = rusqlite::Connection::open(&p).unwrap();
            c.pragma_update(None, "journal_mode", "WAL").unwrap();
            c.execute_batch(s["sql"].as_str().unwrap()).unwrap();
        }
        other => panic!("unknown op {other}"),
    }
}

/// `got` with the overview's `generatedAt` put back to the recorded value
/// when it is a time within `[t0, t1]`.
fn pin_generated_at(body: &str, recorded: &str, t0: i64, t1: i64) -> String {
    const KEY: &str = "{\"generatedAt\":";
    let Some(rest) = body.strip_prefix(KEY) else {
        return body.to_owned();
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let Some(want) = recorded.strip_prefix(KEY).map(|r| {
        r.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
    }) else {
        return body.to_owned();
    };
    match digits.parse::<i64>() {
        Ok(t) if (t0..=t1).contains(&t) => format!("{KEY}{want}{}", &rest[digits.len()..]),
        _ => body.to_owned(),
    }
}

#[test]
fn cost_routes_replay_the_ts_golden() {
    let fx = fixture();
    let world = padded_world(fx["rootLen"].as_u64().unwrap() as usize);
    let root = world.home.parent().unwrap().to_path_buf();
    let n = Norm::new(&root);
    let mut server: Option<Server> = None;
    let mut before = snap(&n, &root);
    let mut failures = vec![];
    for (i, s) in fx["routes"]["steps"].as_array().unwrap().iter().enumerate() {
        if s["op"] != "request" {
            apply(s, &n, &root, &world.home);
            continue;
        }
        let port = server
            .get_or_insert_with(|| {
                Server::spawn(
                    &world,
                    &[("TZ", "UTC"), ("CLAUDIUS_DISABLE_PRICE_REFRESH", "1")],
                )
            })
            .port;
        let method = s["method"].as_str().unwrap();
        let path = s["path"].as_str().unwrap();
        let t0 = now_ms();
        let (status, ty, body) = request(port, method, path);
        let t1 = now_ms();
        let after = snap(&n, &root);
        let changed = changes(&before, &after);
        before = after;
        let at = format!("step {i} {method} {path}");
        if s["notExported"] == true {
            if status != 405 {
                failures.push(format!("{at}: {status}, want 405"));
            }
            continue;
        }
        let want = expected(&s["got"]);
        let body = pin_generated_at(&n.norm(&body), &want.2, t0, t1);
        let got = (status, ty, body);
        if got != want {
            failures.push(format!("{at}:\n  got  {got:?}\n  want {want:?}"));
        }
        if changed != s["changes"] {
            failures.push(format!("{at}: changes {changed}\n  want {}", s["changes"]));
        }
    }
    drop(server);
    let _ = std::fs::set_permissions(
        world.home.join(".claude/projects/-claudius-golden-route-b"),
        std::fs::Permissions::from_mode(0o755),
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// An upstream answering every request with `body` (JSON, 200).
fn upstream(body: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { continue };
            let mut head = Vec::new();
            let mut buf = [0u8; 4096];
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match conn.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => head.extend_from_slice(&buf[..k]),
                }
            }
            let _ = write!(
                conn,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    base
}

/// The `byModel` row of `model` in a `GET /api/cost` body.
fn model_usd(body: &str, model: &str) -> Value {
    let v: Value = serde_json::from_str(body).unwrap();
    v["byModel"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["model"] == model)
        .map_or(Value::Null, |m| m["usd"].clone())
}

#[test]
fn a_price_refresh_reprices_the_cost_report() {
    let world = World::new();
    let cwd = "/claudius-golden/refresh";
    let claudius = world.home.join(".claude/.claudius");
    std::fs::create_dir_all(&claudius).unwrap();
    std::fs::write(
        claudius.join("workspaces.json"),
        json!({"version": 1, "workspaces": [{
            "id": "wks_r", "name": "R", "rootPath": cwd,
            "icon": {"kind": "letter", "letter": "R", "color": "#d97757"},
            "createdAt": 1, "updatedAt": 1, "defaults": {"additionalDirectories": []},
        }]})
        .to_string(),
    )
    .unwrap();
    let dir = world
        .home
        .join(".claude/projects")
        .join(paths::encode_project_dir(cwd));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("s1.jsonl"),
        concat!(
            r#"{"type":"assistant","timestamp":"2001-01-05T12:00:00.000Z","requestId":"q1","#,
            r#""message":{"id":"m1","model":"claude-golden-route","usage":{"input_tokens":1000000,"output_tokens":0}}}"#,
            "\n"
        ),
    )
    .unwrap();
    std::fs::write(
        world.home.join(".claude/.claudius-litellm-prices.json"),
        json!({"claude-golden-route": {"input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6}})
            .to_string(),
    )
    .unwrap();
    let base = upstream(
        json!({"claude-golden-route": {"input_cost_per_token": 3e-6, "output_cost_per_token": 2e-6}})
            .to_string(),
    );
    let server = Server::spawn(
        &world,
        &[
            ("TZ", "UTC"),
            ("CLAUDIUS_DEV", "1"),
            ("CLAUDIUS_DEV_FETCH_BASE", &base),
            // On (a fresh cache: no background refresh).
            ("CLAUDIUS_DISABLE_PRICE_REFRESH", ""),
        ],
    );
    let path = "/api/cost?cwd=%2Fclaudius-golden%2Frefresh";
    let (status, _, body) = request(server.port, "GET", path);
    assert_eq!(status, 200, "{body}");
    assert_eq!(model_usd(&body, "claude-golden-route"), json!(1));
    let (status, _, body) = request(server.port, "POST", "/api/cost/refresh-prices");
    assert_eq!(status, 200, "{body}");
    assert!(body.contains(r#""ok":true"#), "{body}");
    let (status, _, body) = request(server.port, "GET", path);
    assert_eq!(status, 200, "{body}");
    assert_eq!(model_usd(&body, "claude-golden-route"), json!(3));
}
