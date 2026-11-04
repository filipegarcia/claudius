//! `GET /api/workspaces/:id/roots`, `POST …/reveal` and `POST …/shell`
//! (D02) against the real binary, replaying the `steps` of
//! `claudius-core/tests/fixtures/workspace_roots_golden.json` (recorded by
//! `rust/scripts/workspace-roots-golden.mjs` from the real route handlers
//! inside Next's `AppRouteRouteModule`).
//!
//! The server runs in the recorder's layout (`$ROOT/project` is its cwd,
//! `$ROOT/home` its home and state home) with `PATH` at `$ROOT/bin` alone,
//! which holds the recorded fake `open`, `osascript` and `xdg-open`: they
//! write one record per call to `$FAKE_LAUNCH_DIR` and open nothing. No
//! real launcher is on `PATH`, so neither Finder nor a terminal can open,
//! even in the steps that remove the fake. Each step seeds the files, puts
//! `open` in the recorded state (the fake, missing, 0644, a directory, a
//! missing interpreter, no shebang) or sends a request, which must get the
//! same status, content type and body bytes (the 16 Mi-unit outputs by
//! sha256), with the same launches (name, argv, cwd, what fds 0-2 are,
//! whether it leads its group, the inherited env) and the same uncaught
//! spawn errors in the log. A reveal that reached the launcher (`os`) is
//! macOS-only: the command is `open` there. A step with `as` is a listed
//! difference, answered as TS answers its `as` variant.
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use claudius_core::js_string;
use claudius_core::reminders::sha256_hex;
use common::{Server, World};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/workspace_roots_golden.json");
    // `js_string`: the `exec` half holds lone surrogates.
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

struct Got {
    status: u16,
    content_type: Option<String>,
    body: Vec<u8>,
}

fn request(port: u16, method: &str, path: &str, body: Option<&[u8]>) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(120))).unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(b) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        ));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).unwrap();
    if let Some(b) = body {
        s.write_all(b).unwrap();
    }
    let mut out = vec![];
    s.read_to_end(&mut out).unwrap();
    let at = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&out[..at]).into_owned();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let mut content_type = None;
    for line in head.split("\r\n").skip(1) {
        let (k, v) = line.split_once(':').unwrap();
        assert!(
            !k.eq_ignore_ascii_case("transfer-encoding"),
            "chunked body: {head}"
        );
        if k.eq_ignore_ascii_case("content-type") {
            content_type = Some(v.trim().to_owned());
        }
    }
    Got {
        status,
        content_type,
        body: out[at + 4..].to_vec(),
    }
}

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect()
}

/// The records the fake wrote (parsed like the recorder, paths as
/// `$ROOT`), removed.
fn take_records(launch: &Path, root: &str) -> Vec<Value> {
    let mut recs = vec![];
    for e in std::fs::read_dir(launch).unwrap() {
        let e = e.unwrap();
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with("rec.") {
            continue;
        }
        let buf = std::fs::read(e.path()).unwrap();
        std::fs::remove_file(e.path()).unwrap();
        let at = buf.windows(6).position(|w| w == b"argv:\n").unwrap();
        let fake = |s: &str| s.replace(root, "$ROOT");
        let mut rec = Map::new();
        for line in String::from_utf8_lossy(&buf[..at]).split('\n') {
            if let Some((k, v)) = line.split_once('=') {
                rec.insert(k.to_owned(), json!(fake(v)));
            }
        }
        let mut args: Vec<Value> = buf[at + 6..]
            .split(|b| *b == 0)
            .map(|a| json!(fake(&String::from_utf8_lossy(a))))
            .collect();
        args.pop();
        rec.insert("args".into(), Value::Array(args));
        recs.push(Value::Object(rec));
    }
    sorted(recs)
}

fn sorted(mut v: Vec<Value>) -> Vec<Value> {
    v.sort_by_key(|r| r.to_string());
    v
}

struct Rig {
    // Keeps the temp dirs alive.
    _world: World,
    root: String,
    bin: PathBuf,
    launch: PathBuf,
}

impl Rig {
    fn new() -> Rig {
        let world = World::new();
        let root = world
            .project
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let bin = PathBuf::from(format!("{root}/bin"));
        let launch = PathBuf::from(format!("{root}/launch"));
        for d in [&bin, &launch] {
            std::fs::create_dir_all(d).unwrap();
        }
        Rig {
            _world: world,
            root,
            bin,
            launch,
        }
    }

    fn real(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    /// `<root>/bin/<name>` as the recorder made it.
    fn install(&self, name: &str, kind: &str, fx: &Value) {
        let p = self.bin.join(name);
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() => std::fs::remove_dir(&p).unwrap(),
            Ok(_) => std::fs::remove_file(&p).unwrap(),
            Err(_) => {}
        }
        let (text, mode) = match kind {
            "missing" => return,
            "dir" => return std::fs::create_dir(&p).unwrap(),
            "fake" => (&fx["fake"], 0o755),
            "noexec" => (&fx["fake"], 0o644),
            "badinterp" | "noshebang" => (&fx["bins"][kind], 0o755),
            other => panic!("bin {other}"),
        };
        std::fs::write(&p, text.as_str().unwrap()).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn fs(&self, s: &Value) {
        let p = PathBuf::from(self.real(s["path"].as_str().unwrap()));
        match s["act"].as_str().unwrap() {
            "write" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let bytes = match s.get("hex") {
                    Some(h) => unhex(h.as_str().unwrap()),
                    None => self.real(s["text"].as_str().unwrap()).into_bytes(),
                };
                std::fs::write(&p, bytes).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(&p).unwrap(),
            "rm" => match std::fs::symlink_metadata(&p) {
                Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p).unwrap(),
                Ok(_) => std::fs::remove_file(&p).unwrap(),
                Err(_) => {}
            },
            "symlink" => {
                std::os::unix::fs::symlink(self.real(s["target"].as_str().unwrap()), &p).unwrap()
            }
            "chmod" => {
                let mode = s["mode"].as_u64().unwrap() as u32;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            }
            other => panic!("fs {other}"),
        }
    }

    fn spawn(&self, fx: &Value) -> Server {
        let env = [
            ("PATH", self.bin.display().to_string()),
            ("HOME", format!("{}/home", self.root)),
            ("CLAUDIUS_STATE_HOME", format!("{}/home", self.root)),
            ("FAKE_LAUNCH_DIR", self.launch.display().to_string()),
            ("WSR_MARK", fx["mark"].as_str().unwrap().to_owned()),
            ("TZ", "UTC".to_owned()),
        ];
        let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
        Server::spawn(&self._world, &env)
    }
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let rig = Rig::new();
    for name in fx["launchers"].as_array().unwrap() {
        rig.install(name.as_str().unwrap(), "fake", &fx);
    }
    let steps = fx["steps"].as_array().unwrap();
    let macos = cfg!(target_os = "macos") && fx["platform"] == "darwin";

    // The world first, then a server that is surely this rig's: `free_port`
    // can hand two servers starting at once the same port, and then the one
    // that lost the bind exits while its health check passes on the other.
    let world_len = steps
        .iter()
        .position(|s| s["op"] != "fs")
        .expect("requests");
    for s in &steps[..world_len] {
        rig.fs(s);
    }
    let probe = format!(
        "/api/workspaces/{}/roots",
        steps[world_len]["path"]
            .as_str()
            .unwrap()
            .split('/')
            .nth(3)
            .unwrap()
    );
    let mut server = rig.spawn(&fx);
    for attempt in 0.. {
        let got = request(server.port, "GET", &probe, None);
        if String::from_utf8_lossy(&got.body).contains(&rig.root) {
            break;
        }
        assert!(attempt < 5, "no server of this rig's own answered");
        server = rig.spawn(&fx);
    }

    let mut failures: Vec<String> = vec![];
    let mut uncaught: BTreeMap<String, usize> = BTreeMap::new();
    let (mut requests, mut matched, mut skipped, mut differences) = (0, 0, 0, 0);
    for (i, s) in steps.iter().enumerate().skip(world_len) {
        match s["op"].as_str().unwrap() {
            "fs" => {
                rig.fs(s);
                continue;
            }
            "bin" => {
                rig.install("open", s["kind"].as_str().unwrap(), &fx);
                continue;
            }
            "req" => {}
            other => panic!("op {other}"),
        }
        requests += 1;
        if s["os"] == true && !macos {
            skipped += 1;
            continue;
        }
        let (want, want_launched, want_uncaught) = if s.get("as").is_some() {
            differences += 1;
            (&s["gotAs"], &s["launchedAs"], s.get("uncaughtAs"))
        } else {
            (&s["got"], &s["launched"], s.get("uncaught"))
        };
        let body: Option<Vec<u8>> = match (s.get("body"), s.get("bodyHex")) {
            (Some(b), _) => Some(rig.real(b.as_str().unwrap()).into_bytes()),
            (None, Some(h)) => Some(unhex(h.as_str().unwrap())),
            _ => None,
        };
        let path = s["path"].as_str().unwrap();
        let got = request(
            server.port,
            s["method"].as_str().unwrap(),
            path,
            body.as_deref(),
        );
        let mut problems = vec![];
        if want.get("threw").is_some() {
            if (got.status, got.content_type.as_deref(), got.body.len()) != (500, None, 0) {
                problems.push(format!(
                    "want the empty 500 ({}), got {} {:?} {}",
                    want["threw"],
                    got.status,
                    got.content_type,
                    String::from_utf8_lossy(&got.body)
                ));
            }
        } else {
            if u64::from(got.status) != want["status"].as_u64().unwrap() {
                problems.push(format!("status {} want {}", got.status, want["status"]));
            }
            if got.content_type.as_deref() != want["type"].as_str() {
                problems.push(format!("type {:?} want {}", got.content_type, want["type"]));
            }
            let (got_body, want_body) = match want.get("sha256") {
                Some(h) => (
                    format!("{}:{}", sha256_hex(&got.body), got.body.len()),
                    h.as_str().unwrap().to_owned(),
                ),
                None => (
                    String::from_utf8_lossy(&got.body).into_owned(),
                    rig.real(want["body"].as_str().unwrap()),
                ),
            };
            if got_body != want_body {
                problems.push(format!(
                    "body\n    got  {}\n    want {}",
                    got_body.chars().take(600).collect::<String>(),
                    want_body.chars().take(600).collect::<String>()
                ));
            }
        }
        // A reveal returns before its launcher runs: wait for the records.
        let want_launched = sorted(want_launched.as_array().unwrap().clone());
        let t0 = Instant::now();
        let mut launched = take_records(&rig.launch, &rig.root);
        while launched.len() < want_launched.len() && t0.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(10));
            launched.extend(take_records(&rig.launch, &rig.root));
        }
        let launched = sorted(launched);
        if launched != want_launched {
            problems.push(format!(
                "launched\n    got  {}\n    want {}",
                json!(launched),
                json!(want_launched)
            ));
        }
        for m in want_uncaught
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            *uncaught.entry(m.as_str().unwrap().to_owned()).or_default() += 1;
        }
        if problems.is_empty() {
            matched += 1;
        } else {
            failures.push(format!(
                "step {i}: {} {path} {}\n  {}",
                s["method"].as_str().unwrap(),
                s.get("body").map_or(String::new(), |b| b.to_string()),
                problems.join("\n  ")
            ));
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    let stray = take_records(&rig.launch, &rig.root);
    assert!(stray.is_empty(), "launches nobody asked for: {stray:?}");

    // The spawn `error` events TS has no listener for: logged, survived.
    let (_, log, _) = server.stop(Duration::from_secs(10));
    for (m, n) in &uncaught {
        let seen = log
            .matches(&format!("uncaughtException: Error: {m}\n"))
            .count();
        if seen != *n {
            failures.push(format!("uncaught {m:?}: logged {seen} times, want {n}"));
        }
    }
    eprintln!(
        "{requests} requests: {matched} match ({differences} listed differences), {skipped} skipped off macOS"
    );
    assert!(
        failures.is_empty(),
        "{} steps differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(matched + skipped, requests);
}
