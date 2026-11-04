//! `lib/server/worktrees.ts` (D05): a checkout's git worktrees, as
//! `git worktree list --porcelain` reports them, behind `GET /api/worktrees`.
//!
//! Each worktree is a JSON object in the order the TS sets its keys: `path`
//! first, then `head`, `branch`, `bare`, `detached`, `locked` and
//! `prunable` as their lines come (a repeated key keeps its first place and
//! its last value, as a JS property does). Replayed against the TS in
//! `tests/worktrees_golden.rs` and `claudius-server/tests/worktrees_fork.rs`.

use std::path::Path;

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::exec_file::{ExecFileOptions, exec_file};

/// `listWorktrees`' `maxBuffer` (4 MiB).
pub const MAX_BUFFER: usize = 4 * 1024 * 1024;

/// `parsePorcelain(text)`: groups of `key value` and flag lines, separated
/// by blank lines. Lines split at `\n` and lose their trailing JS whitespace
/// (`trimEnd`, so a `\r` before the `\n` goes too); the key is everything
/// before the first space. A `worktree` line with a value starts a new entry
/// and drops one no blank line closed yet; other lines before the first
/// `worktree` are skipped; the last entry is kept without a closing blank
/// line. `branch` drops one leading `refs/heads/`; the flags are `true`
/// whatever follows them.
pub fn parse_porcelain(text: &str) -> Vec<Map<String, Value>> {
    let mut out = Vec::new();
    let mut cur: Option<Map<String, Value>> = None;
    for raw in text.split('\n') {
        let line = raw.trim_end_matches(js::is_whitespace);
        if line.is_empty() {
            out.extend(cur.take());
            continue;
        }
        // `value` is `undefined` without a space; JS's `&& value` also
        // skips an empty one (never left after `trimEnd`).
        let (key, value) = match line.find(' ') {
            Some(i) => (&line[..i], Some(&line[i + 1..]).filter(|v| !v.is_empty())),
            None => (line, None),
        };
        if let ("worktree", Some(path)) = (key, value) {
            let mut wt = Map::new();
            wt.insert("path".into(), Value::String(path.to_owned()));
            cur = Some(wt);
            continue;
        }
        let Some(wt) = cur.as_mut() else {
            continue;
        };
        let (field, v) = match (key, value) {
            ("HEAD", Some(v)) => ("head", Value::String(v.to_owned())),
            ("branch", Some(v)) => (
                "branch",
                Value::String(v.strip_prefix("refs/heads/").unwrap_or(v).to_owned()),
            ),
            ("bare" | "detached" | "locked" | "prunable", _) => (key, Value::Bool(true)),
            _ => continue,
        };
        wt.insert(field.to_owned(), v);
    }
    out.extend(cur);
    out
}

/// `listWorktrees(cwd)`: `git worktree list --porcelain` run in `cwd`
/// (`execFile`, no timeout, a 4 MiB `maxBuffer`), parsed; `[]` when git
/// fails, can't start (a missing or non-directory `cwd`) or says too much.
pub async fn list_worktrees(cwd: &str) -> Vec<Map<String, Value>> {
    let opts = ExecFileOptions {
        cwd: Some(Path::new(cwd)),
        timeout_ms: 0,
        max_buffer: MAX_BUFFER,
    };
    match exec_file("git", &["worktree", "list", "--porcelain"], opts).await {
        Ok(out) => parse_porcelain(&out.stdout),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> String {
        js::stringify(&Value::Array(
            parse_porcelain(text)
                .into_iter()
                .map(Value::Object)
                .collect(),
        ))
    }

    #[test]
    fn keys_follow_the_lines() {
        assert_eq!(
            parsed("worktree /a\nbranch refs/heads/x\nHEAD 1\nHEAD 2\n\nworktree /b\nbare"),
            r#"[{"path":"/a","branch":"x","head":"2"},{"path":"/b","bare":true}]"#
        );
        assert_eq!(
            parsed("HEAD x\nworktree\nworktree /a\nworktree /b\n"),
            r#"[{"path":"/b"}]"#
        );
    }
}
