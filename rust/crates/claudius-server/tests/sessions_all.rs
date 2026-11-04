//! `GET /api/sessions/all`, `GET /api/sessions/{info,export,transcript}/:id`
//! and `DELETE /api/sessions/file/:id` (D19) on the real binary, against
//! the TS handlers recorded by `rust/scripts/sessions-all-golden.mjs`.
//!
//! Each recorded group is rebuilt under a root of the recorded length (so
//! encoded names and file sizes match): the transcripts under
//! `$ROOT/config/projects` (`CLAUDE_CONFIG_DIR`), Claudius's state and
//! databases under `$ROOT/home` (`CLAUDIUS_STATE_HOME`). Its steps then run
//! in order against a fresh server: every request's status, content type,
//! content disposition and body, every `tree` (kind, size, link target of
//! each entry) and every `rows` dump of a `sessions` table must be the
//! recorded ones, with the root written back as `$ROOT` / `$EROOT` /
//! `$QC{…}`. Groups marked `perms` need a non-root user; `os: "darwin"`
//! groups and steps need a case-insensitive disk and run on macOS only.

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use claudius_core::db::{Mode, open_path};
use claudius_core::paths::{encode_project_dir, sdk_project_dir_name};
use common::{Server, World, http};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sessions_all_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn group(name: &str) -> Value {
    fixture()["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == name)
        .unwrap_or_else(|| panic!("no group {name}"))
        .clone()
}

fn is_root_user() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
}

fn runs_here(v: &Value) -> bool {
    match v["os"].as_str() {
        Some("darwin") => cfg!(target_os = "macos"),
        Some(other) => panic!("unknown os {other}"),
        None => true,
    }
}

/// `s.replace(/[^a-zA-Z0-9]/g, "-")`, per UTF-16 unit.
fn ja(s: &str) -> String {
    s.encode_utf16()
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect()
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// One recorded group's world.
struct Root {
    /// Owns the temp dir.
    world: World,
    root: String,
    hashed: Vec<(String, String)>,
}

impl Root {
    fn new(root_len: usize, hashed: &[Value]) -> Root {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let base = base.to_str().unwrap().to_owned();
        let pad = root_len
            .checked_sub(base.len() + 1)
            .filter(|&p| p >= 1)
            .unwrap_or_else(|| panic!("temp dir {base} is too long for {root_len}"));
        let root = format!("{base}/{}", "p".repeat(pad));
        let (home, config, project) = (
            PathBuf::from(format!("{root}/home")),
            PathBuf::from(format!("{root}/config")),
            PathBuf::from(format!("{base}/server-cwd")),
        );
        std::fs::create_dir_all(config.join("projects")).unwrap();
        std::fs::create_dir_all(home.join(".claude/.claudius")).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let hashed = hashed
            .iter()
            .map(|rel| {
                let rel = rel.as_str().unwrap();
                (
                    sdk_project_dir_name(&format!("{root}/{rel}")),
                    format!("$QC{{{rel}}}"),
                )
            })
            .collect();
        Root {
            world: World {
                root: tmp,
                home,
                config,
                project,
            },
            root,
            hashed,
        }
    }

    fn sub(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    fn unroot(&self, s: &str) -> String {
        let mut s = s.to_owned();
        for (name, mark) in &self.hashed {
            s = s.replace(name, mark);
        }
        s.replace(&self.root, "$ROOT")
            .replace(&ja(&self.root), "$EROOT")
    }

    /// `path.join(root, rel)` for the plain relative paths the fixture uses.
    fn under(&self, rel: &str) -> String {
        format!("{}/{}", self.root, self.sub(rel))
    }

    /// The `.claudius.db` of the cwd `$ROOT/<rel>` (text after `$ROOT/`).
    fn db_file(&self, cwd: &str) -> PathBuf {
        let cwd = self.under(cwd.strip_prefix("$ROOT/").unwrap_or(cwd));
        self.world
            .home
            .join(".claude/projects")
            .join(encode_project_dir(&cwd))
            .join(".claudius.db")
    }

    /// A recorded path spec: `"$ROOT/…"`, or a project dir plus `sub`.
    fn path(&self, spec: &Value) -> PathBuf {
        if let Some(s) = spec.as_str() {
            return PathBuf::from(self.sub(s));
        }
        let projects = format!("{}/config/projects", self.root);
        let dir = if let Some(rel) = spec["proj"].as_str() {
            format!("{projects}/{}", sdk_project_dir_name(&self.under(rel)))
        } else if let Some(name) = spec["projName"].as_str() {
            format!("{projects}/{name}")
        } else if let Some(rel) = spec["projPrefix"].as_str() {
            let name: String = ja(&self.under(rel)).chars().take(200).collect();
            format!("{projects}/{name}{}", spec["suffix"].as_str().unwrap())
        } else {
            let rel = spec["db"].as_str().unwrap();
            format!(
                "{}/home/.claude/projects/{}",
                self.root,
                encode_project_dir(&self.under(rel))
            )
        };
        match spec["sub"].as_str() {
            Some(sub) => PathBuf::from(format!("{dir}/{}", self.sub(sub))),
            None => PathBuf::from(dir),
        }
    }

    fn bytes(&self, parts: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        for p in parts.as_array().unwrap() {
            if let Some(t) = p["text"].as_str() {
                out.extend(self.sub(t).into_bytes());
            } else if let Some(h) = p["hex"].as_str() {
                out.extend(
                    (0..h.len())
                        .step_by(2)
                        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()),
                );
            } else {
                let n = p["count"].as_u64().unwrap() as usize;
                out.extend(p["repeat"].as_str().unwrap().repeat(n).into_bytes());
            }
        }
        out
    }

    /// The recorder's `runOps`: mtimes after every write, modes last.
    fn run_ops(&self, ops: &[Value]) {
        let mut times = vec![];
        let mut modes = vec![];
        for op in ops {
            let at = || self.path(&op["path"]);
            match op["op"].as_str().unwrap() {
                "mkdir" => std::fs::create_dir_all(at()).unwrap(),
                "write" => {
                    let at = at();
                    std::fs::create_dir_all(at.parent().unwrap()).unwrap();
                    std::fs::write(&at, self.bytes(&op["parts"])).unwrap();
                    if let Some(ns) = op["mtime"].as_str() {
                        times.push((at, ns.parse::<u64>().unwrap()));
                    }
                }
                "symlink" => {
                    let at = at();
                    std::fs::create_dir_all(at.parent().unwrap()).unwrap();
                    std::os::unix::fs::symlink(self.sub(op["target"].as_str().unwrap()), &at)
                        .unwrap();
                }
                "rm" => {
                    let at = at();
                    match std::fs::symlink_metadata(&at) {
                        Ok(m) if m.is_dir() => std::fs::remove_dir_all(&at).unwrap(),
                        Ok(_) => std::fs::remove_file(&at).unwrap(),
                        Err(_) => {}
                    }
                }
                "chmod" => modes.push((at(), op["mode"].as_u64().unwrap() as u32)),
                "git" => {
                    let cwd = self.under(op["cwd"].as_str().unwrap());
                    std::fs::create_dir_all(&cwd).unwrap();
                    let args: Vec<String> = op["args"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|a| self.sub(a.as_str().unwrap()))
                        .collect();
                    let out = Command::new("git")
                        .args(&args)
                        .current_dir(&cwd)
                        .env("GIT_CONFIG_GLOBAL", "/dev/null")
                        .env("GIT_CONFIG_NOSYSTEM", "1")
                        .output()
                        .unwrap();
                    assert!(out.status.success(), "git {args:?}: {out:?}");
                }
                "sql" => {
                    let db = open_path(&self.db_file(op["cwd"].as_str().unwrap()), Mode::ReadWrite)
                        .unwrap();
                    db.execute_batch(&self.sub(op["sql"].as_str().unwrap()))
                        .unwrap();
                }
                "rawdb" => {
                    let path = self.db_file(op["cwd"].as_str().unwrap());
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    let _ = std::fs::remove_file(&path);
                    if let Some(text) = op["text"].as_str() {
                        std::fs::write(&path, text).unwrap();
                    } else {
                        let db = rusqlite::Connection::open(&path).unwrap();
                        db.execute_batch(&self.sub(op["sql"].as_str().unwrap()))
                            .unwrap();
                    }
                }
                other => panic!("unknown op {other}"),
            }
        }
        for (p, ns) in times {
            let t = SystemTime::UNIX_EPOCH + Duration::from_nanos(ns);
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t))
                .unwrap();
        }
        for (p, mode) in modes {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        }
    }

    /// The recorder's `treeOf`.
    fn tree(&self, spec: &Value) -> Value {
        fn walk(r: &Root, p: &Path, rel: &str, out: &mut Vec<Vec<Value>>) {
            let Ok(st) = std::fs::symlink_metadata(p) else {
                return;
            };
            if rel.ends_with("-wal") || rel.ends_with("-shm") {
                return;
            }
            let ft = st.file_type();
            if ft.is_symlink() {
                let target = std::fs::read_link(p).unwrap();
                out.push(vec![
                    json!(rel),
                    json!("link"),
                    json!(r.unroot(target.to_str().unwrap())),
                ]);
            } else if ft.is_dir() {
                out.push(vec![json!(rel), json!("dir")]);
                let Ok(rd) = std::fs::read_dir(p) else {
                    return;
                };
                let mut names: Vec<String> = rd
                    .map(|e| e.unwrap().file_name().into_string().unwrap())
                    .collect();
                names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                for n in names {
                    let child = if rel.is_empty() {
                        n.clone()
                    } else {
                        format!("{rel}/{n}")
                    };
                    walk(r, &p.join(&n), &child, out);
                }
            } else if ft.is_file() {
                if rel.ends_with(".claudius.db") {
                    out.push(vec![json!(rel), json!("file")]);
                } else {
                    out.push(vec![json!(rel), json!("file"), json!(st.len())]);
                }
            } else {
                out.push(vec![json!(rel), json!("other")]);
            }
        }
        let mut out = vec![];
        walk(self, &self.path(spec), "", &mut out);
        for e in &mut out {
            e[0] = json!(self.unroot(e[0].as_str().unwrap()));
        }
        out.sort_by(|a, b| {
            let (a, b) = (a[0].as_str().unwrap(), b[0].as_str().unwrap());
            a.encode_utf16().cmp(b.encode_utf16())
        });
        json!(out)
    }

    /// The recorder's `rowsOf`: each `sessions` row's id, cwd, title and
    /// state with their SQLite types.
    fn rows(&self, cwd: &str) -> Value {
        use rusqlite::types::ValueRef;
        let path = self.db_file(cwd);
        let db = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut st = db
            .prepare(
                "SELECT typeof(id), id, typeof(cwd), cwd, typeof(title), title, typeof(state), state
                   FROM sessions ORDER BY rowid",
            )
            .unwrap();
        let rows = st
            .query_map([], |r| {
                let mut cells = vec![];
                for i in 0..4 {
                    let t: String = r.get(2 * i)?;
                    let v = match r.get_ref(2 * i + 1)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(f) => json!(f),
                        ValueRef::Text(t) => json!(self.unroot(&String::from_utf8_lossy(t))),
                        ValueRef::Blob(b) => {
                            json!(b.iter().map(|x| format!("{x:02x}")).collect::<String>())
                        }
                    };
                    cells.push(json!([t, v]));
                }
                Ok(Value::Array(cells))
            })
            .unwrap();
        Value::Array(rows.map(Result::unwrap).collect())
    }
}

/// A raw HTTP/1.1 exchange: status, headers (values as latin1) and body.
fn exchange(port: u16, method: &str, target: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let head = if method == "GET" {
        format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
    } else {
        format!(
            "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    };
    s.write_all(head.as_bytes()).unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let at = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head: String = out[..at].iter().map(|&b| char::from(b)).collect();
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
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((
                k.to_ascii_lowercase(),
                v.trim_matches([' ', '\t']).to_owned(),
            ))
        })
        .collect();
    let mut body = out[at + 4..].to_vec();
    if headers
        .iter()
        .any(|(k, v)| k == "transfer-encoding" && v.contains("chunked"))
    {
        body = dechunk(&body);
    }
    (status, headers, body)
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let at = b.windows(2).position(|w| w == b"\r\n").unwrap();
        let size =
            usize::from_str_radix(std::str::from_utf8(&b[..at]).unwrap().trim(), 16).unwrap();
        b = &b[at + 2..];
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&b[..size]);
        b = &b[size + 2..];
    }
}

/// One recorded `call` on the server: what the recorder kept of it.
fn call(r: &Root, port: u16, step: &Value) -> Value {
    let route = step["route"].as_str().unwrap();
    let seg = match route {
        "all" => "all".to_owned(),
        _ => format!(
            "{route}/{}",
            encode_uri_component(step["id"].as_str().unwrap())
        ),
    };
    let query = step["query"]
        .as_str()
        .map(|q| format!("?{}", r.sub(q)))
        .unwrap_or_default();
    let (status, headers, body) = exchange(
        port,
        step["method"].as_str().unwrap(),
        &format!("/api/sessions/{seg}{query}"),
    );
    let header = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    let mut got = json!({"status": status, "type": header("content-type")});
    if let Some(d) = header("content-disposition") {
        got["disposition"] = json!(d);
    }
    got["body"] = json!(r.unroot(&String::from_utf8_lossy(&body)));
    got
}

/// Rebuild and replay the recorded group `name`.
fn replay(name: &str) {
    let g = group(name);
    if g["perms"] == true && is_root_user() {
        eprintln!("{name}: skipped (needs a non-root user)");
        return;
    }
    if !runs_here(&g) {
        eprintln!("{name}: skipped off macOS");
        return;
    }
    let root_len = fixture()["rootLen"].as_u64().unwrap() as usize;
    let r = Root::new(
        root_len,
        g["hashed"].as_array().map_or(&[][..], Vec::as_slice),
    );
    r.run_ops(g["ops"].as_array().unwrap());
    let server = Server::spawn(&r.world, &[]);
    let mut failures = vec![];
    for (i, step) in g["steps"].as_array().unwrap().iter().enumerate() {
        if !runs_here(step) {
            continue;
        }
        let got = match step["op"].as_str().unwrap() {
            "call" => call(&r, server.port, step),
            "tree" => r.tree(&step["path"]),
            "rows" => r.rows(step["cwd"].as_str().unwrap()),
            _ => {
                r.run_ops(std::slice::from_ref(step));
                continue;
            }
        };
        if got != step["got"] {
            failures.push(format!(
                "[{i}] {}\n  ts:   {}\n  rust: {got}",
                serde_json::to_string(&json!({
                    "op": step["op"], "route": step["route"], "method": step["method"],
                    "id": step["id"], "query": step["query"], "path": step["path"],
                }))
                .unwrap(),
                step["got"]
            ));
        }
    }
    // Leave the tree removable whatever the modes were.
    let _ = Command::new("chmod")
        .args(["-R", "u+rwX"])
        .arg(r.world.root.path())
        .status();
    assert!(
        failures.is_empty(),
        "{name}: {} of {} steps differ from TS:\n{}",
        failures.len(),
        g["steps"].as_array().unwrap().len(),
        failures.join("\n")
    );
}

#[test]
fn fixture_groups_are_all_replayed() {
    let names: Vec<String> = fixture()["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        names,
        [
            "basic",
            "odd",
            "forks",
            "relocated",
            "foreign",
            "null_workspace",
            "blob_title",
            "legacy_titles",
            "foreign_dbs",
            "accounts",
            "delete",
            "case_fold",
            "stat_denied",
            "worktrees",
            "long_paths",
            "transcripts"
        ]
    );
}

#[test]
fn basic() {
    replay("basic");
}

#[test]
fn odd_lines_and_names() {
    replay("odd");
}

#[test]
fn forks_and_continued_in() {
    replay("forks");
}

#[test]
fn relocated_cwds() {
    replay("relocated");
}

#[test]
fn foreign_rows() {
    replay("foreign");
}

#[test]
fn null_workspace_entry() {
    replay("null_workspace");
}

#[test]
fn blob_title() {
    replay("blob_title");
}

#[test]
fn legacy_titles() {
    replay("legacy_titles");
}

#[test]
fn foreign_databases() {
    replay("foreign_dbs");
}

#[test]
fn account_store_forms() {
    replay("accounts");
}

#[test]
fn deletes() {
    replay("delete");
}

#[test]
fn case_folding_disk() {
    replay("case_fold");
}

#[test]
fn stat_denied() {
    replay("stat_denied");
}

#[test]
fn git_worktrees() {
    replay("worktrees");
}

#[test]
fn long_paths() {
    replay("long_paths");
}

#[test]
fn transcript_shapes() {
    replay("transcripts");
}

/// The routes sit beside `/api/sessions/:id/*`: a live session's routes
/// still answer, the ported paths only take their TS methods, and what
/// isn't ported goes on as before.
#[test]
fn sits_beside_the_session_routes() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let id = server.create_session(&world);
    let (st, body) = http(
        server.port,
        "GET",
        &format!("/api/sessions/{id}/notification-prefs"),
        "",
    );
    assert_eq!(st, 200, "{body}");
    // A live session with nothing on disk yet: the disk routes don't see it.
    for (method, path, want) in [
        (
            "GET",
            format!("/api/sessions/info/{id}"),
            (404, r#"{"error":"session not found"}"#.to_owned()),
        ),
        (
            "GET",
            format!("/api/sessions/transcript/{id}"),
            (200, r#"{"messages":[]}"#.to_owned()),
        ),
        (
            "GET",
            format!("/api/sessions/export/{id}"),
            (200, String::new()),
        ),
        (
            "DELETE",
            format!("/api/sessions/file/{id}"),
            (
                500,
                format!(r#"{{"error":"Session {id} not found in any project directory"}}"#),
            ),
        ),
        (
            "GET",
            "/api/sessions/all".to_owned(),
            (200, r#"{"sessions":[],"accountsConfigured":0}"#.to_owned()),
        ),
    ] {
        let (st, _, body) = exchange(server.port, method, &path);
        assert_eq!(
            (st, String::from_utf8(body).unwrap()),
            want,
            "{method} {path}"
        );
    }
    // Static segments win over the session id: `info` is not a session.
    let (st, body) = http(
        server.port,
        "GET",
        "/api/sessions/info/notification-prefs",
        "",
    );
    assert_eq!(
        (st, body.as_str()),
        (404, r#"{"error":"session not found"}"#)
    );
    // Only the TS methods.
    for (method, path) in [
        ("POST", "/api/sessions/all"),
        ("DELETE", "/api/sessions/info/x"),
        ("POST", "/api/sessions/export/x"),
        ("PUT", "/api/sessions/transcript/x"),
        ("GET", "/api/sessions/file/x"),
    ] {
        let (st, _, _) = exchange(server.port, method, path);
        assert_eq!(st, 405, "{method} {path}");
    }
    // The session itself is still there, and `fork` still goes to Next.
    let (st, body) = http(
        server.port,
        "GET",
        &format!("/api/sessions/{id}/notification-prefs"),
        "",
    );
    assert_eq!(st, 200, "{body}");
    let (st, _) = http(server.port, "POST", "/api/sessions/fork", "{}");
    assert_ne!(st, 405);
    assert_ne!(st, 501);
}
