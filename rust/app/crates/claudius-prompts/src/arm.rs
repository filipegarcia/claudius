//! The two focus / keystroke guards every card shares.
//!
//! - `lib/client/prompt-arm.ts` (CC 2.1.318): a keystroke within
//!   [`PROMPT_ARM_GRACE_MS`] of a prompt appearing was meant for something
//!   else, so Escape doesn't answer a prompt the user never saw.
//! - `lib/client/typing-focus.ts` (CC 2.1.299): a prompt that appears while
//!   the user is mid-draft doesn't take focus.

/// `PROMPT_ARM_GRACE_MS` (prompt-arm.ts:13).
pub const PROMPT_ARM_GRACE_MS: f64 = 400.0;

/// `isBeforePromptArmed(eventTimeStamp, armedAt)` (prompt-arm.ts:21): a
/// keystroke at `event_ms` is too soon after the prompt armed at
/// `armed_at` (same clock); not armed yet counts as too soon.
pub fn is_before_prompt_armed(event_ms: f64, armed_at: Option<f64>) -> bool {
    match armed_at {
        None => true,
        Some(at) => event_ms - at < PROMPT_ARM_GRACE_MS,
    }
}

/// `isTypingInField(el)` (typing-focus.ts:35) for the native app: the
/// focused element is a text field holding non-whitespace text (`value`
/// is its text, `None` when the focus isn't a text field). An empty field
/// isn't mid-draft.
pub fn is_typing_in_field(value: Option<&str>) -> bool {
    value.is_some_and(|v| !claudius_agent::js::trim(v).is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_before_prompt_armed_holds_the_grace_window() {
        assert!(is_before_prompt_armed(0.0, None));
        assert!(is_before_prompt_armed(1_399.9, Some(1_000.0)));
        assert!(!is_before_prompt_armed(1_400.0, Some(1_000.0)));
        assert!(!is_before_prompt_armed(9_000.0, Some(1_000.0)));
        // A keystroke stamped before the arm (a queued event) is too soon.
        assert!(is_before_prompt_armed(900.0, Some(1_000.0)));
    }

    #[test]
    fn is_typing_in_field_needs_non_whitespace_text() {
        assert!(!is_typing_in_field(None));
        assert!(!is_typing_in_field(Some("")));
        assert!(!is_typing_in_field(Some(" \n\t\u{feff}")));
        assert!(is_typing_in_field(Some(" x ")));
    }
}
