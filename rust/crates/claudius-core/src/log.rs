//! `tracing` targets that mirror the TS server's console tags, so the same
//! diagnostics can be switched on in either backend. Every message keeps the
//! TS tag text (`[sess-load] subscribe`, `[api/sessions] …`), so logs from
//! both backends grep the same way.
//!
//! | TS tag                          | target                 | level         |
//! |---------------------------------|------------------------|---------------|
//! | `[sess-load] …`                 | [`SESS_LOAD`]          | debug         |
//! | `[session] …`, `[session.<m>]`  | [`SESSION`]            | warn / error  |
//! | `[api/…]`, `[input]`            | [`API`]                | warn / error  |
//! | `[scheduler] …`                 | [`SCHEDULER`]          | error         |
//!
//! TS prints `[sess-load]` only when `CLAUDIUS_DEBUG_SESSIONS` is set
//! (`sessLoadDebug()`). The server's filter does the same: that variable adds
//! `claudius::sess_load=debug` on top of `RUST_LOG` or the default
//! (`claudius_server::logging`).

/// TS `[sess-load]`: session start / resume / subscribe / resync tracing.
pub const SESS_LOAD: &str = "claudius::sess_load";
/// TS `[session]` / `[session.<method>]`: session engine warnings and errors.
pub const SESSION: &str = "claudius::session";
/// TS `[api/…]` and `[input]`: route-handler warnings and errors.
pub const API: &str = "claudius::api";
/// TS `[scheduler]`: a scheduled job that failed to fire or re-arm.
pub const SCHEDULER: &str = "claudius::scheduler";

/// `!!process.env.CLAUDIUS_DEBUG_SESSIONS`: any non-empty value (even `0`).
pub fn debug_sessions_enabled(value: Option<&str>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_sessions_is_js_truthy() {
        assert!(!debug_sessions_enabled(None));
        assert!(!debug_sessions_enabled(Some("")));
        for on in ["1", "true", "0", "false", "yes"] {
            assert!(
                debug_sessions_enabled(Some(on)),
                "{on:?} is a non-empty string"
            );
        }
    }
}
