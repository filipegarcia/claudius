//! `lib/shared/hook-ask.ts` (CC 2.1.301): what the permission prompt shows
//! about an ask a PreToolUse hook raised. The engine hands `canUseTool` the
//! hook's own reason as `decisionReason`, tagged `decisionReasonType:
//! "hook"`; this marks the ask as a hook's and cleans the reason for
//! display. It never feeds a permission decision.
//!
//! The module also owns [`strip_ansi`], as hook-ask.ts owns `stripAnsi`:
//! `dangerous_rm_deny` and `feedback_refusal` import it from here, as
//! dangerous-rm-deny.ts and feedback-refusal.ts import it from hook-ask.ts.
//!
//! Replayed against the TS in `tests/session_callbacks_golden.rs` (and,
//! through its two importers, in `tests/cc2309_golden.rs` and
//! `tests/feedback_golden.rs`).

use serde_json::{Map, Value, json};

use claudius_agent::js;

use crate::js_string;

/// `HOOK_ASK_REASON_MAX`, in UTF-16 code units (TS compares `.length`).
pub const HOOK_ASK_REASON_MAX: usize = 600;

/// `stripAnsi(text)`: `text.replace(ANSI_RE, "")` with
/// `/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g`
/// (CSI sequences such as colours and cursor moves, OSC sequences such as
/// titles and links ended by BEL or ST, and the two-character escapes),
/// ported by hand.
pub fn strip_ansi(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\u{1b}'
            && let Some(end) = ansi_end(&chars, i)
        {
            i = end;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Where an `ANSI_RE` match starting at the ESC at `i` ends, trying the
/// alternatives in order. The classes of each are disjoint, so the greedy
/// runs never need to give anything back.
fn ansi_end(c: &[char], i: usize) -> Option<usize> {
    let at = |j: usize| c.get(j).copied();
    if at(i + 1) == Some('[') {
        let mut j = i + 2;
        while matches!(at(j), Some('0'..='?')) {
            j += 1;
        }
        while matches!(at(j), Some(' '..='/')) {
            j += 1;
        }
        if matches!(at(j), Some('@'..='~')) {
            return Some(j + 1);
        }
    }
    if at(i + 1) == Some(']') {
        let mut j = i + 2;
        while at(j).is_some_and(|ch| ch != '\u{7}' && ch != '\u{1b}') {
            j += 1;
        }
        match at(j) {
            Some('\u{7}') => return Some(j + 1),
            Some('\u{1b}') if at(j + 1) == Some('\\') => return Some(j + 2),
            _ => {}
        }
    }
    matches!(at(i + 1), Some('@'..='Z' | '\\'..='_')).then_some(i + 2)
}

/// `hookAsk(decisionReason, decisionReasonType)`: `{ reason? }` when a hook
/// raised this ask, else `None`. A hook may answer `ask` without a reason —
/// the ask was still a hook's, so the object is present and only `reason`
/// is absent.
pub fn hook_ask(
    decision_reason: Option<&str>,
    decision_reason_type: Option<&str>,
) -> Option<Value> {
    if decision_reason_type != Some("hook") {
        return None;
    }
    let stripped = strip_ansi(decision_reason.unwrap_or(""));
    let clean = js::trim(&stripped);
    if clean.is_empty() {
        return Some(Value::Object(Map::new()));
    }
    let units = js_string::units(clean);
    let reason = if units.len() > HOOK_ASK_REASON_MAX {
        format!(
            "{}\u{2026}",
            js_string::from_units(&units[..HOOK_ASK_REASON_MAX - 1])
        )
    } else {
        clean.to_owned()
    };
    Some(json!({ "reason": reason }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_hook_type_reports() {
        assert_eq!(hook_ask(Some("why"), None), None);
        assert_eq!(hook_ask(Some("why"), Some("rule")), None);
        assert_eq!(
            hook_ask(Some("why"), Some("hook")),
            Some(json!({"reason": "why"}))
        );
    }

    #[test]
    fn a_reasonless_hook_still_reports() {
        assert_eq!(hook_ask(None, Some("hook")), Some(json!({})));
        assert_eq!(hook_ask(Some("   "), Some("hook")), Some(json!({})));
        // Only escapes: nothing left after the strip.
        assert_eq!(hook_ask(Some("\u{1b}[31m"), Some("hook")), Some(json!({})));
    }

    #[test]
    fn ansi_is_stripped_and_the_text_trimmed() {
        assert_eq!(
            hook_ask(Some("\u{1b}[31m deny me \u{1b}[0m"), Some("hook")),
            Some(json!({"reason": "deny me"}))
        );
        assert_eq!(strip_ansi("\u{1b}]8;;http://x\u{7}link"), "link");
        assert_eq!(strip_ansi("a\u{1b}Mb"), "ab");
    }

    #[test]
    fn strip_ansi_follows_ansi_re() {
        assert_eq!(strip_ansi("\u{1b}[1;31mred\u{1b}[0m"), "red");
        assert_eq!(strip_ansi("\u{1b}]8;;u\u{7}l\u{1b}]8;;\u{1b}\\"), "l");
        // An OSC without its BEL / ST: only the two-character `ESC ]` goes.
        assert_eq!(strip_ansi("\u{1b}]x\u{1b}y"), "x\u{1b}y");
        // A CSI with no final byte isn't one; the `ESC M` after it is.
        assert_eq!(strip_ansi("\u{1b}[\u{1b}M"), "\u{1b}[");
    }

    #[test]
    fn strip_ansi_takes_each_class_to_its_edges() {
        // CSI: parameters 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E.
        assert_eq!(strip_ansi("a\u{1b}[?25lb"), "ab");
        assert_eq!(strip_ansi("a\u{1b}[1 qb"), "ab");
        assert_eq!(strip_ansi("a\u{1b}[0/@b"), "ab");
        assert_eq!(strip_ansi("a\u{1b}[2~b"), "ab");
        // Two-character escapes: 0x40-0x5A and 0x5C-0x5F, not `[` or 0x60.
        assert_eq!(strip_ansi("a\u{1b}@\u{1b}Z\u{1b}\\\u{1b}_b"), "ab");
        assert_eq!(strip_ansi("a\u{1b}`b"), "a\u{1b}`b");
    }

    #[test]
    fn a_long_reason_is_capped_with_an_ellipsis() {
        let long = "x".repeat(700);
        let got = hook_ask(Some(&long), Some("hook")).unwrap();
        let reason = got["reason"].as_str().unwrap();
        assert_eq!(js_string::len16(reason), HOOK_ASK_REASON_MAX);
        assert!(reason.ends_with('\u{2026}'));
        // Exactly at the cap: kept whole.
        let at_cap = "y".repeat(HOOK_ASK_REASON_MAX);
        assert_eq!(
            hook_ask(Some(&at_cap), Some("hook")).unwrap()["reason"],
            json!(at_cap)
        );
    }
}
