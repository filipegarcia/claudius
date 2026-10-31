//! Per-session subagent (Task) records (`session_tasks`), port of
//! `lib/server/session-tasks-db.ts`.
//!
//! Task counters, status and the subagent's inner conversation ride on
//! SSE-only events (`task_progress` / `task_notification`, messages tagged
//! with `parent_tool_use_id`) that never reach the CLI's JSONL, so a session
//! rebuilt from disk would lose them. The session upserts them here and
//! replays them through `task_snapshot` on subscribe.

use claudius_agent::js;
use rusqlite::types::ValueRef;
use rusqlite::{Row, params};
use serde_json::{Map, Value, json};

use crate::db::{Mode, open_db};
use crate::{js_num, now_ms};

/// `TaskSnapshotEntry`: one task as the session tracks it and as
/// `task_snapshot` carries it. Numbers are JS numbers; `None` is
/// `undefined` (left out of the JSON).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TaskEntry {
    pub task_id: String,
    /// The parent Task `tool_use` id: the client's join key.
    pub tool_use_id: Option<String>,
    /// Never set by the session (TS doesn't either); kept for the row shape.
    pub subagent_type: Option<String>,
    pub description: Option<String>,
    pub task_type: Option<String>,
    pub workflow_name: Option<String>,
    pub status: String,
    pub total_tokens: Option<f64>,
    pub tool_uses: Option<f64>,
    pub duration_ms: Option<f64>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub is_backgrounded: Option<bool>,
    pub spawn_depth: Option<f64>,
    pub ambient: Option<bool>,
    /// Whatever the SDK sent; stored (as JSON) only when truthy, read back
    /// only when it's an array.
    pub resource_links: Option<Value>,
    pub reason: Option<String>,
    pub output_file: Option<String>,
    /// `{at?, message}` envelopes of the subagent's conversation.
    pub inner_messages: Vec<Value>,
}

impl TaskEntry {
    /// The wire shape, keys in `rowToEntry`'s order.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("taskId".into(), json!(self.task_id));
        let mut put = |k: &str, v: Option<Value>| {
            if let Some(v) = v {
                m.insert(k.into(), v);
            }
        };
        let s = |v: &Option<String>| v.as_ref().map(|s| json!(s));
        let n = |v: Option<f64>| v.map(js_num);
        put("toolUseId", s(&self.tool_use_id));
        put("subagentType", s(&self.subagent_type));
        put("description", s(&self.description));
        put("taskType", s(&self.task_type));
        put("workflowName", s(&self.workflow_name));
        put("status", Some(json!(self.status)));
        put("totalTokens", n(self.total_tokens));
        put("toolUses", n(self.tool_uses));
        put("durationMs", n(self.duration_ms));
        put("summary", s(&self.summary));
        put("error", s(&self.error));
        put("isBackgrounded", self.is_backgrounded.map(Value::Bool));
        put("spawnDepth", n(self.spawn_depth));
        put("ambient", self.ambient.map(Value::Bool));
        put("resourceLinks", self.resource_links.clone());
        put("reason", s(&self.reason));
        put("outputFile", s(&self.output_file));
        put(
            "innerMessages",
            Some(Value::Array(self.inner_messages.clone())),
        );
        Value::Object(m)
    }
}

/// `saveSessionTask`: upsert the task's row (best effort: no database, no
/// row).
pub fn save_session_task(cwd: &str, session_id: &str, task: &TaskEntry) -> anyhow::Result<()> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let flag = |b: Option<bool>| b.map(i64::from);
    let links = task
        .resource_links
        .as_ref()
        .filter(|v| js::truthy(v))
        .map(js::stringify);
    db.with(|c| {
        c.execute(
            "INSERT INTO session_tasks(
               session_id, task_id, tool_use_id, subagent_type, description,
               task_type, workflow_name, status, total_tokens, tool_uses,
               duration_ms, summary, error, inner_messages, is_backgrounded,
               spawn_depth, ambient, resource_links, reason, output_file, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, task_id) DO UPDATE SET
               tool_use_id     = excluded.tool_use_id,
               subagent_type   = excluded.subagent_type,
               description     = excluded.description,
               task_type       = excluded.task_type,
               workflow_name   = excluded.workflow_name,
               status          = excluded.status,
               total_tokens    = excluded.total_tokens,
               tool_uses       = excluded.tool_uses,
               duration_ms     = excluded.duration_ms,
               summary         = excluded.summary,
               error           = excluded.error,
               inner_messages  = excluded.inner_messages,
               is_backgrounded = excluded.is_backgrounded,
               spawn_depth     = excluded.spawn_depth,
               ambient         = excluded.ambient,
               resource_links  = excluded.resource_links,
               reason          = excluded.reason,
               output_file     = excluded.output_file,
               updated_at      = excluded.updated_at",
            params![
                session_id,
                task.task_id,
                task.tool_use_id,
                task.subagent_type,
                task.description,
                task.task_type,
                task.workflow_name,
                task.status,
                task.total_tokens,
                task.tool_uses,
                task.duration_ms,
                task.summary,
                task.error,
                js::stringify(&Value::Array(task.inner_messages.clone())),
                flag(task.is_backgrounded),
                task.spawn_depth,
                flag(task.ambient),
                links,
                task.reason,
                task.output_file,
                now_ms(),
            ],
        )
    })?;
    Ok(())
}

/// `listSessionTasks`: the session's tasks, oldest update first; `[]`
/// without a database.
pub fn list_session_tasks(cwd: &str, session_id: &str) -> Vec<TaskEntry> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return vec![];
    };
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT task_id, tool_use_id, subagent_type, description, task_type,
                    workflow_name, status, total_tokens, tool_uses, duration_ms,
                    summary, error, inner_messages, is_backgrounded, spawn_depth,
                    ambient, resource_links, reason, output_file
               FROM session_tasks
              WHERE session_id = ?
              ORDER BY updated_at ASC",
        )?;
        let rows = st.query_map(params![session_id], row_to_entry)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap_or_default()
}

/// `rowToEntry`. The INTEGER columns are read leniently: a value SQLite
/// kept as text (TS hands it back raw) reads as no number rather than
/// failing the whole list.
fn row_to_entry(r: &Row) -> rusqlite::Result<TaskEntry> {
    let num = |i: usize| -> rusqlite::Result<Option<f64>> {
        Ok(match r.get_ref(i)? {
            ValueRef::Integer(n) => Some(n as f64),
            ValueRef::Real(f) => Some(f),
            _ => None,
        })
    };
    // `v == null ? undefined : v !== 0`. INTEGER affinity stores a whole
    // REAL as an integer, so a REAL (or text) left in the column is never 0.
    let flag = |i: usize| -> rusqlite::Result<Option<bool>> {
        Ok(match r.get_ref(i)? {
            ValueRef::Null => None,
            ValueRef::Integer(n) => Some(n != 0),
            _ => Some(true),
        })
    };
    Ok(TaskEntry {
        task_id: r.get(0)?,
        tool_use_id: r.get(1)?,
        subagent_type: r.get(2)?,
        description: r.get(3)?,
        task_type: r.get(4)?,
        workflow_name: r.get(5)?,
        status: r
            .get::<_, Option<String>>(6)?
            .unwrap_or_else(|| "completed".into()),
        total_tokens: num(7)?,
        tool_uses: num(8)?,
        duration_ms: num(9)?,
        summary: r.get(10)?,
        error: r.get(11)?,
        inner_messages: parse_inner_messages(&r.get::<_, String>(12)?),
        is_backgrounded: flag(13)?,
        spawn_depth: num(14)?,
        ambient: flag(15)?,
        resource_links: parse_resource_links(r.get(16)?),
        reason: r
            .get::<_, Option<String>>(17)?
            .filter(|r| r == "worker_restart"),
        output_file: r.get(18)?,
    })
}

/// `parseInnerMessages`: a JSON array, keeping only objects with a
/// `message` key; anything else reads as `[]`.
fn parse_inner_messages(raw: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => items
            .into_iter()
            .filter(|x| x.as_object().is_some_and(|o| o.contains_key("message")))
            .collect(),
        _ => vec![],
    }
}

/// `parseResourceLinks`: an array, or nothing.
fn parse_resource_links(raw: Option<String>) -> Option<Value> {
    let raw = raw.filter(|r| !r.is_empty())?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(v @ Value::Array(_)) => Some(v),
        _ => None,
    }
}
