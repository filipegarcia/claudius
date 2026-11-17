//! `lib/shared/effort-wait-note.ts` (CC 2.1.312): whether the effort pill
//! shows "may wait for your next message", for a pick made mid-turn that
//! the running request doesn't carry yet.
//!
//! `effortToastText` and `EFFORT_WAIT_NOTE` are the chat surface's and the
//! session card's copy, not state.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `EffortWaitState`. `inForce` is always there (`null` when no change is
/// waiting).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortWaitState {
    /// The level the running request was sent with, kept across further
    /// changes in the same window.
    pub in_force: Option<String>,
    /// Whether the note shows.
    pub waits: bool,
    /// Whether the server reported the applied level since the latest pick.
    pub applied_seen: bool,
}

/// `NO_EFFORT_WAIT`.
pub const NO_EFFORT_WAIT: EffortWaitState = EffortWaitState {
    in_force: None,
    waits: false,
    applied_seen: false,
};

impl Default for EffortWaitState {
    fn default() -> Self {
        NO_EFFORT_WAIT
    }
}

/// `effortPicked`'s `opts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffortPick<'a> {
    /// A turn is running.
    pub pending: bool,
    pub picked: &'a str,
    /// The level the pill showed just before (applied, else the pick).
    pub shown_before: &'a str,
    /// The model takes no effort parameter.
    pub no_effort_param: bool,
}

/// `effortPicked(state, opts)`: a pick off-turn (or on a model without an
/// effort parameter) never waits; mid-turn it waits while it differs from
/// the level in force (the one from the window's first change).
pub fn effort_picked(state: &EffortWaitState, opts: EffortPick<'_>) -> EffortWaitState {
    if !opts.pending || opts.no_effort_param {
        return NO_EFFORT_WAIT;
    }
    let in_force = state
        .in_force
        .clone()
        .unwrap_or_else(|| opts.shown_before.to_owned());
    EffortWaitState {
        waits: opts.picked != in_force,
        in_force: Some(in_force),
        applied_seen: false,
    }
}

/// `effortApplied(state, applied)`: the server's `effort_applied`. `null`
/// (no effort parameter) or the level in force clears the note; anything
/// else (a non-string or absent value included) waits for the next
/// request.
pub fn effort_applied(state: &EffortWaitState, applied: Option<&Value>) -> EffortWaitState {
    let Some(in_force) = state.in_force.as_deref() else {
        return state.clone();
    };
    match applied {
        Some(Value::Null) => NO_EFFORT_WAIT,
        Some(Value::String(s)) if s == in_force => NO_EFFORT_WAIT,
        _ => EffortWaitState {
            waits: true,
            applied_seen: true,
            ..state.clone()
        },
    }
}

/// `effortRequestStarted(state)`: a new main-thread request carries the
/// pick only if the server had applied it by then.
pub fn effort_request_started(state: &EffortWaitState) -> EffortWaitState {
    if state.in_force.is_some() && state.applied_seen {
        NO_EFFORT_WAIT
    } else {
        state.clone()
    }
}
