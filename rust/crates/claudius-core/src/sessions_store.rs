//! Session JSONL store — the Rust replacement for the SDK functions
//! `lib/server/sessions-store.ts` wraps (`listSessions`, `getSessionInfo`,
//! `getSessionMessages`, `renameSession`, `forkSession`).
//!
//! The SDK derives list metadata from a 64 KiB head + 64 KiB tail of each
//! `<config>/projects/<enc-cwd>/<uuid>.jsonl` using string scans (not full
//! JSON parses) — reproduced here function-for-function (`zt`, `Ya`, `FEe`,
//! `pE`, `$f`/`gi`, `uD`, `sl`) so titles/summaries match what the TS app shows.
//!
//! Transcript reconstruction lives in [`crate::transcript`].
//!
//! `listSessions` itself (scan, `continued-in` hiding, the relocated-cwd
//! check, order and paging) is [`crate::sessions_list`]; [`list`] is the
//! `sessions-store.ts` wrapper over it. Remote session stores aren't
//! ported (tracked in PORT_PLAN.md).

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::paths;

const HEAD_TAIL: usize = 65_536;

static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
});
// JS `.` stops at every line terminator; JS `\s` is `js::is_whitespace`
// and JS `\w` is ASCII.
static COMMAND_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"<command-name>([^\n\r\x{2028}\x{2029}]*?)</command-name>").unwrap()
});
static BASH_INPUT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<bash-input>(.*?)</bash-input>").unwrap());
const JS_SPACE: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";
static SKIP_PROMPT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:[{JS_SPACE}]*<[a-z][A-Za-z0-9_-]*[{JS_SPACE}>]|\[Request interrupted by user[^\]]*\])"
    ))
    .unwrap()
});
// `Cf` in `hU`: runs of control / format characters and line separators.
static TITLE_JUNK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}\x{2028}\x{2029}]+").unwrap());

pub fn is_uuid(s: &str) -> bool {
    UUID_RE.is_match(s)
}

/// `SDKSessionInfo`
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub summary: String,
    pub last_modified: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

pub struct HeadTail {
    pub head: String,
    pub tail: String,
    pub mtime_ms: i64,
    pub size: u64,
}

fn lossy(buf: &[u8]) -> String {
    String::from_utf8_lossy(buf).into_owned()
}

/// Node's `stat().mtime.getTime()`: `Math.round` of the double
/// `sec * 1e3 + nsec / 1e6` (so a few ns short of a half millisecond can
/// round up).
pub fn node_ms(t: std::time::SystemTime) -> i64 {
    let nanos = match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i128,
        Err(e) => -(e.duration().as_nanos() as i128),
    };
    let (sec, nsec) = (
        nanos.div_euclid(1_000_000_000),
        nanos.rem_euclid(1_000_000_000),
    );
    let ms = sec as f64 * 1e3 + nsec as f64 / 1e6;
    let floor = ms.floor();
    (if ms - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }) as i64
}

/// Open for reading without following a final symlink and without blocking
/// on a FIFO (`O_NOFOLLOW | O_NONBLOCK`, as the SDK opens transcripts).
pub(crate) fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut opts, libc::O_NOFOLLOW | libc::O_NONBLOCK);
    opts.open(path)
}

/// `_i()` — first and last 64 KiB of a regular file (not through a symlink).
pub fn read_head_tail(path: &Path) -> Option<HeadTail> {
    let mut f = open_no_follow(path).ok()?;
    let meta = f.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let size = meta.len();
    let mut buf = vec![0u8; HEAD_TAIL];
    let n = f.read(&mut buf).ok()?;
    if n == 0 {
        return None;
    }
    let head = lossy(&buf[..n]);
    let tail_start = size.saturating_sub(HEAD_TAIL as u64);
    let tail = if tail_start > 0 {
        f.seek(SeekFrom::Start(tail_start)).ok()?;
        let mut t = Vec::with_capacity(HEAD_TAIL);
        f.take(HEAD_TAIL as u64).read_to_end(&mut t).ok()?;
        lossy(&t)
    } else {
        head.clone()
    };
    let mtime_ms = meta.modified().ok().map(node_ms).unwrap_or(0);
    Some(HeadTail {
        head,
        tail,
        mtime_ms,
        size,
    })
}

/// `JSON.parse(line)`: serde_json, else [`claudius_agent::js::json_parse`]
/// for what only V8 reads (a lone-surrogate escape becomes U+FFFD, a number
/// past `f64` becomes `null`).
pub(crate) fn parse_line(line: &str) -> Option<Value> {
    serde_json::from_str(line)
        .ok()
        .or_else(|| claudius_agent::js::json_parse(line).ok())
}

/// `cD` — JSON-unescape a raw string body when it contains escapes.
fn unescape(raw: &str) -> String {
    if !raw.contains('\\') {
        return raw.to_owned();
    }
    match parse_line(&format!("\"{raw}\"")) {
        Some(Value::String(s)) => s,
        _ => raw.to_owned(),
    }
}

/// Scan for the end of a JSON string body starting at byte `start`.
fn string_end(text: &str, start: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut i = start;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

/// `Ya` — first `"key":"value"` occurrence (either spacing style, in order).
pub fn first_string_field(text: &str, key: &str) -> Option<String> {
    for pat in [format!("\"{key}\":\""), format!("\"{key}\": \"")] {
        if let Some(at) = text.find(&pat) {
            let start = at + pat.len();
            if let Some(end) = string_end(text, start) {
                return Some(unescape(&text[start..end]));
            }
        }
    }
    None
}

/// `zt` — LAST `"key":"value"` occurrence by position.
pub fn last_string_field(text: &str, key: &str) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for pat in [format!("\"{key}\":\""), format!("\"{key}\": \"")] {
        let mut from = 0;
        while let Some(rel) = text[from..].find(&pat) {
            let at = from + rel;
            let start = at + pat.len();
            let Some(end) = string_end(text, start) else {
                break;
            };
            if best.as_ref().is_none_or(|(pos, _)| at > *pos) {
                best = Some((at, unescape(&text[start..end])));
            }
            from = end + 1;
        }
    }
    best.map(|(_, v)| v)
}

/// `FEe` — scanning lines from the end, the first line that parses and has
/// a string `key` (and `type == type_filter` if given).
pub(crate) fn last_json_field(text: &str, key: &str, type_filter: Option<&str>) -> Option<String> {
    let key_pat = format!("\"{key}\":");
    let type_pat = type_filter.map(|t| format!("\"type\":\"{t}\""));
    for line in text.rsplit('\n') {
        if !line.contains(&key_pat)
            || type_pat
                .as_ref()
                .is_some_and(|p| !line.contains(p.as_str()))
        {
            continue;
        }
        if let Some(Value::Object(o)) = parse_line(line) {
            if type_filter.is_some_and(|t| o.get("type").and_then(Value::as_str) != Some(t)) {
                continue;
            }
            if let Some(Value::String(s)) = o.get(key) {
                return Some(s.clone());
            }
        }
    }
    None
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// `ls(s, max)`: the first `max` UTF-16 units, without a trailing half of a
/// surrogate pair.
fn truncate_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

fn is_user_line(l: &str) -> bool {
    l.contains("\"type\":\"user\"") || l.contains("\"type\": \"user\"")
}

fn has_flag(l: &str, flag: &str) -> bool {
    l.contains(&format!("\"{flag}\":true")) || l.contains(&format!("\"{flag}\": true"))
}

/// `tE` / `kee` — unwrap `<pasted_content id="xxxx">` blocks to their
/// bodies, eating up to two newlines on each side of a block exactly like
/// the SDK (byte offsets are safe: every marker is ASCII).
fn strip_pasted(e: &str) -> String {
    const OPEN: &str = "<pasted_content id=\"";
    let is_hex4 = |x: &str| {
        x.len() == 4
            && x.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let b = e.as_bytes();
    let mut parts: Vec<&str> = Vec::new();
    let mut saw_block = false;
    let (mut n, mut r) = (0usize, 0usize);
    while let Some(rel) = e.get(r..).and_then(|t| t.find(OPEN)) {
        let o = r + rel;
        let s_ = o + OPEN.len();
        let id = e.get(s_..s_ + 4).unwrap_or("");
        if !is_hex4(id) || !e.get(s_ + 4..).is_some_and(|t| t.starts_with("\">\n")) {
            r = s_;
            continue;
        }
        let a = s_ + 4 + 3;
        let close = format!("</pasted_content id=\"{id}\">");
        let Some(d_rel) = e[a - 1..].find(&format!("\n{close}")) else {
            break;
        };
        let d = a - 1 + d_rel + 1;
        let mut p = o;
        for _ in 0..2 {
            if p > n && b[p - 1] == b'\n' {
                p -= 1
            } else {
                break;
            }
        }
        if p > n {
            parts.push(&e[n..p]);
        }
        n = d + close.len();
        for _ in 0..2 {
            if n < b.len() && b[n] == b'\n' {
                n += 1
            } else {
                break;
            }
        }
        parts.push(&e[a..d - 1]);
        saw_block = true;
        r = n;
    }
    if !saw_block {
        return e.to_owned();
    }
    if n < e.len() {
        parts.push(&e[n..]);
    }
    parts.concat()
}

/// `gi` — first-prompt text of one parsed entry, or None to keep looking.
pub(crate) fn prompt_of_entry(e: &Value, command_fallback: &mut String) -> Option<String> {
    if e.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if e.get("isMeta") == Some(&Value::Bool(true))
        || e.get("isCompactSummary") == Some(&Value::Bool(true))
    {
        return None;
    }
    let content = e.get("message")?.get("content")?;
    let mut texts: Vec<&str> = Vec::new();
    match content {
        Value::String(s) => texts.push(s),
        Value::Array(parts) => {
            for p in parts {
                match p.get("type").and_then(Value::as_str) {
                    Some("tool_result") => return None,
                    Some("text") => {
                        if let Some(t) = p.get("text").and_then(Value::as_str) {
                            texts.push(t)
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    for t in texts {
        let i = strip_pasted(t).replace('\n', " ");
        let i = claudius_agent::js::trim(&i);
        if i.is_empty() {
            continue;
        }
        if let Some(c) = COMMAND_NAME_RE.captures(i) {
            if command_fallback.is_empty() {
                *command_fallback = c[1].to_owned();
            }
            continue;
        }
        if let Some(c) = BASH_INPUT_RE.captures(i) {
            return Some(format!("! {}", claudius_agent::js::trim(&c[1])));
        }
        if SKIP_PROMPT_RE.is_match(i) {
            continue;
        }
        if i.encode_utf16().count() > 200 {
            return Some(format!(
                "{}…",
                claudius_agent::js::trim(truncate_utf16(i, 200))
            ));
        }
        return Some(i.to_owned());
    }
    None
}

/// `$f`
fn first_prompt(head: &str) -> String {
    let mut fallback = String::new();
    for line in head.split('\n') {
        if !is_user_line(line) || line.contains("\"tool_result\"") {
            continue;
        }
        if has_flag(line, "isMeta") || has_flag(line, "isCompactSummary") {
            continue;
        }
        if let Some(v) = parse_line(line)
            && let Some(p) = prompt_of_entry(&v, &mut fallback)
        {
            return p;
        }
    }
    fallback
}

/// `uD` — "Image"/"Document" for media-only first prompts.
fn media_fallback(head: &str) -> String {
    for line in head.split('\n') {
        if !is_user_line(line) || line.contains("\"tool_result\"") || has_flag(line, "isMeta") {
            continue;
        }
        if line.contains("\"type\":\"image\"") || line.contains("\"type\": \"image\"") {
            return "Image".into();
        }
        if line.contains("\"type\":\"document\"") || line.contains("\"type\": \"document\"") {
            return "Document".into();
        }
    }
    String::new()
}

/// `hU` — sanitize a sidecar custom title: JS-trimmed, each run of control
/// / format characters (`\p{Cc}`, `\p{Cf}`, U+2028, U+2029) one space,
/// the first 200 code points, trimmed again.
fn sanitize_title(s: &str) -> String {
    use claudius_agent::js::trim;
    let replaced = TITLE_JUNK_RE.replace_all(trim(s), " ");
    trim(&truncate_chars(&replaced, 200)).to_owned()
}

/// `ol` — `<dir>/<sessionId>/custom-title.json` sidecar (read as lossy
/// UTF-8, like `readFile(…, "utf8")`).
pub(crate) fn sidecar_title(file: &Path, session_id: &str) -> Option<String> {
    let p = file.parent()?.join(session_id).join("custom-title.json");
    let raw = String::from_utf8_lossy(&std::fs::read(p).ok()?).into_owned();
    let v = parse_line(&raw)?;
    let t = sanitize_title(v.as_object()?.get("customTitle")?.as_str()?);
    (!t.is_empty()).then_some(t)
}

/// `sl` — build `SDKSessionInfo` from head/tail.
pub fn info_from_head_tail(
    session_id: &str,
    ht: &HeadTail,
    project_path: Option<&str>,
    sidecar: Option<String>,
) -> Option<SessionInfo> {
    let first_line = ht.head.split('\n').next().unwrap_or("");
    if first_line.contains("\"isSidechain\":true") || first_line.contains("\"isSidechain\": true") {
        return None;
    }
    let (h, t) = (&ht.head, &ht.tail);
    // `a || b || …`: an empty string falls through.
    let some = |v: Option<String>| v.filter(|s| !s.is_empty());
    let custom_title = some(last_string_field(t, "customTitle"))
        .or(sidecar)
        .or_else(|| some(last_string_field(h, "customTitle")))
        .or_else(|| some(last_string_field(t, "aiTitle")))
        .or_else(|| some(last_string_field(h, "aiTitle")));
    let first_prompt = some(Some(first_prompt(h)));
    let created_at =
        some(first_string_field(h, "timestamp")).and_then(|ts| crate::js_date::date_parse(&ts));
    let summary = custom_title
        .clone()
        .or_else(|| some(last_string_field(t, "lastPrompt")))
        .or_else(|| some(last_string_field(t, "summary")))
        .or_else(|| first_prompt.clone())
        .or_else(|| some(Some(media_fallback(h))))?;
    let git_branch = some(last_string_field(t, "gitBranch"))
        .or_else(|| some(first_string_field(h, "gitBranch")));
    let cwd = some(last_json_field(t, "relocatedCwd", Some("relocated")))
        .or_else(|| some(first_string_field(h, "cwd")))
        .or_else(|| some(project_path.map(str::to_owned)));
    let tag = t
        .split('\n')
        .rev()
        .find(|l| l.contains("\"type\":\"tag\"") && l.contains("\"tag\":\""))
        .and_then(|l| last_string_field(l, "tag"))
        .filter(|s| !s.is_empty());
    Some(SessionInfo {
        session_id: session_id.to_owned(),
        summary,
        last_modified: ht.mtime_ms,
        file_size: Some(ht.size),
        custom_title,
        first_prompt,
        git_branch,
        cwd,
        tag,
        created_at,
    })
}

fn realpath(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| p.to_owned())
}

/// `git worktree list --porcelain` paths for `dir` (empty if not a repo).
pub fn git_worktrees(dir: &str) -> Vec<String> {
    let out = std::process::Command::new("git")
        .args(["-C", dir, "worktree", "list", "--porcelain"])
        .stderr(std::process::Stdio::null())
        .output();
    let Ok(out) = out else { return vec![] };
    if !out.status.success() {
        return vec![];
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("worktree ").map(str::to_owned))
        .collect()
}

/// `getSessionInfo`'s read of a found transcript (`xU`): the sidecar title
/// only when the tail has no `customTitle`.
fn info_for(session_id: &str, file: &Path, project_path: Option<&str>) -> Option<SessionInfo> {
    let ht = read_head_tail(file)?;
    let sidecar = if last_string_field(&ht.tail, "customTitle").is_none() {
        sidecar_title(file, session_id)
    } else {
        None
    };
    info_from_head_tail(session_id, &ht, project_path, sidecar)
}

/// `lib/server/sessions-store.ts` `list({ dir, limit, includeWorktrees })`:
/// the SDK's `listSessions` with `limit ?? 200` and
/// `includeWorktrees ?? true` ([`crate::sessions_list`]). `limit` is a JS
/// number (the `/api/sessions/all` route passes `Number(q) || 200`).
pub fn list(
    dir: Option<&str>,
    limit: Option<f64>,
    include_worktrees: Option<bool>,
) -> Vec<SessionInfo> {
    list_with(
        &crate::sessions_list::ListEnv::from_process(),
        dir,
        limit,
        include_worktrees,
    )
}

/// [`list`] against an explicit projects dir (tests).
pub fn list_with(
    env: &crate::sessions_list::ListEnv,
    dir: Option<&str>,
    limit: Option<f64>,
    include_worktrees: Option<bool>,
) -> Vec<SessionInfo> {
    let opts = crate::sessions_list::ListOptions::ts_list(dir, limit, include_worktrees);
    crate::sessions_list::list_sessions_in(&opts, env)
}

/// Locate `<id>.jsonl` (in `dir`'s project dir(s) if given, else anywhere).
pub fn find_file(session_id: &str, dir: Option<&str>) -> Option<(PathBuf, Option<String>)> {
    find_file_where(session_id, dir, Path::is_file)
}

/// [`find_file`], keeping the first candidate `accept` takes.
fn find_file_where(
    session_id: &str,
    dir: Option<&str>,
    accept: impl Fn(&Path) -> bool,
) -> Option<(PathBuf, Option<String>)> {
    if !is_uuid(session_id) {
        return None;
    }
    let projects = paths::sdk_projects_dir();
    let file_name = format!("{session_id}.jsonl");
    if let Some(d) = dir {
        let real = realpath(d);
        let mut paths_ = vec![real.clone(), d.to_owned()];
        paths_.extend(git_worktrees(&real));
        for p in paths_ {
            let f = projects
                .join(paths::sdk_project_dir_name(&p))
                .join(&file_name);
            if accept(&f) {
                return Some((f, Some(p)));
            }
        }
        return None;
    }
    let rd = std::fs::read_dir(&projects).ok()?;
    rd.filter_map(Result::ok)
        .map(|e| e.path().join(&file_name))
        .find(|f| accept(f))
        .map(|f| (f, None))
}

/// `forkSession` options (`ForkSessionOptions` minus `sessionStore`).
#[derive(Debug, Default, Clone)]
pub struct ForkOptions {
    pub up_to_message_id: Option<String>,
    pub title: Option<String>,
    pub dir: Option<String>,
}

/// `forkSession(id, { dir, upToMessageId, title })` (SDK `BU`): copy the
/// session into a new `<new id>.jsonl` next to it and return the new id. The
/// copy is built by [`crate::fork`].
pub fn fork(session_id: &str, opts: &ForkOptions) -> anyhow::Result<String> {
    let file = fork_source(session_id, opts.dir.as_deref())?;
    fork_file(
        &file,
        session_id,
        opts.up_to_message_id.as_deref(),
        opts.title.as_deref(),
    )
}

/// [`fork`]'s lookup: the session's transcript, or the SDK's error.
pub fn fork_source(session_id: &str, dir: Option<&str>) -> anyhow::Result<PathBuf> {
    if !is_uuid(session_id) {
        anyhow::bail!("Invalid sessionId: {session_id}");
    }
    // `QRe` skips empty transcripts and keeps looking.
    let nonempty = |f: &Path| f.metadata().is_ok_and(|m| m.is_file() && m.len() > 0);
    let Some((file, _)) = find_file_where(session_id, dir, nonempty) else {
        match dir {
            Some(d) => anyhow::bail!("Session {session_id} not found in project directory for {d}"),
            None => anyhow::bail!("Session {session_id} not found"),
        }
    };
    Ok(file)
}

/// [`fork`] after the lookup: fork `file` (`<project dir>/<session_id>.jsonl`)
/// into a sibling `<new id>.jsonl`, written like the SDK's `Xc`: one
/// `JSON.stringify` line per entry, mode 0600, truncating.
pub fn fork_file(
    file: &Path,
    session_id: &str,
    up_to_message_id: Option<&str>,
    title: Option<&str>,
) -> anyhow::Result<String> {
    let (text, fork_id) = fork_text(file, session_id, up_to_message_id, title)?;
    write_fork(file, &fork_id, &text)?;
    Ok(fork_id)
}

/// [`fork_file`] short of the write: the fork's JSONL text and its new id.
pub fn fork_text(
    file: &Path,
    session_id: &str,
    up_to_message_id: Option<&str>,
    title: Option<&str>,
) -> anyhow::Result<(String, String)> {
    let buf = std::fs::read(file)?;
    let sidecar = sidecar_title(file, session_id);
    let loaded = crate::fork::load(&buf, session_id);
    let req = crate::fork::ForkRequest {
        session_id,
        up_to_message_id,
        title,
        now: chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
    };
    let (entries, fork_id) =
        crate::fork::build(&loaded, &req, || fork_title(&buf, sidecar), &mut || {
            uuid::Uuid::new_v4().to_string()
        })?;
    // A title from a JS caller can hold a lone surrogate (a [`js_string`]
    // stand-in), which `JSON.stringify` writes as its escape.
    let mut text = String::new();
    for e in &entries {
        text.push_str(&crate::js_string::stringify(e));
        text.push('\n');
    }
    Ok((text, fork_id))
}

/// [`fork_file`]'s write: `text` as `<fork_id>.jsonl` next to `file`.
pub fn write_fork(file: &Path, fork_id: &str, text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let dir = file
        .parent()
        .ok_or_else(|| anyhow::anyhow!("transcript has no parent directory"))?;
    // `fork_id` is a fresh v4 uuid ([`fork_text`]), so the name can't
    // escape `dir`; anything else is refused.
    if !is_uuid(fork_id) {
        anyhow::bail!("Invalid fork id: {fork_id}");
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut out = opts.open(dir.join(format!("{fork_id}.jsonl")))?;
    out.write_all(text.as_bytes())?;
    Ok(())
}

/// The fork's title fallback (the closure `oTe` hands `WU`): the tail's
/// `customTitle` (even `""`, which then falls through), else the sidecar or
/// the head's `customTitle`; then `aiTitle` (tail, head); then the first
/// prompt.
fn fork_title(buf: &[u8], sidecar: Option<String>) -> String {
    let head = lossy(&buf[..buf.len().min(HEAD_TAIL)]);
    let tail = lossy(&buf[buf.len().saturating_sub(HEAD_TAIL)..]);
    let custom = match last_string_field(&tail, "customTitle") {
        Some(c) => Some(c),
        None => sidecar.or_else(|| last_string_field(&head, "customTitle")),
    };
    [
        custom,
        last_string_field(&tail, "aiTitle"),
        last_string_field(&head, "aiTitle"),
    ]
    .into_iter()
    .flatten()
    .find(|t| !t.is_empty())
    .unwrap_or_else(|| first_prompt(&head))
}

/// `renameSession(id, title, { dir })` — append a `custom-title` entry to
/// the existing transcript (never creates one).
pub fn rename(session_id: &str, title: &str, dir: Option<&str>) -> anyhow::Result<()> {
    use std::io::Write;
    if !is_uuid(session_id) {
        anyhow::bail!("Invalid sessionId: {session_id}");
    }
    let t = claudius_agent::js::trim(title);
    if t.is_empty() {
        anyhow::bail!("title must be non-empty");
    }
    let Some((file, _)) = find_file(session_id, dir) else {
        match dir {
            Some(d) => anyhow::bail!("Session {session_id} not found in project directory for {d}"),
            None => anyhow::bail!("Session {session_id} not found in any project directory"),
        }
    };
    let line =
        serde_json::json!({"type": "custom-title", "customTitle": t, "sessionId": session_id})
            .to_string()
            + "\n";
    let mut f = std::fs::OpenOptions::new().append(true).open(file)?;
    f.write_all(line.as_bytes())?;
    Ok(())
}

/// `getSessionInfo(id, { dir })`: the transcript the SDK's lookup picks
/// ([`crate::session_file::find`]), read as `xU` reads it (not through a
/// symlink, so a linked or directory `<id>.jsonl` is `None`).
pub fn info(session_id: &str, dir: Option<&str>) -> Option<SessionInfo> {
    if !is_uuid(session_id) {
        return None;
    }
    let found = crate::session_file::find(
        session_id,
        dir,
        &crate::sessions_list::ListEnv::from_process(),
    )?;
    info_for(session_id, &found.file, found.project_path.as_deref())
}

/// `getSessionMessages(id, { dir, includeSystemMessages })` → `SessionMessage[]`,
/// from the transcript [`crate::session_file::find`] picks (read through a
/// symlink; a directory reads as `[]`).
pub fn messages(session_id: &str, dir: Option<&str>, include_system: bool) -> Vec<Value> {
    if !is_uuid(session_id) {
        return vec![];
    }
    let env = crate::sessions_list::ListEnv::from_process();
    let Some(found) = crate::session_file::find(session_id, dir, &env) else {
        return vec![];
    };
    // The SDK decodes each line with `toString("utf-8")`: invalid bytes are
    // U+FFFD, not a failed read.
    let Ok(bytes) = std::fs::read(&found.file) else {
        return vec![];
    };
    crate::transcript::session_messages(&String::from_utf8_lossy(&bytes), include_system)
}

/// `remove(id, dir)` (`deleteSession`, [`crate::session_file::delete`]):
/// `Err` is the thrown error's `message`.
pub fn remove(session_id: &str, dir: Option<&str>) -> Result<(), String> {
    crate::session_file::delete(
        session_id,
        dir,
        &crate::sessions_list::ListEnv::from_process(),
    )
}

/// `stringifyContent` (sessions-store.ts), with `""` where the TS throws
/// (see [`try_stringify_content`]).
pub fn stringify_content(content: &Value) -> String {
    try_stringify_content(Some(content)).unwrap_or_default()
}

/// `stringifyContent(content)`, `None` being `undefined`. Returns `None`
/// where the TS throws a `TypeError`: a `null` content block (`c.type`) or a
/// `null` tool_result part (`p.text`). Other non-object blocks have no
/// `type` and are skipped.
pub fn try_stringify_content(content: Option<&Value>) -> Option<String> {
    use claudius_agent::js;
    let parts = match content {
        Some(Value::String(s)) => return Some(s.clone()),
        Some(Value::Array(parts)) => parts,
        _ => return Some(String::new()),
    };
    let mut out = Vec::new();
    for c in parts {
        if c.is_null() {
            return None;
        }
        let str_of = |k: &str| c.get(k).and_then(Value::as_str);
        match str_of("type") {
            Some("text") => out.extend(str_of("text").map(str::to_owned)),
            Some("thinking") => out.extend(str_of("thinking").map(|t| format!("[thinking]\n{t}"))),
            Some("tool_use") => {
                // `String(c.name)` / `JSON.stringify(c.input ?? {}, null, 2)`.
                let empty = Value::Object(Map::new());
                let input = c.get("input").filter(|v| !v.is_null()).unwrap_or(&empty);
                out.push(format!(
                    "[tool_use {}]\n{}",
                    js::to_string(c.get("name")),
                    js::stringify_pretty(input)
                ));
            }
            Some("tool_result") => {
                let text = match c.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    // `inner.map((p) => p.text ?? "").join("")`.
                    Some(Value::Array(inner)) => {
                        let mut text = String::new();
                        for p in inner {
                            if p.is_null() {
                                return None;
                            }
                            match p.get("text") {
                                None | Some(Value::Null) => {}
                                t => text.push_str(&js::to_string(t)),
                            }
                        }
                        text
                    }
                    _ => String::new(),
                };
                out.push(format!("[tool_result]\n{text}"));
            }
            _ => {}
        }
    }
    Some(out.join("\n\n"))
}

/// `exportPlainText`: `None` where the TS throws, on a `user` / `assistant`
/// message whose `message` is `null` or missing (`m.message.content`), or
/// on content [`try_stringify_content`] rejects.
pub fn export_plain_text(session_id: &str, dir: Option<&str>) -> Option<String> {
    let mut out = Vec::new();
    for m in messages(session_id, dir, false) {
        let head = match m.get("type").and_then(Value::as_str) {
            Some("user") => "# User\n\n",
            Some("assistant") => "# Claude\n\n",
            Some("system") => {
                out.push("---\n[system]\n".to_owned());
                continue;
            }
            _ => continue,
        };
        let message = m.get("message").filter(|v| !v.is_null())?;
        out.push(format!(
            "{head}{}\n",
            try_stringify_content(message.get("content"))?
        ));
    }
    Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_field_scanners() {
        let t = r#"{"a":"x","customTitle":"one"}
{"customTitle": "two \"q\""}"#;
        assert_eq!(first_string_field(t, "customTitle").as_deref(), Some("one"));
        assert_eq!(
            last_string_field(t, "customTitle").as_deref(),
            Some("two \"q\"")
        );
    }

    #[test]
    fn first_prompt_skips_meta_and_commands() {
        let head = [
            r#"{"type":"user","isMeta":true,"message":{"content":"meta"}}"#,
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","message":{"content":"<local-command-stdout>x</local-command-stdout>"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"real\nprompt"}]}}"#,
        ]
        .join("\n");
        assert_eq!(first_prompt(&head), "real prompt");
        assert_eq!(
            first_prompt(&head.lines().take(3).collect::<Vec<_>>().join("\n")),
            "/clear"
        );
    }

    #[test]
    fn pasted_blocks_unwrap_like_sdk() {
        let t = "this\n\n<pasted_content id=\"ab12\">\nPROD failed\n</pasted_content id=\"ab12\">\n\ntail";
        assert_eq!(strip_pasted(t), "thisPROD failedtail");
        assert_eq!(strip_pasted("plain"), "plain");
        assert_eq!(
            strip_pasted("<pasted_content id=\"zz\">x"),
            "<pasted_content id=\"zz\">x"
        );
    }
}
