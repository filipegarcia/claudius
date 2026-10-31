//! `lib/shared/tcc-protected.ts`, server half: the macOS TCC ("Transparency,
//! Consent, and Control") folders the directory picker gates behind its own
//! heads-up (`fs/dirs`) and the `@`-mention walk won't cross into
//! ([`crate::fs_list`]), and the `~/Library` container folders both hide.
//!
//! Every check takes the platform explicitly, like the TS (`process.platform`
//! there, [`PLATFORM`] here); off macOS they are no-ops. Comparisons are on
//! the exact strings, case included, as in TS.

/// Node's `process.platform` for this build (`darwin`, `linux`, `win32`, …).
pub fn platform() -> &'static str {
    claudius_agent::binary::node_platform(std::env::consts::OS)
}

/// `CATEGORY_DIRS`: the folders whose first read surfaces a TCC dialog.
pub const CATEGORY_DIRS: [&str; 6] = [
    "Desktop",
    "Documents",
    "Downloads",
    "Movies",
    "Music",
    "Pictures",
];

/// `HIDDEN_HOME_SUBPATHS`, relative to the home (forward slashes).
pub const HIDDEN_HOME_SUBPATHS: [&str; 2] = ["Library/Containers", "Library/Group Containers"];

/// `categorizeTccPath(absPath, home, platform)`: the category whose folder
/// `abs_path` is, or sits under, strictly below `home`; `None` for `home`
/// itself, anything outside it, an empty input, or off macOS.
pub fn categorize_tcc_path(abs_path: &str, home: &str, platform: &str) -> Option<&'static str> {
    if platform != "darwin" || abs_path.is_empty() || home.is_empty() {
        return None;
    }
    let norm_home = home.strip_suffix('/').unwrap_or(home);
    let tail = abs_path.strip_prefix(norm_home)?.strip_prefix('/')?;
    let first = tail.split('/').next().unwrap_or("");
    if first.is_empty() {
        return None;
    }
    CATEGORY_DIRS.into_iter().find(|c| *c == first)
}

/// `isHiddenHomeSubpath(relFromHome, platform)`: `Library/Containers` or
/// `Library/Group Containers`, or anything below them, on macOS.
pub fn is_hidden_home_subpath(rel_from_home: &str, platform: &str) -> bool {
    if platform != "darwin" || rel_from_home.is_empty() {
        return false;
    }
    let norm = rel_from_home.replace('\\', "/");
    HIDDEN_HOME_SUBPATHS.iter().any(|hidden| {
        norm == *hidden
            || norm
                .strip_prefix(hidden)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ts_doc_examples() {
        let me = "/Users/me";
        assert_eq!(
            categorize_tcc_path("/Users/me/Desktop", me, "darwin"),
            Some("Desktop")
        );
        assert_eq!(
            categorize_tcc_path("/Users/me/Desktop/foo/bar", me, "darwin"),
            Some("Desktop")
        );
        assert_eq!(
            categorize_tcc_path("/Users/me/Projects/x", me, "darwin"),
            None
        );
        assert_eq!(categorize_tcc_path("/Users/me/Desktop", me, "linux"), None);
        assert_eq!(
            categorize_tcc_path("/Users/me", "/Users/me/", "darwin"),
            None
        );
        assert!(is_hidden_home_subpath("Library/Containers", "darwin"));
        assert!(is_hidden_home_subpath(
            "Library\\Group Containers\\x",
            "darwin"
        ));
        assert!(!is_hidden_home_subpath("Library/ContainersX", "darwin"));
        assert!(!is_hidden_home_subpath("Library/Containers", "linux"));
    }
}
