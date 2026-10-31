//! Log filter for the `claudius` binary (`tracing-subscriber` `EnvFilter`).
//!
//! * `RUST_LOG` wins when set, else [`DEFAULT_FILTER`]. A `claudius` directive
//!   is a string-prefix match, so it covers `claudius_core`,
//!   `claudius_server`, `claudius_agent` and the `claudius::*` targets of
//!   `claudius_core::log`.
//! * `CLAUDIUS_DEBUG_SESSIONS` (any non-empty value, like TS's
//!   `sessLoadDebug()`) adds `claudius::sess_load=debug`, which turns on the
//!   `[sess-load]` diagnostics without touching anything else.
//!
//! Recipes are in PORT_PLAN.md (*Logging*).

use claudius_core::log;

/// What the server logs with no `RUST_LOG`: info and above from every
/// Claudius crate and target.
pub const DEFAULT_FILTER: &str = "claudius=info";

/// The `EnvFilter` directive string for these env values.
pub fn filter_directives(rust_log: Option<&str>, debug_sessions: Option<&str>) -> String {
    let base = rust_log
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_FILTER);
    if log::debug_sessions_enabled(debug_sessions) {
        format!("{base},{}=debug", log::SESS_LOAD)
    } else {
        base.to_owned()
    }
}

/// Install the global subscriber (stdout; ANSI colours only on a terminal,
/// so logs captured by Electron or redirected to a file stay plain text).
pub fn init() {
    use std::io::IsTerminal;
    let rust_log = std::env::var("RUST_LOG").ok();
    let debug = std::env::var("CLAUDIUS_DEBUG_SESSIONS").ok();
    let filter = tracing_subscriber::EnvFilter::try_new(filter_directives(
        rust_log.as_deref(),
        debug.as_deref(),
    ))
    .unwrap_or_else(|e| {
        eprintln!("claudius: ignoring invalid RUST_LOG ({e})");
        tracing_subscriber::EnvFilter::new(filter_directives(None, debug.as_deref()))
    });
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(std::io::stdout().is_terminal())
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::EnvFilter;

    #[test]
    fn directives() {
        assert_eq!(filter_directives(None, None), "claudius=info");
        assert_eq!(filter_directives(Some("  "), None), "claudius=info");
        assert_eq!(filter_directives(Some("warn"), None), "warn");
        assert_eq!(
            filter_directives(None, Some("1")),
            "claudius=info,claudius::sess_load=debug"
        );
        assert_eq!(
            filter_directives(Some("claudius_agent=debug"), Some("0")),
            "claudius_agent=debug,claudius::sess_load=debug",
            "any non-empty value enables it, like `!!process.env.X`"
        );
        assert_eq!(filter_directives(None, Some("")), "claudius=info");
        for d in [
            filter_directives(None, None),
            filter_directives(None, Some("1")),
        ] {
            EnvFilter::try_new(&d).unwrap_or_else(|e| panic!("{d}: {e}"));
        }
    }
}
