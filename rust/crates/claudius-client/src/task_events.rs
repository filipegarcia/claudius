//! Tasks, todos and loops (U01g): `applyEvent`'s `task_snapshot` and
//! `todos_auto_cleared` events, the `sdk` → `system` `task_*` /
//! `background_tasks_changed` subtypes, the assistant handler's TodoWrite /
//! TaskCreate / TaskUpdate / CronCreate / CronDelete / ScheduleWakeup
//! branches, a tool result's CronCreate promotion / TaskCreate re-key /
//! TaskList rebuild, and the `clearTodos` / `updateTodoItem` /
//! `dismissTodosAutoCleared` actions.
//!
//! - `task_snapshot`: the persisted tasks fill the gaps of `tasks` (a real
//!   task drops the provisional row of its tool_use; a known id is kept) and
//!   of `subagentMessages` (`buildSubagentMessages`, for a trail that is
//!   still empty). A task whose pill isn't in the transcript and isn't
//!   running is recovered (`loadUntilTasksFound`): older pages are loaded
//!   until its tool_use shows up, and at the top of the history a minimal
//!   assistant message carrying an `Agent` (or `Workflow`) tool_use stands
//!   in for it. Each page is looked at once it is folded in; the TS reads
//!   `messagesRef` / `hasMoreAboveRef`, which its commit updates only after
//!   the `await` has continued (the U01h `jumpToUuid` note), so in a
//!   browser it looks one page behind. That race isn't ported.
//! - `todos_auto_cleared`: the toast's `{ id, reason, count }`, with an id
//!   that strictly increases.
//! - `task_started` (the status seeded off a result that already landed,
//!   the provisional row's start carried over), `task_updated` (its
//!   `patch`), `task_progress`, `task_notification` (settles the task, or
//!   creates it) and `background_tasks_changed` (the `liveBackgroundTaskIds`
//!   gate, replaced wholesale, and the known tasks' `ambient` flag).
//! - Tool calls on the main thread: TodoWrite replaces `latestTodos`,
//!   TaskCreate adds a pending row keyed by its tool_use id, TaskUpdate
//!   changes (or deletes) a row in place, CronCreate arms a pending cron
//!   loop, CronDelete cancels one, ScheduleWakeup arms a wake-up (replacing
//!   the live ones, with the no-op streak carried) or, with `stop: true`,
//!   cancels the wake-ups armed before it, once per tool_use.
//! - Tool results: a CronCreate's result re-keys its loop under the real
//!   cron id with the human schedule, durability and `nextFireAt` (an error
//!   drops it), a TaskCreate's re-keys its row under `task.id` (an error
//!   drops it), and a TaskList's rebuilds `latestTodos`.
//! - Actions: `clear_todos` (POST `clear-todos`), `update_todo_item` (POST
//!   `todos/<item>`, whose outcome is an [`Effect::ActionResolved`]) and
//!   `dismiss_todos_auto_cleared`. Their failures are `console.warn`s
//!   ([`Effect::ConsoleWarn`]).
//!
//! Deliberate, with the crate's convention for fields the TS copies
//! unchecked: a non-string `task_id` / `taskId` keys the task as `""` (the
//! TS keys `"undefined"` / `"5"`); a non-string `task_notification`
//! `status` is `""` (the TS stores it as sent, which no reader matches
//! either); the other typed fields (`description`, `tool_use_id`,
//! `task_type`, the `usage` counts, the flags, `resource_links`, a
//! snapshot's `status` / `summary`, a TaskCreate result's `task.id`) read as
//! absent when they have another type, and `resource_links` keep only
//! `TaskResourceLink`'s keys. A `task_updated` whose `patch` isn't
//! an object changes nothing, a snapshot entry that isn't an object is
//! skipped, and a snapshot's `innerMessages` that isn't an array reads as
//! none: the TS throws inside a React updater on those, which takes the
//! tree down. A snapshot whose `tasks` isn't an array, or with a `null`
//! entry, is a bad payload with nothing changed (the TS logs the same
//! error, then the updater it queued takes the tree down). An `at` that
//! isn't a number arms a loop at `now` (U01e's convention).

use claudius_agent::js;
use claudius_core::js_string::encode_uri_component;
use indexmap::IndexSet;
use serde_json::{Value, json};

use crate::apply::Cx;
use crate::blocks::{ToolResultInfo, coerce_todos};
use crate::effect::{Action, Effect, FetchOutcome};
use crate::event::JsObject;
use crate::loops::{
    ScheduledLoop, ScheduledLoopKind, is_schedule_wakeup_stop, mark_wakeups_stopped,
    read_cron_next_fire_at,
};
use crate::messages::build_subagent_messages;
use crate::state::{ChatState, Then};
use crate::task_status::{
    TaskInfo, TaskResourceLink, drop_provisional_for_tool_use, find_tool_use_block,
    find_tool_use_block_sorted, seed_task_status, should_recover_orphan_task,
};
use crate::text::{AsciiCi, as_num, as_str, js_pattern, prop, to_js_string, truthy};
use crate::{
    AgentTodo, ClientEnv, DisplayBlock, DisplayMessage, JsThrow, Role, ToolResult, record_set,
};

/// How many pages `loadUntilTasksFound` loads at most.
const HUNT_PAGE_CAP: u32 = 200;

/// `/job\s+([a-z0-9]+)\s*\(([^)]+)\)/i`: the cron id and human schedule
/// in a CronCreate result ("Scheduled recurring job 1545ddb6 (Every
/// minute). ...").
static CRON_JOB: std::sync::LazyLock<AsciiCi> = std::sync::LazyLock::new(|| {
    AsciiCi::new(&js_pattern(r"job[{WS}]+([a-z0-9]+)[{WS}]*\(([^)]+)\)"))
});

/// `/session[- ]only/i`: a session-only (not durable) cron.
static SESSION_ONLY: std::sync::LazyLock<AsciiCi> =
    std::sync::LazyLock::new(|| AsciiCi::new(r"session[- ]only"));

/// What a todo action's reply continues with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TodosThen {
    /// `clearTodos`'s POST.
    Clear,
    /// `updateTodoItem(item_id, ...)`'s POST.
    Update { item_id: String },
}

/// `loadUntilTasksFound(tasks)` waiting for a page: the snapshot's
/// orphaned tasks (their tool_use id and entry as sent) and how many pages
/// it has loaded.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskHunt {
    pub tasks: Vec<(String, Value)>,
    pub pages: u32,
}

/// `a ?? b` with a default.
fn or_else(v: Option<&Value>, d: Value) -> Value {
    match v {
        None | Some(Value::Null) => d,
        Some(v) => v.clone(),
    }
}

fn opt_str(v: Option<&Value>) -> Option<String> {
    as_str(v).map(str::to_owned)
}

fn opt_bool(v: Option<&Value>) -> Option<bool> {
    v.and_then(Value::as_bool)
}

/// A typed `resource_links` (anything else reads as absent).
fn resource_links(v: Option<&Value>) -> Option<Vec<TaskResourceLink>> {
    v.and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// A task id the TS uses as a key (see the module docs).
fn key_of(v: Option<&Value>) -> String {
    as_str(v).unwrap_or_default().to_owned()
}

/// The `message` of a host's `"<name>: <message>"` fetch failure.
fn error_message(e: &str) -> &str {
    e.split_once(": ").map_or(e, |(_, m)| m)
}

impl ChatState {
    // --------------------------------------------------------- events

    /// `todos_auto_cleared`: the server cleared the to-do list on its own.
    pub(crate) fn on_todos_auto_cleared(&mut self, e: &JsObject, cx: &mut Cx<'_>) {
        let now = cx.env.now_ms();
        let base = prop(Some(&self.todos_auto_cleared), "id")
            .and_then(Value::as_f64)
            .unwrap_or(now);
        let id = if base + 1.0 > now { base + 1.0 } else { now };
        let mut toast = serde_json::Map::new();
        toast.insert("id".into(), crate::types::num::to_value(id));
        for key in ["reason", "count"] {
            if let Some(v) = e.get(key) {
                toast.insert(key.into(), v.clone());
            }
        }
        self.todos_auto_cleared = Value::Object(toast);
    }

    /// `dismissTodosAutoCleared()`.
    pub fn dismiss_todos_auto_cleared(&mut self) {
        self.todos_auto_cleared = Value::Null;
    }

    /// `task_snapshot`: the persisted tasks and subagent trails, filling
    /// only what the live replay didn't bring, and the orphaned pills.
    pub(crate) fn on_task_snapshot(
        &mut self,
        e: &JsObject,
        cx: &mut Cx<'_>,
    ) -> Result<(), JsThrow> {
        let entries = match e.get("tasks") {
            Some(Value::Array(items)) => items.as_slice(),
            None => {
                return Err(JsThrow::type_error(
                    "Cannot read properties of undefined (reading 'filter')",
                ));
            }
            Some(Value::Null) => return Err(JsThrow::read_of_null("filter")),
            Some(_) => return Err(JsThrow::type_error("ev.tasks.filter is not a function")),
        };
        if entries.iter().any(Value::is_null) {
            return Err(JsThrow::read_of_null("toolUseId"));
        }
        let entries: Vec<&Value> = entries.iter().filter(|t| t.is_object()).collect();
        for t in &entries {
            let t = Some(*t);
            let tool_use_id = as_str(prop(t, "toolUseId")).filter(|id| !id.is_empty());
            // A replayed Workflow ack's placeholder gives way to the real
            // task.
            if let Some(id) = tool_use_id
                && self
                    .tasks
                    .get(id)
                    .is_some_and(|p| p.provisional == Some(true))
            {
                self.tasks.shift_remove(id);
            }
            let task_id = key_of(prop(t, "taskId"));
            if self.tasks.contains_key(&task_id) {
                continue;
            }
            let description = as_str(prop(t, "description")).unwrap_or("(no description)");
            let status = as_str(prop(t, "status")).unwrap_or("completed");
            let mut task = TaskInfo::new(task_id.clone(), description, status);
            task.tool_use_id = opt_str(prop(t, "toolUseId"));
            task.task_type = opt_str(prop(t, "taskType"));
            task.workflow_name = opt_str(prop(t, "workflowName"));
            task.total_tokens = as_num(prop(t, "totalTokens"));
            task.tool_uses = as_num(prop(t, "toolUses"));
            task.duration_ms = as_num(prop(t, "durationMs"));
            task.summary = opt_str(prop(t, "summary"));
            task.error = opt_str(prop(t, "error"));
            task.resource_links = resource_links(prop(t, "resourceLinks"));
            task.reason = opt_str(prop(t, "reason"));
            task.output_file = opt_str(prop(t, "outputFile"));
            record_set(&mut self.tasks, &task_id, task);
        }
        for t in &entries {
            let t = Some(*t);
            let Some(id) = as_str(prop(t, "toolUseId")).filter(|id| !id.is_empty()) else {
                continue;
            };
            if self
                .subagent_messages
                .get(id)
                .is_some_and(|l| !l.is_empty())
            {
                continue;
            }
            let raw = match prop(t, "innerMessages") {
                Some(Value::Array(items)) => items.as_slice(),
                _ => &[],
            };
            let built = build_subagent_messages(raw, id, cx.env)?;
            if !built.is_empty() {
                record_set(&mut self.subagent_messages, id, built);
            }
        }
        // Pills the transcript doesn't hold: page back for them, or stand
        // in for the ones compaction dropped. (Only whether a block is
        // there: `messagesRef.current`'s order doesn't matter.)
        let messages = &self.messages;
        let unlinked: Vec<(String, Value)> = entries
            .iter()
            .filter_map(|t| {
                let id = as_str(prop(Some(*t), "toolUseId"))?;
                let status = as_str(prop(Some(*t), "status"));
                should_recover_orphan_task(Some(id), status, messages)
                    .then(|| (id.to_owned(), (*t).clone()))
            })
            .collect();
        self.hunt_step(
            TaskHunt {
                tasks: unlinked,
                pages: 0,
            },
            cx,
        );
        Ok(())
    }

    /// One turn of `loadUntilTasksFound`'s loop.
    fn hunt_step(&mut self, mut hunt: TaskHunt, cx: &mut Cx<'_>) {
        if hunt.pages >= HUNT_PAGE_CAP {
            return;
        }
        let messages = &self.messages;
        hunt.tasks
            .retain(|(id, _)| find_tool_use_block(id, &[messages]).is_none());
        if hunt.tasks.is_empty() {
            return;
        }
        if !truthy(self.has_more_above.as_ref()) {
            self.recover_orphans(&hunt.tasks);
            return;
        }
        hunt.pages += 1;
        // A `loadOlder` that returns at once (a page already in flight)
        // leaves the TS spinning on the same refs until its cap.
        self.start_older(Then::TaskPage(hunt), cx);
    }

    /// The page a [`TaskHunt`] asked for came back.
    pub(crate) fn task_page_settled(
        &mut self,
        hunt: TaskHunt,
        outcome: &FetchOutcome,
        cx: &mut Cx<'_>,
    ) {
        self.loading_older = false;
        match self.fold_older(outcome, cx) {
            // The hunt's promise rejects with `loadOlder`'s, and nothing
            // catches it.
            Err(error) => cx.out.push(Effect::UnhandledRejection { error }),
            Ok(()) => self.hunt_step(hunt, cx),
        }
    }

    /// The stand-in assistant messages for tasks whose tool_use compaction
    /// removed: an `Agent` (or, for a workflow, `Workflow`) tool_use with
    /// the recovered status as its result.
    fn recover_orphans(&mut self, tasks: &[(String, Value)]) {
        let fresh: Vec<DisplayMessage> = tasks
            .iter()
            .map(|(id, entry)| {
                let e = Some(entry);
                let is_workflow = as_str(prop(e, "taskType")) == Some("local_workflow");
                let input = if is_workflow {
                    json!({ "name": or_else(prop(e, "workflowName"), json!("Workflow")) })
                } else {
                    json!({
                        "subagent_type": or_else(prop(e, "taskType"), json!("Agent")),
                        "description": or_else(prop(e, "description"), json!("")),
                        "prompt": "",
                    })
                };
                let status = as_str(prop(e, "status"));
                let result = (status != Some("running")).then(|| ToolResult {
                    content: as_str(prop(e, "summary")).unwrap_or_default().to_owned(),
                    is_error: Some(status == Some("failed")),
                    ..Default::default()
                });
                let block = DisplayBlock::ToolUse {
                    id: id.clone(),
                    name: if is_workflow { "Workflow" } else { "Agent" }.into(),
                    input,
                    result,
                    started_at: None,
                };
                DisplayMessage::new(format!("recovered-task-{id}"), Role::Assistant, vec![block])
            })
            .filter(|m| !self.messages.iter().any(|s| s.uuid == m.uuid))
            .collect();
        self.messages.splice(0..0, fresh);
    }

    /// The `system` subtypes that drive `tasks` and the background-task
    /// gate (see the module docs).
    pub(crate) fn on_task_system(&mut self, msg: &Value, cx: &mut Cx<'_>) -> Result<(), JsThrow> {
        let m = Some(msg);
        let task_id = key_of(prop(m, "task_id"));
        match as_str(prop(m, "subtype")) {
            Some("task_started") => {
                let tool_use_id = as_str(prop(m, "tool_use_id"));
                // The Task's result may have landed first: seed its status.
                let block = match tool_use_id.filter(|id| !id.is_empty()) {
                    Some(id) => find_tool_use_block_sorted(id, &self.messages).cloned(),
                    None => None,
                };
                let status = seed_task_status(block.as_ref())?;
                // The provisional row's start carries over.
                let carried = drop_provisional_for_tool_use(&mut self.tasks, tool_use_id);
                let description = as_str(prop(m, "description")).unwrap_or("(no description)");
                let mut task = TaskInfo::new(task_id.clone(), description, status);
                task.tool_use_id = tool_use_id.map(str::to_owned);
                task.task_type = opt_str(prop(m, "task_type"));
                task.workflow_name = opt_str(prop(m, "workflow_name"));
                task.started_at = Some(carried.flatten().unwrap_or_else(|| cx.env.now_ms()));
                task.is_backgrounded = opt_bool(prop(m, "is_backgrounded"));
                task.spawn_depth = as_num(prop(m, "spawn_depth"));
                task.ambient = opt_bool(prop(m, "ambient"));
                task.skip_transcript = opt_bool(prop(m, "skip_transcript"));
                record_set(&mut self.tasks, &task_id, task);
            }
            Some("task_updated") => {
                let Some(t) = self.tasks.get_mut(&task_id) else {
                    return Ok(());
                };
                let patch = prop(m, "patch");
                if let Some(s) = as_str(prop(patch, "status")) {
                    t.status = s.to_owned();
                }
                if let Some(d) = as_str(prop(patch, "description")) {
                    t.description = d.to_owned();
                }
                if let Some(e) = opt_str(prop(patch, "error")) {
                    t.error = Some(e);
                }
                if let Some(b) = opt_bool(prop(patch, "is_backgrounded")) {
                    t.is_backgrounded = Some(b);
                }
                if let Some(n) = as_num(prop(patch, "total_paused_ms")) {
                    t.total_paused_ms = Some(n);
                }
            }
            Some("task_progress") => {
                let Some(t) = self.tasks.get_mut(&task_id) else {
                    return Ok(());
                };
                let usage = prop(m, "usage");
                if let Some(d) = as_str(prop(m, "description")) {
                    t.description = d.to_owned();
                }
                t.total_tokens = as_num(prop(usage, "total_tokens")).or(t.total_tokens);
                t.tool_uses = as_num(prop(usage, "tool_uses")).or(t.tool_uses);
                t.duration_ms = as_num(prop(usage, "duration_ms")).or(t.duration_ms);
                t.last_tool_name = opt_str(prop(m, "last_tool_name")).or(t.last_tool_name.take());
                t.summary = opt_str(prop(m, "summary")).or(t.summary.take());
            }
            Some("task_notification") => {
                // It may come without a `task_started`: the placeholder
                // goes, and the real task settles (or is made).
                let tool_use_id = as_str(prop(m, "tool_use_id"));
                drop_provisional_for_tool_use(&mut self.tasks, tool_use_id);
                let summary = opt_str(prop(m, "summary"));
                let ambient = opt_bool(prop(m, "ambient"));
                let mut t = self.tasks.get(&task_id).cloned().unwrap_or_else(|| {
                    let description = summary.as_deref().unwrap_or("(unknown)");
                    // Its `ambient` is the notification's (below).
                    let mut t = TaskInfo::new(task_id.clone(), description, "completed");
                    t.tool_use_id = tool_use_id.map(str::to_owned);
                    t
                });
                let usage = prop(m, "usage");
                t.status = as_str(prop(m, "status")).unwrap_or_default().to_owned();
                t.summary = summary.or(t.summary);
                t.total_tokens = as_num(prop(usage, "total_tokens")).or(t.total_tokens);
                t.tool_uses = as_num(prop(usage, "tool_uses")).or(t.tool_uses);
                t.duration_ms = as_num(prop(usage, "duration_ms")).or(t.duration_ms);
                t.ambient = ambient.or(t.ambient);
                t.resource_links = resource_links(prop(m, "resource_links")).or(t.resource_links);
                t.output_file = opt_str(prop(m, "output_file")).or(t.output_file);
                t.reason = opt_str(prop(m, "reason")).or(t.reason);
                record_set(&mut self.tasks, &task_id, t);
            }
            Some("background_tasks_changed") => {
                // `(payload.tasks ?? []).map((t) => t.task_id)`.
                let entries = match prop(m, "tasks") {
                    None | Some(Value::Null) => &[][..],
                    Some(Value::Array(items)) => items.as_slice(),
                    Some(_) => return Err(JsThrow::type_error("entries.map is not a function")),
                };
                if entries.iter().any(Value::is_null) {
                    return Err(JsThrow::read_of_null("task_id"));
                }
                let ids: IndexSet<String> = entries
                    .iter()
                    .filter_map(|t| as_str(prop(Some(t), "task_id")))
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .collect();
                self.live_background_task_ids = Some(ids);
                // A level signal over known tasks: their `ambient` flag.
                for entry in entries {
                    let Some(id) = as_str(prop(Some(entry), "task_id")) else {
                        continue;
                    };
                    let Some(t) = self.tasks.get_mut(id) else {
                        continue;
                    };
                    let ambient = prop(Some(entry), "ambient") == Some(&Value::Bool(true));
                    if (t.ambient == Some(true)) != ambient {
                        t.ambient = Some(ambient);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    // ------------------------------------------------------- tool calls

    /// The assistant handler's todo and loop branches for one main-thread
    /// tool_use.
    pub(crate) fn task_tool_use(
        &mut self,
        id: &str,
        name: &str,
        input: &Value,
        at: Option<f64>,
        now: f64,
    ) {
        let input = Some(input);
        let started_at = at.unwrap_or(now);
        match name {
            "TodoWrite" => {
                if let Some(Value::Array(raw)) = prop(input, "todos") {
                    self.latest_todos = coerce_todos(raw);
                }
            }
            "TaskCreate" => {
                if self.latest_todos.iter().any(|t| t.id == id) {
                    return;
                }
                self.latest_todos.push(AgentTodo {
                    id: id.to_owned(),
                    content: as_str(prop(input, "subject"))
                        .unwrap_or_default()
                        .to_owned(),
                    status: "pending".into(),
                    active_form: opt_str(prop(input, "activeForm")),
                });
            }
            "TaskUpdate" => {
                let Some(task_id) = as_str(prop(input, "taskId")).filter(|t| !t.is_empty()) else {
                    return;
                };
                let Some(idx) = self.latest_todos.iter().position(|t| t.id == task_id) else {
                    return;
                };
                let status = as_str(prop(input, "status"));
                if status == Some("deleted") {
                    self.latest_todos.remove(idx);
                    return;
                }
                let row = &mut self.latest_todos[idx];
                if let Some(s) = status.filter(|s| !s.is_empty()) {
                    row.status = s.to_owned();
                }
                if let Some(s) = as_str(prop(input, "subject")).filter(|s| !s.is_empty()) {
                    row.content = s.to_owned();
                }
            }
            "CronCreate" => {
                let Some(cron) = as_str(prop(input, "cron")).filter(|c| !c.is_empty()) else {
                    return;
                };
                // Already armed, or already promoted under its cron id.
                if self.scheduled_loops.contains_key(id)
                    || self.scheduled_loops.values().any(|l| l.tool_use_id == id)
                {
                    return;
                }
                let entry = ScheduledLoop {
                    kind: ScheduledLoopKind::Cron,
                    id: id.to_owned(),
                    tool_use_id: id.to_owned(),
                    cron: Some(cron.to_owned()),
                    human_schedule: None,
                    delay_seconds: None,
                    prompt: as_str(prop(input, "prompt")).unwrap_or_default().to_owned(),
                    reason: None,
                    recurring: prop(input, "recurring") == Some(&Value::Bool(true)),
                    durable: false,
                    started_at,
                    noop: None,
                    noop_streak: None,
                    next_fire_at: None,
                    cancelled: None,
                };
                record_set(&mut self.scheduled_loops, id, entry);
            }
            "CronDelete" => {
                let Some(cron_id) = as_str(prop(input, "id")).filter(|c| !c.is_empty()) else {
                    return;
                };
                if let Some(l) = self.scheduled_loops.get_mut(cron_id) {
                    l.cancelled = Some(true);
                }
            }
            "ScheduleWakeup" => {
                if is_schedule_wakeup_stop(input) {
                    // Once per tool_use, and only for the wake-ups armed
                    // before it (a replayed tail can't cancel a newer one).
                    if self.applied_wakeup_stops.insert(id.to_owned()) {
                        mark_wakeups_stopped(&mut self.scheduled_loops, Some(started_at));
                    }
                    return;
                }
                if self.scheduled_loops.contains_key(id) {
                    return;
                }
                let noop = prop(input, "noop") == Some(&Value::Bool(true));
                // Only the newest wake-up is armed; a quiet tick inherits
                // the streak of the one it replaces.
                let mut streak = 0.0_f64;
                self.scheduled_loops.retain(|_, v| {
                    let live = v.kind == ScheduledLoopKind::Wakeup && v.cancelled != Some(true);
                    if live && noop {
                        streak = streak.max(v.noop_streak.unwrap_or(0.0) + 1.0);
                    }
                    !live
                });
                if noop && streak == 0.0 {
                    streak = 1.0;
                }
                let entry = ScheduledLoop {
                    kind: ScheduledLoopKind::Wakeup,
                    id: id.to_owned(),
                    tool_use_id: id.to_owned(),
                    cron: None,
                    human_schedule: None,
                    delay_seconds: as_num(prop(input, "delaySeconds")),
                    prompt: as_str(prop(input, "prompt")).unwrap_or_default().to_owned(),
                    reason: opt_str(prop(input, "reason")),
                    recurring: false,
                    durable: false,
                    started_at,
                    noop: noop.then_some(true),
                    noop_streak: noop.then_some(streak),
                    next_fire_at: None,
                    cancelled: None,
                };
                record_set(&mut self.scheduled_loops, id, entry);
            }
            _ => {}
        }
    }

    /// A tool result's todo and loop side effects. `name` is the tool the
    /// result answers, as the transcript showed it (`""` for none).
    pub(crate) fn task_tool_result(&mut self, msg: &Value, r: &ToolResultInfo, name: &str) {
        let id = r.tool_use_id.as_str();
        let failed = r.is_error == Some(true);
        // CronCreate: the pending loop moves under its real cron id.
        if let Some(pending) = self
            .scheduled_loops
            .get(id)
            .filter(|l| l.kind == ScheduledLoopKind::Cron)
            .cloned()
        {
            self.scheduled_loops.shift_remove(id);
            if !failed {
                let m = CRON_JOB.captures(&r.text);
                let group = |i: usize| {
                    m.as_ref()
                        .and_then(|c| c[i])
                        .map(|(s, e)| r.text[s..e].to_owned())
                };
                let cron_id = group(1).unwrap_or_else(|| pending.tool_use_id.clone());
                let mut promoted = pending;
                promoted.id = cron_id.clone();
                promoted.human_schedule = group(2);
                promoted.durable = !SESSION_ONLY.is_match(&r.text);
                if let Some(at) = read_cron_next_fire_at(prop(Some(msg), "tool_use_result")) {
                    promoted.next_fire_at = Some(at);
                }
                record_set(&mut self.scheduled_loops, &cron_id, promoted);
            }
        }
        // TaskCreate: the pending row takes the real task id.
        if let Some(idx) = self.latest_todos.iter().position(|t| t.id == id) {
            if failed {
                self.latest_todos.remove(idx);
            } else if let Ok(payload) = claudius_core::js_string::parse(&r.text)
                && let Some(real) =
                    as_str(prop(prop(Some(&payload), "task"), "id")).filter(|s| !s.is_empty())
            {
                self.latest_todos[idx].id = real.to_owned();
            }
        }
        // TaskList: the SDK's own list rebuilds the rail.
        if name == "TaskList"
            && !failed
            && let Some(parsed) = claudius_core::todos::parse_task_list_result(Some(&r.text))
        {
            self.latest_todos = coerce_todos(&parsed);
        }
    }

    // ---------------------------------------------------------- actions

    /// `clearTodos()`: ask the server to clear the to-do list; its
    /// `session_snapshot` does the clearing. Failures are only logged.
    pub fn clear_todos(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.session_id.clone().filter(|s| !s.is_empty()) else {
            return cx.out;
        };
        self.fetch(
            &mut cx,
            "POST",
            format!("/api/sessions/{id}/clear-todos"),
            Vec::new(),
            None,
            Then::Todos(TodosThen::Clear),
        );
        cx.out
    }

    /// `updateTodoItem(itemId, action)`: one row's edit (`complete`,
    /// `reopen`, `in_progress`, `delete`), which the server's
    /// `session_snapshot` applies. The outcome is an
    /// [`Effect::ActionResolved`] (`Action::UpdateTodoItem`).
    pub fn update_todo_item(
        &mut self,
        item_id: &str,
        action: &str,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let done = |out: &mut Vec<Effect>, outcome: Result<(), Value>| {
            out.push(todo_item_updated(item_id.to_owned(), outcome));
        };
        let Some(id) = self.session_id.clone().filter(|s| !s.is_empty()) else {
            done(&mut cx.out, Err(json!("no active session")));
            return cx.out;
        };
        // `encodeURIComponent` throws inside the `try`.
        let Some(item) = encode_uri_component(item_id) else {
            let msg = "URI malformed";
            cx.out.push(Effect::ConsoleWarn {
                text: format!("[updateTodoItem] network error {msg}"),
            });
            done(&mut cx.out, Err(json!(msg)));
            return cx.out;
        };
        let body = js::stringify(&json!({ "action": action }));
        self.fetch(
            &mut cx,
            "POST",
            format!("/api/sessions/{id}/todos/{item}"),
            vec![("Content-Type", "application/json")],
            Some(body),
            Then::Todos(TodosThen::Update {
                item_id: item_id.to_owned(),
            }),
        );
        cx.out
    }

    /// A todo action's reply.
    pub(crate) fn todos_settled(
        &mut self,
        then: TodosThen,
        outcome: &FetchOutcome,
        cx: &mut Cx<'_>,
    ) {
        let warn = |out: &mut Vec<Effect>, text: String| out.push(Effect::ConsoleWarn { text });
        match then {
            TodosThen::Clear => match outcome {
                FetchOutcome::Failed(e) => {
                    warn(&mut cx.out, format!("[clearTodos] network error {e}"));
                }
                FetchOutcome::Response { status, .. } if !outcome.ok() => {
                    let shown = reply_error(outcome).and_then(|e| match e {
                        None => Ok("no body".to_owned()),
                        Some(e) => to_js_string(&e).map_err(|t| t.to_string()),
                    });
                    let text = match shown {
                        Ok(shown) => format!("[clearTodos] server returned {status}: {shown}"),
                        // The `catch` logs the error itself.
                        Err(e) => format!("[clearTodos] network error {e}"),
                    };
                    warn(&mut cx.out, text);
                }
                FetchOutcome::Response { .. } => {}
            },
            TodosThen::Update { item_id } => {
                let outcome = match outcome {
                    FetchOutcome::Failed(e) => {
                        let msg = error_message(e);
                        warn(&mut cx.out, format!("[updateTodoItem] network error {msg}"));
                        Err(json!(msg))
                    }
                    FetchOutcome::Response { status, .. } if !outcome.ok() => {
                        let shown = reply_error(outcome).and_then(|e| {
                            let msg = e.unwrap_or_else(|| json!(format!("HTTP {status}")));
                            let shown = to_js_string(&msg).map_err(|t| t.to_string())?;
                            Ok((msg, shown))
                        });
                        match shown {
                            Ok((msg, shown)) => {
                                let text =
                                    format!("[updateTodoItem] server returned {status}: {shown}");
                                warn(&mut cx.out, text);
                                Err(msg)
                            }
                            // The `catch` reports the error's message.
                            Err(e) => {
                                let msg = error_message(&e);
                                warn(&mut cx.out, format!("[updateTodoItem] network error {msg}"));
                                Err(json!(msg))
                            }
                        }
                    }
                    FetchOutcome::Response { .. } => Ok(()),
                };
                cx.out.push(todo_item_updated(item_id, outcome));
            }
        }
    }
}

/// `updateTodoItem`'s promise value: `{ ok: true }` or `{ ok: false, error }`.
fn todo_item_updated(item_id: String, outcome: Result<(), Value>) -> Effect {
    Effect::ActionResolved {
        action: Action::UpdateTodoItem { item_id },
        outcome: match outcome {
            Ok(()) => json!({ "ok": true }),
            Err(error) => json!({ "ok": false, "error": error }),
        },
    }
}

/// `(await res.json().catch(() => ({}))).error` of a failed reply (`None`
/// for a missing or `null` one); `Err` for a `null` body, whose property
/// read throws.
fn reply_error(outcome: &FetchOutcome) -> Result<Option<Value>, String> {
    let body = outcome.json().unwrap_or_else(|| json!({}));
    if body.is_null() {
        return Err("TypeError: Cannot read properties of null (reading 'error')".into());
    }
    Ok(prop(Some(&body), "error").filter(|e| !e.is_null()).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;

    fn sdk(s: &mut ChatState, message: Value) -> Vec<Effect> {
        let mut env = FixedEnv::new(1000.0);
        let data = json!({ "type": "sdk", "message": message, "at": 5 }).to_string();
        s.on_message(&data, &mut env)
    }

    fn task(subtype: &str, extra: Value) -> Value {
        let mut m = json!({ "type": "system", "subtype": subtype, "uuid": subtype });
        m.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        m
    }

    fn bad(fx: &[Effect]) -> Option<String> {
        match fx {
            [Effect::BadPayload { error }] => Some(error.to_string()),
            _ => None,
        }
    }

    /// The recorder sends the server's types only; these are the crate's
    /// reads of the odd ones (see the module docs).
    #[test]
    fn odd_task_fields_read_as_absent() {
        let mut s = ChatState::new("tab-1");
        sdk(
            &mut s,
            task(
                "task_started",
                json!({ "task_id": 5, "tool_use_id": 7, "description": 5, "task_type": null,
                        "spawn_depth": "2", "is_backgrounded": "yes" }),
            ),
        );
        let t = &s.tasks[""];
        assert_eq!(
            (
                t.task_id.as_str(),
                t.description.as_str(),
                t.status.as_str()
            ),
            ("", "(no description)", "running")
        );
        assert_eq!(
            (t.tool_use_id.as_ref(), t.task_type.as_ref(), t.spawn_depth),
            (None, None, None)
        );
        assert_eq!((t.is_backgrounded, t.started_at), (None, Some(1000.0)));
        // A patch that isn't an object changes nothing.
        let before = s.tasks.clone();
        sdk(
            &mut s,
            task("task_updated", json!({ "task_id": 5, "patch": 5 })),
        );
        sdk(&mut s, task("task_updated", json!({ "task_id": 5 })));
        sdk(
            &mut s,
            task(
                "task_progress",
                json!({ "task_id": 5, "description": 5, "usage": { "total_tokens": "9" },
                        "last_tool_name": 7, "summary": 8 }),
            ),
        );
        assert_eq!(s.tasks, before);
        // A notification's status is kept as a string, `""` otherwise.
        sdk(
            &mut s,
            task(
                "task_notification",
                json!({ "task_id": "n", "status": 5, "resource_links": [{ "uri": 5 }] }),
            ),
        );
        assert_eq!(s.tasks["n"].status, "");
        assert_eq!(s.tasks["n"].description, "(unknown)");
        assert_eq!(s.tasks["n"].resource_links, None);
        sdk(
            &mut s,
            task(
                "task_notification",
                json!({ "task_id": "n", "status": "completed",
                        "resource_links": [{ "uri": "u", "name": "n", "extra": 1 }] }),
            ),
        );
        let links = s.tasks["n"].resource_links.as_ref().unwrap();
        assert_eq!(
            serde_json::to_value(links).unwrap(),
            json!([{ "uri": "u", "name": "n" }])
        );
    }

    #[test]
    fn odd_snapshots_are_bad_payloads_or_skipped() {
        let mut s = ChatState::new("tab-1");
        let mut env = FixedEnv::new(1.0);
        let mut snap = |s: &mut ChatState, tasks: Option<Value>| {
            let mut ev = json!({ "type": "task_snapshot" });
            if let Some(t) = tasks {
                ev["tasks"] = t;
            }
            bad(&s.on_message(&ev.to_string(), &mut env))
        };
        let undefined = "TypeError: Cannot read properties of undefined (reading 'filter')";
        assert_eq!(snap(&mut s, None).as_deref(), Some(undefined));
        assert_eq!(
            snap(&mut s, Some(Value::Null)).as_deref(),
            Some("TypeError: Cannot read properties of null (reading 'filter')")
        );
        assert_eq!(
            snap(&mut s, Some(json!("ab"))).as_deref(),
            Some("TypeError: ev.tasks.filter is not a function")
        );
        let with_null = json!([{ "taskId": "a", "status": "completed" }, null]);
        assert_eq!(
            snap(&mut s, Some(with_null)).as_deref(),
            Some("TypeError: Cannot read properties of null (reading 'toolUseId')")
        );
        assert!(s.tasks.is_empty(), "nothing changed before the throw");
        // Entries that aren't objects are skipped; an odd `innerMessages`
        // reads as none; an odd status / summary as absent.
        let odd = json!([5, "x", { "taskId": "a", "toolUseId": "toolu_A", "status": 5,
                                    "summary": 6, "innerMessages": "ab" }]);
        assert_eq!(snap(&mut s, Some(odd)), None);
        assert_eq!(s.tasks.keys().collect::<Vec<_>>(), ["a"]);
        assert_eq!(s.tasks["a"].status, "completed");
        assert!(s.subagent_messages.is_empty());
        // Recovered at the top of the history: no status is "completed"
        // for the result, and an odd summary is an empty one.
        let DisplayBlock::ToolUse { result, input, .. } = &s.messages[0].blocks[0] else {
            panic!("{:?}", s.messages);
        };
        assert_eq!(result.as_ref().unwrap().content, "");
        assert_eq!(result.as_ref().unwrap().is_error, Some(false));
        assert_eq!(input["subagent_type"], json!("Agent"));
        // A trail that throws is a bad payload too (the TS throws inside
        // its updater).
        let throws = json!([{ "taskId": "b", "toolUseId": "toolu_B", "innerMessages": [null] }]);
        assert!(snap(&mut s, Some(throws)).is_some());
    }

    /// `loadUntilTasksFound` with history above: unrecordable (under
    /// `act()` the hook re-fetches one page up to 200 times).
    #[test]
    fn orphans_page_back_until_their_pill_shows() {
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("sess-1".into());
        s.has_more_above = Some(json!(true));
        let mut env = FixedEnv::new(1.0);
        let snap = json!({ "type": "task_snapshot", "tasks": [
            { "taskId": "a", "toolUseId": "toolu_A", "status": "completed", "innerMessages": [] },
            { "taskId": "b", "toolUseId": "toolu_B", "status": "completed", "innerMessages": [] },
        ] })
        .to_string();
        let fx = s.on_message(&snap, &mut env);
        let [Effect::Fetch(req)] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        assert_eq!(req.url, "/api/sessions/sess-1/transcript?limit=50");
        assert!(s.loading_older);
        // The page holds toolu_A's pill, and there is more above.
        let page = json!({ "hasMore": true, "messages": [
            { "type": "assistant", "uuid": "p1", "timestamp": "2025-11-16T12:00:00.000Z",
              "message": { "id": "msg_P1", "role": "assistant",
                           "content": [{ "type": "tool_use", "id": "toolu_A", "name": "Agent", "input": {} }] } },
        ] });
        let ok = |body: &Value| FetchOutcome::Response {
            status: 200,
            body: body.to_string(),
        };
        let fx = s.fetch_settled(req.id, ok(&page), &mut env);
        let [Effect::Fetch(req)] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        assert!(
            req.url.ends_with("transcript?before=p1&limit=50"),
            "{}",
            req.url
        );
        // The top of the history: toolu_B gets a stand-in, toolu_A doesn't.
        let top = json!({ "hasMore": false, "messages": [
            { "type": "user", "uuid": "p0", "timestamp": "2025-11-16T11:00:00.000Z",
              "message": { "role": "user", "content": "hi" } },
        ] });
        assert!(s.fetch_settled(req.id, ok(&top), &mut env).is_empty());
        let uuids: Vec<&str> = s.messages.iter().map(|m| m.uuid.as_str()).collect();
        assert_eq!(uuids, ["recovered-task-toolu_B", "p0", "msg_P1"]);
        assert!(!s.loading_older);

        // A failing page rejects the hunt, which nothing catches.
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("sess-1".into());
        s.has_more_above = Some(json!(true));
        let fx = s.on_message(&snap, &mut env);
        let [Effect::Fetch(req)] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        let fx = s.fetch_settled(
            req.id,
            FetchOutcome::Failed("TypeError: x".into()),
            &mut env,
        );
        assert_eq!(
            fx,
            vec![Effect::UnhandledRejection {
                error: "TypeError: x".into()
            }]
        );
        assert!(s.messages.is_empty());
        // A page already in flight: the hunt gives up without a stand-in.
        s.loading_older = true;
        assert!(s.on_message(&snap, &mut env).is_empty());
        assert!(s.messages.is_empty());
        // No session: no page either.
        s.loading_older = false;
        s.session_id = None;
        assert!(s.on_message(&snap, &mut env).is_empty());
        // The cap: after the last page the TS loop ends without a look.
        s.session_id = Some("sess-1".into());
        let hunt = TaskHunt {
            tasks: vec![("toolu_A".into(), json!({ "status": "completed" }))],
            pages: HUNT_PAGE_CAP,
        };
        s.has_more_above = Some(json!(false));
        let mut cx = Cx::new(&mut env);
        s.hunt_step(hunt.clone(), &mut cx);
        assert!(cx.out.is_empty());
        assert!(s.messages.is_empty());
        s.hunt_step(
            TaskHunt {
                pages: HUNT_PAGE_CAP - 1,
                ..hunt
            },
            &mut cx,
        );
        assert_eq!(s.messages[0].uuid, "recovered-task-toolu_A");
    }

    #[test]
    fn the_hunt_stops_once_found_or_after_200_pages() {
        let mut env = FixedEnv::new(1.0);
        let fresh = || {
            let mut s = ChatState::new("tab-1");
            s.session_id = Some("sess-1".into());
            s.has_more_above = Some(json!(true));
            s
        };
        let snap = json!({ "type": "task_snapshot", "tasks": [
            { "taskId": "a", "toolUseId": "toolu_A", "status": "completed", "innerMessages": [] },
        ] })
        .to_string();
        let page = |uuid: String, tool: &str| {
            FetchOutcome::Response {
            status: 200,
            body: json!({ "hasMore": true, "messages": [
                { "type": "assistant", "uuid": uuid.clone(),
                  "message": { "id": format!("msg_{uuid}"), "role": "assistant",
                               "content": [{ "type": "tool_use", "id": tool, "name": "Agent", "input": {} }] } },
            ] })
            .to_string(),
        }
        };
        // Found with more above: no further page.
        let mut s = fresh();
        let fx = s.on_message(&snap, &mut env);
        let [Effect::Fetch(req)] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        assert!(
            s.fetch_settled(req.id, page("p1".into(), "toolu_A"), &mut env)
                .is_empty()
        );
        // Never found: 200 pages, then the loop ends without a stand-in.
        let mut s = fresh();
        let mut fx = s.on_message(&snap, &mut env);
        let mut pages = 0;
        while let [Effect::Fetch(req)] = fx.as_slice() {
            pages += 1;
            fx = s.fetch_settled(req.id, page(format!("p{pages}"), "toolu_X"), &mut env);
        }
        assert!(fx.is_empty(), "{fx:?}");
        assert_eq!(pages, 200);
        assert!(
            s.messages
                .iter()
                .all(|m| !m.uuid.starts_with("recovered-task-"))
        );
    }

    #[test]
    fn actions_need_a_truthy_session() {
        let mut s = ChatState::new("tab-1");
        let mut env = FixedEnv::new(1.0);
        for id in [None, Some(String::new())] {
            s.session_id = id;
            assert!(s.clear_todos(&mut env).is_empty());
            assert_eq!(
                s.update_todo_item("t0", "complete", &mut env),
                vec![Effect::ActionResolved {
                    action: Action::UpdateTodoItem {
                        item_id: "t0".into()
                    },
                    outcome: json!({ "ok": false, "error": "no active session" }),
                }]
            );
        }
        // The edit's request: the item id encoded, the action as JSON.
        s.session_id = Some("sess-1".into());
        let fx = s.update_todo_item("a/b c", "delete", &mut env);
        let [Effect::Fetch(req)] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        assert_eq!(req.url, "/api/sessions/sess-1/todos/a%2Fb%20c");
        assert_eq!(req.body.as_deref(), Some(r#"{"action":"delete"}"#));
        assert_eq!(req.headers, vec![("Content-Type", "application/json")]);
        let fx = s.clear_todos(&mut env);
        let [Effect::Fetch(req)] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        assert_eq!((req.method, req.body.as_ref()), ("POST", None));
        assert!(req.headers.is_empty());
    }

    #[test]
    fn odd_tool_inputs_and_results() {
        let mut s = ChatState::new("tab-1");
        s.latest_todos = coerce_todos(&[json!({ "id": "toolu_A", "content": "x" })]);
        // A non-string `task.id` leaves the temp id.
        let r = ToolResultInfo {
            tool_use_id: "toolu_A".into(),
            text: r#"{"task":{"id":5}}"#.into(),
            is_error: None,
            staged: false,
            detached: false,
            not_run: false,
        };
        s.task_tool_result(&json!({}), &r, "TaskCreate");
        assert_eq!(s.latest_todos[0].id, "toolu_A");
        // A loop armed without a usable `at` starts at now.
        s.task_tool_use(
            "toolu_C",
            "CronCreate",
            &json!({ "cron": "* * * * *" }),
            None,
            42.0,
        );
        assert_eq!(s.scheduled_loops["toolu_C"].started_at, 42.0);
        // A stop without `at` cancels what was armed up to now.
        s.task_tool_use("toolu_W", "ScheduleWakeup", &json!({}), Some(40.0), 42.0);
        s.task_tool_use(
            "toolu_S",
            "ScheduleWakeup",
            &json!({ "stop": true }),
            None,
            39.0,
        );
        assert_eq!(s.scheduled_loops["toolu_W"].cancelled, None);
        s.task_tool_use(
            "toolu_S2",
            "ScheduleWakeup",
            &json!({ "stop": true }),
            None,
            40.0,
        );
        assert_eq!(s.scheduled_loops["toolu_W"].cancelled, Some(true));
        // A wake-up's result never promotes it.
        let r = ToolResultInfo {
            tool_use_id: "toolu_W".into(),
            text: "job 1 (x)".into(),
            ..r
        };
        s.task_tool_result(&json!({}), &r, "ScheduleWakeup");
        assert!(s.scheduled_loops.contains_key("toolu_W"));
    }

    #[test]
    fn the_auto_cleared_toast_id_strictly_increases() {
        let mut s = ChatState::new("tab-1");
        let mut env = FixedEnv::new(100.0);
        let ev = r#"{"type":"todos_auto_cleared","reason":"stale","count":2}"#;
        s.on_message(ev, &mut env);
        assert_eq!(
            s.todos_auto_cleared,
            json!({ "id": 101, "reason": "stale", "count": 2 })
        );
        s.on_message(ev, &mut env);
        assert_eq!(s.todos_auto_cleared["id"], json!(102));
        env.now = 102.0;
        s.on_message(ev, &mut env);
        assert_eq!(s.todos_auto_cleared["id"], json!(103));
        env.now = 500.0;
        s.on_message(r#"{"type":"todos_auto_cleared"}"#, &mut env);
        assert_eq!(s.todos_auto_cleared, json!({ "id": 500 }));
        s.dismiss_todos_auto_cleared();
        assert_eq!(s.todos_auto_cleared, Value::Null);
    }
}
