//! `GET /api/settings/export`, `POST /api/settings/import`,
//! `GET`/`DELETE /api/settings/import/:id` and
//! `POST /api/settings/import/:id/resolve` (D11) on the real `claudius`
//! binary, replayed against the `groups` `rust/scripts/settings-bundle-golden.mjs`
//! recorded from the four TS route handlers
//! (`fixtures/settings_bundle_golden.json`).
//!
//! Each group gets a fresh world rebuilt the recorder's way: a temp root
//! (through realpath, the recorder's `$ROOT`) holding `home` (`HOME` and
//! `CLAUDIUS_STATE_HOME`), `config` (`CLAUDE_CONFIG_DIR`), `project` (the
//! server's cwd), `ws1`, `ws2`, `extra` and the file `afile`, umask 022.
//! Setup ops run as recorded; each request must answer the recorded
//! status, content type and body, and change exactly the recorded watched
//! paths (kinds, modes, text or bytes, link targets) against the tree just
//! before it. The tree at the end of the group must be the recorded
//! `final`.
//!
//! What the recorder masked, the replay masks the same way: `$ROOT`, the
//! n-th generated import / workspace id (`$IMP<n>` / `$WKS<n>`, in the order
//! first seen) and the palette colours (`$COLOR`). The recorder pinned
//! `Date.now()` to `BASE + 1000` per request (counted across the groups,
//! in order); a 13-digit stamp the server wrote within a request's window
//! reads as that request's recorded `now`, here and everywhere it shows
//! up later. The export's `exportedFrom` is this machine's
//! (`gethostname`, `process.platform`), its filename the real date's, and
//! its `Content-Length` must be the body's byte length. `threw` (what the
//! TS let throw) is Next's empty 500, and its message must show up in the
//! server's log.
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use claudius_agent::js;
use claudius_core::{js_string, settings_export};
use common::{Server, World};
use serde_json::{Value, json};

const BASE: u64 = 1_700_000_000_000;
const PALETTE: [&str; 8] = [
    "#d97757", "#5588dd", "#9d6cdd", "#2e9d8f", "#dd8e44", "#cc5577", "#33aabb", "#7d8a4c",
];
const WATCH: [&str; 7] = ["home", "project", "ws1", "ws2", "extra", "afile", "config"];

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/settings_bundle_golden.json");
        js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// `os.hostname()`: `gethostname(2)`.
fn hostname() -> String {
    let mut buf = vec![0u8; 256];
    // SAFETY: `buf` is a writable allocation of `buf.len()` bytes.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    assert_eq!(rc, 0, "gethostname");
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// `process.platform`.
fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// JS `a < b` on strings: UTF-16 code units.
fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The recorder's `SKIPPED`: `/\.bak\.|\.tmp$|\.tmp-/`.
fn skipped(rel: &str) -> bool {
    rel.contains(".bak.") || rel.ends_with(".tmp") || rel.contains(".tmp-")
}

/// Every 13-digit run in `s` not glued to a word character: (start, end).
fn stamps(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let glued = (start > 0 && word(b[start - 1])) || (i < b.len() && word(b[i]));
        if i - start == 13 && !glued {
            out.push((start, i));
        }
    }
    out
}

/// `s.replace(/<prefix>[0-9a-f]{n}/g, f)`.
fn replace_ids(s: &str, prefix: &str, n: usize, mut f: impl FnMut(&str) -> String) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        if rest.starts_with(prefix) {
            let tail = &rest.as_bytes()[prefix.len()..];
            if tail.len() >= n
                && tail[..n]
                    .iter()
                    .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
            {
                out.push_str(&f(&rest[..prefix.len() + n]));
                i += prefix.len() + n;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
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

/// One group's world and what makes its output read as the recording.
struct Replay {
    world: World,
    root: String,
    imp: Vec<String>,
    wks: Vec<String>,
    /// Real stamps (13-digit text) → the recorded `now` of their request.
    times: Vec<(String, String)>,
}

impl Replay {
    /// The recorder's `buildWorld()`.
    fn new() -> Replay {
        let world = World::new();
        let root = world
            .root
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let r = Replay {
            world,
            root,
            imp: vec![],
            wks: vec![],
            times: vec![],
        };
        let w = &fixture()["world"];
        for d in w["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(r.abs(d.as_str().unwrap())).unwrap();
        }
        for f in w["files"].as_array().unwrap() {
            let p = r.abs(f[0].as_str().unwrap());
            std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
            std::fs::write(&p, r.to_real(f[1].as_str().unwrap())).unwrap();
        }
        r
    }

    fn abs(&self, rel: &str) -> String {
        format!("{}/{rel}", self.root)
    }

    /// `toReal`: `$ROOT`, then `$IMP<n>` / `$WKS<n>` as the real ids.
    fn to_real(&self, s: &str) -> String {
        let s = s.replace("$ROOT", &self.root);
        let mut out = String::with_capacity(s.len());
        let mut rest = s.as_str();
        while let Some(i) = rest.find('$') {
            out.push_str(&rest[..i]);
            let tail = &rest[i + 1..];
            let kind = ["IMP", "WKS"].into_iter().find(|k| tail.starts_with(k));
            let digits = kind.map_or(0, |k| {
                tail[k.len()..]
                    .bytes()
                    .take_while(u8::is_ascii_digit)
                    .count()
            });
            match kind {
                Some(k) if digits > 0 => {
                    let n: usize = tail[k.len()..k.len() + digits].parse().unwrap();
                    let list = if k == "IMP" { &self.imp } else { &self.wks };
                    let real = list
                        .get(n - 1)
                        .unwrap_or_else(|| panic!("${k}{n} is not allocated yet"));
                    out.push_str(real);
                    rest = &tail[k.len() + digits..];
                }
                _ => {
                    out.push('$');
                    rest = tail;
                }
            }
        }
        out.push_str(rest);
        out
    }

    /// The recorder's `normalize`, after the stamps it pinned are mapped.
    fn normalize(&mut self, text: &str) -> String {
        let mut s = String::with_capacity(text.len());
        let mut last = 0;
        for (a, b) in stamps(text) {
            if let Some((_, recorded)) = self.times.iter().find(|(real, _)| real == &text[a..b]) {
                s.push_str(&text[last..a]);
                s.push_str(recorded);
                last = b;
            }
        }
        s.push_str(&text[last..]);
        let s = s.replace(&self.root, "$ROOT");
        let s = replace_ids(&s, "imp_", 16, |m| place(&mut self.imp, "IMP", m));
        let mut s = replace_ids(&s, "wks_", 12, |m| place(&mut self.wks, "WKS", m));
        for c in PALETTE {
            s = s.replace(c, "$COLOR");
        }
        s
    }

    /// Remember every stamp in `text` that falls in `window` as `now`.
    fn learn(&mut self, text: &str, window: (u64, u64), now: u64) {
        for (a, b) in stamps(text) {
            let v: u64 = text[a..b].parse().unwrap();
            if (window.0..=window.1).contains(&v)
                && !self.times.iter().any(|(r, _)| r == &text[a..b])
            {
                self.times.push((text[a..b].to_owned(), now.to_string()));
            }
        }
    }

    /// Run one recorded setup op.
    fn apply(&self, op: &Value) {
        let p = self.abs(&self.to_real(op["path"].as_str().unwrap()));
        let res = match op["op"].as_str().unwrap() {
            "write" => {
                std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
                let data = match op["bytes"].as_array() {
                    Some(b) => b.iter().map(|x| x.as_u64().unwrap() as u8).collect(),
                    None => self.to_real(op["text"].as_str().unwrap()).into_bytes(),
                };
                std::fs::write(&p, data)
            }
            "mkdir" => std::fs::create_dir_all(&p),
            "rm" => {
                open_up(Path::new(&p));
                match std::fs::symlink_metadata(&p) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p),
                    Ok(_) => std::fs::remove_file(&p),
                    Err(_) => Ok(()),
                }
            }
            "symlink" => {
                std::os::unix::fs::symlink(self.to_real(op["target"].as_str().unwrap()), &p)
            }
            "chmod" => std::fs::set_permissions(
                &p,
                std::fs::Permissions::from_mode(op["mode"].as_u64().unwrap() as u32),
            ),
            other => panic!("unknown setup op {other}"),
        };
        res.unwrap_or_else(|e| panic!("{op}: {e}"));
    }

    /// The recorder's `snapshot()`: every watched path (real, relative to
    /// the root) → its entry.
    fn snapshot(&self) -> BTreeMap<String, Value> {
        let mut snap = BTreeMap::new();
        for w in WATCH {
            self.visit(w, &mut snap);
        }
        snap
    }

    fn visit(&self, rel: &str, snap: &mut BTreeMap<String, Value>) {
        if skipped(rel) {
            return;
        }
        let abs = self.abs(rel);
        let Ok(m) = std::fs::symlink_metadata(&abs) else {
            return;
        };
        let mode = m.permissions().mode() & 0o777;
        if m.is_symlink() {
            let target = std::fs::read_link(&abs).unwrap();
            let target = target.to_string_lossy().replace(&self.root, "$ROOT");
            snap.insert(rel.to_owned(), json!({"kind": "symlink", "target": target}));
        } else if m.is_dir() {
            snap.insert(rel.to_owned(), json!({"kind": "dir", "mode": mode}));
            let Ok(dir) = std::fs::read_dir(&abs) else {
                return;
            };
            let mut names: Vec<String> = dir
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort_by(|a, b| js_cmp(a, b));
            for n in names {
                self.visit(&format!("{rel}/{n}"), snap);
            }
        } else {
            let entry = match std::fs::read(&abs) {
                Err(_) => json!({"kind": "file", "mode": mode}),
                Ok(buf) => match String::from_utf8(buf) {
                    Ok(text) => json!({"kind": "file", "mode": mode, "text": text}),
                    Err(e) => json!({"kind": "file", "mode": mode, "bytes": e.into_bytes()}),
                },
            };
            snap.insert(rel.to_owned(), entry);
        }
    }

    /// An entry as the recorder printed it: `JSON.parse(normalize(JSON.stringify(e)))`.
    fn entry(&mut self, e: &Value) -> Value {
        js_string::parse(&self.normalize(&js::stringify(e))).unwrap()
    }

    /// The recorder's `changes(before, after)`.
    fn changes(
        &mut self,
        before: &BTreeMap<String, Value>,
        after: &BTreeMap<String, Value>,
    ) -> Value {
        let mut keys: Vec<&String> = before.keys().chain(after.keys()).collect();
        keys.sort_by(|a, b| js_cmp(a, b));
        keys.dedup();
        let mut diffs: Vec<(String, Value)> = Vec::new();
        for k in keys {
            let (b, a) = (before.get(k), after.get(k));
            if b.map(js::stringify) == a.map(js::stringify) {
                continue;
            }
            let key = self.normalize(k);
            let v = a.map_or(Value::Null, |a| self.entry(a));
            diffs.push((key, v));
        }
        diffs.sort_by(|a, b| js_cmp(&a.0, &b.0));
        Value::Array(diffs.into_iter().map(|(k, v)| json!([k, v])).collect())
    }

    /// The recorder's `final`.
    fn final_tree(&mut self) -> Value {
        let snap = self.snapshot();
        let mut pairs: Vec<(String, Value)> = Vec::new();
        for (k, v) in &snap {
            let key = self.normalize(k);
            let v = self.entry(v);
            pairs.push((key, v));
        }
        pairs.sort_by(|a, b| js_cmp(&a.0, &b.0));
        Value::Object(pairs.into_iter().collect())
    }

    fn spawn(&self) -> Server {
        let home = self.abs("home");
        let config = self.abs("config");
        Server::spawn(
            &self.world,
            &[
                ("CLAUDIUS_STATE_HOME", &home),
                ("HOME", &home),
                ("CLAUDE_CONFIG_DIR", &config),
                ("TZ", "UTC"),
            ],
        )
    }
}

impl Drop for Replay {
    fn drop(&mut self) {
        open_up(Path::new(&self.root));
    }
}

/// `place(kind, id)`: the id's `$<KIND><n>`, allocating the next `n`.
fn place(list: &mut Vec<String>, kind: &str, id: &str) -> String {
    let at = match list.iter().position(|x| x == id) {
        Some(i) => i,
        None => {
            list.push(id.to_owned());
            list.len() - 1
        }
    };
    format!("${kind}{}", at + 1)
}

/// A response: status, headers (lower-cased names), body.
struct Got {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn request(port: u16, method: &str, target: &str, ctype: Option<&str>, body: &[u8]) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let ct = ctype.map_or(String::new(), |t| format!("Content-Type: {t}\r\n"));
    write!(
        s,
        "{method} {target} HTTP/1.1\r\nHost: localhost\r\n{ct}Content-Length: {}\r\nConnection: close\r\n\r\n",
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
    assert!(
        !headers.contains_key("transfer-encoding"),
        "chunked answer: {head}"
    );
    Got {
        status,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

/// The TS route a URL lands on, as the server logs it.
fn route_of(url: &str) -> &'static str {
    let path = url.split('?').next().unwrap();
    if path == "/api/settings/export" {
        "settings/export"
    } else if path == "/api/settings/import" {
        "settings/import"
    } else if path.ends_with("/resolve") {
        "settings/import/[id]/resolve"
    } else {
        "settings/import/[id]"
    }
}

fn replay(name: &str) {
    let groups = fixture()["groups"].as_array().unwrap();
    let gi = groups
        .iter()
        .position(|g| g["name"] == name)
        .unwrap_or_else(|| panic!("no group {name}"));
    let group = &groups[gi];
    // The recorder's clock moves 1000 per request, across the groups.
    let mut clock = BASE
        + 1000
            * groups[..gi]
                .iter()
                .flat_map(|g| g["steps"].as_array().unwrap())
                .filter(|s| s.get("request").is_some())
                .count() as u64;
    let from_here = format!(
        "\"exportedFrom\": {{\n    \"hostname\": {},\n    \"platform\": {}\n  }}",
        js::stringify(&json!(hostname())),
        js::stringify(&json!(platform())),
    );
    let as_recorded = format!(
        "\"exportedFrom\": {{\n    \"hostname\": {},\n    \"platform\": {}\n  }}",
        js::stringify(&fixture()["host"]),
        js::stringify(&fixture()["platform"]),
    );

    unsafe { libc::umask(0o022) };
    let mut r = Replay::new();
    let mut server: Option<Server> = None;
    let mut threw: Vec<(&str, String)> = vec![];
    let mut failures: Vec<String> = vec![];
    let steps = group["steps"].as_array().unwrap();
    let mut label = String::new();
    for (i, step) in steps.iter().enumerate() {
        if let Some(ops) = step.get("setup") {
            if let Some(l) = step["label"].as_str() {
                label = l.to_owned();
            }
            for op in ops.as_array().unwrap() {
                r.apply(op);
            }
            continue;
        }
        clock += 1000;
        let req = &step["request"];
        let method = req["method"].as_str().unwrap();
        let url = r.to_real(req["url"].as_str().unwrap());
        let body: Vec<u8> = match (req["body"].as_str(), req["bodyBytes"].as_array()) {
            (Some(b), _) => r.to_real(b).into_bytes(),
            (_, Some(b)) => b.iter().map(|x| x.as_u64().unwrap() as u8).collect(),
            _ => Vec::new(),
        };
        let port = server.get_or_insert_with(|| r.spawn()).port;
        let before = r.snapshot();
        let t0 = now_ms();
        let got = request(port, method, &url, req["type"].as_str(), &body);
        let t1 = now_ms();
        let after = r.snapshot();
        // Keep the next request's window clear of this one's.
        while now_ms() <= t1 {
            std::thread::sleep(Duration::from_millis(1));
        }
        let text = String::from_utf8_lossy(&got.body).into_owned();
        r.learn(&text, (t0, t1), clock);
        for e in after.values() {
            r.learn(&js::stringify(e), (t0, t1), clock);
        }
        let want = &step["got"];
        let what = format!("#{i} [{label}] {method} {}", req["url"].as_str().unwrap());
        if let Some(msg) = want["threw"].as_str() {
            // `<name>: <message>`; the message is what the log must carry.
            let msg = msg.split_once(": ").map_or(msg, |(_, m)| m);
            threw.push((route_of(&url), r.to_real(msg)));
            if got.status != 500 || !got.body.is_empty() || got.headers.contains_key("content-type")
            {
                failures.push(format!(
                    "{what}: want the empty 500 ({})\n      got {} {:?} {text:?}",
                    want["threw"], got.status, got.headers
                ));
            }
        } else {
            let body = r.normalize(&text.replace(&from_here, &as_recorded));
            let ctype = got.headers.get("content-type").map(String::as_str);
            let mut ok = want["status"] == got.status
                && want["type"].as_str() == ctype
                && want["body"].as_str() == Some(body.as_str());
            match want["disposition"].as_str() {
                Some(d) => {
                    // The filename is the `exportedAt` day: the recorded
                    // one for the recording, the real one here.
                    let real_at = js_string::parse(&text).unwrap()["exportedAt"]
                        .as_f64()
                        .unwrap();
                    let name_at = |at: f64| {
                        format!(
                            "attachment; filename=\"{}\"",
                            settings_export::suggested_filename(at)
                        )
                    };
                    ok &= d == name_at(clock as f64)
                        && got.headers.get("content-disposition") == Some(&name_at(real_at));
                }
                None => ok &= !got.headers.contains_key("content-disposition"),
            }
            if want.get("length").is_some() {
                ok &= got.headers.get("content-length") == Some(&got.body.len().to_string());
            }
            if !ok {
                failures.push(format!(
                    "{what}: want {want}\n      got {} {:?} {body:?}",
                    got.status, got.headers
                ));
            }
        }
        let changes = r.changes(&before, &after);
        if changes != step["changes"] {
            failures.push(format!(
                "{what}: changes\n      want {}\n      got  {changes}",
                step["changes"]
            ));
        }
    }
    let fin = r.final_tree();
    if fin != group["final"] {
        let (want, got) = (
            group["final"].as_object().unwrap(),
            fin.as_object().unwrap(),
        );
        for k in want.keys().chain(got.keys()) {
            if want.get(k) != got.get(k) {
                failures.push(format!(
                    "final {k}:\n      want {:?}\n      got  {:?}",
                    want.get(k),
                    got.get(k)
                ));
            }
        }
    }
    let log = match server {
        Some(s) => s.stop(Duration::from_secs(20)).1,
        None => String::new(),
    };
    for (route, msg) in &threw {
        let tag = format!("[api/{route}] ");
        if !log
            .lines()
            .any(|l| l.contains(&tag) && l.contains(msg.as_str()))
        {
            failures.push(format!("the server doesn't log {tag}…{msg:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{name}: {} differences in {} steps:\n{}\n--- server log ---\n{log}",
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
    assert_eq!(
        names,
        [
            "export",
            "validate",
            "multipart",
            "system",
            "flow",
            "tamper"
        ]
    );
}

#[test]
fn export() {
    replay("export");
}

#[test]
fn validate() {
    replay("validate");
}

#[test]
fn multipart() {
    replay("multipart");
}

#[test]
fn system() {
    replay("system");
}

#[test]
fn flow() {
    replay("flow");
}

#[test]
fn tamper() {
    replay("tamper");
}

/// Only the methods the TS exports are mounted: the others are axum's 405,
/// and a path under them that isn't a route goes to Next (here the
/// `--no-next` proxy's 404).
#[test]
fn only_the_ported_methods_are_mounted() {
    unsafe { libc::umask(0o022) };
    let r = Replay::new();
    let server = r.spawn();
    for (method, url, status) in [
        ("POST", "/api/settings/export", 405),
        ("PUT", "/api/settings/export", 405),
        ("DELETE", "/api/settings/export", 405),
        ("GET", "/api/settings/import", 405),
        ("DELETE", "/api/settings/import", 405),
        ("POST", "/api/settings/import/imp_0000000000000000", 405),
        ("PUT", "/api/settings/import/imp_0000000000000000", 405),
        (
            "GET",
            "/api/settings/import/imp_0000000000000000/resolve",
            405,
        ),
        ("GET", "/api/settings/export/x", 404),
        ("GET", "/api/settings/import/a/b", 404),
        ("POST", "/api/settings/import/a/resolve/x", 404),
    ] {
        let got = request(server.port, method, url, None, b"");
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
