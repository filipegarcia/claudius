//! `listSessions` (SDK 0.3.299 `LMt` → `wU`), without a `sessionStore`.
//!
//! - **Scan** (`dRe` / `uRe` / `RU` / `Hn` / `xm`): with no `dir`, every
//!   directory in `<config>/projects`. With a `dir`, only the project dir of
//!   its realpath (NFC on macOS), plus, if that hashed name is over 200
//!   chars, sibling dirs with the same 200-char prefix holding a transcript
//!   whose cwd encodes to the same path (`Qa`). With `CLAUDE_CONFIG_DIR` and
//!   `CLAUDE_CODE_PROJECT_DIR_NAME` set, that name and the natural one. With
//!   `includeWorktrees` (default) and more than one `git worktree list`
//!   entry, also every project dir named after a worktree. Directory
//!   listings are byte-sorted, as libuv sorts them; a transcript is
//!   `<uuid>.jsonl` (any case).
//! - **Each session** (`TU`): the 64 KiB head and tail (a symlink, FIFO or
//!   non-file isn't read); with `includeProgrammatic: false`, SDK-started
//!   sessions (`entrypoint` `sdk-*`, `sessionKind` `daemon*`) are dropped.
//!   A session whose tail ends in a `continued-in` record is hidden once the
//!   session it continued in exists next to it with a `"parentUuid":` line
//!   (`CU` / `AU` / `vU`). In a `dir` listing, a session whose cwd (the
//!   tail's `relocated` stamp, else the head's) encodes to the same project
//!   dir name as the listed path but resolves elsewhere belongs to that
//!   other path and is hidden (`mD`), unless the cwd is inside one of the
//!   listed worktrees (`gD`), or either path is a network / device path or
//!   reaches one through a symlink (`xc` / `nP`).
//! - **Order** (`cRe` / `lRe`): without a positive `limit` or `offset`,
//!   every session once (the copy with the newest mtime, the first on a
//!   tie), newest first, then by id descending. With one, candidates are
//!   sorted by their stat mtime the same way and read in order: the first
//!   readable copy of an id wins, `offset` of them are skipped and up to
//!   `limit` are kept; `lastModified` is that stat mtime.
//!
//! Not ported: the win32 drive-letter alias of `hE`, and the remote
//! (`sessionStore` / hover-rest) paths, which the SDK host never takes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::paths;
use crate::sessions_store::{
    self, HeadTail, SessionInfo, first_string_field, last_json_field, last_string_field, parse_line,
};

/// `listSessions` options (`ListSessionsOptions` minus `sessionStore`).
/// Numbers are JS numbers: `limit` and `offset` only count when `> 0`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ListOptions {
    pub dir: Option<String>,
    pub limit: Option<f64>,
    pub offset: Option<f64>,
    pub include_worktrees: Option<bool>,
    pub include_programmatic: Option<bool>,
}

impl ListOptions {
    /// What `lib/server/sessions-store.ts` `list()` passes: `limit ?? 200`,
    /// `includeWorktrees ?? true`.
    pub fn ts_list(dir: Option<&str>, limit: Option<f64>, include_worktrees: Option<bool>) -> Self {
        ListOptions {
            dir: dir.map(str::to_owned),
            limit: Some(limit.unwrap_or(200.0)),
            offset: None,
            include_worktrees: Some(include_worktrees.unwrap_or(true)),
            include_programmatic: None,
        }
    }
}

/// Where the listing looks: `ut()` and the `Vk()` project-dir override.
#[derive(Clone, Debug)]
pub struct ListEnv {
    pub projects: PathBuf,
    /// `CLAUDE_CODE_PROJECT_DIR_NAME`, if it applies (`pS`).
    pub project_dir_name: Option<String>,
}

impl ListEnv {
    /// The process's: `<config dir, NFC>/projects`, and the override when
    /// `CLAUDE_CONFIG_DIR` is set and the name is a plain one.
    pub fn from_process() -> Self {
        let config_set = std::env::var_os("CLAUDE_CONFIG_DIR").is_some_and(|v| !v.is_empty());
        let name = std::env::var("CLAUDE_CODE_PROJECT_DIR_NAME").ok();
        Self::for_config(paths::claude_config_dir(), config_set, name.as_deref())
    }

    /// `ut()` (`mt()` is NFC on every platform) and `Vk()`.
    fn for_config(config: PathBuf, config_set: bool, name: Option<&str>) -> Self {
        let config = match config.to_str() {
            Some(s) => PathBuf::from(nfc(s)),
            None => config,
        };
        ListEnv {
            projects: config.join("projects"),
            project_dir_name: if config_set {
                plain_dir_name(name)
            } else {
                None
            },
        }
    }

    /// `zr`: the project dir name for `path`.
    fn name_for(&self, path: &str) -> String {
        self.project_dir_name
            .clone()
            .unwrap_or_else(|| paths::sdk_project_dir_name(path))
    }

    /// `Xa`
    fn dir_for(&self, path: &str) -> PathBuf {
        self.projects.join(self.name_for(path))
    }
}

/// `pS`: a 1–64 char `[A-Za-z0-9_-]` name that isn't a Windows device name.
pub fn plain_dir_name(name: Option<&str>) -> Option<String> {
    static PLAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").unwrap());
    static DEVICE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$").unwrap());
    let n = name?;
    (PLAIN.is_match(n) && !DEVICE.is_match(n)).then(|| n.to_owned())
}

/// `listSessions(opts)` against the process's config dir.
pub fn list_sessions(opts: &ListOptions) -> Vec<SessionInfo> {
    list_sessions_in(opts, &ListEnv::from_process())
}

/// `wU`
pub fn list_sessions_in(opts: &ListOptions, env: &ListEnv) -> Vec<SessionInfo> {
    let offset = opts.offset.unwrap_or(0.0);
    let include_programmatic = opts.include_programmatic.unwrap_or(true);
    let paged = opts.limit.is_some_and(|l| l > 0.0) || offset > 0.0;
    let cands = match opts.dir.as_deref().filter(|d| !d.is_empty()) {
        Some(dir) => scan_dir(dir, opts.include_worktrees.unwrap_or(true), paged, env),
        None => scan_all(paged, env),
    };
    if paged {
        page(cands, opts.limit, offset, include_programmatic)
    } else {
        all(&cands, include_programmatic)
    }
}

/// `lRe`
fn page(
    mut cands: Vec<Candidate>,
    limit: Option<f64>,
    offset: f64,
    include_programmatic: bool,
) -> Vec<SessionInfo> {
    cands.sort_by(|a, b| {
        b.mtime
            .cmp(&a.mtime)
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    let cap = limit.filter(|l| *l > 0.0).unwrap_or(f64::INFINITY);
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut skipped = 0.0;
    for c in &cands {
        if out.len() as f64 >= cap {
            break;
        }
        let Some(info) = session_info(c, include_programmatic) else {
            continue;
        };
        if !seen.insert(info.session_id.clone()) {
            continue;
        }
        if skipped < offset {
            skipped += 1.0;
            continue;
        }
        out.push(info);
    }
    out
}

/// `cRe`
fn all(cands: &[Candidate], include_programmatic: bool) -> Vec<SessionInfo> {
    let mut out: Vec<SessionInfo> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for c in cands {
        let Some(info) = session_info(c, include_programmatic) else {
            continue;
        };
        match at.get(&info.session_id) {
            Some(&i) if info.last_modified <= out[i].last_modified => {}
            Some(&i) => out[i] = info,
            None => {
                at.insert(info.session_id.clone(), out.len());
                out.push(info);
            }
        }
    }
    out.sort_by(|a, b| {
        b.last_modified
            .cmp(&a.last_modified)
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    out
}

struct Candidate {
    session_id: String,
    file: PathBuf,
    /// The stat mtime, or 0 when unpaged (not read).
    mtime: i64,
    project_path: Option<String>,
    own_worktrees: Option<Rc<Vec<String>>>,
}

// ---- scan ---------------------------------------------------------------------

/// A directory's entries the way `fs.readdir` returns them: sorted by name
/// bytes (libuv's `scandir` sort), names decoded lossily. `None` when the
/// directory can't be read.
pub(crate) fn read_dir_sorted(dir: &Path) -> Option<Vec<(String, std::fs::DirEntry)>> {
    let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(name_bytes);
    Some(
        entries
            .into_iter()
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e))
            .collect(),
    )
}

#[cfg(unix)]
fn name_bytes(e: &std::fs::DirEntry) -> Vec<u8> {
    std::os::unix::ffi::OsStrExt::as_bytes(e.file_name().as_os_str()).to_vec()
}

#[cfg(not(unix))]
fn name_bytes(e: &std::fs::DirEntry) -> Vec<u8> {
    e.file_name().to_string_lossy().into_owned().into_bytes()
}

/// Subdirectory names of `dir` (a `Dirent` that is a directory, not a
/// link to one), sorted.
fn subdirs(dir: &Path) -> Option<Vec<String>> {
    Some(
        read_dir_sorted(dir)?
            .into_iter()
            .filter(|(_, e)| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|(n, _)| n)
            .collect(),
    )
}

fn is_listable_dir(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok()
}

/// `xm`: the transcripts in one project dir.
fn transcripts(
    dir: &Path,
    want_mtime: bool,
    project_path: Option<&str>,
    own_worktrees: Option<&Rc<Vec<String>>>,
) -> Vec<Candidate> {
    let Some(entries) = read_dir_sorted(dir) else {
        return vec![];
    };
    entries
        .into_iter()
        .filter_map(|(name, _)| {
            let id = name.strip_suffix(".jsonl")?;
            if !sessions_store::is_uuid(id) {
                return None;
            }
            let file = dir.join(&name);
            let mtime = if want_mtime {
                sessions_store::node_ms(std::fs::metadata(&file).ok()?.modified().ok()?)
            } else {
                0
            };
            Some(Candidate {
                session_id: id.to_owned(),
                file,
                mtime,
                project_path: project_path.map(str::to_owned),
                own_worktrees: own_worktrees.cloned(),
            })
        })
        .collect()
}

/// `dRe`
fn scan_all(want_mtime: bool, env: &ListEnv) -> Vec<Candidate> {
    let Some(dirs) = subdirs(&env.projects) else {
        return vec![];
    };
    dirs.iter()
        .flat_map(|d| transcripts(&env.projects.join(d), want_mtime, None, None))
        .collect()
}

fn lower_on_windows(s: &str) -> String {
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_owned()
    }
}

/// `Hn`: the existing project dirs for `path`.
pub(crate) fn project_dirs(path: &str, env: &ListEnv) -> Vec<PathBuf> {
    let exact = env.dir_for(path);
    let mut out = Vec::new();
    if is_listable_dir(&exact) {
        out.push(exact.clone());
    }
    let natural = paths::sdk_project_dir_name(path);
    if natural != env.name_for(path) {
        let p = env.projects.join(&natural);
        if is_listable_dir(&p) {
            out.push(p);
        }
        return out;
    }
    if natural.len() <= 200 {
        return out;
    }
    let prefix = lower_on_windows(&format!("{}-", &natural[..200]));
    let exact_key = lower_on_windows(&exact.to_string_lossy());
    let Some(entries) = read_dir_sorted(&env.projects) else {
        return out;
    };
    for (name, e) in entries {
        if !e.file_type().is_ok_and(|t| t.is_dir()) || !lower_on_windows(&name).starts_with(&prefix)
        {
            continue;
        }
        let f = env.projects.join(&name);
        if lower_on_windows(&f.to_string_lossy()) != exact_key && holds_cwd(&f, path, cfg!(windows))
        {
            out.push(f);
        }
    }
    out
}

/// `Qa`: does a transcript in `dir` record a cwd that encodes like `path`?
fn holds_cwd(dir: &Path, path: &str, ci: bool) -> bool {
    let want = ja(path);
    let Some(entries) = read_dir_sorted(dir) else {
        return false;
    };
    for (name, e) in entries {
        if !e.file_type().is_ok_and(|t| t.is_file()) || !name.ends_with(".jsonl") {
            continue;
        }
        let Some(ht) = sessions_store::read_head_tail(&dir.join(&name)) else {
            continue;
        };
        // `hD`
        let Some(cwd) = recorded_cwd(&ht) else {
            continue;
        };
        let got = ja(&ke(&cwd));
        if if ci {
            got.eq_ignore_ascii_case(&want)
        } else {
            got == want
        } {
            return true;
        }
    }
    false
}

/// `RU`
fn scan_paths(paths_: &[String], want_mtime: bool, env: &ListEnv) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    let mut dirs = Vec::new();
    for p in paths_ {
        for f in project_dirs(p, env) {
            if seen.insert(lower_on_windows(&f.to_string_lossy())) {
                dirs.push((f, p));
            }
        }
    }
    dirs.iter()
        .flat_map(|(f, p)| transcripts(f, want_mtime, Some(p), None))
        .collect()
}

/// `uRe`
fn scan_dir(dir: &str, include_worktrees: bool, want_mtime: bool, env: &ListEnv) -> Vec<Candidate> {
    let real = resolved(dir);
    let listed = vec![real.clone()];
    let worktrees = if include_worktrees {
        git_worktrees(&real)
    } else {
        vec![]
    };
    if worktrees.len() <= 1 {
        return scan_paths(&listed, want_mtime, env);
    }
    struct Wt<'a> {
        path: &'a str,
        exact: String,
        prefix: Option<String>,
    }
    let mut wts: Vec<Wt> = worktrees
        .iter()
        .map(|w| {
            let name = env.name_for(w);
            let exact = lower_on_windows(&name);
            let prefix = (name.encode_utf16().count() > 200).then(|| exact[..200].to_owned());
            Wt {
                path: w,
                exact,
                prefix,
            }
        })
        .collect();
    wts.sort_by_key(|w| std::cmp::Reverse(w.exact.len()));
    let Some(names) = subdirs(&env.projects) else {
        return scan_paths(&listed, want_mtime, env);
    };
    let own = Rc::new([listed.clone(), worktrees.clone()].concat());
    let mut out = Vec::new();
    let mut taken = HashSet::new();
    for p in &listed {
        for d in project_dirs(p, env) {
            let base = d
                .file_name()
                .map(|n| lower_on_windows(&n.to_string_lossy()))
                .unwrap_or_default();
            if taken.insert(base) {
                out.extend(transcripts(&d, want_mtime, Some(p), Some(&own)));
            }
        }
    }
    for name in &names {
        let key = lower_on_windows(name);
        if taken.contains(&key) {
            continue;
        }
        for w in &wts {
            let dir = env.projects.join(name);
            let hit = key == w.exact
                || w.prefix.as_ref().is_some_and(|pre| {
                    key.starts_with(&format!("{pre}-")) && holds_cwd(&dir, w.path, cfg!(windows))
                });
            if hit {
                taken.insert(key.clone());
                out.extend(transcripts(&dir, want_mtime, Some(w.path), Some(&own)));
                break;
            }
        }
    }
    out
}

/// `bo`: the realpath (NFC on macOS), or the path itself.
pub(crate) fn resolved(p: &str) -> String {
    match std::fs::canonicalize(p) {
        Ok(r) => ke(&r.to_string_lossy()),
        Err(_) => ke(p),
    }
}

/// `So`: `git worktree list --porcelain` paths from `cwd` (NFC on macOS),
/// with the hooks and fsmonitor off and a 5 s timeout; empty on any
/// failure, empty output, or past `execFile`'s 1 MiB stdout cap.
pub(crate) fn git_worktrees(cwd: &str) -> Vec<String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let child = Command::new("git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=",
            "worktree",
            "list",
            "--porcelain",
        ])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return vec![];
    };
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(1024 * 1024 + 1).read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + Duration::from_millis(5000);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    if !status.is_some_and(|s| s.success()) || out.len() > 1024 * 1024 {
        return vec![];
    }
    String::from_utf8_lossy(&out)
        .split('\n')
        .filter_map(|l| l.strip_prefix("worktree "))
        .map(ke)
        .collect()
}

// ---- one session ----------------------------------------------------------------

/// `TU`
fn session_info(c: &Candidate, include_programmatic: bool) -> Option<SessionInfo> {
    let ht = sessions_store::read_head_tail(&c.file)?;
    if !include_programmatic && is_programmatic(&ht.head, &ht.tail) {
        return None;
    }
    if let Some(next) = continued_in(&ht.tail)
        && continuation_exists(&c.file, &next)
    {
        return None;
    }
    let sidecar = if last_string_field(&ht.tail, "customTitle").is_none() {
        sessions_store::sidecar_title(&c.file, &c.session_id)
    } else {
        None
    };
    let mut info = sessions_store::info_from_head_tail(
        &c.session_id,
        &ht,
        c.project_path.as_deref(),
        sidecar,
    )?;
    if let (Some(cwd), Some(project)) = (recorded_cwd(&ht), &c.project_path)
        && !inside_worktree(&cwd, c.own_worktrees.as_deref(), CASE_INSENSITIVE)
        && belongs_elsewhere(&cwd, project, CASE_INSENSITIVE)
    {
        return None;
    }
    if c.mtime != 0 {
        info.last_modified = c.mtime;
    }
    Some(info)
}

/// `mE()`: paths compare case-insensitively on macOS and Windows.
const CASE_INSENSITIVE: bool = cfg!(any(target_os = "macos", windows));

/// `lD`: started through the SDK (`entrypoint`) or by a daemon
/// (`sessionKind` on the first message line).
fn is_programmatic(head: &str, tail: &str) -> bool {
    let entry =
        first_string_field(head, "entrypoint").or_else(|| last_string_field(tail, "entrypoint"));
    if entry.is_some_and(|e| matches!(e.as_str(), "sdk-cli" | "sdk-ts" | "sdk-py")) {
        return true;
    }
    let line = head
        .split('\n')
        .find(|l| l.contains("\"parentUuid\":"))
        .unwrap_or(head);
    matches!(
        first_string_field(line, "sessionKind").as_deref(),
        Some("daemon" | "daemon-worker")
    )
}

const CONTINUED_IN: &str = "\"type\":\"continued-in\"";

/// `CU`: the session id the tail's last `continued-in` record names, unless
/// a real turn follows it (a user prompt, or an assistant message that
/// finished with a `stop_reason` and isn't an API error).
fn continued_in(tail: &str) -> Option<String> {
    if !tail.contains(CONTINUED_IN) {
        return None;
    }
    for line in tail.rsplit('\n') {
        let marker = line.contains(CONTINUED_IN);
        let turn = line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\"");
        if !(marker || turn) {
            continue;
        }
        let Some(v) = parse_line(line) else {
            continue;
        };
        if marker
            && let Some(o) = v.as_object()
            && o.get("type").and_then(Value::as_str) == Some("continued-in")
            && let Some(Value::String(id)) = o.get("continuedInSessionId")
        {
            return sessions_store::is_uuid(id).then(|| id.clone());
        }
        if turn && is_real_turn(&v) {
            return None;
        }
    }
    None
}

/// `tRe`
fn is_real_turn(v: &Value) -> bool {
    if let Some(o) = v.as_object()
        && o.get("type").and_then(Value::as_str) == Some("assistant")
    {
        let flag_ok = matches!(o.get("isApiErrorMessage"), None | Some(Value::Bool(_)));
        let stop = match o.get("message") {
            None => Some(None),
            Some(Value::Object(m)) => match m.get("stop_reason") {
                None | Some(Value::Null) => Some(None),
                Some(Value::String(s)) => Some(Some(s)),
                Some(_) => None,
            },
            Some(_) => None,
        };
        if flag_ok && let Some(stop) = stop {
            return o.get("isApiErrorMessage") != Some(&Value::Bool(true)) && stop.is_some();
        }
    }
    v.is_object() && sessions_store::prompt_of_entry(v, &mut String::new()).is_some()
}

const PARENT_UUID: &[u8] = b"\"parentUuid\":";

/// `AU` / `vU`: `<dir>/<id>.jsonl` exists, isn't a link, and has a message
/// line (`"parentUuid":` in its head or tail, or anywhere in its first
/// 16 MiB, or it's longer than that).
fn continuation_exists(file: &Path, id: &str) -> bool {
    let Some(dir) = file.parent() else {
        return false;
    };
    let next = dir.join(format!("{id}.jsonl"));
    let Some(ht) = sessions_store::read_head_tail(&next) else {
        return false;
    };
    let pat = std::str::from_utf8(PARENT_UUID).unwrap();
    if ht.head.contains(pat) || ht.tail.contains(pat) {
        return true;
    }
    if ht.size <= 65_536 {
        return false;
    }
    scan_for_parent_uuid(&next).unwrap_or(false)
}

fn scan_for_parent_uuid(path: &Path) -> std::io::Result<bool> {
    const CHUNK: usize = 1 << 20;
    const LIMIT: u64 = 16 << 20;
    let f = sessions_store::open_no_follow(path)?;
    if !f.metadata()?.is_file() {
        return Ok(false);
    }
    let mut buf = vec![0u8; CHUNK + PARENT_UUID.len()];
    let (mut kept, mut pos) = (0usize, 0u64);
    while pos < LIMIT {
        let n = read_at(&f, &mut buf[kept..kept + CHUNK], pos)?;
        if n == 0 {
            return Ok(false);
        }
        let end = kept + n;
        if buf[..end]
            .windows(PARENT_UUID.len())
            .any(|w| w == PARENT_UUID)
        {
            return Ok(true);
        }
        kept = PARENT_UUID.len().min(end);
        buf.copy_within(end - kept..end, 0);
        pos += n as u64;
    }
    Ok(true)
}

#[cfg(unix)]
fn read_at(f: &std::fs::File, buf: &mut [u8], pos: u64) -> std::io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(f, buf, pos)
}

#[cfg(not(unix))]
fn read_at(mut f: &std::fs::File, buf: &mut [u8], pos: u64) -> std::io::Result<usize> {
    use std::io::{Seek, SeekFrom};
    f.seek(SeekFrom::Start(pos))?;
    f.read(buf)
}

/// The cwd `TU` checks: the tail's `relocated` stamp, else the first head
/// line that parses with a string `cwd` (`pE`).
fn recorded_cwd(ht: &HeadTail) -> Option<String> {
    last_json_field(&ht.tail, "relocatedCwd", Some("relocated")).or_else(|| {
        let key = "\"cwd\":";
        ht.head.split('\n').find_map(|line| {
            if !line.contains(key) {
                return None;
            }
            match parse_line(line)? {
                Value::Object(o) => o.get("cwd")?.as_str().map(str::to_owned),
                _ => None,
            }
        })
    })
}

// ---- path comparisons (`Ke`, `Ja`, `Mf`, `eD`, `gD`, `mD`) ---------------------

/// `Ke`: NFC on macOS.
fn ke(s: &str) -> String {
    if cfg!(target_os = "macos") {
        nfc(s)
    } else {
        s.to_owned()
    }
}

fn nfc(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    if s.is_ascii() {
        s.to_owned()
    } else {
        s.nfc().collect()
    }
}

/// `Ja`: every UTF-16 unit that isn't ASCII alphanumeric becomes `-`.
fn ja(s: &str) -> String {
    paths::encode_project_dir(s)
}

/// `Mf`
fn mf(s: &str, ci: bool) -> String {
    let s = s.replace('\\', "/");
    if ci { s.to_lowercase() } else { s }
}

/// `eD`: two paths that share a project dir name but aren't the same path.
fn same_dir_name_other_path(a: &str, b: &str, ci: bool) -> bool {
    let (a, b) = (ke(a), ke(b));
    let (na, nb) = (ja(&a), ja(&b));
    let same = if ci {
        na.eq_ignore_ascii_case(&nb)
    } else {
        na == nb
    };
    same && mf(&a, ci) != mf(&b, ci)
}

/// `gD`
fn inside_worktree(cwd: &str, worktrees: Option<&Vec<String>>, ci: bool) -> bool {
    let Some(wts) = worktrees else {
        return false;
    };
    let c = mf(&ke(cwd), ci);
    wts.iter().any(|w| {
        let w = mf(&ke(w), ci);
        c == w
            || c.starts_with(&if w.ends_with('/') {
                w.clone()
            } else {
                format!("{w}/")
            })
    })
}

/// `mD`: `cwd` names another directory than `project` that encodes to the
/// same project dir name, after resolving both.
fn belongs_elsewhere(cwd: &str, project: &str, ci: bool) -> bool {
    if !same_dir_name_other_path(cwd, project, ci) {
        return false;
    }
    if unexaminable(cwd) || unexaminable(project) {
        return false;
    }
    if network_reachable(cwd) || network_reachable(project) {
        return false;
    }
    let Ok(real) = std::fs::canonicalize(cwd) else {
        return false;
    };
    same_dir_name_other_path(&ke(&real.to_string_lossy()), &resolved(project), ci)
}

// ---- network and device paths (`xc`, `nP`) --------------------------------------

macro_rules! re {
    ($name:ident, $src:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($src).unwrap());
    };
}

re!(DOT_DOT, r"(^|[\\/])\.\.([\\/]|$)");
re!(DOUBLE_SEP, r"^[\\/]{2}");
re!(NT_PREFIX, r"^[\\/]\?\?[\\/]");
re!(WSL, r"(?i)^[\\/]{2}wsl(?:\$|\.localhost)[\\/]([^\\/]*)");
re!(DOTS_ONLY, r"^\.{0,2}[. ]*$");
re!(DEVICE_NS, r"^[\\/]{2}[?.][\\/]");
re!(
    OBJECT_NS,
    r"(?i)^[\\/](GLOBAL\?\?|GLOBALROOT|DosDevices|Device)[\\/]"
);
re!(SPECIAL_HINT, r"(?i)/\.(?:vol|file|nofollow|resolve)(?:/|$)");
re!(SPECIAL_ROOT, r"(?i)^\.(?:vol|file|nofollow|resolve)$");

/// Lexical `/`-segments of an absolute path (`..` pops, `.` and empty
/// skipped), calling `stop` after each push; `true` once it does.
fn walk_segments(e: &str, mut stop: impl FnMut(&[&str]) -> bool) -> bool {
    let mut t: Vec<&str> = Vec::new();
    for n in e.split('/') {
        match n {
            "" | "." => {}
            ".." => {
                t.pop();
            }
            _ => {
                t.push(n);
                if stop(&t) {
                    return true;
                }
            }
        }
    }
    false
}

/// `Ly`: drop bidi / zero-width marks, then upper- and lowercase.
fn ly(s: &str) -> String {
    let kept: String = s
        .chars()
        .filter(|c| {
            !matches!(c, '\u{200c}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{206a}'..='\u{206f}' | '\u{feff}')
        })
        .collect();
    kept.to_uppercase().to_lowercase()
}

/// `go`: under `/net/<host>` or `/Network/Servers/<host>`.
fn automount(e: &str) -> bool {
    e.starts_with('/')
        && walk_segments(e, |t| {
            (t.len() == 2 && ly(t[0]) == "net")
                || (t.len() == 3 && ly(t[0]) == "network" && ly(t[1]) == "servers")
        })
}

/// `is`: exactly `/net`.
fn net_root(e: &str) -> bool {
    if !e.starts_with('/') {
        return false;
    }
    let mut t: Vec<&str> = Vec::new();
    for n in e.split('/') {
        match n {
            "" | "." => {}
            ".." => {
                t.pop();
            }
            _ => t.push(n),
        }
    }
    t.len() == 1 && t[0].to_lowercase() == "net"
}

/// `ho`: under `/Network`.
fn network_dir(e: &str) -> bool {
    e.starts_with('/') && walk_segments(e, |t| t.len() == 1 && t[0].to_lowercase() == "network")
}

/// `ss`: under `/.vol`, `/.file`, `/.nofollow` or `/.resolve`.
fn special_root(e: &str) -> bool {
    SPECIAL_HINT.is_match(e)
        && e.starts_with('/')
        && walk_segments(e, |t| t.len() == 1 && SPECIAL_ROOT.is_match(t[0]))
}

/// `tf`: an NT object path (`\??\…`), also once `path.win32.normalize`d.
fn nt_path(e: &str) -> bool {
    if NT_PREFIX.is_match(e) {
        return true;
    }
    if !e.contains("??") {
        return false;
    }
    // `win32.normalize` gives `\??\…` only for a path with one leading
    // separator whose first normalized segment is `??`, followed by more.
    let b = e.as_bytes();
    let sep = |c: u8| c == b'/' || c == b'\\';
    if b.len() < 2 || !sep(b[0]) || sep(b[1]) {
        return false;
    }
    let mut segs: Vec<&str> = Vec::new();
    for s in e[1..].split(['/', '\\']) {
        match s {
            "" | "." => {}
            ".." => {
                segs.pop();
            }
            _ => segs.push(s),
        }
    }
    segs.first() == Some(&"??") && (segs.len() > 1 || sep(b[b.len() - 1]))
}

/// `vn`
fn unc_like(e: &str) -> bool {
    DOUBLE_SEP.is_match(e) || nt_path(e)
}

/// `mr`: a `\\wsl$\<distro>` / `\\wsl.localhost\<distro>` path.
fn wsl_path(e: &str) -> bool {
    WSL.captures(e)
        .is_some_and(|c| !DOTS_ONLY.is_match(c.get(1).map_or("", |m| m.as_str())))
}

/// `Oc`: a UNC / NT path that isn't a WSL one.
fn share_path(e: &str) -> bool {
    unc_like(e) && !wsl_path(e)
}

/// `xc`: a path the SDK won't examine.
fn unexaminable(e: &str) -> bool {
    share_path(e)
        || automount(e)
        || net_root(e)
        || DEVICE_NS.is_match(e)
        || nt_path(e)
        || OBJECT_NS.is_match(e)
        || special_root(e)
        || network_dir(e)
}

/// `nP`: `..` segments, a share or automount path, or one whose ancestry
/// reaches one (`Lc`).
fn network_reachable(e: &str) -> bool {
    DOT_DOT.is_match(e)
        || share_path(e)
        || automount(e)
        || net_root(e)
        || ancestry_reaches_network(e)
}

/// posix `path.resolve(e)`.
fn resolve_posix(e: &str) -> String {
    let full = if e.starts_with('/') {
        e.to_owned()
    } else {
        let cwd = std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".into());
        format!("{cwd}/{e}")
    };
    let mut t: Vec<&str> = Vec::new();
    for n in full.split('/') {
        match n {
            "" | "." => {}
            ".." => {
                t.pop();
            }
            _ => t.push(n),
        }
    }
    format!("/{}", t.join("/"))
}

/// posix `path.join(s, seg)` for an absolute, normalized `s` and one segment.
fn join_segment(s: &str, seg: &str) -> String {
    match seg {
        "." => s.to_owned(),
        ".." => match s.rfind('/') {
            Some(0) | None => "/".to_owned(),
            Some(i) => s[..i].to_owned(),
        },
        _ if s == "/" => format!("/{seg}"),
        _ => format!("{s}/{seg}"),
    }
}

fn split_segments(s: &str) -> impl Iterator<Item = String> + '_ {
    s.split('/').filter(|x| !x.is_empty()).map(str::to_owned)
}

/// `Lc(ES, e) !== undefined` (`rP` with no options): walk `e` one component
/// at a time with `lstat`, following symlinks by hand, and report a
/// component, link target or end point on a share or automount path, or a
/// chain of 64 links. Any other failure ends the walk unflagged.
fn ancestry_reaches_network(e: &str) -> bool {
    if network_dir(e) {
        return true;
    }
    if share_path(e) || automount(e) {
        return false;
    }
    let r = resolve_posix(e);
    let mut s = "/".to_owned();
    let mut rest: VecDeque<String> = split_segments(&r).collect();
    let mut hops = 0;
    let mut seen = HashSet::new();
    while !rest.is_empty() && hops < 64 {
        let comp = join_segment(&s, &rest[0]);
        if automount(&comp) || network_dir(&comp) || special_root(&comp) {
            return true;
        }
        let under_fd =
            cfg!(target_os = "macos") && comp != "/dev/fd" && comp.starts_with("/dev/fd/");
        if under_fd
            && comp.rfind('/').map(|i| &comp[..i]) == Some("/dev/fd")
            && rest.iter().skip(1).any(|t| t == ".." || t == ".")
        {
            rest.pop_front();
            while rest.front().is_some_and(|f| f == ".") && rest.len() > 1 {
                rest.pop_front();
            }
            s = comp;
            continue;
        }
        if under_fd {
            // Probed as ENOENT, which ends the walk.
            return false;
        }
        let meta = match std::fs::symlink_metadata(&comp) {
            Ok(m) => m,
            Err(err) => {
                if cfg!(unix) && !is_absent(&err) && opens_as_dir_no_follow(&comp) {
                    rest.pop_front();
                    s = comp;
                    continue;
                }
                return false;
            }
        };
        if !meta.file_type().is_symlink() {
            rest.pop_front();
            s = comp;
            continue;
        }
        hops += 1;
        let key = format!("{comp}\0{}", Vec::from(rest.clone()).join("\0"));
        if !seen.insert(key) {
            return false;
        }
        let Ok(link) = std::fs::read_link(&comp) else {
            return false;
        };
        let link = link.to_string_lossy().into_owned();
        rest.pop_front();
        if !link.starts_with('/') {
            for seg in split_segments(&link).collect::<Vec<_>>().into_iter().rev() {
                rest.push_front(seg);
            }
            continue;
        }
        if share_path(&link) || automount(&link) || network_dir(&link) {
            return true;
        }
        s = "/".to_owned();
        for seg in split_segments(&link).collect::<Vec<_>>().into_iter().rev() {
            rest.push_front(seg);
        }
    }
    if !rest.is_empty() {
        return true;
    }
    (hops > 0 && net_root(&s)) || network_dir(&s)
}

/// ENOENT, ENOTDIR or ENAMETOOLONG: the walk's "not there" errors.
fn is_absent(err: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        matches!(
            err.raw_os_error(),
            Some(libc::ENOENT | libc::ENOTDIR | libc::ENAMETOOLONG)
        )
    }
    #[cfg(not(unix))]
    {
        err.kind() == std::io::ErrorKind::NotFound
    }
}

/// The `opendirNofollow` probe for a component `lstat` refused.
fn opens_as_dir_no_follow(p: &str) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(p)
            .is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_predicates() {
        assert!(DOT_DOT.is_match("/a/../b") && !DOT_DOT.is_match("/a/..b"));
        assert!(share_path("//server/share") && !share_path("//wsl$/Ubuntu/x"));
        assert!(share_path("//wsl$/../x"));
        assert!(automount("/net/host/x") && automount("/Network/Servers/h") && !automount("/net"));
        assert!(automount("/a/../NET/h"));
        assert!(net_root("/net") && net_root("/x/../net/") && !net_root("/net/h"));
        assert!(network_dir("/Network") && network_dir("/network/x") && !network_dir("/a/Network"));
        assert!(special_root("/.vol/1/2") && special_root("/.ReSolve") && !special_root("/a/.vol"));
        assert!(nt_path("/??/x") && nt_path("/./??/x") && nt_path("/a/../??/") && !nt_path("/??"));
        assert!(!nt_path("//??/x") && !nt_path("/a/??/x"));
        assert!(unexaminable("\\\\?\\C:\\x") && unexaminable("/Device/x"));
        assert!(!unexaminable("/Users/me/project"));
    }

    /// The SDK's own `xc` and `Da || Oc || go || is`, recorded by
    /// `rust/scripts/list-sessions-golden.mjs`.
    #[test]
    fn path_predicates_match_the_sdk() {
        let raw = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/list_sessions_golden.json"),
        )
        .unwrap();
        let f: Value = serde_json::from_str(&raw).unwrap();
        let preds = f["predicates"].as_array().unwrap();
        assert!(preds.len() > 40);
        for p in preds {
            let path = p["path"].as_str().unwrap();
            assert_eq!(
                unexaminable(path),
                p["xc"].as_bool().unwrap(),
                "xc({path:?})"
            );
            let lexical =
                DOT_DOT.is_match(path) || share_path(path) || automount(path) || net_root(path);
            assert_eq!(
                lexical,
                p["lexical"].as_bool().unwrap(),
                "nP lexical({path:?})"
            );
        }
    }

    #[test]
    fn ancestry_walk_flags_links_onto_shares() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let r = root.to_str().unwrap();
        std::fs::create_dir(root.join("real")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink("/net/host/share", root.join("tonet")).unwrap();
            symlink("//server/share", root.join("tounc")).unwrap();
            symlink("real", root.join("rel")).unwrap();
            symlink("/Network", root.join("tonetwork")).unwrap();
            // Flagged at the link (`ho` reads it lexically); walking it
            // would stop at the missing `/s33-missing`.
            symlink("/s33-missing/../Network", root.join("tonetwork2")).unwrap();
            symlink("loop", root.join("loop")).unwrap();
            assert!(ancestry_reaches_network(&format!("{r}/tonet/x")));
            assert!(ancestry_reaches_network(&format!("{r}/tounc")));
            assert!(ancestry_reaches_network(&format!("{r}/tonetwork/y")));
            assert!(ancestry_reaches_network(&format!("{r}/tonetwork2/y")));
            assert!(!ancestry_reaches_network(&format!("{r}/rel/x")));
            assert!(!ancestry_reaches_network(&format!("{r}/loop/x")));
            // 70 relative hops pass the 64-link cap.
            for i in 0..70 {
                symlink(format!("c{}", i + 1), root.join(format!("c{i}"))).unwrap();
            }
            symlink("real", root.join("c70")).unwrap();
            assert!(ancestry_reaches_network(&format!("{r}/c0")));
            assert!(!ancestry_reaches_network(&format!("{r}/c10")));
            // From c7 the 64th link is the last one (c70 -> real), which
            // leaves a component unwalked; from c8 there are 63.
            assert!(ancestry_reaches_network(&format!("{r}/c7")));
            assert!(!ancestry_reaches_network(&format!("{r}/c8")));
        }
        assert!(!ancestry_reaches_network(&format!(
            "{r}/real/missing/deeper"
        )));
        assert!(ancestry_reaches_network("/Network/x"));
        assert!(!ancestry_reaches_network("/net/host/x"));
    }

    #[test]
    fn options_from_the_ts_wrapper() {
        assert_eq!(
            ListOptions::ts_list(None, None, None),
            ListOptions {
                limit: Some(200.0),
                include_worktrees: Some(true),
                ..Default::default()
            }
        );
        assert_eq!(
            plain_dir_name(Some("my_dir-1")).as_deref(),
            Some("my_dir-1")
        );
        assert_eq!(plain_dir_name(Some("COM1")), None);
        assert_eq!(plain_dir_name(Some("a b")), None);
        assert_eq!(plain_dir_name(Some(&"x".repeat(65))), None);
        let env = ListEnv::for_config("/h/Cafe\u{301}".into(), true, Some("pinned"));
        assert_eq!(env.projects, Path::new("/h/Caf\u{e9}/projects"));
        assert_eq!(env.project_dir_name.as_deref(), Some("pinned"));
        let env = ListEnv::for_config("/h/.claude".into(), false, Some("pinned"));
        assert_eq!(env.project_dir_name, None);
    }
}
