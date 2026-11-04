//! The directory the running Claudius serves from, the "live source" a
//! customization's mirror is compared with: port of
//! `lib/server/runtime-dir.ts`.

use std::sync::OnceLock;

use claudius_agent::js;

static CACHED: OnceLock<String> = OnceLock::new();

/// `getLiveSourceDir()`: `$CLAUDIUS_LIVE_SOURCE` (JS-trimmed) when that is
/// non-empty, else the process cwd, read once and kept for the process.
pub fn live_source_dir() -> String {
    CACHED
        .get_or_init(|| {
            let over =
                std::env::var_os("CLAUDIUS_LIVE_SOURCE").map(|v| v.to_string_lossy().into_owned());
            live_source_dir_for(over.as_deref(), || {
                std::env::current_dir()
                    .map(|d| d.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
        })
        .clone()
}

/// What [`live_source_dir`] picks for an env value and a cwd.
pub fn live_source_dir_for(over: Option<&str>, cwd: impl FnOnce() -> String) -> String {
    match over.map(js::trim) {
        Some(o) if !o.is_empty() => o.to_owned(),
        _ => cwd(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_override_is_trimmed_like_js() {
        let cwd = || "/cwd".to_owned();
        assert_eq!(live_source_dir_for(None, cwd), "/cwd");
        assert_eq!(live_source_dir_for(Some(""), cwd), "/cwd");
        assert_eq!(
            live_source_dir_for(Some(" \t\u{feff}\u{3000}"), cwd),
            "/cwd"
        );
        assert_eq!(live_source_dir_for(Some(" /live\t"), cwd), "/live");
        assert_eq!(live_source_dir_for(Some("\u{85}/x"), cwd), "\u{85}/x");
    }
}
