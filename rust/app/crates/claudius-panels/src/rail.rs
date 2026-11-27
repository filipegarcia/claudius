//! The whole rail as data (`BackgroundTasksPanel`, mounted by
//! ChatSurface.tsx:2941 with `useSession()`'s state): the Activity
//! header, the pinned usage card, then the always-on group, the active
//! group and the history group, each section with its label, badge and
//! collapsed state.

use std::collections::{HashMap, HashSet};

use claudius_client::state::ChatState;
use claudius_client::types::{Role, SystemEntryKind};
use claudius_client::{RateLimitInfo, effect::FetchRequest};
use serde_json::Value;

use crate::card::{self, Card, CardInput, ContextBar, ContextSummary};
use crate::rows::{
    self, BashRow, EarlierRow, EditRow, LoopRow, ProcessRow, RecentRow, SystemRow, TaskRow, ToolRow,
};
use crate::tasks::{Lists, ListsInput};
use crate::todos::{TodoRow, todo_row, todos_badge};
use crate::usage::{
    PLAN_USAGE_COLLAPSED_KEY, PlanCard, PlanInput, RATE_LIMIT_WARNING_KEY, plan_card,
    rate_limit_warning_pct,
};

/// The rail's `localStorage` reads (`claudius.activity.*`, the warning
/// threshold).
pub type Prefs = HashMap<String, String>;

/// `CollapsibleSection`'s key (`claudius.activity.<key>.collapsed`).
pub fn collapsed_key(key: &str) -> String {
    format!("claudius.activity.{key}.collapsed")
}

/// `getSnapshot()` (CollapsibleSection.tsx:46): `"1"` collapsed, `"0"`
/// open, anything else the default (open: no section passes one).
pub fn is_collapsed(prefs: &Prefs, key: &str) -> bool {
    match prefs.get(&collapsed_key(key)).map(String::as_str) {
        Some("1") => true,
        Some("0") => false,
        _ => false,
    }
}

/// The sections' storage keys (`storageKey`), in the rail's order.
pub const SECTION_KEYS: [&str; 9] = [
    "todos",
    "tasks",
    "system-tasks",
    "tools",
    "loops",
    "running",
    "earlier",
    "edits",
    "recent",
];

/// Every `localStorage` key the rail reads, for a host to seed [`Prefs`]
/// with.
pub fn pref_keys() -> Vec<String> {
    SECTION_KEYS
        .iter()
        .map(|k| collapsed_key(k))
        .chain([
            PLAN_USAGE_COLLAPSED_KEY.to_owned(),
            RATE_LIMIT_WARNING_KEY.to_owned(),
        ])
        .collect()
}

/// A collapsible section.
#[derive(Clone, Debug, PartialEq)]
pub struct Section<T> {
    /// The storage key (and the test handle `activity-section-<key>`).
    pub key: &'static str,
    pub label: &'static str,
    pub badge: Option<String>,
    pub collapsed: bool,
    pub body: T,
}

fn section<T>(
    prefs: &Prefs,
    key: &'static str,
    label: &'static str,
    badge: Option<String>,
    body: T,
) -> Section<T> {
    Section {
        key,
        label,
        badge,
        collapsed: is_collapsed(prefs, key),
        body,
    }
}

/// The header's "N running" cue (BackgroundTasksPanel.tsx:548).
#[derive(Clone, Debug, PartialEq)]
pub struct RunningCue {
    pub count: usize,
    /// Agentic work runs (the bot icon), else only processes (terminal).
    pub agents: bool,
    pub title: &'static str,
    pub aria: String,
    /// The section the click opens.
    pub reveal: &'static str,
}

/// The Activity header (BackgroundTasksPanel.tsx:521).
#[derive(Clone, Debug, PartialEq)]
pub struct Header {
    pub busy: bool,
    /// "Reconnecting…" instead of the spinner.
    pub disconnected: bool,
    /// `Starting…` / `Working…` beside the spinner.
    pub working: Option<&'static str>,
    pub running: Option<RunningCue>,
    /// Stop-all's count, when there's a session and something to stop.
    pub stop_all: Option<usize>,
    pub attention: usize,
}

/// The To-dos section's body.
#[derive(Clone, Debug, PartialEq)]
pub struct TodosBody {
    pub rows: Vec<TodoRow>,
    /// The eraser (something to clear).
    pub clear: bool,
    pub add_open: bool,
    /// "No tasks yet. Click + to add." (no rows, the form closed).
    pub empty: bool,
}

/// The Tools section's body: up to 30 rows, or the empty line.
pub type ToolsBody = Vec<ToolRow>;

/// The Running section's body.
#[derive(Clone, Debug, PartialEq)]
pub struct RunningBody {
    pub bashes: Vec<BashRow>,
    pub processes: Vec<ProcessRow>,
}

/// The rail.
#[derive(Clone, Debug, PartialEq)]
pub struct RailModel {
    pub session_id: Option<String>,
    pub header: Header,
    pub plan: Option<PlanCard>,
    pub card: Card,
    pub context: ContextBar,
    pub tokens: [(&'static str, String); 4],
    /// PermissionPending's tool name.
    pub permission: Option<String>,
    pub todos: Section<TodosBody>,
    pub tasks: Option<Section<Vec<TaskRow>>>,
    pub system: Option<Section<Vec<SystemRow>>>,
    pub tools: Section<ToolsBody>,
    pub loops: Option<Section<Vec<LoopRow>>>,
    pub running: Option<Section<RunningBody>>,
    /// The history group's divider.
    pub history: bool,
    pub earlier: Option<Section<Vec<EarlierRow>>>,
    pub edits: Option<Section<Vec<EditRow>>>,
    pub recent: Option<Section<Vec<RecentRow>>>,
    /// What Stop-all stops (task ids).
    pub stoppable: Vec<String>,
}

/// The view's own state the rail reads.
#[derive(Clone, Copy)]
pub struct RailView<'a> {
    pub prefs: &'a Prefs,
    /// The 1 Hz clock.
    pub now: f64,
    /// The usage card's minute clock.
    pub usage_now: f64,
    pub add_open: bool,
    pub cancelling: &'a HashSet<String>,
    /// When the card first saw a bound session.
    pub bound_at: Option<f64>,
    pub context: Option<&'a ContextSummary>,
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

/// `rateLimitEvents` (ChatSurface.tsx:2125): each `rate_limit` entry's
/// payload.
pub fn rate_limit_events(s: &ChatState) -> Vec<RateLimitInfo> {
    s.system_entries
        .iter()
        .filter(|e| e.kind == SystemEntryKind::RateLimit)
        .filter_map(|e| e.rate_limit.clone())
        .collect()
}

/// The card's inputs off the chat.
pub fn card_input(s: &ChatState) -> CardInput {
    let usage = Some(&s.usage);
    let num = |k: &str| claudius_agent::js::prop(usage, k).and_then(Value::as_f64);
    CardInput {
        model: str_of(&s.model),
        effort: s.effort.as_str().unwrap_or("auto").to_owned(),
        applied_effort: s.applied_effort.as_ref().and_then(str_of),
        effort_change_waits: s.effort_change_waits,
        permission_mode: s
            .permission_mode
            .as_ref()
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_owned(),
        cwd: str_of(&s.cwd),
        num_turns: num("numTurns"),
        duration_ms: num("durationMs"),
        historical_turn_count: s
            .messages
            .iter()
            .filter(|m| m.role == Role::Assistant)
            .count(),
        ultracode: s.ultracode,
        fast_mode: s.fast_mode,
        advisor_model: s.advisor_model.clone(),
    }
}

/// The rail over a chat's state.
pub fn rail<Tz: chrono::TimeZone>(s: &ChatState, v: RailView<'_>, tz: &Tz) -> RailModel
where
    Tz::Offset: std::fmt::Display,
{
    let session_id = s.session_id.clone().filter(|id| !id.is_empty());
    let has_session = session_id.is_some();
    let lists = Lists::of(
        ListsInput {
            tasks: &s.tasks,
            live_background_task_ids: s.live_background_task_ids.as_ref(),
            background_bashes: &s.background_bashes,
            scheduled_loops: &s.scheduled_loops,
            tool_history: &s.tool_history,
            pending_permission: !s.pending_permissions.is_empty(),
            ready: s.ready,
            pending: s.pending,
            session_id: session_id.as_deref(),
        },
        v.now,
    );
    let disconnected = s.stream_status == "reconnecting";
    let running = (lists.running_bg > 0).then(|| {
        let agents = lists.non_ambient_subagents > 0;
        RunningCue {
            count: lists.running_bg,
            agents,
            title: if agents {
                "Jump to running tasks"
            } else {
                "Jump to running processes"
            },
            aria: format!(
                "{} background {} running \u{2014} show them",
                lists.running_bg,
                if lists.running_bg == 1 {
                    "task"
                } else {
                    "tasks"
                }
            ),
            reveal: if agents { "tasks" } else { "running" },
        }
    });
    let header = Header {
        busy: lists.busy,
        disconnected: lists.busy && disconnected,
        working: (lists.busy && !disconnected).then_some(if s.ready {
            "Working\u{2026}"
        } else {
            "Starting\u{2026}"
        }),
        running,
        stop_all: (has_session && !lists.stoppable.is_empty()).then_some(lists.stoppable.len()),
        attention: lists.attention,
    };
    let ci = card_input(s);
    let events = rate_limit_events(s);
    let plan = plan_card(
        &PlanInput {
            plan_usage: &s.plan_usage,
            events: &events,
            model: ci.model.as_deref(),
            effort: &ci.effort,
            threshold_pct: rate_limit_warning_pct(
                v.prefs.get(RATE_LIMIT_WARNING_KEY).map(String::as_str),
            ),
            collapsed: v.prefs.get(PLAN_USAGE_COLLAPSED_KEY).map(String::as_str) == Some("1"),
            filter_now_ms: v.usage_now,
            now_ms: v.now,
        },
        tz,
    );
    let todos = section(
        v.prefs,
        "todos",
        "To-dos",
        Some(todos_badge(s.latest_todos.len())),
        TodosBody {
            rows: s.latest_todos.iter().map(todo_row).collect(),
            clear: !s.latest_todos.is_empty(),
            add_open: v.add_open,
            empty: s.latest_todos.is_empty() && !v.add_open,
        },
    );
    let task = |id: &String| s.tasks.get(id);
    let tasks = (!lists.subagents.is_empty()).then(|| {
        section(
            v.prefs,
            "tasks",
            "Tasks",
            Some(format!("({})", lists.subagents.len())),
            lists
                .subagents
                .iter()
                .filter_map(task)
                .map(|t| rows::task_row(t, has_session, v.now))
                .collect(),
        )
    });
    let system = (!lists.system_tasks.is_empty()).then(|| {
        section(
            v.prefs,
            "system-tasks",
            "System tasks",
            Some(format!("({})", lists.system_tasks.len())),
            lists
                .system_tasks
                .iter()
                .filter_map(task)
                .map(rows::system_row)
                .collect(),
        )
    });
    let tools = section(
        v.prefs,
        "tools",
        "Tools",
        rows::tools_badge(s.tool_history.len(), lists.running_count),
        s.tool_history
            .iter()
            .take(30)
            .map(|e| rows::tool_row(e, s.tool_progress.get(&e.tool_use_id), disconnected))
            .collect(),
    );
    let loops = (!lists.loops.is_empty()).then(|| {
        section(
            v.prefs,
            "loops",
            "Scheduled loops",
            Some(rows::loops_badge(
                lists.loops.len(),
                lists.active_loop_count,
            )),
            lists
                .loops
                .iter()
                .filter_map(|id| s.scheduled_loops.get(id))
                .map(|l| rows::loop_row(l, true, v.cancelling, v.now, tz))
                .collect(),
        )
    });
    let running = (lists.running_procs > 0).then(|| {
        section(
            v.prefs,
            "running",
            "Running",
            Some(format!("({})", lists.running_procs)),
            RunningBody {
                bashes: lists
                    .running_bashes
                    .iter()
                    .filter_map(|id| s.background_bashes.get(id))
                    .map(|b| {
                        rows::bash_row(
                            b,
                            Lists::stop_task_for_bash(&s.tasks, &b.tool_use_id),
                            v.now,
                        )
                    })
                    .collect(),
                processes: lists
                    .running_process_tasks
                    .iter()
                    .filter_map(task)
                    .map(|t| rows::process_row(t, has_session))
                    .collect(),
            },
        )
    });
    let earlier = (!lists.earlier.is_empty()).then(|| {
        section(
            v.prefs,
            "earlier",
            "Earlier in this session",
            Some(lists.earlier.len().to_string()),
            lists
                .earlier
                .iter()
                .filter_map(task)
                .map(rows::earlier_row)
                .collect(),
        )
    });
    let edits = (!s.recent_edits.is_empty()).then(|| {
        section(
            v.prefs,
            "edits",
            "Recent edits",
            None,
            s.recent_edits.iter().take(5).map(rows::edit_row).collect(),
        )
    });
    let recent = (!lists.recent.is_empty()).then(|| {
        section(
            v.prefs,
            "recent",
            "Recent",
            None,
            lists
                .recent
                .iter()
                .filter_map(task)
                .map(rows::recent_row)
                .collect(),
        )
    });
    RailModel {
        session_id,
        header,
        plan,
        card: card::card(&ci, v.bound_at, v.now),
        context: card::context_bar(v.context),
        tokens: card::token_tiles(&s.usage),
        permission: card::permission_pending(s.pending_permissions.first().map(|p| &p.0)),
        todos,
        tasks,
        system,
        tools,
        loops,
        running,
        history: !s.recent_edits.is_empty()
            || !lists.recent.is_empty()
            || !lists.earlier.is_empty(),
        earlier,
        edits,
        recent,
        stoppable: lists.stoppable,
    }
}

/// `stopTask(taskId)` (BackgroundTasksPanel.tsx:373): the rail's own
/// POST (best effort, its outcome ignored).
pub fn stop_task_request(session_id: &str, task_id: &str) -> Option<FetchRequest> {
    let sid = claudius_core::js_string::encode_uri_component(session_id)?;
    Some(FetchRequest {
        id: claudius_client::effect::FetchId(0),
        method: "POST",
        url: format!("/api/sessions/{sid}/stop-task"),
        headers: vec![("Content-Type", "application/json")],
        body: Some(claudius_agent::js::stringify(
            &serde_json::json!({ "taskId": task_id }),
        )),
    })
}

/// Stop-all's confirm (`confirm(...)`, BackgroundTasksPanel.tsx:445).
pub fn stop_all_question(n: usize) -> String {
    format!(
        "Stop all {n} running task{}?",
        if n == 1 { "" } else { "s" }
    )
}

/// `messageSubagentDraft(taskId)` (open-task.ts): the composer text
/// "Message" drops in.
pub fn message_subagent_draft(task_id: &str) -> String {
    format!("Use SendMessage to send agent {task_id} this message: ")
}

/// The rail's width (`w-64 lg:w-72`): 288 px from a 1024 px window.
pub fn rail_width(window_width: f32) -> f32 {
    if window_width >= 1024. { 288. } else { 256. }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_section_is_open_unless_its_key_says_one() {
        let mut p = Prefs::new();
        assert!(!is_collapsed(&p, "todos"));
        p.insert(collapsed_key("todos"), "1".into());
        assert!(is_collapsed(&p, "todos"));
        p.insert(collapsed_key("todos"), "0".into());
        assert!(!is_collapsed(&p, "todos"));
        p.insert(collapsed_key("todos"), "yes".into());
        assert!(!is_collapsed(&p, "todos"));
    }

    #[test]
    fn stop_task_posts_the_task_id() {
        let r = stop_task_request("s 1", "t1").unwrap();
        assert_eq!(r.url, "/api/sessions/s%201/stop-task");
        assert_eq!(r.body.as_deref(), Some(r#"{"taskId":"t1"}"#));
        assert_eq!(stop_all_question(1), "Stop all 1 running task?");
        assert_eq!(stop_all_question(3), "Stop all 3 running tasks?");
    }

    #[test]
    fn the_rail_is_wider_on_a_large_window() {
        assert_eq!(rail_width(1023.), 256.);
        assert_eq!(rail_width(1024.), 288.);
    }
}
