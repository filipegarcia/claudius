//! The `mcp-delta` reminder (`McpDelta` / `mcpDeltaReminderBody` in
//! `lib/server/session.ts`), and how `setMcpServers` reads the CLI's
//! `McpSetServersResult` into one.
//!
//! When the user reconnects, toggles or replaces a session's MCP servers
//! (`Session::{reconnect_mcp, toggle_mcp, set_mcp_servers}`), the next turn
//! carries a `<system-reminder>` that names them, so the model's view of the
//! available tools catches up (Claude Code TUI parity, feature 35). As in TS,
//! a server that drops on its own (a crash) has no SDK event and isn't
//! reported.
//!
//! Replayed against the TS by `tests/mcp_controls.rs`.

use std::collections::HashSet;

use serde_json::Value;

/// Server names for each kind of transition. A caller fills only the lists
/// that apply to the change:
/// - `added`: newly available (connected, enabled);
/// - `removed`: dropped from the session (by `setMcpServers`);
/// - `disabled`: toggled off by the user (still configured);
/// - `reconnecting`: a reconnect was just requested, so the server may still
///   be `pending`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct McpDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub disabled: Vec<String>,
    pub reconnecting: Vec<String>,
}

/// The CLI's own guidance, on every body. It makes the reconnect race safe:
/// the model waits instead of reporting tools as missing from a stale view.
const WAIT_AND_SEARCH: &str = "Wait for connecting servers and search their tools once available. \
     Do not report a capability as unavailable without first searching.";

/// `mcpDeltaReminderBody(delta)`: the reminder text, without the
/// `<system-reminder>` wrapper. `None` when every list is empty once empty
/// names are dropped: the change was a no-op, so nothing is queued.
///
/// One line per non-empty list, always in the order added, reconnecting,
/// disabled, removed, then the wait-and-search line. Names are joined with
/// `", "` as given: they aren't deduped or trimmed.
pub fn mcp_delta_reminder_body(delta: &McpDelta) -> Option<String> {
    fn names(v: &[String]) -> Vec<&str> {
        v.iter()
            .map(String::as_str)
            .filter(|s| !s.is_empty())
            .collect()
    }
    let added = names(&delta.added);
    let removed = names(&delta.removed);
    let disabled = names(&delta.disabled);
    let reconnecting = names(&delta.reconnecting);
    if added.is_empty() && removed.is_empty() && disabled.is_empty() && reconnecting.is_empty() {
        return None;
    }
    let mut lines = Vec::new();
    if !added.is_empty() {
        lines.push(format!(
            "The following MCP servers are now available: {}.",
            added.join(", ")
        ));
    }
    if !reconnecting.is_empty() {
        lines.push(format!(
            "The following MCP servers were just reconnected and may still be connecting: {}.",
            reconnecting.join(", ")
        ));
    }
    if !disabled.is_empty() {
        lines.push(format!(
            "The following MCP servers are no longer available (disabled by the user): {}.",
            disabled.join(", ")
        ));
    }
    if !removed.is_empty() {
        lines.push(format!(
            "The following MCP servers are no longer available (removed from this session): {}.",
            removed.join(", ")
        ));
    }
    lines.push(WAIT_AND_SEARCH.to_owned());
    Some(lines.join("\n"))
}

/// The delta `setMcpServers` builds from the CLI's reply to
/// `mcp_set_servers`. It uses the string entries of `added` and `removed`,
/// and drops from `added` every server with an `errors` entry: the CLI adds
/// such a server to the dynamic set but never connected it.
///
/// The reply is read the way JS reads it. `errors` counts when it's an object
/// or an array, and an array's keys are its indices (`"0"`, `"1"`, …). A
/// reply that isn't an object, or an `added` / `removed` that isn't an
/// array, contributes nothing.
pub fn set_servers_delta(result: &Value) -> McpDelta {
    let errored: HashSet<String> = match result.get("errors") {
        Some(Value::Object(m)) => m.keys().cloned().collect(),
        Some(Value::Array(a)) => (0..a.len()).map(|i| i.to_string()).collect(),
        _ => HashSet::new(),
    };
    let strings = |key: &str| -> Vec<String> {
        result
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    McpDelta {
        added: strings("added")
            .into_iter()
            .filter(|s| !errored.contains(s))
            .collect(),
        removed: strings("removed"),
        ..McpDelta::default()
    }
}
