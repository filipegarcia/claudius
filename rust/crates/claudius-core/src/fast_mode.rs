//! The server half of `lib/shared/fast-mode.ts` (CC 2.1.300).
//!
//! `fastModeDisabledReasonLabel` is display copy the client owns, so only
//! the credits-rejected notice is ported here: on a credit-exhaustion
//! rejection the engine retries that one request without fast mode and
//! emits this `system/notification`, but leaves the session's fast flag on,
//! so every later request would be refused and re-sent. The host has to
//! turn it off (`Session::broadcast`, where TS's `broadcast()` does it).

use serde_json::Value;

/// `FAST_MODE_CREDITS_REJECTED_KEY`: the `system/notification` key the
/// engine bundled with SDK 0.3.300 emits when fast mode is refused because
/// usage credits ran out (`out_of_credits`, `org_spend_cap_reached`,
/// `org_level_disabled_until`). Older engines never send it.
pub const FAST_MODE_CREDITS_REJECTED_KEY: &str = "fast-mode-overage-rejected";

/// `isFastModeCreditsRejectedNotice(msg)`: a `system` / `notification`
/// message whose `key` is [`FAST_MODE_CREDITS_REJECTED_KEY`].
pub fn is_fast_mode_credits_rejected_notice(msg: &Value) -> bool {
    // `!msg || typeof msg !== "object"`: an array is an object in JS and
    // has none of these fields, so it falls out on the first test.
    if !(msg.is_object() || msg.is_array()) {
        return false;
    }
    let s = |k: &str| msg.get(k).and_then(Value::as_str);
    s("type") == Some("system")
        && s("subtype") == Some("notification")
        && s("key") == Some(FAST_MODE_CREDITS_REJECTED_KEY)
}

/// The `broadcast()` side: an `sdk` event whose `message` is the notice.
/// Every `sdk` event goes through there, live or from `dev-broadcast`.
pub fn is_credits_rejected_event(ev: &Value) -> bool {
    ev.get("type").and_then(Value::as_str) == Some("sdk")
        && ev
            .get("message")
            .is_some_and(is_fast_mode_credits_rejected_notice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_credits_notice_reports() {
        assert!(is_fast_mode_credits_rejected_notice(&json!({
            "type": "system", "subtype": "notification",
            "key": "fast-mode-overage-rejected", "text": "out of credits",
        })));
        assert!(!is_fast_mode_credits_rejected_notice(&json!({
            "type": "system", "subtype": "notification", "key": "other",
        })));
        assert!(!is_fast_mode_credits_rejected_notice(&json!({
            "type": "system", "subtype": "init", "key": "fast-mode-overage-rejected",
        })));
        assert!(!is_fast_mode_credits_rejected_notice(&json!({
            "type": "result", "subtype": "notification", "key": "fast-mode-overage-rejected",
        })));
    }

    #[test]
    fn only_an_sdk_event_carries_it() {
        let notice = json!({"type": "system", "subtype": "notification",
                            "key": "fast-mode-overage-rejected"});
        assert!(is_credits_rejected_event(
            &json!({"type": "sdk", "message": notice})
        ));
        assert!(!is_credits_rejected_event(
            &json!({"type": "status", "message": notice})
        ));
        assert!(!is_credits_rejected_event(&json!({"type": "sdk"})));
        assert!(!is_credits_rejected_event(&notice));
    }

    #[test]
    fn odd_shapes_report_nothing() {
        for v in [
            json!(null),
            json!("fast-mode-overage-rejected"),
            json!(5),
            json!(true),
            json!([]),
            json!({}),
        ] {
            assert!(!is_fast_mode_credits_rejected_notice(&v), "{v}");
        }
    }
}
