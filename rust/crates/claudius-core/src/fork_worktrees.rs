//! `lib/server/fork-worktrees.ts` and `lib/shared/fork-worktree.ts` (D05):
//! the git worktree `POST /api/sessions/fork` carves off for a `/fork`
//! (`worktree: true`), and the index that maps the fork to it, which
//! [`crate::trusted_cwd::fork_worktree_cwd`] reads when the fork is opened.
//!
//! The worktree is `~/.claude/.claudius/fork-worktrees/fork-<slug>` on a new
//! branch `claudius/fork-<slug>` off the source repo's `HEAD`; it is never
//! removed here. `index.json` is read as `JSON.parse` reads it (a file that
//! doesn't parse, or has no truthy `forks`, starts a fresh index) and written
//! back as `JSON.stringify(idx, null, 2)` with no newline and `version: 1`.
//! The fork goes in as a JS property assignment: an object gains (or
//! replaces) the key; an array takes a property `JSON.stringify` never writes,
//! so nothing is recorded; a truthy primitive throws (strict mode). Replayed
//! against the TS in `tests/worktrees_golden.rs` and
//! `claudius-server/tests/worktrees_fork.rs`.

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::exec_file::{ExecFileOptions, exec_file};
use crate::{git, js_string, node_fs, node_path, paths};

/// Why a bare repository's root gets no worktree.
pub const BARE_REASON: &str = "this is a bare repository's root, which has no working tree";
/// Why a repository whose `HEAD` is unborn gets no worktree.
pub const NO_COMMITS_REASON: &str = "the repository has no commits yet";
/// `MAX_REASON_CHARS`, in UTF-16 units.
const MAX_REASON_CHARS: usize = 120;

/// `forkSlug(sessionId)`: the id's ASCII letters and digits, the first 8,
/// lower-cased; `"session"` when there are none.
pub fn fork_slug(session_id: &str) -> String {
    let cleaned: String = session_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect();
    if cleaned.is_empty() {
        "session".into()
    } else {
        cleaned.to_ascii_lowercase()
    }
}

/// `forkWorktreeIds(sessionId)`: `(branch, dirName)`.
pub fn fork_worktree_ids(session_id: &str) -> (String, String) {
    let slug = fork_slug(session_id);
    (format!("claudius/fork-{slug}"), format!("fork-{slug}"))
}

/// `/^(fatal|error):/i` (ASCII case folding only, as a non-`u` regex
/// folds): the prefix's length.
fn failure_prefix(line: &str) -> Option<usize> {
    let head = line.get(..6)?;
    (head.eq_ignore_ascii_case("fatal:") || head.eq_ignore_ascii_case("error:")).then_some(6)
}

/// `worktreeFailureReason(stderr)`: the first `fatal:` / `error:` line of a
/// failed `git worktree add` (else the first non-blank line), the prefix and
/// the JS whitespace after it dropped, runs of JS whitespace made one space,
/// trimmed, and cut to 119 UTF-16 units plus `…` past 120 (a cut through a
/// surrogate pair leaves the high half, as a [`js_string`] stand-in);
/// `"git worktree add failed"` when nothing is left.
pub fn worktree_failure_reason(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .split('\n')
        .map(js::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let line = lines
        .iter()
        .find(|l| failure_prefix(l).is_some())
        .or(lines.first())
        .copied()
        .unwrap_or("");
    let rest = match failure_prefix(line) {
        Some(n) => line[n..].trim_start_matches(js::is_whitespace),
        None => line,
    };
    let mut collapsed = String::with_capacity(rest.len());
    let mut in_space = false;
    for c in rest.chars() {
        if js::is_whitespace(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let cleaned = js::trim(&collapsed);
    if cleaned.is_empty() {
        return "git worktree add failed".into();
    }
    let units = js_string::units(cleaned);
    if units.len() > MAX_REASON_CHARS {
        format!("{}…", js_string::from_units(&units[..MAX_REASON_CHARS - 1]))
    } else {
        cleaned.to_owned()
    }
}

/// `ForkWorktreeInfo`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForkWorktreeInfo {
    pub path: String,
    pub branch: String,
    /// The source had uncommitted changes, which the worktree (cut from
    /// `HEAD`) doesn't carry.
    pub dirty: bool,
}

impl ForkWorktreeInfo {
    /// `{path, branch, dirty}`.
    pub fn to_json(&self) -> Value {
        json!({"path": self.path, "branch": self.branch, "dirty": self.dirty})
    }
}

/// `ForkWorktreeResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ForkWorktree {
    /// `{ok: true, worktree}`.
    Created(ForkWorktreeInfo),
    /// `{ok: false, reason?}`: a reason when the source is a git repo (or a
    /// bare one) whose worktree couldn't be made; none for a non-git source.
    Failed(Option<String>),
}

/// `forkWorktreesRoot()`: `join(homedir(), ".claude", ".claudius",
/// "fork-worktrees")`.
pub fn fork_worktrees_root() -> String {
    let home = paths::home_dir();
    node_path::join(&[
        &home.to_string_lossy(),
        ".claude",
        ".claudius",
        "fork-worktrees",
    ])
}

/// `execFileP("git", ["-C", dir, ...args], { timeout })`.
async fn git_c(dir: &str, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    let mut argv = vec!["-C", dir];
    argv.extend_from_slice(args);
    let opts = ExecFileOptions {
        timeout_ms,
        ..ExecFileOptions::default()
    };
    exec_file("git", &argv, opts)
        .await
        .map(|o| o.stdout)
        .map_err(|e| e.stderr)
}

/// `isBareRepository(cwd)`: `rev-parse --is-bare-repository` says `true`.
async fn is_bare_repository(cwd: &str) -> bool {
    git_c(cwd, &["rev-parse", "--is-bare-repository"], 5_000)
        .await
        .is_ok_and(|out| js::trim(&out) == "true")
}

/// `createForkWorktree(sourceCwd, forkId)`: the worktree off `HEAD` of
/// `source_cwd`'s repo, recorded in the index. `Err` is a throw (the root
/// can't be made, the index can't take the fork or can't be written), which
/// the route treats as no worktree and no reason; a worktree `git` made by
/// then stays on disk.
pub async fn create_fork_worktree(source_cwd: &str, fork_id: &str) -> Result<ForkWorktree, String> {
    let Some(repo_root) = git::get_repo_root(source_cwd).await else {
        // `--show-toplevel` fails at a bare repository's root as it does
        // outside a repo.
        if is_bare_repository(source_cwd).await {
            return Ok(ForkWorktree::Failed(Some(BARE_REASON.into())));
        }
        return Ok(ForkWorktree::Failed(None));
    };
    let (branch, dir_name) = fork_worktree_ids(fork_id);
    // Path-injection barrier, as in the TS: resolved under the root and
    // checked right above the git and fs calls (`dir_name` is a slug).
    let root = fork_worktrees_root();
    let target = node_path::resolve(&[&root, &dir_name]);
    if !target.starts_with(&format!("{root}/")) {
        return Ok(ForkWorktree::Failed(None));
    }
    if git_c(
        &repo_root,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        5_000,
    )
    .await
    .is_err()
    {
        return Ok(ForkWorktree::Failed(Some(NO_COMMITS_REASON.into())));
    }
    // Non-fatal: a failed status (or one past the 1 MiB default
    // `maxBuffer`) reads as clean.
    let dirty = git_c(&repo_root, &["status", "--porcelain"], 5_000)
        .await
        .is_ok_and(|out| !js::trim(&out).is_empty());
    node_fs::mkdir_recursive(&root, 0o777).map_err(|e| e.message)?;
    if let Err(stderr) = git_c(
        &repo_root,
        &["worktree", "add", "-b", &branch, &target, "HEAD"],
        20_000,
    )
    .await
    {
        return Ok(ForkWorktree::Failed(Some(worktree_failure_reason(&stderr))));
    }
    let index = node_path::join(&[&root, "index.json"]);
    let mut forks = read_index_forks(&index);
    let assoc = json!({"cwd": target, "branch": branch, "sourceCwd": repo_root});
    match &mut forks {
        Value::Object(m) => {
            m.insert(fork_id.to_owned(), assoc);
        }
        // A non-index property: `JSON.stringify` leaves it out.
        Value::Array(_) => {}
        other => {
            return Err(format!(
                "Cannot create property '{fork_id}' on {} '{}'",
                js_type(other),
                js::to_string(Some(other))
            ));
        }
    }
    node_fs::mkdir_recursive(&root, 0o777).map_err(|e| e.message)?;
    let text = js_string::stringify_pretty(&json!({"version": 1, "forks": forks}));
    node_fs::write_file(&index, &text, 0o666).map_err(|e| e.message)?;
    Ok(ForkWorktree::Created(ForkWorktreeInfo {
        path: target,
        branch,
        dirty,
    }))
}

/// `readIndex().forks`: the parsed file's `forks` when the file is an object
/// with a truthy one, else `{}` (missing, unreadable or malformed files too).
fn read_index_forks(index: &str) -> Value {
    if let Ok(text) = node_fs::read_to_string(index)
        && let Ok(Value::Object(mut parsed)) = js_string::parse(&text)
        && let Some(forks) = parsed.remove("forks").filter(js::truthy)
    {
        return forks;
    }
    Value::Object(Map::new())
}

/// `typeof v` for the primitives a property assignment throws on.
fn js_type(v: &Value) -> &'static str {
    match v {
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        _ => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_ids() {
        assert_eq!(fork_slug("ABCDEF12-3456"), "abcdef12");
        assert_eq!(fork_slug("--"), "session");
        assert_eq!(
            fork_worktree_ids("a-b"),
            ("claudius/fork-ab".into(), "fork-ab".into())
        );
    }

    #[test]
    fn reasons() {
        assert_eq!(worktree_failure_reason(""), "git worktree add failed");
        assert_eq!(
            worktree_failure_reason("Preparing\nERROR:  a \t b \n"),
            "a b"
        );
        let long = format!("fatal: {}", "x".repeat(130));
        let got = worktree_failure_reason(&long);
        assert_eq!(js_string::len16(&got), 120);
        assert!(got.ends_with('…'));
    }
}
