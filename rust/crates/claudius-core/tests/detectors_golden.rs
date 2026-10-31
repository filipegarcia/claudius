//! Nudge detector parity (S20): the detectors and the session's note methods
//! replayed against what the TS returned (`rust/scripts/detectors-golden.mjs`):
//! `opus-overload-detector.ts`, `long-context-credits-detector.ts`,
//! `auth-failed-detector.ts`, `token-expiry.ts`, and the real
//! `Session.prototype.note*` methods driven the way `consume()` and
//! `broadcast()` call them.

use std::sync::OnceLock;

use claudius_agent::js;
use claudius_core::detectors::{
    Nudges, OPUS_OVERLOAD_NUDGE_THRESHOLD, Observed, TOKEN_EXPIRY_WARNING_WINDOW_MS,
    is_auth_failed_error_text, is_auth_failed_signal, is_billing_error_signal,
    is_oauth_revoked_signal, is_oauth_revoked_text, is_opus_model_id, is_overload_error_text,
    is_overload_signal, should_warn_token_expiring,
};
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("fixtures/detectors_golden.json")).unwrap())
}

fn cases(key: &str, min: usize) -> &'static [Value] {
    let v = fixture()[key].as_array().unwrap();
    assert!(v.len() >= min, "{key}: {}", v.len());
    v
}

/// A recorded JS value as the `number` the Rust side takes: a number, or
/// `{"$num": …}` for one JSON can't hold; anything else (`undefined`, a
/// string, …) is no number.
fn number(v: &Value) -> Option<f64> {
    if let Some(s) = v.get("$num").and_then(Value::as_str) {
        return Some(match s {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            _ => panic!("$num {s}"),
        });
    }
    v.as_f64()
}

#[test]
fn constants_match() {
    let c = &fixture()["constants"];
    assert_eq!(
        json!(OPUS_OVERLOAD_NUDGE_THRESHOLD),
        c["OPUS_OVERLOAD_NUDGE_THRESHOLD"]
    );
    assert_eq!(
        TOKEN_EXPIRY_WARNING_WINDOW_MS,
        c["TOKEN_EXPIRY_WARNING_WINDOW_MS"].as_f64().unwrap()
    );
}

#[test]
fn error_texts_match() {
    let mut hits = [0; 3];
    for c in cases("texts", 60) {
        let text = c["text"].as_str().unwrap();
        let got = [
            is_overload_error_text(text),
            is_auth_failed_error_text(text),
            is_oauth_revoked_text(text),
        ];
        let want =
            [&c["overload"], &c["authFailed"], &c["oauthRevoked"]].map(|v| v.as_bool().unwrap());
        assert_eq!(got, want, "{text:?}");
        for (h, w) in hits.iter_mut().zip(want) {
            *h += usize::from(w);
        }
    }
    assert!(hits.iter().all(|&h| h >= 5), "{hits:?}");
}

#[test]
fn model_ids_match() {
    for c in cases("models", 15) {
        let model = c.get("model").and_then(Value::as_str);
        assert_eq!(
            is_opus_model_id(model),
            c["opus"].as_bool().unwrap(),
            "{model:?}"
        );
    }
}

#[test]
fn message_signals_match() {
    let mut hits = [0; 4];
    for c in cases("messages", 70) {
        let m = &c["message"];
        let got = [
            is_overload_signal(m),
            is_billing_error_signal(m),
            is_auth_failed_signal(m),
            is_oauth_revoked_signal(m),
        ];
        let want = [
            &c["overload"],
            &c["billingError"],
            &c["authFailed"],
            &c["oauthRevoked"],
        ]
        .map(|v| v.as_bool().unwrap());
        assert_eq!(got, want, "{m}");
        let o = Observed::of(m);
        assert_eq!(
            [o.overload, o.billing_error, o.auth_failed, o.oauth_revoked],
            want,
            "{m}"
        );
        for (h, w) in hits.iter_mut().zip(want) {
            *h += usize::from(w);
        }
    }
    assert!(hits.iter().all(|&h| h >= 3), "{hits:?}");
}

#[test]
fn token_expiry_matches() {
    let mut warned = 0;
    for c in cases("expiry", 40) {
        let want = c["warn"].as_bool().unwrap();
        warned += usize::from(want);
        let now = number(&c["now"]).unwrap();
        assert_eq!(
            should_warn_token_expiring(number(&c["expiresAt"]), now),
            want,
            "{c}"
        );
    }
    assert!(warned >= 8, "{warned}");
}

/// The fields the recorder reads back after each step, in its names.
fn state_json(n: &Nudges) -> Value {
    json!({
        "opusOverloadStreak": n.opus_overload_streak,
        "opusOverloadNudgeFired": n.opus_overload_nudge_fired,
        "opusOverloadCountedThisTurn": n.opus_overload_counted_this_turn,
        "longContextCreditsNudgeFired": n.long_context_credits_nudge_fired,
        "authFailedNudgeFired": n.auth_failed_nudge_fired,
        "tokenExpiringNudgeFired": n.token_expiring_nudge_fired,
    })
}

/// `broadcast()`'s test for the live init that runs the token check.
fn is_init(m: &Value) -> bool {
    m.get("type").and_then(Value::as_str) == Some("system")
        && m.get("subtype").and_then(Value::as_str) == Some("init")
}

#[test]
fn sessions_match() {
    let (mut steps, mut fired) = (0, 0);
    for c in cases("sessions", 45) {
        let name = c["name"].as_str().unwrap();
        let mut model = c.get("model").and_then(Value::as_str).map(str::to_owned);
        let enable_1m = c.get("enable1mContext") == Some(&json!(true));
        let expires_at = number(&c["expiresAt"]);
        let mut n = Nudges::default();
        for (i, step) in c["steps"].as_array().unwrap().iter().enumerate() {
            let now = step
                .get("clock")
                .and_then(Value::as_f64)
                .unwrap_or(1_761_500_000_000.0);
            let mut events = vec![];
            if let Some(m) = step.get("live") {
                if is_init(m) {
                    events.extend(n.note_token_expiring_at_startup(expires_at, now));
                }
                events.extend(n.observe(Observed::of(m), model.as_deref(), enable_1m));
            } else if step.get("replay").is_some() {
                // A replayed init runs no check (`!this.isReplayingTranscript`).
            } else if let Some(t) = step.get("thrown") {
                events.extend(n.observe_thrown(t.as_str().unwrap(), model.as_deref()));
            } else {
                model = step["model"].as_str().map(str::to_owned);
            }
            let got: Vec<String> = events.iter().map(js::stringify).collect();
            let want: Vec<&str> = step["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e.as_str().unwrap())
                .collect();
            assert_eq!(got, want, "{name} step {i}");
            assert_eq!(state_json(&n), step["state"], "{name} step {i}: state");
            steps += 1;
            fired += want.len();
        }
    }
    assert!(steps >= 140 && fired >= 35, "{steps} steps, {fired} nudges");
}
