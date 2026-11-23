//! The account switcher's routes (G02c) against the TS recording in
//! `fixtures/accounts_routes_golden.json` (`rust/scripts/accounts-routes-golden.mjs`:
//! the real `app/api/accounts`, `app/api/accounts/profile` and
//! `app/api/account` handlers over the real accounts store, profile cache
//! and session manager):
//! - `cases`: `GET`/`POST`/`PATCH`/`DELETE /api/accounts` and
//!   `GET /api/accounts/profile` on the real binary, one world and one server
//!   (fresh caches) per case. The server's HTTPS client is pointed at a local
//!   fake of Anthropic's profile endpoint (`CLAUDIUS_DEV_FETCH_BASE`) that
//!   answers with the recorded raw responses. Per request it checks the
//!   status, content type and body byte for byte (an empty 500 for a throw),
//!   every request that reached the fake (headers as in
//!   `accounts_oauth.rs`), and the world tree afterwards. The recorder pinned
//!   `randomBytes` and the clock; a new profile's id and `createdAt` are
//!   checked (shape, the request's time window) and from then on stand for
//!   the recorded ones. No secret reaches the server's log.
//! - `account`: `GET /api/account` on the binary, one session per group on
//!   the fake CLI as the group scripts it (or without a CLI, or exited after
//!   `initialize`).
//! - `drift`: what `PATCH` does to live sessions (`notifyActiveAccountChanged`)
//!   runs in process. No route pins a session to an account before S30
//!   (`resolveAccountProfile` at start), so the scenarios pin real sessions
//!   in a `SessionManager` and run `accounts::patch_accounts` and
//!   `notify_active_account_changed`, comparing each session's
//!   `account_changed` events, its pin afterwards and the store.
//!
//! All tokens are fake; nothing reaches the network.
#![cfg(unix)]

mod common;
#[path = "../../claudius-core/tests/common_oauth/mod.rs"]
mod common_oauth;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::account_drift::{AccountPin, AccountRef};
use claudius_core::account_oauth::RouteAnswer;
use claudius_core::account_profile::{FetchResponse, ProfileFetch, ProfileInfoResolver};
use claudius_core::accounts::AccountsStore;
use claudius_core::claude_global_config::ClaudeGlobalConfig;
use claudius_core::fetch::FetchError;
use claudius_core::now_ms;
use claudius_core::paths;
use claudius_core::session::{RuntimeOptions, SessionOptions, Subscription};
use claudius_core::session_manager::SessionManager;
use claudius_server::accounts;
use common::{Server, World, fake_bin, free_port, read_until, request};
use common_oauth::{build, fill, hex, recorded_tree, sub, tree, unlock};
use futures::future::BoxFuture;
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/accounts_routes_golden.json")).unwrap()
    })
}

// ---- the fake profile endpoint ----------------------------------------------------

#[derive(Default)]
struct Fake {
    queue: VecDeque<Value>,
    log: Vec<Value>,
}

/// A raw HTTP/1.1 listener: logs each request as the recorder's server did
/// and answers it with the next scripted response, byte for byte.
fn fake_profile_server() -> (u16, Arc<Mutex<Fake>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Mutex::new(Fake::default()));
    let st = state.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            let st = st.clone();
            std::thread::spawn(move || serve(conn, &st));
        }
    });
    (port, state)
}

fn serve(mut conn: TcpStream, st: &Mutex<Fake>) {
    conn.set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let (head_end, len) = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..at]).into_owned();
            let len = head
                .split("\r\n")
                .skip(1)
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if buf.len() >= at + 4 + len {
                break (at, len);
            }
        }
        match conn.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap().split(' ');
    let (method, path) = (first.next().unwrap(), first.next().unwrap());
    let headers: Vec<Value> = lines
        .map(|l| {
            let (k, v) = l.split_once(':').unwrap();
            json!([k, v.trim()])
        })
        .collect();
    let body = String::from_utf8_lossy(&buf[head_end + 4..head_end + 4 + len]).into_owned();
    let entry = json!({"method": method, "path": path, "headers": headers, "body": body});
    let next = {
        let mut st = st.lock().unwrap();
        st.log.push(entry);
        st.queue.pop_front()
    };
    let Some(next) = next else {
        return; // unscripted: hang up (the replay then sees one request too many)
    };
    if next["close"] == true {
        let _ = conn.shutdown(Shutdown::Both);
        return;
    }
    let bytes = match next["wireHex"].as_str() {
        Some(h) => hex(h),
        None => next["wire"].as_str().unwrap().as_bytes().to_vec(),
    };
    let _ = conn.write_all(&bytes);
    let _ = conn.flush();
    let _ = conn.shutdown(Shutdown::Write);
    let _ = conn.read_to_end(&mut Vec::new());
}

/// Header lines as compared: in order, names lowercased, without the ones
/// undici and the Rust client send differently by design (the fake's port
/// in `host`, undici's `connection: keep-alive`, and `accept-encoding`,
/// see `accounts_oauth.rs`), and without `content-length`.
fn headers(v: &Value) -> Vec<(String, String)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|h| {
            (
                h[0].as_str().unwrap().to_ascii_lowercase(),
                h[1].as_str().unwrap().to_owned(),
            )
        })
        .filter(|(k, _)| {
            !matches!(
                k.as_str(),
                "host" | "connection" | "accept-encoding" | "content-length"
            )
        })
        .collect()
}

// ---- the server ------------------------------------------------------------------

/// The binary with dev routes on, outbound requests sent to `base`, the
/// store's env exactly `env`, and everything it prints in `log`.
fn spawn(world: &World, base: &str, env: &Value, log: &Path) -> Server {
    let port = free_port();
    let out = std::fs::File::create(log).unwrap();
    let mut cmd = Command::new(common::server_bin());
    cmd.args(["--port", &port.to_string(), "--no-next"])
        .current_dir(&world.project)
        .env("RUST_LOG", "debug")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_SCHEDULER")
        .env_remove("CLAUDIUS_ACCOUNTS_DIR")
        .env_remove("CLAUDIUS_CLAUDE_CONFIG_PATH")
        .env_remove("NODE_USE_ENV_PROXY")
        .env("CLAUDIUS_DEV", "1")
        .env("CLAUDIUS_DEV_FETCH_BASE", base)
        .env("CLAUDIUS_STATE_HOME", &world.home)
        .env("CLAUDE_CONFIG_DIR", &world.config)
        .stdout(out.try_clone().unwrap())
        .stderr(out);
    for (k, v) in env.as_object().unwrap() {
        cmd.env(k, v.as_str().unwrap());
    }
    let mut child = cmd.spawn().unwrap();
    common::wait_healthy(&mut child, port, Duration::from_secs(20));
    Server { child, port }
}

/// The fake CLI, built once.
fn fake() -> &'static Path {
    static F: OnceLock<std::path::PathBuf> = OnceLock::new();
    F.get_or_init(fake_bin)
}

/// The binary running sessions on `claude_bin` (the fake CLI, with
/// `FAKE_CLAUDE_SCRIPT` = `script`; or a path that doesn't exist, so
/// sessions get no CLI).
fn spawn_cli(world: &World, claude_bin: &Path, script: Option<&str>) -> Server {
    let port = free_port();
    let mut cmd = Command::new(common::server_bin());
    cmd.args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(claude_bin)
        .current_dir(&world.project)
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_DEV")
        .env_remove("CLAUDIUS_SCHEDULER")
        .env_remove("FAKE_CLAUDE_SCRIPT")
        .env("CLAUDIUS_STATE_HOME", &world.home)
        .env("CLAUDE_CONFIG_DIR", &world.config)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(s) = script {
        cmd.env("FAKE_CLAUDE_SCRIPT", s);
    }
    let mut child = cmd.spawn().unwrap();
    common::wait_healthy(&mut child, port, Duration::from_secs(20));
    Server { child, port }
}

/// A step's request body: `bodyHex`, `body`, or none.
fn step_body(step: &Value) -> Option<Vec<u8>> {
    match (step["bodyHex"].as_str(), step["body"].as_str()) {
        (Some(h), _) => Some(hex(h)),
        (None, Some(b)) => Some(b.as_bytes().to_vec()),
        (None, None) => None,
    }
}

/// The recorded answer as compared: `{status, type, body}`, or `{threw}`
/// (Next's empty 500, whose message only TS shows).
fn answer(status: u16, ctype: Option<String>, body: &str, want: &Value, at: &str) -> Value {
    if status == 500 && ctype.is_none() && body.is_empty() {
        assert!(want.get("threw").is_some(), "{at}: an empty 500");
        return want.clone();
    }
    json!({"status": status, "type": ctype, "body": body})
}

// ---- standing in for the recorded random values ---------------------------------

fn is_hex_id(s: &str) -> bool {
    s.strip_prefix("acc_")
        .is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

struct Subs(Vec<(String, String)>);

impl Subs {
    fn add(&mut self, actual: &str, recorded: &str) {
        if actual != recorded && !self.0.iter().any(|(a, _)| a == actual) {
            self.0.push((actual.to_owned(), recorded.to_owned()));
        }
    }

    fn apply(&self, s: &str) -> String {
        let mut out = s.to_owned();
        for (a, r) in &self.0 {
            out = out.replace(a.as_str(), r);
        }
        out
    }
}

/// The temp-file names in a write error: `accounts.json.<pid>.<12 hex>.tmp`
/// with the pid and the random hex masked.
fn mask_tmp(s: &str) -> String {
    const AT: &str = "accounts.json.";
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(AT) {
        out.push_str(&rest[..i + AT.len()]);
        rest = &rest[i + AT.len()..];
        let pid = rest
            .strip_prefix("$PID")
            .or_else(|| Some(rest.trim_start_matches(|c: char| c.is_ascii_digit())))
            .filter(|r| r.len() < rest.len());
        let masked = pid.and_then(|r| r.strip_prefix('.')).and_then(|r| {
            let (h, tail) = r.split_at_checked(12)?;
            (h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) && tail.starts_with(".tmp"))
                .then_some(&tail[4..])
        });
        if let Some(tail) = masked {
            out.push_str("$PID.$HEX.tmp");
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

/// What was stored for each profile this server added (a random id, the
/// real clock) stands for what the recorder stored at the same position.
fn learn_store(subs: &mut Subs, actual: &str, recorded: &str, window: (i64, i64), at: &str) {
    let (Ok(a), Ok(r)) = (
        serde_json::from_str::<Value>(actual),
        serde_json::from_str::<Value>(recorded),
    ) else {
        return;
    };
    let (Some(ap), Some(rp)) = (a["profiles"].as_array(), r["profiles"].as_array()) else {
        return;
    };
    assert_eq!(ap.len(), rp.len(), "{at}: profiles stored");
    for (a, r) in ap.iter().zip(rp) {
        let (Some(aid), Some(rid)) = (a["id"].as_str(), r["id"].as_str()) else {
            continue;
        };
        if aid == rid || subs.0.iter().any(|(a, _)| a == aid) {
            continue; // the world's own, or learned at an earlier step
        }
        assert!(is_hex_id(aid) && is_hex_id(rid), "{at}: {aid} / {rid}");
        subs.add(aid, rid);
        let (Some(ac), Some(rc)) = (a["createdAt"].as_str(), r["createdAt"].as_str()) else {
            panic!("{at}: no createdAt");
        };
        let ms = chrono::DateTime::parse_from_rfc3339(ac)
            .unwrap()
            .timestamp_millis();
        assert!(window.0 <= ms && ms <= window.1, "{at}: createdAt {ac}");
        for (a, r) in [
            (
                format!("\"createdAt\": \"{ac}\""),
                format!("\"createdAt\": \"{rc}\""),
            ),
            (
                format!("\"createdAt\":\"{ac}\""),
                format!("\"createdAt\":\"{rc}\""),
            ),
        ] {
            subs.add(&a, &r);
        }
    }
}

// ---- cases: the store and profile routes on the binary ---------------------------

/// The world tree as the recorder saw it: without the top-level `home` dir
/// itself (each side made its own), `config` and `project`.
fn world_tree(w: &str, subs: &Subs) -> BTreeMap<String, Value> {
    let mut t = tree(w, &["config", "project"]);
    t.remove("home");
    for v in t.values_mut() {
        if let Some(x) = v["x"].as_str() {
            v["x"] = json!(mask_tmp(&subs.apply(x)));
        }
    }
    t
}

fn want_tree(v: &Value) -> BTreeMap<String, Value> {
    let mut t = recorded_tree(v);
    t.remove("home");
    for v in t.values_mut() {
        if let Some(x) = v["x"].as_str() {
            v["x"] = json!(mask_tmp(x));
        }
    }
    t
}

/// Every secret the fixture's worlds and bodies hold contains `FAKE`.
const SECRET_MARK: &str = "FAKE";

/// One recorded case on a fresh world and server; returns the requests made.
fn replay_case(case: &Value, fake_port: u16, fake: &Mutex<Fake>) -> usize {
    let name = case["name"].as_str().unwrap();
    let world = World::new();
    let w = world.root.path().display().to_string();
    let logs = tempfile::tempdir().unwrap();
    let log = logs.path().join("server.log");
    build(&w, &case["files"]);
    let server = spawn(
        &world,
        &format!("http://127.0.0.1:{fake_port}"),
        &fill(&w, &case["env"]),
        &log,
    );
    let mut subs = Subs(Vec::new());
    let mut want = want_tree(&case["start"]);
    assert_eq!(world_tree(&w, &subs), want, "{name}: the world");
    let mut requests = 0;
    for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
        let at = format!("{name} / step {i}");
        if step["op"] == "files" {
            build(&w, &step["files"]);
        } else {
            assert_eq!(step["op"], "req", "{at}");
            requests += 1;
            replay_request(&server, &w, step, fake, &mut subs, &at);
        }
        if let Some(t) = step.get("tree") {
            want = want_tree(t);
        }
        assert_eq!(world_tree(&w, &subs), want, "{at}: the world tree");
    }
    drop(server);
    let printed = std::fs::read_to_string(&log).unwrap();
    assert!(
        !printed.contains(SECRET_MARK),
        "{name}: a secret in the log:\n{printed}"
    );
    // Each throw is logged under its route's tag (so the log is read).
    for step in case["steps"].as_array().unwrap() {
        if let Some(e) = step["got"]["threw"].as_str() {
            let route = step["path"].as_str().unwrap().split('?').next().unwrap();
            let line = format!("[{}] {}", &route[1..], e.replace("$W", &w));
            assert!(
                mask_tmp(&printed).contains(&mask_tmp(&line)),
                "{name}: {line:?} not logged:\n{printed}"
            );
        }
    }
    unlock(world.root.path());
    requests
}

fn replay_request(
    server: &Server,
    w: &str,
    step: &Value,
    fake: &Mutex<Fake>,
    subs: &mut Subs,
    at: &str,
) {
    {
        let mut fake = fake.lock().unwrap();
        fake.log.clear();
        fake.queue = step["responses"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into();
    }
    let before = now_ms();
    let (status, ctype, body) = request(
        server.port,
        step["method"].as_str().unwrap(),
        step["path"].as_str().unwrap(),
        step_body(step).as_deref(),
    );
    let after = now_ms();

    // What reached the profile endpoint.
    let (log, unused) = {
        let mut fake = fake.lock().unwrap();
        (std::mem::take(&mut fake.log), fake.queue.len())
    };
    assert_eq!(unused, 0, "{at}: scripted responses left");
    let recorded = step["wire"].as_array().cloned().unwrap_or_default();
    assert_eq!(log.len(), recorded.len(), "{at}: profile requests");
    for (a, r) in log.iter().zip(&recorded) {
        assert_eq!(
            (&a["method"], &a["path"], &a["body"]),
            (&r["method"], &r["path"], &r["body"]),
            "{at}: request"
        );
        assert_eq!(
            headers(&a["headers"]),
            headers(&r["headers"]),
            "{at}: headers"
        );
        assert!(
            a["headers"].as_array().unwrap().iter().any(|h| h[0]
                .as_str()
                .unwrap()
                .eq_ignore_ascii_case("accept-encoding")
                && h[1] == "identity"),
            "{at}: accept-encoding"
        );
    }

    // New profiles: their ids and createdAt stand for the recorded ones.
    if let Some(t) = step.get("tree") {
        let t = recorded_tree(t);
        for key in ["acc/accounts.json", "home/.claude/.claudius/accounts.json"] {
            if let (Ok(actual), Some(rec)) = (
                std::fs::read_to_string(format!("{w}/{key}")),
                t.get(key).and_then(|v| v["x"].as_str()),
            ) {
                learn_store(subs, &actual, rec, (before, after), at);
            }
        }
    }

    let want = &step["got"];
    let body = mask_tmp(&subs.apply(&sub(w, &body)));
    let got = answer(status, ctype, &body, want, at);
    let mut want = want.clone();
    if let Some(b) = want["body"].as_str() {
        want["body"] = json!(mask_tmp(b));
    }
    assert_eq!(got, want, "{at}");
}

#[test]
fn the_store_and_profile_routes_replay_the_ts_handlers() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    assert!(cases.len() >= 30, "{} cases", cases.len());
    let (fake_port, fake) = fake_profile_server();
    let mut requests = 0;
    let mut fetches = 0;
    for case in cases {
        requests += replay_case(case, fake_port, &fake);
        fetches += case["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["wire"].as_array().map_or(0, Vec::len))
            .sum::<usize>();
    }
    assert!(requests >= 290, "{requests} requests");
    assert!(fetches >= 25, "{fetches} profile fetches");
}

// ---- account: GET /api/account on the binary --------------------------------------

/// One recorded group on its own server and session; returns the requests.
fn replay_account_group(group: &Value) -> usize {
    let name = group["name"].as_str().unwrap();
    let world = World::new();
    let query = group["query"].as_str().unwrap();
    let script = match &group["script"] {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        v => Some(v.to_string()),
    };
    let server = match query {
        "none" => spawn_cli(&world, &world.root.path().join("no-such-claude"), None),
        _ => spawn_cli(&world, fake(), script.as_deref()),
    };
    let id = server.create_session(&world);
    // `create` returns once the session started its CLI (or failed to);
    // an exit is reported once the SDK host's cleanup has run.
    let _sse = (query == "exited").then(|| {
        let mut sse = server.open_stream(&id);
        read_until(&mut sse, "exited with code 3", Duration::from_secs(10));
        sse
    });
    let cases = group["cases"].as_array().unwrap();
    for (i, case) in cases.iter().enumerate() {
        let at = format!("{name} / case {i}");
        let path = case["path"].as_str().unwrap().replace("$ID", &id);
        let (status, ctype, body) = request(server.port, "GET", &path, None);
        let want = &case["got"];
        let got = answer(status, ctype, &body.replace(&id, "$ID"), want, &at);
        assert_eq!(&got, want, "{at}: {path}");
    }
    unlock(world.root.path());
    cases.len()
}

#[test]
fn the_account_route_replays_the_ts_handler() {
    let groups = fixture()["account"].as_array().unwrap();
    assert!(groups.len() >= 12, "{} groups", groups.len());
    let requests: usize = groups.iter().map(replay_account_group).sum();
    assert!(requests >= 22, "{requests} requests");
}

// ---- drift: PATCH and the live sessions, in process -------------------------------

/// An isolated `$HOME` and config dir for the sessions this process starts.
fn isolated_home() -> &'static tempfile::TempDir {
    static H: OnceLock<tempfile::TempDir> = OnceLock::new();
    H.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let (home, config) = (root.path().join("home"), root.path().join("config"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(config));
        root
    })
}

fn recorded_pin(v: &Value) -> AccountPin {
    AccountPin {
        id: v["id"].as_str().map(str::to_owned),
        label: v["label"].as_str().map(str::to_owned),
        drift_from_active: v["drift"].as_object().map(|d| AccountRef {
            id: d["id"].as_str().unwrap().to_owned(),
            label: d["label"].as_str().unwrap().to_owned(),
        }),
    }
}

fn pin_json(p: &AccountPin) -> Value {
    json!({"id": p.id, "label": p.label, "drift": p.drift_from_active.as_ref().map(AccountRef::to_json)})
}

fn route_answer(a: RouteAnswer) -> Value {
    match a {
        RouteAnswer::Json(status, v) => {
            json!({"status": status, "type": "application/json", "body": js::stringify(&v)})
        }
        RouteAnswer::Thrown(e) => json!({"threw": e}),
    }
}

/// The `account_changed` events delivered since the last call.
fn account_events(sub: &mut Subscription) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(ev) = sub.rx.try_recv() {
        if ev["type"] == "account_changed" {
            out.push(js::stringify(&ev));
        }
    }
    out
}

async fn replay_drift(sc: &Value) {
    let name = sc["name"].as_str().unwrap();
    let root = tempfile::tempdir().unwrap();
    let w = root.path().display().to_string();
    let project = root.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(root.path().join("home")).unwrap();
    build(&w, &sc["files"]);
    let store = AccountsStore::new(format!("{w}/acc"), format!("{w}/home"));
    let mgr = Arc::new(SessionManager::default());
    let opts = SessionOptions {
        cwd: Some(project.canonicalize().unwrap().display().to_string()),
        runtime: RuntimeOptions {
            claude_bin: Some(root.path().join("no-such-claude")),
            env_override: Some(HashMap::new()),
        },
        ..Default::default()
    };
    let mut live = Vec::new();
    for p in sc["sessions"].as_array().unwrap() {
        let s = mgr.create(opts.clone()).await.expect("create");
        s.set_account_pin(recorded_pin(p));
        let mut sub = s.subscribe(None, None);
        account_events(&mut sub);
        live.push((s, sub));
    }
    for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
        let at = format!("{name} / step {i}");
        match step["op"].as_str().unwrap() {
            "req" => {
                assert_eq!(
                    (&step["method"], &step["path"]),
                    (&json!("PATCH"), &json!("/api/accounts")),
                    "{at}"
                );
                let body = step_body(step).unwrap_or_default();
                let got = route_answer(accounts::patch_accounts(&store, &mgr, &body));
                assert_eq!(got, step["got"], "{at}");
            }
            "notify" => {
                let count = mgr.notify_active_account_changed(&store);
                assert_eq!(json!(count), step["count"], "{at}: sessions asked");
            }
            "files" => build(&w, &step["files"]),
            op => panic!("{at}: {op}"),
        }
        for (j, (s, sub)) in live.iter_mut().enumerate() {
            let want: Vec<String> = step["events"][j]
                .as_array()
                .unwrap()
                .iter()
                .map(js::stringify)
                .collect();
            assert_eq!(account_events(sub), want, "{at}: session {j}'s events");
            assert_eq!(
                js::stringify(&pin_json(&s.account_pin())),
                js::stringify(&step["pins"][j]),
                "{at}: session {j}'s pin"
            );
        }
        let stored = tree(&w, &[]).remove("acc/accounts.json");
        assert_eq!(
            stored.unwrap_or(Value::Null),
            step["store"],
            "{at}: the store"
        );
    }
    for (s, _) in &live {
        mgr.remove(&s.id).await;
    }
    unlock(root.path());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_switch_moves_every_pinned_session_s_drift() {
    isolated_home();
    let scenarios = fixture()["drift"].as_array().unwrap();
    assert!(scenarios.len() >= 3, "{} scenarios", scenarios.len());
    for sc in scenarios {
        replay_drift(sc).await;
    }
}

// ---- the profile cache: a new profile's id is never served stale ------------------

/// A profile endpoint that answers every call with a new email and keeps
/// the bearer each call carried.
#[derive(Default)]
struct Scripted {
    bearers: Mutex<Vec<String>>,
}

impl ProfileFetch for Scripted {
    fn get<'a>(
        &'a self,
        _url: &'a str,
        headers: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<FetchResponse, FetchError>> {
        let bearer = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        let n = {
            let mut b = self.bearers.lock().unwrap();
            b.push(bearer);
            b.len()
        };
        let body = format!(r#"{{"account":{{"email":"call{n}@example.com"}}}}"#).into_bytes();
        Box::pin(async move { Ok(FetchResponse { status: 200, body }) })
    }
}

/// `POST /api/accounts` drops its new id from the profile cache
/// (`invalidateProfileCache(profile.id)`): with the store's randomness
/// pinned, the id it adds is one a lookup cached for an earlier profile,
/// and the next lookup asks again with the new token. (With real
/// randomness a new id is never cached, so the binary can't show this.)
#[tokio::test]
async fn a_post_drops_the_new_id_from_the_profile_cache() {
    let root = tempfile::tempdir().unwrap();
    let w = root.path().display().to_string();
    let store = AccountsStore::new(format!("{w}/acc"), format!("{w}/home"))
        .with_random(Arc::new(|b: &mut [u8]| b.fill(0xab)));
    let id = "acc_abababababababab";
    std::fs::create_dir_all(format!("{w}/acc")).unwrap();
    let old = json!({"profiles": [{"id": id, "label": "Old", "kind": "oauth-token", "secret": "sk-ant-oat01-FAKE-old", "createdAt": "2026-01-02T03:04:05.006Z"}], "activeProfileId": id, "autoRotateOnRateLimit": false});
    std::fs::write(store.accounts_path(), old.to_string()).unwrap();
    let fetch = Arc::new(Scripted::default());
    let global = Arc::new(ClaudeGlobalConfig::new(format!("{w}/home/.claude.json")));
    let resolver = ProfileInfoResolver::new(store.clone(), global, fetch.clone());
    let email = |v: Option<Value>| v.unwrap()["email"].as_str().unwrap().to_owned();

    let first = resolver.get_profile_info_for_account(id, false).await;
    assert_eq!(email(first.unwrap()), "call1@example.com");
    let cached = resolver.get_profile_info_for_account(id, false).await;
    assert_eq!(email(cached.unwrap()), "call1@example.com");

    std::fs::write(
        store.accounts_path(),
        r#"{"profiles":[],"activeProfileId":null}"#,
    )
    .unwrap();
    let added = accounts::post_accounts(
        &store,
        &resolver,
        br#"{"label":"New","kind":"oauth-token","secret":"sk-ant-oat01-FAKE-new"}"#,
    );
    let RouteAnswer::Json(200, body) = added else {
        panic!("{:?}", route_answer(added));
    };
    assert_eq!(body["profileId"], id);
    let fresh = resolver.get_profile_info_for_account(id, false).await;
    assert_eq!(email(fresh.unwrap()), "call2@example.com");
    assert_eq!(
        *fetch.bearers.lock().unwrap(),
        [
            "Bearer sk-ant-oat01-FAKE-old",
            "Bearer sk-ant-oat01-FAKE-new"
        ]
    );
}
