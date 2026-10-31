//! `lib/server/session-recap.ts` and `lib/shared/recap-cap.ts`: the "where
//! were we?" recap. The transcript tail comes from the session's broadcast
//! buffer, and the recap from a one-shot, tool-less, non-persistent query
//! ([`generate_recap`]). [`crate::session::Session::request_recap`] holds
//! the gates and the broadcast.
//!
//! JS strings are UTF-16: every length and cut here counts UTF-16 units. A
//! cut through a surrogate pair leaves JS with a lone high surrogate, which a
//! Rust string can't hold, so that one unit is dropped (the budget arithmetic
//! still counts it).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use claudius_agent::{CanUseTool, Options, PermissionResult, Query, ToolPermissionContext, js};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// `RECAP_INSTRUCTION`: the TUI's away-summary prompt, verbatim.
pub const RECAP_INSTRUCTION: &str = "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.";

/// `TAIL_CHAR_BUDGET`, in UTF-16 units.
const TAIL_CHAR_BUDGET: i64 = 4_000;

/// `RECAP_DEDUPE_WINDOW_MS`: the minimum gap between two recaps of a session.
pub const RECAP_DEDUPE_WINDOW_MS: i64 = 60_000;

/// `RECAP_MAX_CHARS`.
pub const RECAP_MAX_CHARS: usize = 400;

/// The tool-call denial the recap's model gets.
const DENY_MESSAGE: &str = "Recap mode cannot use tools.";

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` in UTF-16 units, without a trailing lone high surrogate.
fn utf16_head(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        used += c.len_utf16();
        if used > n {
            return &s[..i];
        }
    }
    s
}

/// `extractTranscriptTail(buffer)`: the user and assistant prose of the
/// newest broadcast `sdk` events, newest first until the budget runs out,
/// then in order. `None` where the TS throws: an `sdk` event whose
/// `message` is missing or `null`.
pub fn extract_transcript_tail(buffer: &[Value]) -> Option<(String, usize)> {
    let mut lines = Vec::new();
    let mut budget = TAIL_CHAR_BUDGET;
    let mut turns = 0;
    for ev in buffer.iter().rev() {
        if budget <= 0 {
            break;
        }
        if ev.get("type").and_then(Value::as_str) != Some("sdk") {
            continue;
        }
        let msg = ev.get("message").filter(|m| !m.is_null())?;
        let (prefix, text) = match msg.get("type").and_then(Value::as_str) {
            Some("user") => ("USER: ", user_text(msg)),
            Some("assistant") => ("ASSISTANT: ", assistant_text(msg)),
            _ => continue,
        };
        if text.is_empty() {
            continue;
        }
        let (cut, cut_units) = truncate(&text, budget);
        lines.push(format!("{prefix}{cut}"));
        budget -= (units(prefix) + cut_units) as i64;
        turns += 1;
    }
    lines.reverse();
    Some((lines.join("\n\n"), turns))
}

/// `extractUserText`: skips tool results (`parent_tool_use_id`) and
/// synthetic pings (`isSynthetic`), both by JS truthiness.
fn user_text(msg: &Value) -> String {
    if msg.get("parent_tool_use_id").is_some_and(js::truthy)
        || msg.get("isSynthetic").is_some_and(js::truthy)
    {
        return String::new();
    }
    match msg.get("message").and_then(|m| m.get("content")) {
        Some(Value::String(s)) => js::trim(s).to_owned(),
        Some(Value::Array(blocks)) => text_blocks(blocks),
        _ => String::new(),
    }
}

/// `extractAssistantText`: skips subagent turns.
fn assistant_text(msg: &Value) -> String {
    if msg.get("parent_tool_use_id").is_some_and(js::truthy) {
        return String::new();
    }
    match msg.get("message").and_then(|m| m.get("content")) {
        Some(Value::Array(blocks)) => text_blocks(blocks),
        _ => String::new(),
    }
}

/// The `text` blocks' strings joined with a space, then JS-trimmed.
fn text_blocks(blocks: &[Value]) -> String {
    let parts: Vec<&str> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    js::trim(&parts.join(" ")).to_owned()
}

/// `truncate(s, max)`, with the JS length of the result.
fn truncate(s: &str, max: i64) -> (String, usize) {
    let len = units(s);
    if len as i64 <= max {
        return (s.to_owned(), len);
    }
    let keep = (max - 1).max(0) as usize;
    (format!("{}…", utf16_head(s, keep)), keep + 1)
}

/// `capRecap(text, max)`: at most `max` units, cut at the last space past
/// 60% of the budget (else hard), right-trimmed, with an ellipsis.
pub fn cap_recap(text: &str, max: usize) -> String {
    if units(text) <= max {
        return text.to_owned();
    }
    let budget = max.saturating_sub(1).max(1);
    let slice = utf16_head(text, budget);
    let cut = match slice.rfind(' ') {
        Some(at) if units(&slice[..at]) as f64 > budget as f64 * 0.6 => &slice[..at],
        _ => slice,
    };
    format!("{}…", cut.trim_end_matches(js::is_whitespace))
}

/// `collapseWhitespace`: every run of JS whitespace (`\s+`) becomes one space.
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if js::is_whitespace(c) {
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

/// The recap prompt: the instruction, then the tail in a tagged block.
pub fn recap_prompt(tail: &str) -> String {
    format!("{RECAP_INSTRUCTION}\n\n<recent_transcript>\n{tail}\n</recent_transcript>")
}

/// `GenerateRecapInput`, plus the CLI binary the session runs.
#[derive(Clone, Debug, Default)]
pub struct RecapInput {
    pub cwd: String,
    pub transcript_tail: String,
    /// The session's model; `None` lets the CLI pick.
    pub model: Option<String>,
    /// The session's frozen account env; `None` inherits the process env.
    pub env: Option<HashMap<String, String>>,
    pub claude_bin: Option<PathBuf>,
}

/// `GenerateRecapResult`.
#[derive(Clone, Debug, PartialEq)]
pub enum RecapOutcome {
    Ok(String),
    EmptyResponse,
    /// Cancelled through the token. The TS reports a cancelled query as
    /// `failed` with the SDK's abort message (its errors aren't named
    /// `AbortError`), which `requestRecap` then drops because its signal is
    /// aborted; nothing reaches a subscriber either way.
    Aborted,
    Failed(String),
}

struct DenyAllTools;

#[async_trait]
impl CanUseTool for DenyAllTools {
    async fn can_use_tool(
        &self,
        _tool_name: &str,
        _input: Value,
        _ctx: ToolPermissionContext,
    ) -> Option<PermissionResult> {
        Some(PermissionResult::Deny {
            message: DENY_MESSAGE.into(),
            interrupt: false,
        })
    }
}

/// `generateRecap(input)`: a single-turn query that may not use tools or
/// persist, its top-level assistant text collapsed, trimmed and capped.
/// A token cancelled before the call spawns nothing (the biased `select!`
/// returns before the spawn is polled).
pub async fn generate_recap(input: RecapInput, cancel: CancellationToken) -> RecapOutcome {
    let prompt = recap_prompt(&input.transcript_tail);
    let options = Options {
        cwd: Some(PathBuf::from(&input.cwd)),
        model: input.model,
        env: input.env,
        path_to_claude_code_executable: input.claude_bin,
        persist_session: Some(false),
        max_turns: Some(1.0),
        can_use_tool: Some(Arc::new(DenyAllTools)),
        permission_prompts: Some("none".into()),
        permission_mode: Some("default".into()),
        verbatim_prompts: true,
        ..Default::default()
    };
    let spawned = tokio::select! {
        biased;
        _ = cancel.cancelled() => return RecapOutcome::Aborted,
        q = Query::spawn_prompt(&prompt, options) => q,
    };
    let mut q = match spawned {
        Ok(q) => q,
        Err(e) => return RecapOutcome::Failed(e.to_string()),
    };
    let handle = q.handle();
    let collected = tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        r = collect_text(&mut q) => Some(r),
    };
    handle.close().await;
    match collected {
        None => RecapOutcome::Aborted,
        Some(Err(e)) => RecapOutcome::Failed(e),
        Some(Ok(text)) => finish(&text).map_or(RecapOutcome::EmptyResponse, RecapOutcome::Ok),
    }
}

/// The `for await` over the query: top-level assistant `text` blocks,
/// concatenated as they come.
async fn collect_text(q: &mut Query) -> Result<String, String> {
    let mut text = String::new();
    while let Some(msg) = q.next().await {
        let msg = msg.map_err(|e| e.to_string())?;
        if msg.get("type").and_then(Value::as_str) != Some("assistant")
            || msg.get("parent_tool_use_id").is_some_and(js::truthy)
        {
            continue;
        }
        let Some(Value::Array(blocks)) = msg.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        for b in blocks {
            if b.get("type").and_then(Value::as_str) == Some("text")
                && let Some(t) = b.get("text").and_then(Value::as_str)
            {
                text.push_str(t);
            }
        }
    }
    Ok(text)
}

/// The cleanup after the query: `None` for an empty response.
fn finish(text: &str) -> Option<String> {
    let collapsed = collapse_whitespace(text);
    let cleaned = js::trim(&collapsed);
    (!cleaned.is_empty()).then(|| cap_recap(cleaned, RECAP_MAX_CHARS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_cuts_never_split_a_pair() {
        assert_eq!(utf16_head("a😀b", 1), "a");
        assert_eq!(utf16_head("a😀b", 2), "a");
        assert_eq!(utf16_head("a😀b", 3), "a😀");
        assert_eq!(utf16_head("a😀b", 9), "a😀b");
        // The JS length counts the lone surrogate JS would have kept.
        assert_eq!(truncate("a😀b", 3), ("a…".to_owned(), 3));
        assert_eq!(truncate("abc", 3), ("abc".to_owned(), 3));
        assert_eq!(truncate("abc", 0), ("…".to_owned(), 1));
    }

    /// A token cancelled before the call never reaches the spawn: with a
    /// CLI path that can't run, it's `Aborted`, not the spawn error.
    #[tokio::test]
    async fn a_cancelled_recap_spawns_nothing() {
        let input = RecapInput {
            cwd: std::env::temp_dir().display().to_string(),
            transcript_tail: "USER: hi".into(),
            claude_bin: Some(PathBuf::from("/nonexistent/claudius-recap-cli")),
            ..Default::default()
        };
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert_eq!(
            generate_recap(input.clone(), cancelled).await,
            RecapOutcome::Aborted
        );
        let failed = generate_recap(input, CancellationToken::new()).await;
        assert!(matches!(failed, RecapOutcome::Failed(_)), "{failed:?}");
    }

    #[test]
    fn collapse_and_finish() {
        assert_eq!(
            collapse_whitespace(" a \n\n b\u{a0}\u{85}c "),
            " a b \u{85}c "
        );
        assert_eq!(finish(" \u{2028}\t"), None);
        assert_eq!(finish("  x  y "), Some("x y".into()));
    }
}
