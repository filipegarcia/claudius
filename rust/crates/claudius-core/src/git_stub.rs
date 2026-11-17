//! The SDK's guard against the macOS `git` stub (SDK 0.3.312 `PD`).
//!
//! A Mac without the developer tools still has `/usr/bin/git`, but it's the
//! `xcode-select` shim: running it pops the "install the command line
//! developer tools" dialog instead of running git. Since 0.3.312 the SDK's
//! `git worktree list` (`So`, 0.3.312 `Do`, behind `listSessions`,
//! `getSessionInfo`, `getSessionMessages` and the fork lookup) skips git
//! when `PD("git", process.env)` says that's all there is:
//!
//! - only on darwin, and only without a non-empty `DEVELOPER_DIR`;
//! - `git` resolved like the SDK does: the first absolute `PATH` entry
//!   whose `path.join(entry, "git")` exists, which must be exactly
//!   `/usr/bin/git`;
//! - and no `/Library/Developer/CommandLineTools` (`statSync`), no
//!   `/var/db/xcode_select_link` (`lstatSync`), and no `/^Xcode.*\.app$/i`
//!   entry in `/Applications`.
//!
//! Any other fs error (a stat that fails other than "not there", an
//! unreadable `/Applications`) lands in the SDK's `catch` and means "not the
//! stub", so git runs. Pinned against the SDK's own code, lifted out of
//! sdk.mjs with a fake fs, by `tests/session_messages_golden.rs`.

use std::sync::LazyLock;

use regex::Regex;

use crate::node_path;

/// What a `statSync` / `lstatSync` with `throwIfNoEntry: false` saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    /// It returned stats.
    Present,
    /// It returned `undefined` (ENOENT / ENOTDIR).
    Missing,
    /// It threw.
    Error,
}

/// The fs calls the check makes, so tests can stage them.
pub trait StubFs {
    /// `existsSync(path)`.
    fn exists(&self, path: &str) -> bool;
    /// `statSync(path, {throwIfNoEntry: false})`.
    fn stat(&self, path: &str) -> Probe;
    /// `lstatSync(path, {throwIfNoEntry: false})`.
    fn lstat(&self, path: &str) -> Probe;
    /// `readdirSync(path)`, `None` when it throws.
    fn read_dir(&self, path: &str) -> Option<Vec<String>>;
}

/// `/^Xcode.*\.app$/i`: JS `/i` without `u` folds ASCII only, and `.` stops
/// at the four JS line terminators.
static XCODE_APP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[Xx][Cc][Oo][Dd][Ee][^\n\r\x{2028}\x{2029}]*\.[Aa][Pp][Pp]$").unwrap()
});

/// `PD("git", env)` with the platform, `PATH`, `DEVELOPER_DIR` and fs given.
pub fn is_git_stub_with(
    darwin: bool,
    path: Option<&str>,
    developer_dir: Option<&str>,
    fs: &dyn StubFs,
) -> bool {
    if !darwin || developer_dir.is_some_and(|d| !d.is_empty()) {
        return false;
    }
    let git = path
        .unwrap_or("")
        .split(':')
        .filter(|entry| entry.starts_with('/'))
        .map(|entry| node_path::join(&[entry, "git"]))
        .find(|candidate| fs.exists(candidate));
    if git.as_deref() != Some("/usr/bin/git") {
        return false;
    }
    // Each `=== void 0`: stats there, or a throw, both mean "not the stub".
    if fs.stat("/Library/Developer/CommandLineTools") != Probe::Missing
        || fs.lstat("/var/db/xcode_select_link") != Probe::Missing
    {
        return false;
    }
    fs.read_dir("/Applications")
        .is_some_and(|names| !names.iter().any(|n| XCODE_APP.is_match(n)))
}

struct RealFs;

fn probe(r: std::io::Result<std::fs::Metadata>) -> Probe {
    match r {
        Ok(_) => Probe::Present,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Probe::Missing,
        Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => Probe::Missing,
        Err(_) => Probe::Error,
    }
}

impl StubFs for RealFs {
    fn exists(&self, path: &str) -> bool {
        std::fs::metadata(path).is_ok()
    }
    fn stat(&self, path: &str) -> Probe {
        probe(std::fs::metadata(path))
    }
    fn lstat(&self, path: &str) -> Probe {
        probe(std::fs::symlink_metadata(path))
    }
    fn read_dir(&self, path: &str) -> Option<Vec<String>> {
        let entries = std::fs::read_dir(path).ok()?;
        entries
            .map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect()
    }
}

/// `PD("git", process.env)` for this process: true when the only `git` is
/// the macOS developer-tools stub, so `git worktree list` must not run.
pub fn is_git_stub() -> bool {
    let var = |k: &str| std::env::var_os(k).map(|v| v.to_string_lossy().into_owned());
    is_git_stub_with(
        cfg!(target_os = "macos"),
        var("PATH").as_deref(),
        var("DEVELOPER_DIR").as_deref(),
        &RealFs,
    )
}
