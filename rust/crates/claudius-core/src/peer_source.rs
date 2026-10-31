//! `lib/server/peer-source.ts` (G11): resolve a cross-session peer message
//! (`SDKMessageOrigin.kind === "peer"`) to the Claude Code session that sent
//! it, so the chat can link there. Navigation only: nothing may be gated on
//! the answer.
//!
//! Two lookups, cheapest first:
//! 1. The CLI's live registry, `<claudeDir>/sessions/<pid>.json`, plus every
//!    account profile's own `sessions` dir that is a real directory (a
//!    symlink back to the main one is skipped). By `<pid>.json` when the
//!    query has a pid; then, for a `uds:` sender address, every
//!    `^\d+\.json$` record (strcmp order, main dir first) whose
//!    `messagingSocketPath` is that socket. A record counts when its `pid`
//!    is a safe integer, its `sessionId` is `^[A-Za-z0-9_-]{1,128}$`, its
//!    socket doesn't contradict the address and it didn't start more than
//!    5 s after the message (`at`). `live` is `process.kill(pid, 0)` (EPERM
//!    counts; a pid that isn't an int32 doesn't).
//! 2. The sender's transcript: every `*.jsonl` one level under
//!    `<claudeDir>/projects/` touched since `at - 5 min` (or ever, without
//!    `at`), oldest first (stable on ties), read line by line
//!    ([`crate::jsonl_lines`]) until the time or byte budget runs out. A hit
//!    is a record whose `toolUseResult.msg_id` is the query's `msgId` (a
//!    UUID), else whose `SendMessage` `tool_use` body, JS-trimmed, starts
//!    with the trimmed snippet (at least 16 UTF-16 units, and only with
//!    `at`). Its `cwd` is the first record's that has one.
//!
//! Results are cached per query: misses for 30 s, transcript hits for good,
//! at most 500 entries (the oldest inserted goes first, also when the new
//! answer isn't kept); registry hits aren't kept, since `live` changes.
//!
//! Values are read as `JSON.parse` reads them ([`Js`]): strings are UTF-16
//! (a lone surrogate survives), numbers can be ±Infinity. Paths are
//! `path.resolve`d, and each one built from a directory listing is checked
//! to stay inside its directory right above the fs call that reads it, as in
//! the TS.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use claudius_agent::js;
use indexmap::IndexMap;

use crate::docker::Js;
use crate::jsonl_lines::JsonlLines;
use crate::{accounts, js_string, node_fs, node_path, paths};

/// `MIN_SNIPPET`: shorter snippets match too loosely to trust.
pub const MIN_SNIPPET: usize = 16;
/// `PEER_SNIPPET_MAX` (lib/shared/peer-source.ts): the route's cut, in
/// UTF-16 units.
pub const PEER_SNIPPET_MAX: usize = 200;
/// A registry record started this long after the message has a recycled pid.
const STARTED_SLACK_MS: f64 = 5_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Registry,
    Transcript,
}

/// `PeerSource`. Strings the sender wrote are UTF-16 units.
#[derive(Clone, Debug, PartialEq)]
pub struct PeerSource {
    /// Always `^[A-Za-z0-9_-]{1,128}$`.
    pub session_id: String,
    pub cwd: Option<Vec<u16>>,
    pub name: Option<Vec<u16>>,
    pub live: bool,
    pub via: Via,
}

impl PeerSource {
    /// `JSON.stringify(source)`.
    pub fn to_json(&self) -> String {
        let mut out = String::from("{\"sessionId\":");
        js::stringify_utf16(&units(&self.session_id), &mut out);
        out.push_str(",\"cwd\":");
        push_str_or_null(&mut out, self.cwd.as_deref());
        out.push_str(",\"name\":");
        push_str_or_null(&mut out, self.name.as_deref());
        out.push_str(",\"live\":");
        out.push_str(if self.live { "true" } else { "false" });
        out.push_str(",\"via\":");
        out.push_str(match self.via {
            Via::Registry => "\"registry\"}",
            Via::Transcript => "\"transcript\"}",
        });
        out
    }
}

/// `JSON.stringify` of a string or `null`.
pub fn push_str_or_null(out: &mut String, s: Option<&[u16]>) {
    match s {
        Some(s) => js::stringify_utf16(s, out),
        None => out.push_str("null"),
    }
}

/// `PeerSourceQuery`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PeerSourceQuery {
    pub pid: Option<f64>,
    /// `origin.from`, e.g. `uds:/tmp/cc-socks/123.sock`.
    pub from: Option<String>,
    pub msg_id: Option<String>,
    /// UTF-16 units: the route's 200-unit cut can end in half a pair.
    pub snippet: Option<Vec<u16>>,
    /// Message time, ms epoch.
    pub at: Option<f64>,
}

/// `PeerSourceRoots`.
#[derive(Clone, Debug, PartialEq)]
pub struct PeerSourceRoots {
    /// The Claude config dir holding `sessions/` and `projects/`.
    pub claude_dir: String,
    /// `<accountsDir>/profiles`.
    pub profiles_root: String,
}

/// `defaultRoots()`: `homedir()/.claude` (not `$CLAUDE_CONFIG_DIR`) and the
/// accounts root's `profiles`. `homedir()` is [`paths::home_dir`], which
/// `CLAUDIUS_STATE_HOME` moves.
pub fn default_roots() -> PeerSourceRoots {
    let home = paths::home_dir().to_string_lossy().into_owned();
    PeerSourceRoots {
        claude_dir: node_path::resolve(&[&home, ".claude"]),
        profiles_root: node_path::resolve(&[&accounts::accounts_dir(), "profiles"]),
    }
}

/// The TS module's bounds, injectable so tests can shrink them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limits {
    /// `SCAN_SLACK_MS`
    pub scan_slack_ms: f64,
    /// `SCAN_BYTE_BUDGET`
    pub byte_budget: f64,
    /// `SCAN_TIME_BUDGET_MS`
    pub time_budget_ms: f64,
    /// `CACHE_MAX`
    pub cache_max: usize,
    /// `MISS_TTL_MS`
    pub miss_ttl_ms: f64,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            scan_slack_ms: 5.0 * 60_000.0,
            byte_budget: 512.0 * 1024.0 * 1024.0,
            time_budget_ms: 5_000.0,
            cache_max: 500,
            miss_ttl_ms: 30_000.0,
        }
    }
}

/// `Date.now()`.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

struct Cached {
    at: f64,
    value: Option<PeerSource>,
}

/// `resolvePeerSource` with its module state (the cache).
pub struct Resolver {
    limits: Limits,
    clock: Clock,
    cache: Mutex<IndexMap<String, Cached>>,
}

impl Resolver {
    pub fn new(limits: Limits, clock: Clock) -> Resolver {
        Resolver {
            limits,
            clock,
            cache: Mutex::new(IndexMap::new()),
        }
    }

    /// The process's resolver: TS's limits, the real clock.
    pub fn global() -> &'static Resolver {
        static GLOBAL: OnceLock<Resolver> = OnceLock::new();
        GLOBAL.get_or_init(|| Resolver::new(Limits::default(), Arc::new(|| crate::now_ms() as f64)))
    }

    fn now(&self) -> f64 {
        (self.clock)()
    }

    fn cache(&self) -> MutexGuard<'_, IndexMap<String, Cached>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `resolvePeerSource(q, roots)`. Blocking: reads the disk.
    pub fn resolve(&self, q: &PeerSourceQuery, roots: &PeerSourceRoots) -> Option<PeerSource> {
        let key = cache_key(q, roots);
        if let Some(c) = self.cache().get(&key)
            && (c.value.is_some() || self.now() - c.at < self.limits.miss_ttl_ms)
        {
            return c.value.clone();
        }
        let value = from_registry(q, roots).or_else(|| self.scan_transcripts(q, roots));
        let mut cache = self.cache();
        if cache.len() >= self.limits.cache_max {
            cache.shift_remove_index(0);
        }
        // Misses and transcript hits; a registry hit's `live` goes stale.
        if value.as_ref().is_none_or(|v| v.via == Via::Transcript) {
            let at = self.now();
            cache.insert(
                key,
                Cached {
                    at,
                    value: value.clone(),
                },
            );
        }
        value
    }

    /// `fromTranscripts`.
    fn scan_transcripts(&self, q: &PeerSourceQuery, roots: &PeerSourceRoots) -> Option<PeerSource> {
        let msg_id = q.msg_id.as_deref().filter(|m| crate::is_uuid(m));
        let snippet = q
            .snippet
            .as_deref()
            .map(trim16)
            .filter(|s| s.len() >= MIN_SNIPPET);
        if msg_id.is_none() && snippet.is_none() {
            return None;
        }
        // Body matching has no unique id: it needs a time anchor.
        if msg_id.is_none() && q.at.is_none() {
            return None;
        }
        let root = node_path::resolve(&[&roots.claude_dir, "projects"]);
        let since = q.at.map_or(0.0, |at| at - self.limits.scan_slack_ms);
        let project_dirs = node_fs::readdir(&root).ok()?;
        let mut candidates: Vec<(String, f64, f64)> = Vec::new();
        for d in project_dirs {
            let dir = node_path::resolve(&[&root, &d]);
            if !dir.starts_with(&format!("{root}/")) {
                continue;
            }
            let Ok(names) = node_fs::readdir(&dir) else {
                continue;
            };
            for n in names {
                if !n.ends_with(".jsonl") {
                    continue;
                }
                let file = node_path::resolve(&[&dir, &n]);
                if !file.starts_with(&format!("{dir}/")) {
                    continue;
                }
                // `fs.stat` follows links; one that vanished is skipped.
                if let Ok(st) = std::fs::metadata(&file)
                    && let Ok(modified) = st.modified()
                {
                    let mtime = node_fs::mtime_ms(modified);
                    if mtime >= since {
                        candidates.push((file, mtime, st.len() as f64));
                    }
                }
            }
        }
        // Oldest-touched first (a stable sort): the sender's file was last
        // written closest to the message time.
        candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

        let deadline = self.now() + self.limits.time_budget_ms;
        let mut bytes = 0.0;
        for (file, _, size) in &candidates {
            if self.now() > deadline || bytes > self.limits.byte_budget {
                break;
            }
            bytes += size;
            if let Some(hit) = find_sender_in_file(file, msg_id, snippet) {
                return Some(hit);
            }
        }
        None
    }
}

/// `JSON.stringify([roots.claudeDir, q.msgId, q.pid, q.from, q.snippet, q.at])`.
fn cache_key(q: &PeerSourceQuery, roots: &PeerSourceRoots) -> String {
    let num = |n: Option<f64>| n.map_or_else(|| "null".to_owned(), js::number_to_string);
    let mut k = String::from("[");
    js::stringify_utf16(&units(&roots.claude_dir), &mut k);
    k.push(',');
    push_str_or_null(&mut k, q.msg_id.as_deref().map(units).as_deref());
    k.push(',');
    k.push_str(&num(q.pid));
    k.push(',');
    push_str_or_null(&mut k, q.from.as_deref().map(units).as_deref());
    k.push(',');
    push_str_or_null(&mut k, q.snippet.as_deref());
    k.push(',');
    k.push_str(&num(q.at));
    k.push(']');
    k
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// `o.key` on a parsed value: an object's own property (none of the keys
/// read here is on `Object.prototype`, or on strings and arrays); `?.` on a
/// missing value.
fn get<'a>(v: Option<&'a Js>, key: &str) -> Option<&'a Js> {
    match v? {
        Js::Obj(m) => m.get(&units(key)),
        _ => None,
    }
}

/// `typeof v === "string" && v ? v : null`.
fn non_empty_str(v: Option<&Js>) -> Option<Vec<u16>> {
    match v {
        Some(Js::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `String.prototype.trim` on UTF-16 units (JS whitespace is all BMP).
fn trim16(s: &[u16]) -> &[u16] {
    let ws = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(js::is_whitespace);
    let start = s.iter().position(|u| !ws(u)).unwrap_or(s.len());
    let end = s.iter().rposition(|u| !ws(u)).map_or(start, |i| i + 1);
    &s[start..end]
}

/// `SESSION_ID_RE`: `^[A-Za-z0-9_-]{1,128}$`.
fn is_session_id(s: &[u16]) -> bool {
    (1..=128).contains(&s.len())
        && s.iter().all(|&u| {
            u8::try_from(u).is_ok_and(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}

/// `Number.isSafeInteger(n)`.
fn is_safe_integer(n: f64) -> bool {
    n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

/// `/^\d+\.json$/` (ASCII digits).
fn is_pid_json(name: &str) -> bool {
    name.strip_suffix(".json")
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

/// `pidAlive`: `process.kill(pid, 0)` succeeds or fails with EPERM. Node
/// throws a TypeError (not EPERM) for a pid that isn't an int32.
#[cfg(unix)]
fn pid_alive(pid: f64) -> bool {
    let p = pid as i32;
    if f64::from(p) != pid {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists.
    if unsafe { libc::kill(p, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn pid_alive(_pid: f64) -> bool {
    false
}

/// `socketPathFromAddress`: `uds:<percent-encoded path>` → the path (the
/// raw rest when it doesn't decode); `None` for other addresses. An empty
/// path is `None` too: TS only ever tests it for truthiness.
fn socket_path_from_address(from: Option<&str>) -> Option<Vec<u16>> {
    let rest = from?.strip_prefix("uds:")?;
    let path = js_string::decode_uri_component(rest).unwrap_or_else(|| rest.to_owned());
    (!path.is_empty()).then(|| units(&path))
}

/// `registryDirs`.
fn registry_dirs(roots: &PeerSourceRoots) -> Vec<String> {
    let mut dirs = vec![node_path::resolve(&[&roots.claude_dir, "sessions"])];
    let profiles_root = node_path::resolve(&[&roots.profiles_root]);
    let Ok(profiles) = node_fs::readdir(&profiles_root) else {
        return dirs;
    };
    for p in profiles {
        let d = node_path::resolve(&[&profiles_root, &p, "sessions"]);
        // `lstat`: a real directory, not a symlink to one.
        if std::fs::symlink_metadata(&d).is_ok_and(|m| m.is_dir()) {
            dirs.push(d);
        }
    }
    dirs
}

/// `readRecord`: `JSON.parse(readFile(file, "utf8"))`, `None` when either throws.
fn read_record(file: &str) -> Option<Js> {
    Js::parse(&node_fs::read_to_string(file).ok()?)
}

/// `acceptRecord`.
fn accept_record(rec: &Js, q: &PeerSourceQuery, socket: Option<&[u16]>) -> Option<PeerSource> {
    let rec = Some(rec);
    let Some(&Js::Num(pid)) = get(rec, "pid") else {
        return None;
    };
    if !is_safe_integer(pid) {
        return None;
    }
    let Some(Js::Str(session_id)) = get(rec, "sessionId") else {
        return None;
    };
    if !is_session_id(session_id) {
        return None;
    }
    // Same pid but another socket: not the process that sent this.
    if let Some(socket) = socket
        && let Some(Js::Str(path)) = get(rec, "messagingSocketPath")
        && path != socket
    {
        return None;
    }
    // Started after the message was sent: the pid was recycled.
    if let Some(at) = q.at
        && let Some(&Js::Num(started)) = get(rec, "startedAt")
        && started > at + STARTED_SLACK_MS
    {
        return None;
    }
    Some(PeerSource {
        session_id: String::from_utf16_lossy(session_id),
        cwd: non_empty_str(get(rec, "cwd")),
        name: non_empty_str(get(rec, "name")),
        live: pid_alive(pid),
        via: Via::Registry,
    })
}

/// `fromRegistry`.
fn from_registry(q: &PeerSourceQuery, roots: &PeerSourceRoots) -> Option<PeerSource> {
    let socket = socket_path_from_address(q.from.as_deref());
    let pid = q.pid.filter(|&p| is_safe_integer(p) && p > 0.0);
    if pid.is_none() && socket.is_none() {
        return None;
    }
    let dirs = registry_dirs(roots);

    // Fast path: the `<pid>.json` record.
    if let Some(pid) = pid {
        for base in &dirs {
            let file = node_path::resolve(&[base, &format!("{}.json", js::number_to_string(pid))]);
            if !file.starts_with(&format!("{base}/")) {
                continue;
            }
            if let Some(rec) = read_record(&file)
                && get(Some(&rec), "pid") == Some(&Js::Num(pid))
                && let Some(hit) = accept_record(&rec, q, socket.as_deref())
            {
                return Some(hit);
            }
        }
    }
    // Queued deliveries carry no pid: match the socket across the registry.
    if let Some(socket) = &socket {
        for base in &dirs {
            let Ok(names) = node_fs::readdir(base) else {
                continue;
            };
            for n in names {
                if !is_pid_json(&n) {
                    continue;
                }
                let file = node_path::resolve(&[base, &n]);
                if !file.starts_with(&format!("{base}/")) {
                    continue;
                }
                let Some(rec) = read_record(&file) else {
                    continue;
                };
                if !matches!(get(Some(&rec), "messagingSocketPath"), Some(Js::Str(p)) if p == socket)
                {
                    continue;
                }
                if let Some(hit) = accept_record(&rec, q, Some(socket)) {
                    return Some(hit);
                }
            }
        }
    }
    None
}

/// `isSendMessageFor`: a `SendMessage` `tool_use` whose trimmed
/// `input.message` starts with `snippet`.
fn is_send_message_for(rec: &Js, snippet: &[u16]) -> bool {
    let Some(Js::Arr(content)) = get(get(Some(rec), "message"), "content") else {
        return false;
    };
    let is = |v: Option<&Js>, want: &str| matches!(v, Some(Js::Str(s)) if *s == units(want));
    content.iter().any(|c| {
        is(get(Some(c), "type"), "tool_use")
            && is(get(Some(c), "name"), "SendMessage")
            && matches!(get(get(Some(c), "input"), "message"),
                Some(Js::Str(body)) if trim16(body).starts_with(snippet))
    })
}

/// `findSenderInFile`: `None` when nothing matches or the file can't be read
/// through (TS's `.catch(() => null)`).
fn find_sender_in_file(
    file: &str,
    msg_id: Option<&str>,
    snippet: Option<&[u16]>,
) -> Option<PeerSource> {
    let f = std::fs::File::open(file).ok()?;
    // The session's START cwd (first record that has one): later records
    // track the shell's cwd, which may be a subdirectory.
    let mut start_cwd: Option<Vec<u16>> = None;
    for line in JsonlLines::new(f) {
        let line = line.ok()?;
        if start_cwd.is_none() && line.contains("\"cwd\":\"") {
            start_cwd = non_empty_str(get(Js::parse(&line).as_ref(), "cwd"));
        }
        let by_id = msg_id.is_some_and(|m| line.contains(m));
        let by_body = !by_id && snippet.is_some() && line.contains("\"SendMessage\"");
        if !by_id && !by_body {
            continue;
        }
        let Some(rec) = Js::parse(&line) else {
            continue;
        };
        // Structural matches only: a transcript that merely quotes the id
        // or the text carries it elsewhere.
        let hit = match (by_id, msg_id, snippet) {
            (true, Some(m), _) => matches!(get(get(Some(&rec), "toolUseResult"), "msg_id"),
                Some(Js::Str(s)) if *s == units(m)),
            (_, _, Some(snippet)) => is_send_message_for(&rec, snippet),
            _ => false,
        };
        if !hit {
            continue;
        }
        let Some(Js::Str(session_id)) = get(Some(&rec), "sessionId") else {
            continue;
        };
        if !is_session_id(session_id) {
            continue;
        }
        let cwd = start_cwd.or_else(|| non_empty_str(get(Some(&rec), "cwd")));
        return Some(PeerSource {
            session_id: String::from_utf16_lossy(session_id),
            cwd,
            name: None,
            live: false,
            via: Via::Transcript,
        });
    }
    None
}

/// The route's workspace pick: of `workspaces` (as `listWorkspaces` returns
/// them), those whose `rootPath` is `cwd` or a parent of it (`rootPath +
/// "/"` unless it already ends in `/`), deepest first (stable on ties); its
/// `id ?? null`. `Err` is the `TypeError` the TS `filter` throws on an entry
/// that is `null` or whose `rootPath` isn't a string.
pub fn workspace_for_cwd(
    cwd: &[u16],
    workspaces: &[serde_json::Value],
) -> Result<serde_json::Value, String> {
    use serde_json::Value;
    let mut matches: Vec<(usize, &Value)> = Vec::new();
    for w in workspaces {
        let root = match w {
            Value::Null => {
                return Err(
                    "TypeError: Cannot read properties of null (reading 'rootPath')".into(),
                );
            }
            Value::Object(m) => m.get("rootPath"),
            _ => None,
        };
        let root = match root {
            Some(Value::String(r)) => js_string::units(r),
            None => {
                return Err(
                    "TypeError: Cannot read properties of undefined (reading 'endsWith')".into(),
                );
            }
            Some(Value::Null) => {
                return Err(
                    "TypeError: Cannot read properties of null (reading 'endsWith')".into(),
                );
            }
            Some(_) => return Err("TypeError: w.rootPath.endsWith is not a function".into()),
        };
        let parent = if root.last() == Some(&0x2f) {
            root.clone()
        } else {
            [&root[..], &[0x2f]].concat()
        };
        if cwd == root.as_slice() || cwd.starts_with(&parent) {
            matches.push((root.len(), w));
        }
    }
    matches.sort_by_key(|m| std::cmp::Reverse(m.0));
    Ok(matches
        .first()
        .and_then(|(_, w)| w.get("id"))
        .cloned()
        .unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_predicates() {
        assert!(is_pid_json("0.json") && is_pid_json("0012.json"));
        assert!(!is_pid_json(".json") && !is_pid_json("1.JSON") && !is_pid_json("1a.json"));
        assert!(!is_pid_json("\u{663}.json") && !is_pid_json("1.json.bak"));
        assert!(is_safe_integer(9_007_199_254_740_991.0) && is_safe_integer(-0.0));
        assert!(!is_safe_integer(9_007_199_254_740_992.0) && !is_safe_integer(1.5));
        assert!(!is_safe_integer(f64::INFINITY) && !is_safe_integer(f64::NAN));
        assert!(is_session_id(&units("aZ09_-")) && is_session_id(&units(&"a".repeat(128))));
        assert!(!is_session_id(&[]) && !is_session_id(&units(&"a".repeat(129))));
        assert!(!is_session_id(&units("a b")) && !is_session_id(&units("a.b")));
        assert!(!is_session_id(&[0x161]) && !is_session_id(&[0x0141]));
        assert_eq!(trim16(&units("\u{feff}\u{a0} a b\u{3000}\n")), units("a b"));
        assert_eq!(trim16(&units(" \u{85}x\u{85} ")), units("\u{85}x\u{85}"));
        assert_eq!(trim16(&[0x20, 0xd83d, 0x20]), &[0xd83d]);
        assert!(trim16(&units("  ")).is_empty());
    }

    #[test]
    fn socket_paths() {
        let s = |f: &str| socket_path_from_address(Some(f)).map(|u| String::from_utf16_lossy(&u));
        assert_eq!(s("uds:%2Ftmp%2Fa.sock").as_deref(), Some("/tmp/a.sock"));
        assert_eq!(s("uds:/tmp/100%.sock").as_deref(), Some("/tmp/100%.sock"));
        assert_eq!(s("uds:"), None);
        assert_eq!(s("UDS:/x"), None);
        assert_eq!(s("tcp:/x"), None);
        assert_eq!(socket_path_from_address(None), None);
    }

    #[cfg(unix)]
    #[test]
    fn pid_liveness() {
        assert!(pid_alive(f64::from(std::process::id())));
        assert!(pid_alive(0.0) && pid_alive(-0.0));
        assert!(!pid_alive(2_147_483_648.0) && !pid_alive(99_999_901.0));
        assert!(!pid_alive(1.5));
    }

    #[test]
    fn cache_keys_follow_json_stringify() {
        let roots = PeerSourceRoots {
            claude_dir: "/h/.claude".into(),
            profiles_root: "/p".into(),
        };
        let q = PeerSourceQuery {
            pid: Some(-0.0),
            from: Some("uds:\"x\"".into()),
            msg_id: None,
            snippet: Some(vec![0x61, 0xd83d]),
            at: Some(f64::NAN),
        };
        assert_eq!(
            cache_key(&q, &roots),
            r#"["/h/.claude",null,0,"uds:\"x\"","a\ud83d",null]"#
        );
        let q = PeerSourceQuery {
            pid: Some(1e21),
            msg_id: Some("m".into()),
            at: Some(1.5),
            ..Default::default()
        };
        assert_eq!(
            cache_key(&q, &roots),
            r#"["/h/.claude","m",1e+21,null,null,1.5]"#
        );
    }

    #[test]
    fn workspace_pick() {
        use serde_json::json;
        let cwd = units("/w/a/b");
        let ws = [
            json!({"id": "root", "rootPath": "/"}),
            json!({"id": "a", "rootPath": "/w/a"}),
            json!({"id": "a2", "rootPath": "/w/a/"}),
            json!({"id": "ab", "rootPath": "/w/a/b"}),
            json!({"id": "x", "rootPath": "/w/a/bc"}),
        ];
        assert_eq!(workspace_for_cwd(&cwd, &ws), Ok(json!("ab")));
        assert_eq!(workspace_for_cwd(&cwd, &ws[..3]), Ok(json!("a2")));
        assert_eq!(workspace_for_cwd(&cwd, &ws[..2]), Ok(json!("a")));
        assert_eq!(workspace_for_cwd(&units("/w/a"), &ws[1..3]), Ok(json!("a")));
        assert_eq!(workspace_for_cwd(&units("/v"), &ws[1..]), Ok(json!(null)));
        assert_eq!(
            workspace_for_cwd(
                &cwd,
                &[
                    json!({"rootPath": "/w"}),
                    json!({"id": null, "rootPath": "/"})
                ]
            ),
            Ok(json!(null))
        );
        let err = |w: serde_json::Value| workspace_for_cwd(&cwd, &[ws[3].clone(), w]).unwrap_err();
        assert!(err(json!(null)).contains("of null (reading 'rootPath')"));
        assert!(err(json!(5)).contains("of undefined (reading 'endsWith')"));
        assert!(err(json!({"rootPath": null})).contains("of null (reading 'endsWith')"));
        assert!(err(json!({"rootPath": []})).ends_with("is not a function"));
    }
}
