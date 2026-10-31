//! File-based subagents (`<scope>/.claude/agents/<name>.md`): port of
//! `lib/server/agents.ts`. User agents live under `homedir()`, project
//! agents under the trusted cwd. A file is YAML frontmatter between `---`
//! lines (parsed by [`crate::yaml`], the `yaml` package's port) and a body.
//!
//! Known differences, all at the edges of what a filename or a frontmatter
//! can hold: [`crate::collate`] orders non-Latin names by code point where
//! ICU orders them by script, and [`crate::yaml`]'s own (lone surrogates,
//! nesting depth, `Date` keys in UTC).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::{collate, db_agents, paths, yaml};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentScope {
    User,
    Project,
}

impl AgentScope {
    /// `SCOPES.includes(s)`.
    pub fn parse(s: &str) -> Option<AgentScope> {
        match s {
            "user" => Some(AgentScope::User),
            "project" => Some(AgentScope::Project),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AgentScope::User => "user",
            AgentScope::Project => "project",
        }
    }
}

/// CC 2.1.292: agent names allow at most 256 characters.
pub const MAX_AGENT_NAME_LENGTH: usize = 256;

/// `/^[\w.\-]+$/` (`\w` is ASCII in JS).
static NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.\-]+$").expect("name regex"));

pub fn is_name(s: &str) -> bool {
    NAME_RE.is_match(s)
}

#[derive(Clone, Debug)]
pub struct AgentFile {
    pub scope: AgentScope,
    /// The filename without `.md`.
    pub name: String,
    pub path: String,
    pub frontmatter: yaml::Frontmatter,
    pub body: String,
    pub raw: String,
}

impl AgentFile {
    /// The object `NextResponse.json` serializes; `None` when
    /// `JSON.stringify` throws on it (a cyclic frontmatter).
    pub fn to_json(&self) -> Option<Value> {
        let mut m = Map::new();
        m.insert("scope".into(), json!(self.scope.as_str()));
        m.insert("name".into(), json!(self.name));
        m.insert("path".into(), json!(self.path));
        m.insert("frontmatter".into(), self.frontmatter.json.clone()?);
        m.insert("body".into(), json!(self.body));
        m.insert("raw".into(), json!(self.raw));
        Some(Value::Object(m))
    }
}

/// `path.posix.normalize(p)`.
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let absolute = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|l| *l != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut s = out.join("/");
    if s.is_empty() && !absolute {
        s = ".".into();
    }
    if !s.is_empty() && trailing && s != "." {
        s.push('/');
    } else if s == "." && trailing {
        s = "./".into();
    }
    if absolute { format!("/{s}") } else { s }
}

/// `path.join(...parts)`.
pub fn join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        ".".into()
    } else {
        normalize(&joined)
    }
}

/// `path.dirname(p)` for an absolute, normalized path.
fn dirname(p: &str) -> &str {
    match p.rfind('/') {
        Some(0) => "/",
        Some(i) => &p[..i],
        None => ".",
    }
}

/// `agentsDir(scope, projectCwd)`.
pub fn agents_dir(scope: AgentScope, project_cwd: &str) -> String {
    match scope {
        AgentScope::User => join(&[
            &paths::home_dir().display().to_string(),
            ".claude",
            "agents",
        ]),
        AgentScope::Project => join(&[project_cwd, ".claude", "agents"]),
    }
}

/// `path.resolve(base, child)` (`base` absolute).
fn resolve_in(base: &str, child: &str) -> String {
    let joined = if child.starts_with('/') {
        child.to_owned()
    } else {
        format!("{base}/{child}")
    };
    let n = normalize(&joined);
    if n.len() > 1 {
        n.trim_end_matches('/').to_owned()
    } else {
        n
    }
}

/// `path.resolve(p)`.
fn resolve_abs(p: &str) -> String {
    if p.starts_with('/') {
        resolve_in("/", p)
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        resolve_in(&cwd.display().to_string(), p)
    }
}

/// Why a call threw (the route turns it into Next's bare 500).
#[derive(Debug)]
pub struct Thrown(pub String);

/// `agentPath(scope, projectCwd, name)`: the file's path, or the throw for a
/// name outside `[\w.-]`.
pub fn agent_path(scope: AgentScope, project_cwd: &str, name: &str) -> Result<String, Thrown> {
    if !is_name(name) {
        return Err(Thrown("invalid agent name".into()));
    }
    // assertWithin(dir, `${name}.md`)
    let base = resolve_abs(&agents_dir(scope, project_cwd));
    let child = resolve_in(&base, &format!("{name}.md"));
    if child != base && !child.starts_with(&format!("{base}/")) {
        return Err(Thrown("path escapes base directory".into()));
    }
    Ok(child)
}

/// `listAgents(scope, projectCwd)`: the `.md` files of the scope's dir
/// (none when it doesn't exist), sorted by `localeCompare` of their names;
/// unreadable files are skipped. `Err` when `readdir` throws otherwise.
pub fn list_agents(scope: AgentScope, project_cwd: &str) -> Result<Vec<AgentFile>, Thrown> {
    let dir = agents_dir(scope, project_cwd);
    let base = resolve_abs(&dir);
    let entries = match std::fs::read_dir(&base) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Thrown(e.to_string())),
    };
    // libuv's scandir sorts by `strcmp`; the sort below is stable.
    let mut names: Vec<String> = entries
        .flatten()
        // A name that isn't UTF-8 reads back (lossily) as a missing file.
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort_unstable();
    let mut out = Vec::new();
    for filename in names {
        if !filename.ends_with(".md") {
            continue;
        }
        let full = join(&[&dir, &filename]);
        let target = resolve_in(&base, &filename);
        if !target.starts_with(&format!("{base}/")) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&target) else {
            continue; // skip unreadable
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let parsed = parse_frontmatter(&raw);
        out.push(AgentFile {
            scope,
            name: filename[..filename.len() - 3].to_owned(),
            path: full,
            frontmatter: parsed.frontmatter,
            body: parsed.body,
            raw,
        });
    }
    out.sort_by(|a, b| collate::locale_compare(&a.name, &b.name));
    Ok(out)
}

/// `readAgent(scope, projectCwd, name)`: `None` when the file is missing.
pub fn read_agent(
    scope: AgentScope,
    project_cwd: &str,
    name: &str,
) -> Result<Option<AgentFile>, Thrown> {
    let p = agent_path(scope, project_cwd, name)?;
    let base = resolve_abs(&agents_dir(scope, project_cwd));
    if !p.starts_with(&format!("{base}/")) {
        return Err(Thrown("path escapes base directory".into()));
    }
    let bytes = match std::fs::read(&p) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Thrown(e.to_string())),
    };
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let parsed = parse_frontmatter(&raw);
    Ok(Some(AgentFile {
        scope,
        name: name.to_owned(),
        path: p,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        raw,
    }))
}

/// `name.length` for a JSON value: a string's UTF-16 length, an array's
/// length; `undefined` (no limit applies) otherwise.
fn js_length(v: &Value) -> Option<usize> {
    match v {
        Value::Array(a) => Some(a.len()),
        v => db_agents::as_str(v).map(|s| s.encode_utf16().count()),
    }
}

/// `writeAgent(scope, projectCwd, name, raw)`. `name` is whatever the
/// request body held (from [`db_agents::json_parse`]), which the checks and
/// the filename see through `String(name)`. `Err` is the thrown error's
/// `message`, which the route answers 400 with.
pub fn write_agent(
    scope: AgentScope,
    project_cwd: &str,
    name: &Value,
    raw: &str,
) -> Result<(), String> {
    let name_text = db_agents::js_string(name);
    if !is_name(&name_text) {
        return Err("invalid agent name".into());
    }
    let fm = parse_frontmatter(raw).frontmatter;
    if fm
        .name
        .as_ref()
        .is_some_and(|n| n.contains(&u16::from(b':')))
    {
        return Err(
            "agent name cannot contain ':' \u{2014} reserved for plugin namespacing".into(),
        );
    }
    if name.is_null() {
        // `null.length` (the route never gets here: it wants a truthy name)
        return Err("Cannot read properties of null (reading 'length')".into());
    }
    let too_long = format!("agent name too long (max {MAX_AGENT_NAME_LENGTH} characters)");
    if js_length(name).is_some_and(|n| n > MAX_AGENT_NAME_LENGTH) {
        return Err(too_long);
    }
    if fm
        .name
        .as_ref()
        .is_some_and(|n| n.len() > MAX_AGENT_NAME_LENGTH)
    {
        return Err(too_long);
    }
    let base = resolve_abs(&agents_dir(scope, project_cwd));
    let p = resolve_in(&base, &format!("{name_text}.md"));
    if p != base && !p.starts_with(&format!("{base}/")) {
        return Err("path escapes base directory".into());
    }
    mkdir_p(dirname(&p)).map_err(|(errno, at)| node_fs_message(errno, "mkdir", &at))?;
    // (the barrier again, at the sink)
    if !p.starts_with(&format!("{base}/")) {
        return Err("path escapes base directory".into());
    }
    std::fs::write(&p, raw).map_err(|e| node_fs_message(errno_of(&e), "open", &p))?;
    Ok(())
}

/// `deleteAgent(scope, projectCwd, name)`: whether a file was removed.
pub fn delete_agent(scope: AgentScope, project_cwd: &str, name: &str) -> Result<bool, Thrown> {
    let p = agent_path(scope, project_cwd, name)?;
    let base = resolve_abs(&agents_dir(scope, project_cwd));
    if !p.starts_with(&format!("{base}/")) {
        return Err(Thrown("path escapes base directory".into()));
    }
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(Thrown(e.to_string())),
    }
}

// ─── frontmatter ──────────────────────────────────────────────────────────

/// `parseFrontmatter(raw)`'s result.
#[derive(Clone, Debug)]
pub struct Parsed {
    pub frontmatter: yaml::Frontmatter,
    pub body: String,
}

fn empty_frontmatter() -> yaml::Frontmatter {
    yaml::Frontmatter {
        json: Some(Value::Object(Map::new())),
        name: None,
    }
}

/// `parseFrontmatter(raw)`: one leading BOM dropped, then
/// `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/`; the first group is the
/// YAML, the second the body. No match: `{}` and the whole text.
pub fn parse_frontmatter(raw: &str) -> Parsed {
    let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let Some(rest) = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))
    else {
        return Parsed {
            frontmatter: empty_frontmatter(),
            body: text.to_owned(),
        };
    };
    // The lazy group ends at the first `\r?\n---`.
    let b = rest.as_bytes();
    let found = (0..b.len()).find_map(|i| {
        if b[i..].starts_with(b"\r\n---") {
            Some((i, i + 5))
        } else if b[i..].starts_with(b"\n---") {
            Some((i, i + 4))
        } else {
            None
        }
    });
    let Some((end, after)) = found else {
        return Parsed {
            frontmatter: empty_frontmatter(),
            body: text.to_owned(),
        };
    };
    let mut body_start = after;
    if b.get(body_start) == Some(&b'\r') {
        body_start += 1;
    }
    if b.get(body_start) == Some(&b'\n') {
        body_start += 1;
    }
    Parsed {
        frontmatter: yaml::frontmatter(&rest[..end]),
        body: rest[body_start..].to_owned(),
    }
}

// ─── node's fs errors ────────────────────────────────────────────────────

fn errno_of(e: &io::Error) -> i32 {
    e.raw_os_error().unwrap_or(libc::EIO)
}

/// The `message` of the error node's `fs` throws: `CODE: description,
/// syscall 'path'` (libuv's names and descriptions).
pub fn node_fs_message(errno: i32, syscall: &str, path: &str) -> String {
    let (code, desc) = match errno {
        libc::EACCES => ("EACCES", "permission denied"),
        libc::EEXIST => ("EEXIST", "file already exists"),
        libc::EISDIR => ("EISDIR", "illegal operation on a directory"),
        libc::ENOTDIR => ("ENOTDIR", "not a directory"),
        libc::ENOENT => ("ENOENT", "no such file or directory"),
        libc::ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        libc::EPERM => ("EPERM", "operation not permitted"),
        libc::ELOOP => ("ELOOP", "too many symbolic links encountered"),
        libc::EROFS => ("EROFS", "read-only file system"),
        libc::ENOSPC => ("ENOSPC", "no space left on device"),
        libc::EMFILE => ("EMFILE", "too many open files"),
        libc::ENFILE => ("ENFILE", "file table overflow"),
        libc::EBUSY => ("EBUSY", "resource busy or locked"),
        libc::EINVAL => ("EINVAL", "invalid argument"),
        libc::EIO => ("EIO", "i/o error"),
        libc::EFBIG => ("EFBIG", "file too large"),
        libc::ETXTBSY => ("ETXTBSY", "text file is busy"),
        libc::EDQUOT => ("EDQUOT", "disk quota exceeded"),
        libc::EAGAIN => ("EAGAIN", "resource temporarily unavailable"),
        libc::ENOMEM => ("ENOMEM", "not enough memory"),
        _ => {
            let unknown = format!("Unknown system error -{errno}");
            return format!("{unknown}: {unknown}, {syscall} '{path}'");
        }
    };
    format!("{code}: {desc}, {syscall} '{path}'")
}

/// `mkdir(p, { recursive: true })` as node's `MKDirpAsync` runs it, down to
/// which errno it reports for which path (`ENOTDIR` for a file in the way
/// of a parent, `EEXIST` for a file at `p` itself).
pub fn mkdir_p(path: &str) -> Result<(), (i32, String)> {
    let mut stack = vec![path.to_owned()];
    while let Some(next) = stack.pop() {
        let mut err = match std::fs::create_dir(&next) {
            Ok(()) => 0,
            Err(e) => errno_of(&e),
        };
        loop {
            match err {
                0 => {
                    if stack.is_empty() {
                        return Ok(());
                    }
                }
                libc::EACCES | libc::ENOSPC | libc::ENOTDIR | libc::EPERM => {
                    return Err((err, next));
                }
                libc::ENOENT => {
                    let dirname = next
                        .rfind('/')
                        .map_or(next.as_str(), |i| &next[..i])
                        .to_owned();
                    if dirname != next {
                        stack.push(next.clone());
                        stack.push(dirname);
                    } else if stack.is_empty() {
                        err = libc::EEXIST;
                        continue;
                    }
                }
                orig => {
                    let parent_pending = orig == libc::EEXIST && !stack.is_empty();
                    match std::fs::metadata(Path::new(&next)) {
                        Ok(md) if md.is_dir() => {
                            if !parent_pending {
                                return Ok(());
                            }
                        }
                        Ok(_) if parent_pending => return Err((libc::ENOTDIR, next)),
                        Ok(_) => return Err((libc::EEXIST, next)),
                        Err(_) if parent_pending => return Err((libc::ENOTDIR, next)),
                        Err(e) => return Err((errno_of(&e), next)),
                    }
                }
            }
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_follows_path_posix() {
        for (p, want) in [
            ("", "."),
            ("/", "/"),
            ("//a//b/", "/a/b/"),
            ("/a/../..", "/"),
            ("a/../..", ".."),
            ("./a/./b", "a/b"),
            ("a/", "a/"),
            ("./", "./"),
            ("/x/.claude/agents", "/x/.claude/agents"),
        ] {
            assert_eq!(normalize(p), want, "{p:?}");
        }
        assert_eq!(join(&["/", ".claude", "agents"]), "/.claude/agents");
        assert_eq!(
            join(&["/home/u/", ".claude", "agents"]),
            "/home/u/.claude/agents"
        );
    }

    #[test]
    fn frontmatter_delimiters() {
        let p = parse_frontmatter("\u{feff}---\r\nname: a\r\n---\r\nbody\n");
        assert_eq!(p.frontmatter.json, Some(json!({"name": "a"})));
        assert_eq!(p.body, "body\n");
        let p = parse_frontmatter("---\n---\nbody");
        assert_eq!(p.frontmatter.json, Some(json!({})));
        assert_eq!(p.body, "---\n---\nbody", "no match: the whole text");
        let p = parse_frontmatter("---\n\n---\rx");
        assert_eq!(p.body, "x");
    }
}
