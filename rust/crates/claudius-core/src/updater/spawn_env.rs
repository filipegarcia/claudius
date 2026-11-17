//! `lib/server/updater/spawn-env.ts`: the PATH the updater's spawns get.
//!
//! A daemon started outside a shell (Finder, launchd, Spotlight) inherits
//! the minimal kernel PATH, where bun and a homebrew git are invisible.
//! [`extended_path`] prepends every standard install dir that exists on
//! disk, in priority order, skipping the ones PATH already has.

use std::collections::HashSet;

use crate::node_path;

/// Locations relative to `$HOME`.
pub const HOME_RELATIVE: [&str; 1] = [".bun/bin"];

/// Absolute install prefixes, in priority order.
pub const ABSOLUTE_LOCATIONS: [&str; 3] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
];

/// `bunInstallCandidates(home)`: the candidate dirs, `$HOME`-expanded with
/// `path.join` (so a trailing slash or a `..` segment is normalized away).
pub fn bun_install_candidates(home: &str) -> Vec<String> {
    HOME_RELATIVE
        .iter()
        .map(|rel| node_path::join(&[home, rel]))
        .chain(ABSOLUTE_LOCATIONS.iter().map(|d| (*d).to_owned()))
        .collect()
}

/// `extendedPath(currentPath, home)`: `currentPath` with every candidate
/// dir that exists on disk and isn't already on it prepended (`:`-joined,
/// empty segments dropped). With nothing to add, `currentPath` is returned
/// as it is — empty segments and duplicates included.
pub fn extended_path(current_path: Option<&str>, home: &str) -> String {
    let current = current_path.unwrap_or("");
    let parts: Vec<&str> = current.split(':').filter(|p| !p.is_empty()).collect();
    let mut seen: HashSet<String> = parts.iter().map(|p| (*p).to_owned()).collect();
    let mut prepend: Vec<String> = Vec::new();
    for dir in bun_install_candidates(home) {
        if seen.contains(&dir) {
            continue;
        }
        // `existsSync`: follows symlinks, any file type.
        if std::fs::metadata(&dir).is_err() {
            continue;
        }
        seen.insert(dir.clone());
        prepend.push(dir);
    }
    if prepend.is_empty() {
        return current.to_owned();
    }
    prepend
        .iter()
        .map(String::as_str)
        .chain(parts)
        .collect::<Vec<_>>()
        .join(":")
}

/// `extendedPath(process.env.PATH)` for this process's `PATH` and home
/// (`withExtendedPath(process.env).PATH`).
pub fn process_extended_path() -> String {
    let path = std::env::var_os("PATH").map(|p| p.to_string_lossy().into_owned());
    extended_path(path.as_deref(), &crate::paths::home_dir().to_string_lossy())
}
