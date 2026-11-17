//! The disk side of `app/api/workspaces/[id]/files/route.ts` (D03): the
//! path rules, one level of a folder (`listDir`), the recursive filename
//! and content searches (`searchFiles`, `searchFileContents`) and the image
//! types `?serve=1` answers. The routes are `claudius-server`'s
//! `workspace_files`.
//!
//! Paths are the strings the TS builds with `path.posix`; a path is inside
//! the root when `relative(root, path)` doesn't start with `..` (so a
//! first segment like `..foo` counts as outside, as in TS). Every fs call
//! here has its containment check inline right above it. Like TS, the walks
//! never follow a symlink (a `Dirent` that is one is skipped), but a
//! listing `stat`s through them and the file routes read and write through
//! them (PORT_PLAN "Mirrored TS bugs", T08a).
//!
//! Names are compared and sorted as JS does: `toLowerCase`
//! ([`js_string::to_lower`]), `includes` / `indexOf` (UTF-16 indices), and
//! `localeCompare` ([`collate::locale_compare`]) in a stable sort. Names,
//! paths and file text are well formed (node decodes them with U+FFFD), so
//! they are plain `String`s (no lone-surrogate stand-ins: U+10F800 and up
//! are themselves).
//! Replayed against the TS through the routes by
//! `claudius-server/tests/workspace_files.rs`.

use std::cmp::Ordering;
use std::io::Read;

use claudius_agent::js;
use serde_json::{Value, json};

use crate::fs_list::{self, EntryType};
use crate::js_string;
use crate::node_path::{is_absolute, join, normalize, relative};
use crate::{collate, node_fs};

/// The search caps: matches returned, entries visited.
pub const SEARCH_RESULT_LIMIT: usize = 1000;
pub const SEARCH_SCAN_LIMIT: usize = 50_000;
/// The content search caps: matching lines returned, files read, the
/// largest file read, the NUL probe, a line's snippet (UTF-16 units).
pub const CONTENT_RESULT_LIMIT: usize = 1000;
pub const CONTENT_FILE_LIMIT: usize = 5000;
pub const CONTENT_MAX_BYTES: u64 = 1024 * 1024;
pub const CONTENT_BINARY_PROBE: u64 = 8 * 1024;
pub const CONTENT_LINE_SNIPPET: usize = 400;

/// `HIDDEN.has(name) || name.startsWith(".")` (`HIDDEN` is the
/// [`fs_list::IGNORE`] set).
pub fn is_hidden(name: &str) -> bool {
    fs_list::IGNORE.contains(&name) || name.starts_with('.')
}

/// `inside(root, target)`: `relative(root, target)` is `""`, or neither
/// starts with `..` nor is absolute.
pub fn inside(root: &str, target: &str) -> bool {
    let r = relative(root, target);
    r.is_empty() || (!r.starts_with("..") && !is_absolute(&r))
}

/// `normalize(rawPath).replace(/^\/+/, "")`: the request path made
/// relative.
pub fn rel_path(raw: &str) -> String {
    normalize(raw).trim_start_matches('/').to_owned()
}

/// What a resolved path under `root` must start with: `root/` (just `/`
/// for the root `/`, which holds every absolute path).
pub fn under(root: &str) -> String {
    if root.ends_with('/') {
        root.to_owned()
    } else {
        format!("{root}/")
    }
}

/// `IMAGE_MIME[target.split(".").pop().toLowerCase()]`: a plain object, so
/// `constructor` and `__proto__` (the only all-lowercase names on
/// `Object.prototype`) hit the inherited `Object` function and
/// `Object.prototype`, which the response header prints as `String()`
/// does.
pub fn image_mime(target: &str) -> Option<&'static str> {
    let ext = js_string::to_lower(target.rsplit('.').next().unwrap_or_default());
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "tiff" | "tif" => "image/tiff",
        "constructor" => "function Object() { [native code] }",
        "__proto__" => "[object Object]",
        _ => return None,
    })
}

/// `stat.mtimeMs`.
fn mtime_ms(m: &std::fs::Metadata) -> f64 {
    m.modified().map(node_fs::mtime_ms).unwrap_or(f64::NAN)
}

/// A file or folder of a listing: `{name, relPath, kind, sizeBytes?,
/// modifiedMs}`, a folder's `relPath` ending in `/`.
fn entry_json(name: &str, rel: &str, m: &std::fs::Metadata) -> Option<Value> {
    if m.is_dir() {
        Some(json!({
            "name": name,
            "relPath": format!("{rel}/"),
            "kind": "dir",
            "modifiedMs": mtime_ms(m),
        }))
    } else if m.is_file() {
        Some(json!({
            "name": name,
            "relPath": rel,
            "kind": "file",
            "sizeBytes": m.len() as f64,
            "modifiedMs": mtime_ms(m),
        }))
    } else {
        None
    }
}

/// `listDir(root, dir)`: one level of `dir` without the hidden names
/// (counted in the second value), each entry `stat`ed (through a
/// symlink; one that fails, or isn't a file or folder, is left out),
/// folders first, then by `localeCompare` of the names. The `readdir`
/// error is the caller's.
pub fn list_dir(root: &str, dir: &str) -> std::io::Result<(Vec<Value>, usize)> {
    let base = under(root);
    if dir != root && !dir.starts_with(&base) {
        return Ok((Vec::new(), 0));
    }
    let names = fs_list::read_dir_typed(dir)?;
    let mut out: Vec<(bool, String, Value)> = Vec::new();
    let mut hidden = 0;
    for (name, _) in names {
        if is_hidden(&name) {
            hidden += 1;
            continue;
        }
        let abs = join(&[dir, &name]);
        if !inside(root, &abs) {
            continue;
        }
        if !abs.starts_with(&base) {
            continue;
        }
        let Ok(m) = std::fs::metadata(&abs) else {
            continue;
        };
        if let Some(e) = entry_json(&name, &relative(root, &abs), &m) {
            out.push((m.is_dir(), name, e));
        }
    }
    out.sort_by(|a, b| match (a.0, b.0) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => collate::locale_compare(&a.1, &b.1),
    });
    Ok((out.into_iter().map(|(_, _, e)| e).collect(), hidden))
}

/// `searchFiles(root, baseDir, q)`: the files under `base_dir` whose
/// root-relative path holds `q` (already trimmed and lowercased) once
/// lowercased, as `{name, relPath, kind: "file"}` by `localeCompare` of the
/// paths, and whether a cap cut the walk short. The walk is a stack (the
/// last folder found is read next), skips hidden names and symlinks, and
/// leaves out a sub-folder it can't read. `Err` is the `readdir` error of
/// `base_dir` itself: the search failed, it didn't find nothing (CC
/// 2.1.301; the route's `searchFailed`).
pub fn search_files(root: &str, base_dir: &str, q: &str) -> std::io::Result<(Vec<Value>, bool)> {
    let base = under(root);
    let mut matches: Vec<(String, Value)> = Vec::new();
    let mut stack = vec![base_dir.to_owned()];
    let mut scanned = 0;
    let mut truncated = false;
    while !truncated && let Some(dir) = stack.pop() {
        if dir != root && !dir.starts_with(&base) {
            continue;
        }
        let names = match fs_list::read_dir_typed(&dir) {
            Ok(names) => names,
            Err(e) if dir == base_dir => return Err(e),
            Err(_) => continue,
        };
        for (name, t) in names {
            if is_hidden(&name) || t == EntryType::Symlink {
                continue;
            }
            let abs = join(&[&dir, &name]);
            if !inside(root, &abs) {
                continue;
            }
            scanned += 1;
            if scanned >= SEARCH_SCAN_LIMIT {
                truncated = true;
                break;
            }
            match t {
                EntryType::Dir => stack.push(abs),
                EntryType::File => {
                    let rel = relative(root, &abs);
                    if js_string::to_lower(&rel).contains(q) {
                        matches.push((
                            rel.clone(),
                            json!({"name": name, "relPath": rel, "kind": "file"}),
                        ));
                        if matches.len() >= SEARCH_RESULT_LIMIT {
                            truncated = true;
                            break;
                        }
                    }
                }
                EntryType::Symlink | EntryType::Other => {}
            }
        }
    }
    matches.sort_by(|a, b| collate::locale_compare(&a.0, &b.0));
    Ok((matches.into_iter().map(|(_, m)| m).collect(), truncated))
}

/// One matching line of a content search (`ContentMatch`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContentMatch {
    pub rel_path: String,
    pub line: usize,
    pub col: i64,
    pub col_end: i64,
    /// UTF-16 code units: a snippet cut through a surrogate pair keeps the
    /// lone half.
    pub text: Vec<u16>,
    pub truncated: bool,
}

impl ContentMatch {
    /// `JSON.stringify` of the match (the lone half as its `\udxxx`).
    pub fn write_json(&self, out: &mut String) {
        out.push_str("{\"relPath\":");
        out.push_str(&js::stringify(&json!(self.rel_path)));
        out.push_str(&format!(
            ",\"line\":{},\"col\":{},\"colEnd\":{},\"text\":",
            self.line, self.col, self.col_end
        ));
        js::stringify_utf16(&self.text, out);
        out.push_str(&format!(",\"truncated\":{}}}", self.truncated));
    }
}

/// `JSON.stringify(matches)`.
pub fn matches_json(matches: &[ContentMatch]) -> String {
    let mut out = String::from("[");
    for (i, m) in matches.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        m.write_json(&mut out);
    }
    out.push(']');
    out
}

/// The matching lines of one file's `content` (`split(/\r?\n/)`): the
/// first hit of `needle` (`q`, lowercased unless `case_sensitive`) in the
/// line (lowercased likewise), with 1-based UTF-16 columns whose end adds
/// `q`'s length. A line over 400 units is cut to 400 around the hit,
/// counting from where the hit is in the lowercased line, which can sit
/// elsewhere in the original when lowercasing changed lengths. Stops once
/// `matches` holds [`CONTENT_RESULT_LIMIT`] (the `bool`).
pub fn match_lines(
    rel: &str,
    content: &str,
    q: &str,
    needle: &str,
    case_sensitive: bool,
    matches: &mut Vec<ContentMatch>,
) -> bool {
    // `.length`: these are plain strings (a U+10F800–U+10FFFF character is
    // two units), so not `js_string::len16`, which counts a stand-in as one.
    let q_len = q.encode_utf16().count() as i64;
    let needle_len = needle.encode_utf16().count() as i64;
    let mut lines: Vec<&str> = content.split('\n').collect();
    let last = lines.len() - 1;
    for l in &mut lines[..last] {
        *l = l.strip_suffix('\r').unwrap_or(l);
    }
    for (i, line) in lines.iter().enumerate() {
        let lowered;
        let hay = if case_sensitive {
            *line
        } else {
            lowered = js_string::to_lower(line);
            lowered.as_str()
        };
        // Both are well formed, so the first UTF-16 hit is at a char.
        let Some(at) = hay.find(needle) else {
            continue;
        };
        let idx = hay[..at].encode_utf16().count() as i64;
        let units: Vec<u16> = line.encode_utf16().collect();
        let m = if units.len() > CONTENT_LINE_SNIPPET {
            let half = (CONTENT_LINE_SNIPPET as i64 - needle_len).div_euclid(2);
            let start = (idx - half).max(0);
            let end = (units.len() as i64).min(start + CONTENT_LINE_SNIPPET as i64);
            let text = if start < end {
                units[start as usize..end as usize].to_vec()
            } else {
                Vec::new()
            };
            let col = (idx - start + 1).max(1);
            ContentMatch {
                rel_path: rel.to_owned(),
                line: i + 1,
                col,
                col_end: col + q_len,
                text,
                truncated: true,
            }
        } else {
            ContentMatch {
                rel_path: rel.to_owned(),
                line: i + 1,
                col: idx + 1,
                col_end: idx + 1 + q_len,
                text: units,
                truncated: false,
            }
        };
        matches.push(m);
        if matches.len() >= CONTENT_RESULT_LIMIT {
            return true;
        }
    }
    false
}

/// `searchFileContents(root, baseDir, q, caseSensitive)`: the matching
/// lines of the text files under `base_dir` ([`match_lines`]), by
/// `localeCompare` of the paths, then line; whether a cap cut the walk
/// short; and how many files it counted. Same walk as [`search_files`]; a
/// file is counted before the cap check, and skipped when it's empty, over
/// 1 MiB, has a NUL in its first 8 KiB (one read; a short one leaves the
/// rest of the probe zeros) or can't be read. It reads as UTF-8 with
/// U+FFFD (a BOM stays in the first line). `Err` is the `readdir` error of
/// `base_dir` itself, as in [`search_files`].
pub fn search_contents(
    root: &str,
    base_dir: &str,
    q: &str,
    case_sensitive: bool,
) -> std::io::Result<(Vec<ContentMatch>, bool, usize)> {
    if q.is_empty() {
        return Ok((Vec::new(), false, 0));
    }
    let needle = if case_sensitive {
        q.to_owned()
    } else {
        js_string::to_lower(q)
    };
    let base = under(root);
    let mut matches: Vec<ContentMatch> = Vec::new();
    let mut stack = vec![base_dir.to_owned()];
    let mut files_scanned = 0;
    let mut truncated = false;
    while !truncated && let Some(dir) = stack.pop() {
        if dir != root && !dir.starts_with(&base) {
            continue;
        }
        let names = match fs_list::read_dir_typed(&dir) {
            Ok(names) => names,
            Err(e) if dir == base_dir => return Err(e),
            Err(_) => continue,
        };
        for (name, t) in names {
            if is_hidden(&name) || t == EntryType::Symlink {
                continue;
            }
            let abs = join(&[&dir, &name]);
            if !inside(root, &abs) {
                continue;
            }
            if t == EntryType::Dir {
                stack.push(abs);
                continue;
            }
            if t != EntryType::File {
                continue;
            }
            files_scanned += 1;
            if files_scanned >= CONTENT_FILE_LIMIT {
                truncated = true;
                break;
            }
            if !abs.starts_with(&base) {
                continue;
            }
            let Ok(m) = std::fs::metadata(&abs) else {
                continue;
            };
            if m.len() == 0 || m.len() > CONTENT_MAX_BYTES {
                continue;
            }
            let mut probe = vec![0u8; CONTENT_BINARY_PROBE.min(m.len()) as usize];
            let Ok(mut f) = std::fs::File::open(&abs) else {
                continue;
            };
            if f.read(&mut probe).is_err() {
                continue;
            }
            if probe.contains(&0) {
                continue;
            }
            let Ok(content) = node_fs::read_to_string(&abs) else {
                continue;
            };
            let rel = relative(root, &abs);
            if match_lines(&rel, &content, q, &needle, case_sensitive, &mut matches) {
                truncated = true;
                break;
            }
        }
    }
    matches.sort_by(|a, b| {
        if a.rel_path != b.rel_path {
            collate::locale_compare(&a.rel_path, &b.rel_path)
        } else {
            a.line.cmp(&b.line)
        }
    });
    Ok((matches, truncated, files_scanned))
}
