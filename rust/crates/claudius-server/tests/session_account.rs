//! `GET/POST /api/sessions/:id/account` (S30) on the real binary and the
//! fake CLI, replaying the TS handler's recorded groups
//! (`claudius-core/tests/fixtures/session_account_golden.json`, recorded by
//! `rust/scripts/session-account-golden.mjs`) in order on one server, as the
//! recorder ran them in one process: each group starts with no account
//! store and no profiles dir, seeds the store, the session row's state or a
//! file where a profile's config dir goes, starts its session
//! (`POST /api/sessions` with the group's id as `resume`) and sends the
//! requests. Each request's status, content type and body must match byte
//! for byte (a TS throw is Next's empty 500), and after each step: whether
//! the session is live, its row's state text, the `account` of the `ready`
//! a subscriber gets, and the account keys of the environment the step's
//! new CLI (the start, or the rebuild after a move) was spawned with.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use claudius_core::db::{self, Mode};
use common::{Server, World, http, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../claudius-core/tests/fixtures/session_account_golden.json"
    ))
    .unwrap()
}

/// `(status, content type, body)` of a request with exactly `body` (and its
/// `Content-Length`), or no body at all.
fn request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let length = body.map_or_else(String::new, |b| {
        format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        )
    });
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{length}Connection: close\r\n\r\n{}",
        body.unwrap_or_default()
    )
    .unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let ctype = head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, ctype, body.to_owned())
}

/// The `account` of the first `ready` a new subscriber gets (null when it
/// has none).
fn ready_account(port: u16, id: &str) -> Value {
    let mut sse = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        sse,
        "GET /api/sessions/{id}/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
    )
    .unwrap();
    sse.set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let start = Instant::now();
    let mut seen = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let text = String::from_utf8_lossy(&seen).into_owned();
        let ready = text
            .split('\n')
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|d| serde_json::from_str::<Value>(d).ok())
            .find(|e| e["type"] == "ready");
        if let Some(e) = ready {
            return e.get("account").cloned().unwrap_or(Value::Null);
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "no ready on the stream:\n{text}"
        );
        match sse.read(&mut buf) {
            Ok(0) => panic!("stream closed:\n{text}"),
            Ok(n) => seen.extend_from_slice(&buf[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => panic!("{e}"),
        }
    }
}

/// The session row's `state` text (null without a row or a database).
fn state_of(cwd: &str, id: &str) -> Value {
    let Ok(db) = db::open_db(cwd, Mode::ReadOnly) else {
        return Value::Null;
    };
    db.with(|c| {
        c.query_row("SELECT state FROM sessions WHERE id = ?", [id], |r| {
            r.get::<_, String>(0)
        })
    })
    .map_or(Value::Null, Value::String)
}

fn seed_state(cwd: &str, id: &str, state: &str) {
    db::open_db(cwd, Mode::ReadWrite)
        .unwrap()
        .with(|c| {
            c.execute(
                "INSERT INTO sessions(id, cwd, state, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state",
                rusqlite::params![id, cwd, state, 1_767_225_600_000_i64, 1_767_225_600_000_i64, 1_767_225_600_000_i64],
            )
        })
        .unwrap();
}

fn write_store(file: &Path, text: &Value) {
    let _ = std::fs::remove_dir_all(file);
    let _ = std::fs::remove_file(file);
    match text {
        Value::String(d) if d == "$DIR" => std::fs::create_dir(file).unwrap(),
        Value::String(t) => std::fs::write(file, t).unwrap(),
        _ => {}
    }
}

/// The recorded account keys of the env file the next CLI writes, `$ROOT`
/// for the root.
fn cli_env(file: &Path, keys: &[Value], root: &str) -> Value {
    wait_until("the CLI's env", Duration::from_secs(10), || file.exists());
    let mut text = String::new();
    wait_until("the CLI's env", Duration::from_secs(10), || {
        text = std::fs::read_to_string(file).unwrap_or_default();
        serde_json::from_str::<Value>(&text).is_ok()
    });
    let env: Value = serde_json::from_str(&text).unwrap();
    let mut out = serde_json::Map::new();
    for k in keys {
        let k = k.as_str().unwrap();
        if let Some(v) = env[k].as_str() {
            out.insert(k.to_owned(), json!(v.replace(root, "$ROOT")));
        }
    }
    Value::Object(out)
}

#[test]
fn the_route_replays_the_ts_handler() {
    let fx = fixture();
    let groups = fx["route"].as_array().unwrap();
    let keys = fx["envKeys"].as_array().unwrap();
    // The recorder's root is a realpath: so is this one.
    let tmp = tempfile::tempdir().unwrap();
    let root_path = tmp.path().canonicalize().unwrap();
    let world = World {
        home: root_path.join("home"),
        config: root_path.join("config"),
        project: root_path.join("project"),
        root: tmp,
    };
    for d in [&world.home, &world.config, &world.project] {
        std::fs::create_dir_all(d).unwrap();
    }
    let root = root_path.display().to_string();
    let project = world.project.display().to_string();
    // This process reads and seeds the project's database where the server
    // keeps it.
    assert!(claudius_core::paths::set_home_override(world.home.clone()));
    let store_dir = world.home.join(".claude/.claudius");
    std::fs::create_dir_all(&store_dir).unwrap();
    let accounts = store_dir.join("accounts.json");
    let profiles = store_dir.join("profiles");
    let env_file: PathBuf = root_path.join("cli-env.json");
    let log_file = root_path.join("cli-stdin.log");
    let server = Server::spawn(
        &world,
        &[
            ("FAKE_CLAUDE_ENV", &env_file.display().to_string()),
            ("FAKE_CLAUDE_LOG", &log_file.display().to_string()),
        ],
    );
    let port = server.port;
    let mut requests = 0;
    for group in groups {
        let name = group["name"].as_str().unwrap();
        let id = group["id"].as_str().unwrap();
        write_store(&accounts, &Value::Null);
        let _ = std::fs::remove_dir_all(&profiles);
        for (i, step) in group["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{name} / step {i} ({})", step["op"]);
            let _ = std::fs::remove_file(&env_file);
            let mut started = false;
            match step["op"].as_str().unwrap() {
                "store" => write_store(&accounts, &step["text"]),
                "state" => seed_state(&project, id, step["text"].as_str().unwrap()),
                "block" => {
                    let p = profiles.join(step["profile"].as_str().unwrap());
                    std::fs::create_dir_all(&profiles).unwrap();
                    let _ = std::fs::remove_dir_all(&p);
                    std::fs::write(&p, "not a dir").unwrap();
                }
                "create" => {
                    let (st, body) = http(
                        port,
                        "POST",
                        "/api/sessions",
                        &json!({"cwd": project, "resume": id}).to_string(),
                    );
                    assert_eq!(st, 200, "{at}: {body}");
                    started = true;
                }
                "req" => {
                    requests += 1;
                    let target = step["id"].as_str().unwrap_or(id);
                    let method = step["method"].as_str().unwrap();
                    let (status, ctype, body) = request(
                        port,
                        method,
                        &format!("/api/sessions/{target}/account"),
                        step["body"].as_str(),
                    );
                    let want = &step["got"];
                    if want.get("threw").is_some() {
                        assert_eq!(
                            (status, ctype.as_deref(), body.as_str()),
                            (500, None, ""),
                            "{at}: TS threw {}",
                            want["threw"]
                        );
                    } else {
                        assert_eq!(
                            (status, ctype.as_deref(), body.as_str()),
                            (
                                want["status"].as_u64().unwrap() as u16,
                                want["type"].as_str(),
                                want["body"].as_str().unwrap()
                            ),
                            "{at}"
                        );
                    }
                    started = method == "POST"
                        && serde_json::from_str::<Value>(&body)
                            .is_ok_and(|b| b["restarted"] == true);
                }
                op => panic!("{at}: {op}"),
            }
            if !matches!(step["op"].as_str(), Some("create" | "req")) {
                continue;
            }
            let live = http(port, "GET", &format!("/api/sessions/{id}/mode"), "").0 == 200;
            assert_eq!(json!(live), step["live"], "{at}: live");
            assert_eq!(state_of(&project, id), step["state"], "{at}: state");
            let ready = if live {
                ready_account(port, id)
            } else {
                Value::Null
            };
            assert_eq!(
                claudius_agent::js::stringify(&ready),
                claudius_agent::js::stringify(&step["ready"]),
                "{at}: ready.account"
            );
            let env = if started {
                cli_env(&env_file, keys, &root)
            } else {
                Value::Null
            };
            assert_eq!(env, step["env"], "{at}: the CLI's env");
        }
    }
    assert!(requests >= 39, "{requests} requests");
}

/// Only GET and POST are routed: other methods get axum's 405 (Next's
/// answer for a method the route doesn't export), not the 501 guard.
#[test]
fn other_methods_are_405() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let id = server.create_session(&world);
    for method in ["PUT", "PATCH", "DELETE"] {
        let (status, _) = http(
            server.port,
            method,
            &format!("/api/sessions/{id}/account"),
            "",
        );
        assert_eq!(status, 405, "{method}");
    }
}

/// The recap's off-band query runs under the environment the session was
/// spawned with (TS `this.envOverride`, frozen at start), not under the
/// profile that is active when the recap runs.
#[test]
fn a_recap_runs_under_the_session_s_account() {
    let world = World::new();
    let store_dir = world.home.join(".claude/.claudius");
    std::fs::create_dir_all(&store_dir).unwrap();
    let store = |active: &str| {
        json!({
            "profiles": [
                {"id": "acc_alpha", "label": "Alpha", "kind": "api-key", "secret": "sk-ant-api03-FAKE-recap", "createdAt": "2026-01-01T00:00:00.000Z"},
                {"id": "acc_bravo", "label": "Bravo", "kind": "oauth-token", "secret": "sk-ant-oat01-FAKE-recap", "createdAt": "2026-01-01T00:00:00.000Z"},
            ],
            "activeProfileId": active,
            "autoRotateOnRateLimit": false,
        })
        .to_string()
    };
    std::fs::write(store_dir.join("accounts.json"), store("acc_alpha")).unwrap();
    let env_file = world.root.path().join("cli-env.json");
    let script = json!({"turns": [
        {"match": "stepped away", "steps": [{"$text": "Recap under the pin."}]},
    ]});
    let server = Server::spawn(
        &world,
        &[
            ("FAKE_CLAUDE_SCRIPT", &script.to_string()),
            ("FAKE_CLAUDE_ENV", &env_file.display().to_string()),
        ],
    );
    let id = server.create_session(&world);
    let mut sse = server.open_stream(&id);
    let (st, _) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/input"),
        r#"{"text":"hello"}"#,
    );
    assert_eq!(st, 200);
    let seen = common::read_until(&mut sse, "echo:hello", Duration::from_secs(10));
    if !seen[seen.find("echo:hello").unwrap()..].contains(r#""status":"idle""#) {
        common::read_until(&mut sse, r#""status":"idle""#, Duration::from_secs(10));
    }
    let keys = [json!("ANTHROPIC_API_KEY"), json!("CLAUDE_CODE_OAUTH_TOKEN")];
    let root = world.root.path().display().to_string();
    assert_eq!(
        cli_env(&env_file, &keys, &root),
        json!({"ANTHROPIC_API_KEY": "sk-ant-api03-FAKE-recap"})
    );
    // The user switches accounts; the session keeps its credential.
    std::fs::write(store_dir.join("accounts.json"), store("acc_bravo")).unwrap();
    std::fs::remove_file(&env_file).unwrap();
    let (st, _) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/recap"),
        "{}",
    );
    assert_eq!(st, 202);
    let seen = common::read_until(&mut sse, "Recap under the pin.", Duration::from_secs(15));
    assert!(seen.contains(r#""type":"session_recap""#), "{seen}");
    assert_eq!(
        cli_env(&env_file, &keys, &root),
        json!({"ANTHROPIC_API_KEY": "sk-ant-api03-FAKE-recap"})
    );
}
