//! `GET /api/workspaces/:id/git/{status,diff,show}` against the real
//! binary, replaying the `steps` of
//! `claudius-core/tests/fixtures/git_golden.json` (recorded by
//! `rust/scripts/git-golden.mjs` from the real TS route handlers on real
//! repos): every repo is rebuilt with the same git commands, files and
//! stores under a temp root, in the same pinned environment (fixed author,
//! committer and date, so the hashes match), and every request must answer
//! the same status, content type and body text (`threw` is Next's empty
//! 500), with the root shown as `$ROOT`. Bodies over 200 000 units compare
//! by UTF-8 length, FNV-1a 64 and head; a body cut by the 16 MiB stream
//! limit compares by its head and must be past the limit. `nogit` requests
//! go to a second server whose PATH has no git.
//!
//! The fixture records its git version. With another git, messages git
//! itself wrote (500 `git-failed` bodies) only compare by status and code.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use claudius_agent::js;
use common::{Server, free_port, http, wait_until};
use serde_json::{Value, json};

const MAX_BUFFER: usize = 16 * 1024 * 1024;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/git_golden.json");
    js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Where Rust knowingly differs, by request label: the body Rust answers
/// (`None`: Next's empty 500).
const KNOWN: &[(&str, u16, Option<&str>)] = &[
    // A ref starting with `-` never reaches git as an option.
    (
        "--output ref writes a file (refused in Rust)",
        500,
        Some(
            r#"{"error":"git show exited 128: fatal: unrecognized argument: --output=$ROOT/pwned:a.txt","code":"git-failed"}"#,
        ),
    ),
    (
        "--format ref shows HEAD (refused in Rust)",
        500,
        Some(
            r#"{"error":"git show exited 128: fatal: unrecognized argument: --format=%s:a.txt","code":"git-failed"}"#,
        ),
    ),
];

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    env: Vec<(String, String)>,
}

impl World {
    fn new(fx: &Value) -> World {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let r = root.display().to_string();
        let mut env: Vec<(String, String)> = fx["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().replace("$ROOT", &r)))
            .collect();
        env.push(("PATH".into(), std::env::var("PATH").unwrap()));
        World {
            _dir: dir,
            root,
            env,
        }
    }
    fn path(&self, p: &str) -> PathBuf {
        if p.is_empty() {
            self.root.clone()
        } else {
            self.root.join(p)
        }
    }
    fn root_str(&self) -> String {
        self.root.display().to_string()
    }
    /// `$ROOT` (and `$ROOT_REL`, without its leading slash) for the root.
    fn normalize(&self, text: &str) -> String {
        let r = self.root_str();
        text.replace(&r, "$ROOT").replace(&r[1..], "$ROOT_REL")
    }

    fn server(&self, path_var: &str) -> Server {
        let port = free_port();
        let child = Command::new(env!("CARGO_BIN_EXE_claudius"))
            .args(["--port", &port.to_string(), "--no-next"])
            .current_dir(self.path("servercwd"))
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .env("PATH", path_var)
            .env("CLAUDIUS_STATE_HOME", self.path("home"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let server = Server { child, port };
        wait_until("health", Duration::from_secs(20), || {
            TcpStream::connect(("127.0.0.1", port)).is_ok()
                && http(port, "GET", "/api/rust/health", "").0 == 200
        });
        server
    }

    fn run(&self, step: &Value) -> Option<bool> {
        let p = |k: &str| self.path(step[k].as_str().unwrap());
        match step["op"].as_str().unwrap() {
            "git" => {
                let args: Vec<&str> = step["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap())
                    .collect();
                let out = Command::new("git")
                    .args(&args)
                    .current_dir(p("cwd"))
                    .env_clear()
                    .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
                    .output()
                    .unwrap();
                assert_eq!(
                    !out.status.success(),
                    step["fails"] == true,
                    "git {args:?}: {}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            "mkdir" => std::fs::create_dir_all(p("path")).unwrap(),
            "write" => {
                let path = p("path");
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, bytes_of(step)).unwrap();
            }
            "gen" => {
                let path = p("path");
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, generate(step)).unwrap();
            }
            "rm" => {
                let path = p("path");
                if path.is_dir() && !path.is_symlink() {
                    std::fs::remove_dir_all(path).unwrap();
                } else {
                    let _ = std::fs::remove_file(path);
                }
            }
            "symlink" => {
                std::os::unix::fs::symlink(step["target"].as_str().unwrap(), p("path")).unwrap()
            }
            "chmod" => {
                let mode = u32::from_str_radix(step["mode"].as_str().unwrap(), 8).unwrap();
                std::fs::set_permissions(p("path"), std::fs::Permissions::from_mode(mode)).unwrap();
            }
            "exists" => return Some(p("path").exists()),
            "workspaces" => {
                let text = match step["text"].as_str() {
                    Some(t) => t.to_owned(),
                    None => {
                        let list: Vec<Value> = step["list"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .enumerate()
                            .map(|(i, w)| {
                                let root = match w["raw"].as_str() {
                                    Some(raw) => raw.to_owned(),
                                    None => {
                                        self.path(w["root"].as_str().unwrap()).display().to_string()
                                    }
                                };
                                json!({
                                    "id": w["id"], "name": w["id"], "rootPath": root,
                                    "icon": {"kind": "letter", "letter": "W", "color": "#d97757"},
                                    "createdAt": 1_700_000_000_000u64 + i as u64,
                                    "updatedAt": 1_700_000_000_000u64 + i as u64,
                                })
                            })
                            .collect();
                        serde_json::to_string_pretty(&json!({"version": 1, "workspaces": list}))
                            .unwrap()
                    }
                };
                let dir = self.path("home/.claude/.claudius");
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join("workspaces.json"), text).unwrap();
            }
            "custIndex" => {
                let file = self.path("home/.claude/.claudius/customizations/index.json");
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                if step["text"].is_null() && step["hex"].is_null() {
                    let _ = std::fs::remove_file(file);
                } else {
                    std::fs::write(file, bytes_of(step)).unwrap();
                }
            }
            op => panic!("unknown op {op}"),
        }
        None
    }
}

fn bytes_of(step: &Value) -> Vec<u8> {
    match step["hex"].as_str() {
        Some(h) => (0..h.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
            .collect(),
        None => step["text"].as_str().unwrap().as_bytes().to_vec(),
    }
}

/// The recorder's generators: `lines` and xorshift32 `bytes`.
fn generate(step: &Value) -> Vec<u8> {
    let n = step["n"].as_u64().unwrap() as usize;
    if step["kind"] == "lines" {
        let tag = step["tag"].as_str().unwrap();
        let unit = "abcdefghij".repeat(6);
        let mut s = String::new();
        for i in 0..n {
            s.push_str(&format!("{tag} {i} {unit}\n"));
        }
        return s.into_bytes();
    }
    let mut x = step["seed"].as_u64().unwrap() as u32;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

fn fnv1a64(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// `(status, content type, body)`.
fn get(port: u16, path: &str) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = vec![];
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

fn signal_normalized(head: &str) -> String {
    ["SIGPIPE", "SIGTERM"].iter().fold(head.to_owned(), |h, s| {
        h.replacen(&format!(" killed by {s}"), " killed by $SIGNAL", 1)
    })
}

/// A 500 `git-failed` whose message is git's own text.
fn is_git_message(body: &str) -> bool {
    serde_json::from_str::<Value>(body).is_ok_and(|v| {
        v["code"] == "git-failed" && v["error"].as_str().is_some_and(|m| m.starts_with("git "))
    })
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new(&fx);
    // Both servers run in the server cwd the recorder ran its requests in.
    std::fs::create_dir_all(world.path("servercwd")).unwrap();
    std::fs::create_dir_all(world.path("emptybin")).unwrap();
    let git_version = Command::new("git")
        .arg("--version")
        .output()
        .map(|o| js::trim(&String::from_utf8_lossy(&o.stdout)).to_owned())
        .unwrap_or_default();
    let same_git = fx["gitVersion"] == git_version.as_str();
    if !same_git {
        eprintln!(
            "git is {git_version:?}, the fixture {}: git's own messages compare by code only",
            fx["gitVersion"]
        );
    }
    let server = world.server(&std::env::var("PATH").unwrap());
    let nogit = world.server(&world.path("emptybin").display().to_string());

    let steps = fx["steps"].as_array().unwrap();
    let mut failures = vec![];
    let mut requests = 0;
    let mut known_seen = 0;
    for (i, s) in steps.iter().enumerate() {
        if s["op"] != "req" {
            if let Some(exists) = world.run(s) {
                // The `--output` ref's file: TS wrote it, Rust never runs it.
                let want = if s["path"] == "pwned:a.txt" {
                    false
                } else {
                    s["got"] == true
                };
                if exists != want {
                    failures.push(format!("#{i} exists {}: {exists}", s["path"]));
                }
            }
            continue;
        }
        requests += 1;
        let label = s["label"].as_str().unwrap();
        let query = s["query"]
            .as_str()
            .unwrap()
            .replace("$ROOT", &world.root_str());
        let path = format!(
            "/api/workspaces/{}/git/{}{}",
            s["id"].as_str().unwrap(),
            s["route"].as_str().unwrap(),
            if query.is_empty() {
                String::new()
            } else {
                format!("?{query}")
            }
        );
        let port = if s["nogit"] == true {
            nogit.port
        } else {
            server.port
        };
        let (status, content_type, body) = get(port, &path);
        let body = world.normalize(&body);
        let want = &s["got"];
        let threw = status == 500 && body.is_empty() && content_type.is_none();
        let fail = |what: String| format!("#{i} {label} ({path}): {what}");

        if let Some((_, st, rust_body)) = KNOWN.iter().find(|(l, ..)| *l == label) {
            known_seen += 1;
            let ok = match rust_body {
                None => threw,
                Some(b) => status == *st && body == *b,
            };
            if !ok {
                failures.push(fail(format!("known difference moved: {status} {body}")));
            }
            continue;
        }
        if want.get("threw").is_some() {
            if !threw {
                failures.push(fail(format!("want Next's empty 500, got {status} {body}")));
            }
            continue;
        }
        let head_of = |b: &str| -> String {
            let units: Vec<u16> = b.encode_utf16().take(300).collect();
            String::from_utf16_lossy(&units)
        };
        let got = if want["cut"] == true {
            let len = body.len();
            if !(MAX_BUFFER..MAX_BUFFER + (1 << 20)).contains(&len) {
                failures.push(fail(format!("cut body is {len} bytes")));
            }
            let code = serde_json::from_str::<Value>(&body).map(|v| v["code"].clone());
            if code.as_ref().ok() != Some(&json!("git-failed")) {
                failures.push(fail(format!("cut body code {code:?}")));
            }
            json!({"status": status, "type": content_type, "head": signal_normalized(&head_of(&body)), "cut": true})
        } else if want.get("len").is_some() {
            json!({"status": status, "type": content_type, "len": body.len(), "fnv": fnv1a64(body.as_bytes()), "head": head_of(&body)})
        } else {
            json!({"status": status, "type": content_type, "body": body})
        };
        let mut want = want.clone();
        if !same_git
            && let Some(b) = want["body"].as_str()
            && is_git_message(b)
            && is_git_message(&body)
        {
            want["body"] = json!(body);
        }
        if got != want {
            failures.push(fail(format!("\n  want {want}\n  got  {got}")));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {requests} requests differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(requests >= 230, "{requests}");
    assert_eq!(known_seen, KNOWN.len());

    // GET only, like the TS route modules.
    for route in ["status", "diff", "show"] {
        for method in ["POST", "PUT", "PATCH", "DELETE"] {
            let (st, _) = http(
                server.port,
                method,
                &format!("/api/workspaces/wks_basic/git/{route}"),
                "{}",
            );
            assert_eq!(st, 405, "{method} {route}");
        }
    }
    drop((server, nogit));
}

/// The `--output` ref never reaches git: no file appears anywhere under the
/// repo or the root, whatever the ref names.
#[test]
fn dash_refs_never_reach_git() {
    let fx = fixture();
    let world = World::new(&fx);
    for d in ["servercwd", "home", "emptybin"] {
        std::fs::create_dir_all(world.path(d)).unwrap();
    }
    let repo = world.path("r");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env_clear()
                .envs(world.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
                .status()
                .unwrap()
                .success()
        )
    };
    git(&["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&["add", "a.txt"]);
    git(&["commit", "-qm", "a"]);
    world.run(&json!({"op": "workspaces", "list": [{"id": "wks_r", "root": "r"}]}));
    let server = world.server(&std::env::var("PATH").unwrap());
    let target = world.path("pwned");
    for r in [
        format!("--output={}", target.display()),
        "--output=pwned".to_owned(),
        "-o".to_owned(),
        "--textconv".to_owned(),
        // One dash, and an option git takes: TS gets a 200 (pickaxe).
        "-Sx".to_owned(),
    ] {
        let q = format!(
            "path=a.txt&ref={}",
            r.replace('/', "%2F").replace('=', "%3D")
        );
        let (st, _, body) = get(server.port, &format!("/api/workspaces/wks_r/git/show?{q}"));
        assert_eq!(st, 500, "{r}: {body}");
        assert!(body.contains("unrecognized argument"), "{r}: {body}");
    }
    assert!(!Path::new(&format!("{}:a.txt", target.display())).exists());
    assert!(!repo.join("pwned:a.txt").exists());
    assert!(!world.path("servercwd/pwned:a.txt").exists());
    // A plain ref still reads the blob.
    let (st, _, body) = get(
        server.port,
        "/api/workspaces/wks_r/git/show?path=a.txt&ref=HEAD",
    );
    assert_eq!((st, body.as_str()), (200, r#"{"content":"a\n"}"#));
}
