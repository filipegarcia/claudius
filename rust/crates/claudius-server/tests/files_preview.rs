//! `GET /api/workspaces/:id/files/preview/*path` (D03c) on the real
//! `claudius` binary against what `rust/scripts/files-preview-golden.mjs`
//! recorded from the TS route handler behind Next's route matcher
//! (`fixtures/files_preview_golden.json`).
//!
//! Each group gets a fresh world rebuilt the recorder's way: a temp root
//! (through realpath, the recorder's `$ROOT`) holding `home`
//! (`CLAUDIUS_STATE_HOME`), `config` (`CLAUDE_CONFIG_DIR`) and `project` (the
//! server's cwd), umask 022. Steps run in order: `fs` ops rebuild the
//! recorder's setup (the server starts at the first request), `req`s go out
//! as raw HTTP/1.1 and must match the recorded status, content type, cache
//! header and body (`text`, `hex`, or the sha256 and length). `threw` is
//! Next's empty 500; `decode` (a param Next's matcher can't decode, its 400
//! page) must be handed to Next, here the `--no-next` proxy's 404; `garbage`
//! is the deliberate difference: TS serves an empty file as the 64 KiB
//! scratch buffer Node's `readFile` read it into, Rust serves it empty. The
//! `perms` group runs only where permissions are enforced (not root).
//!
//! The URLs Next doesn't hand the handler as they came (a `//`, a `\`, a
//! trailing `/`, a dot segment) aren't in the fixture; the last test checks
//! that they go to Next.
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::ffi::CString;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use common::{Server, World};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// What the proxy answers under `--no-next`: the request went to Next.
const NO_NEXT: &str = "not found (no Next upstream configured)";

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/files_preview_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
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

/// chmod every directory under `p` back to 0755, so it can be removed.
fn open_up(p: &Path) {
    let Ok(m) = std::fs::symlink_metadata(p) else {
        return;
    };
    if !m.is_dir() || std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).is_err() {
        return;
    }
    for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
        open_up(&e.path());
    }
}

/// A world: the temp dir and its realpath (`$ROOT`).
struct Root {
    world: World,
    root: String,
}

impl Root {
    fn new() -> Root {
        let world = World::new();
        let root = world
            .root
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(world.project, Path::new(&root).join("project"));
        Root { world, root }
    }

    fn real(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    /// Run one recorded `fs` op.
    fn apply(&self, s: &Value) {
        let p = Path::new(&self.root).join(self.real(s["path"].as_str().unwrap()));
        let res = match s["act"].as_str().unwrap() {
            "mkdir" => std::fs::create_dir_all(&p),
            "write" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let data = match s["hex"].as_str() {
                    Some(h) => unhex(h),
                    None => self.real(s["text"].as_str().unwrap()).into_bytes(),
                };
                std::fs::write(&p, data)
            }
            "zero" => {
                std::fs::File::create(&p).and_then(|f| f.set_len(s["size"].as_u64().unwrap()))
            }
            "symlink" => std::os::unix::fs::symlink(self.real(s["target"].as_str().unwrap()), &p),
            "fifo" => {
                let c = CString::new(p.as_os_str().as_bytes()).unwrap();
                assert_eq!(
                    unsafe { libc::mkfifo(c.as_ptr(), 0o666) },
                    0,
                    "mkfifo {p:?}"
                );
                Ok(())
            }
            "chmod" => std::fs::set_permissions(
                &p,
                std::fs::Permissions::from_mode(s["mode"].as_u64().unwrap() as u32),
            ),
            other => panic!("unknown fs op {other}"),
        };
        res.unwrap_or_else(|e| panic!("{s}: {e}"));
    }

    fn spawn(&self) -> Server {
        let home = format!("{}/home", self.root);
        Server::spawn(
            &self.world,
            &[
                ("CLAUDIUS_STATE_HOME", &home),
                ("HOME", &home),
                ("TZ", "UTC"),
            ],
        )
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        open_up(Path::new(&self.root));
    }
}

/// A response: status, the two headers the recorder kept, the body.
struct Got {
    status: u16,
    content_type: Option<String>,
    cache: Option<String>,
    body: Vec<u8>,
}

fn request(port: u16, target: &str) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(300))).unwrap();
    write!(
        s,
        "GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a header block");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut body = raw[split + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let mut headers = BTreeMap::new();
    for l in lines {
        let (k, v) = l.split_once(':').unwrap();
        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
    }
    if headers.get("transfer-encoding").map(String::as_str) == Some("chunked") {
        let (mut out, mut at) = (Vec::new(), 0);
        loop {
            let end = at + body[at..].windows(2).position(|w| w == b"\r\n").unwrap();
            let n = usize::from_str_radix(std::str::from_utf8(&body[at..end]).unwrap().trim(), 16)
                .unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&body[end + 2..end + 2 + n]);
            at = end + 2 + n + 2;
        }
        body = out;
    } else if let Some(n) = headers.get("content-length") {
        assert_eq!(body.len(), n.parse::<usize>().unwrap(), "{target}");
    }
    Got {
        status,
        content_type: headers.get("content-type").cloned(),
        cache: headers.get("cache-control").cloned(),
        body,
    }
}

fn describe(got: &Got) -> String {
    let body = if got.body.len() <= 200 {
        format!("{:?}", String::from_utf8_lossy(&got.body))
    } else {
        format!("<{} bytes>", got.body.len())
    };
    format!(
        "{} type={:?} cache={:?} {body}",
        got.status, got.content_type, got.cache
    )
}

/// Compare an answer with a recorded `got`; `Err` describes the difference.
fn check(want: &Value, got: &Got) -> Result<(), String> {
    let ok = if want.get("threw").is_some() {
        // Next's empty 500.
        got.status == 500 && got.body.is_empty() && got.content_type.is_none()
    } else if want.get("decode").is_some() {
        // Next's 400 page: the request goes to Next.
        got.status == 404 && got.body == NO_NEXT.as_bytes()
    } else {
        let body = if want.get("garbage").is_some() {
            // Deliberate difference: an empty file is served empty.
            got.body.is_empty()
        } else if let Some(t) = want["text"].as_str() {
            got.body == t.as_bytes()
        } else if let Some(h) = want["hex"].as_str() {
            hex(&got.body) == h
        } else {
            let sha = format!("{}:{}", hex(&Sha256::digest(&got.body)), got.body.len());
            want["sha"].as_str() == Some(&sha)
        };
        assert!(want.get("headers").is_none(), "{want}");
        body && want["status"] == got.status
            && want["type"].as_str() == got.content_type.as_deref()
            && want["cache"].as_str() == got.cache.as_deref()
    };
    if ok {
        Ok(())
    } else {
        Err(format!("want {want}\n      got {}", describe(got)))
    }
}

fn replay(name: &str) {
    let group = fixture()["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == name)
        .unwrap_or_else(|| panic!("no group {name}"));
    if group["perms"] == true && unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping {name}: permissions aren't enforced for root");
        return;
    }
    unsafe { libc::umask(0o022) };
    let root = Root::new();
    let mut server = None;
    let mut failures = vec![];
    let steps = group["steps"].as_array().unwrap();
    for (i, step) in steps.iter().enumerate() {
        if step["op"] == "fs" {
            root.apply(step);
            continue;
        }
        let port = server.get_or_insert_with(|| root.spawn()).port;
        let url = step["url"].as_str().unwrap();
        if let Err(e) = check(&step["got"], &request(port, url)) {
            failures.push(format!("#{i} {url}: {e}"));
        }
    }
    drop(server);
    assert!(
        failures.is_empty(),
        "{name}: {} of {} steps differ:\n{}",
        failures.len(),
        steps.len(),
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
    assert_eq!(names, ["serve", "perms"]);
}

#[test]
fn serve() {
    replay("serve");
}

#[test]
fn perms() {
    replay("perms");
}

/// What Next doesn't hand the handler as it came goes to Next: its 308s
/// for a `//`, a `\` and a trailing `/`, and the WHATWG-resolved pathname
/// of a dot segment.
#[test]
fn next_answers_what_it_rewrites() {
    let root = Root::new();
    root.apply(
        &serde_json::json!({"act": "write", "path": "ws/index.html", "text": "<p>hi</p>\n"}),
    );
    root.apply(&serde_json::json!({"act": "write", "path": "ws/a/b.html", "text": "<p>b</p>\n"}));
    root.apply(&serde_json::json!({
        "act": "write",
        "path": "home/.claude/.claudius/workspaces.json",
        "text": root.real(r#"{"version": 1, "workspaces": [{"id": "wks_a", "name": "a", "rootPath": "$ROOT/ws"}]}"#),
    }));
    let server = root.spawn();
    let base = "/api/workspaces/wks_a/files/preview";
    let served = request(server.port, &format!("{base}/a/b.html"));
    assert_eq!(
        (served.status, served.body.as_slice()),
        (200, &b"<p>b</p>\n"[..])
    );
    for path in [
        "index.html/",
        "a/",
        "/index.html",
        "a//b.html",
        "a\\b.html",
        "a/../index.html",
        "./index.html",
        "a/./b.html",
        "a/%2e/b.html",
        "a/%2E%2E/index.html",
        "a/.%2e/index.html",
        "..",
        "%2e",
    ] {
        let got = request(server.port, &format!("{base}/{path}"));
        assert_eq!(
            (got.status, String::from_utf8_lossy(&got.body).into_owned()),
            (404, NO_NEXT.to_owned()),
            "{path}"
        );
    }
    let id_dots = request(server.port, "/api/workspaces/%2e/files/preview/index.html");
    assert_eq!(
        (id_dots.status, id_dots.body.as_slice()),
        (404, NO_NEXT.as_bytes())
    );
}
