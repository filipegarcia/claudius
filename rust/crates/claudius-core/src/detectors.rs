//! The session's one-shot nudges and the detectors behind them:
//! `lib/server/opus-overload-detector.ts`, `long-context-credits-detector.ts`,
//! `auth-failed-detector.ts` and `token-expiry.ts`, plus session.ts's
//! `noteOverloadObservation`, `noteLongContextCreditsObservation`,
//! `noteAuthFailedObservation` and `noteTokenExpiringAtStartup` with the
//! `consume()` lines that feed them ([`Nudges`]).
//!
//! Each nudge fires at most once per session object. The overload streak
//! counts at most one signal per turn, clears on a successful `result`, and
//! fires only for an Opus model once it reaches
//! [`OPUS_OVERLOAD_NUDGE_THRESHOLD`].

use serde_json::{Value, json};

use crate::thinking_replay::extract_message_text;

/// `OPUS_OVERLOAD_NUDGE_THRESHOLD`: overloaded turns in a row that trip the
/// nudge.
pub const OPUS_OVERLOAD_NUDGE_THRESHOLD: u64 = 2;

/// `TOKEN_EXPIRY_WARNING_WINDOW_MS`: three days.
pub const TOKEN_EXPIRY_WARNING_WINDOW_MS: f64 = 3.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// `extractAssistantText(m.message)`: a string `content` as is, else its
/// `text` blocks joined; `""` when `message` is missing.
fn assistant_text(m: &Value) -> String {
    m.get("message")
        .map(extract_message_text)
        .unwrap_or_default()
}

fn is_assistant(m: &Value) -> bool {
    m.get("type").and_then(Value::as_str) == Some("assistant")
}

/// `isOverloadErrorText`: "overloaded" anywhere, or a `529` next to
/// "api error" / "status" (a bare `529` can be a uuid fragment).
pub fn is_overload_error_text(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("overloaded")
        || (t.contains("529") && (t.contains("api error") || t.contains("status")))
}

/// `isOverloadSignal`: an assistant message whose text is the overload, or
/// an `error_during_execution` result with an overload among its string
/// `errors`. A `success` result with `api_error_status: 529` (the SDK's
/// fallback rescued the turn) doesn't count.
pub fn is_overload_signal(m: &Value) -> bool {
    if is_assistant(m) {
        return is_overload_error_text(&assistant_text(m));
    }
    m.get("type").and_then(Value::as_str) == Some("result")
        && m.get("subtype").and_then(Value::as_str) == Some("error_during_execution")
        && m.get("errors")
            .and_then(Value::as_array)
            .is_some_and(|errs| {
                errs.iter()
                    .filter_map(Value::as_str)
                    .any(is_overload_error_text)
            })
}

/// `isOpusModelId`: the lowercased id contains "opus".
pub fn is_opus_model_id(model: Option<&str>) -> bool {
    model.is_some_and(|m| m.to_lowercase().contains("opus"))
}

/// `isBillingErrorSignal`: an assistant message tagged
/// `error: "billing_error"`.
pub fn is_billing_error_signal(m: &Value) -> bool {
    is_assistant(m) && m.get("error").and_then(Value::as_str) == Some("billing_error")
}

/// `isAuthFailedErrorText`: "failed to authenticate", or a `401` / `403`
/// next to "authenticat".
pub fn is_auth_failed_error_text(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("failed to authenticate")
        || ((t.contains("401") || t.contains("403")) && t.contains("authenticat"))
}

/// `isAuthFailedSignal`: an assistant message tagged
/// `authentication_failed` / `cloud_credential_error`, or whose text is an
/// authentication failure. `oauth_org_not_allowed` isn't one.
pub fn is_auth_failed_signal(m: &Value) -> bool {
    if !is_assistant(m) {
        return false;
    }
    matches!(
        m.get("error").and_then(Value::as_str),
        Some("authentication_failed" | "cloud_credential_error")
    ) || is_auth_failed_error_text(&assistant_text(m))
}

/// `isOAuthRevokedText`: "oauth token revoked", any case.
pub fn is_oauth_revoked_text(text: &str) -> bool {
    text.to_lowercase().contains("oauth token revoked")
}

/// `isOAuthRevokedSignal`: [`is_oauth_revoked_text`] over an assistant
/// message's text.
pub fn is_oauth_revoked_signal(m: &Value) -> bool {
    is_assistant(m) && is_oauth_revoked_text(&assistant_text(m))
}

/// `shouldWarnTokenExpiring(expiresAt, now)`: an expiry that is still
/// ahead, by at most [`TOKEN_EXPIRY_WARNING_WINDOW_MS`]. `None` is any
/// non-number. TS also requires a finite expiry, which the range test
/// implies: a non-finite one leaves `remaining` NaN or infinite.
pub fn should_warn_token_expiring(expires_at: Option<f64>, now: f64) -> bool {
    expires_at.is_some_and(|at| {
        let remaining = at - now;
        remaining > 0.0 && remaining <= TOKEN_EXPIRY_WARNING_WINDOW_MS
    })
}

/// What `consume()` reads off one live SDK message for the nudges.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Observed {
    /// [`is_overload_signal`].
    pub overload: bool,
    /// [`is_billing_error_signal`].
    pub billing_error: bool,
    /// [`is_auth_failed_signal`].
    pub auth_failed: bool,
    /// [`is_oauth_revoked_signal`].
    pub oauth_revoked: bool,
    /// A `result` (the turn boundary): `Some(subtype == "success")`.
    pub result: Option<bool>,
}

impl Observed {
    pub fn of(m: &Value) -> Observed {
        Observed {
            overload: is_overload_signal(m),
            billing_error: is_billing_error_signal(m),
            auth_failed: is_auth_failed_signal(m),
            oauth_revoked: is_oauth_revoked_signal(m),
            result: (m.get("type").and_then(Value::as_str) == Some("result"))
                .then(|| m.get("subtype").and_then(Value::as_str) == Some("success")),
        }
    }
}

/// The nudges' per-session state, named as the `Session` fields. Each
/// method returns the events to broadcast, in order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Nudges {
    /// `opusOverloadStreak`: overloaded turns since the last success.
    pub opus_overload_streak: u64,
    /// `opusOverloadNudgeFired`.
    pub opus_overload_nudge_fired: bool,
    /// `opusOverloadCountedThisTurn`: a turn's assistant 529 and its
    /// `error_during_execution` result count once.
    pub opus_overload_counted_this_turn: bool,
    /// `longContextCreditsNudgeFired`.
    pub long_context_credits_nudge_fired: bool,
    /// `authFailedNudgeFired`.
    pub auth_failed_nudge_fired: bool,
    /// `tokenExpiringNudgeFired`: set by the first check, warning or not.
    pub token_expiring_nudge_fired: bool,
}

impl Nudges {
    /// `noteOverloadObservation(isOverload)` with `this.model`.
    pub fn note_overload_observation(
        &mut self,
        is_overload: bool,
        model: Option<&str>,
    ) -> Option<Value> {
        if !is_overload || self.opus_overload_counted_this_turn {
            return None;
        }
        self.opus_overload_counted_this_turn = true;
        self.opus_overload_streak += 1;
        if self.opus_overload_nudge_fired
            || !is_opus_model_id(model)
            || self.opus_overload_streak < OPUS_OVERLOAD_NUDGE_THRESHOLD
        {
            return None;
        }
        self.opus_overload_nudge_fired = true;
        Some(json!({
            "type": "opus_overload_nudge",
            "model": model.unwrap_or(""),
            "count": self.opus_overload_streak,
        }))
    }

    /// `noteLongContextCreditsObservation(isBillingError)`: only on a
    /// session with the 1M-context beta on.
    pub fn note_long_context_credits_observation(
        &mut self,
        is_billing_error: bool,
        enable_1m_context: bool,
        model: Option<&str>,
    ) -> Option<Value> {
        if !is_billing_error || self.long_context_credits_nudge_fired || !enable_1m_context {
            return None;
        }
        self.long_context_credits_nudge_fired = true;
        Some(json!({"type": "long_context_credits_required", "model": model.unwrap_or("")}))
    }

    /// `noteAuthFailedObservation(isAuthFailed, oauthRevoked)`.
    pub fn note_auth_failed_observation(
        &mut self,
        is_auth_failed: bool,
        oauth_revoked: bool,
        model: Option<&str>,
    ) -> Option<Value> {
        if !is_auth_failed || self.auth_failed_nudge_fired {
            return None;
        }
        self.auth_failed_nudge_fired = true;
        let mut ev = json!({"type": "auth_failed_required", "model": model.unwrap_or("")});
        if oauth_revoked {
            ev["reason"] = json!("oauth_revoked");
        }
        Some(ev)
    }

    /// `noteTokenExpiringAtStartup()`, on the first live `system/init`, with
    /// `activeProfileExpiresAt` and `Date.now()`.
    pub fn note_token_expiring_at_startup(
        &mut self,
        expires_at: Option<f64>,
        now: f64,
    ) -> Option<Value> {
        if std::mem::replace(&mut self.token_expiring_nudge_fired, true)
            || !should_warn_token_expiring(expires_at, now)
        {
            return None;
        }
        let at = expires_at?;
        Some(json!({"type": "token_expiring_required", "expiresAt": crate::js_num(at)}))
    }

    /// `consume()` on a live message, after its `sdk` broadcast: the
    /// overload, long-context and auth notes, then the `result` branch's
    /// resets (a success clears the streak; any result ends the turn).
    pub fn observe(
        &mut self,
        o: Observed,
        model: Option<&str>,
        enable_1m_context: bool,
    ) -> Vec<Value> {
        let evs = [
            self.note_overload_observation(o.overload, model),
            self.note_long_context_credits_observation(o.billing_error, enable_1m_context, model),
            self.note_auth_failed_observation(o.auth_failed, o.oauth_revoked, model),
        ];
        if let Some(success) = o.result {
            if success {
                self.opus_overload_streak = 0;
            }
            self.opus_overload_counted_this_turn = false;
        }
        evs.into_iter().flatten().collect()
    }

    /// `consume()`'s catch, after the `error` broadcast: the thrown message
    /// through the overload and auth text tests.
    pub fn observe_thrown(&mut self, message: &str, model: Option<&str>) -> Vec<Value> {
        let evs = [
            self.note_overload_observation(is_overload_error_text(message), model),
            self.note_auth_failed_observation(
                is_auth_failed_error_text(message),
                is_oauth_revoked_text(message),
                model,
            ),
        ];
        evs.into_iter().flatten().collect()
    }
}
