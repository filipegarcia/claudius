//! The customization lifecycle routes (`POST /api/customizations`, and
//! `[id]/{deactivate,sync,description,build-app,publish,auto-fix}` plus
//! `[id]/publishes/[pubId]/revert`) against the real binary, replaying the
//! `steps` of `tests/fixtures/customization_actions_golden.json` (recorded
//! by `rust/scripts/customization-actions-golden.mjs` from the real TS
//! modules and route handlers run inside Next's route module): the same
//! file-system setup, the same per-project DB rows and the same `PATH` of
//! fakes (the `git` the diff runs, the `node` a launcher lookup finds, both
//! written from the fixture, and the live tree's `bin/claudius-revert` /
//! `scripts/build-app-local.mjs`), at the same points.
//!
//! Every request must answer the same status, content type and body ("threw"
//! is Next's empty 500), and leave the same `index.json` bytes, `.claudius`
//! tree and live tree, changed exactly where the recording changed them. A
//! `description` POST must also have sent the fake CLI the same argv, the
//! same system prompt and the same prompt text (the unified diff of the
//! user-edited files and the chat intent).
//!
//! What the replay maps, because the recorder pinned what this server reads
//! live:
//! * recorded request times → a real time inside the request's window
//!   ([`Clocks`], as in `customizations.rs`); a build's `startedAt` /
//!   `finishedAt` are two reads of one pinned clock, so they become `$T`
//!   once checked to be times inside the run;
//! * the random `cust_…` / `pub_…` ids → `$C<n>` / `$P<n>` by order of
//!   appearance;
//! * `$ROOT` (the temp root), `$NODE` (the fake node), `$CLI` (the fake
//!   CLI), `$MAC` (electron-builder's per-arch dir) and the workspace
//!   store's `.bak.<time>` name.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use claudius_core::{js_string, node_fs, now_ms, paths};
use common::{Server, fake_bin, free_port, http, wait_until};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/customization_actions_golden.json");
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
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

/// electron-builder's output dir for this arch (`macSubdir()`).
fn mac_subdir() -> &'static str {
    if std::env::consts::ARCH == "aarch64" {
        "mac-arm64"
    } else {
        "mac"
    }
}

// ---- the world ----------------------------------------------------------------

struct World {
    tmp: tempfile::TempDir,
    root: String,
    cli: String,
    /// The TS `CLAUDIUS_VERSION` the recording carries, and this build's.
    versions: (String, String),
}

impl Drop for World {
    fn drop(&mut self) {
        unlock(self.tmp.path());
    }
}

impl World {
    fn new(fx: &Value) -> World {
        let fakes = &fx["fakes"];
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        for d in ["home", "config", "project", "live", "fakebin", "sysbin"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        // The same stand-ins the recorder ran, from the fixture.
        for (name, body) in [("git", &fakes["git"]), ("node", &fakes["node"])] {
            let path = root.join("fakebin").join(name);
            std::fs::write(&path, str_of(body)).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        for tool in ["sh", "mkdir", "sleep", "rm", "test"] {
            for dir in ["/bin", "/usr/bin"] {
                let from = Path::new(dir).join(tool);
                if from.exists() {
                    std::os::unix::fs::symlink(&from, root.join("sysbin").join(tool)).unwrap();
                    break;
                }
            }
        }
        World {
            tmp,
            root: root.to_str().unwrap().to_owned(),
            cli: fake_bin().to_string_lossy().into_owned(),
            versions: (
                str_of(&fx["version"]).to_owned(),
                claudius_core::customizations::claudius_version(),
            ),
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        Path::new(&self.root).join(rel)
    }

    fn real(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    /// Everything this server reads live, written as the recorder wrote it.
    /// The two `CLAUDIUS_VERSION`s and the fallback name's UTC date (a
    /// pinned clock there, the real one here) become `$VER` and `$DATE`.
    fn fake(&self, s: &str) -> String {
        let node = self.path("fakebin/node").to_string_lossy().into_owned();
        mask_date(
            &s.replace(&self.versions.0, "$VER")
                .replace(&self.versions.1, "$VER"),
        )
        .replace(&node, "$NODE")
        .replace(&self.cli, "$CLI")
        .replace(&format!("/release/{}/", mac_subdir()), "/release/$MAC/")
        .replace(&self.root, "$ROOT")
    }

    fn claudius(&self) -> PathBuf {
        self.path("home/.claude/.claudius")
    }

    fn index(&self) -> PathBuf {
        self.claudius().join("customizations/index.json")
    }

    fn spawn(&self) -> Server {
        let port = free_port();
        let mut cmd = Command::new(common::server_bin());
        cmd.args(["--port", &port.to_string(), "--no-next"]);
        cmd.arg("--claude-bin")
            .arg(&self.cli)
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
                "PATH",
                format!(
                    "{}:{}",
                    self.path("fakebin").display(),
                    self.path("sysbin").display()
                ),
            )
            .env("FAKE_CLAUDE_SCRIPT", self.path("cli-script.json"))
            .env("FAKE_CLAUDE_ARGV", self.path("cli-argv.json"))
            .env("FAKE_CLAUDE_LOG", self.path("cli-stdin.log"))
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

    /// The recorder's `applyFs` (a `sdk` step names a transcript under the
    /// SDK's project dir for a cwd).
    fn apply(&self, s: &Value) {
        let p = match s.get("sdk") {
            Some(cwd) => self
                .path("config/projects")
                .join(paths::sdk_project_dir_name(&self.real(str_of(cwd))))
                .join(str_of(&s["name"]))
                .to_string_lossy()
                .into_owned(),
            None => self.real(str_of(&s["path"])),
        };
        let parent = || std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
        match str_of(&s["act"]) {
            "write" => {
                parent();
                std::fs::write(&p, self.real(str_of(&s["text"]))).unwrap();
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

    /// A `db` step: the recorder's `openDb(cwd, "readwrite").exec(sql)`.
    fn apply_db(&self, s: &Value) {
        let cwd = self.real(str_of(&s["cwd"]));
        let db = self
            .path("home/.claude/projects")
            .join(paths::encode_project_dir(&cwd))
            .join(".claudius.db");
        let conn = claudius_core::db::open_path(&db, claudius_core::db::Mode::ReadWrite).unwrap();
        conn.execute_batch(&self.real(str_of(&s["sql"]))).unwrap();
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
                Ok(b) => {
                    let masked = self.fake(&String::from_utf8_lossy(&b));
                    if masked.len() <= 2000 {
                        json!(masked)
                    } else {
                        json!(format!(
                            "sha256:{}:{}",
                            sha256(masked.as_bytes()),
                            masked.len()
                        ))
                    }
                }
                Err(_) => json!("f!"),
            };
        }
        let Ok(rd) = std::fs::read_dir(path) else {
            return json!("d!");
        };
        let mut names: Vec<String> = rd
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let mut out = Map::new();
        for name in names {
            out.insert(self.fake(&name), self.tree(&path.join(&name)));
        }
        Value::Object(out)
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            index: std::fs::read(self.index()).ok(),
            tree: self.tree(&self.claudius()),
            live: self.tree(&self.path("live")),
        }
    }
}

#[derive(PartialEq)]
struct Snapshot {
    index: Option<Vec<u8>>,
    tree: Value,
    live: Value,
}

/// SHA-256, for the recorder's `sha256:` digests of big files.
fn sha256(data: &[u8]) -> String {
    claudius_core::asset_store::sha256_hex(data)
}

// ---- normalizing --------------------------------------------------------------

/// The build state's two clock reads, and the sync status's view of the
/// manifest a request wrote a tick before the record it reports next to it.
const BODY_TIMES: &[&str] = &["startedAt", "finishedAt", "manifestCreatedAt"];
/// A manifest's `createdAt`, written next to the record's own.
const TREE_TIMES: &[&str] = &["createdAt"];

/// Recorded request times and the real ones they stand for (as in
/// `customizations.rs`).
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

    /// `want` against `got`: where they differ, `want` must hold the
    /// request's recorded time `clock`, and `got` in its place a time within
    /// `window`, which stands for it from then on.
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

/// Every `cust_<12 hex>` / `pub_<12 hex>` as `$C<n>` / `$P<n>`, by order of
/// appearance: the recorder's ids came from a seeded `randomUUID`.
fn mask_ids(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut seen: Vec<(String, String)> = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &s[i..];
        let kind = ["cust_", "pub_"]
            .into_iter()
            .find(|p| rest.starts_with(p))
            .filter(|p| {
                rest.len() >= p.len() + 12
                    && rest[p.len()..p.len() + 12]
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            });
        if let Some(prefix) = kind {
            let id = &rest[..prefix.len() + 12];
            let next = seen.len();
            let name = match seen.iter().find(|(seen, _)| seen == id) {
                Some((_, name)) => name.clone(),
                None => {
                    let name = format!("${}{next}", if prefix == "cust_" { "C" } else { "P" });
                    seen.push((id.to_owned(), name.clone()));
                    name
                }
            };
            out.push_str(&name);
            i += id.len();
            continue;
        }
        let c = s[i..].chars().next().expect("a char boundary");
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// The times a request read from its own clock more than once: the
/// recording pinned one value for all of them, so each is checked to be a
/// time inside the run and then written `$T`. `startedAt` / `finishedAt`
/// are the build state's two reads; `createdAt` is a manifest's, next to
/// the record's own in the index.
fn mask_times(s: &str, keys: &[&str], window: Option<(i64, i64)>) -> String {
    let mut out = s.to_owned();
    for key in keys {
        for sep in [format!("\"{key}\":"), format!("\\\"{key}\\\":")] {
            let mut at = 0;
            while let Some(i) = out[at..].find(&sep) {
                let start = at + i + sep.len();
                let start = start + usize::from(out[start..].starts_with(' '));
                let digits: String = out[start..]
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect();
                if digits.is_empty() {
                    at = start;
                    continue;
                }
                let t: i64 = digits.parse().unwrap();
                // A hand-written fixture value (a small `createdAt`) is the
                // same on both sides; only a clock read is masked.
                if t < 1_000_000_000_000 {
                    at = start;
                    continue;
                }
                if let Some(window) = window {
                    assert!(
                        (window.0..=window.1).contains(&t),
                        "{key} {t} outside the run {window:?}"
                    );
                }
                out.replace_range(start..start + digits.len(), "$T");
                at = start + 2;
            }
        }
    }
    out
}

/// `Customization <YYYY-MM-DD>`, the bootstrap's fallback name: the UTC day
/// of a pinned clock in the recording, of the real one here.
fn mask_date(s: &str) -> String {
    let mut out = s.to_owned();
    let head = "Customization ";
    let mut at = 0;
    while let Some(i) = out[at..].find(head) {
        let start = at + i + head.len();
        let day = &out[start..];
        let shaped = day.len() >= 10
            && day.as_bytes()[..10].iter().enumerate().all(|(n, b)| {
                if n == 4 || n == 7 {
                    *b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            });
        if shaped {
            out.replace_range(start..start + 10, "$DATE");
        }
        at = start;
    }
    out
}

/// The workspace store's rolling backup is named after the clock.
fn mask_bak(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| {
                    let k = if k.starts_with("workspaces.json.bak.") {
                        "workspaces.json.bak.*".to_owned()
                    } else {
                        k.clone()
                    };
                    (k, mask_bak(v))
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The text to compare for a tree: one JSON string, so a time inside a
/// recorded file can be aligned like any other.
fn tree_text(w: &World, v: &Value) -> String {
    mask_ids(&w.fake(&js_string::stringify(&mask_bak(v))))
}

// ---- HTTP ---------------------------------------------------------------------

struct Got {
    status: u16,
    types: Vec<String>,
    body: String,
}

fn request(port: u16, method: &str, path: &str, body: &[u8]) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
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
    let types = lines
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.trim().to_owned())
        .collect();
    Got {
        status,
        types,
        body: String::from_utf8_lossy(&out[split + 4..]).into_owned(),
    }
}

// ---- the fake CLI's side ---------------------------------------------------------

/// The recorder's `maskIds`: every UUID as `$UUID`.
fn mask_uuids(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let hex = |c: char| c.is_ascii_hexdigit() && !c.is_ascii_uppercase();
    let mut rest = s;
    'outer: while !rest.is_empty() {
        let bytes: Vec<char> = rest.chars().take(36).collect();
        if bytes.len() == 36 {
            let shape = [8, 4, 4, 4, 12];
            let mut at = 0;
            let mut ok = true;
            for (n, len) in shape.iter().enumerate() {
                if n > 0 {
                    ok &= bytes[at] == '-';
                    at += 1;
                }
                ok &= bytes[at..at + len].iter().copied().all(hex);
                at += len;
            }
            if ok {
                out.push_str("$UUID");
                rest = &rest[36..];
                continue 'outer;
            }
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// What the fake CLI was launched with and sent, as the recorder read it.
fn read_cli(w: &World) -> Value {
    let mask = |s: &str| mask_uuids(&w.fake(s));
    let argv = std::fs::read_to_string(w.path("cli-argv.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| {
            Value::Array(
                v.as_array()
                    .expect("an argv array")
                    .iter()
                    .map(|a| json!(mask(str_of(a))))
                    .collect(),
            )
        })
        .unwrap_or(Value::Null);
    let mut system = Value::Null;
    let mut prompt = Value::Null;
    if let Ok(log) = std::fs::read_to_string(w.path("cli-stdin.log")) {
        for line in log.lines().filter(|l| !l.is_empty()) {
            let Ok(m) = js_string::parse(line) else {
                continue;
            };
            if m["type"] == "control_request" && m["request"]["subtype"] == "initialize" {
                system = match &m["request"]["systemPrompt"] {
                    Value::Array(a) => {
                        Value::Array(a.iter().map(|s| json!(mask(str_of(s)))).collect())
                    }
                    _ => Value::Null,
                };
            }
            if m["type"] == "user" && prompt.is_null() {
                let content = &m["message"]["content"];
                prompt = json!(mask(&match content {
                    Value::String(s) => s.clone(),
                    other => js_string::stringify(other),
                }));
            }
        }
    }
    json!({"argv": argv, "system": system, "prompt": prompt})
}

// ---- the replay ---------------------------------------------------------------

#[test]
fn routes_match_the_ts_routes() {
    let fx = fixture();
    let w = World::new(&fx);
    let server = w.spawn();
    let t_begin = now_ms();
    let mut clocks = Clocks::default();
    let mut last = w.snapshot();
    let mut last_pub = "pub_none".to_owned();
    let mut reqs = 0;
    for (i, step) in fx["steps"].as_array().unwrap().iter().enumerate() {
        match str_of(&step["op"]) {
            "fs" => {
                w.apply(step);
                last = w.snapshot();
                continue;
            }
            "db" => {
                w.apply_db(step);
                last = w.snapshot();
                continue;
            }
            "wait" => {
                let path = format!(
                    "/api/customizations/{}/build-app",
                    str_of(&step["id"]).replace("$PUB", &last_pub)
                );
                wait_until("the build to settle", Duration::from_secs(60), || {
                    let (_, body) = http(server.port, "GET", &path, "");
                    !body.contains("\"status\":\"building\"")
                });
                last = w.snapshot();
                continue;
            }
            _ => {}
        }
        reqs += 1;
        let (method, path) = (str_of(&step["method"]), str_of(&step["path"]));
        let path = path.replace("$PUB", &last_pub);
        let ctx = format!("step {i} {method} {path}");
        let body = step["body"]
            .as_str()
            .map(|b| js_string::lossy(&w.real(b)).into_owned().into_bytes())
            .unwrap_or_default();
        let clock = step["clock"].as_i64().unwrap();
        let t0 = now_ms();
        let got = request(server.port, method, &path, &body);
        let window = (t0, now_ms());
        let run = (t_begin, now_ms());
        let rec = &step["got"];
        let now = w.snapshot();
        if rec.get("threw").is_some() {
            assert_eq!(
                (got.status, got.body.as_str(), got.types.clone()),
                (500, "", vec![]),
                "{ctx}: Next's empty 500"
            );
        } else {
            assert_eq!(
                u64::from(got.status),
                rec["status"].as_u64().unwrap(),
                "{ctx}: {}",
                got.body
            );
            assert_eq!(
                got.types,
                vec![str_of(&rec["type"]).to_owned()],
                "{ctx}: content type"
            );
            let have = mask_times(&mask_ids(&w.fake(&got.body)), BODY_TIMES, Some(run));
            let want = mask_times(&mask_ids(&w.fake(str_of(&rec["body"]))), BODY_TIMES, None);
            let want = clocks.align(&want, &have, clock, window);
            assert_eq!(have, want, "{ctx}: body");
            // The publish id a later `$PUB` path means.
            if got.status == 201
                && let Ok(parsed) = js_string::parse(&got.body)
                && let Some(id) = parsed["id"].as_str()
                && id.starts_with("pub_")
            {
                last_pub = id.to_owned();
            }
        }
        if let Some(cli) = step.get("cli") {
            let have = read_cli(&w);
            assert_eq!(
                mask_ids(&js_string::stringify(&have)),
                mask_ids(&js_string::stringify(cli)),
                "{ctx}: the CLI's argv, system prompt and prompt"
            );
        }
        match step.get("index") {
            None => assert!(
                now.index == last.index,
                "{ctx}: index unchanged, got {:?}",
                now.index.as_deref().map(String::from_utf8_lossy)
            ),
            Some(Value::Null) => assert_eq!(now.index, None, "{ctx}: index gone"),
            Some(want) => {
                let have = mask_ids(&w.fake(&String::from_utf8_lossy(
                    now.index.as_deref().expect("an index"),
                )));
                let want = clocks.align(&mask_ids(&w.fake(str_of(want))), &have, clock, window);
                assert_eq!(have, want, "{ctx}: index");
            }
        }
        for (key, got_tree, last_tree) in [
            ("tree", &now.tree, &last.tree),
            ("live", &now.live, &last.live),
        ] {
            match step.get(key) {
                None => assert_eq!(
                    mask_times(&tree_text(&w, got_tree), TREE_TIMES, Some(run)),
                    mask_times(&tree_text(&w, last_tree), TREE_TIMES, Some(run)),
                    "{ctx}: {key} unchanged"
                ),
                Some(want) => {
                    let have = mask_times(&tree_text(&w, got_tree), TREE_TIMES, Some(run));
                    let want = mask_times(&tree_text(&w, want), TREE_TIMES, None);
                    let want = clocks.align(&want, &have, clock, window);
                    assert_eq!(have, want, "{ctx}: {key}");
                }
            }
        }
        last = now;
    }
    assert_eq!(reqs, 74);
}

/// The one deliberate difference: an id whose mirror is not strictly inside
/// the customizations root. TS walks, writes and deletes wherever
/// `<root>/<id>/src` points (`..%2Fescape` is `.claudius/escape/src`); here
/// every route that would touch it answers 403, as D13's `diff` does. The
/// `description` GET is the exception — its hash failure already reads as
/// "no diff" — and `deactivate` / `revert` never touch the mirror.
#[test]
fn an_id_outside_the_root_is_refused() {
    let fx = fixture();
    let w = World::new(&fx);
    let server = w.spawn();
    let index = json!({
        "version": 1,
        "customizations": [{"id": "../escape"}],
        "publishes": [],
    });
    // `build-app` checks availability before the path (the TS order).
    std::fs::create_dir_all(w.path("live/scripts")).unwrap();
    std::fs::write(w.path("live/scripts/build-app-local.mjs"), "").unwrap();
    std::fs::write(w.path("live/electron-builder.yml"), "").unwrap();
    std::fs::create_dir_all(w.claudius().join("escape/src")).unwrap();
    std::fs::write(w.claudius().join("escape/src/a.txt"), "x").unwrap();
    std::fs::create_dir_all(w.index().parent().unwrap()).unwrap();
    std::fs::write(w.index(), js_string::stringify(&index)).unwrap();
    let before = w.snapshot();
    for (method, path) in [
        ("GET", "/api/customizations/..%2Fescape/sync"),
        ("POST", "/api/customizations/..%2Fescape/sync"),
        ("POST", "/api/customizations/..%2Fescape/publish"),
        ("POST", "/api/customizations/..%2Fescape/auto-fix"),
        ("POST", "/api/customizations/..%2Fescape/description"),
        ("POST", "/api/customizations/..%2Fescape/build-app"),
    ] {
        let got = request(server.port, method, path, b"");
        assert_eq!(
            (got.status, got.body.as_str()),
            (403, r#"{"error":"path outside allowed root"}"#),
            "{method} {path}"
        );
    }
    // The GET still answers, with no current hash (TS hashes the escaped
    // tree and gets one, but only `stale` would use it, and that needs a
    // stored description).
    let got = request(
        server.port,
        "GET",
        "/api/customizations/..%2Fescape/description",
        b"",
    );
    assert_eq!(
        (got.status, got.body.as_str()),
        (
            200,
            r#"{"description":null,"descriptionGeneratedAt":null,"descriptionDiffHash":null,"descriptionIsManual":false,"currentDiffHash":"","stale":false}"#
        )
    );
    assert!(
        w.snapshot() == before,
        "nothing outside the root was touched"
    );
}
