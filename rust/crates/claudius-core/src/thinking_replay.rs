//! `lib/server/thinking-replay-recovery.ts`: detecting the API 400 for a
//! modified `thinking` / `redacted_thinking` block and planning the in-place
//! rewind that gets a wedged session past it.
//!
//! Once a streamed turn that mixes adaptive thinking with parallel or server
//! tool calls is reassembled wrongly, it sits at the conversation tail and
//! every later prompt replays it into the same 400. The session drops that
//! turn by resuming at the assistant message before the prompt that started
//! it, then re-sends the prompt.

use serde_json::Value;

use crate::user_prompt::extract_user_prompt_text;

/// `isThinkingReplayErrorText`: the stable wording of the 400, not its
/// `messages.N.content.M` prefix.
pub fn is_thinking_replay_error_text(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("thinking")
        && t.contains("cannot be modified")
        && (t.contains("redacted_thinking") || t.contains("latest assistant message"))
}

/// `extractMessageText`: a string `content` as is, else the concatenated
/// text of its `text` blocks; `""` for anything else.
pub fn extract_message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    }
}

/// `thinkingReplayErrorFrom`: the error text when an `assistant` record is
/// the synthetic "API Error: …" message carrying the 400.
pub fn thinking_replay_error_from(sdk_message: &Value) -> Option<String> {
    if sdk_message.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let text = sdk_message
        .get("message")
        .map(extract_message_text)
        .unwrap_or_default();
    // TS also requires `text` non-empty, which the wording test implies.
    is_thinking_replay_error_text(&text).then_some(text)
}

/// `ThinkingReplayRecoveryPlan`.
#[derive(Clone, Debug, PartialEq)]
pub struct RecoveryPlan {
    /// The assistant uuid to resume at (`resumeSessionAt`): everything after
    /// it, the poisoned turn included, is dropped.
    pub resume_at: String,
    /// The prompt that started the poisoned turn, to re-send.
    pub replay_prompt: String,
    /// That prompt's `uuid`, as the record has it.
    pub replay_prompt_uuid: Option<Value>,
}

fn is_assistant(m: &Value) -> bool {
    m.get("type").and_then(Value::as_str) == Some("assistant")
}

fn content(m: &Value) -> Option<&Value> {
    m.get("message").and_then(|msg| msg.get("content"))
}

/// `assistantHasThinking`.
fn has_thinking(m: &Value) -> bool {
    content(m).and_then(Value::as_array).is_some_and(|blocks| {
        blocks.iter().any(|b| {
            matches!(
                b.get("type").and_then(Value::as_str),
                Some("thinking" | "redacted_thinking")
            )
        })
    })
}

/// `planThinkingReplayRecovery(messages)` over the transcript (oldest
/// first):
/// 1. the anchor is the latest assistant record with a thinking block, else
///    the latest assistant record;
/// 2. the prompt is the last real user prompt before it
///    ([`extract_user_prompt_text`]);
/// 3. resume at the last assistant record with a uuid before that prompt.
///
/// `None` when any step finds nothing: there is no safe point to resume at.
pub fn plan_thinking_replay_recovery(messages: &[Value]) -> Option<RecoveryPlan> {
    let anchor = messages
        .iter()
        .rposition(|m| is_assistant(m) && has_thinking(m))
        .or_else(|| messages.iter().rposition(is_assistant))?;
    let (prompt_idx, replay_prompt) = messages[..anchor]
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, m)| m.get("type").and_then(Value::as_str) == Some("user"))
        .find_map(|(i, m)| extract_user_prompt_text(content(m)).map(|t| (i, t)))?;
    // `m.uuid` is truthy; the CLI writes it as a string.
    let resume_at = messages[..prompt_idx].iter().rev().find_map(|m| {
        is_assistant(m)
            .then(|| m.get("uuid").and_then(Value::as_str))
            .flatten()
            .filter(|u| !u.is_empty())
    })?;
    Some(RecoveryPlan {
        resume_at: resume_at.to_owned(),
        replay_prompt,
        replay_prompt_uuid: messages[prompt_idx].get("uuid").cloned(),
    })
}
