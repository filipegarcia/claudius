//! `lib/server/updater/git.ts`, the parts the five D27a routes need: a
//! `git` runner aimed at the install root (never a workspace cwd), with
//! interactive prompts off and the standard install dirs on `PATH`.
//!
//! `apply`'s stash / pull / merge helpers stay on Next until D27b.

use std::path::Path;

use claudius_agent::js;

use crate::exec_file::{ErrorCode, ExecFileError, ExecFileOptions, ExecFileOutput, exec_file_env};
use crate::updater::spawn_env;
use crate::{js_string, paths};

/// `MAX_BUFFER`.
pub const MAX_BUFFER: usize = 16 * 1024 * 1024;
/// `DEFAULT_TIMEOUT_MS`.
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// `FETCH_TIMEOUT_MS`.
pub const FETCH_TIMEOUT_MS: u64 = 60_000;
/// `PULL_TIMEOUT_MS`.
pub const PULL_TIMEOUT_MS: u64 = 60_000;
/// `recentCommits`' default `limit`.
pub const RECENT_COMMITS_LIMIT: u32 = 8;

/// `UpdaterGitError`: what the run rejected with, plus the output it
/// attached (`git diff --check` reports its findings on stdout and still
/// exits non-zero).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdaterGitError {
    pub message: String,
    pub stderr: String,
    /// `typeof e.code === "number" ? e.code : null`.
    pub exit_code: Option<i32>,
    pub stdout: String,
}

/// The env `git()` runs with: `{...process.env, GIT_TERMINAL_PROMPT: "0",
/// GIT_ASKPASS: "/bin/echo", PATH: extendedPath(process.env.PATH)}`.
pub fn git_env() -> Vec<(String, String)> {
    let path = std::env::var_os("PATH").map(|p| p.to_string_lossy().into_owned());
    let home = paths::home_dir().to_string_lossy().into_owned();
    vec![
        ("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()),
        ("GIT_ASKPASS".to_owned(), "/bin/echo".to_owned()),
        (
            "PATH".to_owned(),
            spawn_env::extended_path(path.as_deref(), &home),
        ),
    ]
}

/// `git(args, cwd, timeoutMs)`.
pub async fn git(
    args: &[&str],
    cwd: &str,
    timeout_ms: u64,
) -> Result<ExecFileOutput, UpdaterGitError> {
    let opts = ExecFileOptions {
        cwd: Some(Path::new(cwd)),
        timeout_ms,
        max_buffer: MAX_BUFFER,
    };
    // An argument holding a lone surrogate reaches the OS as Node's UTF-8
    // encoder writes it: U+FFFD.
    let args: Vec<String> = args
        .iter()
        .map(|a| js_string::lossy(a).into_owned())
        .collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let env = git_env();
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    exec_file_env("git", &args, opts, &env)
        .await
        .map_err(|e: ExecFileError| UpdaterGitError {
            message: e.message,
            stderr: e.stderr,
            exit_code: match e.code {
                ErrorCode::Exit(c) => Some(c),
                _ => None,
            },
            stdout: e.stdout,
        })
}

async fn run(args: &[&str], cwd: &str) -> Result<ExecFileOutput, UpdaterGitError> {
    git(args, cwd, DEFAULT_TIMEOUT_MS).await
}

/// `isGitCheckout(cwd)`.
pub async fn is_git_checkout(cwd: &str) -> bool {
    run(&["rev-parse", "--is-inside-work-tree"], cwd)
        .await
        .is_ok()
}

/// `currentBranch(cwd)`: `None` is the TS's `null` (a detached HEAD).
pub async fn current_branch(cwd: &str) -> Result<Option<String>, UpdaterGitError> {
    let out = run(&["rev-parse", "--abbrev-ref", "HEAD"], cwd).await?;
    let b = js::trim(&out.stdout);
    Ok((b != "HEAD").then(|| b.to_owned()))
}

/// `headSha(cwd)`.
pub async fn head_sha(cwd: &str) -> Result<String, UpdaterGitError> {
    let out = run(&["rev-parse", "HEAD"], cwd).await?;
    Ok(js::trim(&out.stdout).to_owned())
}

/// `revParse(cwd, ref)`.
pub async fn rev_parse(cwd: &str, reference: &str) -> Result<String, UpdaterGitError> {
    let out = run(&["rev-parse", reference], cwd).await?;
    Ok(js::trim(&out.stdout).to_owned())
}

/// `isAncestor(cwd, ancestor, descendant)`: `git merge-base
/// --is-ancestor`'s exit 0; every failure (including an exit 1, which is
/// its "no") is `false`.
pub async fn is_ancestor(cwd: &str, ancestor: &str, descendant: &str) -> bool {
    run(&["merge-base", "--is-ancestor", ancestor, descendant], cwd)
        .await
        .is_ok()
}

/// `isDirty(cwd)`.
pub async fn is_dirty(cwd: &str) -> Result<bool, UpdaterGitError> {
    let out = run(&["status", "--porcelain"], cwd).await?;
    Ok(!js::trim(&out.stdout).is_empty())
}

/// `fetch(cwd, remote, branch)`.
pub async fn fetch(cwd: &str, remote: &str, branch: &str) -> Result<(), UpdaterGitError> {
    git(
        &["fetch", "--quiet", "--no-tags", remote, branch],
        cwd,
        FETCH_TIMEOUT_MS,
    )
    .await
    .map(|_| ())
}

/// `AheadBehind`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AheadBehind {
    pub ahead: f64,
    pub behind: f64,
}

/// `s.split(/\s+/)`, on a string that has been trimmed first (so there are
/// no empty ends); an empty string splits into one empty piece.
fn split_whitespace(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return vec![""];
    }
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(at) = rest.find(js::is_whitespace) {
        out.push(&rest[..at]);
        let tail = &rest[at..];
        let skip = tail
            .find(|c: char| !js::is_whitespace(c))
            .unwrap_or(tail.len());
        rest = &tail[skip..];
    }
    out.push(rest);
    out
}

/// `aheadBehind(cwd, local, upstream)`: `Number(n) || 0` of the first two
/// whitespace-separated fields, each missing one counted as 0.
pub async fn ahead_behind(
    cwd: &str,
    local: &str,
    upstream: &str,
) -> Result<AheadBehind, UpdaterGitError> {
    let out = run(
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{local}...{upstream}"),
        ],
        cwd,
    )
    .await?;
    let fields = split_whitespace(js::trim(&out.stdout));
    let count = |i: usize| {
        fields
            .get(i)
            .map(|f| {
                let n = js::to_number(f);
                if n == 0.0 || n.is_nan() { 0.0 } else { n }
            })
            .unwrap_or(0.0)
    };
    Ok(AheadBehind {
        ahead: count(0),
        behind: count(1),
    })
}

/// `recentCommits(cwd, local, upstream, limit)`: the subject lines, trimmed,
/// blanks dropped; a failed `git log` is no commits at all.
pub async fn recent_commits(cwd: &str, local: &str, upstream: &str, limit: u32) -> Vec<String> {
    let range = format!("{local}..{upstream}");
    let Ok(out) = run(
        &["log", "--pretty=%s", "-n", &limit.to_string(), &range],
        cwd,
    )
    .await
    else {
        return Vec::new();
    };
    out.stdout
        .split('\n')
        .map(js::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `hasUnmergedFiles(cwd)`.
pub async fn has_unmerged_files(cwd: &str) -> Result<bool, UpdaterGitError> {
    let out = run(&["ls-files", "-u"], cwd).await?;
    Ok(!js::trim(&out.stdout).is_empty())
}

/// `/^(.*):\d+: leftover conflict marker$/`'s first group on a trimmed
/// line, when it isn't empty. `.` doesn't match a line terminator, so a
/// line with a `\r` (or U+2028 / U+2029) left in the middle never matches.
fn marker_file(line: &str) -> Option<&str> {
    let rest = line.strip_suffix(": leftover conflict marker")?;
    let digits = rest
        .as_bytes()
        .iter()
        .rev()
        .take_while(|b| b.is_ascii_digit())
        .count();
    if digits == 0 {
        return None;
    }
    let head = &rest[..rest.len() - digits];
    let path = head.strip_suffix(':')?;
    (!path.is_empty() && !path.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(path)
}

/// `conflictedFiles(cwd)`: the files `git diff --check HEAD` names as
/// carrying marker residue, sorted and deduplicated. The findings come on
/// stdout, which the non-zero exit carries on the thrown error.
pub async fn conflicted_files(cwd: &str) -> Vec<String> {
    let out = match run(&["diff", "--check", "HEAD"], cwd).await {
        Ok(out) => out.stdout,
        Err(e) => e.stdout,
    };
    let mut files: Vec<String> = Vec::new();
    for raw in out.split('\n') {
        if let Some(path) = marker_file(js::trim(raw))
            && !files.iter().any(|f| f == path)
        {
            files.push(path.to_owned());
        }
    }
    // `[...set].sort()`: by UTF-16 code unit, which for these paths is the
    // byte order of their UTF-8 (both are code-point order below U+10000,
    // and surrogate pairs sort after every BMP character either way).
    files.sort_by_key(|f| f.encode_utf16().collect::<Vec<u16>>());
    files
}

/// `hasConflicts(cwd)`: unmerged index entries, or marker residue in
/// tracked content. Any unexpected failure answers `true`.
pub async fn has_conflicts(cwd: &str) -> bool {
    match has_unmerged_files(cwd).await {
        Ok(true) => true,
        Ok(false) => !conflicted_files(cwd).await.is_empty(),
        Err(_) => true,
    }
}
