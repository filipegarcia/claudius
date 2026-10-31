//! `/api/heartbeat` and `/api/heartbeatz` against the real binary, replaying
//! `fixtures/heartbeat_golden.json` (recorded by
//! `rust/scripts/heartbeat-golden.mjs` from the real route modules, on the
//! real DB layer, through Next's own method table and `vary` header). The
//! server's cwd is the world's project, so the readiness check probes
//! `$HOME/.claude/projects/$ENC/.claudius.db` under the state home; the same
//! world changes run between the requests (a projects dir that is a file,
//! read-only folders and files, a database that isn't one, migrated
//! databases with a bad schema version or `schema_meta`), and every request
//! must answer the same status, the same headers (all but the transport
//! ones: `date`, `connection`, `keep-alive`, `transfer-encoding`,
//! `content-length`) and the same body, with `ts` read during the request.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use claudius_core::db::{Mode, latest_version, open_path};
use claudius_core::{now_ms, paths};
use common::{Server, World};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/heartbeat_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

const TRANSPORT: [&str; 5] = [
    "date",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
];

/// `(status, headers but the transport ones (lowercased, sorted), body)`.
type Answer = (u16, Vec<(String, String)>, String);

fn request(port: u16, method: &str, path: &str) -> Answer {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
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
    (status, headers, body.to_owned())
}

/// [`request`], with the body's `ts` (`Date.now()` during the request)
/// checked and replaced by `$TS`.
fn timed_request(port: u16, method: &str, path: &str) -> Result<Answer, String> {
    let t0 = now_ms();
    let (status, headers, mut body) = request(port, method, path);
    let t1 = now_ms();
    if let Some(at) = body.find("\"ts\":") {
        let digits: String = body[at + 5..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let ts: i64 = digits.parse().map_err(|_| format!("bad ts in {body}"))?;
        if !(t0..=t1).contains(&ts) {
            return Err(format!("ts {ts} not in {t0}..={t1}"));
        }
        body = body.replacen(&format!("\"ts\":{digits}"), "\"ts\":$TS", 1);
    }
    Ok((status, headers, body))
}

/// Leaves every mode writable again, so the temp dir can go.
struct Restore(PathBuf);

impl Drop for Restore {
    fn drop(&mut self) {
        let _ = std::process::Command::new("chmod")
            .args(["-R", "u+rwx"])
            .arg(&self.0)
            .status();
    }
}

fn raw_db(path: &Path, sql: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let c = rusqlite::Connection::open(path).unwrap();
    c.pragma_update(None, "journal_mode", "WAL").unwrap();
    c.execute_batch(sql).unwrap();
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    assert_eq!(fx["vary"], claudius_server::heartbeat::VARY);
    let world = World::new();
    let _restore = Restore(world.root.path().to_path_buf());
    let server = Server::spawn(&world, &[]);
    let home = world.home.display().to_string();
    let enc = paths::encode_project_dir(&world.project.display().to_string());
    let real = |p: &str| {
        p.replace("$HOME", &home)
            .replace("$ENC", &enc)
            .replace("$LAST", &latest_version().to_string())
    };
    let scrub = |s: &str| s.replace(&home, "$HOME").replace(&enc, "$ENC");
    let db_path = PathBuf::from(real("$HOME/.claude/projects/$ENC/.claudius.db"));

    let steps = fx["steps"].as_array().unwrap();
    let mut failures = vec![];
    let mut requests = 0;
    for (i, s) in steps.iter().enumerate() {
        let path = s["path"].as_str().map(|p| PathBuf::from(real(p)));
        match s["op"].as_str().unwrap() {
            "request" => {
                requests += 1;
                let method = s["method"].as_str().unwrap();
                let route = s["path"].as_str().unwrap();
                let got = match timed_request(server.port, method, route) {
                    Ok((status, headers, body)) => {
                        json!({"status": status, "headers": headers, "body": scrub(&body)})
                    }
                    Err(e) => {
                        failures.push(format!("#{i} {method} {route}: {e}"));
                        continue;
                    }
                };
                if got != s["got"] {
                    failures.push(format!(
                        "#{i} {method} {route}\n  want {}\n  got  {got}",
                        s["got"]
                    ));
                }
            }
            "write" => {
                let p = path.unwrap();
                let _ = std::fs::remove_dir_all(&p);
                let _ = std::fs::remove_file(&p);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(&p, s["text"].as_str().unwrap()).unwrap();
            }
            "rm" => {
                let p = path.unwrap();
                if p.is_dir() {
                    std::fs::remove_dir_all(&p).unwrap();
                } else if p.exists() {
                    std::fs::remove_file(&p).unwrap();
                }
            }
            "mkdir" => std::fs::create_dir_all(path.unwrap()).unwrap(),
            "chmod" => std::fs::set_permissions(
                path.unwrap(),
                std::fs::Permissions::from_mode(s["mode"].as_u64().unwrap() as u32),
            )
            .unwrap(),
            "sql" => raw_db(&path.unwrap(), s["sql"].as_str().unwrap()),
            "migrated" => {
                drop(open_path(&db_path, Mode::ReadWrite).unwrap());
                let sql = real(s["sql"].as_str().unwrap());
                if !sql.is_empty() {
                    raw_db(&db_path, &sql);
                }
            }
            op => panic!("unknown op {op}"),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} steps differ:\n{}",
        failures.len(),
        steps.len(),
        failures.join("\n")
    );
    assert!(requests >= 35, "{requests} requests");

    // Not in the golden (the recorder's cwd is the repo): Node keeps the cwd
    // it read at boot, so removing the server's cwd changes nothing (checked
    // with node 22: `process.cwd()` answers the removed path).
    let last = steps
        .iter()
        .rev()
        .find(|s| s["method"] == "GET" && s["path"] == "/api/heartbeatz")
        .unwrap();
    assert_eq!(last["got"]["status"], 200);
    std::fs::remove_dir_all(&world.project).unwrap();
    let (status, headers, body) = timed_request(server.port, "GET", "/api/heartbeatz").unwrap();
    assert_eq!(
        json!({"status": status, "headers": headers, "body": body}),
        last["got"]
    );
    server.stop(Duration::from_secs(30));
}
