//! The disk side of `fixtures/peer_source_golden.json` (recorded by
//! `rust/scripts/peer-source-golden.mjs`): the recorder's disk ops (`dir`,
//! `file` with its exact mtime, `link`, `rm`, `chmod`) replayed under a
//! base dir, with `@LIVE@` standing for this process's pid. Shared with
//! claudius-server's `tests/peer_source.rs` (`#[path]`).
#![allow(dead_code)] // each test binary uses a different subset

use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/peer_source_golden.json")).unwrap()
}

/// A pid that is running for the whole test: this process's.
pub fn live() -> String {
    std::process::id().to_string()
}

pub fn sub(s: &str) -> String {
    s.replace("@LIVE@", &live())
}

/// A part list as bytes: UTF-8 text (with `@LIVE@`), `{hex}` or `{rep, n}`.
pub fn bytes(parts: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    for p in parts.as_array().unwrap() {
        if let Some(s) = p.as_str() {
            out.extend(sub(s).as_bytes());
        } else if let Some(hex) = p["hex"].as_str() {
            for i in (0..hex.len()).step_by(2) {
                out.push(u8::from_str_radix(&hex[i..i + 2], 16).unwrap());
            }
        } else {
            let n = p["n"].as_u64().unwrap() as usize;
            out.extend(p["rep"].as_str().unwrap().repeat(n).as_bytes());
        }
    }
    out
}

fn set_mtime(p: &Path, ns: &str) {
    let ns: i128 = ns.parse().unwrap();
    let d = Duration::new(
        (ns.unsigned_abs() / 1_000_000_000) as u64,
        (ns.unsigned_abs() % 1_000_000_000) as u32,
    );
    let t = if ns < 0 {
        UNIX_EPOCH - d
    } else {
        UNIX_EPOCH + d
    };
    let f = std::fs::File::open(p).unwrap();
    f.set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t))
        .unwrap();
    let got: SystemTime = std::fs::metadata(p).unwrap().modified().unwrap();
    assert_eq!(got, t, "{}: the disk kept another mtime", p.display());
}

/// Apply one recorded disk op under `base`.
pub fn apply(base: &Path, op: &Value) {
    let p = base.join(sub(op["path"].as_str().unwrap()));
    let mtime = || {
        if let Some(ns) = op["mtimeNs"].as_str() {
            set_mtime(&p, ns);
        }
    };
    match op["op"].as_str().unwrap() {
        "dir" => {
            std::fs::create_dir_all(&p).unwrap();
            mtime();
        }
        "file" => {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, bytes(&op["parts"])).unwrap();
            mtime();
        }
        "link" => {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            symlink(op["target"].as_str().unwrap(), &p).unwrap();
        }
        "rm" => match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p).unwrap(),
            Ok(_) => std::fs::remove_file(&p).unwrap(),
            Err(_) => {}
        },
        "chmod" => {
            let mode = op["mode"].as_u64().unwrap() as u32;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        other => panic!("op {other}"),
    }
}

/// Make everything under `dir` removable again (the ops lock some of it).
pub fn open_up(dir: &Path) {
    let Ok(m) = std::fs::symlink_metadata(dir) else {
        return;
    };
    if m.file_type().is_symlink() {
        return;
    }
    let mode = if m.is_dir() { 0o755 } else { 0o644 };
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode));
    if m.is_dir()
        && let Ok(entries) = std::fs::read_dir(dir)
    {
        for e in entries.flatten() {
            open_up(&e.path());
        }
    }
}

/// Whether this disk refuses a mode-000 file (not root), as the recorder's did.
pub fn perms_enforced() -> bool {
    let t = tempfile::tempdir().unwrap();
    let locked = t.path().join("locked");
    std::fs::write(&locked, "x").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let enforced = std::fs::read(&locked).is_err();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
    enforced
}
