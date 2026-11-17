//! `lib/server/updater/git.ts`: a `git` runner aimed at the install root
//! (never a workspace cwd), with interactive prompts off and the standard
//! install dirs on `PATH`, the read-only helpers the check needs (D27a), and
//! `apply`'s pull / stash / heal helpers plus `spawnStreamed` (D27b).

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

/// `pullFastForward(cwd, remote, branch)`.
pub async fn pull_fast_forward(
    cwd: &str,
    remote: &str,
    branch: &str,
) -> Result<(), UpdaterGitError> {
    git(
        &["pull", "--ff-only", "--quiet", remote, branch],
        cwd,
        PULL_TIMEOUT_MS,
    )
    .await
    .map(|_| ())
}

/// The label every updater stash carries.
pub const UPDATER_STASH: &str = "claudius-updater-stash";

/// `stashPushIncludeUntracked(cwd, message)`: `Ok(true)` when the tree's
/// changes (tracked and untracked) went onto the stash. First, the tracked
/// part of every earlier `claudius-updater-stash` entry is put back and the
/// entry dropped (best effort), so the new stash takes it along. A clean
/// tree stashes nothing. A blocked push is retried once after
/// [`clear_in_progress_merge_state`] (non-destructive: nothing is reset
/// `--hard` or cleaned). A tree still dirty after the push stashed nothing.
pub async fn stash_push_include_untracked(
    cwd: &str,
    message: &str,
) -> Result<bool, UpdaterGitError> {
    let _ = recover_updater_stashes(cwd).await;
    if !is_dirty(cwd).await? {
        return Ok(false);
    }
    let push = ["stash", "push", "-u", "-m", message];
    if git(&push, cwd, DEFAULT_TIMEOUT_MS * 2).await.is_err() {
        clear_in_progress_merge_state(cwd).await;
        if !is_dirty(cwd).await? {
            return Ok(false);
        }
        git(&push, cwd, DEFAULT_TIMEOUT_MS * 2).await?;
    }
    Ok(!is_dirty(cwd).await?)
}

/// `clearInProgressMergeState(cwd)`: abort a merge / rebase / cherry-pick /
/// revert in progress (each a no-op that fails when there is none), then,
/// if unmerged index entries are left, a mixed `git reset --quiet`. File
/// content on disk is never touched. Never fails.
pub async fn clear_in_progress_merge_state(cwd: &str) {
    for op in ["merge", "rebase", "cherry-pick", "revert"] {
        let _ = run(&[op, "--abort"], cwd).await;
    }
    if has_unmerged_files(cwd).await.unwrap_or(false) {
        let _ = run(&["reset", "--quiet"], cwd).await;
    }
}

/// `recoverUpdaterStashes(cwd)`: for each `claudius-updater-stash` entry,
/// highest index first, `git stash apply` it and drop it. An apply that
/// exits 1 with unmerged entries left (a real conflict, or a check that
/// failed) keeps its entry; any other failed apply keeps it too, and a
/// failed drop is ignored. `Err` is a `stash list` that failed.
async fn recover_updater_stashes(cwd: &str) -> Result<(), UpdaterGitError> {
    let out = run(&["stash", "list", "--format=%gd %s"], cwd).await?;
    let mut entries: Vec<&str> = out
        .stdout
        .split('\n')
        .filter(|l| l.contains(UPDATER_STASH))
        .map(|l| l.split(' ').next().unwrap_or(""))
        .filter(|r| !r.is_empty())
        .collect();
    entries.reverse();
    for reference in entries {
        let applied = match git(&["stash", "apply", reference], cwd, DEFAULT_TIMEOUT_MS * 2).await {
            Ok(_) => true,
            // Exit 1 and nothing unmerged: the changes were already there.
            Err(e) if e.exit_code == Some(1) => !has_unmerged_files(cwd).await.unwrap_or(true),
            Err(_) => false,
        };
        if applied {
            let _ = git(&["stash", "drop", reference], cwd, DEFAULT_TIMEOUT_MS).await;
        }
    }
    Ok(())
}

/// What [`stash_pop`] answers when it doesn't fail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StashPop {
    Ok,
    /// Real merge conflicts: the entry stays on the stash.
    Conflicts {
        output: String,
    },
}

/// `stashPop(cwd)`. Exit 1 with unmerged entries (or a check that fails) is
/// a real conflict, with git's stderr (else the error's message), trimmed.
/// Exit 1 with none is the "already exists, no checkout" false conflict
/// that `recoverFalseConflictPop` repairs. Any other failure is `Err`.
pub async fn stash_pop(cwd: &str) -> Result<StashPop, UpdaterGitError> {
    match git(&["stash", "pop"], cwd, DEFAULT_TIMEOUT_MS * 2).await {
        Ok(_) => Ok(StashPop::Ok),
        Err(e) if e.exit_code == Some(1) => {
            if !has_unmerged_files(cwd).await.unwrap_or(true) {
                return Ok(recover_false_conflict_pop(cwd, &e.stderr).await);
            }
            let output = if e.stderr.is_empty() {
                &e.message
            } else {
                &e.stderr
            };
            Ok(StashPop::Conflicts {
                output: js::trim(output).to_owned(),
            })
        }
        Err(e) => Err(e),
    }
}

/// `recoverFalseConflictPop(cwd, originalOutput)`: re-apply the stash (its
/// tracked part comes back; a failed apply is fine), then, unless that left
/// unmerged entries, drop the entry.
async fn recover_false_conflict_pop(cwd: &str, original_output: &str) -> StashPop {
    let _ = git(&["stash", "apply"], cwd, DEFAULT_TIMEOUT_MS * 2).await;
    if has_unmerged_files(cwd).await.unwrap_or(false) {
        let output = if original_output.is_empty() {
            "tracked changes conflict during stash recovery".to_owned()
        } else {
            format!("{original_output}\n(tracked changes also conflicted during recovery apply)")
        };
        return StashPop::Conflicts { output };
    }
    let _ = git(&["stash", "drop"], cwd, DEFAULT_TIMEOUT_MS).await;
    StashPop::Ok
}

/// Which pipe a [`spawn_streamed`] line came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Out,
    Err,
}

impl Stream {
    /// `"out"` / `"err"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Stream::Out => "out",
            Stream::Err => "err",
        }
    }
}

/// `spawnStreamed(cmd, args, cwd, onLine, envOverrides)`: run `cmd` with
/// stdin on `/dev/null`, `{...process.env, GIT_TERMINAL_PROMPT: "0",
/// GIT_ASKPASS: "/bin/echo", PATH: extendedPath(), ...overrides}` (an
/// override of `None` deletes the variable), and hand `on_line` each line of
/// either pipe as it arrives: every 64 KiB read decoded as lossy UTF-8 on
/// its own, split on `\n` with one `\r` before it dropped. At `close` the
/// unterminated tail of stdout, then of stderr, comes as a last line. `Ok`
/// is the exit code (1 after a signal); `Err` is Node's spawn error
/// message (`spawn bun ENOENT`).
pub async fn spawn_streamed(
    cmd: &str,
    args: &[&str],
    cwd: &str,
    env: &[(&str, Option<&str>)],
    mut on_line: impl FnMut(&str, Stream),
) -> Result<i32, String> {
    // `normalizeSpawnArguments` refuses a NUL in an argument or the cwd.
    if let Some(i) = args.iter().position(|a| a.contains('\0')) {
        return Err(format!(
            "The argument 'args[{i}]' must be a string without null bytes. Received {}",
            crate::git::node_inspect_string(args[i])
        ));
    }
    let mut command = tokio::process::Command::new(cmd);
    command
        .args(args.iter().map(|a| js_string::lossy(a).into_owned()))
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (k, v) in git_env() {
        command.env(k, v);
    }
    for (k, v) in env {
        match v {
            Some(v) => command.env(k, v),
            None => command.env_remove(k),
        };
    }
    let mut child = command
        .spawn()
        .map_err(|e| crate::git::spawn_message(cmd, &e))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let (mut out_tail, mut err_tail) = (String::new(), String::new());
    let (mut out_buf, mut err_buf) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    let mut status = None;
    while stdout.is_some() || stderr.is_some() || status.is_none() {
        tokio::select! {
            r = read_some(&mut stdout, &mut out_buf), if stdout.is_some() => {
                match r {
                    Ok(n) if n > 0 => {
                        out_tail.push_str(&String::from_utf8_lossy(&out_buf[..n]));
                        flush_lines(&mut out_tail, Stream::Out, &mut on_line);
                    }
                    _ => stdout = None,
                }
            }
            r = read_some(&mut stderr, &mut err_buf), if stderr.is_some() => {
                match r {
                    Ok(n) if n > 0 => {
                        err_tail.push_str(&String::from_utf8_lossy(&err_buf[..n]));
                        flush_lines(&mut err_tail, Stream::Err, &mut on_line);
                    }
                    _ => stderr = None,
                }
            }
            s = child.wait(), if status.is_none() => status = Some(s),
        }
    }
    if !out_tail.is_empty() {
        on_line(&out_tail, Stream::Out);
    }
    if !err_tail.is_empty() {
        on_line(&err_tail, Stream::Err);
    }
    Ok(match status {
        Some(Ok(s)) => s.code().unwrap_or(1),
        _ => 1,
    })
}

/// One read from a pipe that is still open.
async fn read_some<R: tokio::io::AsyncRead + Unpin>(
    pipe: &mut Option<R>,
    buf: &mut [u8],
) -> std::io::Result<usize> {
    use tokio::io::AsyncReadExt;
    match pipe.as_mut() {
        Some(p) => p.read(buf).await,
        None => Ok(0),
    }
}

/// `buf.split(/\r?\n/)`: every complete line goes to `on_line`, the rest
/// stays in `buf`.
fn flush_lines(buf: &mut String, stream: Stream, on_line: &mut impl FnMut(&str, Stream)) {
    let Some(last) = buf.rfind('\n') else {
        return;
    };
    let tail = buf.split_off(last + 1);
    for line in buf[..last].split('\n') {
        on_line(line.strip_suffix('\r').unwrap_or(line), stream);
    }
    *buf = tail;
}
