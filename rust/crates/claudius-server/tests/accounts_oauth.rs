//! `POST /api/accounts/oauth` against the real binary, replaying the cases
//! of `claudius-core/tests/fixtures/account_oauth_golden.json` (recorded by
//! `rust/scripts/account-oauth-golden.mjs` from the real TS route over
//! node's real fetch) that only post requests: the same worlds, bodies and
//! byte-for-byte token-endpoint responses, served by a local fake that the
//! server's HTTPS client is pointed at (`CLAUDIUS_DEV_FETCH_BASE`, honoured
//! only with the dev routes on). So reqwest gets the very responses undici
//! got (reason phrases, BOMs, cut and chunked bodies, redirects, hang-ups,
//! a refused connection) and every answer has to come out the same.
//!
//! Per request it checks the status, content type and body text (an empty
//! 500 for a throw), every request that reached the fake (method, path,
//! body; headers as undici sent them, minus the listed differences), and the
//! world tree afterwards. The recorder pinned `randomBytes` and the clock;
//! this server runs on the OS CSPRNG and the real clock, so each random value
//! is first checked (its shape; the PKCE S256 pairing of the verifier sent
//! with the challenge answered; ids, `createdAt` and `expiresAt` within the
//! request's time window) and from then on stands for the recorded one.
//! All tokens and codes are fake; nothing reaches the network.
#![cfg(unix)]

mod common;
#[path = "../../claudius-core/tests/common_oauth/mod.rs"]
mod common_oauth;

use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::account_oauth::code_challenge;
use claudius_core::now_ms;
use common::{Server, World, free_port, http, wait_until};
use common_oauth::{build, fixture, hex, recorded_tree, request_body, tree, unlock};
use serde_json::{Value, json};

// ---- the fake token endpoint ----------------------------------------------------

#[derive(Default)]
struct Fake {
    queue: VecDeque<Value>,
    log: Vec<Value>,
}

/// A raw HTTP/1.1 listener: logs each request as the recorder's server did
/// and answers it with the next scripted response, byte for byte.
fn fake_token_server() -> (u16, Arc<Mutex<Fake>>) {
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
    let body = &buf[head_end + 4..head_end + 4 + len];
    let mut entry = json!({"method": method, "path": path, "headers": headers});
    match std::str::from_utf8(body) {
        Ok(t) => entry["body"] = json!(t),
        Err(_) => {
            entry["bodyHex"] = json!(body.iter().map(|b| format!("{b:02x}")).collect::<String>())
        }
    }
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

// ---- the server ------------------------------------------------------------------

const PROXY_VARS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

/// The binary with dev routes on, outbound requests sent to `base`, and the
/// store's env exactly `env` (anything else about accounts removed).
fn spawn(world: &World, base: &str, env: &Value) -> Server {
    let port = free_port();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_claudius"));
    cmd.args(["--port", &port.to_string(), "--no-next"])
        .current_dir(&world.project)
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_SCHEDULER")
        .env_remove("CLAUDIUS_ACCOUNTS_DIR")
        .env_remove("NODE_USE_ENV_PROXY")
        .env_remove("NO_PROXY")
        .env_remove("no_proxy")
        .env("CLAUDIUS_DEV", "1")
        .env("CLAUDIUS_DEV_FETCH_BASE", base)
        .env("CLAUDIUS_STATE_HOME", &world.home)
        .env("CLAUDE_CONFIG_DIR", &world.config)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Proxies to nowhere: undici ignores them without NODE_USE_ENV_PROXY=1,
    // so every replay also checks that the client does.
    let nowhere = format!("http://127.0.0.1:{}", free_port());
    for k in PROXY_VARS {
        cmd.env(k, &nowhere);
    }
    for (k, v) in env.as_object().unwrap() {
        cmd.env(k, v.as_str().unwrap());
    }
    let server = Server {
        child: cmd.spawn().unwrap(),
        port,
    };
    wait_until("health", Duration::from_secs(20), || {
        TcpStream::connect(("127.0.0.1", port)).is_ok()
            && http(port, "GET", "/api/rust/health", "").0 == 200
    });
    server
}

/// `(status, content type, body)` of a raw POST.
fn post(port: u16, body: &[u8]) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut req = format!(
        "POST /api/accounts/oauth HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    req.extend_from_slice(body);
    s.write_all(&req).unwrap();
    let mut out = Vec::new();
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

// ---- standing in for the recorded random values ---------------------------------

const B64URL: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn is_b64url(s: &str, len: usize) -> bool {
    s.len() == len && s.chars().all(|c| B64URL.contains(c))
}

fn is_hex_id(s: &str, prefix: &str) -> bool {
    s.strip_prefix(prefix)
        .is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A started flow, as answered: `(flowId, state, code_challenge)`.
fn start_answer(body: &str) -> Option<(String, String, String)> {
    let v: Value = serde_json::from_str(body).ok()?;
    let url = v["authUrl"].as_str()?;
    let at = url.find("&code_challenge=")? + "&code_challenge=".len();
    let challenge = url[at..].split('&').next()?.to_owned();
    Some((
        v["flowId"].as_str()?.to_owned(),
        v["state"].as_str()?.to_owned(),
        challenge,
    ))
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
fn learn_store(
    subs: &mut Subs,
    actual: &str,
    recorded: &str,
    window: (i64, i64),
    t0: i64,
    at: &str,
) {
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
        assert!(
            is_hex_id(aid, "acc_") && is_hex_id(rid, "acc_"),
            "{at}: {aid} / {rid}"
        );
        subs.add(aid, rid);
        if let (Some(ac), Some(rc)) = (a["createdAt"].as_str(), r["createdAt"].as_str()) {
            let ms = chrono::DateTime::parse_from_rfc3339(ac)
                .unwrap()
                .timestamp_millis();
            assert!(window.0 <= ms && ms <= window.1, "{at}: createdAt {ac}");
            subs.add(
                &format!("\"createdAt\": \"{ac}\""),
                &format!("\"createdAt\": \"{rc}\""),
            );
            subs.add(
                &format!("\"createdAt\":\"{ac}\""),
                &format!("\"createdAt\":\"{rc}\""),
            );
        }
        if let (Some(ae), Some(re)) = (a["expiresAt"].as_f64(), r["expiresAt"].as_f64()) {
            // recorded = t0 + e·1000, actual = t + e·1000 for t in the window.
            let tol = 1.0 + re.abs() * 4.0 * f64::EPSILON;
            let lo = re + (window.0 - t0) as f64 - tol;
            let hi = re + (window.1 - t0) as f64 + tol;
            assert!(lo <= ae && ae <= hi, "{at}: expiresAt {ae} for {re}");
            let (at_, rt) = (js::number_to_string(ae), js::number_to_string(re));
            subs.add(
                &format!("\"expiresAt\": {at_}"),
                &format!("\"expiresAt\": {rt}"),
            );
        }
    }
}

/// Header lines as compared: in order, names lowercased (hyper writes every
/// name in lower case, undici keeps the caller's `Content-Type`), without
/// the ones the clients differ on by design (see `KNOWN_HEADER_DIFFERENCES`)
/// and without `content-length`, which is checked against the body instead.
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
            k != "content-length" && !KNOWN_HEADER_DIFFERENCES.iter().any(|(n, _)| n == k)
        })
        .collect()
}

/// Request headers undici and the Rust client send differently.
const KNOWN_HEADER_DIFFERENCES: &[(&str, &str)] = &[
    ("host", "the fake's port differs per run"),
    (
        "connection",
        "undici sends `keep-alive`; hyper sends none (HTTP/1.1 keeps the connection by default)",
    ),
    (
        "accept-encoding",
        "undici asks for `gzip, deflate` (`br, gzip, deflate` over HTTPS) and decodes; the Rust client asks for `identity` and decodes nothing",
    ),
];

// ---- the replay --------------------------------------------------------------------

fn binary_case(case: &Value) -> bool {
    case["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| matches!(s["op"].as_str(), Some("post" | "files")))
        // A `throwCert` response is a rejected TLS handshake, which the
        // plain-HTTP fake can't present; `tests/account_oauth_golden.rs`
        // replays those through the scripted client.
        && !case["steps"].as_array().unwrap().iter().any(|s| {
            s["responses"]
                .as_array()
                .is_some_and(|r| r.iter().any(|r| r.get("throwCert").is_some()))
        })
}

fn refuses(case: &Value) -> bool {
    case["steps"].as_array().unwrap().iter().any(|s| {
        s["responses"]
            .as_array()
            .is_some_and(|r| r.iter().any(|r| r["refuse"] == true))
    })
}

struct Replay<'a> {
    w: String,
    server: &'a Server,
    fake: &'a Mutex<Fake>,
    t0: i64,
}

impl Replay<'_> {
    fn reset(&self) {
        for d in ["acc", "home/.claude"] {
            let p = format!("{}/{d}", self.w);
            unlock(std::path::Path::new(&p));
            let _ = std::fs::remove_dir_all(&p);
        }
    }

    /// The world tree as the recorder saw it (it had no config, project or
    /// home dir of its own).
    fn tree(&self) -> BTreeMap<String, Value> {
        let mut t = tree(&self.w, &["config", "project"]);
        t.remove("home");
        t
    }

    fn run(&self, case: &Value) {
        let case = &common_oauth::expected_case(case);
        let name = case["name"].as_str().unwrap();
        self.reset();
        build(&self.w, &case["files"]);
        let mut want_tree = recorded_tree(&case["start"]);
        want_tree.remove("home");
        assert_eq!(self.tree(), want_tree, "{name}: the world");
        let mut subs = Subs(Vec::new());
        // (flowId, state) answered here, and in the recording.
        let mut flows: Vec<(String, String)> = Vec::new();
        let mut challenges: BTreeMap<String, String> = BTreeMap::new();
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{name} / step {i}");
            if step["op"] == "files" {
                build(&self.w, &step["files"]);
            } else {
                self.post(step, &at, &mut subs, &mut flows, &mut challenges);
            }
            if let Some(t) = step.get("tree") {
                want_tree = recorded_tree(t);
                want_tree.remove("home");
            }
            let mut now = self.tree();
            for v in now.values_mut() {
                if let Some(x) = v["x"].as_str() {
                    v["x"] = json!(mask_tmp(&subs.apply(x)));
                }
            }
            let want: BTreeMap<String, Value> = want_tree
                .iter()
                .map(|(k, v)| {
                    let mut v = v.clone();
                    if let Some(x) = v["x"].as_str() {
                        v["x"] = json!(mask_tmp(x));
                    }
                    (k.clone(), v)
                })
                .collect();
            assert_eq!(now, want, "{at}: the world tree");
        }
    }

    fn post(
        &self,
        step: &Value,
        at: &str,
        subs: &mut Subs,
        flows: &mut Vec<(String, String)>,
        challenges: &mut BTreeMap<String, String>,
    ) {
        let responses = step["responses"].as_array().cloned().unwrap_or_default();
        {
            let mut fake = self.fake.lock().unwrap();
            fake.log.clear();
            fake.queue = responses
                .into_iter()
                .filter(|r| r["refuse"] != true)
                .collect();
        }
        let before = now_ms();
        let (status, ctype, body) = post(self.server.port, &request_body(step, flows));
        let after = now_ms();
        let want = &step["got"];

        // A start: its random values stand for the recorded ones.
        if want["status"] == 200
            && let Some((rf, rs, rc)) = start_answer(want["body"].as_str().unwrap())
        {
            let (af, as_, ac) = start_answer(&body).unwrap_or_else(|| panic!("{at}: {body}"));
            assert!(is_hex_id(&af, "oauth_"), "{at}: flowId {af}");
            assert!(is_b64url(&as_, 32) && is_b64url(&ac, 43), "{at}: {body}");
            subs.add(&af, &rf);
            subs.add(&as_, &rs);
            subs.add(&ac, &rc);
            challenges.insert(as_.clone(), ac);
            flows.push((af, as_));
        }

        // What reached the token endpoint.
        let log = std::mem::take(&mut self.fake.lock().unwrap().log);
        let recorded = step["wire"].as_array().cloned().unwrap_or_default();
        assert_eq!(
            log.len(),
            recorded.len(),
            "{at}: requests at the token endpoint"
        );
        for (a, r) in log.iter().zip(&recorded) {
            assert_eq!(
                (&a["method"], &a["path"]),
                (&r["method"], &r["path"]),
                "{at}: request line"
            );
            assert_eq!(
                headers(&a["headers"]),
                headers(&r["headers"]),
                "{at}: headers"
            );
            let length = |v: &Value| {
                v["headers"].as_array().unwrap().iter().find_map(|h| {
                    h[0].as_str()
                        .unwrap()
                        .eq_ignore_ascii_case("content-length")
                        .then(|| h[1].as_str().unwrap().parse::<usize>().unwrap())
                })
            };
            let sent = a["body"].as_str().map_or(0, str::len);
            assert_eq!(
                length(a).map(|_| sent),
                length(r).map(|_| sent),
                "{at}: a content-length on both or neither"
            );
            assert_eq!(length(a).unwrap_or(sent), sent, "{at}: content-length");
            let names: Vec<&str> = a["headers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| h[0].as_str().unwrap())
                .collect();
            assert!(
                names.iter().any(|n| n.eq_ignore_ascii_case("host")),
                "{at}: {names:?}"
            );
            assert!(
                a["headers"].as_array().unwrap().iter().any(|h| h[0]
                    .as_str()
                    .unwrap()
                    .eq_ignore_ascii_case("accept-encoding")
                    && h[1] == "identity"),
                "{at}: accept-encoding"
            );
            if let (Some(ab), Some(rb)) = (a["body"].as_str(), r["body"].as_str()) {
                if let (Ok(av), Ok(rv)) = (
                    serde_json::from_str::<Value>(ab),
                    serde_json::from_str::<Value>(rb),
                ) && let (Some(v), Some(rv_)) =
                    (av["code_verifier"].as_str(), rv["code_verifier"].as_str())
                {
                    // PKCE: the verifier sent is the one behind the challenge
                    // this flow answered.
                    let challenge = &challenges[av["state"].as_str().unwrap()];
                    assert!(is_b64url(v, 43), "{at}: verifier shape");
                    assert_eq!(&code_challenge(v), challenge, "{at}: S256 pairing");
                    subs.add(v, rv_);
                }
                assert_eq!(subs.apply(ab), rb, "{at}: request body");
            } else {
                assert_eq!(a["bodyHex"], r["bodyHex"], "{at}: request body");
            }
        }

        // The store: new ids, createdAt and expiresAt stand for the recorded.
        let file = format!("{}/acc/accounts.json", self.w);
        let home_file = format!("{}/home/.claude/.claudius/accounts.json", self.w);
        let recorded_tree = step.get("tree").map(recorded_tree).unwrap_or_default();
        for (path, key) in [
            (&file, "acc/accounts.json"),
            (&home_file, "home/.claude/.claudius/accounts.json"),
        ] {
            if let (Ok(actual), Some(rec)) = (
                std::fs::read_to_string(path),
                recorded_tree.get(key).and_then(|v| v["x"].as_str()),
            ) {
                learn_store(subs, &actual, rec, (before, after), self.t0, at);
            }
        }

        let got = if status == 500 && ctype.is_none() && body.is_empty() {
            assert!(want.get("threw").is_some(), "{at}: an empty 500");
            want.clone()
        } else {
            json!({"status": status, "type": ctype, "body": mask_tmp(&subs.apply(&common_oauth::sub(&self.w, &body)))})
        };
        let mut want = want.clone();
        if let Some(b) = want["body"].as_str() {
            want["body"] = json!(mask_tmp(b));
        }
        assert_eq!(got, want, "{at}");
    }
}

#[test]
fn replays_the_ts_golden_on_the_binary() {
    let fx = fixture();
    let t0 = fx["t0"].as_i64().unwrap();
    let cases: Vec<&Value> = fx["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| binary_case(c))
        .collect();
    assert!(cases.len() >= 70, "{} cases", cases.len());
    common_oauth::check_known_differences(&fx);
    let world = World::new();
    let w = world.root.path().display().to_string();
    let (fake_port, fake) = fake_token_server();
    let closed = free_port();
    // One server per store environment, and one whose token endpoint
    // refuses connections.
    let mut groups: Vec<(String, bool, Vec<&Value>)> = Vec::new();
    for c in cases {
        let key = (common_oauth::fill(&w, &c["env"]).to_string(), refuses(c));
        match groups.iter_mut().find(|g| (g.0.clone(), g.1) == key) {
            Some(g) => g.2.push(c),
            None => groups.push((key.0, key.1, vec![c])),
        }
    }
    let mut replayed = 0;
    for (env, refuse, cases) in &groups {
        let env: Value = serde_json::from_str(env).unwrap();
        let port = if *refuse { closed } else { fake_port };
        let server = spawn(&world, &format!("http://127.0.0.1:{port}"), &env);
        let replay = Replay {
            w: w.clone(),
            server: &server,
            fake: &fake,
            t0,
        };
        for c in cases {
            replay.run(c);
            replayed += 1;
        }
    }
    assert!(replayed >= 70, "{replayed}");
    unlock(world.root.path());
}

/// With `NODE_USE_ENV_PROXY=1` an https request tunnels through
/// `HTTPS_PROXY` with `CONNECT host:port`, as undici's env proxy agent does
/// (checked by hand on node 22.23.3; undici then retries a CONNECT the proxy
/// hangs up on, where reqwest fails the request).
#[test]
fn node_use_env_proxy_1_tunnels_through_the_proxy() {
    let world = World::new();
    let (proxy_port, fake) = fake_token_server();
    let direct = free_port(); // nothing listens: only the proxy is reached
    let proxy = format!("http://127.0.0.1:{proxy_port}");
    let mut env = json!({"NODE_USE_ENV_PROXY": "1"});
    for k in PROXY_VARS {
        env[k] = json!(proxy);
    }
    let server = spawn(&world, &format!("https://127.0.0.1:{direct}"), &env);
    let (status, _, body) = post(server.port, br#"{"action":"start"}"#);
    assert_eq!(status, 200, "{body}");
    let flow = js::json_parse(&body).unwrap()["flowId"].clone();
    let complete = json!({"action": "complete", "flowId": flow, "code": "c", "label": "L"});
    let (status, ctype, body) = post(server.port, complete.to_string().as_bytes());
    assert_eq!(
        (status, ctype.as_deref(), body.as_str()),
        (400, Some("application/json"), r#"{"error":"fetch failed"}"#)
    );
    let log = fake.lock().unwrap().log.clone();
    assert_eq!(log.len(), 1, "{log:?}");
    assert_eq!(
        (&log[0]["method"], &log[0]["path"]),
        (&json!("CONNECT"), &json!(format!("127.0.0.1:{direct}")))
    );
    drop(server);
    unlock(world.root.path());
}
