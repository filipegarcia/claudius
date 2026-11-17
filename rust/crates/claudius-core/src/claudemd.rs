//! CLAUDE.md files: `lib/server/claudemd.ts`. Four scopes: user
//! (`homedir()/.claude/CLAUDE.md`), project (`<cwd>/CLAUDE.md`, falling
//! back to `<cwd>/AGENTS.md` when only that exists, as Claude Code 2.1.277
//! reads it), project-claude (`<cwd>/.claude/CLAUDE.md`) and local
//! (`<cwd>/CLAUDE.local.md`). Every function takes `home` (`homedir()`).
//!
//! [`resolve_content`] expands `@path` import lines the way the TS does:
//! a path relative to the importing file's folder, or an absolute one,
//! anywhere on disk (the import graph is the user's own files, which Claude
//! Code reads the same way), five hops at most, each file once per tree.
//! Those reads are the one place here without a containment check.

use std::collections::HashSet;
use std::path::Path;

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::js_string;
use crate::node_fs;
use crate::node_path;
use crate::safe_path;
use crate::skills::Thrown;

/// `MAX_IMPORT_HOPS`.
pub const MAX_IMPORT_HOPS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeMdScope {
    User,
    Project,
    ProjectClaude,
    Local,
}

impl ClaudeMdScope {
    /// The four scopes, in `readAllScopes` / `resolveHierarchy` order.
    pub const ALL: [ClaudeMdScope; 4] = [
        ClaudeMdScope::User,
        ClaudeMdScope::Project,
        ClaudeMdScope::ProjectClaude,
        ClaudeMdScope::Local,
    ];

    /// `SCOPES.includes(s)`.
    pub fn parse(s: &str) -> Option<ClaudeMdScope> {
        ClaudeMdScope::ALL.into_iter().find(|c| c.as_str() == s)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ClaudeMdScope::User => "user",
            ClaudeMdScope::Project => "project",
            ClaudeMdScope::ProjectClaude => "project-claude",
            ClaudeMdScope::Local => "local",
        }
    }
}

/// The folder a scope's file lives under, and the file relative to it.
fn parts(home: &str, scope: ClaudeMdScope, project_cwd: &str) -> (String, &'static str) {
    match scope {
        ClaudeMdScope::User => (node_path::join(&[home, ".claude"]), "CLAUDE.md"),
        ClaudeMdScope::Project => (project_cwd.to_owned(), "CLAUDE.md"),
        ClaudeMdScope::ProjectClaude => (project_cwd.to_owned(), ".claude/CLAUDE.md"),
        ClaudeMdScope::Local => (project_cwd.to_owned(), "CLAUDE.local.md"),
    }
}

/// `pathFor(scope, projectCwd)`, through `assertWithin`.
pub fn path_for(home: &str, scope: ClaudeMdScope, project_cwd: &str) -> Result<String, Thrown> {
    let (base, child) = parts(home, scope, project_cwd);
    safe_path::assert_within(&base, child).map_err(Thrown::path_injection)
}

/// `agentsPathFor(projectCwd)`.
fn agents_path_for(project_cwd: &str) -> Result<String, Thrown> {
    safe_path::assert_within(project_cwd, "AGENTS.md").map_err(Thrown::path_injection)
}

/// The resolved folder a scope's fs calls are checked against.
fn base_of(home: &str, scope: ClaudeMdScope, project_cwd: &str) -> String {
    node_path::resolve(&[&parts(home, scope, project_cwd).0])
}

fn inside(base: &str, target: &str) -> bool {
    target.starts_with(&format!("{base}/"))
}

/// A `ScopeFile`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeFile {
    pub scope: ClaudeMdScope,
    pub path: String,
    pub exists: bool,
    pub content: String,
    /// The project scope's file is AGENTS.md (the key is absent otherwise).
    pub using_agents_fallback: bool,
}

impl ScopeFile {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("scope".into(), json!(self.scope.as_str()));
        m.insert("path".into(), json!(self.path));
        m.insert("exists".into(), json!(self.exists));
        m.insert("content".into(), json!(self.content));
        if self.using_agents_fallback {
            m.insert("usingAgentsFallback".into(), json!(true));
        }
        Value::Object(m)
    }
}

/// `readFile(path, "utf8")` of a path checked to be under `base`.
fn read_text(base: &str, path: &str) -> Result<Option<String>, Thrown> {
    let target = node_path::resolve(&[path]);
    if !inside(base, &target) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    match node_fs::sys::read_file(Path::new(&target)) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.code == "ENOENT" => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// `readScope(scope, projectCwd)`. A missing file is `exists: false` with
/// empty content; any other read error throws.
pub fn read_scope(
    home: &str,
    scope: ClaudeMdScope,
    project_cwd: &str,
) -> Result<ScopeFile, Thrown> {
    let path = path_for(home, scope, project_cwd)?;
    read_scope_at(home, scope, project_cwd, path)
}

fn read_scope_at(
    home: &str,
    scope: ClaudeMdScope,
    project_cwd: &str,
    path: String,
) -> Result<ScopeFile, Thrown> {
    let base = base_of(home, scope, project_cwd);
    let file = |path: String, content: Option<String>, fallback: bool| ScopeFile {
        scope,
        path,
        exists: content.is_some(),
        content: content.unwrap_or_default(),
        using_agents_fallback: fallback,
    };
    if let Some(content) = read_text(&base, &path)? {
        return Ok(file(path, Some(content), false));
    }
    if scope != ClaudeMdScope::Project {
        return Ok(file(path, None, false));
    }
    let agents_path = agents_path_for(project_cwd)?;
    match read_text(&base, &agents_path)? {
        Some(content) => Ok(file(agents_path, Some(content), true)),
        None => Ok(file(path, None, false)),
    }
}

/// `fs.access(path)` (`F_OK`): whether it can be reached.
fn accessible(path: &str) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(Path::new(path).as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `c` is a NUL-terminated path that outlives the call.
        unsafe { libc::access(c.as_ptr(), libc::F_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        Path::new(path).exists()
    }
}

/// `resolveProjectWritePath(projectCwd)`: CLAUDE.md if it's there, else
/// AGENTS.md if that is, else CLAUDE.md.
fn resolve_project_write_path(project_cwd: &str) -> Result<String, Thrown> {
    let base = node_path::resolve(&[project_cwd]);
    let claude_path =
        safe_path::assert_within(project_cwd, "CLAUDE.md").map_err(Thrown::path_injection)?;
    if !inside(&base, &claude_path) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    if accessible(&claude_path) {
        return Ok(claude_path);
    }
    let agents_path = agents_path_for(project_cwd)?;
    if !inside(&base, &agents_path) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    if accessible(&agents_path) {
        return Ok(agents_path);
    }
    Ok(claude_path)
}

/// `writeScope(scope, projectCwd, content)`: the path written.
pub fn write_scope(
    home: &str,
    scope: ClaudeMdScope,
    project_cwd: &str,
    content: &str,
) -> Result<String, Thrown> {
    let path = match scope {
        ClaudeMdScope::Project => resolve_project_write_path(project_cwd)?,
        _ => path_for(home, scope, project_cwd)?,
    };
    let base = base_of(home, scope, project_cwd);
    if !inside(&base, &path) {
        return Err(Thrown::path_injection("path escapes base directory"));
    }
    node_fs::sys::mkdir_recursive(Path::new(&node_path::dirname(&path)))?;
    node_fs::sys::write_file(Path::new(&path), content.as_bytes())?;
    Ok(path)
}

/// `readAllScopes(projectCwd)`: the four scopes. Under `Promise.all` a
/// `pathFor` refusal (thrown before any read) wins over a read error.
pub fn read_all_scopes(home: &str, project_cwd: &str) -> Result<Vec<ScopeFile>, Thrown> {
    let paths = ClaudeMdScope::ALL
        .into_iter()
        .map(|s| path_for(home, s, project_cwd).map(|p| (s, p)))
        .collect::<Result<Vec<_>, _>>()?;
    paths
        .into_iter()
        .map(|(s, p)| read_scope_at(home, s, project_cwd, p))
        .collect()
}

/// A `ResolvedSegment` (`scope` is always `"import"`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    pub source: String,
    pub content: String,
    pub depth: usize,
}

impl Segment {
    pub fn to_json(&self) -> Value {
        json!({
            "scope": "import",
            "source": self.source,
            "content": self.content,
            "depth": self.depth,
        })
    }
}

/// The path of an `@path` line: `/^@(\S+)\s*$/` on the trimmed line.
fn import_line(line: &str) -> Option<&str> {
    let path = js::trim(line).strip_prefix('@')?;
    (!path.is_empty() && !path.chars().any(js::is_whitespace)).then_some(path)
}

/// `resolveContent(content, baseDir, visited, depth)`: `content` cut into
/// `(inline)` runs and the files its `@path` lines import (recursively,
/// each source prefixed `@path → `), a file already inlined in this tree
/// marked `(cycle)`, an unreadable one `(missing)`, and past five hops a
/// single `(max import depth exceeded)` segment.
pub fn resolve_content(
    content: &str,
    base_dir: &str,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Vec<Segment> {
    if depth > MAX_IMPORT_HOPS {
        return vec![Segment {
            source: "(max import depth exceeded)".into(),
            content: String::new(),
            depth,
        }];
    }
    let mut segments = Vec::new();
    let mut buffer: Vec<&str> = Vec::new();
    let flush = |buffer: &mut Vec<&str>, segments: &mut Vec<Segment>| {
        if !buffer.is_empty() {
            segments.push(Segment {
                source: "(inline)".into(),
                content: buffer.join("\n"),
                depth,
            });
            buffer.clear();
        }
    };
    let marked = |import_path: &str, mark: &str| Segment {
        source: format!("{import_path} ({mark})"),
        content: String::new(),
        depth,
    };
    for line in content.split('\n') {
        let Some(import_path) = import_line(line) else {
            buffer.push(line);
            continue;
        };
        flush(&mut buffer, &mut segments);
        let abs = if node_path::is_absolute(import_path) {
            import_path.to_owned()
        } else {
            node_path::resolve(&[base_dir, import_path])
        };
        if visited.contains(&abs) {
            segments.push(marked(import_path, "cycle"));
            continue;
        }
        // Anywhere on disk, as in TS (see the module doc).
        let Ok(bytes) = node_fs::sys::read_file(Path::new(&abs)) else {
            segments.push(marked(import_path, "missing"));
            continue;
        };
        let inner = String::from_utf8_lossy(&bytes).into_owned();
        visited.insert(abs.clone());
        for s in resolve_content(&inner, &node_path::dirname(&abs), visited, depth + 1) {
            segments.push(Segment {
                source: format!("@{import_path} \u{2192} {}", s.source),
                ..s
            });
        }
    }
    flush(&mut buffer, &mut segments);
    segments
}

/// `resolveHierarchy(projectCwd)`: each scope's segments (none for a
/// missing file) and the total UTF-16 length of their content.
pub fn resolve_hierarchy(home: &str, project_cwd: &str) -> Result<Value, Thrown> {
    let mut scopes = Vec::new();
    let mut total_chars = 0usize;
    for scope in ClaudeMdScope::ALL {
        let file = read_scope(home, scope, project_cwd)?;
        let segments = if file.exists {
            let segments = resolve_content(
                &file.content,
                &node_path::dirname(&file.path),
                &mut HashSet::new(),
                0,
            );
            total_chars += segments
                .iter()
                .map(|s| js_string::len16(&s.content))
                .sum::<usize>();
            segments
        } else {
            Vec::new()
        };
        scopes.push(json!({
            "scope": scope.as_str(),
            "path": file.path,
            "exists": file.exists,
            "segments": segments.iter().map(Segment::to_json).collect::<Vec<_>>(),
        }));
    }
    Ok(json!({ "cwd": project_cwd, "scopes": scopes, "totalChars": total_chars }))
}
