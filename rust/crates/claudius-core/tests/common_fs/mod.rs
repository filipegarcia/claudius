//! The disk side of `fixtures/fs_list_golden.json` (recorded by
//! `rust/scripts/fs-list-golden.mjs`): rebuilding a scenario's tree in a
//! fresh temp root, its snapshot, and comparing an answer with a recorded
//! `got`. Shared with claudius-server's `tests/fs_routes.rs` (`#[path]`).
#![allow(dead_code)] // each test binary uses a different subset

use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The recorder's temp root, as written in the fixture.
pub const PH: &str = "@@ROOT@@";

pub fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/fs_list_golden.json")).unwrap()
}

/// What a scenario's `needs` asks of the disk the replay runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Disk {
    /// Names fold case and Unicode normalization (APFS, HFS+).
    pub fold: bool,
    /// Permissions are enforced (not root).
    pub perm: bool,
    /// BSD immutable flags (`chflags uchg`, macOS): mkdir inside is EPERM.
    pub uchg: bool,
}

/// Probe the temp dir's disk the way the recorder probed its own.
pub fn probe_disk() -> Disk {
    let t = tempfile::tempdir().unwrap();
    std::fs::create_dir(t.path().join("Ab\u{e9}")).unwrap();
    let fold = t.path().join("aBe\u{301}").exists();
    let locked = t.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let perm = std::fs::read_dir(&locked).is_err();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    let frozen = t.path().join("frozen");
    std::fs::create_dir(&frozen).unwrap();
    let uchg = chflags("uchg", &frozen);
    if uchg {
        chflags("nouchg", &frozen);
    }
    Disk { fold, perm, uchg }
}

/// `chflags <flags> <path>`; false where there's no `chflags` (Linux).
fn chflags(flags: &str, p: &Path) -> bool {
    std::process::Command::new("chflags")
        .arg(flags)
        .arg(p)
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Whether this disk can replay `scenario` (its `needs` must match the
/// recorder's disk, `fx.fs`, on this disk too).
pub fn can_replay(fx: &Value, scenario: &Value, disk: Disk) -> bool {
    scenario["needs"].as_array().unwrap().iter().all(|n| {
        let n = n.as_str().unwrap();
        let mine = match n {
            "fold" => disk.fold,
            "perm" => disk.perm,
            "uchg" => disk.uchg,
            other => panic!("unknown need {other}"),
        };
        fx["fs"][n].as_bool() == Some(mine)
    })
}

/// A fresh temp root with `home`, `w`, `out` and `config`.
pub struct Tree {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
    /// A `uchg` op ran: clear the flags before the temp dir goes.
    flagged: std::cell::Cell<bool>,
}

impl Tree {
    pub fn new() -> Tree {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for d in ["home", "w", "out", "config"] {
            std::fs::create_dir(root.join(d)).unwrap();
        }
        Tree {
            _dir: dir,
            root,
            flagged: std::cell::Cell::new(false),
        }
    }

    pub fn root_str(&self) -> String {
        self.root.to_str().unwrap().to_owned()
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        if rel.is_empty() {
            self.root.clone()
        } else {
            self.root.join(rel)
        }
    }

    /// `@@ROOT@@` → this root.
    pub fn sub(&self, s: &str) -> String {
        s.replace(PH, &self.root_str())
    }

    /// This root → `@@ROOT@@`.
    pub fn unsub(&self, s: &str) -> String {
        s.replace(&self.root_str(), PH)
    }

    /// Run the ops that succeeded for the recorder (each must succeed here).
    pub fn apply(&self, ops: &Value) {
        for o in ops.as_array().unwrap() {
            if o["ok"] != true {
                continue;
            }
            let op = o["op"].as_array().unwrap();
            let kind = op[0].as_str().unwrap();
            let p = self.root.join(op[1].as_str().unwrap());
            let arg = op.get(2);
            let res = match kind {
                "dir" => std::fs::create_dir(&p),
                "file" => std::fs::write(&p, self.sub(arg.and_then(Value::as_str).unwrap_or(""))),
                "link" => symlink(self.sub(arg.unwrap().as_str().unwrap()), &p),
                "fifo" => {
                    let st = std::process::Command::new("mkfifo")
                        .arg(&p)
                        .status()
                        .unwrap();
                    assert!(st.success(), "mkfifo {p:?}");
                    Ok(())
                }
                "uchg" => {
                    self.flagged.set(true);
                    assert!(chflags("uchg", &p), "chflags uchg {p:?}");
                    Ok(())
                }
                "chmod" => std::fs::set_permissions(
                    &p,
                    std::fs::Permissions::from_mode(arg.unwrap().as_u64().unwrap() as u32),
                ),
                "files" => (0..arg.unwrap().as_u64().unwrap())
                    .try_for_each(|i| std::fs::write(p.join(format!("f{i:04}")), "")),
                other => panic!("unknown op {other}"),
            };
            res.unwrap_or_else(|e| panic!("{o}: {e}"));
        }
    }

    /// The recorder's `snapshot()`: every path under `w` and `out`, sorted.
    pub fn snapshot(&self) -> Vec<String> {
        fn walk(root: &Path, rel: &str, out: &mut Vec<String>, tree: &Tree) {
            let Ok(rd) = std::fs::read_dir(root.join(rel)) else {
                out.push(format!("{rel} !"));
                return;
            };
            let mut names: Vec<String> = rd
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            for n in names {
                let r = format!("{rel}/{n}");
                let Ok(meta) = std::fs::symlink_metadata(root.join(&r)) else {
                    out.push(format!("{r} ?"));
                    continue;
                };
                let t = meta.file_type();
                if t.is_symlink() {
                    let target = std::fs::read_link(root.join(&r)).unwrap();
                    out.push(format!("{r} -> {}", tree.unsub(&target.to_string_lossy())));
                } else if t.is_dir() {
                    out.push(format!("{r}/"));
                    walk(root, &r, out, tree);
                } else if t.is_file() {
                    out.push(r);
                } else {
                    out.push(format!("{r} |"));
                }
            }
        }
        let mut out = Vec::new();
        for top in ["w", "out"] {
            walk(&self.root, top, &mut out, self);
        }
        out.sort();
        out
    }
}

/// Undo the scenario's `uchg`s and `chmod`s so the temp dir can go.
impl Drop for Tree {
    fn drop(&mut self) {
        if self.flagged.get() {
            std::process::Command::new("chflags")
                .args(["-R", "nouchg"])
                .arg(&self.root)
                .stderr(std::process::Stdio::null())
                .status()
                .ok();
        }
        fn open_up(p: &Path) {
            let Ok(meta) = std::fs::symlink_metadata(p) else {
                return;
            };
            if !meta.is_dir() {
                return;
            }
            let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755));
            if let Ok(rd) = std::fs::read_dir(p) {
                for e in rd.flatten() {
                    open_up(&e.path());
                }
            }
        }
        open_up(&self.root);
    }
}

/// The recorder's `fnv1a64`: FNV-1a 64 over the UTF-8 bytes, 16 hex digits.
pub fn fnv1a64(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The recorded `got` of `step` (an index into the scenario's `gots`).
pub fn got<'a>(scenario: &'a Value, step: &Value) -> &'a Value {
    &scenario["gots"][step["got"].as_u64().unwrap() as usize]
}

/// Compare an answer (status, content type, body with the root already
/// replaced by `@@ROOT@@`) with a recorded `got`; `Err` describes the
/// difference. A recorded `threw` is Next's empty 500.
pub fn check(
    want: &Value,
    status: u16,
    content_type: Option<&str>,
    body: &str,
) -> Result<(), String> {
    if want.get("threw").is_some() {
        return if status == 500 && body.is_empty() && content_type.is_none() {
            Ok(())
        } else {
            Err(format!(
                "want Next's empty 500 ({}), got {status} {content_type:?} {body}",
                want["threw"]
            ))
        };
    }
    let mut problems = vec![];
    if want["status"].as_u64() != Some(u64::from(status)) {
        problems.push(format!("status {} vs {status}", want["status"]));
    }
    if want["type"].as_str() != content_type {
        problems.push(format!("type {} vs {content_type:?}", want["type"]));
    }
    match want.get("body") {
        Some(b) => {
            if b.as_str() != Some(body) {
                problems.push(format!(
                    "body\n    want {}\n    got  {body}",
                    b.as_str().unwrap()
                ));
            }
        }
        None => {
            let len = body.len() as u64;
            if want["len"].as_u64() != Some(len)
                || want["fnv"].as_str() != Some(fnv1a64(body).as_str())
            {
                let head: String = body.chars().take(400).collect();
                problems.push(format!(
                    "hashed body: len {} vs {len}\n    want head {}\n    got  head {head}",
                    want["len"], want["head"]
                ));
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}
