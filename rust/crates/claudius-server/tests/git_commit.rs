//! `POST /api/workspaces/:id/git/{stage,commit,commit-message}` and `GET /
//! POST / DELETE …/git/commit-draft` against the real binary, replaying the
//! `steps` of `tests/fixtures/git_commit_golden.json` (recorded by
//! `rust/scripts/git-commit-golden.mjs` from the real TS route handlers, on
//! real repos, the real `db.ts`, and the real SDK `query()` against the
//! fake CLI).
//!
//! Every repo is rebuilt with the same git commands, files, stores and
//! databases under a temp root, in the same pinned environment (fixed
//! author, committer and date, so the hashes match). The server's PATH is
//! only `$ROOT/fakebin:$ROOT/sysbin`: the recorder's logging git wrapper,
//! plus links to `sh` / `cat` / `rm` / `sleep` for it and the hooks. It runs
//! with `--claude-bin` at `claudius-fake-claude`, whose script, argv, env
//! and stdin files are the recorder's fixed paths. Each request must answer
//! the same status, content type and body text (`threw` is Next's empty
//! 500), with the root shown as `$ROOT`, and run the same git calls, in
//! order, in the same dirs. A `commit-message` request must also hand the
//! CLI the same argv and stdin lines (the `initialize` request and the
//! prompt; strings past 2000 units by length, FNV-1a and ends) and the same
//! variables the SDK sets (its own version as `$SDK_VERSION`). `state` reads a repo back with real git, `ls` a
//! dir, and `dbs` every project dir with its `commit_drafts` rows (bytes in
//! hex, types by `typeof`); each must match the recording. `nogit` requests
//! go to a second server whose PATH has no git.
//!
//! With another git, only the status, the body's keys and its `code` / `ok`
//! are compared, and states aren't; so too for a step recorded on another
//! OS (`os`: unlink(2) on a directory is EPERM on macOS, EISDIR on Linux).
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::paths::encode_project_dir;
use common::{Server, fake_bin, free_port, http, wait_until};
use rusqlite::types::ValueRef;
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/git_commit_golden.json");
    js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The options the routes put on git's command line; anything else starting
/// with `-` came from a request.
const OPTIONS: &[&str] = &[
    "--version",
    "--show-toplevel",
    "--short",
    "--porcelain=v1",
    "-b",
    "-uall",
    "-z",
    "-A",
    "--",
    "--staged",
    "-fd",
    "-f",
    "-F",
    "-",
    "--cleanup=strip",
    "-1",
    "--pretty=%H%n%s",
    "--no-color",
    "--no-textconv",
    "--no-index",
];

/// Keys the SDK host adds to the CLI env that the Rust host doesn't (as in
/// `tests/models.rs`).
const ENV_DIFFERENCES: &[(&str, &str)] = &[(
    "NoDefaultCurrentDirectoryInExePath",
    "sdk.mjs sets it on its own `process.env` when it loads (only Windows reads it), \
     so every CLI spawned with an inherited env gets it",
)];

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    enc_root: String,
    env: Vec<(String, String)>,
    state_cmds: Vec<Vec<String>>,
    fake_git: String,
    sys_tools: Vec<String>,
}

impl World {
    fn new(fx: &Value) -> World {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let r = root.display().to_string();
        let env: Vec<(String, String)> = fx["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().replace("$ROOT", &r)))
            .collect();
        let strings = |v: &Value| -> Vec<String> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap().to_owned())
                .collect()
        };
        World {
            _dir: dir,
            enc_root: encode_project_dir(&r),
            root,
            env,
            state_cmds: fx["stateCmds"]
                .as_array()
                .unwrap()
                .iter()
                .map(strings)
                .collect(),
            fake_git: fx["fakeGit"].as_str().unwrap().to_owned(),
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
    /// `$ROOT`, `$ROOT_REL` (without its leading slash) and `$ENCROOT` (its
    /// project-dir name).
    fn normalize(&self, text: &str) -> String {
        let r = self.root_str();
        text.replace(&r, "$ROOT")
            .replace(&r[1..], "$ROOT_REL")
            .replace(&self.enc_root, "$ENCROOT")
    }
    fn norm(&self, v: Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.normalize(&s)),
            Value::Array(a) => Value::Array(a.into_iter().map(|v| self.norm(v)).collect()),
            Value::Object(o) => {
                Value::Object(o.into_iter().map(|(k, v)| (k, self.norm(v))).collect())
            }
            v => v,
        }
    }
    fn projects(&self) -> PathBuf {
        self.path("home/.claude/projects")
    }
    /// The `.claudius.db` of the workspace rooted at `root`.
    fn db_file(&self, root: &str) -> PathBuf {
        let abs = self.path(root).display().to_string();
        self.projects()
            .join(encode_project_dir(&abs))
            .join(".claudius.db")
    }

    /// The server's environment, PATH aside.
    fn server_env(&self) -> Vec<(String, String)> {
        let mut env = self.env.clone();
        env.push((
            "CLAUDIUS_STATE_HOME".into(),
            self.path("home").display().to_string(),
        ));
        env
    }

    fn server(&self, path_var: &str, fake: &std::path::Path) -> Server {
        let port = free_port();
        let child = Command::new(env!("CARGO_BIN_EXE_claudius"))
            .args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
            .arg(fake)
            .current_dir(self.path("servercwd"))
            .env_clear()
            .envs(self.server_env())
            .env("PATH", path_var)
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
            .env("PATH", std::env::var("PATH").unwrap())
            .output()
            .unwrap()
    }

    /// The calls the wrapper logged since the last read: `[program, cwd,
    /// ...argv]`.
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

    /// What the fake CLI saw on its last run, as the recorder reads it, and
    /// clears it.
    fn take_cli(&self, server_env: &BTreeMap<String, String>) -> Value {
        let file = |name: &str| self.path(&format!("fakeclaude/{name}"));
        let read_json = |name: &str| {
            std::fs::read_to_string(file(name))
                .ok()
                .and_then(|s| js::json_parse(&s).ok())
                .unwrap_or(Value::Null)
        };
        let argv = read_json("argv.json");
        let cli_env = read_json("env.json");
        let stdin = std::fs::read_to_string(file("stdin.log")).ok().map(|text| {
            let mut ids: Vec<String> = vec![];
            let lines: Vec<Value> = text
                .split('\n')
                .filter(|l| !l.is_empty())
                .map(|l| {
                    let mut m = js::json_parse(l).unwrap();
                    if let Some(id) = m["request_id"].as_str().map(str::to_owned) {
                        let n = ids.iter().position(|x| *x == id).unwrap_or_else(|| {
                            ids.push(id);
                            ids.len() - 1
                        });
                        m["request_id"] = json!(format!("$ID{n}"));
                    } else if m["type"] == "control_response"
                        && m["response"]["request_id"].is_string()
                    {
                        m["response"]["request_id"] = json!("$CLI_ID");
                    }
                    m
                })
                .collect();
            Value::Array(lines)
        });
        let sdk_env = cli_env.as_object().map(|o| {
            let mut out = Map::new();
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by_key(|k| k.encode_utf16().collect::<Vec<u16>>());
            for k in keys {
                if k.starts_with("__CF") {
                    continue;
                }
                if server_env.get(k).map(String::as_str) != o[k].as_str() {
                    let v = o[k].as_str().unwrap_or_default();
                    let v = v.replace(
                        claudius_agent::options::MIRRORED_SDK_VERSION,
                        "$SDK_VERSION",
                    );
                    out.insert(k.clone(), json!(v));
                }
            }
            Value::Object(out)
        });
        for name in ["argv.json", "env.json", "stdin.log"] {
            let _ = std::fs::remove_file(file(name));
        }
        self.norm(shrink(json!({
            "argv": argv,
            "stdin": stdin,
            "sdkEnv": sdk_env,
        })))
    }

    fn write_exec(&self, rel: &str, text: &str) {
        let file = self.path(rel);
        std::fs::write(&file, text).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Runs a setup step; `Some` is what a `state` / `ls` / `dbs` step reads.
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
                let out = self.git(&args, step["cwd"].as_str().unwrap());
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
                std::fs::write(path, step["text"].as_str().unwrap()).unwrap();
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
                let text = self
                    .fake_git
                    .replace("@ROOT@", &self.root_str())
                    .replace("@GIT@", &git);
                self.write_exec("fakebin/git", &text);
            }
            "sql" => {
                let root = step["root"].as_str().unwrap();
                let file = self.db_file(root);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                let conn = rusqlite::Connection::open(&file).unwrap();
                conn.pragma_update(None, "journal_mode", "WAL").unwrap();
                let cwd = self.path(root).display().to_string();
                conn.execute_batch(&step["sql"].as_str().unwrap().replace("$CWD", &cwd))
                    .unwrap();
            }
            "block" => {
                let dir = self.db_file(step["root"].as_str().unwrap());
                let dir = dir.parent().unwrap();
                std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
                std::fs::write(dir, "not a dir\n").unwrap();
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
            "ls" => return Some(json!(sorted_names(&p("path")))),
            "dbs" => return Some(self.read_dbs()),
            op => panic!("unknown op {op}"),
        }
        None
    }

    fn write_workspaces(&self, step: &Value) {
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
        let text =
            serde_json::to_string_pretty(&json!({"version": 1, "workspaces": list})).unwrap();
        let dir = self.path("home/.claude/.claudius");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("workspaces.json"), text).unwrap();
    }

    /// Each project dir (in UTF-16 order) with its drafts: `[cwd, typeof
    /// message, hex(message), typeof updated_at]`, or `rows: null` when the
    /// query fails.
    fn read_dbs(&self) -> Value {
        let projects = self.projects();
        if !projects.exists() {
            return Value::Null;
        }
        let entries: Vec<Value> = sorted_names(&projects)
            .into_iter()
            .map(|name| {
                let p = projects.join(&name);
                let mut entry = json!({"name": self.normalize(&name)});
                if !p.is_dir() {
                    entry["kind"] = json!("file");
                    return entry;
                }
                let file = p.join(".claudius.db");
                if !file.exists() {
                    entry["kind"] = json!("dir");
                    return entry;
                }
                entry["kind"] = json!("db");
                let conn = rusqlite::Connection::open_with_flags(
                    &file,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
                .unwrap();
                let rows = conn
                    .prepare(
                        "SELECT cwd, typeof(message), hex(message), typeof(updated_at) FROM commit_drafts ORDER BY rowid",
                    )
                    .and_then(|mut st| {
                        st.query_map([], |r| {
                            let text = |i: usize| -> rusqlite::Result<String> {
                                Ok(match r.get_ref(i)? {
                                    ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                                    ValueRef::Integer(n) => n.to_string(),
                                    other => format!("{other:?}"),
                                })
                            };
                            Ok(json!([self.normalize(&text(0)?), text(1)?, text(2)?, text(3)?]))
                        })?
                        .collect::<rusqlite::Result<Vec<Value>>>()
                    });
                entry["rows"] = rows.map_or(Value::Null, Value::Array);
                entry
            })
            .collect();
        Value::Array(entries)
    }
}

/// A dir's entry names in JS `sort()` (UTF-16) order.
fn sorted_names(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by_key(|n| n.encode_utf16().collect::<Vec<u16>>());
    names
}

/// FNV-1a over UTF-16 units.
fn fnv(units: &[u16]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for u in units {
        h ^= u32::from(*u);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// The recorder's `shrink`: strings past 2000 units as `{$big, fnv, head,
/// tail}` (200 units each end).
fn shrink(v: Value) -> Value {
    match v {
        Value::String(s) => {
            let units: Vec<u16> = s.encode_utf16().collect();
            if units.len() <= 2000 {
                return Value::String(s);
            }
            json!({
                "$big": units.len(),
                "fnv": fnv(&units),
                "head": String::from_utf16_lossy(&units[..200]),
                "tail": String::from_utf16_lossy(&units[units.len() - 200..]),
            })
        }
        Value::Array(a) => Value::Array(a.into_iter().map(shrink).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, shrink(v))).collect()),
        v => v,
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

/// What is compared under another git or OS: the status, and the body's
/// keys and its `code` / `ok`.
fn coarse(v: &Value) -> Value {
    let Some(body) = v["body"].as_str() else {
        return v.clone();
    };
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let keys: Vec<&String> = parsed
        .as_object()
        .map(|o| o.keys().collect())
        .unwrap_or_default();
    json!({"status": v["status"], "keys": keys, "code": parsed["code"], "ok": parsed["ok"]})
}

/// No request input reaches git as an option: every `-` argument is one the
/// routes add, or comes after `--`.
fn assert_no_injected_options(call: &[String]) {
    for a in call[2..].iter().take_while(|a| *a != "--") {
        assert!(
            !a.starts_with('-') || OPTIONS.contains(&a.as_str()),
            "an option reached git: {call:?}"
        );
    }
}

/// node's `process.platform` for this OS.
fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    }
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new(&fx);
    for d in ["servercwd", "emptybin", "fakeclaude"] {
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
    let fake = fake_bin();
    let fake_path = format!(
        "{}:{}",
        world.path("fakebin").display(),
        world.path("sysbin").display()
    );
    let server = world.server(&fake_path, &fake);
    let nogit = world.server(&world.path("emptybin").display().to_string(), &fake);
    let mut server_env: BTreeMap<String, String> = world.server_env().into_iter().collect();
    server_env.insert("PATH".into(), fake_path.clone());

    let steps = fx["steps"].as_array().unwrap();
    let mut failures = vec![];
    let mut loose = 0;
    let (mut requests, mut states, mut cli_runs) = (0, 0, 0);
    let mut all_calls: Vec<Vec<String>> = vec![];
    for (i, s) in steps.iter().enumerate() {
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
                let got = shape(&world, send(port, &method, &path, body.as_deref()));
                let calls = world.take_calls();
                all_calls.extend(calls.iter().cloned());
                let what = format!("#{i} {label} ({method} {path})");
                let exact = same_git && s["os"].as_str().is_none_or(|os| os == platform());
                let want = want_shape(&s["got"]);
                if want != got {
                    if exact {
                        failures.push(format!("{what}:\n  want {want}\n  got  {got}"));
                    } else if coarse(&want) != coarse(&got) {
                        failures.push(format!("{what} (coarse):\n  want {want}\n  got  {got}"));
                    } else {
                        loose += 1;
                    }
                }
                let want_calls = &s["got"]["calls"];
                if *want_calls != json!(calls) && same_git {
                    failures.push(format!(
                        "{what} calls:\n  want {want_calls}\n  got  {}",
                        json!(calls)
                    ));
                }
                if s["route"] == "commit-message" {
                    let cli = world.take_cli(&server_env);
                    let mut want = s["got"]["cli"].clone();
                    if let Some(env) = want["sdkEnv"].as_object_mut() {
                        for (k, _) in ENV_DIFFERENCES {
                            env.shift_remove(*k);
                        }
                    }
                    if !cli["argv"].is_null() {
                        cli_runs += 1;
                    }
                    if cli != want {
                        failures.push(format!("{what} cli:\n  want {want}\n  got  {cli}"));
                    }
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
                        s["cwd"].as_str().or(s["path"].as_str()).unwrap_or("")
                    );
                    if same_git || op != "state" {
                        failures.push(format!("{what}:\n  want {}\n  got  {got}", s["got"]));
                    } else {
                        loose += 1;
                    }
                }
            }
        }
    }
    if loose > 0 {
        eprintln!("{loose} answers or states differ in git's or the OS's own words (not compared)");
    }
    assert!(
        failures.is_empty(),
        "{} differences in {requests} requests:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(
        requests >= 160 && states >= 30 && cli_runs >= 19,
        "{requests} {states} {cli_runs}"
    );
    for call in &all_calls {
        assert_no_injected_options(call);
    }
    assert!(all_calls.len() >= 290, "{}", all_calls.len());

    // Only the TS methods; the rest is axum's 405, as Next answers it.
    for (route, allowed) in [
        ("stage", &["POST"][..]),
        ("commit", &["POST"]),
        ("commit-draft", &["GET", "POST", "DELETE"]),
        ("commit-message", &["POST"]),
    ] {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            if allowed.contains(&method) {
                continue;
            }
            let (st, _) = http(
                server.port,
                method,
                &format!("/api/workspaces/wks_a/git/{route}"),
                "{}",
            );
            assert_eq!(st, 405, "{method} {route}");
        }
    }
    drop((server, nogit));
}
