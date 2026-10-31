//! The disk side of `fixtures/session_search_golden.json` (recorded by
//! `rust/scripts/session-search-golden.mjs`): rebuilding the recorded
//! transcript folders under a home (bytes, symlinks, exact mtimes, modes),
//! and which steps a disk can replay. Shared with claudius-server's
//! `tests/session_search.rs` (`#[path]`).
#![allow(dead_code)] // each test binary uses a different subset

use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use claudius_core::paths::encode_project_dir;
use serde_json::Value;

pub fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/session_search_golden.json")).unwrap()
}

/// An entry's `parts` as bytes: UTF-8 text, `{hex}` or `{rep, n}`.
pub fn bytes(parts: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    for p in parts.as_array().unwrap() {
        if let Some(s) = p.as_str() {
            out.extend(s.as_bytes());
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

/// A recorded `mtimeNs` as a `SystemTime`.
fn time_of(ns: &str) -> SystemTime {
    let ns: i128 = ns.parse().unwrap();
    let d = Duration::new(
        (ns.unsigned_abs() / 1_000_000_000) as u64,
        (ns.unsigned_abs() % 1_000_000_000) as u32,
    );
    if ns < 0 {
        UNIX_EPOCH - d
    } else {
        UNIX_EPOCH + d
    }
}

fn set_mtime(p: &Path, ns: &str) {
    let t = time_of(ns);
    let f = std::fs::File::open(p).unwrap();
    f.set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t))
        .unwrap();
    // Read back as node reads it.
    let got = std::fs::metadata(p).unwrap().modified().unwrap();
    assert_eq!(got, t, "{}: the disk kept another mtime", p.display());
}

/// The rebuilt folders; dropping it makes every folder it locked listable
/// again so the temp dir can go.
pub struct Built {
    locked: Vec<PathBuf>,
}

impl Drop for Built {
    fn drop(&mut self) {
        for p in self.locked.iter().rev() {
            let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755));
        }
    }
}

/// Rebuild the fixture's `outside` files and `worlds` under `home`, as the
/// recorder did under its `$HOME`: contents, then times, then modes.
pub fn build(home: &Path, fx: &Value) -> Built {
    let projects = home.join(".claude/projects");
    std::fs::create_dir_all(&projects).unwrap();
    for o in fx["outside"].as_array().unwrap() {
        let p = home.join(o["path"].as_str().unwrap());
        if o["kind"] == "dir" {
            std::fs::create_dir_all(&p).unwrap();
        } else {
            std::fs::write(&p, bytes(&o["parts"])).unwrap();
            set_mtime(&p, o["mtimeNs"].as_str().unwrap());
        }
    }
    let mut built = Built { locked: Vec::new() };
    let mut modes = Vec::new();
    for w in fx["worlds"].as_array().unwrap() {
        let encoded = w["encoded"].as_str().unwrap();
        assert_eq!(encode_project_dir(w["dir"].as_str().unwrap()), encoded);
        let base = projects.join(encoded);
        match w["base"].as_str().unwrap() {
            "file" => std::fs::write(&base, "not a folder").unwrap(),
            "link" => symlink(w["target"].as_str().unwrap(), &base).unwrap(),
            _ => std::fs::create_dir(&base).unwrap(),
        }
        for e in w["entries"].as_array().unwrap() {
            let p = base.join(e["name"].as_str().unwrap());
            match e["kind"].as_str().unwrap() {
                "link" => symlink(e["target"].as_str().unwrap(), &p).unwrap(),
                kind => {
                    if kind == "dir" {
                        std::fs::create_dir(&p).unwrap();
                    } else {
                        std::fs::write(&p, bytes(&e["parts"])).unwrap();
                    }
                    set_mtime(&p, e["mtimeNs"].as_str().unwrap());
                }
            }
            if let Some(m) = e["mode"].as_u64() {
                modes.push((p, m as u32));
            }
        }
        if let Some(m) = w["mode"].as_u64() {
            modes.push((base.clone(), m as u32));
            built.locked.push(base);
        }
    }
    for (p, m) in modes {
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(m)).unwrap();
    }
    built
}

/// Whether this disk refuses a mode-000 folder (not root), as the
/// recorder's did.
pub fn perms_enforced() -> bool {
    let t = tempfile::tempdir().unwrap();
    let locked = t.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let enforced = std::fs::read_dir(&locked).is_err();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    enforced
}

/// Whether `step` reads a world that relies on modes being enforced.
pub fn needs_perms(fx: &Value, step: &Value) -> bool {
    let Some(dir) = step["params"]["dir"].as_str() else {
        return false;
    };
    let encoded = encode_project_dir(dir);
    fx["worlds"].as_array().unwrap().iter().any(|w| {
        w["encoded"] == encoded.as_str()
            && (w["mode"].is_u64()
                || w["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["mode"].is_u64()))
    })
}
