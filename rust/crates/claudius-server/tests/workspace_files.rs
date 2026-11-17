//! `GET/PUT/POST/DELETE/PATCH /api/workspaces/:id/files` on the real
//! `claudius` binary against what `rust/scripts/workspace-files-golden.mjs`
//! recorded from the real TS route handlers (the `groups` of
//! `claudius-core/tests/fixtures/workspace_files_golden.json`; its `pure`
//! half replays in `claudius-core/tests/workspace_files_golden.rs`).
//!
//! Each group gets a fresh world rebuilt the recorder's way: a temp root of
//! exactly `rootLen` characters (Node's NUL-byte messages cut the path at
//! 128 units) holding `home` (HOME and `CLAUDIUS_STATE_HOME`), `config`
//! (`CLAUDE_CONFIG_DIR`) and `project` (the server's cwd), umask 022, and a
//! server with only PATH, those, `TZ=UTC` and `GIT_CONFIG_NOSYSTEM=1` in its
//! environment. Steps run in order: `fs` ops rebuild the recorder's setup,
//! `req`s are sent as raw HTTP/1.1 and their status, content type, cache
//! header and body (text, or the recorder's sha256 and length) must match
//! ("threw" is Next's empty 500). After every step the recorded mtimes are
//! pinned and the whole world must look as the recorder saw it: every
//! entry's kind, mode, size and bytes (or hash), and link targets.
//!
//! Groups replay on the platform they were recorded on (macOS), the `os`
//! ones only there, and the `perms` ones only when permissions are enforced
//! (not root).
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use claudius_core::js_string;
use common::{Server, fake_bin, free_port};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../claudius-core/tests/fixtures/workspace_files_golden.json");
        js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// A step whose Rust answer is a listed difference: the request, what Rust
/// answers instead, and whether the step's recorded tree change is skipped
/// (Rust leaves the disk alone).
struct Known {
    group: &'static str,
    method: &'static str,
    url: &'static str,
    status: u16,
    body: &'static str,
    skip_tree: bool,
}

/// A customization id whose `..` climbs out of the customizations folder
/// resolves nowhere in Rust; TS (`path.join(root, id, "src")`) reads and
/// writes under `~/.claude/.claudius/y/src`.
const KNOWN: &[Known] = &[
    Known {
        group: "store",
        method: "GET",
        url: "/api/workspaces/cust_..%2F..%2F../files",
        status: 404,
        body: "{\"error\":\"workspace not found\"}",
        skip_tree: false,
    },
    Known {
        group: "store",
        method: "GET",
        url: "/api/workspaces/cust_x%2F..%2F..%2Fy/files",
        status: 404,
        body: "{\"error\":\"workspace not found\"}",
        skip_tree: false,
    },
    Known {
        group: "store",
        method: "GET",
        url: "/api/workspaces/cust_x%2F..%2F..%2Fy/files?path=escaped.txt",
        status: 404,
        body: "{\"error\":\"workspace not found\"}",
        skip_tree: false,
    },
    Known {
        group: "store",
        method: "PUT",
        url: "/api/workspaces/cust_x%2F..%2F..%2Fy/files?path=put.txt",
        status: 404,
        body: "{\"error\":\"workspace not found\"}",
        skip_tree: true,
    },
];

/// `process.platform`.
fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}

fn cstr(p: &Path) -> CString {
    CString::new(p.as_os_str().as_bytes()).unwrap()
}

/// `chmod` every directory under `p` back to 0755, so it can be removed.
fn open_up(p: &Path) {
    let Ok(m) = std::fs::symlink_metadata(p) else {
        return;
    };
    if !m.is_dir() || std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).is_err() {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            open_up(&e.path());
        }
    }
}

/// What the snapshot's hash cache keys a file by: inode, size, mtime and
/// ctime (ns).
type FileKey = (u64, u64, i128, i128);

/// Files bigger than this are snapshotted without their bytes.
const HASH_MAX: u64 = 4 * 1024 * 1024;

/// A world: `$ROOT` and what the recorder's snapshot needs.
struct World {
    _dir: tempfile::TempDir,
    root: String,
    /// `rel -> (key, bytes)`, as the recorder caches.
    hashes: std::cell::RefCell<BTreeMap<String, (FileKey, Value)>>,
}

impl World {
    fn new(len: usize) -> World {
        let dir = tempfile::tempdir().unwrap();
        let base = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let root = format!("{base}/{}", "r".repeat(len - base.len() - 1));
        assert_eq!(root.len(), len);
        assert!(
            root.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b)),
            "{root}"
        );
        for d in ["home", "config", "project"] {
            let p = Path::new(&root).join(d);
            std::fs::create_dir_all(&p).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        World {
            _dir: dir,
            root,
            hashes: Default::default(),
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        if rel.is_empty() {
            PathBuf::from(&self.root)
        } else {
            Path::new(&self.root).join(rel)
        }
    }

    fn real(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
            .replace("$RREL", &self.root[1..])
    }

    fn fake(&self, s: &str) -> String {
        s.replace(&self.root, "$ROOT")
            .replace(&self.root[1..], "$RREL")
    }

    /// `fake` on bytes (the root only).
    fn fake_bytes(&self, b: &[u8]) -> Vec<u8> {
        let needle = self.root.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i..].starts_with(needle) {
                out.extend_from_slice(b"$ROOT");
                i += needle.len();
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        out
    }

    /// Run one recorded `fs` op.
    fn apply(&self, s: &Value) {
        let p = self.path(s["path"].as_str().unwrap());
        let res = match s["act"].as_str().unwrap() {
            "mkdir" => std::fs::create_dir_all(&p),
            "write" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let data = if let Some(h) = s["hex"].as_str() {
                    unhex(&self.real(h))
                } else if let Some(rep) = s.get("rep") {
                    let mut t = rep["text"]
                        .as_str()
                        .unwrap()
                        .repeat(rep["count"].as_u64().unwrap() as usize);
                    t.push_str(rep["tail"].as_str().unwrap());
                    t.into_bytes()
                } else {
                    self.real(s["text"].as_str().unwrap()).into_bytes()
                };
                std::fs::write(&p, data)
            }
            "zero" => {
                std::fs::File::create(&p).and_then(|f| f.set_len(s["size"].as_u64().unwrap()))
            }
            "symlink" => std::os::unix::fs::symlink(self.real(s["target"].as_str().unwrap()), &p),
            "chmod" => std::fs::set_permissions(
                &p,
                std::fs::Permissions::from_mode(s["mode"].as_u64().unwrap() as u32),
            ),
            "fifo" => {
                let rc = unsafe { libc::mkfifo(cstr(&p).as_ptr(), 0o666) };
                assert_eq!(rc, 0, "mkfifo {p:?}");
                Ok(())
            }
            "mtime" => {
                let ns: i128 = s["ns"].as_str().unwrap().parse().unwrap();
                set_mtime(&p, ns);
                assert_eq!(mtime_ns(&std::fs::symlink_metadata(&p).unwrap()), ns);
                Ok(())
            }
            "rm" => {
                open_up(&p);
                match std::fs::symlink_metadata(&p) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p),
                    Ok(_) => std::fs::remove_file(&p),
                    Err(_) => Ok(()),
                }
            }
            "gen" => {
                let width = s["width"].as_u64().unwrap() as usize;
                let prefix = s["prefix"].as_str().unwrap();
                (0..s["count"].as_u64().unwrap()).try_for_each(|i| {
                    std::fs::write(
                        p.join(format!("{prefix}{i:0width$}")),
                        s["text"].as_str().unwrap(),
                    )
                })
            }
            other => panic!("unknown fs op {other}"),
        };
        res.unwrap_or_else(|e| panic!("{s}: {e}"));
    }

    /// Pin the recorded mtimes (paths that aren't here are skipped; the
    /// tree check reports them).
    fn pin(&self, pins: Option<&Value>) {
        for pin in pins.and_then(Value::as_array).into_iter().flatten() {
            let p = self.path(pin[0].as_str().unwrap());
            if std::fs::symlink_metadata(&p).is_ok() {
                set_mtime(&p, pin[1].as_str().unwrap().parse().unwrap());
            }
        }
    }

    /// The recorder's `walk()` + `entryOf()`: every entry under the world
    /// (the top-level `gen-*` dirs aside; a dir that can't be read has no
    /// children), keyed by its path relative to the root.
    fn snapshot(&self) -> BTreeMap<String, Value> {
        let mut out = BTreeMap::new();
        self.visit("", &mut out);
        out
    }

    fn visit(&self, rel: &str, out: &mut BTreeMap<String, Value>) {
        let Ok(rd) = std::fs::read_dir(self.path(rel)) else {
            return;
        };
        let mut names: Vec<String> = rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for name in names {
            if rel.is_empty() && name.starts_with("gen-") {
                continue;
            }
            let r = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let Ok(m) = std::fs::symlink_metadata(self.path(&r)) else {
                continue;
            };
            out.insert(r.clone(), self.entry(&r, &m));
            if m.is_dir() {
                self.visit(&r, out);
            }
        }
    }

    fn entry(&self, rel: &str, m: &std::fs::Metadata) -> Value {
        let mode = m.mode() & 0o7777;
        let t = m.file_type();
        if t.is_symlink() {
            let target = std::fs::read_link(self.path(rel)).unwrap();
            return json!({"k": "l", "t": self.fake(&target.to_string_lossy())});
        }
        if t.is_dir() {
            return json!({"k": "d", "m": mode});
        }
        if t.is_fifo() {
            return json!({"k": "p", "m": mode});
        }
        if !t.is_file() {
            return json!({"k": "o", "m": mode});
        }
        let key = (m.ino(), m.size(), mtime_ns(m), ctime_ns(m));
        let cached = self
            .hashes
            .borrow()
            .get(rel)
            .filter(|(k, _)| *k == key)
            .map(|(_, b)| b.clone());
        let b = cached.unwrap_or_else(|| {
            let b = if m.size() > HASH_MAX {
                json!("large")
            } else {
                match std::fs::read(self.path(rel)) {
                    Ok(bytes) => {
                        let bytes = self.fake_bytes(&bytes);
                        if bytes.len() <= 64 {
                            json!(hex(&bytes))
                        } else {
                            json!(format!("sha:{}:{}", sha(&bytes), bytes.len()))
                        }
                    }
                    Err(_) => Value::Null,
                }
            };
            self.hashes
                .borrow_mut()
                .insert(rel.to_owned(), (key, b.clone()));
            b
        });
        json!({"k": "f", "m": mode, "s": m.size(), "b": b})
    }
}

impl Drop for World {
    fn drop(&mut self) {
        open_up(Path::new(&self.root));
    }
}

fn mtime_ns(m: &std::fs::Metadata) -> i128 {
    i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec())
}

fn ctime_ns(m: &std::fs::Metadata) -> i128 {
    i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec())
}

/// `utimes(p, t, t)` to the nanosecond (through a symlink, as utimes goes).
fn set_mtime(p: &Path, ns: i128) {
    let ts = libc::timespec {
        tv_sec: ns.div_euclid(1_000_000_000) as libc::time_t,
        tv_nsec: ns.rem_euclid(1_000_000_000) as libc::c_long,
    };
    let times = [ts, ts];
    let rc = unsafe { libc::utimensat(libc::AT_FDCWD, cstr(p).as_ptr(), times.as_ptr(), 0) };
    assert_eq!(
        rc,
        0,
        "utimensat {p:?}: {}",
        std::io::Error::last_os_error()
    );
}

/// The server, with only the recorder's environment.
fn spawn(world: &World) -> Server {
    let port = free_port();
    let home = world.path("home");
    let mut child = Command::new(env!("CARGO_BIN_EXE_claudius"))
        .args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(fake_bin())
        .current_dir(world.path("project"))
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("CLAUDIUS_STATE_HOME", &home)
        .env("CLAUDE_CONFIG_DIR", world.path("config"))
        .env("TZ", "UTC")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    common::wait_healthy(&mut child, port, Duration::from_secs(30));
    Server { child, port }
}

/// A response: status, the two headers the recorder kept, the body.
struct Got {
    status: u16,
    content_type: Option<String>,
    cache: Option<String>,
    body: Vec<u8>,
}

fn request(port: u16, method: &str, target: &str, body: &[u8]) -> Got {
    let mut raw = format!(
        "{method} {target} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    raw.extend_from_slice(body);
    let common::Response {
        status,
        head,
        body: mut rest,
    } = common::exchange(port, &raw);
    assert!(status != 0, "no header block: {head}");
    let mut headers = BTreeMap::new();
    for l in head.split("\r\n").skip(1) {
        let (k, v) = l.split_once(':').unwrap();
        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
    }
    if headers.get("transfer-encoding").map(String::as_str) == Some("chunked") {
        let mut body = Vec::new();
        let mut at = 0;
        loop {
            let end = at + rest[at..].windows(2).position(|w| w == b"\r\n").unwrap();
            let n = usize::from_str_radix(std::str::from_utf8(&rest[at..end]).unwrap().trim(), 16)
                .unwrap();
            if n == 0 {
                break;
            }
            body.extend_from_slice(&rest[end + 2..end + 2 + n]);
            at = end + 2 + n + 2;
        }
        rest = body;
    } else if let Some(n) = headers.get("content-length") {
        assert_eq!(rest.len(), n.parse::<usize>().unwrap(), "{target}");
    }
    Got {
        status,
        content_type: headers.get("content-type").cloned(),
        cache: headers.get("cache-control").cloned(),
        body: rest,
    }
}

/// Compare an answer with a recorded `got`; `Err` describes the difference.
fn check(world: &World, want: &Value, got: &Got) -> Result<(), String> {
    if want.get("threw").is_some() {
        return if got.status == 500 && got.body.is_empty() && got.content_type.is_none() {
            Ok(())
        } else {
            Err(format!(
                "want Next's empty 500 ({}), got {} {:?} {}",
                want["threw"],
                got.status,
                got.content_type,
                String::from_utf8_lossy(&got.body)
            ))
        };
    }
    let mut problems = vec![];
    if want["status"].as_u64() != Some(u64::from(got.status)) {
        problems.push(format!("status {} want {}", got.status, want["status"]));
    }
    if want["type"].as_str() != got.content_type.as_deref() {
        problems.push(format!("type {:?} want {}", got.content_type, want["type"]));
    }
    if want.get("cache").and_then(Value::as_str) != got.cache.as_deref() {
        problems.push(format!(
            "cache {:?} want {:?}",
            got.cache,
            want.get("cache")
        ));
    }
    assert!(want.get("headers").is_none(), "other headers: {want}");
    if got.content_type.as_deref() == Some("application/json") {
        let text = world.fake(&String::from_utf8_lossy(&got.body));
        if got.body.len() <= 16384 {
            if want["body"].as_str() != Some(text.as_str()) {
                problems.push(format!("body\n      {text}\n want {}", want["body"]));
            }
        } else {
            let s = format!("{}:{}", sha(text.as_bytes()), text.len());
            if want["sha"].as_str() != Some(s.as_str()) {
                problems.push(format!(
                    "body sha {s} want {} ({}…)",
                    want["sha"],
                    text.chars().take(400).collect::<String>()
                ));
            }
        }
    } else if got.body.len() <= 64 {
        if want["hex"].as_str() != Some(hex(&got.body).as_str()) {
            problems.push(format!("bytes {} want {}", hex(&got.body), want["hex"]));
        }
    } else {
        let s = format!("{}:{}", sha(&got.body), got.body.len());
        if want["sha"].as_str() != Some(s.as_str()) {
            problems.push(format!("bytes sha {s} want {}", want["sha"]));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

fn tree_diff(want: &BTreeMap<String, Value>, got: &BTreeMap<String, Value>) -> Vec<String> {
    let mut out = vec![];
    for (k, w) in want {
        match got.get(k) {
            None => out.push(format!("missing {k}: {w}")),
            Some(g) if g != w => out.push(format!("{k}: {g} want {w}")),
            _ => {}
        }
    }
    for (k, g) in got {
        if !want.contains_key(k) {
            out.push(format!("extra {k}: {g}"));
        }
    }
    out
}

fn replay(name: &str) {
    let fx = fixture();
    let group = fx["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == name)
        .unwrap_or_else(|| panic!("no group {name}"));
    if group["platform"] != platform() {
        eprintln!("skipping {name}: recorded on {}", group["platform"]);
        return;
    }
    if group["perms"] == true && unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping {name}: permissions aren't enforced for root");
        return;
    }
    unsafe { libc::umask(0o022) };
    let world = World::new(fx["rootLen"].as_u64().unwrap() as usize);
    let mut expected = world.snapshot();
    assert_eq!(
        expected.keys().collect::<Vec<_>>(),
        ["config", "home", "project"]
    );
    world.pin(Some(&group["init"]["pins"]));
    let server = spawn(&world);
    let mut failures = vec![];
    let mut used = vec![];
    for (i, step) in group["steps"].as_array().unwrap().iter().enumerate() {
        let mut skip_tree = false;
        if step["op"] == "fs" {
            world.apply(step);
        } else {
            let method = step["method"].as_str().unwrap();
            let url = step["url"].as_str().unwrap();
            let body = match (step.get("body"), step.get("bodyHex")) {
                (Some(b), _) => world.real(b.as_str().unwrap()).into_bytes(),
                (_, Some(h)) => unhex(h.as_str().unwrap()),
                _ => Vec::new(),
            };
            let got = request(server.port, method, &world.real(url), &body);
            let known = KNOWN
                .iter()
                .find(|k| k.group == name && k.method == method && k.url == url);
            let want = match known {
                Some(k) => {
                    used.push(k.url);
                    skip_tree = k.skip_tree;
                    json!({"status": k.status, "type": "application/json", "body": k.body})
                }
                None => step["got"].clone(),
            };
            if let Err(e) = check(&world, &want, &got) {
                failures.push(format!("#{i} {method} {url}: {e}"));
            }
        }
        world.pin(step.get("pins"));
        if !skip_tree {
            for (k, v) in step
                .get("tree")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                if v.is_null() {
                    expected.remove(k);
                } else {
                    expected.insert(k.clone(), v.clone());
                }
            }
        }
        let actual = world.snapshot();
        let diff = tree_diff(&expected, &actual);
        if !diff.is_empty() {
            failures.push(format!("#{i} {step}: tree\n    {}", diff.join("\n    ")));
            // Later steps are compared from here.
            expected = actual;
        }
    }
    drop(server);
    let want_used: Vec<&str> = KNOWN
        .iter()
        .filter(|k| k.group == name)
        .map(|k| k.url)
        .collect();
    assert_eq!(used, want_used, "listed differences that didn't come up");
    assert!(
        failures.is_empty(),
        "{name}: {} of {} steps differ:\n{}",
        failures.len(),
        group["steps"].as_array().unwrap().len(),
        failures.join("\n")
    );
}

#[test]
fn every_group_has_a_test() {
    let names: Vec<&str> = fixture()["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "read",
            "darwin",
            "read-perms",
            "search",
            "limits",
            "write",
            "write-perms",
            "store"
        ]
    );
}

#[test]
fn read() {
    replay("read");
}

#[test]
fn darwin() {
    replay("darwin");
}

#[test]
fn read_perms() {
    replay("read-perms");
}

#[test]
fn search() {
    replay("search");
}

#[test]
fn limits() {
    replay("limits");
}

#[test]
fn write() {
    replay("write");
}

#[test]
fn write_perms() {
    replay("write-perms");
}

#[test]
fn store() {
    replay("store");
}
