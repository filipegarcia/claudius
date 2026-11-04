//! `GET`/`PUT /api/customize-settings` and `GET /api/customize/runtime`
//! (D16) on the real `claudius` binary against what
//! `rust/scripts/customize-golden.mjs` recorded from the TS route handlers
//! (`fixtures/customize_golden.json`).
//!
//! Each group gets a fresh world rebuilt the recorder's way: a temp root
//! (through realpath, the recorder's `$ROOT`) holding `home`
//! (`CLAUDIUS_STATE_HOME` and `HOME`), `config` (`CLAUDE_CONFIG_DIR`) and
//! `project` (the server's cwd), umask 022. Steps run in order: `fs` ops
//! rebuild the recorder's setup, `req`s go out as raw HTTP/1.1 and must
//! match the recorded status, content type and body, and after every step
//! the settings file's text and the whole `.claude` listing (kinds, modes,
//! bytes, link targets) must look as the recorder saw them. `threw` is what
//! the TS let throw: Next's empty 500, and the message must show up in the
//! server's log. A `live` step is a new `$CLAUDIUS_LIVE_SOURCE`, which the
//! process reads once, so it restarts the server. The `perms` group runs
//! only where permissions are enforced (not root).
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use claudius_core::customize_settings::DEFAULT_AUTO_FIX_PROMPT;
use claudius_core::js_string;
use common::{Server, World};
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/customize_golden.json");
        js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// The default prompt as the recorder wrote it into a body (`$DEFAULT` is
/// its JSON text, quotes aside).
fn default_text() -> String {
    let quoted = js_string::stringify(&json!(DEFAULT_AUTO_FIX_PROMPT));
    quoted[1..quoted.len() - 1].to_owned()
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

/// chmod every directory under `p` back to 0755, so it can be read and
/// removed.
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

/// A world: the temp dir and its realpath (the recorder's `$ROOT`).
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
        Root { world, root }
    }

    fn claude(&self) -> String {
        format!("{}/home/.claude", self.root)
    }

    fn settings_file(&self) -> String {
        format!("{}/.claudius/customize-settings.json", self.claude())
    }

    /// The recorder's placeholders, in its order.
    fn place(&self, s: &str) -> String {
        s.replace("$FILE", &self.settings_file())
            .replace("$CLAUDIUS", &format!("{}/.claudius", self.claude()))
            .replace("$CLAUDE", &self.claude())
            .replace(
                "$CUSTx",
                &format!("{}/.claudius/customizationsx", self.claude()),
            )
            .replace(
                "$CUST",
                &format!("{}/.claudius/customizations", self.claude()),
            )
            .replace("$ROOT", &self.root)
    }

    fn fake(&self, s: &str) -> String {
        s.replace(&self.root, "$ROOT")
    }

    /// Run one recorded `fs` op.
    fn apply(&self, s: &Value) {
        let p = PathBuf::from(self.place(s["path"].as_str().unwrap()));
        let res = match s["act"].as_str().unwrap() {
            "mkdir" => std::fs::create_dir_all(&p),
            "write" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let data = match s["hex"].as_str() {
                    Some(h) => unhex(h),
                    None => self.place(s["text"].as_str().unwrap()).into_bytes(),
                };
                std::fs::write(&p, data)
            }
            "symlink" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(self.place(s["target"].as_str().unwrap()), &p)
            }
            "chmod" => std::fs::set_permissions(
                &p,
                std::fs::Permissions::from_mode(s["mode"].as_u64().unwrap() as u32),
            ),
            "rm" => {
                open_up(&p);
                match std::fs::symlink_metadata(&p) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p),
                    Ok(_) => std::fs::remove_file(&p),
                    Err(_) => Ok(()),
                }
            }
            other => panic!("unknown fs op {other}"),
        };
        res.unwrap_or_else(|e| panic!("{s}: {e}"));
    }

    /// The server with `$CLAUDIUS_LIVE_SOURCE` as the step left it.
    fn spawn(&self, live: Option<&str>) -> Server {
        let home = format!("{}/home", self.root);
        let mut env = vec![
            ("CLAUDIUS_STATE_HOME", home.clone()),
            ("HOME", home),
            ("TZ", "UTC".to_owned()),
        ];
        if let Some(v) = live {
            env.push(("CLAUDIUS_LIVE_SOURCE", v.to_owned()));
        }
        let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
        Server::spawn(&self.world, &env)
    }

    /// The recorder's `file`: the settings file's text (lossy, as Node's
    /// `readFile(…, "utf8")`), or `null`.
    fn file(&self) -> Value {
        match std::fs::read(self.settings_file()) {
            Ok(b) => json!(self.fake(&String::from_utf8_lossy(&b))),
            Err(_) => Value::Null,
        }
    }

    /// The recorder's `tree` of `.claude`.
    fn tree(&self) -> Value {
        self.tree_of(Path::new(&self.claude()))
    }

    fn tree_of(&self, p: &Path) -> Value {
        let Ok(m) = std::fs::symlink_metadata(p) else {
            return Value::Null;
        };
        if m.is_symlink() {
            let target = std::fs::read_link(p).unwrap();
            return json!(format!("l>{}", self.fake(&target.to_string_lossy())));
        }
        let mode = format!("{:03o}", m.permissions().mode() & 0o7777);
        if !m.is_dir() {
            return match std::fs::read(p) {
                Ok(b) => json!(format!("{mode}:{}", hex(&b))),
                Err(_) => json!("f!"),
            };
        }
        let Ok(dir) = std::fs::read_dir(p) else {
            return json!("d!");
        };
        let mut names: Vec<_> = dir
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let mut out = serde_json::Map::new();
        out.insert(String::new(), json!(mode));
        for n in names {
            out.insert(self.fake(&n), self.tree_of(&p.join(&n)));
        }
        Value::Object(out)
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        open_up(Path::new(&self.root));
    }
}

/// A response: status, content type, every other header name, the body.
struct Got {
    status: u16,
    content_type: Option<String>,
    others: Vec<String>,
    body: Vec<u8>,
}

fn request(port: u16, method: &str, target: &str, body: &[u8]) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    write!(
        s,
        "{method} {target} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .unwrap();
    s.write_all(body).unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a header block");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
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
    // The hop-by-hop headers axum adds aren't the recorder's business.
    let others = headers
        .keys()
        .filter(|k| !["content-type", "content-length", "date", "connection"].contains(&k.as_str()))
        .cloned()
        .collect();
    Got {
        status,
        content_type: headers.get("content-type").cloned(),
        others,
        body: raw[split + 4..].to_vec(),
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
    let default = default_text();
    let mut live: Option<String> = None;
    let mut server: Option<Server> = None;
    let mut threw: Vec<String> = vec![];
    let mut failures = vec![];
    let mut file = Value::Null;
    let mut tree = Value::Null;
    let steps = group["steps"].as_array().unwrap();
    for (i, step) in steps.iter().enumerate() {
        match step["op"].as_str().unwrap() {
            "fs" => root.apply(step),
            "live" => {
                // The live source dir is read once per process.
                drop(server.take());
                live = Some(root.place(step["value"].as_str().unwrap()));
            }
            "req" => {
                let port = server
                    .get_or_insert_with(|| root.spawn(live.as_deref()))
                    .port;
                let method = step["method"].as_str().unwrap();
                let url = step["url"].as_str().unwrap();
                let body = match (step["body"].as_str(), step["bodyHex"].as_str()) {
                    (Some(b), _) => root.place(b).into_bytes(),
                    (_, Some(h)) => unhex(h),
                    _ => Vec::new(),
                };
                let got = request(port, method, url, &body);
                let want = &step["got"];
                let ok = if let Some(msg) = want["threw"].as_str() {
                    threw.push(root.place(msg));
                    got.status == 500 && got.body.is_empty() && got.content_type.is_none()
                } else {
                    let body = root.fake(&String::from_utf8_lossy(&got.body));
                    want["status"] == got.status
                        && want["type"].as_str() == got.content_type.as_deref()
                        && want["headers"].as_array().map(Vec::len).unwrap_or(0) == got.others.len()
                        && want["body"].as_str().unwrap().replace("$DEFAULT", &default) == body
                };
                if !ok {
                    failures.push(format!(
                        "#{i} {method} {url}: want {want}\n      got {} {:?} {:?} {:?}",
                        got.status,
                        got.content_type,
                        got.others,
                        String::from_utf8_lossy(&got.body)
                    ));
                }
            }
            other => panic!("unknown op {other}"),
        }
        if let Some(f) = step.get("file") {
            file = f.clone();
        }
        if let Some(t) = step.get("tree") {
            tree = t.clone();
        }
        let (gf, gt) = (root.file(), root.tree());
        if gf != file {
            failures.push(format!(
                "#{i} {step}: file\n      want {file}\n      got  {gf}"
            ));
            file = gf;
        }
        if gt != tree {
            failures.push(format!(
                "#{i} {step}: tree\n      want {tree}\n      got  {gt}"
            ));
            tree = gt;
        }
    }
    let log = match server {
        Some(s) => s.stop(Duration::from_secs(20)).1,
        None => String::new(),
    };
    let route = if name == "runtime" {
        "customize/runtime"
    } else {
        "customize-settings"
    };
    for msg in &threw {
        let line = format!("[api/{route}] {msg}");
        if !log.contains(&line) {
            failures.push(format!("the server doesn't log {line:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{name}: {} of {} steps differ:\n{}\n--- server log ---\n{log}",
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
    assert_eq!(names, ["settings", "perms", "runtime"]);
}

#[test]
fn settings() {
    replay("settings");
}

#[test]
fn perms() {
    replay("perms");
}

#[test]
fn runtime() {
    replay("runtime");
}

/// Only the methods the TS exports are mounted; everything else goes to
/// Next (here the `--no-next` proxy's 404).
#[test]
fn only_the_ported_methods_are_mounted() {
    let root = Root::new();
    let server = root.spawn(None);
    for (method, url, status) in [
        ("POST", "/api/customize-settings", 405),
        ("DELETE", "/api/customize-settings", 405),
        ("PATCH", "/api/customize-settings", 405),
        ("PUT", "/api/customize/runtime", 405),
        ("POST", "/api/customize/runtime", 405),
        ("GET", "/api/customize-settings/x", 404),
        ("GET", "/api/customize/runtime/x", 404),
        ("GET", "/api/customize", 404),
    ] {
        let got = request(server.port, method, url, b"");
        assert_eq!(got.status, status, "{method} {url}");
        if status == 404 {
            assert_eq!(
                String::from_utf8_lossy(&got.body),
                "not found (no Next upstream configured)",
                "{method} {url}"
            );
        }
    }
}
