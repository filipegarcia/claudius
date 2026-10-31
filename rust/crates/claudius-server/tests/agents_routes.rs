//! `/api/agents` (GET, PUT), `/api/agents/:name` (DELETE) and
//! `/api/agents/db` (GET, PUT, DELETE) against the real binary, replaying
//! the TS handlers' recording (`claudius-core/tests/fixtures/
//! agents_golden.json`, from `rust/scripts/agents-golden.mjs`):
//! - `routes`: every request in order on one server without live sessions,
//!   between the same filesystem and SQL setups: status and body byte for
//!   byte (`"updatedAt"` stamps as `"$NOW"`), then the files under both
//!   scopes and the `db_agents` rows;
//! - `reload`: the same with two live sessions in the cwd: each response
//!   and the `reload_plugins` control requests their CLIs got (ids `$ID`).
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use common::{Server, World, read_until};
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../claudius-core/tests/fixtures/agents_golden.json"
        ))
        .unwrap()
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Placeholder ↔ path, as the recorder writes them.
struct Places(Vec<(&'static str, String)>);

impl Places {
    fn new(world: &World) -> Places {
        Places(vec![
            ("$PROJECT", world.project.display().to_string()),
            ("$HOME", world.home.display().to_string()),
        ])
    }
    fn place(&self, s: &str) -> String {
        self.0
            .iter()
            .fold(s.to_owned(), |t, (k, v)| t.replace(v.as_str(), k))
    }
    fn unplace(&self, s: &str) -> String {
        self.0
            .iter()
            .fold(s.to_owned(), |t, (k, v)| t.replace(k, v))
    }
}

/// `method path` with exactly these body bytes, or none (no
/// `Content-Length`) → (status, body).
fn request(port: u16, method: &str, path: &str, body: Option<&[u8]>) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let length = body.map_or_else(String::new, |b| {
        format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        )
    });
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{length}Connection: close\r\n\r\n"
    )
    .unwrap();
    s.write_all(body.unwrap_or_default()).unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let status = out
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = out
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_owned())
        .unwrap_or_default();
    (status, body)
}

/// `"updatedAt"` stamps from `from` on, as `"$NOW"`.
fn nowed(s: &str, from: u64) -> String {
    let to = now_ms();
    let key = "\"updatedAt\":";
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(key) {
        let after = &rest[i + key.len()..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        out.push_str(&rest[..i + key.len()]);
        match after[..digits].parse::<u64>() {
            Ok(n) if digits == 13 && (from..=to).contains(&n) => out.push_str("\"$NOW\""),
            _ => out.push_str(&after[..digits]),
        }
        rest = &after[digits..];
    }
    out.push_str(rest);
    out
}

fn fs_action(pl: &Places, a: &Value) {
    let path = |i: usize| PathBuf::from(pl.unplace(a[i].as_str().unwrap()));
    match a[0].as_str().unwrap() {
        "mkdir" => std::fs::create_dir_all(path(1)).unwrap(),
        "write" => std::fs::write(path(1), unhex(a[2].as_str().unwrap())).unwrap(),
        "chmod" => {
            let mode = a[2].as_u64().unwrap() as u32;
            std::fs::set_permissions(path(1), std::fs::Permissions::from_mode(mode)).unwrap();
        }
        "symlink" => std::os::unix::fs::symlink(path(2), path(1)).unwrap(),
        "rm" => {
            let p = path(1);
            let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
        }
        op => panic!("fs op {op}"),
    }
}

fn tree(pl: &Places, dir: &str) -> Vec<Value> {
    fn walk(pl: &Places, d: &Path, rel: &str, out: &mut Vec<Value>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut names: Vec<String> = rd
            .flatten()
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for n in names {
            let p = d.join(&n);
            let r = format!("{rel}/{n}");
            let md = std::fs::symlink_metadata(&p).unwrap();
            if md.file_type().is_symlink() {
                out.push(json!([
                    "l",
                    r,
                    pl.place(&std::fs::read_link(&p).unwrap().display().to_string())
                ]));
            } else if md.is_dir() {
                out.push(json!(["d", r]));
                walk(pl, &p, &r, out);
            } else {
                out.push(json!(["f", r, hex(&std::fs::read(&p).unwrap())]));
            }
        }
    }
    let mut out = Vec::new();
    walk(pl, Path::new(&pl.unplace(dir)), dir, &mut out);
    out
}

/// The project's `.claudius.db` (under the server's state home).
fn db_file(world: &World) -> PathBuf {
    let enc = claudius_core::paths::encode_project_dir(&world.project.display().to_string());
    world
        .home
        .join(".claude/projects")
        .join(enc)
        .join(".claudius.db")
}

fn db_rows(world: &World, from: u64) -> Vec<Value> {
    let c = rusqlite::Connection::open_with_flags(
        db_file(world),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut st = c
        .prepare("SELECT quote(name), quote(definition_json), quote(updated_at) FROM db_agents ORDER BY rowid")
        .unwrap();
    let to = now_ms();
    let text = |r: &rusqlite::Row, i: usize| match r.get_ref(i).unwrap() {
        rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        v => panic!("quote() gave {v:?}"),
    };
    st.query_map([], |r| {
        let u = text(r, 2);
        let u = if u.parse::<u64>().is_ok_and(|n| (from..=to).contains(&n)) {
            "$NOW".to_owned()
        } else {
            u
        };
        Ok(json!([text(r, 0), text(r, 1), u]))
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

/// One recorded request → `(status, body)` as recorded.
fn call(server: &Server, pl: &Places, step: &Value, from: u64) -> (u64, String) {
    let bytes = match (&step["request"], &step["requestHex"]) {
        (Value::String(b), _) => Some(pl.unplace(b).into_bytes()),
        (_, Value::String(h)) => Some(unhex(h)),
        _ => None,
    };
    let url = pl.unplace(step["url"].as_str().unwrap());
    let (status, body) = request(
        server.port,
        step["method"].as_str().unwrap(),
        &url,
        bytes.as_deref(),
    );
    (u64::from(status), nowed(&pl.place(&body), from))
}

#[test]
fn agents_routes_answer_like_ts() {
    let fx = &fixture()["routes"];
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let pl = Places::new(&world);
    let from = now_ms();
    let steps = fx["steps"].as_array().unwrap();
    assert!(steps.len() > 130, "{} steps", steps.len());
    for (i, step) in steps.iter().enumerate() {
        if let Some(actions) = step["fs"].as_array() {
            actions.iter().for_each(|a| fs_action(&pl, a));
            continue;
        }
        if let Some(sql) = step["sql"].as_str() {
            rusqlite::Connection::open(db_file(&world))
                .unwrap()
                .execute_batch(sql)
                .unwrap();
            continue;
        }
        let (status, body) = call(&server, &pl, step, from);
        let shown = format!("step {i}: {} {}", step["method"], step["url"]);
        assert_eq!(
            body,
            step["body"]
                .as_str()
                .map_or_else(|| step["body"].to_string(), str::to_owned),
            "{shown}: body"
        );
        assert_eq!(status, step["status"].as_u64().unwrap(), "{shown}: status");
    }
    let mut got = tree(&pl, "$PROJECT/.claude");
    got.extend(tree(&pl, "$HOME/.claude/agents"));
    assert_eq!(Value::Array(got), fx["tree"], "files");
    assert_eq!(Value::Array(db_rows(&world, from)), fx["rows"], "db rows");
    server.stop(Duration::from_secs(10));
}

/// The `reload_plugins` control requests in `log` past byte `from`, ids as
/// `$ID`, sorted. The two CLIs append to the same file, and the fake writes
/// a line and its newline separately, so lines can run together: read the
/// text as a stream of JSON values instead.
fn reload_wire(log: &Path, from: usize) -> Vec<String> {
    let text = std::fs::read(log).unwrap_or_default();
    let text = String::from_utf8_lossy(&text[from.min(text.len())..]).into_owned();
    let mut it = serde_json::Deserializer::from_str(&text).into_iter::<Value>();
    let (mut start, mut v) = (0, Vec::new());
    while let Some(Ok(m)) = it.next() {
        let end = it.byte_offset();
        let raw = text[start..end].trim_start();
        start = end;
        if m["type"] == "control_request" && m["request"]["subtype"] == "reload_plugins" {
            let id = serde_json::to_string(&m["request_id"]).unwrap();
            v.push(raw.replacen(&id, "\"$ID\"", 1));
        }
    }
    v.sort();
    v
}

fn log_len(log: &Path) -> usize {
    std::fs::metadata(log).map_or(0, |m| m.len() as usize)
}

#[test]
fn saving_a_file_agent_reloads_the_cwds_sessions() {
    let fx = &fixture()["reload"];
    let world = World::new();
    let log = world.root.path().join("cli.log");
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_LOG", &log.display().to_string())]);
    let pl = Places::new(&world);
    let n = fx["sessions"].as_u64().unwrap();
    let mut streams = Vec::new();
    for _ in 0..n {
        let id = server.create_session(&world);
        let mut sse = server.open_stream(&id);
        read_until(&mut sse, r#""type":"tips""#, Duration::from_secs(10));
        streams.push(sse);
    }
    let from = now_ms();
    for (i, step) in fx["steps"].as_array().unwrap().iter().enumerate() {
        let at = log_len(&log);
        let (status, body) = call(&server, &pl, step, from);
        let shown = format!("step {i}: {} {}", step["method"], step["url"]);
        assert_eq!(body, step["body"].as_str().unwrap(), "{shown}: body");
        assert_eq!(status, step["status"].as_u64().unwrap(), "{shown}: status");
        let want: Vec<String> = serde_json::from_value(step["wire"].clone()).unwrap();
        assert_eq!(reload_wire(&log, at), want, "{shown}: wire");
    }
    drop(streams);
    server.stop(Duration::from_secs(10));
}
