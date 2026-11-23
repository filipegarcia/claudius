//! `GET /api/worktrees` and `POST /api/sessions/fork` against the real
//! binary, replaying the `steps` of
//! `claudius-core/tests/fixtures/worktrees_fork_golden.json` (recorded by
//! `rust/scripts/worktrees-fork-golden.mjs` from the real TS route handlers,
//! the SDK's `forkSession` and real git): the same repos, worktrees, stores
//! and transcripts are rebuilt under a temp root in the same pinned
//! environment (fixed author, committer and date, so the hashes match), the
//! server runs in `$ROOT/servercwd`, and every request must answer the same
//! status, content type and body text (`threw` is Next's empty 500), every
//! fork's new transcript must read the same, and every `state` snapshot (the
//! fork index, the fork-worktrees dir, the project dirs, the repos' branches)
//! must match.
//!
//! As in the recorder, the root shows as `$ROOT` (`$ENCROOT` in project dir
//! names), the k-th fork id as `$FORKk` and its slug as `$SLUGk`; in a
//! fork's transcript, uuids and ISO times its source doesn't hold are
//! `$U<n>` / `$NOW`. The fixture records its git version: with another git,
//! the `gitText` request's body (git's own wording) isn't compared.
#![cfg(unix)]

mod common;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use claudius_agent::js;
use common::{Server, free_port, http, wait_until};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/worktrees_fork_golden.json");
    js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The recorder's `encode`: `/[^a-zA-Z0-9]/g` → `-`, per UTF-16 unit.
fn encode(p: &str) -> String {
    p.chars()
        .flat_map(|c| {
            let n = if c.is_ascii_alphanumeric() {
                1
            } else {
                c.len_utf16()
            };
            std::iter::repeat_n(if c.is_ascii_alphanumeric() { c } else { '-' }, n)
        })
        .collect()
}

/// Each non-overlapping `len`-byte run `is_match` accepts, leftmost first
/// (a global regex replace), through `with`.
fn replace_runs(
    text: &str,
    len: usize,
    is_match: impl Fn(&[u8]) -> bool,
    mut with: impl FnMut(&str) -> String,
) -> String {
    let b = text.as_bytes();
    let (mut out, mut copied, mut i) = (String::new(), 0, 0);
    while i + len <= b.len() {
        if is_match(&b[i..i + len]) {
            out.push_str(&text[copied..i]);
            out.push_str(&with(&text[i..i + len]));
            i += len;
            copied = i;
        } else {
            i += 1;
        }
    }
    out + &text[copied..]
}

/// `/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/`
fn is_uuid(s: &[u8]) -> bool {
    s.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
    })
}

/// `/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/`
fn is_iso(s: &[u8]) -> bool {
    s.iter().zip(b"dddd-dd-ddTdd:dd:dd.dddZ").all(|(c, p)| {
        if *p == b'd' {
            c.is_ascii_digit()
        } else {
            c == p
        }
    })
}

struct Replay {
    _dir: tempfile::TempDir,
    root: String,
    env: Vec<(String, String)>,
    fork_root: String,
    /// Fork ids in the order their responses named them.
    forks: Vec<String>,
    /// Session id → its transcript template.
    sources: HashMap<String, String>,
    server: Option<Server>,
    same_git: bool,
}

impl Replay {
    fn new(fx: &Value) -> Replay {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        let mut env: Vec<(String, String)> = fx["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().replace("$ROOT", &root)))
            .collect();
        env.push(("PATH".into(), std::env::var("PATH").unwrap()));
        let version = Command::new("git").arg("--version").output().unwrap();
        let same_git = String::from_utf8_lossy(&version.stdout).trim()
            == fx["recordedWith"]["git"].as_str().unwrap();
        if !same_git {
            eprintln!(
                "git differs from the recording's {}: its wording isn't compared",
                fx["recordedWith"]["git"]
            );
        }
        Replay {
            fork_root: format!("{root}/home/.claude/.claudius/fork-worktrees"),
            _dir: dir,
            root,
            env,
            forks: Vec::new(),
            sources: HashMap::new(),
            server: None,
            same_git,
        }
    }

    fn abs(&self, p: &str) -> String {
        if p.is_empty() {
            self.root.clone()
        } else {
            format!("{}/{p}", self.root)
        }
    }

    fn git(&self, cwd: &str, args: &[&str]) -> Output {
        Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .output()
            .unwrap()
    }

    fn git_lines(&self, cwd: &str, args: &[&str]) -> Vec<String> {
        String::from_utf8_lossy(&self.git(cwd, args).stdout)
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect()
    }

    /// The recorder's `expand`: placeholders in a request.
    fn expand(&self, text: &str) -> String {
        let mut t = text.replace("$ROOT", &self.root);
        for (k, id) in self.forks.iter().enumerate().rev() {
            t = t
                .replace(&format!("$FORK{}", k + 1), id)
                .replace(&format!("$SLUG{}", k + 1), &id[..8]);
        }
        t
    }

    /// The recorder's `norm`: placeholders in what came back.
    fn norm(&self, text: &str) -> String {
        let mut t = text
            .replace(&self.root, "$ROOT")
            .replace(&encode(&self.root), "$ENCROOT");
        for (i, id) in self.forks.iter().enumerate() {
            t = t.replace(id, &format!("$FORK{}", i + 1));
        }
        for (i, id) in self.forks.iter().enumerate() {
            t = t.replace(&id[..8], &format!("$SLUG{}", i + 1));
        }
        t
    }

    /// The recorder's `normForked`.
    fn norm_forked(&self, text: &str, source: &str) -> String {
        let mut seen: Vec<String> = Vec::new();
        let t = replace_runs(&self.norm(text), 36, is_uuid, |u| {
            if source.contains(u) {
                return u.to_owned();
            }
            let n = match seen.iter().position(|s| s == u) {
                Some(n) => n,
                None => {
                    seen.push(u.to_owned());
                    seen.len() - 1
                }
            };
            format!("$U{}", n + 1)
        });
        replace_runs(&t, 24, is_iso, |iso| {
            if source.contains(iso) {
                iso.to_owned()
            } else {
                "$NOW".into()
            }
        })
    }

    fn exec(&mut self, step: &Value) {
        let s = |k: &str| step[k].as_str().unwrap();
        match s("op") {
            "git" => {
                let args: Vec<&str> = step["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap())
                    .collect();
                let out = self.git(&self.abs(s("cwd")), &args);
                assert_eq!(
                    !out.status.success(),
                    step["fails"] == true,
                    "git {args:?}: {}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            "write" => {
                let path = self.abs(s("path"));
                std::fs::create_dir_all(Path::new(&path).parent().unwrap()).unwrap();
                std::fs::write(path, s("text").replace("$ROOT", &self.root)).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(self.abs(s("path"))).unwrap(),
            "rm" => {
                let path = PathBuf::from(self.abs(s("path")));
                if path.is_dir() && !path.is_symlink() {
                    std::fs::remove_dir_all(path).unwrap();
                } else {
                    let _ = std::fs::remove_file(path);
                }
            }
            "symlink" => std::os::unix::fs::symlink(
                s("target").replace("$ROOT", &self.root),
                self.abs(s("path")),
            )
            .unwrap(),
            "transcript" => {
                let dir = format!(
                    "{}/config/projects/{}",
                    self.root,
                    encode(&self.abs(s("cwd")))
                );
                std::fs::create_dir_all(&dir).unwrap();
                let file = format!("{dir}/{}.jsonl", s("id"));
                std::fs::write(file, s("text").replace("$ROOT", &self.root)).unwrap();
                self.sources
                    .insert(s("id").to_owned(), s("text").to_owned());
            }
            "cleanForks" => {
                let repo = self.abs(s("repo"));
                let prefix = format!("{}/", self.fork_root);
                for line in self.git_lines(&repo, &["worktree", "list", "--porcelain"]) {
                    if let Some(path) = line.strip_prefix("worktree ")
                        && path.starts_with(&prefix)
                    {
                        self.git(&repo, &["worktree", "remove", "--force", path]);
                    }
                }
                self.git(&repo, &["worktree", "prune"]);
                let refs = [
                    "for-each-ref",
                    "--format=%(refname:short)",
                    "refs/heads/claudius/",
                ];
                for branch in self.git_lines(&repo, &refs) {
                    self.git(&repo, &["branch", "-D", &branch]);
                }
            }
            other => panic!("unknown op {other}"),
        }
    }

    /// The recorder's `state`.
    fn state(&self, step: &Value) -> Value {
        let index = format!("{}/index.json", self.fork_root);
        let index_text = if !Path::new(&index).exists() {
            Value::Null
        } else if std::fs::symlink_metadata(&index).unwrap().is_dir() {
            json!("<dir>")
        } else {
            json!(self.norm(&String::from_utf8_lossy(&std::fs::read(&index).unwrap())))
        };
        let root_is_dir = Path::new(&self.fork_root).exists()
            && std::fs::symlink_metadata(&self.fork_root).unwrap().is_dir();
        let entries = if root_is_dir {
            let mut names: Vec<String> = std::fs::read_dir(&self.fork_root)
                .unwrap()
                .map(|e| {
                    let e = e.unwrap();
                    let slash = if e.file_type().unwrap().is_dir() {
                        "/"
                    } else {
                        ""
                    };
                    format!("{}{slash}", self.norm(&e.file_name().to_string_lossy()))
                })
                .collect();
            js_sort(&mut names);
            json!(names)
        } else {
            Value::Null
        };
        let pdir = format!("{}/config/projects", self.root);
        let mut projects = Map::new();
        for d in sorted_names(&pdir) {
            let mut files: Vec<String> = sorted_names(&format!("{pdir}/{d}"))
                .iter()
                .map(|f| self.norm(f))
                .collect();
            js_sort(&mut files);
            projects.insert(self.norm(&d), json!(files));
        }
        let mut refs = Map::new();
        for r in step["repos"].as_array().unwrap() {
            let r = r.as_str().unwrap();
            let mut names: Vec<String> = self
                .git_lines(
                    &self.abs(r),
                    &["for-each-ref", "--format=%(refname)", "refs/heads"],
                )
                .iter()
                .map(|l| self.norm(l))
                .collect();
            js_sort(&mut names);
            refs.insert(r.to_owned(), json!(names));
        }
        json!({"index": index_text, "forkRoot": entries, "projects": projects, "refs": refs})
    }

    fn server(&mut self) -> u16 {
        if self.server.is_none() {
            let port = free_port();
            let child = Command::new(common::server_bin())
                .args(["--port", &port.to_string(), "--no-next"])
                .current_dir(self.abs("servercwd"))
                .env_clear()
                .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
                .env("CLAUDIUS_STATE_HOME", self.abs("home"))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            self.server = Some(Server { child, port });
            wait_until("health", Duration::from_secs(20), || {
                TcpStream::connect(("127.0.0.1", port)).is_ok()
                    && http(port, "GET", "/api/rust/health", "").0 == 200
            });
        }
        self.server.as_ref().unwrap().port
    }

    /// One `req` step: `Err` says how it differs from the recording.
    fn request(&mut self, step: &Value) -> Result<(), String> {
        let port = self.server();
        let method = step["method"].as_str().unwrap();
        let url = self.expand(step["url"].as_str().unwrap());
        let body = step["body"].as_str().map(|b| self.expand(b));
        let (status, content_type, text) = send(port, method, &url, body.as_deref());
        let got = &step["got"];
        if got["threw"] == true {
            return match (status, &content_type, text.as_str()) {
                (500, None, "") => Ok(()),
                _ => Err(format!(
                    "want Next's empty 500, got {status} {content_type:?} {text}"
                )),
            };
        }
        let mut forked = None;
        if method == "POST" && status == 200 {
            let id = js::json_parse(&text).unwrap()["sessionId"]
                .as_str()
                .unwrap()
                .to_owned();
            self.forks.push(id.clone());
            let sid = js::json_parse(body.as_deref().unwrap()).unwrap()["sessionId"]
                .as_str()
                .unwrap()
                .to_owned();
            let pdir = format!("{}/config/projects", self.root);
            let dir = sorted_names(&pdir)
                .into_iter()
                .find(|d| Path::new(&format!("{pdir}/{d}/{id}.jsonl")).exists())
                .ok_or_else(|| format!("no transcript for fork {id}"))?;
            let written = std::fs::read_to_string(format!("{pdir}/{dir}/{id}.jsonl")).unwrap();
            forked = Some(self.norm_forked(&written, &self.sources[&sid]));
        }
        let mut diffs = Vec::new();
        if Some(u64::from(status)) != got["status"].as_u64() {
            diffs.push(format!("status {status}, want {}", got["status"]));
        }
        if content_type.as_deref() != got["type"].as_str() {
            diffs.push(format!("type {content_type:?}, want {}", got["type"]));
        }
        let body = self.norm(&text);
        if body != got["body"].as_str().unwrap() && (self.same_git || step["gitText"] != true) {
            diffs.push(format!(
                "body\n  got  {body}\n  want {}",
                got["body"].as_str().unwrap()
            ));
        }
        if forked.as_deref() != step["forked"].as_str() {
            diffs.push(format!(
                "forked\n  got  {}\n  want {}",
                forked.unwrap_or_default(),
                step["forked"].as_str().unwrap_or("(none)")
            ));
        }
        if diffs.is_empty() {
            Ok(())
        } else {
            Err(diffs.join("\n"))
        }
    }
}

/// `readdirSync(dir).sort()`.
fn sorted_names(dir: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    js_sort(&mut names);
    names
}

/// `Array.prototype.sort()` on strings: by UTF-16 code units.
fn js_sort(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `(status, content type, body)`; `body: None` sends none.
fn send(port: u16, method: &str, path: &str, body: Option<&str>) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
    if let Some(b) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        ));
    }
    write!(s, "{head}\r\n{}", body.unwrap_or("")).unwrap();
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

#[test]
fn worktrees_and_forks_answer_as_the_ts_did() {
    let fx = fixture();
    let mut replay = Replay::new(&fx);
    let mut failures = Vec::new();
    let (mut requests, mut states) = (0, 0);
    for step in fx["steps"].as_array().unwrap() {
        match step["op"].as_str().unwrap() {
            "req" => {
                requests += 1;
                if let Err(why) = replay.request(step) {
                    failures.push(format!("[{}] {why}", step["label"].as_str().unwrap()));
                }
            }
            "state" => {
                states += 1;
                let got = replay.state(step);
                if got != step["state"] {
                    failures.push(format!(
                        "state #{states}\n  got  {got}\n  want {}",
                        step["state"]
                    ));
                }
            }
            _ => replay.exec(step),
        }
    }
    assert!(
        requests > 90 && states > 10,
        "{requests} requests, {states} states"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
