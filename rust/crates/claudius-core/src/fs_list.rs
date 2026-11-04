//! `lib/server/fs-list.ts`: the breadth-first walk behind the composer's
//! `@`-mention picker (`GET /api/fs/list`) and its scoring, plus
//! [`read_dir`], node's `fs.readdir(path, { withFileTypes: true })`, which
//! the `fs/dirs` route lists with too.
//!
//! The walk starts at a trusted cwd (the route resolves it first), skips
//! dot-names and the usual build folders, and stops at 5 000 entries or 6
//! levels. On macOS it never descends from unprotected space into a TCC
//! folder (`~/Desktop`, `~/Documents`, …; the folder itself is still listed)
//! and drops `~/Library/Containers` and `~/Library/Group Containers`
//! ([`crate::tcc_protected`]). Symlinks are neither files nor directories to
//! it, so they're never listed or followed. An unreadable sub-directory is
//! skipped silently, but an unreadable *root* fails the walk (CC 2.1.301: a
//! failed search, not an empty folder — the route words it `Search failed:`
//! and answers 403 / 500).
//!
//! Order is node's: `readdir` comes back sorted by raw bytes (libuv's
//! `scandir` sorts with `strcmp`), the queue is FIFO, and the scored list is
//! a stable sort on the score. Scoring runs on JS strings: `toLowerCase`,
//! then UTF-16 indices and lengths.

use std::collections::VecDeque;
use std::sync::OnceLock;

use claudius_agent::js;
use serde_json::{Value, json};

use crate::node_path::{join, relative, resolve};
use crate::paths;
use crate::tcc_protected::{categorize_tcc_path, is_hidden_home_subpath};

/// `IGNORE`: never listed, never walked (dot-names are skipped too).
pub const IGNORE: [&str; 9] = [
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".turbo",
    ".cache",
    "coverage",
    ".DS_Store",
];

/// The walk's cap on entries collected.
pub const MAX_ENTRIES: usize = 5000;
/// The walk's depth cap (the root is depth 0; entries come back from up to
/// this many levels down).
pub const MAX_DEPTH: usize = 6;

/// What a `Dirent` says an entry is. A symlink is `Other`, whatever it
/// points at (`isDirectory()` and `isFile()` are both false for it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirentKind {
    Dir,
    File,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dirent {
    pub name: String,
    pub kind: DirentKind,
}

/// `fs.promises.readdir(path, { withFileTypes: true })`: the entries sorted
/// by the raw bytes of their names (libuv's `scandir` sort is `strcmp`),
/// each name then decoded as node decodes it (UTF-8, U+FFFD for invalid
/// bytes). The type comes from the directory entry, without following a
/// symlink (an unknown type is `lstat`ed, and a failure there fails the
/// whole read, as in node).
pub fn read_dir(path: &str) -> std::io::Result<Vec<Dirent>> {
    Ok(read_dir_typed(path)?
        .into_iter()
        .map(|(name, t)| Dirent {
            name,
            kind: match t {
                EntryType::Dir => DirentKind::Dir,
                EntryType::File => DirentKind::File,
                EntryType::Symlink | EntryType::Other => DirentKind::Other,
            },
        })
        .collect())
}

/// What a `Dirent` says an entry is, a symlink told apart from the other
/// kinds (`isSymbolicLink()`), whatever it points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryType {
    Dir,
    File,
    Symlink,
    Other,
}

/// [`read_dir`] with [`EntryType`]s: `(name, type)` in libuv's order.
pub fn read_dir_typed(path: &str) -> std::io::Result<Vec<(String, EntryType)>> {
    let mut raw: Vec<(Vec<u8>, EntryType)> = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let t = entry.file_type()?;
        let kind = if t.is_dir() {
            EntryType::Dir
        } else if t.is_file() {
            EntryType::File
        } else if t.is_symlink() {
            EntryType::Symlink
        } else {
            EntryType::Other
        };
        raw.push((name_bytes(&entry.file_name()), kind));
    }
    raw.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(raw
        .into_iter()
        .map(|(name, kind)| (String::from_utf8_lossy(&name).into_owned(), kind))
        .collect())
}

#[cfg(unix)]
fn name_bytes(name: &std::ffi::OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    name.as_bytes().to_vec()
}

#[cfg(not(unix))]
fn name_bytes(name: &std::ffi::OsStr) -> Vec<u8> {
    name.to_string_lossy().into_owned().into_bytes()
}

/// Node's `err.code` for an fs error (libuv's errno name), where known.
pub fn error_code(e: &std::io::Error) -> Option<&'static str> {
    #[cfg(unix)]
    {
        e.raw_os_error()
            .and_then(claudius_agent::binary::errno_name)
    }
    #[cfg(not(unix))]
    {
        use std::io::ErrorKind;
        match e.kind() {
            ErrorKind::NotFound => Some("ENOENT"),
            ErrorKind::PermissionDenied => Some("EPERM"),
            ErrorKind::AlreadyExists => Some("EEXIST"),
            _ => None,
        }
    }
}

/// `FsEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsEntry {
    /// Relative to the walk root, forward slashes; a directory ends in `/`.
    pub rel_path: String,
    pub abs_path: String,
    pub is_dir: bool,
}

impl FsEntry {
    /// `{ relPath, absPath, type }`, in the TS key order.
    pub fn to_json(&self) -> Value {
        json!({
            "relPath": self.rel_path,
            "absPath": self.abs_path,
            "type": if self.is_dir { "dir" } else { "file" },
        })
    }
}

/// fs-list.ts's `HOME`: `resolve(homedir())`, taken once.
pub fn home() -> &'static str {
    static HOME: OnceLock<String> = OnceLock::new();
    HOME.get_or_init(|| resolve(&[&paths::home_dir().to_string_lossy()]))
}

/// `walk(root, { max, maxDepth })` with fs-list.ts's `HOME` and
/// `process.platform` passed in. `Err` is the `readdir` error of `root`
/// itself; a sub-directory's is swallowed.
fn walk(
    root: &str,
    home: &str,
    platform: &str,
    max: usize,
    max_depth: usize,
) -> std::io::Result<Vec<FsEntry>> {
    let mut out: Vec<FsEntry> = Vec::new();
    let mut queue: VecDeque<(String, usize)> = VecDeque::from([(root.to_owned(), 0)]);
    while out.len() < max {
        let Some((abs, depth)) = queue.pop_front() else {
            break;
        };
        // Whether this node is already inside a TCC category: a child is
        // only refused when it would *cross* into one.
        let parent_category = categorize_tcc_path(&abs, home, platform);
        let entries = match read_dir(&abs) {
            Ok(entries) => entries,
            Err(e) if abs == root => return Err(e),
            Err(_) => continue,
        };
        for ent in entries {
            if out.len() >= max {
                break;
            }
            if IGNORE.contains(&ent.name.as_str()) || ent.name.starts_with('.') {
                continue;
            }
            let child_abs = join(&[&abs, &ent.name]);
            // `relative(HOME, childAbs).split(sep).join("/")` (sep is `/`).
            let rel_from_home = relative(home, &child_abs);
            if platform == "darwin"
                && !rel_from_home.starts_with("..")
                && is_hidden_home_subpath(&rel_from_home, platform)
            {
                continue;
            }
            let rel = relative(root, &child_abs);
            match ent.kind {
                DirentKind::Dir => {
                    out.push(FsEntry {
                        rel_path: format!("{rel}/"),
                        abs_path: child_abs.clone(),
                        is_dir: true,
                    });
                    if depth + 1 < max_depth {
                        let child_category = categorize_tcc_path(&child_abs, home, platform);
                        let crossing_into_protected =
                            parent_category.is_none() && child_category.is_some();
                        if !crossing_into_protected {
                            queue.push_back((child_abs, depth + 1));
                        }
                    }
                }
                DirentKind::File => out.push(FsEntry {
                    rel_path: rel,
                    abs_path: child_abs,
                    is_dir: false,
                }),
                DirentKind::Other => {}
            }
        }
    }
    Ok(out)
}

/// `Array.prototype.slice(0, end)`'s end for a JS number `end`
/// (`ToIntegerOrInfinity`, then counted back from the length if negative).
pub fn js_slice_end(len: usize, end: f64) -> usize {
    let rel = if end.is_nan() { 0.0 } else { end.trunc() };
    if rel < 0.0 {
        (len as f64 + rel).max(0.0) as usize
    } else {
        rel.min(len as f64) as usize
    }
}

fn index_of(hay: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| hay[i..].starts_with(needle))
}

/// `score` for one lower-cased `relPath` against a non-empty lower-cased
/// query (both UTF-16): prefix > substring > subsequence, then +10 000 when
/// the part after the last `/` holds the query (for a directory that part
/// is empty: its `relPath` ends in `/`). `None` when it doesn't match or
/// scores ≤ 0.
fn score(hay: &[u16], q: &[u16]) -> Option<f64> {
    let len = hay.len() as f64;
    let mut score = -1.0;
    if hay.starts_with(q) {
        score = 1000.0 - len;
    } else if let Some(idx) = index_of(hay, q) {
        score = 500.0 - idx as f64 - len / 100.0;
    } else {
        let (mut n, mut h) = (0, 0);
        while h < hay.len() && n < q.len() {
            if hay[h] == q[n] {
                n += 1;
            }
            h += 1;
        }
        if n == q.len() {
            score = 100.0 - len / 100.0;
        }
    }
    if score <= 0.0 {
        return None;
    }
    let slash = hay.iter().rposition(|&u| u == u16::from(b'/'));
    let basename = slash.map_or(hay, |s| &hay[s + 1..]);
    if index_of(basename, q).is_some() {
        score += 10000.0;
    }
    Some(score)
}

/// `listFs({ cwd, query, limit })` with this process's `HOME` and platform.
pub fn list_fs(cwd: &str, query: &str, limit: f64) -> std::io::Result<Vec<FsEntry>> {
    list_fs_in(home(), crate::tcc_protected::platform(), cwd, query, limit)
}

/// [`list_fs`] with fs-list.ts's `HOME` and `process.platform` given.
pub fn list_fs_in(
    home: &str,
    platform: &str,
    cwd: &str,
    query: &str,
    limit: f64,
) -> std::io::Result<Vec<FsEntry>> {
    let root = resolve(&[cwd]);
    // Always walk broadly; `limit` only applies after scoring.
    let mut all = walk(&root, home, platform, MAX_ENTRIES, MAX_DEPTH)?;
    let q = js::trim(query).to_lowercase();
    if q.is_empty() {
        all.truncate(js_slice_end(all.len(), limit));
        return Ok(all);
    }
    let q: Vec<u16> = q.encode_utf16().collect();
    let mut scored: Vec<(FsEntry, f64)> = all
        .into_iter()
        .filter_map(|e| {
            let hay: Vec<u16> = e.rel_path.to_lowercase().encode_utf16().collect();
            score(&hay, &q).map(|s| (e, s))
        })
        .collect();
    // `(a, b) => b.score - a.score`, stable.
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let end = js_slice_end(scored.len(), limit);
    Ok(scored.into_iter().take(end).map(|(e, _)| e).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_end_is_js() {
        assert_eq!(js_slice_end(10, 200.0), 10);
        assert_eq!(js_slice_end(10, 3.9), 3);
        assert_eq!(js_slice_end(10, -3.0), 7);
        assert_eq!(js_slice_end(10, -0.5), 0);
        assert_eq!(js_slice_end(10, -0.0), 0);
        assert_eq!(js_slice_end(10, -20.0), 0);
        assert_eq!(js_slice_end(10, f64::INFINITY), 10);
        assert_eq!(js_slice_end(10, f64::NEG_INFINITY), 0);
    }

    #[test]
    fn a_directory_never_gets_the_basename_bonus() {
        let u = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        assert_eq!(
            score(&u("src/config.ts"), &u("config")),
            Some(500.0 - 4.0 - 0.13 + 10000.0)
        );
        assert_eq!(score(&u("config/"), &u("config")), Some(1000.0 - 7.0));
        assert_eq!(score(&u("abc"), &u("ac")), Some(100.0 - 0.03));
        assert_eq!(score(&u("abc"), &u("ca")), None);
    }
}
