//! `lib/client/task-status.ts`: subagent (Task) status reconciliation off
//! the Task's own `tool_result`, and the provisional rows a backgrounded
//! launcher (the Workflow tool) gets before its `task_started`.
//!
//! Only what `use-session.ts` calls is here. `isSystemTask`,
//! `isBackgroundTaskLive`, `isActivityCountableTask`,
//! `collectStoppableTaskIds` and `findSubagentRetry` are read by the
//! Background tasks panel and the task block, not the state machine.
//!
//! The task map is the hook's `Record<string, TaskInfo>`, a [`JsRecord`]:
//! the helpers change it in place and return whether they did (the TS
//! hands back `prev` itself when nothing changed).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsThrow;
use crate::types::{DisplayBlock, DisplayMessage, JsRecord, num, record_set};

/// `TaskStatus`: `"pending" | "running" | "completed" | "failed" |
/// "killed" | "stopped" | "paused"`, kept as the string the event carried.
pub type TaskStatus = String;

/// `TaskResourceLink` (`lib/shared/events.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResourceLink {
    pub uri: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub size: Option<f64>,
}

/// `TaskInfo`: one row of the hook's `tasks` map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_name: Option<String>,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_backgrounded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub spawn_depth: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub started_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisional: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambient: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_transcript: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub total_tokens: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub tool_uses: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub total_paused_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_links: Option<Vec<TaskResourceLink>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl TaskInfo {
    /// A row with only the required fields.
    pub fn new(
        task_id: impl Into<String>,
        description: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            tool_use_id: None,
            description: description.into(),
            task_type: None,
            workflow_name: None,
            status: status.into(),
            is_backgrounded: None,
            spawn_depth: None,
            started_at: None,
            provisional: None,
            ambient: None,
            model: None,
            skip_transcript: None,
            total_tokens: None,
            tool_uses: None,
            duration_ms: None,
            total_paused_ms: None,
            last_tool_name: None,
            summary: None,
            output_file: None,
            error: None,
            resource_links: None,
            reason: None,
        }
    }

    fn is_provisional(&self) -> bool {
        self.provisional == Some(true)
    }
}

/// `isNonTerminalTaskStatus(s)`: `running`, `pending` and `paused` (a
/// usage-limit hold that resumes on its own).
pub fn is_non_terminal_task_status(s: &str) -> bool {
    matches!(s, "running" | "pending" | "paused")
}

/// `statusFromToolResult(isError)`: the terminal status a foreground Task's
/// `tool_result` implies.
pub fn status_from_tool_result(is_error: Option<bool>) -> &'static str {
    if is_error == Some(true) {
        "failed"
    } else {
        "completed"
    }
}

/// `setTaskModelForToolUse(tasks, toolUseId, model)`: stamps `model` on
/// every task of `tool_use_id` that has none yet (an empty model counts as
/// none). Set once.
pub fn set_task_model_for_tool_use(
    tasks: &mut JsRecord<TaskInfo>,
    tool_use_id: &str,
    model: &str,
) -> bool {
    let mut changed = false;
    for t in tasks.values_mut() {
        if t.tool_use_id.as_deref() == Some(tool_use_id)
            && t.model.as_deref().is_none_or(str::is_empty)
        {
            t.model = Some(model.to_owned());
            changed = true;
        }
    }
    changed
}

/// `findToolUseBlock(toolUseId, ...lists)`: the first `tool_use` block with
/// that id, list by list, message by message.
pub fn find_tool_use_block<'a>(
    tool_use_id: &str,
    lists: &[&'a [DisplayMessage]],
) -> Option<&'a DisplayBlock> {
    lists
        .iter()
        .flat_map(|list| list.iter())
        .flat_map(|m| m.blocks.iter())
        .find(|b| b.tool_use_id() == Some(tool_use_id))
}

/// `shouldRecoverOrphanTask(task, messages)`: a snapshot task with a
/// (non-empty) `toolUseId` that isn't `running` and whose tool_use block
/// isn't in `messages`.
pub fn should_recover_orphan_task(
    tool_use_id: Option<&str>,
    status: Option<&str>,
    messages: &[DisplayMessage],
) -> bool {
    let Some(id) = tool_use_id.filter(|id| !id.is_empty()) else {
        return false;
    };
    if status == Some("running") {
        return false;
    }
    find_tool_use_block(id, &[messages]).is_none()
}

/// `isBackgroundedToolUse(block)`: a tool_use whose input has a strict
/// `run_in_background: true`, or the always-backgrounded `Workflow` tool.
/// An input of `null` throws as the TS property read does.
pub fn is_backgrounded_tool_use(block: Option<&DisplayBlock>) -> Result<bool, JsThrow> {
    let Some(DisplayBlock::ToolUse { name, input, .. }) = block else {
        return Ok(false);
    };
    if input.is_null() {
        return Err(JsThrow::read_of_null("run_in_background"));
    }
    if input.get("run_in_background") == Some(&Value::Bool(true)) {
        return Ok(true);
    }
    Ok(name == "Workflow")
}

/// `reconcileTasksOnToolResult(tasks, toolUseId, isError, backgrounded)`:
/// every non-terminal, non-backgrounded task of `tool_use_id` takes the
/// status its `tool_result` implies. A backgrounded launch changes nothing.
pub fn reconcile_tasks_on_tool_result(
    tasks: &mut JsRecord<TaskInfo>,
    tool_use_id: &str,
    is_error: Option<bool>,
    backgrounded: bool,
) -> bool {
    if backgrounded {
        return false;
    }
    let mut changed = false;
    for t in tasks.values_mut() {
        if t.tool_use_id.as_deref() != Some(tool_use_id)
            || !is_non_terminal_task_status(&t.status)
            || t.is_backgrounded == Some(true)
        {
            continue;
        }
        t.status = status_from_tool_result(is_error).to_owned();
        changed = true;
    }
    changed
}

/// `seedTaskStatus(block)`: `running`, or the terminal status when the
/// Task's (non-backgrounded) `tool_result` already landed on `block`.
pub fn seed_task_status(block: Option<&DisplayBlock>) -> Result<&'static str, JsThrow> {
    if let Some(DisplayBlock::ToolUse {
        result: Some(result),
        ..
    }) = block
        && !is_backgrounded_tool_use(block)?
    {
        return Ok(status_from_tool_result(result.is_error));
    }
    Ok("running")
}

/// `hasRealTaskForToolUse(tasks, toolUseId)`.
pub fn has_real_task_for_tool_use(tasks: &JsRecord<TaskInfo>, tool_use_id: &str) -> bool {
    tasks
        .values()
        .any(|t| t.tool_use_id.as_deref() == Some(tool_use_id) && !t.is_provisional())
}

/// `upsertProvisionalTask(tasks, provisional)`: the placeholder under its
/// `toolUseId` (as its `taskId`, `provisional: true`), unless a real task
/// owns that tool_use or a provisional row is already there.
pub fn upsert_provisional_task(
    tasks: &mut JsRecord<TaskInfo>,
    tool_use_id: &str,
    mut provisional: TaskInfo,
) -> bool {
    if has_real_task_for_tool_use(tasks, tool_use_id) {
        return false;
    }
    if tasks.get(tool_use_id).is_some_and(TaskInfo::is_provisional) {
        return false;
    }
    provisional.tool_use_id = Some(tool_use_id.to_owned());
    provisional.task_id = tool_use_id.to_owned();
    provisional.provisional = Some(true);
    record_set(tasks, tool_use_id, provisional);
    true
}

/// `dropProvisionalForToolUse(tasks, toolUseId)`: removes the provisional
/// row of `tool_use_id` and returns `Some(carriedStartedAt)` (the row's
/// `startedAt`, if any), or `None` when there was nothing to drop.
pub fn drop_provisional_for_tool_use(
    tasks: &mut JsRecord<TaskInfo>,
    tool_use_id: Option<&str>,
) -> Option<Option<f64>> {
    let id = tool_use_id.filter(|id| !id.is_empty())?;
    if !tasks.get(id).is_some_and(TaskInfo::is_provisional) {
        return None;
    }
    tasks.shift_remove(id).map(|t| t.started_at)
}
