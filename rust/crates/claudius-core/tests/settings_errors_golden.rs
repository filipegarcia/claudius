//! Replays `fixtures/settings_errors_golden.json`, recorded from the real TS
//! by `rust/scripts/settings-errors-golden.mjs`:
//! - `errorMap` / `unknown` / `fsErrors`: libuv's names and descriptions and
//!   raw `fs.promises` failures, against `node_err`;
//! - `sanitize`: `sanitizeJsonParseReason`, on its own and on V8's
//!   `JSON.parse` messages;
//! - `read` / `write`: `readSettings` / `writeSettings` on malformed files
//!   and unwritable paths, each case's tree recreated under a temp root and
//!   compared after the call;
//! - `callers`: the TS settings readers and writers (`setOutputStyle`,
//!   `persistModelToUserSettings`, `enforceAdvisorModelCompatibility`, the
//!   advisor route, `setPermissionMode`, `requestRecap`) against their Rust
//!   counterparts.
//!
//! Plus `start()` failing on a `null` settings.json (the message recorded by
//! the spinner-tips golden).
#![cfg(unix)]

use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier, LazyLock, OnceLock};

use claudius_agent::js;
use claudius_core::node_err::{self, NodeError};
use claudius_core::paths;
use claudius_core::session::{RuntimeOptions, Session, SessionOptions};
use claudius_core::session_manager::{CreateError, SessionManager};
use claudius_core::settings::{self, Scope, SettingsError};
use claudius_core::settings_load_error::{
    sanitize_json_parse_reason, sanitize_json_parse_reason_utf16,
};
use regex::Regex;
use serde_json::{Value, json};

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| load("settings_errors_golden.json"))
}

/// Recorded on this OS, so errno numbers compare too.
fn same_platform() -> bool {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    fixture()["platform"] == os
}

fn is_root() -> bool {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() == 0 }
}

/// Where Rust knowingly differs from the recording.
#[derive(Clone, Copy, Debug)]
enum Known {
    /// A lone surrogate in a message (V8's token is half of an astral
    /// character) is dropped: a `String` can't hold it.
    LoneSurrogate,
    /// A lone surrogate in a value (an escape, or a string spread through
    /// an astral character) is U+FFFD: TS writes it as a `\udXXX` escape.
    Fffd,
    /// Nesting past serde_json's limit: Rust throws where V8 parses.
    Depth,
}

const KNOWN: &[(&str, &str, Known)] = &[
    ("read", "string astral", Known::Fffd),
    ("read", "lone surrogate escapes", Known::Fffd),
    ("read", "nested 128", Known::Depth),
    ("read", "nested 129", Known::Depth),
    ("read", "nested 200 objects", Known::Depth),
    ("read", "nested 3000", Known::Depth),
    (
        "read",
        "malformed {\\\"a\\\": \u{1f600}}",
        Known::LoneSurrogate,
    ),
    ("read", "malformed \u{1f600}", Known::LoneSurrogate),
    ("write", "fresh lone", Known::Fffd),
    ("callers", "setOutputStyle string astral", Known::Fffd),
    (
        "callers",
        "persistModelToUserSettings \"opus\" string astral",
        Known::Fffd,
    ),
    (
        "callers",
        "advisor route \"claude-opus-4-8\" string astral",
        Known::Fffd,
    ),
    ("callers", "advisor route null string astral", Known::Fffd),
];

// ------------------------------- strings -------------------------------

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// A recorded string's UTF-16 units (a string, or `{"units": [...]}`).
fn want_units(v: &Value) -> Vec<u16> {
    match v {
        Value::String(s) => units(s),
        v => v["units"]
            .as_array()
            .unwrap_or_else(|| panic!("not a string: {v}"))
            .iter()
            .map(|u| u.as_u64().unwrap() as u16)
            .collect(),
    }
}

/// Every `{"units": [...]}` as a string without its lone surrogates.
fn drop_lone(v: &Value) -> Value {
    match v {
        Value::Object(m) if m.len() == 1 && m.contains_key("units") => Value::String(
            char::decode_utf16(want_units(v))
                .filter_map(Result::ok)
                .collect(),
        ),
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), drop_lone(v))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(drop_lone).collect()),
        v => v.clone(),
    }
}

/// Every `\udXXX` escape in a string (JSON text) as U+FFFD.
fn fffd(v: &Value) -> Value {
    static ESC: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\\u[dD][89a-fA-F][0-9a-fA-F]{2}").unwrap());
    match v {
        Value::String(s) => Value::String(ESC.replace_all(s, "\u{fffd}").into_owned()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), fffd(v))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(fffd).collect()),
        v => v.clone(),
    }
}

// ------------------------------- the temp world -------------------------------

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    text: String,
}

/// One temp root for the binary: `paths::set_home_override` is process-wide.
fn world() -> &'static World {
    static W: OnceLock<World> = OnceLock::new();
    W.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert!(paths::set_home_override(root.join("home")));
        // The CLI config dir too: never the real `~/.claude`.
        std::fs::create_dir(root.join("config")).unwrap();
        assert!(paths::set_config_dir_override(root.join("config")));
        // SAFETY: umask has no preconditions; the recorder used 022 too.
        unsafe { libc::umask(0o022) };
        let text = root.to_str().unwrap().to_owned();
        World {
            _dir: dir,
            root,
            text,
        }
    })
}

fn fill(s: &str) -> String {
    s.replace("$ROOT", &world().text)
}

fn scrub(s: &str) -> String {
    static TMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.tmp-\d+-\d+").unwrap());
    TMP.replace_all(&s.replace(&world().text, "$ROOT"), ".tmp-$$PID-$$SEQ")
        .into_owned()
}

fn chmod_tree(p: &Path) {
    let Ok(m) = std::fs::symlink_metadata(p) else {
        return;
    };
    if !m.is_dir() {
        return;
    }
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    for e in std::fs::read_dir(p).unwrap() {
        chmod_tree(&e.unwrap().path());
    }
}

fn reset() {
    for top in ["home", "project", "ext"] {
        let p = world().root.join(top);
        chmod_tree(&p);
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir(&p).unwrap();
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn apply(setup: &Value) {
    let mut chmods = Vec::new();
    for op in setup.as_array().unwrap() {
        let p = world().root.join(op["path"].as_str().unwrap());
        match op["op"].as_str().unwrap() {
            "dir" => std::fs::create_dir_all(&p).unwrap(),
            "file" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let body = match op["hex"].as_str() {
                    Some(h) => hex(h),
                    None => op["text"].as_str().unwrap().as_bytes().to_vec(),
                };
                std::fs::write(&p, body).unwrap();
            }
            "symlink" => {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(fill(op["target"].as_str().unwrap()), &p).unwrap();
            }
            "rm" => {
                let _ = std::fs::remove_dir_all(&p);
            }
            "chmod" => chmods.push((p, op["mode"].as_u64().unwrap() as u32)),
            other => panic!("unknown op {other}"),
        }
    }
    for (p, mode) in chmods {
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
    }
}

/// The recorder's `snapshot()`: the tree under home/, project/ and ext/.
fn snapshot() -> Value {
    fn walk(rel: &str, out: &mut Vec<Value>) {
        let abs = world().root.join(rel);
        let mut e = serde_json::Map::new();
        e.insert("path".into(), json!(scrub(rel)));
        let Ok(st) = std::fs::symlink_metadata(&abs) else {
            e.insert("unreadable".into(), json!(true));
            out.push(Value::Object(e));
            return;
        };
        if st.file_type().is_symlink() {
            e.insert("type".into(), json!("symlink"));
            let target = std::fs::read_link(&abs).unwrap();
            e.insert("target".into(), json!(scrub(target.to_str().unwrap())));
            out.push(Value::Object(e));
            return;
        }
        e.insert("mode".into(), json!(st.permissions().mode() & 0o777));
        if st.is_dir() {
            e.insert("type".into(), json!("dir"));
            let names = std::fs::read_dir(&abs).map(|rd| {
                let mut v: Vec<String> = rd
                    .map(|d| d.unwrap().file_name().into_string().unwrap())
                    .collect();
                v.sort();
                v
            });
            if names.is_err() {
                e.insert("unreadable".into(), json!(true));
            }
            out.push(Value::Object(e));
            for n in names.unwrap_or_default() {
                walk(&format!("{rel}/{n}"), out);
            }
            return;
        }
        e.insert(
            "type".into(),
            json!(if st.is_file() { "file" } else { "other" }),
        );
        if st.is_file() {
            match std::fs::read(&abs) {
                Ok(b) => match String::from_utf8(b) {
                    Ok(t) => {
                        e.insert("text".into(), json!(scrub(&t)));
                    }
                    Err(b) => {
                        let h: String = b.as_bytes().iter().map(|x| format!("{x:02x}")).collect();
                        e.insert("hex".into(), json!(h));
                    }
                },
                Err(_) => {
                    e.insert("unreadable".into(), json!(true));
                }
            }
        }
        out.push(Value::Object(e));
    }
    let mut out = Vec::new();
    for top in ["home", "project", "ext"] {
        if std::fs::symlink_metadata(world().root.join(top)).is_ok() {
            walk(top, &mut out);
        }
    }
    Value::Array(out)
}

fn scope_of(c: &Value) -> Scope {
    Scope::parse(c["scope"].as_str().unwrap()).unwrap()
}

fn node_json(n: &NodeError) -> Value {
    let mut o = json!({
        "name": "Error",
        "message": scrub(&n.message),
        "code": n.code,
        "errno": n.errno,
        "syscall": n.syscall,
    });
    if let Some(p) = &n.path {
        o["path"] = json!(scrub(p));
    }
    if let Some(d) = &n.dest {
        o["dest"] = json!(scrub(d));
    }
    o
}

/// The recorder's `err()` for a settings error.
fn err_json(e: &SettingsError) -> Value {
    match e {
        SettingsError::Parse { path, reason } => json!({
            "name": e.name(),
            "message": scrub(&e.to_string()),
            "path": scrub(path),
            "reason": reason,
            "settingsParseError": true,
        }),
        SettingsError::Io(n) => {
            let mut o = node_json(n);
            o["name"] = json!(e.name());
            o
        }
        SettingsError::PathInjection(m) => json!({"name": e.name(), "message": m}),
    }
}

/// Drops `errno` (platform-specific numbers) unless recorded here.
fn errno_free(mut v: Value) -> Value {
    if !same_platform() {
        strip_errno(&mut v);
    }
    v
}

fn strip_errno(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("errno");
            m.values_mut().for_each(strip_errno);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_errno),
        _ => {}
    }
}

/// Compares one case, allowing exactly the listed differences.
struct Tally {
    section: &'static str,
    matched: usize,
    known: Vec<String>,
}

impl Tally {
    fn new(section: &'static str) -> Tally {
        Tally {
            section,
            matched: 0,
            known: Vec::new(),
        }
    }

    fn check(&mut self, name: &str, got: Value, want: Value) {
        let (got, want) = (errno_free(got), errno_free(want));
        let known = KNOWN
            .iter()
            .find(|(s, n, _)| *s == self.section && *n == name)
            .map(|(.., k)| *k);
        let Some(kind) = known else {
            assert_eq!(got, want, "{} {name:?}", self.section);
            self.matched += 1;
            return;
        };
        assert_ne!(
            got, want,
            "{} {name:?} is listed as {kind:?} but matches: drop it from KNOWN",
            self.section
        );
        match kind {
            Known::LoneSurrogate => assert_eq!(got, drop_lone(&want), "{} {name:?}", self.section),
            Known::Fffd => assert_eq!(fffd(&got), fffd(&want), "{} {name:?}", self.section),
            Known::Depth => {
                let reason = got["throws"]["reason"].as_str().unwrap_or_default();
                assert!(
                    reason.starts_with("recursion limit exceeded"),
                    "{} {name:?}: {got}",
                    self.section
                );
                assert!(want.get("value").is_some(), "{} {name:?}", self.section);
                assert_eq!(got["after"], want["after"], "{} {name:?}", self.section);
            }
        }
        self.known.push(name.to_owned());
    }

    fn done(self, min: usize) {
        let listed: Vec<&str> = KNOWN
            .iter()
            .filter(|(s, ..)| *s == self.section)
            .map(|(_, n, _)| *n)
            .collect();
        assert_eq!(
            self.known, listed,
            "{}: every KNOWN case must be in the fixture",
            self.section
        );
        assert!(
            self.matched >= min,
            "{}: only {} cases matched",
            self.section,
            self.matched
        );
    }
}

fn pick(c: &Value, keys: &[&str]) -> Value {
    let mut o = serde_json::Map::new();
    for k in keys {
        if let Some(v) = c.get(*k) {
            o.insert((*k).to_owned(), v.clone());
        }
    }
    Value::Object(o)
}

// ------------------------------- errno names and fs errors -------------------------------

#[test]
fn error_map_matches_libuv() {
    let fx = fixture();
    let recorded: Vec<(i64, &str, &str)> = fx["errorMap"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e[0].as_i64().unwrap(),
                e[1].as_str().unwrap(),
                e[2].as_str().unwrap(),
            )
        })
        .collect();
    assert!(recorded.len() > 80);
    let by_code = |code: &str| recorded.iter().find(|(_, c, _)| *c == code);
    let mut checked = 0;
    for n in 1..512 {
        let Some((code, description)) = node_err::describe(n) else {
            if same_platform() {
                assert!(
                    !recorded.iter().any(|(e, ..)| *e == -i64::from(n)),
                    "errno {n} is in node's map"
                );
            }
            continue;
        };
        let want = by_code(code).unwrap_or_else(|| panic!("{code} isn't in node's map"));
        assert_eq!(want.2, description, "{code}");
        if same_platform() {
            assert_eq!(want.0, -i64::from(n), "{code}");
        }
        checked += 1;
    }
    assert!(checked > 60, "{checked}");
    if same_platform() {
        // Every recorded OS errno is named here.
        for (e, code, _) in &recorded {
            if (-511..0).contains(e) {
                assert_eq!(node_err::describe(-*e as i32).map(|d| d.0), Some(*code));
            }
        }
    }
    for u in fx["unknown"].as_array().unwrap() {
        let n = -u[0].as_i64().unwrap() as i32;
        let e = node_err::uv_exception(&std::io::Error::from_raw_os_error(n), "open", None, None);
        assert_eq!(e.code, u[1].as_str().unwrap());
        assert_eq!(
            e.message,
            format!(
                "{}: {}, open",
                u[1].as_str().unwrap(),
                u[2].as_str().unwrap()
            )
        );
    }
}

#[test]
fn fs_errors_match_node() {
    let fx = fixture();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let text = root.to_str().unwrap().to_owned();
    let p = |s: &str| PathBuf::from(s.replace("$ROOT", &text));
    let mk = |rel: &str, body: Option<&str>| {
        let f = root.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        if let Some(b) = body {
            std::fs::write(&f, b).unwrap();
        } else {
            std::fs::create_dir_all(&f).unwrap();
        }
    };
    mk("ext/file", Some("x"));
    mk("ext/dir/sub", None);
    mk("ext/empty", None);
    std::os::unix::fs::symlink(root.join("ext/loop"), root.join("ext/loop")).unwrap();
    std::os::unix::fs::symlink(root.join("ext/nowhere/x"), root.join("ext/dangling")).unwrap();
    mk("ext/ro/inside", Some("y"));
    mk("ext/it's \"q\" d\u{ef}r/f", Some("z"));
    mk("ext/locked", Some("w"));
    let mode = |rel: &str, m: u32| {
        std::fs::set_permissions(root.join(rel), std::fs::Permissions::from_mode(m)).unwrap()
    };
    mode("ext/locked", 0o000);
    mode("ext/ro", 0o555);
    // macOS: a user-immutable directory, as the recorder froze it.
    let frozen = cfg!(target_os = "macos").then(|| {
        mk("ext/frozen", None);
        Frozen::new(root.join("ext/frozen"))
    });
    let mut checked = 0;
    for case in fx["fsErrors"].as_array().unwrap() {
        let op = case["op"].as_str().unwrap();
        let args = case["args"].as_array().unwrap();
        let a = |i: usize| p(args[i].as_str().unwrap());
        let touches_locked = args.iter().any(|x| {
            x.as_str()
                .is_some_and(|s| s.contains("/ext/ro/") || s.ends_with("/ext/locked"))
        });
        if is_root() && touches_locked {
            eprintln!("skipped {op} {args:?}: running as root");
            continue;
        }
        let touches_frozen = args
            .iter()
            .any(|x| x.as_str().is_some_and(|s| s.contains("/ext/frozen/")));
        if frozen.is_none() && touches_frozen {
            eprintln!("skipped {op} {args:?}: macOS only");
            continue;
        }
        let uv = |e: std::io::Error, syscall: &'static str, path: &Path, dest: Option<&Path>| {
            node_err::uv_exception(&e, syscall, Some(path), dest)
        };
        let got: NodeError = match op {
            "readFile" => node_err::fs::read_file(&a(0)).unwrap_err(),
            "writeFile" => node_err::fs::write_file(&a(0), b"x").unwrap_err(),
            "mkdir" => uv(std::fs::create_dir(a(0)).unwrap_err(), "mkdir", &a(0), None),
            "mkdirp" => node_err::fs::mkdir_recursive(&a(0)).unwrap_err(),
            "rename" => node_err::fs::rename(&a(0), &a(1)).unwrap_err(),
            "rmdir" => uv(std::fs::remove_dir(a(0)).unwrap_err(), "rmdir", &a(0), None),
            "unlink" => uv(
                std::fs::remove_file(a(0)).unwrap_err(),
                "unlink",
                &a(0),
                None,
            ),
            "lstat" => node_err::fs::lstat(&a(0)).unwrap_err(),
            "stat" => uv(std::fs::metadata(a(0)).unwrap_err(), "stat", &a(0), None),
            "readdir" => uv(std::fs::read_dir(a(0)).unwrap_err(), "scandir", &a(0), None),
            "chmod" => node_err::fs::chmod(&a(0), args[1].as_u64().unwrap() as u32).unwrap_err(),
            "symlink" => uv(
                std::os::unix::fs::symlink(a(0), a(1)).unwrap_err(),
                "symlink",
                &a(0),
                Some(&a(1)),
            ),
            "copyFile" => uv(
                std::fs::copy(a(0), a(1)).unwrap_err(),
                "copyfile",
                &a(0),
                Some(&a(1)),
            ),
            "realpath" => uv(
                std::fs::canonicalize(a(0)).unwrap_err(),
                "realpath",
                &a(0),
                None,
            ),
            "readlink" => uv(
                std::fs::read_link(a(0)).unwrap_err(),
                "readlink",
                &a(0),
                None,
            ),
            "access" => {
                let c = std::ffi::CString::new(a(0).to_str().unwrap()).unwrap();
                // SAFETY: a valid NUL-terminated path.
                assert_eq!(unsafe { libc::access(c.as_ptr(), libc::F_OK) }, -1);
                uv(std::io::Error::last_os_error(), "access", &a(0), None)
            }
            "rm" => uv(
                std::fs::symlink_metadata(a(0)).unwrap_err(),
                "lstat",
                &a(0),
                None,
            ),
            "open" => uv(std::fs::File::open(a(0)).unwrap_err(), "open", &a(0), None),
            other => panic!("unknown op {other}"),
        };
        let mut got = node_json(&got);
        for v in got.as_object_mut().unwrap().values_mut() {
            if let Value::String(s) = v {
                *s = s.replace(&text, "$ROOT");
            }
        }
        assert_eq!(
            errno_free(got),
            errno_free(case["err"].clone()),
            "{op} {args:?}"
        );
        checked += 1;
    }
    drop(frozen);
    chmod_tree(&root);
    assert!(checked >= if is_root() { 30 } else { 50 }, "{checked}");
}

/// `chflags uchg` on a directory, cleared on drop so the temp dir can go.
struct Frozen(PathBuf);

impl Frozen {
    fn new(dir: PathBuf) -> Frozen {
        let st = std::process::Command::new("chflags")
            .arg("uchg")
            .arg(&dir)
            .status()
            .unwrap();
        assert!(st.success());
        Frozen(dir)
    }
}

impl Drop for Frozen {
    fn drop(&mut self) {
        let _ = std::process::Command::new("chflags")
            .arg("nouchg")
            .arg(&self.0)
            .status();
    }
}

// ------------------------------- sanitize -------------------------------

#[test]
fn sanitize_matches_ts() {
    let fx = &fixture()["sanitize"];
    for c in fx["messages"].as_array().unwrap() {
        let message = want_units(&c["message"]);
        assert_eq!(
            sanitize_json_parse_reason_utf16(&message),
            want_units(&c["reason"]),
            "{}",
            c["message"]
        );
        if let Value::String(m) = &c["message"] {
            let want: String = char::decode_utf16(want_units(&c["reason"]))
                .filter_map(Result::ok)
                .collect();
            assert_eq!(sanitize_json_parse_reason(m), want, "{m:?}");
        }
    }
    let parsed = fx["parsed"].as_array().unwrap();
    assert!(parsed.len() > 400);
    for c in parsed {
        let text = want_units(&c["text"]);
        let message =
            js::json_parse_error_utf16(&text).unwrap_or_else(|| panic!("{} parses", c["text"]));
        assert_eq!(message, want_units(&c["message"]), "{}", c["text"]);
        assert_eq!(
            sanitize_json_parse_reason_utf16(&message),
            want_units(&c["reason"]),
            "{}",
            c["text"]
        );
    }
}

// ------------------------------- readSettings, writeSettings, callers -------------------------------

fn type_of(v: &Value, null: bool) -> &'static str {
    match v {
        _ if null => "null",
        Value::Null | Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn replay_read(c: &Value) -> Value {
    let (scope, cwd) = (scope_of(c), fill(c["cwd"].as_str().unwrap()));
    let got = match settings::read_settings_value(scope, &cwd) {
        Ok(v) => {
            let props = settings::read_settings_js(scope, &cwd).unwrap();
            let spread = settings::read_settings(scope, &cwd).unwrap();
            assert_eq!(props.is_none(), v.is_null() && props.is_none());
            if let Some(p) = &props {
                assert_eq!(*p, spread, "{}", c["name"]);
            }
            json!({"value": {
                "type": type_of(&v, props.is_none()),
                "json": scrub(&js::stringify(&v)),
                "spread": scrub(&js::stringify(&Value::Object(spread))),
            }})
        }
        Err(e) => {
            assert_eq!(settings::read_settings_js(scope, &cwd).unwrap_err(), e);
            assert_eq!(settings::read_settings(scope, &cwd).unwrap_err(), e);
            json!({"throws": err_json(&e)})
        }
    };
    let mut got = got;
    got["after"] = snapshot();
    got
}

fn replay_write(c: &Value) -> Value {
    let (scope, cwd) = (scope_of(c), fill(c["cwd"].as_str().unwrap()));
    let next = js::json_parse(c["next"].as_str().unwrap()).unwrap();
    let res = if c["name"] == "two writes" {
        let first = json!({"first": 1});
        settings::write_settings(scope, &cwd, first.as_object().unwrap())
            .and_then(|()| settings::write_settings(scope, &cwd, next.as_object().unwrap()))
    } else {
        settings::write_settings(scope, &cwd, next.as_object().unwrap())
    };
    let mut got = match res {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"throws": err_json(&e)}),
    };
    got["after"] = snapshot();
    got
}

/// What the TS caller logged: `[[tag, error]]`, as Rust's `Err` text.
fn logged(c: &Value) -> Option<String> {
    let l = c["logged"].as_array().unwrap();
    assert!(l.len() <= 1, "{}", c["name"]);
    l.first().map(|entry| {
        let e = &drop_lone(&entry[1]);
        e["message"].as_str().unwrap().to_owned()
    })
}

async fn replay_caller(c: &Value) -> Value {
    let cwd = fill(c["cwd"].as_str().unwrap());
    let caller = c["caller"].as_str().unwrap();
    let session = || {
        Session::new(SessionOptions {
            cwd: Some(cwd.clone()),
            ..Default::default()
        })
        .unwrap()
    };
    let as_logged = |r: Result<(), String>| -> Value {
        match r {
            Ok(()) => json!([]),
            Err(e) => json!([[c["logged"][0][0], {"message": scrub(&e)}]]),
        }
    };
    // The TS `logged` entries reduced to the tag and the message.
    let want_logged = || -> Value {
        match logged(c) {
            None => json!([]),
            Some(m) => json!([[c["logged"][0][0], {"message": m}]]),
        }
    };
    let mut got = serde_json::Map::new();
    let mut want = serde_json::Map::new();
    match caller {
        "setOutputStyle" => {
            let returned = match session().set_output_style("concise").await {
                Ok(n) => json!({"ok": true, "outputStyle": n}),
                Err(e) => json!({"ok": false, "error": scrub(&e)}),
            };
            got.insert("returned".into(), returned);
            want.insert("returned".into(), c["returned"].clone());
        }
        "enforceAdvisorModelCompatibility" => {
            got.insert(
                "logged".into(),
                as_logged(settings::clear_user_advisor_model(&cwd)),
            );
            want.insert("logged".into(), want_logged());
        }
        "setPermissionMode auto" => {
            let s = session();
            match s.try_set_permission_mode("auto", false).await {
                Ok(()) => {}
                Err(e) => {
                    got.insert("throws".into(), json!(e));
                    want.insert("throws".into(), c["throws"]["message"].clone());
                }
            }
            let modes: Vec<Value> = s
                .buffer_snapshot()
                .into_iter()
                .filter(|e| e["type"] == "mode_changed")
                .map(|e| pick(&e, &["type", "mode"]))
                .collect();
            got.insert("mode".into(), json!(s.permission_mode()));
            got.insert("broadcasts".into(), json!(modes));
            want.insert("mode".into(), c["mode"].clone());
            want.insert(
                "broadcasts".into(),
                c.get("broadcasts").cloned().unwrap_or(json!([])),
            );
        }
        "requestRecap" => {
            let s = session();
            s.request_recap("manual").await;
            let errors: Vec<Value> = s
                .buffer_snapshot()
                .into_iter()
                .filter(|e| e["type"] == "session_recap_error")
                .map(|e| pick(&e, &["type", "reason"]))
                .collect();
            got.insert("broadcasts".into(), json!(errors));
            want.insert(
                "broadcasts".into(),
                c.get("broadcasts").cloned().unwrap_or(json!([])),
            );
        }
        other => {
            let model = c["args"][0].as_str();
            let r = if other.starts_with("persistModelToUserSettings") {
                settings::try_persist_model_to_user_settings(&cwd, model)
            } else if other.starts_with("advisor route") {
                assert_eq!(c["status"], 200);
                settings::try_persist_advisor_to_user_settings(&cwd, model)
            } else {
                panic!("unknown caller {other}")
            };
            got.insert("logged".into(), as_logged(r));
            want.insert("logged".into(), want_logged());
        }
    }
    got.insert("after".into(), snapshot());
    want.insert("after".into(), c["after"].clone());
    json!({"got": got, "want": want})
}

#[tokio::test(flavor = "multi_thread")]
async fn replays_the_ts_recording() {
    let fx = fixture();
    world();
    let _guard = LOCK.lock().await;
    let skip = |c: &Value| {
        let s = c["needsNonRoot"] == true && is_root();
        if s {
            eprintln!("skipped {:?}: running as root", c["name"]);
        }
        s
    };

    let mut tally = Tally::new("read");
    for c in fx["read"].as_array().unwrap() {
        if skip(c) {
            continue;
        }
        reset();
        apply(&c["setup"]);
        let got = replay_read(c);
        tally.check(
            c["name"].as_str().unwrap(),
            got,
            pick(c, &["value", "throws", "after"]),
        );
    }
    tally.done(if is_root() { 120 } else { 130 });

    let mut tally = Tally::new("write");
    for c in fx["write"].as_array().unwrap() {
        if skip(c) {
            continue;
        }
        reset();
        apply(&c["setup"]);
        let got = replay_write(c);
        tally.check(
            c["name"].as_str().unwrap(),
            got,
            pick(c, &["ok", "throws", "after"]),
        );
    }
    tally.done(if is_root() { 30 } else { 40 });

    let mut tally = Tally::new("callers");
    for c in fx["callers"].as_array().unwrap() {
        if skip(c) {
            continue;
        }
        reset();
        apply(&c["setup"]);
        let r = replay_caller(c).await;
        tally.check(
            c["name"].as_str().unwrap(),
            r["got"].clone(),
            r["want"].clone(),
        );
    }
    tally.done(if is_root() { 160 } else { 175 });
    reset();
}

/// Holds the first `[sess-load]` event after `armed` is set until the test
/// lets it go: a `start()` stopped part-way, its in-flight entry published.
struct Gate {
    armed: AtomicBool,
    reached: Barrier,
    release: Barrier,
}

static GATE: LazyLock<Gate> = LazyLock::new(|| Gate {
    armed: AtomicBool::new(false),
    reached: Barrier::new(2),
    release: Barrier::new(2),
});

struct GateSubscriber;

impl tracing::Subscriber for GateSubscriber {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        if event.metadata().target() == claudius_core::log::SESS_LOAD
            && GATE.armed.swap(false, Ordering::SeqCst)
        {
            GATE.reached.wait();
            GATE.release.wait();
        }
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

fn check_threw(r: Result<Arc<Session>, CreateError>, want: &str) {
    match r {
        Err(e @ CreateError::Threw { .. }) => {
            assert_eq!((e.name(), e.to_string().as_str()), ("TypeError", want));
        }
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("created"),
    }
}

/// `start()` throws reading `spinnerTipsEnabled` off a `null` settings.json
/// (recorded by the spinner-tips golden): the create fails with that
/// `TypeError`, and so does a create that joined it in flight; nothing is
/// left registered, and the next create starts afresh.
#[tokio::test(flavor = "multi_thread")]
async fn a_null_user_settings_file_fails_the_create() {
    let spinner = load("spinner_tips_golden.json");
    let case = spinner["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "settings null")
        .unwrap();
    let config: Value = serde_json::from_str(case["config"].as_str().unwrap()).unwrap();
    let want = config["throws"].as_str().unwrap().to_owned();
    let _ = tracing::subscriber::set_global_default(GateSubscriber);

    // Its own project: the replay above resets home/ between cases.
    let w = world();
    let _guard = LOCK.lock().await;
    let project = w.root.join("start-project");
    std::fs::create_dir_all(&project).unwrap();
    let cwd = project.to_str().unwrap().to_owned();
    let home = w.root.join("home/.claude");
    let restore = std::fs::read(home.join("settings.json")).ok();
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("settings.json"), "null").unwrap();
    // A transcript to resume, so `start()` logs `[sess-load]` part-way.
    let resume = "4e1d5c2a-0000-4000-8000-000000000001";
    let transcripts = paths::sdk_projects_dir().join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&transcripts).unwrap();
    std::fs::write(transcripts.join(format!("{resume}.jsonl")), "").unwrap();
    // No CLI: a start that gets that far fails to spawn and still creates.
    let opts = || SessionOptions {
        cwd: Some(cwd.clone()),
        resume: Some(resume.into()),
        runtime: RuntimeOptions {
            claude_bin: Some(w.root.join("no-claude")),
            ..Default::default()
        },
        ..Default::default()
    };

    let s = Session::new(opts()).unwrap();
    s.start().await;
    assert_eq!(s.take_start_error(), Some(("TypeError", want.clone())));
    assert_eq!(s.take_start_error(), None);
    s.end().await;

    let mgr = Arc::new(SessionManager::default());
    GATE.armed.store(true, Ordering::SeqCst);
    let (m, o) = (mgr.clone(), opts());
    let a = tokio::spawn(async move { m.create(o).await });
    tokio::task::spawn_blocking(|| GATE.reached.wait())
        .await
        .unwrap();
    // `a` is inside `start()`: this create joins it.
    let mut b = Box::pin(mgr.create(opts()));
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(b.as_mut().poll(&mut cx).is_pending());
    tokio::task::spawn_blocking(|| GATE.release.wait())
        .await
        .unwrap();
    check_threw(a.await.unwrap(), &want);
    check_threw(b.await, &want);
    assert!(mgr.list().is_empty());

    std::fs::write(home.join("settings.json"), "{}").unwrap();
    let c = mgr
        .create(opts())
        .await
        .expect("the next create starts afresh");
    assert_eq!(mgr.list().len(), 1);
    mgr.remove(&c.id).await;

    match restore {
        Some(b) => std::fs::write(home.join("settings.json"), b).unwrap(),
        None => std::fs::remove_file(home.join("settings.json")).unwrap(),
    }
    std::fs::remove_dir_all(&project).unwrap();
    std::fs::remove_dir_all(&transcripts).unwrap();
}

/// The two tests that use the shared home run one at a time.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
