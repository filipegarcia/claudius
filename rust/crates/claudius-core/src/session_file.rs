//! Where a session's transcript is, and deleting it: the SDK's `fs` lookup
//! behind `getSessionInfo` / `getSessionMessages`, and `deleteSession`
//! (`F2e` → `T4` / `L2e`), SDK 0.3.299 without a `sessionStore`.
//!
//! - **Find** (`fs`): with a `dir`, its realpath (NFC on macOS; the text as
//!   given when that fails), then that path's project dirs (`Hn`: the exact
//!   name, the `CLAUDE_CODE_PROJECT_DIR_NAME` one, the hashed 200-char
//!   siblings holding a transcript of the same cwd), then those of every
//!   other `git worktree list` entry (`GEe`). Without one, every name in
//!   `<config>/projects`, sorted, files included. The first `<id>.jsonl`
//!   whose `stat` (through links) has a size over 0 wins, even a directory,
//!   which then reads as nothing. Its project path (the info's `cwd`
//!   fallback) is the resolved dir, or the worktree it was found under.
//! - **Delete**: the same dirs for a `dir` (the worktrees' not deduped),
//!   else every directory or symlink in `<config>/projects`. In the first
//!   one whose `<id>.jsonl` stats with a size over 0 (a missing file or a
//!   parent that isn't a directory is passed over; any other `stat` error is
//!   thrown), the file goes with `rm(…, {force})` (a directory is
//!   `ERR_FS_EISDIR`; a link is unlinked, not followed), then `<id>` with
//!   `rm(…, {recursive, force})` (Node's rimraf, a link again unlinked).
//!   Database rows and live sessions are left alone. Errors are the thrown
//!   `message`s.
//!
//! Every path is `<projects>/<name>/<id>…`, with `id` a UUID and `name` an
//! encoded cwd or a directory entry, so none leaves `<projects>` by its
//! text; each fs call still checks that it stays inside. Symlinks are
//! followed as the SDK follows them (PORT_PLAN "Mirrored TS bugs", T08a).

use std::path::{Path, PathBuf};

use crate::node_fs::{self, FsError};
use crate::node_path;
use crate::sessions_list::{self, ListEnv};
use crate::sessions_store::is_uuid;

/// A transcript [`find`] picked.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub file: PathBuf,
    /// The resolved `dir` or the worktree it was found under (`None`
    /// without a `dir`).
    pub project_path: Option<String>,
    /// Its `stat` size.
    pub size: u64,
}

/// `<projects>/` as a resolved prefix.
fn projects_base(env: &ListEnv) -> String {
    format!(
        "{}/",
        node_path::resolve(&[&env.projects.to_string_lossy()])
    )
}

/// `l(d, p)` in `fs`: `<d>/<id>.jsonl` when it stats with a size over 0.
fn probe(base: &str, dir: &Path, file_name: &str, project_path: Option<&str>) -> Option<Found> {
    let target = node_path::resolve(&[&dir.to_string_lossy(), file_name]);
    if !target.starts_with(base) {
        return None;
    }
    let meta = std::fs::metadata(&target).ok()?;
    (meta.len() > 0).then(|| Found {
        file: PathBuf::from(target),
        project_path: project_path.map(str::to_owned),
        size: meta.len(),
    })
}

/// `fs(id, dir)`: the transcript `getSessionInfo` / `getSessionMessages`
/// read. The caller has checked `session_id` is a UUID.
pub fn find(session_id: &str, dir: Option<&str>, env: &ListEnv) -> Option<Found> {
    let base = projects_base(env);
    let file_name = format!("{session_id}.jsonl");
    let Some(dir) = dir else {
        let names = sessions_list::read_dir_sorted(&env.projects)?;
        return names
            .iter()
            .find_map(|(name, _)| probe(&base, &env.projects.join(name), &file_name, None));
    };
    let d = sessions_list::resolved(dir);
    for f in sessions_list::project_dirs(&d, env) {
        if let Some(found) = probe(&base, &f, &file_name, Some(&d)) {
            return Some(found);
        }
    }
    for wt in sessions_list::git_worktrees(&d) {
        if wt == d {
            continue;
        }
        for f in sessions_list::project_dirs(&wt, env) {
            if let Some(found) = probe(&base, &f, &file_name, Some(&wt)) {
                return Some(found);
            }
        }
    }
    None
}

/// `L2e`: the project dirs a delete looks in, in order.
fn delete_dirs(dir: Option<&str>, env: &ListEnv) -> Vec<PathBuf> {
    let Some(dir) = dir else {
        let Some(entries) = sessions_list::read_dir_sorted(&env.projects) else {
            return vec![];
        };
        return entries
            .into_iter()
            .filter(|(_, e)| e.file_type().is_ok_and(|t| t.is_dir() || t.is_symlink()))
            .map(|(name, _)| env.projects.join(name))
            .collect();
    };
    let r = sessions_list::resolved(dir);
    let mut dirs = sessions_list::project_dirs(&r, env);
    for wt in sessions_list::git_worktrees(&r) {
        if wt != r {
            dirs.extend(sessions_list::project_dirs(&wt, env));
        }
    }
    dirs
}

/// `deleteSession(id, { dir })`: `Err` is the thrown error's `message`.
pub fn delete(session_id: &str, dir: Option<&str>, env: &ListEnv) -> Result<(), String> {
    if !is_uuid(session_id) {
        return Err(format!("Invalid sessionId: {session_id}"));
    }
    let base = projects_base(env);
    let file_name = format!("{session_id}.jsonl");
    for d in delete_dirs(dir, env) {
        let d = d.to_string_lossy();
        let file = node_path::resolve(&[&d, &file_name]);
        if !file.starts_with(&base) {
            continue;
        }
        match std::fs::metadata(&file) {
            Err(e) if matches!(node_fs::code(&e).as_deref(), Some("ENOENT" | "ENOTDIR")) => {
                continue;
            }
            Err(e) => return Err(FsError::new(&e, "stat", Some(&file), None).message),
            Ok(m) if m.len() == 0 => continue,
            Ok(_) => {}
        }
        node_fs::rm_force(&file).map_err(|e| e.message)?;
        let sidecar = node_path::resolve(&[&d, session_id]);
        if sidecar.starts_with(&base) {
            node_fs::rm_recursive(&sidecar, true).map_err(|e| e.message)?;
        }
        return Ok(());
    }
    Err(match dir {
        Some(d) => format!("Session {session_id} not found in project directory for {d}"),
        None => format!("Session {session_id} not found in any project directory"),
    })
}
