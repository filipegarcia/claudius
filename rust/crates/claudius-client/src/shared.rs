//! The small `lib/shared` reads the hook makes, most of them the server's
//! ports re-exported (each pinned against the TS on the client path by
//! `tests/client_modules_golden.rs`):
//!
//! - `system-informational.ts` `classifyInformationalLevel`;
//! - `hook-events.ts` `hookEventGetsDurablePill`;
//! - `fast-mode.ts` `isFastModeCreditsRejectedNotice` (server port);
//! - `advisor.ts` `ADVISOR_ACTIVE_SENTINEL`;
//! - `cost-pricing.ts` `costFromTokens` (server port);
//! - `parse-tasklist-result.ts` `parseTaskListResult` (server port; its
//!   rows feed `blocks::coerce_todos`).
//!
//! `fastModeDisabledReasonLabel` and the rest of `advisor.ts` and
//! `hook-events.ts` are display copy and the settings editors', not state.

pub use claudius_core::cost_pricing::{TokenBreakdown, cost_from_tokens};
pub use claudius_core::fast_mode::is_fast_mode_credits_rejected_notice;
pub use claudius_core::todos::parse_task_list_result;

/// `ADVISOR_ACTIVE_SENTINEL`: the advisor model the hook shows when the
/// init's tools have the advisor but no model id is known ("on, model
/// unknown"). Never sent to the server.
pub const ADVISOR_ACTIVE_SENTINEL: &str = "(active)";

/// `InformationalLevel`: the pill tones of a `system/informational`.
pub const INFORMATIONAL_LEVELS: [&str; 3] = ["notice", "suggestion", "warning"];

/// `classifyInformationalLevel(level)`: `(hidden, infoLevel)`. `info` is
/// transcript-only upstream, so hidden; `notice` / `suggestion` /
/// `warning` tone the pill; anything else (absent, unknown, a non-string)
/// shows untoned.
pub fn classify_informational_level(level: Option<&str>) -> (bool, Option<&'static str>) {
    match level {
        Some("info") => (true, None),
        Some(l) => (
            false,
            INFORMATIONAL_LEVELS.iter().copied().find(|k| *k == l),
        ),
        None => (false, None),
    }
}

/// `HOOK_PILL_EVENTS`: the one-time lifecycle hooks whose completion always
/// gets a durable pill.
pub const HOOK_PILL_EVENTS: [&str; 4] = ["SessionStart", "Setup", "SubagentStart", "SessionEnd"];

/// `hookEventGetsDurablePill(event, failed)`: a failed hook, or a lifecycle
/// one.
pub fn hook_event_gets_durable_pill(event: &str, failed: bool) -> bool {
    failed || HOOK_PILL_EVENTS.contains(&event)
}
