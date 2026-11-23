//! `/api/skills` (+ `:name`), `/api/hooks` (+ `/disabled`),
//! `/api/keybindings` and `/api/claudemd` (D12) against the real binary,
//! replaying the TS handlers' recorded groups
//! (`claudius-core/tests/fixtures/skills_hooks_golden.json`, recorded by
//! `rust/scripts/skills-hooks-golden.mjs`) in order, one world and one
//! server per group. The server runs with its cwd at `<root>/project` (the
//! first trusted root), `CLAUDIUS_STATE_HOME` at `<root>/home` (the home
//! dir) and umask 022, like the recorder.
//!
//! Each request checks the status, content type and body byte for byte
//! (`threw` is Next's empty 500, whose error the server must log: its first
//! line, as V8's circular-JSON message runs on) and every watched path the
//! request changed (kind, mode, text or bytes, symlink target), and each
//! group's tree at the end.
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use claudius_core::js_string;
use common::{Server, free_port, wait_until};
use serde_json::{Value, json};

fn fixture() -> Value {
    js_string::parse(include_str!(
        "../../claudius-core/tests/fixtures/skills_hooks_golden.json"
    ))
    .unwrap()
}

/// Requests (group, a substring of the recorded URL or body) where Rust
/// differs, the recorded text rewritten to what Rust sends or writes (in the
/// body and in the changed files), and why. Each must still differ before
/// the rewrite, so a fix shows up here.
type Gap = (
    &'static str,
    &'static str,
    (&'static str, &'static str),
    &'static str,
);
const GAPS: &[Gap] = &[
    (
        "hooks settings files",
        "lone in the file",
        (r"\ud800", "\u{FFFD}"),
        "settings files are read as JSON.parse reads them but a lone surrogate escape \
         becomes U+FFFD (settings.rs), so a rewrite writes the character where TS writes \
         the `\\ud800` escape back",
    ),
    (
        "hooks settings files",
        r"x\udc00",
        (r"\udc00", "\u{FFFD}"),
        "a lone surrogate escape in the POSTed group reads as U+FFFD, so the settings file \
         gets the character where TS writes the escape",
    ),
    (
        "hooks settings files",
        "cwd=$ROOT%2Fproject",
        (
            r#""path":"$ROOT/project/.claude/settings.json","disableAllHooks":true"#,
            r#""path":"$ROOT/project/.claude/settings.json","disableAllHooks":false"#,
        ),
        "`disableAllHooks: 1e400` in a settings file is Infinity (truthy) in JS but reads \
         as null (settings.rs keeps no Infinity)",
    ),
];

const WATCH: [&str; 8] = [
    "home/.claude",
    "project",
    "ws",
    "untrusted",
    "outside",
    "dotfile",
    "config",
    "caf\u{e9} x\u{1f600}",
];

struct World {
    _dir: tempfile::TempDir,
    root: String,
}

impl World {
    fn new(layout: &Value) -> World {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        assert!(
            root.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b)),
            "placeholders are swapped textually: {root}"
        );
        let w = World { _dir: dir, root };
        for d in layout["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(w.path(d.as_str().unwrap())).unwrap();
        }
        for f in layout["files"].as_array().unwrap() {
            let p = w.path(f[0].as_str().unwrap());
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, w.sub(f[1].as_str().unwrap())).unwrap();
        }
        w
    }

    fn path(&self, rel: &str) -> PathBuf {
        PathBuf::from(format!("{}/{}", self.root, self.sub(rel)))
    }

    fn sub(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    /// `$ROOT` back in, and `writeSettings`' temp names masked.
    fn rel(&self, s: &str) -> String {
        mask_tmp(&s.replace(&self.root, "$ROOT"))
    }

    fn apply(&self, op: &Value) {
        let p = self.path(op["path"].as_str().unwrap());
        match op["op"].as_str().unwrap() {
            "write" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let bytes = match op.get("bytes") {
                    Some(b) => b
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_u64().unwrap() as u8)
                        .collect(),
                    None => self.sub(op["text"].as_str().unwrap()).into_bytes(),
                };
                std::fs::write(p, bytes).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(p).unwrap(),
            "rm" => {
                open_up(&p);
                match std::fs::symlink_metadata(&p) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(p).unwrap(),
                    Ok(_) => std::fs::remove_file(p).unwrap(),
                    Err(_) => {}
                }
            }
            "symlink" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(self.sub(op["target"].as_str().unwrap()), p).unwrap()
            }
            "chmod" => std::fs::set_permissions(
                p,
                std::fs::Permissions::from_mode(op["mode"].as_u64().unwrap() as u32),
            )
            .unwrap(),
            other => panic!("unknown op {other}"),
        }
    }

    /// The recorder's `snapshot()`.
    fn snapshot(&self) -> BTreeMap<String, Value> {
        let mut snap = BTreeMap::new();
        for rel in WATCH {
            self.visit(rel, &mut snap);
        }
        snap
    }

    fn visit(&self, rel: &str, snap: &mut BTreeMap<String, Value>) {
        if snap.contains_key(rel) || rel == "home/.claude/.claudius" {
            return;
        }
        let abs = self.path(rel);
        let Ok(meta) = std::fs::symlink_metadata(&abs) else {
            return;
        };
        let mode = meta.permissions().mode() & 0o777;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&abs).unwrap().display().to_string();
            snap.insert(
                rel.into(),
                json!({"kind": "symlink", "target": self.rel(&target)}),
            );
        } else if meta.is_dir() {
            let mut entry = json!({"kind": "dir", "mode": mode});
            let names = match std::fs::read_dir(&abs) {
                Ok(rd) => {
                    let mut names: Vec<String> = rd
                        .map(|e| e.unwrap().file_name().into_string().unwrap())
                        .collect();
                    js_sort(&mut names);
                    names
                }
                Err(_) => {
                    entry["unreadable"] = json!(true);
                    Vec::new()
                }
            };
            snap.insert(rel.into(), entry);
            for n in names {
                self.visit(&format!("{rel}/{}", self.rel(&n)), snap);
            }
        } else {
            let entry = match std::fs::read(&abs) {
                Err(_) => json!({"kind": "file", "mode": mode, "unreadable": true}),
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => json!({"kind": "file", "mode": mode, "text": self.rel(&text)}),
                    Err(e) => json!({"kind": "file", "mode": mode, "bytes": e.into_bytes()}),
                },
            };
            snap.insert(rel.into(), entry);
        }
    }
}

/// `.tmp-<pid>-<n>` as `.tmp-PID-N`.
fn mask_tmp(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(".tmp-") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 5..];
        let pid = after.bytes().take_while(u8::is_ascii_digit).count();
        let tail = &after[pid..];
        let n = tail
            .strip_prefix('-')
            .map_or(0, |t| t.bytes().take_while(u8::is_ascii_digit).count());
        if pid > 0 && n > 0 {
            out.push_str(".tmp-PID-N");
            rest = &tail[1 + n..];
        } else {
            out.push_str(".tmp-");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// chmod every directory under `p` back to 0755, so it can be removed.
fn open_up(p: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(p) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    if std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).is_err() {
        return;
    }
    for e in std::fs::read_dir(p).unwrap() {
        open_up(&e.unwrap().path());
    }
}

/// JS's default `sort()`: by UTF-16 code units.
fn js_sort(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// The recorder's `changes`.
fn changes(before: &BTreeMap<String, Value>, after: &BTreeMap<String, Value>) -> Value {
    let mut keys: Vec<String> = before.keys().chain(after.keys()).cloned().collect();
    js_sort(&mut keys);
    keys.dedup();
    Value::Array(
        keys.into_iter()
            .filter(|k| before.get(k) != after.get(k))
            .map(|k| json!([k, after.get(&k).cloned().unwrap_or(Value::Null)]))
            .collect(),
    )
}

/// `v` with `from` replaced by `to` in every string.
fn rewrite(v: &Value, from: &str, to: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(from, to)),
        Value::Array(a) => Value::Array(a.iter().map(|x| rewrite(x, from, to)).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| (k.clone(), rewrite(x, from, to)))
                .collect(),
        ),
        v => v.clone(),
    }
}

/// `claudius` for one world under umask 022, with the fake CLI.
fn spawn(world: &World) -> Server {
    let port = free_port();
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg("umask 022 && exec \"$0\" \"$@\"")
        .arg(common::server_bin())
        .args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
        .arg(common::fake_bin())
        .current_dir(world.path("project"))
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_DEV")
        .env_remove("CLAUDIUS_SCHEDULER")
        .env("CLAUDIUS_STATE_HOME", world.path("home"))
        .env("CLAUDE_CONFIG_DIR", world.path("config"))
        .stdout(std::fs::File::create(world.path("server.out")).unwrap())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().unwrap();
    wait_until("health", Duration::from_secs(20), || {
        if let Ok(Some(st)) = child.try_wait() {
            panic!("claudius exited ({st})");
        }
        TcpStream::connect(("127.0.0.1", port)).is_ok()
            && request(port, "GET", "/api/rust/health", None).0 == 200
    });
    Server { child, port }
}

/// One HTTP/1.1 request → (status, content type, body).
fn request(
    port: u16,
    method: &str,
    url: &str,
    body: Option<&str>,
) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let body = body.unwrap_or("");
    write!(
        s,
        "{method} {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8(raw).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let ctype = lines.find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, ctype, body.to_owned())
}

/// The server's output from byte `from` on.
fn output_since(path: &Path, from: usize) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    String::from_utf8_lossy(bytes.get(from..).unwrap_or_default()).into_owned()
}

/// `(status, content type, body)` of a recorded `got`; `threw` is Next's
/// empty 500.
fn expected(got: &Value) -> (u16, Option<String>, String) {
    if got.get("threw").is_some() {
        return (500, None, String::new());
    }
    (
        got["status"].as_u64().unwrap() as u16,
        got["type"].as_str().map(str::to_owned),
        got["body"].as_str().unwrap().to_owned(),
    )
}

fn perm_enforced() -> bool {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("probe");
    std::fs::create_dir(&p).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o0)).unwrap();
    let enforced = std::fs::read_dir(&p).is_err();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    enforced
}

/// A run's tally: requests replayed, and the gaps that still differ.
#[derive(Default)]
struct Tally {
    requests: usize,
    gaps_differing: Vec<(String, String)>,
}

fn replay_group(fx: &Value, group: &Value, tally: &mut Tally) {
    let name = group["name"].as_str().unwrap();
    let world = World::new(&fx["world"]);
    let out = world.path("server.out");
    let server = spawn(&world);

    for (i, step) in group["steps"].as_array().unwrap().iter().enumerate() {
        if let Some(ops) = step.get("setup") {
            for op in ops.as_array().unwrap() {
                world.apply(op);
            }
            continue;
        }
        tally.requests += 1;
        let req = &step["request"];
        let method = req["method"].as_str().unwrap();
        let url = world.sub(req["url"].as_str().unwrap());
        let body = req.get("body").map(|b| world.sub(b.as_str().unwrap()));
        let before = world.snapshot();
        let out_from = std::fs::metadata(&out).map_or(0, |m| m.len() as usize);
        let (status, ctype, text) = request(server.port, method, &url, body.as_deref());
        let after = world.snapshot();
        let what = format!(
            "{name} step {i}: {method} {} {}",
            req["url"],
            req.get("body").unwrap_or(&Value::Null)
        );

        let mut want = expected(&step["got"]);
        let mut want_changes = step["changes"].clone();
        let got = (status, ctype, world.rel(&text));
        let got_changes = changes(&before, &after);
        let request_text = format!(
            "{} {}",
            req["url"].as_str().unwrap(),
            req["body"].as_str().unwrap_or("")
        );
        for (g, marker, (from, to), _) in GAPS {
            if *g != name || !request_text.contains(marker) {
                continue;
            }
            if got != want || got_changes != want_changes {
                tally
                    .gaps_differing
                    .push((g.to_string(), marker.to_string()));
            }
            want.2 = want.2.replace(from, to);
            want_changes = rewrite(&want_changes, from, to);
        }
        assert_eq!(got, want, "{what}");
        if let Some(t) = step["got"]["threw"].as_str() {
            let first = t.lines().next().unwrap();
            let logged = world.rel(&output_since(&out, out_from));
            assert!(
                logged.contains(&format!("] {first}\n")),
                "{what}: the server logs {first:?}:\n{logged}"
            );
        }
        assert_eq!(got_changes, want_changes, "{what}: changed");
    }
    let end: BTreeMap<String, Value> = group["final"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let mut end_want = Value::Object(end.into_iter().collect());
    for (g, _, (from, to), _) in GAPS {
        if *g == name {
            end_want = rewrite(&end_want, from, to);
        }
    }
    let end_got = Value::Object(world.snapshot().into_iter().collect());
    assert_eq!(end_got, end_want, "{name}: the tree at the end");
    drop(server);
    open_up(Path::new(&world.root));
}

#[test]
fn the_routes_replay_the_ts_handlers() {
    let fx = fixture();
    let perm = perm_enforced();
    let mut tally = Tally::default();
    let mut ran = 0;
    for group in fx["routes"].as_array().unwrap() {
        if group["skipped"] == true {
            continue;
        }
        let needs_perm = group["needs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n == "perm");
        if needs_perm && !perm {
            continue;
        }
        ran += 1;
        replay_group(&fx, group, &mut tally);
    }
    for (g, marker, _, why) in GAPS {
        assert!(
            tally
                .gaps_differing
                .iter()
                .any(|(dg, dm)| dg == g && dm == marker),
            "stale gap {g} / {marker}: {why}"
        );
    }
    let skipped_perm = if perm { 0 } else { 4 };
    assert_eq!(ran, 11 - skipped_perm, "groups run");
    assert!(tally.requests >= 300, "{} requests", tally.requests);
    println!("{} recorded requests replayed", tally.requests);
}
