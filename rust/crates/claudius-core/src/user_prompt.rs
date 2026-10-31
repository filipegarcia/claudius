//! Port of `lib/shared/user-prompt.ts` — deciding which `user` SDK messages
//! are real human prompts (vs. tool results, CLI plumbing, reminders).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

pub const COMPACT_SUMMARY_PREFIX: &str =
    "This session is being continued from a previous conversation";

static TASK_NOTIFICATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*<task-notification[\s>]").unwrap());
static CLI_PLUMBING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)[\s>]").unwrap()
});
static GOAL_REMINDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*<session-goal>[\s\S]*?</session-goal>\s*").unwrap());
static SYSTEM_REMINDER_LEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*<system-reminder>([\s\S]*?)</system-reminder>\s*").unwrap());

fn is_task_notification(t: &str) -> bool {
    TASK_NOTIFICATION.is_match(t)
}
fn is_compact_summary(t: &str) -> bool {
    t.trim_start().starts_with(COMPACT_SUMMARY_PREFIX)
}
fn is_cli_plumbing(t: &str) -> bool {
    CLI_PLUMBING.is_match(t)
}

pub fn strip_goal_reminder(text: &str) -> String {
    GOAL_REMINDER.replace(text, "").into_owned()
}

pub fn split_leading_system_reminders(text: &str) -> (Vec<String>, String) {
    let mut reminders = Vec::new();
    let mut rest = text.to_owned();
    while let Some(c) = SYSTEM_REMINDER_LEADING.captures(&rest) {
        reminders.push(c[1].trim().to_owned());
        let end = c.get(0).unwrap().end();
        rest = rest[end..].to_owned();
    }
    (reminders, rest)
}

pub fn strip_system_reminders(text: &str) -> String {
    split_leading_system_reminders(text).1
}

fn strip_leading_reminders(text: &str) -> String {
    strip_system_reminders(&strip_goal_reminder(text))
}

fn classify(text: &str) -> Option<String> {
    if text.is_empty()
        || is_task_notification(text)
        || is_compact_summary(text)
        || is_cli_plumbing(text)
    {
        return None;
    }
    let stripped = strip_leading_reminders(text);
    (!stripped.is_empty()).then_some(stripped)
}

/// `extractUserPromptText`.
pub fn extract_user_prompt_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(s) => classify(s),
        Value::Array(blocks) => {
            let mut text = String::new();
            for b in blocks {
                if b.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(t) = b.get("text").and_then(Value::as_str)
                {
                    text.push_str(t);
                }
            }
            classify(&text)
        }
        _ => None,
    }
}

pub fn is_real_user_prompt(content: Option<&Value>) -> bool {
    extract_user_prompt_text(content).is_some()
}

/// `isAnchorableUserPrompt` — real prompts plus image-only turns.
pub fn is_anchorable_user_prompt(content: Option<&Value>) -> bool {
    if extract_user_prompt_text(content).is_some() {
        return true;
    }
    let Some(Value::Array(blocks)) = content else {
        return false;
    };
    let mut has_image = false;
    for b in blocks {
        match b.get("type").and_then(Value::as_str) {
            Some("tool_result") => return false,
            Some("image") => has_image = true,
            _ => {}
        }
    }
    has_image
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_prompts() {
        assert_eq!(
            extract_user_prompt_text(Some(&json!("hi"))).as_deref(),
            Some("hi")
        );
        assert_eq!(
            extract_user_prompt_text(Some(&json!("<command-name>/x</command-name>"))),
            None
        );
        assert_eq!(
            extract_user_prompt_text(Some(&json!(
                "<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>real"
            )))
            .as_deref(),
            Some("real")
        );
        assert_eq!(
            extract_user_prompt_text(Some(&json!("<session-goal>g</session-goal>\n\nask")))
                .as_deref(),
            Some("ask")
        );
        assert!(!is_anchorable_user_prompt(Some(
            &json!([{"type":"tool_result","content":"x"}])
        )));
        assert!(is_anchorable_user_prompt(Some(
            &json!([{"type":"image","source":{}}])
        )));
    }
}
