//! `components/sessions/TranscriptViewer.tsx` as plain rows: what each
//! `HistoryMessage` shows (or hides), with each compaction folded into one
//! divider (`toRows`). The markdown, the code highlighting and the chat's
//! tool cards are U05's; this is the read-only text.

use serde_json::Value;

use super::search::{js_trim, js_trim_start, locale_number};

/// `COMPACT_SUMMARY_PREFIX` (`lib/shared/user-prompt.ts`).
pub const COMPACT_SUMMARY_PREFIX: &str =
    "This session is being continued from a previous conversation";

/// A content block (`Block`).
#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Text(String),
    Thinking(String),
    ToolUse {
        id: String,
        name: String,
        /// `JSON.stringify(input, null, 2)`.
        input: String,
    },
    ToolResult {
        id: String,
        text: String,
        is_error: bool,
    },
}

/// `String(v ?? "")`.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// `blocks(content)`: a string is one text block; an array keeps the
/// blocks it knows.
pub fn blocks(content: Option<&Value>) -> Vec<Block> {
    match content {
        Some(Value::String(s)) => vec![Block::Text(s.clone())],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|c| {
                let kind = c.get("type").and_then(Value::as_str)?;
                match kind {
                    "text" => c
                        .get("text")
                        .and_then(Value::as_str)
                        .map(|t| Block::Text(t.to_owned())),
                    "thinking" => c
                        .get("thinking")
                        .and_then(Value::as_str)
                        .map(|t| Block::Thinking(t.to_owned())),
                    "tool_use" => {
                        let input = match c.get("input") {
                            None | Some(Value::Null) => Value::Object(Default::default()),
                            Some(v) => v.clone(),
                        };
                        Some(Block::ToolUse {
                            id: js_string(c.get("id")),
                            name: js_string(c.get("name")),
                            input: serde_json::to_string_pretty(&input).unwrap_or_default(),
                        })
                    }
                    "tool_result" => {
                        let text = match c.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Array(parts)) => parts
                                .iter()
                                .map(|p| p.get("text").and_then(Value::as_str).unwrap_or_default())
                                .collect(),
                            _ => String::new(),
                        };
                        Some(Block::ToolResult {
                            id: js_string(c.get("tool_use_id")),
                            text,
                            is_error: c.get("is_error").is_some_and(truthy),
                        })
                    }
                    _ => None,
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// JS truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0. && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn content(m: &Value) -> Option<&Value> {
    m.get("message").and_then(|x| x.get("content"))
}

/// The text blocks joined (`plainText`).
pub fn plain_text(content: Option<&Value>) -> String {
    blocks(content)
        .into_iter()
        .filter_map(|b| match b {
            Block::Text(t) => Some(t),
            _ => None,
        })
        .collect()
}

fn kind(m: &Value) -> &str {
    m.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn uuid(m: &Value) -> String {
    js_string(m.get("uuid"))
}

/// The SDK's compaction summary: flagged, or a user turn that opens with
/// the prefix.
pub fn is_compact_summary(m: &Value) -> bool {
    if kind(m) != "user" {
        return false;
    }
    if m.get("isCompactSummary") == Some(&Value::Bool(true)) {
        return true;
    }
    js_trim_start(&plain_text(content(m))).starts_with(COMPACT_SUMMARY_PREFIX)
}

/// The divider's stats (`formatCompactStats`): `167,000→42,000 tokens · 38s`.
pub fn compact_stats(b: &Value) -> Option<String> {
    let mut parts = Vec::new();
    if let (Some(pre), Some(post)) = (
        b.get("preTokens").and_then(Value::as_f64),
        b.get("postTokens").and_then(Value::as_f64),
    ) {
        parts.push(format!(
            "{}→{} tokens",
            locale_number(pre as i64),
            locale_number(post as i64)
        ));
    }
    if let Some(d) = b.get("durationMs").and_then(Value::as_f64)
        && d >= 1000.
    {
        parts.push(format!("{}s", (d / 1000. + 0.5).floor()));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// One row of the viewer.
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    /// A compaction: the boundary's stats, the summary behind "show
    /// summary".
    Compaction {
        uuid: String,
        stats: Option<String>,
        summary: Option<String>,
    },
    /// Another system row: `— api error —`.
    System { uuid: String, text: String },
    /// A user turn's text (with "↺ Rewind here").
    User { uuid: String, text: String },
    /// "Claude", then its text, thinking and tool calls.
    Assistant { uuid: String, blocks: Vec<Block> },
}

/// The divider's label.
pub const COMPACTION_LABEL: &str = "Compacted earlier conversation";

/// `/^\s*<task-notification[\s>]/`.
fn is_task_notification(text: &str) -> bool {
    let rest = text.trim_start_matches(super::search::is_js_space);
    rest.strip_prefix("<task-notification")
        .and_then(|r| r.chars().next())
        .is_some_and(|c| c == '>' || super::search::is_js_space(c))
}

/// The rows (`toRows`, then the viewer's per-row choices): a tool-result-only
/// user turn and an SDK `<task-notification>` are hidden; each compaction is
/// one divider holding the summary that follows its boundary.
pub fn rows(messages: &[Value]) -> Vec<Row> {
    let mut out: Vec<Row> = Vec::new();
    let mut pending: Option<usize> = None;
    for m in messages {
        let k = kind(m);
        if k == "system" && m.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
            out.push(Row::Compaction {
                uuid: uuid(m),
                stats: m.get("compactBoundary").and_then(compact_stats),
                summary: None,
            });
            pending = Some(out.len() - 1);
        } else if is_compact_summary(m) {
            let text = js_trim(&plain_text(content(m))).to_owned();
            match pending.and_then(|i| out.get_mut(i)) {
                Some(Row::Compaction { summary, .. }) => *summary = Some(text),
                _ => out.push(Row::Compaction {
                    uuid: uuid(m),
                    stats: None,
                    summary: Some(text),
                }),
            }
            pending = None;
        } else if k == "assistant" || k == "user" || k == "system" {
            if let Some(row) = message_row(m) {
                out.push(row);
            }
            if k != "system" {
                pending = None;
            }
        }
    }
    out
}

fn message_row(m: &Value) -> Option<Row> {
    let bs = blocks(content(m));
    match kind(m) {
        "system" => {
            let sub = m
                .get("subtype")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            Some(Row::System {
                uuid: uuid(m),
                text: format!(
                    "— {} —",
                    sub.map_or_else(|| "system".to_owned(), |s| s.replace('_', " "))
                ),
            })
        }
        "user" => {
            let text: String = bs
                .iter()
                .filter_map(|b| match b {
                    Block::Text(t) => Some(t.as_str()),
                    _ => None,
                })
                .collect();
            let tool_results_only =
                !bs.is_empty() && bs.iter().all(|b| matches!(b, Block::ToolResult { .. }));
            if tool_results_only || is_task_notification(&text) {
                return None;
            }
            Some(Row::User {
                uuid: uuid(m),
                text,
            })
        }
        _ => Some(Row::Assistant {
            uuid: uuid(m),
            blocks: bs
                .into_iter()
                .filter(|b| !matches!(b, Block::ToolResult { .. }))
                .collect(),
        }),
    }
}

/// The "Raw" view: each message's JSON on its line.
pub fn raw(messages: &[Value]) -> String {
    messages
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}
