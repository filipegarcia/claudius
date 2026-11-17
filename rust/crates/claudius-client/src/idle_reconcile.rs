//! `lib/client/idle-reconcile.ts`: the turn-end sweeps that clear the
//! "still running" markers whose own close event never came (an
//! interrupt, an aborted stream, a parallel subagent's missing
//! `tool_result`), and the live thinking-token estimate.
//!
//! Each helper changes the list in place and returns whether it did (the
//! TS returns the same array when nothing changed).

use serde::{Deserialize, Serialize};

use crate::types::{DisplayMessage, num};

/// `ToolHistoryEntry["kind"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolHistoryKind {
    Tool,
    Thinking,
}

/// `ToolHistoryEntry`: one row of the activity rail's Tools section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHistoryEntry {
    pub tool_use_id: String,
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_arg: Option<String>,
    #[serde(with = "num")]
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub ended_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_run: Option<bool>,
    /// Absent on a thinking row, `null` (`Some(None)`) on a main-thread
    /// tool, else the parent Task's tool_use id: the hook writes the tool
    /// row's `parent_tool_use_id ?? null` as is.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::parse_init::double_option"
    )]
    pub parent_tool_use_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ToolHistoryKind>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub estimated_thinking_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message_uuid: Option<String>,
}

impl ToolHistoryEntry {
    fn is_open_thinking(&self) -> bool {
        self.kind == Some(ToolHistoryKind::Thinking) && self.done != Some(true)
    }
}

/// `applyThinkingTokensEstimate(entries, estimatedTokens, userMessageUuid)`:
/// the estimate goes on the latest open thinking row stamped with
/// `user_message_uuid` (when given and non-empty), else on the latest open
/// thinking row, which then takes the stamp.
pub fn apply_thinking_tokens_estimate(
    entries: &mut [ToolHistoryEntry],
    estimated_tokens: f64,
    user_message_uuid: Option<&str>,
) -> bool {
    let uuid = user_message_uuid.filter(|u| !u.is_empty());
    let idx = uuid
        .and_then(|u| {
            entries
                .iter()
                .rposition(|e| e.is_open_thinking() && e.user_message_uuid.as_deref() == Some(u))
        })
        .or_else(|| entries.iter().rposition(ToolHistoryEntry::is_open_thinking));
    let Some(idx) = idx else {
        return false;
    };
    let e = &mut entries[idx];
    e.estimated_thinking_tokens = Some(estimated_tokens);
    if let Some(u) = uuid {
        e.user_message_uuid = Some(u.to_owned());
    }
    true
}

/// `sweepToolHistoryDone(entries, now)`: every row not yet `done` is, with
/// `endedAt` kept or set to `now`.
pub fn sweep_tool_history_done(entries: &mut [ToolHistoryEntry], now: f64) -> bool {
    let mut changed = false;
    for e in entries.iter_mut().filter(|e| e.done != Some(true)) {
        e.done = Some(true);
        e.ended_at.get_or_insert(now);
        changed = true;
    }
    changed
}

/// `clearStreaming(messages)`: `streaming: false` on every streaming
/// message.
pub fn clear_streaming(messages: &mut [DisplayMessage]) -> bool {
    let mut changed = false;
    for m in messages.iter_mut().filter(|m| m.streaming == Some(true)) {
        m.streaming = Some(false);
        changed = true;
    }
    changed
}
