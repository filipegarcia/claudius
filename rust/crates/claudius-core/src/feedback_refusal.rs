//! `lib/shared/feedback-refusal.ts` (CC 2.1.309): what the feedback
//! survey's forward (`Session::submit_feedback`, the CLI's
//! `submit_feedback` control request) resolved with, and the display-safe
//! refusal reason the banner shows.
//!
//! The CLI answers a refusal (an organization that doesn't accept feedback)
//! as a *successful* control response, `{feedback_id: null,
//! unavailable_reason, failure_reason?}`, so the reply has to be read:
//! [`interpret_feedback_response`]. The reason goes through
//! [`feedback_refusal_reason`]: ANSI escapes stripped (hook-ask's
//! `stripAnsi`, [`crate::hook_ask::strip_ansi`]), C0 / DEL / C1 runs
//! and JS whitespace runs collapsed to one space, the CLI's trailing "Report
//! issues at <url>" pointer dropped, JS `trim`, then capped at 200 code
//! points (199 and `…`). The regexes are ported by hand. Replayed against
//! the TS in `tests/feedback_golden.rs`.

use claudius_agent::js;
use serde_json::Value;

use crate::hook_ask::strip_ansi;

/// `FEEDBACK_REASON_MAX`: the reason's cap, in code points.
pub const FEEDBACK_REASON_MAX: usize = 200;

/// `FeedbackForwardResult`: whether the CLI took the feedback and, when it
/// refused, the reason to show. `reason` is only ever set with `forwarded:
/// false`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedbackForward {
    pub forwarded: bool,
    pub reason: Option<String>,
}

impl FeedbackForward {
    fn sent() -> FeedbackForward {
        FeedbackForward {
            forwarded: true,
            reason: None,
        }
    }

    /// `JSON.stringify` of the TS result: `{forwarded}` or `{forwarded,
    /// reason}`.
    pub fn to_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("forwarded".into(), Value::Bool(self.forwarded));
        if let Some(r) = &self.reason {
            m.insert("reason".into(), Value::String(r.clone()));
        }
        Value::Object(m)
    }
}

/// `interpretFeedbackResponse(res)`, `res` being the control response's
/// `response` (`Null` for both `null` and `undefined`):
/// - not an object (an array is one, but has none of the fields): sent;
/// - a non-empty string `feedback_id`: sent;
/// - an `unavailable_reason` that isn't `null`: refused, with its reason if
///   one survives [`feedback_refusal_reason`];
/// - a `failure_reason` that isn't `null`: not sent, no reason;
/// - anything else: sent.
pub fn interpret_feedback_response(res: &Value) -> FeedbackForward {
    let Value::Object(r) = res else {
        return FeedbackForward::sent();
    };
    if matches!(r.get("feedback_id"), Some(Value::String(id)) if !id.is_empty()) {
        return FeedbackForward::sent();
    }
    if let Some(v) = r.get("unavailable_reason").filter(|v| !v.is_null()) {
        return FeedbackForward {
            forwarded: false,
            reason: feedback_refusal_reason(v),
        };
    }
    if r.get("failure_reason").is_some_and(|v| !v.is_null()) {
        return FeedbackForward {
            forwarded: false,
            reason: None,
        };
    }
    FeedbackForward::sent()
}

/// `feedbackRefusalReason(err)`: an object with an own `message` gives its
/// `message`; then only a string has a reason (see [`sanitize_reason`]).
pub fn feedback_refusal_reason(err: &Value) -> Option<String> {
    let raw = match err {
        Value::Object(o) if o.contains_key("message") => &o["message"],
        v => v,
    };
    match raw {
        Value::String(s) => sanitize_reason(s),
        _ => None,
    }
}

/// The string half of `feedbackRefusalReason`: `None` when nothing is left.
pub fn sanitize_reason(raw: &str) -> Option<String> {
    let stripped = strip_ansi(raw);
    // `.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")`
    let controls = collapse(&stripped, |c| {
        c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c)
    });
    // `.replace(/\s+/g, " ")`
    let spaced = collapse(&controls, js::is_whitespace);
    let cut = strip_report_pointer(&spaced);
    let clean = js::trim(cut);
    if clean.is_empty() {
        return None;
    }
    // `Array.from(clean)`: code points.
    if clean.chars().count() > FEEDBACK_REASON_MAX {
        let mut out: String = clean.chars().take(FEEDBACK_REASON_MAX - 1).collect();
        out.push('\u{2026}');
        Some(out)
    } else {
        Some(clean.to_owned())
    }
}

/// Every run of chars matching `is` becomes one space.
fn collapse(s: &str, is: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if is(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `.replace(/\s*Report (?:issues|bugs) at \S+\s*$/i, "")` on text whose
/// whitespace runs are already single spaces: the match has to end the
/// string, so its `\S+` is the last word, right after `Report issues at ` /
/// `Report bugs at ` (ASCII case-insensitive: without the `u` flag no other
/// letter canonicalizes to these), and the leftmost start takes the space
/// before `Report` too.
fn strip_report_pointer(s: &str) -> &str {
    let body = s.strip_suffix(' ').unwrap_or(s);
    let word = body.rfind(' ').map_or(0, |i| i + 1);
    if word == body.len() {
        return s;
    }
    let head = &body[..word];
    for lead in ["report issues at ", "report bugs at "] {
        let Some(at) = head.len().checked_sub(lead.len()) else {
            continue;
        };
        if head.is_char_boundary(at) && head[at..].eq_ignore_ascii_case(lead) {
            let start = if head[..at].ends_with(' ') {
                at - 1
            } else {
                at
            };
            return &s[..start];
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_reply() {
        let r = |v: Value| interpret_feedback_response(&v).to_json().to_string();
        assert_eq!(r(json!({"feedback_id": "fb_1"})), r#"{"forwarded":true}"#);
        assert_eq!(
            r(
                json!({"feedback_id": null, "unavailable_reason": "Not accepted. Report bugs at https://x"})
            ),
            r#"{"forwarded":false,"reason":"Not accepted."}"#
        );
        assert_eq!(
            r(json!({"failure_reason": "http_error"})),
            r#"{"forwarded":false}"#
        );
        assert_eq!(r(json!([1])), r#"{"forwarded":true}"#);
        assert_eq!(r(Value::Null), r#"{"forwarded":true}"#);
    }

    #[test]
    fn strips_escapes_and_caps() {
        // The escapes go before the collapse (`hook_ask::strip_ansi`).
        assert_eq!(
            sanitize_reason("\u{1b}[1;31mNot\u{1b}[0m \u{1b}]8;;u\u{7}accepted\u{1b}]8;;\u{1b}\\"),
            Some("Not accepted".to_owned())
        );
        let long = "a".repeat(250);
        let got = sanitize_reason(&long).unwrap();
        assert_eq!(got.chars().count(), FEEDBACK_REASON_MAX);
        assert!(got.ends_with('\u{2026}'));
        assert_eq!(sanitize_reason(" \u{0}\t "), None);
    }
}
