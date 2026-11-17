//! `lib/server/rules.ts`: plain-text CRUD for Claude Code rule files,
//! `<dir>/*.md` under `homedir()/.claude/rules` (user scope) or
//! `<cwd>/.claude/rules` (project scope; the cwd must be absolute, via
//! safe-path.ts `assertAbsoluteUserPath`). A rule's text is the body as it
//! was sent: no front matter, no index. Replayed against the TS in
//! `tests/memory_golden.rs`.
//!
//! Names pass `^[\w.\-]+\.md$` before the scope's directory is worked out
//! (so a bad name wins over a bad cwd), except in [`list_rules`]. Each call
//! then checks, right before its fs call, that the resolved target sits
//! under the resolved directory. Symlinks are followed (reads, edits,
//! listings), as in TS; a create is exclusive, so it never goes through an
//! existing entry.

use crate::auto_memory::{self, MemoryFile, Outcome, Refusal, Thrown, Written};
use crate::node_fs::{self, FsError};
use crate::{node_path, safe_path};

/// `RuleScope`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleScope {
    User,
    Project,
}

impl RuleScope {
    /// `"user"` / `"project"`, as the route takes them.
    pub fn parse(s: &str) -> Option<RuleScope> {
        match s {
            "user" => Some(RuleScope::User),
            "project" => Some(RuleScope::Project),
            _ => None,
        }
    }
}

/// `isValidRuleFilename(name)`: the auto-memory name rule.
pub fn is_valid_rule_filename(name: &str) -> bool {
    auto_memory::is_valid_memory_filename(name)
}

/// `rulesDir(scope, projectCwd)` under `home` (`homedir()`).
pub fn rules_dir(home: &str, scope: RuleScope, cwd: Option<&str>) -> Result<String, Thrown> {
    match scope {
        RuleScope::User => Ok(node_path::join(&[home, ".claude", "rules"])),
        RuleScope::Project => match cwd.filter(|c| !c.is_empty()) {
            None => Err(Thrown::PathInjection(
                "project scope requires an absolute cwd".into(),
            )),
            Some(cwd) => Ok(node_path::join(&[
                &safe_path::assert_absolute_user_path(cwd)
                    .map_err(|m| Thrown::PathInjection(m.into()))?,
                ".claude",
                "rules",
            ])),
        },
    }
}

/// `listRules(scope, projectCwd)`.
pub fn list_rules(
    home: &str,
    scope: RuleScope,
    cwd: Option<&str>,
) -> Result<Vec<MemoryFile>, Thrown> {
    let dir = rules_dir(home, scope, cwd)?;
    Ok(auto_memory::list_md_files(&dir)?)
}

/// `readRule(scope, name, projectCwd)`: `None` for an invalid name or a
/// missing file.
pub fn read_rule(
    home: &str,
    scope: RuleScope,
    name: &str,
    cwd: Option<&str>,
) -> Result<Option<String>, Thrown> {
    if !is_valid_rule_filename(name) {
        return Ok(None);
    }
    let base = node_path::resolve(&[&rules_dir(home, scope, cwd)?]);
    let target = node_path::resolve(&[&base, name]);
    if !target.starts_with(&format!("{base}/")) {
        return Ok(None);
    }
    match node_fs::read_to_string(&target) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.is_not_found() => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// `fs.access(path)`: whether the path resolves (following symlinks).
fn access(path: &str) -> Result<(), FsError> {
    std::fs::metadata(path)
        .map(|_| ())
        .map_err(|e| FsError::new(&e, "access", Some(path), None))
}

/// `writeRule(scope, name, body, projectCwd, overwrite)`: a create (409
/// when the name exists) or, with `overwrite`, an edit of an existing file
/// (404 when it doesn't). The directory is made either way.
pub fn write_rule(
    home: &str,
    scope: RuleScope,
    name: &str,
    body: &str,
    cwd: Option<&str>,
    overwrite: bool,
) -> Outcome<Written> {
    if !is_valid_rule_filename(name) {
        return Ok(Err(Refusal::new(400, "invalid filename")));
    }
    let base = node_path::resolve(&[&rules_dir(home, scope, cwd)?]);
    node_fs::mkdir_recursive(&base, 0o777)?;
    let target = node_path::resolve(&[&base, name]);
    if !target.starts_with(&format!("{base}/")) {
        return Ok(Err(Refusal::new(400, "invalid path")));
    }
    let written = || Written {
        name: name.to_owned(),
        path: target.clone(),
    };
    if overwrite {
        if let Err(e) = access(&target) {
            return Ok(Err(if e.is_not_found() {
                Refusal::new(404, "not found")
            } else {
                Refusal::new(500, e.message)
            }));
        }
        if let Err(e) = auto_memory::write_text(&target, body) {
            return Ok(Err(Refusal::new(500, e.message)));
        }
        return Ok(Ok(written()));
    }
    if let Err(e) = auto_memory::write_new(&target, body) {
        return Ok(Err(if e.code.as_deref() == Some("EEXIST") {
            Refusal::new(409, "file already exists")
        } else {
            Refusal::new(500, e.message)
        }));
    }
    Ok(Ok(written()))
}

/// `deleteRule(scope, name, projectCwd)`.
pub fn delete_rule(home: &str, scope: RuleScope, name: &str, cwd: Option<&str>) -> Outcome<()> {
    if !is_valid_rule_filename(name) {
        return Ok(Err(Refusal::new(400, "invalid filename")));
    }
    let base = node_path::resolve(&[&rules_dir(home, scope, cwd)?]);
    let target = node_path::resolve(&[&base, name]);
    if !target.starts_with(&format!("{base}/")) {
        return Ok(Err(Refusal::new(400, "invalid path")));
    }
    if let Err(e) = auto_memory::unlink(&target) {
        return Ok(Err(if e.is_not_found() {
            Refusal::new(404, "not found")
        } else {
            Refusal::new(500, e.message)
        }));
    }
    Ok(Ok(()))
}
