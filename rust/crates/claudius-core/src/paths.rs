//! Filesystem layout shared with the TS app.
//!
//! Two roots matter and they are NOT the same thing:
//! * `~/.claude` (hard-coded `homedir()/.claude` in the TS app) — Claudius's
//!   own state: `.claudius/workspaces.json`, per-project `.claudius.db`.
//! * the Claude Code config dir (`$CLAUDE_CONFIG_DIR`, default `~/.claude`)
//!   — where the CLI writes session JSONL under `projects/`. Account
//!   profiles point this at `~/.claude/.claudius/profiles/<id>`.

use std::path::{Path, PathBuf};

static HOME_OVERRIDE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Pin `homedir()` for this process (tests, embedders). First call wins.
pub fn set_home_override(dir: PathBuf) -> bool {
    HOME_OVERRIDE.set(dir).is_ok()
}

/// `os.homedir()` — `$HOME` on Unix.
pub fn home_dir() -> PathBuf {
    if let Some(h) = HOME_OVERRIDE.get() {
        return h.clone();
    }
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// `homedir()/.claude` — Claudius state root.
pub fn claude_home() -> PathBuf {
    home_dir().join(".claude")
}

/// `~/.claude/.claudius`
pub fn claudius_root() -> PathBuf {
    claude_home().join(".claudius")
}

static CONFIG_DIR_OVERRIDE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Pin the Claude Code config dir for this process (tests). First call wins.
pub fn set_config_dir_override(dir: PathBuf) -> bool {
    CONFIG_DIR_OVERRIDE.set(dir).is_ok()
}

/// Claude Code config dir (`mt()` in the SDK).
pub fn claude_config_dir() -> PathBuf {
    if let Some(d) = CONFIG_DIR_OVERRIDE.get() {
        return d.clone();
    }
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => claude_home(),
    }
}

/// `<config>/projects` — where session JSONL lives (`ut()` in the SDK).
pub fn sdk_projects_dir() -> PathBuf {
    claude_config_dir().join("projects")
}

/// `encodeProjectDir` (lib/server/auto-memory.ts): every non-alphanumeric
/// char becomes `-`. Used for Claudius's own per-project dir (.claudius.db,
/// memory/). No length cap.
pub fn encode_project_dir(abs: &str) -> String {
    // JS regexes walk UTF-16 units: an astral char becomes two dashes, a
    // lone surrogate (a `js_string` stand-in) one.
    let mut out = String::with_capacity(abs.len());
    for c in abs.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            for _ in 0..crate::js_string::len16(c.encode_utf8(&mut [0; 4])) {
                out.push('-');
            }
        }
    }
    out
}

/// SDK `eE` — Java-style 32-bit string hash over UTF-16 code units.
fn sdk_hash(s: &str) -> i32 {
    let mut h: i32 = 0;
    for u in s.encode_utf16() {
        h = h.wrapping_shl(5).wrapping_sub(h).wrapping_add(u as i32);
    }
    h
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// SDK project-dir name (`Qc`): like [`encode_project_dir`] but names longer
/// than 200 chars are cut and suffixed with a base36 hash. Non-alnum test is
/// per UTF-16 unit in JS, so non-BMP chars become `--`.
pub fn sdk_project_dir_name(abs: &str) -> String {
    let encoded: String = abs
        .encode_utf16()
        .map(|u| {
            if (u as u32) < 128 && (u as u8).is_ascii_alphanumeric() {
                u as u8 as char
            } else {
                '-'
            }
        })
        .collect();
    if encoded.len() <= 200 {
        return encoded;
    }
    let h = (sdk_hash(abs) as i64).unsigned_abs();
    format!("{}-{}", &encoded[..200], to_base36(h))
}

/// `~/.claude/projects/<encoded>` — Claudius per-project root (`projectRoot`).
pub fn project_root(cwd: &str) -> PathBuf {
    claude_home().join("projects").join(encode_project_dir(cwd))
}

/// `~/.claude/projects/<encoded>/.claudius.db`
pub fn db_path(cwd: &str) -> PathBuf {
    project_root(cwd).join(".claudius.db")
}

/// Resolve `child` under `base` and refuse anything that escapes it.
pub fn within(base: &Path, child: &str) -> Option<PathBuf> {
    let joined = base.join(child);
    let mut out = PathBuf::new();
    for comp in joined.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out.starts_with(base).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_ts() {
        assert_eq!(encode_project_dir("/Users/a/my.proj"), "-Users-a-my-proj");
        assert_eq!(sdk_project_dir_name("/Users/a/my.proj"), "-Users-a-my-proj");
    }

    #[test]
    fn long_names_are_hashed() {
        let p = format!("/{}", "x".repeat(250));
        let name = sdk_project_dir_name(&p);
        assert!(name.starts_with(&format!("-{}", "x".repeat(199))));
        assert_eq!(name.as_bytes()[200], b'-');
    }

    #[test]
    fn within_blocks_escape() {
        let base = Path::new("/a/b");
        assert_eq!(within(base, "c/d"), Some(PathBuf::from("/a/b/c/d")));
        assert_eq!(within(base, "../x"), None);
    }
}
