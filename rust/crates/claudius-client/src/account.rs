//! U01n: `moveToActiveAccount` and `effortChangeWouldWait`, split from
//! U01i's status actions.
//!
//! - `moveToActiveAccount()` changes no state. Its outcome is the promise's
//!   value (`{ ok: true }` / `{ ok: false, error }`), which comes back as an
//!   [`Effect::ActionResolved`] (the crate's promise-outcome convention, see
//!   `effect.rs`): at once without a bound session, else once the POST
//!   settles. The server restarts the query under the same id, so the
//!   stream reconnects and its fresh `ready` updates `account`.
//! - `effortChangeWouldWait(level)` is a pure read: whether picking `level`
//!   now would show the "may wait" note (`nextEffortWait(level).waits`).

use serde_json::{Value, json};

use crate::apply::Cx;
use crate::effect::{Action, Effect, FetchOutcome};
use crate::env::ClientEnv;
use crate::state::{ChatState, Then};
use crate::text::prop;

/// `err instanceof Error ? err.message : String(err)` for a rejected
/// `fetch`: [`FetchOutcome::Failed`] holds `<name>: <message>`.
pub(crate) fn error_message(text: &str) -> &str {
    text.split_once(": ").map_or(text, |(_, message)| message)
}

/// The `{ ok: false, error }` of an action whose non-2xx reply reads
/// `body.error ?? "HTTP <status>"` off `res.json().catch(() => ({}))`. A
/// `null` body throws on `.error` inside the `try`, so the `catch` gives
/// V8's message.
pub(crate) fn http_error(status: u16, body: Option<&Value>) -> Value {
    match body {
        Some(Value::Null) => json!({
            "ok": false,
            "error": "Cannot read properties of null (reading 'error')",
        }),
        _ => {
            let error = match prop(body, "error") {
                None | Some(Value::Null) => json!(format!("HTTP {status}")),
                Some(e) => e.clone(),
            };
            json!({ "ok": false, "error": error })
        }
    }
}

impl ChatState {
    /// `moveToActiveAccount()`: re-pin this session to the active account
    /// profile (`POST /api/sessions/{id}/account`, no body).
    pub fn move_to_active_account(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            cx.out.push(account_moved(
                json!({ "ok": false, "error": "no active session" }),
            ));
            return cx.out;
        };
        self.fetch(
            &mut cx,
            "POST",
            format!("/api/sessions/{id}/account"),
            Vec::new(),
            None,
            Then::Account,
        );
        cx.out
    }

    /// The account POST settled: a 2xx is `{ ok: true }` (its body unread),
    /// a non-2xx the server's `error`, a network failure its message.
    pub(crate) fn account_settled(&mut self, outcome: &FetchOutcome, cx: &mut Cx<'_>) {
        let value = match outcome {
            FetchOutcome::Failed(e) => json!({ "ok": false, "error": error_message(e) }),
            FetchOutcome::Response { status, .. } if !outcome.ok() => {
                http_error(*status, Some(&outcome.json().unwrap_or_else(|| json!({}))))
            }
            FetchOutcome::Response { .. } => json!({ "ok": true }),
        };
        cx.out.push(account_moved(value));
    }

    /// `effortChangeWouldWait(level)`: whether picking `level` now would
    /// show the "may wait" note. No session is needed; nothing changes.
    pub fn effort_change_would_wait(&self, level: &str) -> bool {
        self.next_effort_wait(level).waits
    }
}

fn account_moved(outcome: Value) -> Effect {
    Effect::ActionResolved {
        action: Action::MoveToActiveAccount,
        outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;
    use crate::effort_wait::EffortWaitState;

    fn moved(outcome: Value) -> Vec<Effect> {
        vec![account_moved(outcome)]
    }

    fn post(s: &mut ChatState, env: &mut FixedEnv) -> crate::effect::FetchId {
        let fx = s.move_to_active_account(env);
        let [Effect::Fetch(req)] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        assert_eq!(
            (req.method, req.url.as_str()),
            ("POST", "/api/sessions/s/account")
        );
        assert!(req.headers.is_empty() && req.body.is_none());
        req.id
    }

    #[test]
    fn a_move_needs_a_truthy_session() {
        let mut env = FixedEnv::new(1.0);
        for id in [None, Some(String::new())] {
            let mut s = ChatState::new("tab-1");
            s.session_id = id;
            let before = s.clone();
            assert_eq!(
                s.move_to_active_account(&mut env),
                moved(json!({ "ok": false, "error": "no active session" }))
            );
            assert_eq!(s, before);
        }
    }

    #[test]
    fn a_move_resolves_with_the_reply() {
        let mut env = FixedEnv::new(1.0);
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("s".into());
        let before = s.snapshot();
        let reply = |status: u16, body: &str| FetchOutcome::Response {
            status,
            body: body.into(),
        };
        for (outcome, want) in [
            (reply(200, "not json"), json!({ "ok": true })),
            (reply(204, ""), json!({ "ok": true })),
            (
                reply(400, r#"{"error":"no active account profile configured"}"#),
                json!({ "ok": false, "error": "no active account profile configured" }),
            ),
            (
                reply(500, "oops"),
                json!({ "ok": false, "error": "HTTP 500" }),
            ),
            (
                reply(404, r#"{"error":null}"#),
                json!({ "ok": false, "error": "HTTP 404" }),
            ),
            (
                reply(409, r#"{"error":5}"#),
                json!({ "ok": false, "error": 5 }),
            ),
            (reply(409, "7"), json!({ "ok": false, "error": "HTTP 409" })),
            (
                reply(502, "null"),
                json!({ "ok": false, "error": "Cannot read properties of null (reading 'error')" }),
            ),
            (
                FetchOutcome::Failed("TypeError: Failed to fetch".into()),
                json!({ "ok": false, "error": "Failed to fetch" }),
            ),
            (
                FetchOutcome::Failed("offline".into()),
                json!({ "ok": false, "error": "offline" }),
            ),
        ] {
            let id = post(&mut s, &mut env);
            assert_eq!(s.fetch_settled(id, outcome, &mut env), moved(want));
            assert_eq!(s.snapshot(), before, "no state changes");
        }
    }

    #[test]
    fn would_wait_reads_the_pick_without_changing_anything() {
        let mut s = ChatState::new("tab-1");
        // Idle: a pick never waits.
        assert!(!s.effort_change_would_wait("high"));
        s.pending = true;
        // Mid-turn, against the shown pick (`auto`), with no session bound.
        assert!(s.effort_change_would_wait("high"));
        assert!(!s.effort_change_would_wait("auto"));
        // Against the applied level when there is one.
        s.applied_effort = Some(json!("high"));
        assert!(!s.effort_change_would_wait("high"));
        assert!(s.effort_change_would_wait("auto"));
        // A model without an effort parameter never waits.
        s.applied_effort = Some(Value::Null);
        assert!(!s.effort_change_would_wait("max"));
        // The level in force from an earlier pick wins over the shown one.
        s.applied_effort = None;
        s.effort_wait = EffortWaitState {
            in_force: Some("low".into()),
            waits: true,
            applied_seen: true,
        };
        assert!(!s.effort_change_would_wait("low"));
        assert!(s.effort_change_would_wait("auto"));
        let before = s.clone();
        s.effort_change_would_wait("max");
        assert_eq!(s, before);
    }
}
