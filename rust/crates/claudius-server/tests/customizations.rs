//! The customization routes (`/api/customizations` GET, `[id]`
//! GET/PATCH/DELETE, `select`, `publishes`, `diff`) against the real
//! binary, replaying the `steps` of
//! `claudius-core/tests/fixtures/customizations_golden.json` (recorded by
//! `rust/scripts/customizations-golden.mjs` from the real TS store and route
//! handlers run inside Next's route module): the same file-system setup
//! (index files, mirrors, the live tree, symlinks, modes) at the same
//! points, with `CLAUDIUS_LIVE_SOURCE` set as the recorder set it. Every
//! request must answer the same status, content type, `Set-Cookie`s (in
//! order) and body ("threw" is Next's empty 500), and leave the same
//! `index.json` bytes and `.claudius` tree, changed exactly where the
//! recording changed them.
//!
//! The recorder pinned `Date.now()` per request; this server runs on the
//! real clock. A recorded request time found in a body or the index must
//! come back, in its place, as a time within the request, which from then
//! on stands for it; a cookie's `Expires` must be a year past a time within
//! the request, and the recorded one the TS format of a year past the
//! pinned time.
//!
//! Three recorded requests differ on purpose ([`expected_difference`]).
//! [`delete_leaves_next_alone`] runs against a fake Next upstream: since D15
//! the preview routes and the preview stop on `DELETE` are this server's
//! own (replayed in `customization_preview.rs`), and only a route still
//! Next-only goes there.
#![cfg(unix)]

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_core::{js_string, node_fs, now_ms};
use claudius_server::workspaces::utc_string;
use common::{Server, fake_bin, free_port, http, wait_until};
use serde_json::{Map, Value, json};

const YEAR_MS: i64 = 31_536_000_000;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/customizations_golden.json");
    // Lone-surrogate escapes: serde_json would refuse them.
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// SHA-256 (FIPS 180-4), for the recorder's `sha256:` file digests.
fn sha256(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            (hh, g, f, e, d, c, b, a) = (g, f, e, d.wrapping_add(t1), c, b, a, t1.wrapping_add(t2));
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

/// The recorder's generated contents: byte `i` is `(i * 31 + seed) & 255`.
fn pattern(len: usize, seed: usize) -> Vec<u8> {
    (0..len).map(|i| ((i * 31 + seed) & 255) as u8).collect()
}

fn unlock(dir: &Path) {
    let Ok(m) = std::fs::symlink_metadata(dir) else {
        return;
    };
    if !m.is_dir() {
        return;
    }
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            unlock(&e.path());
        }
    }
}

// ---- the world ----------------------------------------------------------------

struct World {
    tmp: tempfile::TempDir,
    root: String,
}

impl Drop for World {
    fn drop(&mut self) {
        unlock(self.tmp.path());
    }
}

impl World {
    fn new() -> World {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        for d in ["home", "config", "project", "live"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let root = root.to_str().unwrap().to_owned();
        World { tmp, root }
    }

    fn path(&self, rel: &str) -> PathBuf {
        Path::new(&self.root).join(rel)
    }

    fn real(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    fn fake(&self, s: &str) -> String {
        s.replace(&self.root, "$ROOT")
    }

    fn real_bytes(&self, raw: &[u8]) -> Vec<u8> {
        let (needle, mut out, mut at) = (b"$ROOT", Vec::new(), 0);
        while let Some(i) = raw[at..].windows(needle.len()).position(|w| w == needle) {
            out.extend_from_slice(&raw[at..at + i]);
            out.extend_from_slice(self.root.as_bytes());
            at += i + needle.len();
        }
        out.extend_from_slice(&raw[at..]);
        out
    }

    fn claudius(&self) -> PathBuf {
        self.path("home/.claude/.claudius")
    }

    fn index(&self) -> PathBuf {
        self.claudius().join("customizations/index.json")
    }

    /// `claudius` in this world (`next`: a fake Next upstream's port).
    fn spawn(&self, next: Option<u16>) -> Server {
        let port = free_port();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_claudius"));
        // `--no-next` first, so the orphan selector in the brief matches;
        // a later `--next` wins.
        cmd.args(["--port", &port.to_string(), "--no-next"]);
        if let Some(up) = next {
            cmd.args(["--next", &format!("http://127.0.0.1:{up}")]);
        }
        cmd.arg("--claude-bin")
            .arg(fake_bin())
            .current_dir(self.path("project"))
            .env_remove("RUST_LOG")
            .env_remove("CLAUDIUS_DEBUG_SESSIONS")
            .env_remove("NODE_ENV")
            .env_remove("CLAUDIUS_DEV")
            .env_remove("CLAUDIUS_SCHEDULER")
            .env("HOME", self.path("home"))
            .env("CLAUDIUS_STATE_HOME", self.path("home"))
            .env("CLAUDE_CONFIG_DIR", self.path("config"))
            .env(
                "CLAUDIUS_LIVE_SOURCE",
                format!(" {}\t", self.path("live").display()),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().unwrap();
        wait_until("health", Duration::from_secs(30), || {
            if let Ok(Some(st)) = child.try_wait() {
                panic!("claudius exited ({st})");
            }
            TcpStream::connect(("127.0.0.1", port)).is_ok()
                && http(port, "GET", "/api/rust/health", "").0 == 200
        });
        Server { child, port }
    }

    /// The recorder's `applyFs`.
    fn apply(&self, s: &Value) {
        let p = self.real(str_of(&s["path"]));
        let parent = || std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
        match str_of(&s["act"]) {
            "write" => {
                parent();
                let bytes = if let Some(g) = s["gen"].as_array() {
                    pattern(
                        g[0].as_u64().unwrap() as usize,
                        g[1].as_u64().unwrap() as usize,
                    )
                } else if let Some(h) = s["hex"].as_str() {
                    self.real_bytes(&unhex(h))
                } else {
                    // `writeFileSync(path, string)`: lone surrogates as U+FFFD.
                    js_string::lossy(&self.real(str_of(&s["text"])))
                        .into_owned()
                        .into_bytes()
                };
                std::fs::write(&p, bytes).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(&p).unwrap(),
            "rm" => node_fs::rm_recursive_force(&p).unwrap(),
            "symlink" => {
                parent();
                std::os::unix::fs::symlink(self.real(str_of(&s["target"])), &p).unwrap();
            }
            "chmod" => {
                let mode = s["mode"].as_u64().unwrap() as u32;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            }
            other => panic!("fs act {other}"),
        }
    }

    /// The recorder's `tree()`.
    fn tree(&self, path: &Path) -> Value {
        let Ok(st) = std::fs::symlink_metadata(path) else {
            return Value::Null;
        };
        if st.file_type().is_symlink() {
            let target = std::fs::read_link(path).unwrap();
            return json!(format!("l>{}", self.fake(&target.to_string_lossy())));
        }
        if path == self.index() && st.is_file() {
            return json!("index");
        }
        if !st.is_dir() {
            return match std::fs::read(path) {
                Ok(b) if b.len() <= 32 => json!(hex(&b)),
                Ok(b) => json!(format!("sha256:{}:{}", sha256(&b), b.len())),
                Err(_) => json!("f!"),
            };
        }
        let Ok(rd) = std::fs::read_dir(path) else {
            return json!("d!");
        };
        let mut out = Map::new();
        for e in rd {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            out.insert(self.fake(&name), self.tree(&path.join(&name)));
        }
        Value::Object(out)
    }

    fn snapshot(&self) -> (Option<Vec<u8>>, Value) {
        (
            std::fs::read(self.index()).ok(),
            self.tree(&self.claudius()),
        )
    }
}

// ---- HTTP -----------------------------------------------------------------------

struct Got {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Got {
    fn all(&self, name: &str) -> Vec<String> {
        self.headers
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .collect()
    }
}

/// One HTTP/1.1 request; `cookie` and `body` are sent as they are.
fn request(port: u16, method: &str, path: &str, cookie: Option<&str>, body: &[u8]) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(c) = cookie {
        req.push_str(&format!("Cookie: {c}\r\n"));
    }
    req.push_str(&format!(
        "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    ));
    let mut bytes = req.into_bytes();
    bytes.extend_from_slice(body);
    s.write_all(&bytes).unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&out[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let body = out[split + 4..].to_vec();
    assert!(
        !headers.iter().any(|(k, _)| k == "transfer-encoding"),
        "{path}: unexpected chunked body"
    );
    Got {
        status,
        headers,
        body,
    }
}

// ---- times ------------------------------------------------------------------------

/// Recorded request times and the real ones they stand for.
#[derive(Default)]
struct Clocks(Vec<(String, String)>);

impl Clocks {
    fn map(&self, s: &str) -> String {
        let mut s = s.to_owned();
        for (c, r) in &self.0 {
            s = s.replace(c, r);
        }
        s
    }

    /// `want` (already `$ROOT`-mapped) against `got`: where they differ,
    /// `want` must hold the request's recorded time `clock`, and `got` in
    /// its place a time within `window`, which stands for it from then on.
    fn align(&mut self, want: &str, got: &str, clock: i64, window: (i64, i64)) -> String {
        let mut want = self.map(want);
        let c = clock.to_string();
        while want != got {
            let Some(d) = want.bytes().zip(got.bytes()).position(|(a, b)| a != b) else {
                break;
            };
            let s = want[..d]
                .rfind(|ch: char| !ch.is_ascii_digit())
                .map_or(0, |i| i + 1);
            if !want[s..].starts_with(&c) || got.len() < s + c.len() {
                break;
            }
            let r = &got[s..s + c.len()];
            let Ok(t) = r.parse::<i64>() else { break };
            assert!(
                (window.0..=window.1).contains(&t),
                "time {t} outside the request {window:?}"
            );
            self.0.push((c.clone(), r.to_owned()));
            want = want.replace(&c, r);
        }
        want
    }
}

/// `Expires=<date>` of a `Set-Cookie` with `Max-Age`: a year past a time in
/// `window` (whole seconds); the recorded one must be the TS text of a year
/// past `clock`. Both come back as `Expires=*`.
fn expires(want: &str, got: &str, clock: i64, window: (i64, i64)) -> (String, String) {
    let cut = |s: &str| -> (String, Option<String>) {
        match s.split_once("; Expires=") {
            Some((head, rest)) if rest.contains("Max-Age=") => {
                let (date, tail) = rest.split_once("; ").unwrap();
                (format!("{head}; Expires=*; {tail}"), Some(date.to_owned()))
            }
            _ => (s.to_owned(), None),
        }
    };
    let (w, wd) = cut(want);
    let (g, gd) = cut(got);
    if let Some(wd) = wd {
        assert_eq!(wd, utc_string(clock + YEAR_MS), "recorded Expires");
        let gd = gd.unwrap_or_else(|| panic!("no Expires in {got}"));
        let ok =
            (window.0 / 1000..=window.1 / 1000 + 1).any(|s| utc_string(s * 1000 + YEAR_MS) == gd);
        assert!(ok, "Expires {gd} is not a year past the request {window:?}");
    }
    (w, g)
}

// ---- the replay ---------------------------------------------------------------------

/// The recorded requests this port answers differently on purpose. Each id
/// names a dir outside the customizations root, which TS walks or removes:
/// * `GET /..%2Fescape/diff`: TS hashes `<root>/../escape/src`; 403 here.
/// * `DELETE /..%2Fescape`: TS removes `.claudius/escape`; here it stays
///   (the record still goes).
/// * `DELETE /x%2F..`: TS removes the whole customizations root, index
///   and all (and so has no record left to drop); here the root stays and
///   the index loses the record.
fn expected_difference(step: &Value) -> Option<&'static str> {
    match (str_of(&step["method"]), str_of(&step["path"])) {
        ("GET", "/api/customizations/..%2Fescape/diff") => Some("diff"),
        ("DELETE", "/api/customizations/..%2Fescape") => Some("rm escape"),
        ("DELETE", "/api/customizations/x%2F..") => Some("rm root"),
        _ => None,
    }
}

#[test]
fn routes_match_the_ts_routes() {
    let fx = fixture();
    let w = World::new();
    // The live tree, as the recorder's `store` section left it.
    for step in fx["store"].as_array().unwrap() {
        if step["op"] == "fs" && str_of(&step["path"]).starts_with("$ROOT/live/") {
            w.apply(step);
        }
    }
    let server = w.spawn(None);
    let mut clocks = Clocks::default();
    let mut last = w.snapshot();
    let (mut reqs, mut differences) = (0, 0);
    for (i, step) in fx["steps"].as_array().unwrap().iter().enumerate() {
        if step["op"] == "fs" {
            w.apply(step);
            last = w.snapshot();
            continue;
        }
        reqs += 1;
        let (method, path) = (str_of(&step["method"]), str_of(&step["path"]));
        let ctx = format!("step {i} {method} {path}");
        let body = if let Some(b) = step["body"].as_str() {
            js_string::lossy(&w.real(b)).into_owned().into_bytes()
        } else if let Some(h) = step["bodyHex"].as_str() {
            w.real_bytes(&unhex(h))
        } else {
            Vec::new()
        };
        let cookie = step["cookie"].as_str().map(|c| w.real(c));
        let clock = step["clock"].as_i64().unwrap();
        let t0 = now_ms();
        let got = request(server.port, method, path, cookie.as_deref(), &body);
        let window = (t0, now_ms());
        let rec = &step["got"];
        let text = String::from_utf8_lossy(&got.body).into_owned();
        let others: Vec<&str> = got
            .headers
            .iter()
            .map(|(k, _)| k.as_str())
            .filter(|k| {
                ![
                    "content-type",
                    "set-cookie",
                    "content-length",
                    "date",
                    "connection",
                ]
                .contains(k)
            })
            .collect();
        assert_eq!(others, Vec::<&str>::new(), "{ctx}: headers");
        let now = w.snapshot();
        match expected_difference(step) {
            Some("diff") => {
                differences += 1;
                assert_eq!(
                    (got.status, text.as_str()),
                    (403, r#"{"error":"path outside allowed root"}"#),
                    "{ctx}"
                );
                assert_eq!(now, last, "{ctx}: a refused diff touches nothing");
                continue;
            }
            Some(kind) => {
                differences += 1;
                assert_eq!(
                    (got.status, text.as_str()),
                    (200, r#"{"ok":true}"#),
                    "{ctx}"
                );
                let mut want_tree = rec_tree(step, &last.1);
                let want_index = match kind {
                    // TS removed `.claudius/escape`; it stays.
                    "rm escape" => {
                        want_tree["escape"] = last.1["escape"].clone();
                        assert!(want_tree["escape"].is_object(), "{ctx}");
                        rec_index(step, &w, &clocks, &last.0)
                    }
                    // TS removed the root; it stays, without the record.
                    _ => {
                        want_tree = last.1.clone();
                        let mut shape =
                            js_string::parse(&String::from_utf8_lossy(last.0.as_ref().unwrap()))
                                .unwrap();
                        let list = shape["customizations"].as_array_mut().unwrap();
                        let before = list.len();
                        list.retain(|c| c["id"] != "x/..");
                        assert_eq!(list.len(), before - 1, "{ctx}");
                        Some((js_string::stringify_pretty(&shape) + "\n").into_bytes())
                    }
                };
                assert_eq!(now.1, want_tree, "{ctx}: tree");
                assert_eq!(now.0, want_index, "{ctx}: index");
                last = now;
                continue;
            }
            _ => {}
        }
        if rec.get("threw").is_some() {
            assert_eq!(
                (got.status, text.as_str(), got.all("content-type")),
                (500, "", vec![]),
                "{ctx}: Next's empty 500"
            );
        } else {
            assert_eq!(
                u64::from(got.status),
                rec["status"].as_u64().unwrap(),
                "{ctx}: {text}"
            );
            assert_eq!(
                got.all("content-type"),
                vec![str_of(&rec["type"]).to_owned()],
                "{ctx}"
            );
            let want_cookies: Vec<String> = rec["cookies"]
                .as_array()
                .map(|a| a.iter().map(|c| w.real(str_of(c))).collect())
                .unwrap_or_default();
            let got_cookies = got.all("set-cookie");
            assert_eq!(
                got_cookies.len(),
                want_cookies.len(),
                "{ctx}: {got_cookies:?}"
            );
            for (want, have) in want_cookies.iter().zip(&got_cookies) {
                let (want, have) = expires(want, have, clock, window);
                assert_eq!(have, want, "{ctx}: cookie");
            }
            let want = clocks.align(&w.real(str_of(&rec["body"])), &text, clock, window);
            assert_eq!(text, want, "{ctx}: body");
        }
        // The index and the tree, changed where the recording changed them.
        match step.get("index") {
            None => assert_eq!(now.0, last.0, "{ctx}: index unchanged"),
            Some(Value::Null) => assert_eq!(now.0, None, "{ctx}: index gone"),
            Some(want) => {
                let have =
                    String::from_utf8_lossy(now.0.as_deref().expect("an index")).into_owned();
                let want = clocks.align(&w.real(str_of(want)), &have, clock, window);
                assert_eq!(have, want, "{ctx}: index");
            }
        }
        match step.get("tree") {
            None => assert_eq!(now.1, last.1, "{ctx}: tree unchanged"),
            Some(want) => assert_eq!(&now.1, want, "{ctx}: tree"),
        }
        last = now;
    }
    assert_eq!((reqs, differences), (172, 3));
}

/// The recorded tree after `step` (the one before when it didn't change).
fn rec_tree(step: &Value, before: &Value) -> Value {
    step.get("tree").cloned().unwrap_or_else(|| before.clone())
}

/// The recorded index bytes after `step`, mapped.
fn rec_index(
    step: &Value,
    w: &World,
    clocks: &Clocks,
    before: &Option<Vec<u8>>,
) -> Option<Vec<u8>> {
    match step.get("index") {
        None => before.clone(),
        Some(Value::Null) => None,
        Some(t) => Some(clocks.map(&w.real(str_of(t))).into_bytes()),
    }
}

// ---- the Next half -----------------------------------------------------------------

/// A fake Next upstream: answers every request `200 {"next":true}` and logs
/// `METHOD path body`.
fn fake_next() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let log = Arc::new(Mutex::new(Vec::new()));
    let seen = log.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { continue };
            let mut reader = BufReader::new(conn.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let mut len = 0;
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; len];
            let _ = reader.read_exact(&mut body);
            let target = line.split(' ').take(2).collect::<Vec<_>>().join(" ");
            seen.lock()
                .unwrap()
                .push(format!("{target} {}", String::from_utf8_lossy(&body)));
            let _ = conn.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\nConnection: close\r\n\r\n{\"next\":true}",
            );
        }
    });
    (port, log)
}

/// Since D15 the preview routes, and the preview stop on `DELETE`, are this
/// server's own (`tests/customization_preview.rs`): with a Next upstream
/// configured, only a route still Next-only (`updater/apply`) goes
/// there, body and all.
#[test]
fn delete_leaves_next_alone() {
    let w = World::new();
    let dir = w.claudius().join("customizations/cust a/b");
    let (up, log) = fake_next();
    let server = w.spawn(Some(up));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    let index = json!({
        "version": 1,
        "customizations": [
            {"id": "cust a/b", "name": "n"},
            {"id": "cust_busy", "name": "n"},
        ],
        "publishes": [{"id": "p", "customizationId": "cust_busy", "revertedAt": null}],
    });
    std::fs::write(w.index(), js_string::stringify_pretty(&index)).unwrap();

    let (st, body) = http(
        server.port,
        "POST",
        "/api/updater/apply",
        r#"{"paths":["x"]}"#,
    );
    assert_eq!((st, body.as_str()), (200, r#"{"next":true}"#));
    // The port's own routes don't go there, the preview's included.
    let (st, _) = http(server.port, "GET", "/api/customizations", "");
    assert_eq!(st, 200);
    let (st, body) = http(
        server.port,
        "GET",
        "/api/customizations/cust_busy/preview",
        "",
    );
    assert_eq!(
        (st, body.as_str()),
        (
            200,
            r#"{"customizationId":"cust_busy","status":"exited","port":null,"pid":null,"startedAt":null,"exitCode":null,"exitSignal":null,"logs":[]}"#
        )
    );
    // A blocked DELETE stops nothing.
    let (st, body) = http(server.port, "DELETE", "/api/customizations/cust_busy", "");
    assert_eq!(
        (st, body.as_str()),
        (
            409,
            r#"{"error":"cannot delete: 1 active publish. Revert first."}"#
        )
    );
    // DELETE stops the preview here, then removes the dir and the record.
    let (st, body) = http(
        server.port,
        "DELETE",
        "/api/customizations/cust%20a%2Fb",
        "",
    );
    assert_eq!((st, body.as_str()), (200, r#"{"ok":true}"#));
    assert!(!dir.exists());
    assert!(w.claudius().join("customizations/cust a").is_dir());
    assert!(
        !std::fs::read_to_string(w.index())
            .unwrap()
            .contains("cust a/b")
    );
    assert_eq!(
        *log.lock().unwrap(),
        ["POST /api/updater/apply {\"paths\":[\"x\"]}"]
    );
}

#[test]
fn without_next_the_delete_still_goes_through() {
    let w = World::new();
    let server = w.spawn(None);
    let index = json!({"version": 1, "customizations": [{"id": "c"}], "publishes": []});
    std::fs::create_dir_all(w.claudius().join("customizations/c/src")).unwrap();
    std::fs::write(w.index(), js_string::stringify(&index)).unwrap();
    let (st, body) = http(server.port, "DELETE", "/api/customizations/c", "");
    assert_eq!((st, body.as_str()), (200, r#"{"ok":true}"#));
    assert!(!w.claudius().join("customizations/c").exists());
    // A route still Next-only has nowhere to go.
    let (st, body) = http(server.port, "POST", "/api/updater/apply", "");
    assert_eq!(
        (st, body.as_str()),
        (404, "not found (no Next upstream configured)")
    );
}
