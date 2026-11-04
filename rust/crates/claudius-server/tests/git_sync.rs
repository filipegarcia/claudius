//! `POST /api/workspaces/:id/git/{merge,rebase,pull-merge,remote}` and `GET
//! …/git/{remote-host,pr-status}` against the real binary, replaying the
//! `steps` of `claudius-core/tests/fixtures/git_sync_golden.json` (recorded
//! by `rust/scripts/git-sync-golden.mjs` from the real TS route handlers on
//! real repos whose remotes are local bare repos).
//!
//! Every repo is rebuilt with the same git commands, files and stores under
//! a temp root, in the same pinned environment (fixed author, committer and
//! per-commit dates, so the hashes match, merge and rebased commits too;
//! `GIT_ALLOW_PROTOCOL=file`, so no git can reach a network). The server's
//! PATH is only `$ROOT/fakebin:$ROOT/sysbin`: the recorder's logging git
//! wrapper (`fakeGit`, with its one-shot markers: canned output, a call
//! killed at its timeout, a call that only the 10 min hook timeout lets
//! finish) and the fake `gh` / `glab` (`fakeGh`, canned JSON, exit codes, a
//! sleep past the 6 s timeout, and its argv and env logged), plus links to
//! `sh` / `cat` / `rm` / `sleep`; so the real `gh` / `glab` (and the user's
//! auth) are never reachable, and removing a fake is a missing CLI. Each
//! request must answer the same status, content type and body text
//! (`threw` is Next's empty 500), with the root shown as `$ROOT`, and run the
//! same git / gh / glab calls, in order, in the same dirs. A `par` step
//! sends its requests at once and compares the calls as a sorted list. After
//! each mutating request, `state` reads the repo back with real git (every
//! ref, HEAD, status, MERGE_HEAD / REBASE_HEAD, branch and remote config) and
//! must match the recording. `wait` holds the replay until 32 s after a
//! marked request, so the pr-status cache entry it made has expired.
//! `nogit` requests go to a second server whose PATH has no git.
//!
//! The fixture records its git version. With another git, git's own words
//! and the repo states that follow from them may differ, so only the status,
//! the body's keys and its `code` / `ok` / `kind` are compared.
#![cfg(unix)]

mod common;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use claudius_agent::js;
use common::{Server, free_port, http, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/git_sync_golden.json");
    js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Where Rust knowingly differs, by request label: the status and body Rust
/// answers (its calls and the state after it are still compared).
const KNOWN: &[(&str, u16, &str)] = &[
    // `\ud800` reaches Rust as U+FFFD (D07: a `String` can't hold a lone
    // surrogate), so the echo is that character where `JSON.stringify`
    // writes the escape. Git sees U+FFFD from both.
    (
        "checkoutBranch lone surrogate: unknown",
        400,
        "{\"ok\":false,\"kind\":\"error\",\"message\":\"unknown branch: \u{fffd}x\"}",
    ),
];

/// The options the routes put on git's command line; anything else starting
/// with `-` came from somewhere else.
const OPTIONS: &[&str] = &[
    "--version",
    "--show-toplevel",
    "--get",
    "--abbrev-ref",
    "--all",
    "--prune",
    "--ff-only",
    "--no-rebase",
    "--no-edit",
    "-u",
    "--name-only",
    "--diff-filter=U",
    "-z",
    // checkoutBranch, before a `checkoutBranch` rebase:
    "--verify",
    "--quiet",
];

/// The `-`-named remote and branch two repos are set up with: as in TS, what
/// git reports reaches `push -u` (and `gh`) as is.
const FROM_THE_REPO: &[&str] = &["-x", "-dash"];

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    env: Vec<(String, String)>,
    state_cmds: Vec<Vec<String>>,
    fake_git: String,
    fake_gh: String,
    sys_tools: Vec<String>,
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
        let strings = |v: &Value| -> Vec<String> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap().to_owned())
                .collect()
        };
        World {
            _dir: dir,
            root,
            env,
            state_cmds: fx["stateCmds"]
                .as_array()
                .unwrap()
                .iter()
                .map(strings)
                .collect(),
            fake_git: fx["fakeGit"].as_str().unwrap().to_owned(),
            fake_gh: fx["fakeGh"].as_str().unwrap().to_owned(),
            sys_tools: strings(&fx["sysTools"]),
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

    fn git(&self, args: &[&str], cwd: &str) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(self.path(cwd))
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .output()
            .unwrap()
    }

    /// The calls the wrappers logged since the last read: `[program, cwd,
    /// ...argv]` (gh / glab add their env).
    fn take_calls(&self) -> Vec<Vec<String>> {
        let log = self.path("fakelog");
        let Ok(bytes) = std::fs::read(&log) else {
            return vec![];
        };
        std::fs::remove_file(&log).unwrap();
        String::from_utf8_lossy(&bytes)
            .split('\u{1e}')
            .filter(|r| !r.is_empty())
            .map(|r| r.split('\u{1f}').map(|a| self.normalize(a)).collect())
            .collect()
    }

    fn write_exec(&self, rel: &str, text: &str) {
        let file = self.path(rel);
        std::fs::write(&file, text).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Runs a setup step; `Some` is what a `state` / `ls` step reads.
    fn run(&self, step: &Value) -> Option<Value> {
        let p = |k: &str| self.path(step[k].as_str().unwrap());
        let which = |tool: &str| {
            let out = Command::new("sh")
                .args(["-c", &format!("command -v {tool}")])
                .output()
                .unwrap();
            js::trim(&String::from_utf8_lossy(&out.stdout)).to_owned()
        };
        match step["op"].as_str().unwrap() {
            "git" => {
                let args: Vec<&str> = step["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap())
                    .collect();
                let mut cmd = Command::new("git");
                cmd.args(&args)
                    .current_dir(p("cwd"))
                    .env_clear()
                    .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
                if let Some(date) = step["date"].as_str() {
                    cmd.env("GIT_AUTHOR_DATE", date)
                        .env("GIT_COMMITTER_DATE", date);
                }
                let out = cmd.output().unwrap();
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
            "big" => {
                let path = p("path");
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                let n = step["n"].as_u64().unwrap() as usize;
                let text = format!(
                    "{}{}{}",
                    step["head"].as_str().unwrap(),
                    "x".repeat(n),
                    step["tail"].as_str().unwrap()
                );
                std::fs::write(path, text).unwrap();
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
            "workspaces" => self.write_workspaces(step),
            "sysbin" => {
                std::fs::create_dir_all(self.path("sysbin")).unwrap();
                for tool in &self.sys_tools {
                    let at = which(tool);
                    assert!(at.starts_with('/'), "no {tool} on PATH");
                    std::os::unix::fs::symlink(at, self.path("sysbin").join(tool)).unwrap();
                }
            }
            "fakes" => {
                let git = which("git");
                std::fs::create_dir_all(self.path("fakebin")).unwrap();
                std::fs::create_dir_all(self.path("fakemarks")).unwrap();
                let root = self.root_str();
                self.write_exec(
                    "fakebin/git",
                    &self
                        .fake_git
                        .replace("@ROOT@", &root)
                        .replace("@GIT@", &git),
                );
                for prog in ["gh", "glab"] {
                    self.write_exec(
                        &format!("fakebin/{prog}"),
                        &self.fake_gh.replace("@ROOT@", &root),
                    );
                }
            }
            "state" => {
                let cwd = step["cwd"].as_str().unwrap();
                let got: Vec<Value> = self
                    .state_cmds
                    .iter()
                    .map(|cmd| {
                        let args: Vec<&str> = cmd.iter().map(String::as_str).collect();
                        let out = self.git(&args, cwd);
                        json!({
                            "code": out.status.code(),
                            "out": self.normalize(&String::from_utf8_lossy(&out.stdout)),
                            "err": self.normalize(&String::from_utf8_lossy(&out.stderr)),
                        })
                    })
                    .collect();
                return Some(Value::Array(got));
            }
            "ls" => {
                let mut names: Vec<String> = std::fs::read_dir(p("path"))
                    .unwrap()
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect();
                names.sort();
                return Some(json!(names));
            }
            op => panic!("unknown op {op}"),
        }
        None
    }

    fn write_workspaces(&self, step: &Value) {
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
                            None => self.path(w["root"].as_str().unwrap()).display().to_string(),
                        };
                        json!({
                            "id": w["id"], "name": w["id"], "rootPath": root,
                            "icon": {"kind": "letter", "letter": "W", "color": "#d97757"},
                            "createdAt": 1_700_000_000_000u64 + i as u64,
                            "updatedAt": 1_700_000_000_000u64 + i as u64,
                        })
                    })
                    .collect();
                serde_json::to_string_pretty(&json!({"version": 1, "workspaces": list})).unwrap()
            }
        };
        let dir = self.path("home/.claude/.claudius");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("workspaces.json"), text).unwrap();
    }
}

fn bytes_of(step: &Value) -> Vec<u8> {
    match step["hex"].as_str() {
        Some(h) => hex(h),
        None => step["text"].as_str().unwrap().as_bytes().to_vec(),
    }
}

fn hex(h: &str) -> Vec<u8> {
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect()
}

/// `(status, content type, body)`.
fn send(port: u16, method: &str, path: &str, body: Option<&[u8]>) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if method == "POST" {
        let len = body.map_or(0, <[u8]>::len);
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {len}\r\n"
        ));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).unwrap();
    if let Some(b) = body {
        s.write_all(b).unwrap();
    }
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

/// A request step's method, URL and body.
fn request_of(step: &Value) -> (String, String, Option<Vec<u8>>) {
    let path = format!(
        "/api/workspaces/{}/git/{}",
        step["id"].as_str().unwrap(),
        step["route"].as_str().unwrap(),
    );
    let body = match (step["bodyHex"].as_str(), step["body"].as_str()) {
        (Some(h), _) => Some(hex(h)),
        (None, Some(b)) => Some(b.as_bytes().to_vec()),
        _ => None,
    };
    (step["method"].as_str().unwrap().to_owned(), path, body)
}

/// A response in the recorder's shape: `{status, type, body}` or `{threw}`.
fn shape(world: &World, (status, content_type, body): (u16, Option<String>, String)) -> Value {
    if status == 500 && body.is_empty() && content_type.is_none() {
        return json!({"threw": true});
    }
    json!({"status": status, "type": content_type, "body": world.normalize(&body)})
}

/// The recorded response in the same shape (a throw's message isn't sent).
fn want_shape(got: &Value) -> Value {
    if got.get("threw").is_some() {
        return json!({"threw": true});
    }
    json!({"status": got["status"], "type": got["type"], "body": got["body"]})
}

/// What is compared under another git: the status, and the body's keys and
/// its `code` / `ok` / `kind`.
fn coarse(v: &Value) -> Value {
    let Some(body) = v["body"].as_str() else {
        return v.clone();
    };
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let keys: Vec<&String> = parsed
        .as_object()
        .map(|o| o.keys().collect())
        .unwrap_or_default();
    json!({
        "status": v["status"], "keys": keys,
        "code": parsed["code"], "ok": parsed["ok"], "kind": parsed["kind"],
    })
}

/// JS `sort` of the joined calls: UTF-16 order.
fn sort_calls(calls: &mut [Vec<String>]) {
    calls.sort_by_key(|c| c.join("\u{1f}").encode_utf16().collect::<Vec<u16>>());
}

/// No request input reaches git as an option: every `-` argument is one the
/// routes add, or the `-`-named remote / branch git itself reported, in the
/// `push -u <remote> <branch>` of the fallback.
fn assert_no_injected_options(call: &[String]) {
    let (prog, args) = (call[0].as_str(), &call[2..]);
    if prog != "git" {
        // gh / glab: `pr view <branch> --json <fields>` / `mr view <branch> -F json`.
        let want: &[&str] = if prog == "gh" {
            &[
                "pr",
                "view",
                "--json",
                "number,state,isDraft,statusCheckRollup,title,url",
            ]
        } else {
            &["mr", "view", "-F", "json"]
        };
        let fixed: Vec<&str> = args
            .iter()
            .enumerate()
            .filter(|(i, a)| *i != 2 && !a.starts_with("env "))
            .map(|(_, a)| a.as_str())
            .collect();
        assert_eq!(fixed, want, "{call:?}");
        assert!(
            !args[2].starts_with('-') || FROM_THE_REPO.contains(&args[2].as_str()),
            "{call:?}"
        );
        return;
    }
    let fallback = args.len() == 4 && args[0] == "push" && args[1] == "-u";
    for (i, a) in args.iter().enumerate() {
        if !a.starts_with('-') || OPTIONS.contains(&a.as_str()) {
            continue;
        }
        assert!(
            fallback && i >= 2 && FROM_THE_REPO.contains(&a.as_str()),
            "an option reached git: {call:?}"
        );
    }
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new(&fx);
    for d in ["servercwd", "emptybin"] {
        std::fs::create_dir_all(world.path(d)).unwrap();
    }
    let git_version = Command::new("git")
        .arg("--version")
        .output()
        .map(|o| js::trim(&String::from_utf8_lossy(&o.stdout)).to_owned())
        .unwrap_or_default();
    let same_git = fx["gitVersion"] == git_version.as_str();
    if !same_git {
        eprintln!(
            "git is {git_version:?}, the fixture {}: only statuses, keys and codes compare",
            fx["gitVersion"]
        );
    }
    let fake_path = format!(
        "{}:{}",
        world.path("fakebin").display(),
        world.path("sysbin").display()
    );
    let server = world.server(&fake_path);
    let nogit = world.server(&world.path("emptybin").display().to_string());

    let steps = fx["steps"].as_array().unwrap();
    let mut failures = vec![];
    let mut loose = 0;
    let mut requests = 0;
    let mut states = 0;
    let mut waited = 0;
    let mut known_seen = 0;
    let mut marks: HashMap<String, Instant> = HashMap::new();
    let mut all_calls: Vec<Vec<String>> = vec![];
    let compare = |what: String, want: &Value, got: &Value, failures: &mut Vec<String>| {
        if want == got {
            return 0;
        }
        if same_git {
            failures.push(format!("{what}:\n  want {want}\n  got  {got}"));
        } else if coarse(want) != coarse(got) {
            failures.push(format!("{what} (coarse):\n  want {want}\n  got  {got}"));
        }
        1
    };
    // Mutation runs: stop at the first difference.
    let fail_fast = std::env::var_os("GIT_SYNC_FAIL_FAST").is_some();
    for (i, s) in steps.iter().enumerate() {
        assert!(
            !fail_fast || failures.is_empty(),
            "first difference:\n{}",
            failures.join("\n")
        );
        match s["op"].as_str().unwrap() {
            "req" => {
                requests += 1;
                let label = s["label"].as_str().unwrap();
                let (method, path, body) = request_of(s);
                let port = if s["nogit"] == true {
                    nogit.port
                } else {
                    server.port
                };
                if let Some(mark) = s["mark"].as_str() {
                    marks.insert(mark.to_owned(), Instant::now());
                }
                let got = shape(&world, send(port, &method, &path, body.as_deref()));
                let calls = world.take_calls();
                all_calls.extend(calls.iter().cloned());
                let what = format!("#{i} {label} ({method} {path})");
                if let Some((_, st, rust_body)) = KNOWN.iter().find(|(l, ..)| *l == label) {
                    known_seen += 1;
                    let want = json!({"status": st, "type": "application/json", "body": rust_body});
                    if got != want {
                        failures.push(format!("{what}: known difference moved: {got}"));
                    }
                } else {
                    loose += compare(what.clone(), &want_shape(&s["got"]), &got, &mut failures);
                }
                let want_calls = &s["got"]["calls"];
                if *want_calls != json!(calls) && same_git {
                    failures.push(format!(
                        "{what} calls:\n  want {want_calls}\n  got  {}",
                        json!(calls)
                    ));
                }
            }
            "par" => {
                let reqs = s["reqs"].as_array().unwrap();
                requests += reqs.len();
                let port = server.port;
                let answers: Vec<_> = std::thread::scope(|scope| {
                    let handles: Vec<_> = reqs
                        .iter()
                        .map(|r| {
                            let (method, path, body) = request_of(r);
                            scope.spawn(move || send(port, &method, &path, body.as_deref()))
                        })
                        .collect();
                    handles.into_iter().map(|h| h.join().unwrap()).collect()
                });
                for (r, answer) in reqs.iter().zip(answers) {
                    let what = format!("#{i} {}", r["label"].as_str().unwrap());
                    let got = shape(&world, answer);
                    loose += compare(what, &want_shape(&r["got"]), &got, &mut failures);
                }
                let mut calls = world.take_calls();
                all_calls.extend(calls.iter().cloned());
                sort_calls(&mut calls);
                if s["calls"] != json!(calls) && same_git {
                    failures.push(format!(
                        "#{i} par calls:\n  want {}\n  got  {}",
                        s["calls"],
                        json!(calls)
                    ));
                }
            }
            "wait" => {
                waited += 1;
                let since = marks[s["since"].as_str().unwrap()];
                let until = since + Duration::from_millis(s["ms"].as_u64().unwrap());
                if let Some(left) = until.checked_duration_since(Instant::now()) {
                    std::thread::sleep(left);
                }
            }
            op => {
                let got = world.run(s);
                if op == "state" {
                    states += 1;
                }
                if let Some(got) = got
                    && got != s["got"]
                {
                    let what = format!(
                        "#{i} {op} {}",
                        s["cwd"].as_str().or(s["path"].as_str()).unwrap()
                    );
                    if same_git || op == "ls" {
                        failures.push(format!("{what}:\n  want {}\n  got  {got}", s["got"]));
                    } else {
                        loose += 1;
                    }
                }
            }
        }
    }
    if !same_git {
        eprintln!("{loose} answers or states differ in git's own words (not compared)");
    }
    assert!(
        failures.is_empty(),
        "{} differences in {requests} requests:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(
        requests >= 310 && states >= 85 && waited == 1,
        "{requests} {states} {waited}"
    );
    assert_eq!(known_seen, KNOWN.len());

    for call in &all_calls {
        assert_no_injected_options(call);
    }
    let progs = |p: &str| all_calls.iter().filter(|c| c[0] == p).count();
    assert!(
        progs("git") > 550 && progs("gh") >= 20 && progs("glab") >= 4,
        "{all_calls:?}"
    );

    // Only the TS methods; the rest is axum's 405, as Next answers it.
    for (route, allowed) in [
        ("merge", "POST"),
        ("rebase", "POST"),
        ("pull-merge", "POST"),
        ("remote", "POST"),
        ("remote-host", "GET"),
        ("pr-status", "GET"),
    ] {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            if method == allowed {
                continue;
            }
            let (st, _) = http(
                server.port,
                method,
                &format!("/api/workspaces/wks_rm/git/{route}"),
                "{}",
            );
            assert_eq!(st, 405, "{method} {route}");
        }
    }
    drop((server, nogit));
}
