//! `applyEvent`'s `sdk` → `user` and `tool_progress` branches, the
//! `system` / `thinking_tokens` frame, and the assistant handler's per-tool
//! side effects for Edit / MultiEdit / Write, background Bash and KillBash
//! (U01e).
//!
//! - `user` with a `tool_result`: the result lands on every tool_use block
//!   with its id, in the transcript and in every subagent trail; the tool's
//!   progress frame goes, its rail row and recent edit are marked done, a
//!   Task's status follows its result, a Workflow ack seeds a provisional
//!   task, and a background shell picks up its SDK-side id (or the shell
//!   the SDK backgrounded on a timeout).
//! - Any other `user` message: a subagent's prompt joins its trail; on the
//!   main thread, the compaction summary becomes a divider, the SDK's
//!   internal records (`isMeta`, the local-command caveat, the image-resize
//!   note, `<task-notification>`) are dropped, a replayed SDK slash command
//!   and the CLI's `<command-name>` / stdout / stderr wrappers become info
//!   pills (with the prose after a wrapper as its own bubble, and the
//!   "Set model to" stdout only moving the model), leading
//!   `<system-reminder>`s become reminder pills, and the rest is a user
//!   bubble (with its images and a peer sender).
//! - `tool_progress`: the tool's live progress frame, by tool_use id.
//! - `system` / `thinking_tokens`: the live thinking estimate on the open
//!   thinking row.
//! - The assistant's Edit / MultiEdit / Write calls are the Recent Edits
//!   widget (newest first, 20 at most), a `run_in_background` Bash is a
//!   background shell, and KillBash marks one killed.
//!
//! A result's todo and loop side effects (the TaskCreate re-key, the
//! TaskList rebuild, the CronCreate promotion) are U01g's
//! (`task_events.rs`).
//!
//! Deliberate, with the crate's convention for SDK fields the TS copies
//! unchecked: a `uuid` that isn't a string counts as missing (a random
//! uuid, where the TS keeps the number or object), a non-string
//! `parent_tool_use_id` or `user_message_uuid` as absent, and an `at` that
//! isn't a number as none (`Date.now()` for a shell's start, where the TS
//! keeps it as sent).

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::apply::Cx;
use crate::blocks::{
    ToolResultInfo, apply_bash_auto_background, extract_peer_origin, extract_tool_result,
    extract_user_content, tool_progress_info_from_sdk_message,
};
use crate::compact::merge_compact_boundary;
use crate::idle_reconcile::apply_thinking_tokens_estimate;
use crate::messages::{
    apply_tool_result_to_list, apply_tool_result_to_trails, sort_messages_by_chronology,
    trailing_bubble_uuid,
};
use crate::sdk_filters::{
    CliWrapper, is_compact_summary_content, is_image_resize_note_content,
    is_local_command_caveat_content, is_sdk_internal_envelope, is_sdk_slash_user_message,
    is_synthetic_task_notification, parse_synthetic_cli_wrapper,
};
use crate::state::ChatState;
use crate::task_status::{
    TaskInfo, find_tool_use_block, is_backgrounded_tool_use, reconcile_tasks_on_tool_result,
    upsert_provisional_task,
};
use crate::text::{AsciiCi, as_num, as_str, js_pattern, prop, push_js, to_js_string, truthy};
use crate::types::num;
use crate::workflow_meta::parse_workflow_meta;
use crate::{
    BackgroundBash, DisplayBlock, DisplayMessage, JsThrow, Role, SystemEntry, SystemEntryKind,
    ToolResult, record_set,
};

/// How many rows the Recent Edits widget keeps (`slice(0, 20)`).
const RECENT_EDITS_CAP: usize = 20;

/// `RecentEdit`: one file an Edit / MultiEdit / Write call touched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEdit {
    pub tool_use_id: String,
    pub tool_name: String,
    pub file_path: String,
    #[serde(with = "num")]
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_run: Option<bool>,
}

/// `/bash[_-]?(?:id)?[: ]+([\w-]+)/i`: the SDK-side shell id in a
/// background launch's acknowledgement (`\w` is ASCII without `u`).
static BASH_ID: LazyLock<AsciiCi> =
    LazyLock::new(|| AsciiCi::new(r"bash[_-]?(?:id)?[: ]+([0-9a-z_-]+)"));

/// `/^set\s+model\s+to\s+(\S+)/i`: the CLI's confirmation of a model
/// change. A trimmed text that passes the hook's `test` always has the
/// token, so one pattern does for both.
static SET_MODEL: LazyLock<AsciiCi> =
    LazyLock::new(|| AsciiCi::new(&js_pattern(r"^set[{WS}]+model[{WS}]+to[{WS}]+([^{WS}]+)")));

/// The `text` parts of a user message, joined (`c?.type === "text" &&
/// c.text`), or the content itself when it is a string.
fn joined_text(content: Option<&Value>) -> Result<String, JsThrow> {
    let mut text = String::new();
    match content {
        Some(Value::String(s)) => text.clone_from(s),
        Some(Value::Array(items)) => {
            for c in items {
                let t = prop(Some(c), "text");
                if as_str(prop(Some(c), "type")) == Some("text") && truthy(t) {
                    push_js(&mut text, &to_js_string(t.expect("truthy"))?);
                }
            }
        }
        _ => {}
    }
    Ok(text)
}

impl ChatState {
    /// `msg.uuid ?? crypto.randomUUID()`.
    fn record_uuid(msg: &Value, cx: &mut Cx<'_>) -> String {
        match prop(Some(msg), "uuid") {
            Some(Value::String(s)) => s.clone(),
            _ => cx.env.random_uuid(),
        }
    }

    /// An info pill after the last assistant message, unless its uuid is
    /// already there (a replay).
    fn push_info_pill(&mut self, uuid: String, label: String) {
        if self.system_entries.iter().any(|e| e.uuid == uuid) {
            return;
        }
        let anchor = self.last_assistant_uuid.clone();
        self.system_entries
            .push(SystemEntry::new(uuid, anchor, SystemEntryKind::Info, label));
    }

    /// `if (msg.type === "user") { ... }`.
    pub(crate) fn on_user(
        &mut self,
        msg: &Value,
        at: Option<f64>,
        cx: &mut Cx<'_>,
    ) -> Result<(), JsThrow> {
        let m = Some(msg);
        let inner = prop(m, "message");
        let content = prop(inner, "content");
        let result = extract_tool_result(
            content,
            prop(m, "tool_use_result"),
            prop(m, "tool_result_meta"),
        )?;
        if let Some(result) = result {
            return self.on_tool_result(msg, &result, at, cx);
        }
        // `if (parent && inner)`: a falsy message has no content, which
        // adds nothing to the trail either.
        let parent = as_str(prop(m, "parent_tool_use_id")).filter(|p| !p.is_empty());
        if let Some(parent) = parent {
            return self.on_subagent_prompt(msg, parent, content, at, cx);
        }
        if prop(m, "isSynthetic") == Some(&Value::Bool(true)) || !truthy(inner) {
            return Ok(());
        }
        // The SDK's post-compaction summary (flagged on disk, recognised by
        // its text live): a divider that can expand it.
        if prop(m, "isCompactSummary") == Some(&Value::Bool(true))
            || is_compact_summary_content(content)
        {
            let uuid = Self::record_uuid(msg, cx);
            let summary = joined_text(content)?;
            let summary = claudius_agent::js::trim(&summary);
            let anchor = self.last_assistant_uuid.clone();
            merge_compact_boundary(
                &mut self.system_entries,
                &uuid,
                &anchor,
                None,
                Some(summary),
            );
            return Ok(());
        }
        // Records written for the model's eyes only.
        if is_sdk_internal_envelope(m)
            || is_local_command_caveat_content(content)
            || is_image_resize_note_content(content)
            || is_synthetic_task_notification(content)
        {
            return Ok(());
        }
        if let Some(slash) = is_sdk_slash_user_message(content)? {
            let uuid = Self::record_uuid(msg, cx);
            self.push_info_pill(uuid, ran_label(&slash.command, &slash.args));
            return Ok(());
        }
        if let Some(cli) = parse_synthetic_cli_wrapper(content) {
            self.on_cli_wrapper(msg, &cli, cx);
            return Ok(());
        }
        let user = extract_user_content(content);
        let uuid = Self::record_uuid(msg, cx);
        // Cross-turn reminders the server prepended (a cold resume replays
        // them): one pill each, above the bubble.
        let anchor = self.last_assistant_uuid.clone();
        for (i, body) in user.reminder_bodies.iter().enumerate() {
            let id = format!("{uuid}-reminder-{i}");
            if self.system_entries.iter().any(|e| e.uuid == id) {
                continue;
            }
            let mut entry = SystemEntry::new(
                id,
                anchor.clone(),
                SystemEntryKind::SystemReminder,
                "System reminder",
            );
            entry.reminder_body = Some(body.clone());
            self.system_entries.push(entry);
        }
        // A peer's turn shows the body the model saw.
        let peer = extract_peer_origin(m);
        let text = peer
            .as_ref()
            .and_then(|p| p.body.clone())
            .unwrap_or(user.text);
        if (text.is_empty() && user.images.is_empty())
            || self.messages.iter().any(|m| m.uuid == uuid)
        {
            return Ok(());
        }
        let blocks = if text.is_empty() {
            Vec::new()
        } else {
            vec![DisplayBlock::text(text)]
        };
        let mut bubble = DisplayMessage::new(uuid, Role::User, blocks);
        bubble.images = (!user.images.is_empty()).then_some(user.images);
        bubble.created_at = at;
        bubble.peer = peer.map(|p| p.to_display_peer());
        self.messages.push(bubble);
        Ok(())
    }

    /// A subagent's user-shaped message (its spawning prompt) joins its
    /// Task's trail once.
    fn on_subagent_prompt(
        &mut self,
        msg: &Value,
        parent: &str,
        content: Option<&Value>,
        at: Option<f64>,
        cx: &mut Cx<'_>,
    ) -> Result<(), JsThrow> {
        let text = joined_text(content)?;
        if text.is_empty() {
            return Ok(());
        }
        let uuid = Self::record_uuid(msg, cx);
        let mut list = self
            .subagent_messages
            .get(parent)
            .cloned()
            .unwrap_or_default();
        if list.iter().any(|m| m.uuid == uuid) {
            return Ok(());
        }
        let mut m = DisplayMessage::new(uuid, Role::User, vec![DisplayBlock::text(text)]);
        m.parent_tool_use_id = Some(parent.to_owned());
        m.created_at = at;
        list.push(m);
        record_set(&mut self.subagent_messages, parent, list);
        Ok(())
    }

    /// The CLI's plumbing around a slash command run, as a pill; the
    /// "Set model to" confirmation only moves the model.
    fn on_cli_wrapper(&mut self, msg: &Value, cli: &CliWrapper, cx: &mut Cx<'_>) {
        if let CliWrapper::Stdout { text, .. } = cli
            && let Some(c) = SET_MODEL.captures(text)
        {
            let (s, e) = c[1].expect("group 1");
            // `.replace(/\[.*$/, "")`: the token has no line break.
            let token = &text[s..e];
            let model = token.split('[').next().unwrap_or_default();
            if !model.is_empty() {
                self.model = Value::String(model.to_owned());
            }
            return;
        }
        let uuid = Self::record_uuid(msg, cx);
        let label = match cli {
            CliWrapper::Command { command, args, .. } => ran_label(command, args),
            CliWrapper::Stdout { text, .. } if text.is_empty() => "CLI ran".to_owned(),
            CliWrapper::Stdout { text, .. } => format!("CLI: {text}"),
            CliWrapper::Stderr { text, .. } if text.is_empty() => "CLI error".to_owned(),
            CliWrapper::Stderr { text, .. } => format!("CLI error: {text}"),
        };
        self.push_info_pill(uuid.clone(), label);
        // The user's prose after a quoted tag is its own bubble.
        let trailing = cli.trailing();
        if trailing.is_empty() {
            return;
        }
        let id = trailing_bubble_uuid(&uuid);
        if self.messages.iter().any(|m| m.uuid == id) {
            return;
        }
        self.messages.push(DisplayMessage::new(
            id,
            Role::User,
            vec![DisplayBlock::text(trailing)],
        ));
    }

    /// A `tool_result`: everything that waits on a tool call finishing.
    fn on_tool_result(
        &mut self,
        msg: &Value,
        r: &ToolResultInfo,
        at: Option<f64>,
        cx: &mut Cx<'_>,
    ) -> Result<(), JsThrow> {
        let id = r.tool_use_id.as_str();
        let now = cx.env.now_ms();
        let result = ToolResult {
            content: r.text.clone(),
            is_error: r.is_error,
            staged: r.staged.then_some(true),
            detached: r.detached.then_some(true),
            not_run: r.not_run.then_some(true),
        };
        // `findToolUseBlock(id, messagesRef.current)`: the main transcript
        // as last rendered (sorted), before this result lands on it.
        let block = {
            let mut sorted = self.messages.clone();
            sort_messages_by_chronology(&mut sorted);
            find_tool_use_block(id, &[&sorted]).cloned()
        };
        apply_tool_result_to_list(&mut self.messages, id, Some(&result));
        apply_tool_result_to_trails(&mut self.subagent_messages, id, Some(&result));
        self.tool_progress.shift_remove(id);
        if let Some(row) = self.tool_history.iter_mut().find(|e| e.tool_use_id == id) {
            row.done = Some(true);
            row.ended_at = Some(now);
            row.is_error = r.is_error;
            if r.not_run {
                row.not_run = Some(true);
            }
        }
        if let Some(edit) = self.recent_edits.iter_mut().find(|e| e.tool_use_id == id) {
            edit.done = Some(true);
            edit.is_error = r.is_error;
            if r.not_run {
                edit.not_run = Some(true);
            }
        }
        // The result is the "subagent returned" signal; a backgrounded
        // launch's first result is only its ack.
        let backgrounded = is_backgrounded_tool_use(block.as_ref())?;
        reconcile_tasks_on_tool_result(&mut self.tasks, id, r.is_error, backgrounded);
        let (name, input) = match &block {
            Some(DisplayBlock::ToolUse { name, input, .. }) => (name.as_str(), Some(input)),
            _ => ("", None),
        };
        // A Workflow's ack: a provisional row until `task_started` (U01g)
        // brings the real one.
        if name == "Workflow" && r.is_error != Some(true) {
            let meta = parse_workflow_meta(prop(input, "script"));
            let description = meta.description.clone().unwrap_or_else(|| {
                match meta.name.as_deref().filter(|n| !n.is_empty()) {
                    Some(n) => format!("Workflow {n}"),
                    None => "Workflow running in background".to_owned(),
                }
            });
            let mut task = TaskInfo::new(id, description, "running");
            task.task_type = Some("local_workflow".into());
            task.workflow_name = meta.name;
            task.is_backgrounded = Some(true);
            task.started_at = Some(now);
            upsert_provisional_task(&mut self.tasks, id, task);
        }
        // A background shell's launch ack names its SDK-side id.
        if let Some(shell) = self.background_bashes.get_mut(id)
            && shell.bash_id.as_deref().is_none_or(str::is_empty)
            && let Some(c) = BASH_ID.captures(&r.text)
        {
            let (s, e) = c[1].expect("group 1");
            shell.bash_id = Some(r.text[s..e].to_owned());
        }
        // A foreground Bash the SDK moved to the background on its timeout.
        if name == "Bash" {
            let command = as_str(prop(input, "command")).unwrap_or_default();
            apply_bash_auto_background(
                &mut self.background_bashes,
                id,
                command,
                prop(Some(msg), "tool_use_result"),
                at.unwrap_or(now),
            );
        }
        // The CronCreate promotion, TaskCreate re-key, TaskList rebuild.
        self.task_tool_result(msg, r, name);
        Ok(())
    }

    /// `if (msg.type === "tool_progress") { ... }`.
    pub(crate) fn on_tool_progress(&mut self, msg: &Value) -> Result<(), JsThrow> {
        let info = tool_progress_info_from_sdk_message(msg)?;
        let key = info.tool_use_id.clone();
        record_set(&mut self.tool_progress, &key, info);
        Ok(())
    }

    /// `system` / `thinking_tokens`: the live estimate on the open
    /// thinking row (a number only).
    pub(crate) fn on_thinking_tokens(&mut self, msg: &Value) -> Result<(), JsThrow> {
        let m = Some(msg);
        if let Some(n) = as_num(prop(m, "estimated_tokens")) {
            let uuid = as_str(prop(m, "user_message_uuid"));
            apply_thinking_tokens_estimate(&mut self.tool_history, n, uuid);
        }
        Ok(())
    }

    /// The assistant handler's per-tool branches for one main-thread
    /// tool_use: Edit / MultiEdit / Write, a background Bash, KillBash.
    pub(crate) fn tool_use_side_effects(
        &mut self,
        id: &str,
        name: &str,
        input: &Value,
        at: Option<f64>,
        now: f64,
    ) {
        let input = Some(input);
        match name {
            "Edit" | "MultiEdit" | "Write" => {
                let Some(path) = as_str(prop(input, "file_path")).filter(|p| !p.is_empty()) else {
                    return;
                };
                if self.recent_edits.iter().any(|e| e.tool_use_id == id) {
                    return;
                }
                let edit = RecentEdit {
                    tool_use_id: id.to_owned(),
                    tool_name: name.to_owned(),
                    file_path: path.to_owned(),
                    started_at: now,
                    done: None,
                    is_error: None,
                    not_run: None,
                };
                self.recent_edits.insert(0, edit);
                self.recent_edits.truncate(RECENT_EDITS_CAP);
            }
            "Bash" => {
                if prop(input, "run_in_background") != Some(&Value::Bool(true)) {
                    return;
                }
                let Some(command) = as_str(prop(input, "command")) else {
                    return;
                };
                if self.background_bashes.contains_key(id) {
                    return;
                }
                // Anchored on the event's time, so a replay keeps the
                // shell's elapsed time.
                let shell = BackgroundBash {
                    tool_use_id: id.to_owned(),
                    bash_id: None,
                    command: command.to_owned(),
                    started_at: at.unwrap_or(now),
                    killed: None,
                    timed_out_after_ms: None,
                    ends_with_agent_final_response: None,
                };
                record_set(&mut self.background_bashes, id, shell);
            }
            "KillBash" => {
                // `shell_id ?? bash_id`.
                let sid = match prop(input, "shell_id") {
                    None | Some(Value::Null) => prop(input, "bash_id"),
                    v => v,
                };
                if let Some(shell) = as_str(sid).and_then(|s| self.background_bashes.get_mut(s)) {
                    shell.killed = Some(true);
                }
            }
            _ => {}
        }
    }
}

/// `Ran ${command}${args ? ` ${args}` : ""}`.
fn ran_label(command: &str, args: &str) -> String {
    if args.is_empty() {
        format!("Ran {command}")
    } else {
        format!("Ran {command} {args}")
    }
}

/// `system` messages whose subtype U01e handles (`thinking_tokens`).
pub(crate) fn is_thinking_tokens(msg: &Value) -> bool {
    as_str(prop(Some(msg), "subtype")) == Some("thinking_tokens")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;
    use crate::effect::Effect;
    use serde_json::json;

    fn sdk(s: &mut ChatState, message: Value, at: Value) -> Vec<Effect> {
        let mut env = FixedEnv::new(1000.0);
        env.uuids = s.messages.len() as u64;
        let data = json!({ "type": "sdk", "message": message, "at": at }).to_string();
        s.on_message(&data, &mut env)
    }

    fn tool_use(id: &str, name: &str, input: Value) -> Value {
        json!({ "type": "assistant", "uuid": format!("a-{id}"), "parent_tool_use_id": null,
                "message": { "id": format!("msg-{id}"), "content": [
                    { "type": "tool_use", "id": id, "name": name, "input": input }
                ] } })
    }

    fn result(id: &str, is_error: bool) -> Value {
        json!({ "type": "user", "uuid": format!("r-{id}"), "message": { "content": [
            { "type": "tool_result", "tool_use_id": id, "content": "done", "is_error": is_error }
        ] } })
    }

    /// Tasks only come from U01g's events, which the recorder can't send
    /// yet: a Task's result settles its running task, but not one that
    /// was launched in the background (its result is only the ack).
    #[test]
    fn a_task_follows_its_result_unless_backgrounded() {
        let mut s = ChatState::new("tab-1");
        let task = |id: &str, bg: Option<bool>| {
            let mut t = TaskInfo::new(format!("task-{id}"), "d", "running");
            t.tool_use_id = Some(id.into());
            t.is_backgrounded = bg;
            t
        };
        for (id, bg) in [
            ("toolu_a", None),
            ("toolu_b", None),
            ("toolu_c", Some(true)),
        ] {
            record_set(&mut s.tasks, &format!("task-{id}"), task(id, bg));
        }
        sdk(&mut s, tool_use("toolu_a", "Task", json!({})), Value::Null);
        sdk(
            &mut s,
            tool_use("toolu_b", "Task", json!({ "run_in_background": true })),
            Value::Null,
        );
        sdk(&mut s, tool_use("toolu_c", "Task", json!({})), Value::Null);
        for id in ["toolu_a", "toolu_b", "toolu_c"] {
            sdk(&mut s, result(id, true), Value::Null);
        }
        let status = |s: &ChatState, id: &str| s.tasks[&format!("task-{id}")].status.clone();
        assert_eq!(status(&s, "toolu_a"), "failed");
        assert_eq!(status(&s, "toolu_b"), "running", "a backgrounded launch");
        assert_eq!(status(&s, "toolu_c"), "running", "a backgrounded task");
        // A task without its tool_use in the transcript still settles.
        record_set(&mut s.tasks, "task-toolu_d", task("toolu_d", None));
        sdk(&mut s, result("toolu_d", false), Value::Null);
        assert_eq!(status(&s, "toolu_d"), "completed");
    }

    /// The crate's convention for SDK fields the TS copies unchecked (not
    /// recorded: each would also differ in the TS's own snapshot type).
    #[test]
    fn odd_wire_fields_read_as_missing() {
        let mut s = ChatState::new("tab-1");
        // A non-string uuid takes a random one (the TS keeps the number).
        sdk(
            &mut s,
            json!({ "type": "user", "uuid": 5, "message": { "content": "hi" } }),
            json!("soon"),
        );
        assert_eq!(s.messages[0].uuid, "00000000-0000-4000-8000-000000000001");
        // An `at` that isn't a number is no `createdAt`.
        assert_eq!(s.messages[0].created_at, None);
        // A non-string parent is the main thread (the TS keys a trail "5").
        sdk(
            &mut s,
            json!({ "type": "user", "uuid": "u2", "parent_tool_use_id": 5, "message": { "content": "sub?" } }),
            json!(7),
        );
        assert!(s.subagent_messages.is_empty());
        assert_eq!(s.messages[1].created_at, Some(7.0));
        // A shell's start falls back to now (the TS keeps `"soon"`).
        sdk(
            &mut s,
            tool_use(
                "toolu_b",
                "Bash",
                json!({ "command": "x", "run_in_background": true }),
            ),
            json!("soon"),
        );
        assert_eq!(s.background_bashes["toolu_b"].started_at, 1000.0);
        // A non-string `user_message_uuid` stamps nothing.
        let mut row = crate::idle_reconcile::ToolHistoryEntry {
            tool_use_id: "thinking:m:0".into(),
            tool_name: "Thinking".into(),
            primary_arg: None,
            started_at: 1.0,
            ended_at: None,
            done: None,
            is_error: None,
            not_run: None,
            parent_tool_use_id: None,
            kind: Some(crate::idle_reconcile::ToolHistoryKind::Thinking),
            estimated_thinking_tokens: None,
            user_message_uuid: None,
        };
        s.tool_history = vec![row.clone()];
        sdk(
            &mut s,
            json!({ "type": "system", "subtype": "thinking_tokens", "estimated_tokens": 9, "user_message_uuid": 3 }),
            Value::Null,
        );
        row.estimated_thinking_tokens = Some(9.0);
        assert_eq!(s.tool_history, vec![row]);
    }

    #[test]
    fn only_thinking_tokens_of_the_system_messages_are_handled() {
        let msg = |subtype: Value| json!({ "type": "system", "subtype": subtype });
        assert!(is_thinking_tokens(&msg(json!("thinking_tokens"))));
        assert!(!is_thinking_tokens(&msg(json!("init"))));
        assert!(!is_thinking_tokens(&msg(Value::Null)));
        assert!(!is_thinking_tokens(&json!({ "type": "system" })));
    }

    #[test]
    fn the_shell_id_pattern_is_ascii() {
        let id = |text: &str| {
            BASH_ID.captures(text).map(|c| {
                let (s, e) = c[1].unwrap();
                text[s..e].to_owned()
            })
        };
        assert_eq!(id("bash_id: Shell-9").as_deref(), Some("Shell-9"));
        assert_eq!(id("BashId:x\u{e9}y").as_deref(), Some("x"));
        assert_eq!(id("ba\u{17f}h id: x"), None, "no `\u{17f}` folding");
        assert_eq!(id("bash_1"), None);
        let model = |text: &str| {
            SET_MODEL.captures(text).map(|c| {
                let (s, e) = c[1].unwrap();
                text[s..e].to_owned()
            })
        };
        assert_eq!(
            model("Set\u{a0}model to\u{3000}opus[1m] x").as_deref(),
            Some("opus[1m]")
        );
        assert_eq!(model("Set model to\u{85}opus"), None, "U+0085 isn't `\\s`");
    }
}
