//! `GET/POST/PATCH/DELETE /api/memory/auto` and `/api/memory/rules` (G08)
//! against the real binary, replaying the TS handlers' recorded groups
//! (`claudius-core/tests/fixtures/memory_golden.json`, recorded by
//! `rust/scripts/memory-golden.mjs`) in order, one world and one server per
//! group. The server runs with its cwd at `<root>/project` (the first
//! trusted root), `CLAUDIUS_STATE_HOME` at `<root>/home` (the home dir the
//! memory and user-rules dirs hang off) and umask 022, like the recorder.
//!
//! Each request checks the status, content type and body byte for byte
//! (`threw` is Next's empty 500, whose error text the server must log) and
//! every watched path the request changed (kind, mode, text or bytes,
//! symlink target), and each group's tree at the end. The recorder pinned
//! the clock, so each ISO timestamp is compared as `<ISO>`.
//!
//! The groups with sessions run three live sessions on the fake CLI, like
//! the recorder's bare ones: A and B in the project, C in the `ws`
//! workspace, A and C seeded with Read paths by a turn whose assistant Reads
//! them. TS recorded the `memory-update` reminders each request queued; the
//! `probes` group sends a probe turn to every session after each request,
//! which must carry exactly those, and the others one probe turn per session
//! at the end, which carries them all.
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use common::{Server, free_port, read_until, wait_until};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../claudius-core/tests/fixtures/memory_golden.json"
    ))
    .unwrap()
}

/// Requests (group, a substring of the recorded body) whose response body
/// differs, the recorded text rewritten to what Rust sends, and why. Each
/// must still differ before the rewrite, so a fix shows up here.
const GAPS: &[(&str, &str, (&str, &str), &str)] = &[(
    "auto requests",
    r#"{"description":"\ud83d lone"}"#,
    (r"\ud83d", "\u{FFFD}"),
    "a lone surrogate escape in the body reads as U+FFFD, so the PATCH echoes it as the \
     character where JSON.stringify writes the `\\ud83d` escape (the file and the index get \
     the same bytes either way)",
)];

/// The watched roots besides each project's memory dir (the recorder's
/// `WATCH`).
fn watch() -> Vec<String> {
    [
        "home/.claude/rules",
        "project",
        "ws",
        "ws-extra",
        "untrusted",
        "outside",
        "nowhere",
        "caf\u{e9} x\u{1f600}",
        "long",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

struct World {
    _dir: tempfile::TempDir,
    root: String,
    eroot: String,
}

impl World {
    fn new(layout: &Value) -> World {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        assert!(
            root.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b)),
            "placeholders are swapped textually: {root}"
        );
        let eroot = root
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let w = World {
            _dir: dir,
            root,
            eroot,
        };
        for d in layout["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(w.path(d.as_str().unwrap())).unwrap();
        }
        for f in layout["files"].as_array().unwrap() {
            let p = w.path(f[0].as_str().unwrap());
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, w.sub(f[1].as_str().unwrap())).unwrap();
        }
        w
    }

    fn path(&self, rel: &str) -> PathBuf {
        PathBuf::from(format!("{}/{}", self.root, self.sub(rel)))
    }

    fn sub(&self, s: &str) -> String {
        s.replace("$EROOT", &self.eroot)
            .replace("$ROOT", &self.root)
    }

    fn rel(&self, s: &str) -> String {
        s.replace(&self.eroot, "$EROOT")
            .replace(&self.root, "$ROOT")
    }

    fn apply(&self, op: &Value) {
        let p = self.path(op["path"].as_str().unwrap());
        match op["op"].as_str().unwrap() {
            "write" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let bytes = match op.get("bytes") {
                    Some(b) => b
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_u64().unwrap() as u8)
                        .collect(),
                    None => self.sub(op["text"].as_str().unwrap()).into_bytes(),
                };
                std::fs::write(p, bytes).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(p).unwrap(),
            "rm" => {
                open_up(&p);
                match std::fs::symlink_metadata(&p) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(p).unwrap(),
                    Ok(_) => std::fs::remove_file(p).unwrap(),
                    Err(_) => {}
                }
            }
            "symlink" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(self.sub(op["target"].as_str().unwrap()), p).unwrap()
            }
            "chmod" => std::fs::set_permissions(
                p,
                std::fs::Permissions::from_mode(op["mode"].as_u64().unwrap() as u32),
            )
            .unwrap(),
            "mtime" => set_mtime_ns(&p, op["ns"].as_str().unwrap().parse().unwrap()),
            other => panic!("unknown op {other}"),
        }
    }

    /// The recorder's `snapshot()`.
    fn snapshot(&self) -> BTreeMap<String, Value> {
        let mut snap = BTreeMap::new();
        let mut projects: Vec<String> = std::fs::read_dir(self.path("home/.claude/projects"))
            .map(|rd| {
                rd.map(|e| e.unwrap().file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        js_sort(&mut projects);
        for p in projects {
            let rel = if p == "memory" {
                "home/.claude/projects/memory".to_owned()
            } else {
                format!("home/.claude/projects/{}/memory", self.rel(&p))
            };
            self.visit(&rel, &mut snap);
        }
        for rel in watch() {
            self.visit(&rel, &mut snap);
        }
        snap
    }

    fn visit(&self, rel: &str, snap: &mut BTreeMap<String, Value>) {
        if snap.contains_key(rel) {
            return;
        }
        let abs = self.path(rel);
        let Ok(meta) = std::fs::symlink_metadata(&abs) else {
            return;
        };
        let mode = meta.permissions().mode() & 0o777;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&abs).unwrap().display().to_string();
            snap.insert(
                rel.into(),
                json!({"kind": "symlink", "target": self.rel(&target)}),
            );
        } else if meta.is_dir() {
            let mut entry = json!({"kind": "dir", "mode": mode});
            let names = match std::fs::read_dir(&abs) {
                Ok(rd) => {
                    let mut names: Vec<String> = rd
                        .map(|e| e.unwrap().file_name().into_string().unwrap())
                        .collect();
                    js_sort(&mut names);
                    names
                }
                Err(_) => {
                    entry["unreadable"] = json!(true);
                    Vec::new()
                }
            };
            snap.insert(rel.into(), entry);
            for n in names {
                self.visit(&format!("{rel}/{}", self.rel(&n)), snap);
            }
        } else {
            let entry = match std::fs::read(&abs) {
                Err(_) => json!({"kind": "file", "mode": mode, "unreadable": true}),
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => json!({"kind": "file", "mode": mode, "text": self.rel(&text)}),
                    Err(e) => json!({"kind": "file", "mode": mode, "bytes": e.into_bytes()}),
                },
            };
            snap.insert(rel.into(), entry);
        }
    }
}

/// chmod every directory under `p` back to 0755, so it can be removed.
fn open_up(p: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(p) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    if std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).is_err() {
        return;
    }
    for e in std::fs::read_dir(p).unwrap() {
        open_up(&e.unwrap().path());
    }
}

/// `utimesSync(p, t, t)` to the nanosecond the recorder read back.
fn set_mtime_ns(p: &Path, ns: i128) {
    let secs = ns.div_euclid(1_000_000_000);
    let nanos = ns.rem_euclid(1_000_000_000) as u32;
    let t = std::time::UNIX_EPOCH + Duration::new(secs as u64, nanos);
    let f = std::fs::OpenOptions::new()
        .read(true)
        .open(p)
        .or_else(|_| std::fs::OpenOptions::new().write(true).open(p));
    match f {
        Ok(f) => f
            .set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t))
            .unwrap(),
        Err(_) => {
            // No read or write permission: lend it one for the call.
            let mode = std::fs::metadata(p).unwrap().permissions().mode();
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode | 0o400)).unwrap();
            set_mtime_ns(p, ns);
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
        }
    }
}

/// JS's default `sort()`: by UTF-16 code units.
fn js_sort(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// Every `YYYY-MM-DDTHH:MM:SS.mmmZ` as `<ISO>`.
fn iso(s: &str) -> String {
    const SHAPE: &[u8] = b"dddd-dd-ddTdd:dd:dd.dddZ";
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        let hit = b.len() - i >= SHAPE.len()
            && SHAPE.iter().zip(&b[i..]).all(|(want, got)| match want {
                b'd' => got.is_ascii_digit(),
                w => w == got,
            });
        if hit {
            out.push_str("<ISO>");
            i += SHAPE.len();
        } else {
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// The recorder's `changes`.
fn changes(before: &BTreeMap<String, Value>, after: &BTreeMap<String, Value>) -> Value {
    let mut keys: Vec<String> = before.keys().chain(after.keys()).cloned().collect();
    js_sort(&mut keys);
    keys.dedup();
    Value::Array(
        keys.into_iter()
            .filter(|k| before.get(k) != after.get(k))
            .map(|k| {
                let v = after.get(&k).cloned().unwrap_or(Value::Null);
                json!([k, v])
            })
            .collect(),
    )
}

/// A snapshot or `changes` value with its ISO timestamps as `<ISO>`.
fn iso_deep(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(iso(s)),
        Value::Array(a) => Value::Array(a.iter().map(iso_deep).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| (k.clone(), iso_deep(x)))
                .collect::<Map<String, Value>>(),
        ),
        v => v.clone(),
    }
}

/// `claudius` for one world under umask 022, with the fake CLI.
fn spawn(world: &World, log: &Path) -> Server {
    let port = free_port();
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg("umask 022 && exec \"$0\" \"$@\"")
        .arg(env!("CARGO_BIN_EXE_claudius"))
        .args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(common::fake_bin())
        .current_dir(world.path("project"))
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_DEV")
        .env_remove("CLAUDIUS_SCHEDULER")
        .env("CLAUDIUS_STATE_HOME", world.path("home"))
        .env("CLAUDE_CONFIG_DIR", world.path("config"))
        .env("FAKE_CLAUDE_LOG", log)
        .stdout(std::fs::File::create(world.path("server.out")).unwrap())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().unwrap();
    wait_until("health", Duration::from_secs(20), || {
        if let Ok(Some(st)) = child.try_wait() {
            panic!("claudius exited ({st})");
        }
        TcpStream::connect(("127.0.0.1", port)).is_ok()
            && request(port, "GET", "/api/rust/health", None).0 == 200
    });
    Server { child, port }
}

/// One HTTP/1.1 request → (status, content type, body).
fn request(
    port: u16,
    method: &str,
    url: &str,
    body: Option<&str>,
) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let body = body.unwrap_or("");
    write!(
        s,
        "{method} {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8(raw).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let ctype = lines.find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, ctype, body.to_owned())
}

fn open_stream(port: u16, id: &str) -> TcpStream {
    let mut sse = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        sse,
        "GET /api/sessions/{id}/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
    )
    .unwrap();
    read_until(&mut sse, r#""type":"tips""#, Duration::from_secs(10));
    sse
}

/// A live session standing in for one of the recorder's bare ones.
struct Live {
    key: String,
    id: String,
    sse: TcpStream,
    turns: usize,
}

/// Post `text` as a turn and wait for it to end. `sendInput` broadcasts
/// `running` before the POST answers, and these turns send one `running`
/// and then one `idle`, so the first `running` read is this turn's, and so is
/// the `idle` after it.
fn run_turn(server: &Server, live: &mut Live, text: &str) {
    let (st, _, body) = request(
        server.port,
        "POST",
        &format!("/api/sessions/{}/input", live.id),
        Some(&json!({ "text": text }).to_string()),
    );
    assert_eq!(st, 200, "{body}");
    let running = r#""status":"running""#;
    let idle = r#""status":"idle""#;
    let seen = read_until(&mut live.sse, running, Duration::from_secs(20));
    if !seen[seen.find(running).unwrap()..].contains(idle) {
        read_until(&mut live.sse, idle, Duration::from_secs(20));
    }
}

/// A probe turn: what the CLI's user message carried before the prompt.
/// The fake logs each stdin line before it acts on it, so the line is in by
/// the turn's `idle`, and in one write, so it stays whole while the other
/// sessions' fakes append to the same log (I22).
fn probe(server: &Server, live: &mut Live, log: &Path) -> String {
    live.turns += 1;
    let text = format!("probe {} {}", live.key, live.turns);
    run_turn(server, live, &text);
    let raw = std::fs::read_to_string(log).unwrap();
    let content = raw
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|m| m["type"] == "user")
        .filter_map(|m| m["message"]["content"].as_str().map(str::to_owned))
        .rfind(|c| c.ends_with(&text))
        .unwrap_or_else(|| {
            let torn: Vec<&str> = raw
                .lines()
                .filter(|l| serde_json::from_str::<Value>(l).is_err())
                .collect();
            panic!("no user message for {text}; the log's unparsable lines: {torn:#?}")
        });
    content[..content.len() - text.len()].to_owned()
}

/// The group's sessions, created and seeded with their Read paths.
fn start_sessions(server: &Server, world: &World, group: &Value) -> Vec<Live> {
    let mut out = Vec::new();
    for s in group["sessions"].as_array().unwrap() {
        let key = s["key"].as_str().unwrap().to_owned();
        let cwd = world.sub(s["cwd"].as_str().unwrap());
        let (st, _, body) = request(
            server.port,
            "POST",
            "/api/sessions",
            Some(&json!({ "cwd": cwd }).to_string()),
        );
        assert_eq!(st, 200, "session {key}: {body}");
        let id = serde_json::from_str::<Value>(&body).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let sse = open_stream(server.port, &id);
        let mut live = Live {
            key,
            id,
            sse,
            turns: 0,
        };
        let reads: Vec<Value> = s["reads"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(n, p)| {
                json!({"type": "tool_use", "id": format!("toolu_read_{n}"), "name": "Read",
                       "input": {"file_path": world.sub(p.as_str().unwrap())}})
            })
            .collect();
        let seed =
            json!([{"type": "assistant", "message": {"role": "assistant", "content": reads}}]);
        run_turn(server, &mut live, &format!("script:{seed}"));
        out.push(live);
    }
    out
}

/// The server's output from byte `from` on.
fn output_since(path: &Path, from: usize) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    String::from_utf8_lossy(bytes.get(from..).unwrap_or_default()).into_owned()
}

/// `(status, content type, body)` of a recorded `got`; `threw` is Next's
/// empty 500.
fn expected(got: &Value) -> (u16, Option<String>, String) {
    if got.get("threw").is_some() {
        return (500, None, String::new());
    }
    (
        got["status"].as_u64().unwrap() as u16,
        got["type"].as_str().map(str::to_owned),
        iso(got["body"].as_str().unwrap()),
    )
}

fn perm_enforced() -> bool {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("probe");
    std::fs::create_dir(&p).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o0)).unwrap();
    let enforced = std::fs::read_dir(&p).is_err();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    enforced
}

fn host_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}

/// A group's tally: requests replayed, and the gaps that still differ.
#[derive(Default)]
struct Tally {
    requests: usize,
    gaps_differing: Vec<(String, String)>,
}

fn replay_group(fx: &Value, group: &Value, tally: &mut Tally) {
    let name = group["name"].as_str().unwrap();
    let world = World::new(&fx["world"]);
    let log = world.path("stdin.log");
    let out = world.path("server.out");
    let probes = group["probes"].as_bool().unwrap();
    let server = spawn(&world, &log);
    let mut sessions = start_sessions(&server, &world, group);
    let mut pending: BTreeMap<String, String> = BTreeMap::new();
    let mut last = std::time::Instant::now();

    for (i, step) in group["steps"].as_array().unwrap().iter().enumerate() {
        if let Some(ops) = step.get("setup") {
            for op in ops.as_array().unwrap() {
                world.apply(op);
            }
            continue;
        }
        tally.requests += 1;
        let req = &step["request"];
        let method = req["method"].as_str().unwrap();
        let url = world.sub(req["url"].as_str().unwrap());
        let body = req.get("body").map(|b| world.sub(b.as_str().unwrap()));
        let before = world.snapshot();
        let out_from = std::fs::metadata(&out).map_or(0, |m| m.len() as usize);
        // A write stamps `modified` with the server's clock: keep each
        // request on a later millisecond than the last, so a rewrite that
        // only moves the stamp still changes the file, as with TS's ticks.
        while last.elapsed() < Duration::from_millis(2) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let (status, ctype, text) = request(server.port, method, &url, body.as_deref());
        last = std::time::Instant::now();
        let after = world.snapshot();
        let what = format!(
            "{name} step {i}: {method} {} {}",
            req["url"],
            req.get("body").unwrap_or(&Value::Null)
        );

        let mut want = expected(&step["got"]);
        let got = (status, ctype, iso(&world.rel(&text)));
        let gap = GAPS.iter().find(|(g, marker, _, _)| {
            *g == name && req["body"].as_str().is_some_and(|b| b.contains(marker))
        });
        if let Some((g, marker, (from, to), _)) = gap {
            if got != want {
                tally
                    .gaps_differing
                    .push((g.to_string(), marker.to_string()));
            }
            want.2 = want.2.replace(from, to);
        }
        assert_eq!(got, want, "{what}");
        if let Some(t) = step["got"]["threw"].as_str() {
            let t = world.sub(t);
            let logged = output_since(&out, out_from);
            assert!(
                logged.contains(&format!("] {t}\n")),
                "{what}: the server logs {t:?}:\n{logged}"
            );
        }
        assert_eq!(
            iso_deep(&changes(&before, &after)),
            iso_deep(&step["changes"]),
            "{what}: changed"
        );

        let reminders = &step["reminders"];
        for live in sessions.iter_mut() {
            let want = reminders[&live.key].as_str().unwrap_or("").to_owned();
            let want = world.sub(&want);
            if probes {
                assert_eq!(
                    probe(&server, live, &log),
                    want,
                    "{what}: session {}'s next turn",
                    live.key
                );
            } else {
                pending.entry(live.key.clone()).or_default().push_str(&want);
            }
        }
    }
    if !probes {
        for live in sessions.iter_mut() {
            let want = pending.remove(&live.key).unwrap_or_default();
            assert_eq!(
                probe(&server, live, &log),
                want,
                "{name}: the reminders session {} got",
                live.key
            );
        }
    }
    let end: Value = Value::Object(world.snapshot().into_iter().collect());
    assert_eq!(
        iso_deep(&end),
        iso_deep(&group["final"]),
        "{name}: the tree at the end"
    );
    drop(sessions);
    drop(server);
    open_up(Path::new(&world.root));
}

#[test]
fn the_routes_replay_the_ts_handlers() {
    let fx = fixture();
    let perm = perm_enforced();
    let mut tally = Tally::default();
    let mut ran = 0;
    for group in fx["routes"].as_array().unwrap() {
        if group["skipped"] == true {
            continue;
        }
        if let Some(os) = group["os"].as_str()
            && os != host_platform()
        {
            continue;
        }
        let needs_perm = group["needs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n == "perm");
        if needs_perm && !perm {
            continue;
        }
        ran += 1;
        replay_group(&fx, group, &mut tally);
    }
    for (g, marker, _, why) in GAPS {
        assert!(
            tally
                .gaps_differing
                .iter()
                .any(|(dg, dm)| dg == g && dm == marker),
            "stale gap {g} / {marker}: {why}"
        );
    }
    let skipped_os = if host_platform() == "darwin" { 0 } else { 2 };
    let skipped_perm = if perm { 0 } else { 2 };
    assert_eq!(ran, 11 - skipped_os - skipped_perm, "groups run");
    assert!(tally.requests >= 200, "{} requests", tally.requests);
    println!("{} recorded requests replayed", tally.requests);
}
