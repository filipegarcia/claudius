//! `GET /api/doctor` and `POST /api/doctor/fix` against the real binary,
//! replaying `tests/fixtures/doctor_golden.json` (recorded by
//! `rust/scripts/doctor-golden.mjs` from the real TS route handlers).
//!
//! The cases are grouped by the env they ran under; each group gets its own
//! temp root and server: cwd `$ROOT/project`, `PATH` at `$ROOT/bin` only
//! (the recorded fake `git`, and a fake `node` printing the case's version
//! in place of TS's own `process.versions.node`), `HOME` and
//! `CLAUDIUS_STATE_HOME` at `$ROOT/home`, `CLAUDE_CONFIG_DIR` at a decoy,
//! umask 022, no other env. Each case starts from the emptied root and the
//! recorded base world, then runs its steps: every request must get the
//! recorded status, content type and body bytes (`$ROOT` / `$EROOT` and
//! the runtime's platform and arch swapped back), run `git` with the
//! recorded argv (and `node` with `--version`), and change exactly the
//! recorded paths in the same way. A request recorded with `as` is a
//! listed difference: the port answers what TS answered for the `as` body.
//! Cases that need enforced permissions run only where a `chmod 0` file is
//! unreadable.
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use claudius_core::{doctor, js_string, paths, tcc_protected};
use common::free_port;
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/doctor_golden.json");
        js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

struct Rig {
    // Keeps the root alive.
    _tmp: tempfile::TempDir,
    root: String,
    eroot: String,
    env: Vec<(String, String)>,
    server: Option<(Child, u16)>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        if let Some((child, _)) = &mut self.server {
            let _ = child.kill();
            let _ = child.wait();
        }
        open_up(Path::new(&self.root));
    }
}

/// chmod every directory under `p` back to 0755, so it can be removed.
fn open_up(p: &Path) {
    let Ok(md) = std::fs::symlink_metadata(p) else {
        return;
    };
    if !md.is_dir() {
        return;
    }
    if std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).is_err() {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            open_up(&e.path());
        }
    }
}

fn remove(p: &Path) {
    open_up(p);
    match std::fs::symlink_metadata(p) {
        Ok(md) if md.is_dir() => std::fs::remove_dir_all(p).unwrap(),
        Ok(_) => std::fs::remove_file(p).unwrap(),
        Err(_) => {}
    }
}

/// `mkdir -p` with every directory it makes 0755 (what umask 022 gives).
fn mkdir_p(p: &Path) {
    if p.exists() {
        return;
    }
    if let Some(parent) = p.parent() {
        mkdir_p(parent);
    }
    std::fs::create_dir(p).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn write(p: &Path, bytes: &[u8], mode: u32) {
    std::fs::write(p, bytes).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

impl Rig {
    fn new(env: &Map<String, Value>) -> Rig {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let root = root.to_str().unwrap().to_owned();
        for d in ["project", "bin"] {
            mkdir_p(Path::new(&format!("{root}/{d}")));
        }
        let mut rig = Rig {
            _tmp: tmp,
            eroot: paths::encode_project_dir(&root),
            root,
            env: env
                .iter()
                .map(|(k, v)| (k.clone(), s(v).to_owned()))
                .collect(),
            server: None,
        };
        rig.reset();
        rig.spawn();
        rig
    }

    fn path(&self, rel: &str) -> String {
        format!("{}/{}", self.root, self.abs(rel))
    }

    fn abs(&self, s: &str) -> String {
        s.replace("$EROOT", &self.eroot)
            .replace("$ROOT", &self.root)
    }

    fn rel(&self, s: &str) -> String {
        s.replace(&self.eroot, "$EROOT")
            .replace(&self.root, "$ROOT")
    }

    fn port(&self) -> u16 {
        self.server.as_ref().unwrap().1
    }

    fn spawn(&mut self) {
        for _ in 0..5 {
            let port = free_port();
            let mut cmd = Command::new("/bin/sh");
            cmd.arg("-c")
                .arg("umask 022 && exec \"$0\" \"$@\"")
                .arg(common::server_bin())
                .args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
                .arg(common::fake_bin())
                .current_dir(self.path("project"))
                .env_clear()
                .env("PATH", self.path("bin"))
                .env("HOME", self.path("home"))
                .env("CLAUDIUS_STATE_HOME", self.path("home"))
                .env("CLAUDE_CONFIG_DIR", self.path("config"))
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            for (k, v) in &self.env {
                cmd.env(k, v);
            }
            let mut child = cmd.spawn().unwrap();
            let up = {
                let start = Instant::now();
                loop {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        break false;
                    }
                    if TcpStream::connect(("127.0.0.1", port)).is_ok()
                        && request(port, "GET", "/api/rust/health", "").0 == 200
                    {
                        break true;
                    }
                    assert!(start.elapsed() < Duration::from_secs(20), "no health");
                    std::thread::sleep(Duration::from_millis(50));
                }
            };
            // Two servers handed the same port: the one that lost the bind
            // exits, and its health check may have passed on the other.
            // This server's doctor names this root.
            if up && matches!(child.try_wait(), Ok(None)) {
                let (_, _, body) = request(port, "GET", "/api/doctor", "");
                let _ = std::fs::remove_file(self.path("bin/git.argv"));
                let _ = std::fs::remove_file(self.path("bin/node.argv"));
                if body.contains(&format!("\"detail\":\"{}/home/.claude\"", self.root)) {
                    self.server = Some((child, port));
                    return;
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        panic!("no server of this rig's own answered");
    }

    /// The recorder's `resetWorld`: the root emptied, `project` and `bin`
    /// kept (emptied).
    fn reset(&self) {
        let root = Path::new(&self.root);
        open_up(root);
        for e in std::fs::read_dir(root).unwrap().flatten() {
            let name = e.file_name();
            let p = e.path();
            if name == "project" || name == "bin" {
                for inner in std::fs::read_dir(&p).unwrap().flatten() {
                    remove(&inner.path());
                }
            } else {
                remove(&p);
            }
        }
    }

    fn apply(&self, op: &Value) {
        let p = op["path"].as_str().map(|r| self.path(r));
        let p = || Path::new(p.as_deref().unwrap());
        match s(&op["op"]) {
            "write" => {
                mkdir_p(p().parent().unwrap());
                let bytes = match op["bytes"].as_array() {
                    Some(b) => b.iter().map(|n| n.as_u64().unwrap() as u8).collect(),
                    None => js_string::lossy(&self.abs(s(&op["text"])))
                        .as_bytes()
                        .to_vec(),
                };
                write(p(), &bytes, 0o644);
            }
            "mkdir" => mkdir_p(p()),
            "rm" => remove(p()),
            "symlink" => {
                mkdir_p(p().parent().unwrap());
                std::os::unix::fs::symlink(self.abs(s(&op["target"])), p()).unwrap();
            }
            "chmod" => {
                let mode = op["mode"].as_u64().unwrap() as u32;
                std::fs::set_permissions(p(), std::fs::Permissions::from_mode(mode)).unwrap();
            }
            "sql" => {
                let cwd = self.abs(s(&op["cwd"]));
                let db = format!(
                    "{}/home/.claude/projects/{}/.claudius.db",
                    self.root,
                    paths::encode_project_dir(&cwd)
                );
                mkdir_p(Path::new(&db).parent().unwrap());
                let conn = rusqlite::Connection::open(&db).unwrap();
                conn.execute_batch(s(&op["sql"])).unwrap();
                conn.close().unwrap();
                std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
            other => panic!("op {other}"),
        }
    }

    fn install_git(&self, g: &Value) {
        let p = self.path("bin/git");
        remove(Path::new(&p));
        let fx = fixture();
        let head = s(&fx["fakeHead"]);
        match g.as_str() {
            None => {}
            Some("dir") => mkdir_p(Path::new(&p)),
            Some("noexec") => write(
                Path::new(&p),
                format!("{head}{}\n", s(&fx["git"])).as_bytes(),
                0o644,
            ),
            Some(body) => write(Path::new(&p), format!("{head}{body}\n").as_bytes(), 0o755),
        }
    }

    /// The fake `node`, printing `v<version>` as `node --version` does.
    fn install_node(&self, version: &str) {
        assert!(!version.contains('\''), "{version}");
        let head = s(&fixture()["fakeHead"]);
        write(
            Path::new(&self.path("bin/node")),
            format!("{head}printf 'v%s\\n' '{version}'\n").as_bytes(),
            0o755,
        );
    }

    /// The argv a fake ran with since the last call (and forget it).
    fn argv(&self, tool: &str) -> Value {
        let p = self.path(&format!("bin/{tool}.argv"));
        match std::fs::read(&p) {
            Ok(b) => {
                std::fs::remove_file(&p).unwrap();
                let text = String::from_utf8(b).unwrap();
                let mut args: Vec<&str> = text.split('\0').collect();
                assert_eq!(args.pop(), Some(""), "{text:?}");
                json!(args)
            }
            Err(_) => Value::Null,
        }
    }

    /// Every path under the root but `bin`, as the recorder's `snapshot`.
    fn snapshot(&self) -> BTreeMap<Vec<u16>, (String, Value)> {
        let mut snap = BTreeMap::new();
        let mut names: Vec<String> = std::fs::read_dir(&self.root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "bin")
            .collect();
        names.sort_by_key(|n| n.encode_utf16().collect::<Vec<_>>());
        for n in names {
            self.visit(&n, &mut snap);
        }
        snap
    }

    fn visit(&self, rel: &str, snap: &mut BTreeMap<Vec<u16>, (String, Value)>) {
        let abs = self.path(rel);
        let Ok(md) = std::fs::symlink_metadata(&abs) else {
            return;
        };
        let mode = md.permissions().mode() & 0o777;
        let name = rel.rsplit('/').next().unwrap();
        let entry = if md.file_type().is_symlink() {
            let target = std::fs::read_link(&abs).unwrap();
            json!({"kind": "symlink", "target": self.rel(&target.to_string_lossy())})
        } else if md.is_dir() {
            let mut entry = json!({"kind": "dir", "mode": mode});
            let mut names: Vec<String> = match std::fs::read_dir(&abs) {
                Ok(rd) => rd
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect(),
                Err(_) => {
                    entry["unreadable"] = json!(true);
                    Vec::new()
                }
            };
            names.sort_by_key(|n| n.encode_utf16().collect::<Vec<_>>());
            snap.insert(rel.encode_utf16().collect(), (rel.to_owned(), entry));
            for n in names {
                if n.ends_with(".claudius.db-wal") || n.ends_with(".claudius.db-shm") {
                    continue;
                }
                self.visit(&format!("{rel}/{}", self.rel(&n)), snap);
            }
            return;
        } else if name == ".claudius.db" {
            json!({"kind": "file", "mode": mode, "db": true})
        } else {
            match std::fs::read(&abs) {
                Err(_) => json!({"kind": "file", "mode": mode, "unreadable": true}),
                Ok(buf) => match String::from_utf8(buf) {
                    Ok(text) => json!({"kind": "file", "mode": mode, "text": self.rel(&text)}),
                    Err(e) => json!({"kind": "file", "mode": mode, "bytes": e.into_bytes()}),
                },
            }
        };
        snap.insert(rel.encode_utf16().collect(), (rel.to_owned(), entry));
    }
}

fn changes(
    before: &BTreeMap<Vec<u16>, (String, Value)>,
    after: &BTreeMap<Vec<u16>, (String, Value)>,
) -> Value {
    let mut keys: Vec<&Vec<u16>> = before.keys().chain(after.keys()).collect();
    keys.sort();
    keys.dedup();
    let out: Vec<Value> = keys
        .into_iter()
        .filter(|k| before.get(*k).map(|e| &e.1) != after.get(*k).map(|e| &e.1))
        .map(|k| {
            let (rel, entry) = after
                .get(k)
                .map(|(r, e)| (r.clone(), e.clone()))
                .unwrap_or_else(|| (before[k].0.clone(), Value::Null));
            json!([rel, entry])
        })
        .collect();
    json!(out)
}

/// One HTTP/1.1 request → (status, content type, body).
fn request(port: u16, method: &str, url: &str, body: &str) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "{method} {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let raw = String::from_utf8(raw).unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let content_type = head.split("\r\n").find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, content_type, body.to_owned())
}

/// Whether a `chmod 0` file is unreadable here (not root).
fn perm_enforced() -> bool {
    static P: OnceLock<bool> = OnceLock::new();
    *P.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("probe");
        std::fs::write(&p, "x").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::read(&p).is_err()
    })
}

/// Replay one case on the rig; the mismatches.
fn replay(rig: &Rig, case: &Value) -> Vec<String> {
    let fx = fixture();
    let name = s(&case["name"]);
    let mut bad = Vec::new();
    rig.reset();
    for op in fx["base"].as_array().unwrap() {
        rig.apply(op);
    }
    rig.install_git(&fx["git"]);
    rig.install_node(s(&fx["node"]));
    let platform_arch = format!(
        "\"platform\":\"{}\",\"arch\":\"{}\"",
        tcc_protected::platform(),
        doctor::node_arch(std::env::consts::ARCH)
    );
    for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
        if let Some(ops) = step["setup"].as_array() {
            for op in ops {
                rig.apply(op);
            }
            continue;
        }
        if let Some(v) = step.get("node") {
            rig.install_node(s(v));
            continue;
        }
        if let Some(g) = step.get("git") {
            rig.install_git(g);
            continue;
        }
        let req = &step["request"];
        let method = s(&req["method"]);
        let before = rig.snapshot();
        let t0 = Instant::now();
        let (status, content_type, body) = request(
            rig.port(),
            method,
            s(&req["path"]),
            req["body"].as_str().unwrap_or(""),
        );
        let took = t0.elapsed();
        let mut body = rig.rel(&body);
        if method == "GET" && status == 200 {
            assert!(body.contains(&platform_arch), "{body}");
            body = body.replacen(
                &platform_arch,
                "\"platform\":\"$PLATFORM\",\"arch\":\"$ARCH\"",
                1,
            );
        }
        let got = if status == 500 && content_type.is_none() && body.is_empty() {
            json!({"threw": true})
        } else {
            json!({"status": status, "type": content_type, "body": body})
        };
        let want = match step["got"].get("threw") {
            Some(_) => json!({"threw": true}),
            None => step["got"].clone(),
        };
        let where_ = format!("{name} step {i} ({method} {})", req["body"]);
        if got != want {
            bad.push(format!(
                "{where_}\n  want {}\n  got  {}",
                js_string::stringify(&want),
                js_string::stringify(&got)
            ));
        }
        let git = rig.argv("git");
        if git != step["gitArgv"] {
            bad.push(format!(
                "{where_}: git argv {git}, want {}",
                step["gitArgv"]
            ));
        }
        let node = rig.argv("node");
        let want_node = if method == "GET" {
            json!(["--version"])
        } else {
            Value::Null
        };
        if node != want_node {
            bad.push(format!("{where_}: node argv {node}"));
        }
        let ch = changes(&before, &rig.snapshot());
        if js_string::stringify(&ch) != js_string::stringify(&step["changes"]) {
            bad.push(format!(
                "{where_}: changes\n  want {}\n  got  {}",
                js_string::stringify(&step["changes"]),
                js_string::stringify(&ch)
            ));
        }
        // The probes' 1.5 s timeout (`exec /bin/sleep 5`) bounds the GET.
        if took > Duration::from_secs(4) {
            bad.push(format!("{where_}: took {took:?}"));
        }
    }
    bad
}

#[test]
fn doctor_golden() {
    let fx = fixture();
    let mut groups: BTreeMap<String, (Map<String, Value>, Vec<&Value>)> = BTreeMap::new();
    let mut skipped = 0;
    for case in fx["cases"].as_array().unwrap() {
        if case["needs"] == "perm" && !perm_enforced() {
            skipped += 1;
            continue;
        }
        let env = case["env"].as_object().unwrap().clone();
        groups
            .entry(js_string::stringify(&case["env"]))
            .or_insert_with(|| (env, Vec::new()))
            .1
            .push(case);
    }
    assert!(groups.len() >= 5, "{}", groups.len());
    let bad: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = groups
            .values()
            .map(|(env, cases)| {
                scope.spawn(move || {
                    let rig = Rig::new(env);
                    cases
                        .iter()
                        .flat_map(|c| replay(&rig, c))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect()
    });
    assert!(
        bad.is_empty(),
        "{} mismatches ({skipped} cases skipped):\n{}",
        bad.len(),
        bad.join("\n")
    );
}

/// The Rust-only half of the Node.js check: with no `node` that answers
/// on PATH, it fails with `node not on PATH` and `runtime.node` is empty.
#[test]
fn node_missing_or_failing() {
    let rig = Rig::new(&Map::new());
    for op in fixture()["base"].as_array().unwrap() {
        rig.apply(op);
    }
    rig.install_git(&fixture()["git"]);
    let check = |rig: &Rig| {
        let (status, _, body) = request(rig.port(), "GET", "/api/doctor", "");
        assert_eq!(status, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        (v["runtime"]["node"].clone(), v["checks"][0].clone())
    };
    let want =
        json!({"id": "node", "label": "Node.js", "status": "fail", "detail": "node not on PATH"});
    let _ = std::fs::remove_file(rig.path("bin/node"));
    assert_eq!(check(&rig), (json!(""), want.clone()));
    let head = s(&fixture()["fakeHead"]);
    write(
        Path::new(&rig.path("bin/node")),
        format!("{head}exit 1\n").as_bytes(),
        0o755,
    );
    assert_eq!(check(&rig), (json!(""), want.clone()));
    write(
        Path::new(&rig.path("bin/node")),
        format!("{head}exec /bin/sleep 5\n").as_bytes(),
        0o755,
    );
    let t0 = Instant::now();
    assert_eq!(check(&rig), (json!(""), want));
    let took = t0.elapsed();
    assert!(
        (Duration::from_millis(1400)..Duration::from_secs(4)).contains(&took),
        "{took:?}"
    );
    // One trailing newline and one leading `v` come off; the rest stays.
    write(
        Path::new(&rig.path("bin/node")),
        format!("{head}printf 'v20.1.0\\n\\n'\n").as_bytes(),
        0o755,
    );
    let (node, c) = check(&rig);
    assert_eq!(node, json!("20.1.0\n"));
    assert_eq!(c["detail"], json!("v20.1.0\n"));
    assert_eq!(c["status"], json!("ok"));
}
