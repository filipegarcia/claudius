//! `findResumedTranscriptPath` (session.ts, CC 2.1.301): the on-disk JSONL
//! a resumed session replays from, for the compaction row's "earlier
//! messages are saved in …" line.
//!
//! A resumed session replays history from its last compaction on, so the
//! turns before it live only in the engine's JSONL. The cwd's own project
//! dir is checked first (the ordinary resume), then every other project dir
//! under the base — a `/fork` resumed in its git worktree keeps its JSONL
//! under the SOURCE project's dir, so the cwd's dir alone names a file that
//! doesn't exist. `None` when no candidate exists: the row then shows
//! nothing rather than a wrong path.
//!
//! Replayed against the TS in `tests/resumed_transcript_golden.rs`.

use std::path::{MAIN_SEPARATOR, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::{node_path, paths};

/// `/^[\w-]+$/`: the id must be a plain transcript name before any fs call.
static ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w-]+$").unwrap());

/// `pathJoin(homedir(), ".claude", "projects")`, the TS default base. It is
/// the home `.claude`, not `$CLAUDE_CONFIG_DIR` (as in TS).
pub fn default_projects_base() -> PathBuf {
    paths::home_dir().join(".claude").join("projects")
}

/// `findResumedTranscriptPath(id, cwd, projectsBase)`. Blocking: the caller
/// runs it off the session lock.
pub fn find_resumed_transcript_path(id: &str, cwd: &str, projects_base: &str) -> Option<String> {
    // The TS regex has no `u` flag, so `\w` is ASCII `[A-Za-z0-9_]`.
    if !ID_RE.is_match(id) || !id.is_ascii() {
        return None;
    }
    let base = node_path::resolve(&[projects_base]);
    let own = paths::encode_project_dir(cwd);
    let own_file = node_path::resolve(&[&base, &own, &format!("{id}.jsonl")]);
    if own_file.starts_with(&format!("{base}{MAIN_SEPARATOR}"))
        && std::fs::metadata(&own_file).is_ok_and(|m| m.is_file())
    {
        return Some(own_file);
    }
    // `readdir(base, { withFileTypes: true })` filtered by `d.isDirectory()`:
    // the entry's own type, so a symlink to a directory is skipped. The
    // cwd's own dir is skipped too (already tried above).
    let dirs = crate::node_fs::readdir_dirents(&base).ok()?;
    for (name, kind) in dirs {
        if name == own || !kind.is_dir() {
            continue;
        }
        let file = node_path::resolve(&[&base, &name, &format!("{id}.jsonl")]);
        if !file.starts_with(&format!("{base}{MAIN_SEPARATOR}")) {
            continue;
        }
        if std::fs::metadata(&file).is_ok_and(|m| m.is_file()) {
            return Some(file);
        }
    }
    None
}

/// `resumedTranscriptPath()`'s display form: the found file with the home
/// shortened to `~`. Never read or written through.
pub fn display_path(file: &str) -> String {
    let home = paths::home_dir().to_string_lossy().into_owned();
    if file.starts_with(&format!("{home}{MAIN_SEPARATOR}")) {
        format!("~{}", &file[home.len()..])
    } else {
        file.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(base: &std::path::Path, dir: &str, name: &str) -> PathBuf {
        let d = base.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join(name);
        std::fs::write(&f, "{}\n").unwrap();
        f
    }

    #[test]
    fn the_cwd_s_own_project_dir_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let cwd = "/Users/x/proj";
        let own = paths::encode_project_dir(cwd);
        let want = seed(&base, &own, "abc-1.jsonl");
        // A same-named transcript elsewhere must not be preferred.
        seed(&base, "-Users-x-other", "abc-1.jsonl");
        assert_eq!(
            find_resumed_transcript_path("abc-1", cwd, &base.display().to_string()),
            Some(want.display().to_string())
        );
    }

    #[test]
    fn another_project_dir_is_the_fork_in_a_worktree_case() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let want = seed(&base, "-Users-x-source", "fork1.jsonl");
        std::fs::create_dir_all(base.join(paths::encode_project_dir("/Users/x/wt"))).unwrap();
        assert_eq!(
            find_resumed_transcript_path("fork1", "/Users/x/wt", &base.display().to_string()),
            Some(want.display().to_string())
        );
    }

    #[test]
    fn a_missing_file_bad_id_or_base_reports_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        seed(&base, "-a", "ok.jsonl");
        let b = base.display().to_string();
        assert_eq!(find_resumed_transcript_path("gone", "/a", &b), None);
        // Names the regex refuses, before any fs call.
        for id in ["../ok", "a/b", "", "a.b", "a b", "\u{e9}"] {
            assert_eq!(find_resumed_transcript_path(id, "/a", &b), None, "{id:?}");
        }
        // A base that isn't a directory.
        assert_eq!(find_resumed_transcript_path("ok", "/a", "/dev/null"), None);
    }

    #[test]
    fn a_plain_file_in_the_base_is_not_descended_into() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        std::fs::write(base.join("loose.jsonl"), "{}").unwrap();
        assert_eq!(
            find_resumed_transcript_path("loose", "/a", &base.display().to_string()),
            None
        );
    }

    #[test]
    fn the_display_form_shortens_the_home() {
        let home = paths::home_dir().to_string_lossy().into_owned();
        assert_eq!(
            display_path(&format!("{home}/.claude/projects/-x/a.jsonl")),
            "~/.claude/projects/-x/a.jsonl"
        );
        assert_eq!(display_path("/elsewhere/a.jsonl"), "/elsewhere/a.jsonl");
        // The home itself isn't a prefix match (TS needs the separator).
        assert_eq!(display_path(&home), home);
    }
}
