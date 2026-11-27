//! The rail's task, shell and loop lists (BackgroundTasksPanel.tsx:327
//! through :514): which tasks are "Tasks", "System tasks", "Running",
//! "Earlier in this session" and "Recent", the Stop-all set, the
//! attention count and the header's "N running" cue; with the
//! `lib/client/task-status.ts` predicates the panel reads.

use claudius_client::idle_reconcile::ToolHistoryEntry;
use claudius_client::loops::{ScheduledLoop, ScheduledLoopKind};
use claudius_client::task_status::TaskInfo;
use claudius_client::types::{BackgroundBash, JsRecord};
use indexmap::IndexSet;

/// `PROCESS_TASK_TYPES` (BackgroundTasksPanel.tsx:182): processes, not
/// agentic work; they show under "Running".
pub fn is_process_task_type(t: Option<&str>) -> bool {
    matches!(t.unwrap_or(""), "local_bash" | "local_monitor")
}

/// `TERMINAL_STATUSES` (BackgroundTasksPanel.tsx:185).
pub fn is_terminal_status(s: &str) -> bool {
    matches!(s, "completed" | "failed" | "stopped" | "killed")
}

/// `isFinishedSubagent(t)` (BackgroundTasksPanel.tsx:192): a
/// `local_agent` that ended.
pub fn is_finished_subagent(t: &TaskInfo) -> bool {
    t.task_type.as_deref() == Some("local_agent") && is_terminal_status(&t.status)
}

/// `isSystemTask(t)` (task-status.ts:36): Claude Code's own housekeeping
/// (`skipTranscript === true`).
pub fn is_system_task(t: &TaskInfo) -> bool {
    t.skip_transcript == Some(true)
}

/// `isBackgroundTaskLive(task, liveIds)` (task-status.ts:82): a running
/// task the latest `background_tasks_changed` snapshot no longer lists is
/// stale; anything not running, or no snapshot yet, is live.
pub fn is_background_task_live(t: &TaskInfo, live_ids: Option<&IndexSet<String>>) -> bool {
    if t.status != "running" {
        return true;
    }
    match live_ids {
        None => true,
        Some(ids) => ids.contains(&t.task_id),
    }
}

/// `isActivityCountableTask(t)` (task-status.ts:106): not `ambient`.
pub fn is_activity_countable_task(t: &TaskInfo) -> bool {
    t.ambient != Some(true)
}

/// `isStaleWakeup(loop, now)` (session-loops.ts:140) over the client's
/// loop: a wake-up whose fire moment is more than a minute past.
pub fn is_stale_wakeup(l: &ScheduledLoop, now: f64) -> bool {
    if l.kind != ScheduledLoopKind::Wakeup {
        return false;
    }
    let Some(delay) = l.delay_seconds else {
        return false;
    };
    let fire_at = l.started_at + delay * 1000.0;
    now > fire_at + claudius_core::session_loops::WAKEUP_STALE_GRACE_MS
}

/// `scheduledLoopCancelPrompt(loop)` (stop-self-paced-loop.ts:25): what
/// the rail's X sends.
pub fn scheduled_loop_cancel_prompt(l: &ScheduledLoop) -> String {
    match l.kind {
        ScheduledLoopKind::Wakeup => "Please stop the self-paced loop by calling `ScheduleWakeup` with `stop: true`. Reply with one short line confirming it's stopped \u{2014} don't run any other tools.".to_owned(),
        ScheduledLoopKind::Cron => format!(
            "Please cancel the scheduled loop with id `{}` by calling `CronDelete` on it. Reply with one short line confirming it's cancelled \u{2014} don't run any other tools.",
            l.id
        ),
    }
}

/// `taskStatusLabel(t)` (BackgroundTasksPanel.tsx:215).
pub fn task_status_label(t: &TaskInfo) -> String {
    if t.reason.as_deref() == Some("worker_restart") {
        format!("{} (restarted)", t.status)
    } else {
        t.status.clone()
    }
}

/// `taskStatusTitle(t)` (BackgroundTasksPanel.tsx:220).
pub fn task_status_title(t: &TaskInfo) -> Option<&'static str> {
    (t.reason.as_deref() == Some("worker_restart")).then_some(
        "Stopped because the background worker process restarted and found this task orphaned \u{2014} not a user or agent action.",
    )
}

/// `taskIcon(taskType)` (BackgroundTasksPanel.tsx:233): a shell's
/// terminal, a monitor's pulse, else the bot.
pub fn task_icon(task_type: Option<&str>) -> &'static str {
    match task_type {
        Some("local_bash") => "Terminal",
        Some("local_monitor") => "Activity",
        _ => "Bot",
    }
}

/// JS truthiness of a number (`0`, `-0` and `NaN` are false).
pub fn num_truthy(n: Option<f64>) -> bool {
    n.is_some_and(|n| n != 0.0 && !n.is_nan())
}

/// `taskElapsedSeconds(t, now)` (BackgroundTasksPanel.tsx:253): the live
/// wall clock while a stamped task runs, else the SDK's `durationMs`.
pub fn task_elapsed_seconds(t: &TaskInfo, now: f64) -> Option<f64> {
    if num_truthy(t.started_at) && (t.status == "running" || t.status == "pending") {
        let started = t.started_at.expect("truthy");
        // `Math.max(0, NaN)` is NaN.
        let s = (now - started) / 1000.0;
        return Some(if s.is_nan() { s } else { s.max(0.0) });
    }
    t.duration_ms.map(|d| d / 1000.0)
}

/// `(b.durationMs ?? 0) - (a.durationMs ?? 0)`: longest first, stable.
fn by_duration_desc(list: &mut [&TaskInfo]) {
    list.sort_by(|a, b| {
        let (a, b) = (a.duration_ms.unwrap_or(0.0), b.duration_ms.unwrap_or(0.0));
        b.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// What the lists read off the chat (the panel's props).
#[derive(Clone, Copy)]
pub struct ListsInput<'a> {
    pub tasks: &'a JsRecord<TaskInfo>,
    pub live_background_task_ids: Option<&'a IndexSet<String>>,
    pub background_bashes: &'a JsRecord<BackgroundBash>,
    pub scheduled_loops: &'a JsRecord<ScheduledLoop>,
    pub tool_history: &'a [ToolHistoryEntry],
    pub pending_permission: bool,
    pub ready: bool,
    pub pending: bool,
    pub session_id: Option<&'a str>,
}

/// The panel's derived lists, by task id / tool-use id / loop id, in the
/// order they show.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Lists {
    /// `runningCount`: tool calls not done.
    pub running_count: usize,
    /// "Tasks": live agentic work, longest first.
    pub subagents: Vec<String>,
    /// "System tasks".
    pub system_tasks: Vec<String>,
    /// "Earlier in this session": finished subagents, newest first.
    pub earlier: Vec<String>,
    /// "Recent": the last three other ended tasks, newest first.
    pub recent: Vec<String>,
    /// Live background shells (tool-use ids).
    pub running_bashes: Vec<String>,
    /// Process tasks with no shell row.
    pub running_process_tasks: Vec<String>,
    pub running_procs: usize,
    /// What Stop-all stops.
    pub stoppable: Vec<String>,
    /// Loops not stale, newest first.
    pub loops: Vec<String>,
    pub active_loop_count: usize,
    pub non_ambient_subagents: usize,
    pub attention: usize,
    /// The header's "N running".
    pub running_bg: usize,
    pub busy: bool,
}

impl Lists {
    /// The derivations (BackgroundTasksPanel.tsx:327 through :514).
    pub fn of(i: ListsInput<'_>, now: f64) -> Lists {
        let running_count = i
            .tool_history
            .iter()
            .filter(|e| e.done != Some(true))
            .count();
        // `taskByToolUseId`: the last task with a truthy tool-use id wins.
        let mut by_tool_use: indexmap::IndexMap<&str, &TaskInfo> = indexmap::IndexMap::new();
        for t in i.tasks.values() {
            if let Some(id) = t.tool_use_id.as_deref().filter(|s| !s.is_empty()) {
                by_tool_use.insert(id, t);
            }
        }
        let live = |t: &TaskInfo| is_background_task_live(t, i.live_background_task_ids);
        let mut subagents: Vec<&TaskInfo> = i
            .tasks
            .values()
            .filter(|t| {
                matches!(t.status.as_str(), "running" | "pending" | "paused")
                    && !is_process_task_type(t.task_type.as_deref())
                    && !is_system_task(t)
                    && live(t)
            })
            .collect();
        by_duration_desc(&mut subagents);
        let mut system: Vec<&TaskInfo> = i
            .tasks
            .values()
            .filter(|t| is_system_task(t) && live(t))
            .collect();
        by_duration_desc(&mut system);
        let earlier: Vec<String> = i
            .tasks
            .values()
            .filter(|t| is_finished_subagent(t) && !is_system_task(t))
            .rev()
            .map(|t| t.task_id.clone())
            .collect();
        let ended: Vec<&TaskInfo> = i
            .tasks
            .values()
            .filter(|t| !matches!(t.status.as_str(), "running" | "pending" | "paused"))
            .filter(|t| !(is_finished_subagent(t) && !is_system_task(t)))
            .collect();
        let recent: Vec<String> = ended[ended.len().saturating_sub(3)..]
            .iter()
            .rev()
            .map(|t| t.task_id.clone())
            .collect();
        let running_bashes: Vec<&BackgroundBash> = i
            .background_bashes
            .values()
            .filter(|b| {
                if b.killed == Some(true) {
                    return false;
                }
                let t = by_tool_use.get(b.tool_use_id.as_str());
                !t.is_some_and(|t| is_terminal_status(&t.status))
            })
            .collect();
        let bash_ids: IndexSet<&str> = i
            .background_bashes
            .values()
            .map(|b| b.tool_use_id.as_str())
            .collect();
        let process: Vec<&TaskInfo> = i
            .tasks
            .values()
            .filter(|t| {
                (t.status == "running" || t.status == "pending")
                    && is_process_task_type(t.task_type.as_deref())
                    && !t
                        .tool_use_id
                        .as_deref()
                        .is_some_and(|id| !id.is_empty() && bash_ids.contains(id))
                    && live(t)
            })
            .collect();
        let non_ambient_process = process
            .iter()
            .filter(|t| is_activity_countable_task(t))
            .count();
        let running_procs = running_bashes.len() + non_ambient_process;
        // `collectStoppableTaskIds` (task-status.ts:300).
        let mut stoppable: IndexSet<String> = IndexSet::new();
        for t in subagents.iter().chain(process.iter()) {
            stoppable.insert(t.task_id.clone());
        }
        for b in &running_bashes {
            if let Some(t) = by_tool_use.get(b.tool_use_id.as_str())
                && !t.task_id.is_empty()
            {
                stoppable.insert(t.task_id.clone());
            }
        }
        let mut loops: Vec<&ScheduledLoop> = i
            .scheduled_loops
            .values()
            .filter(|l| !is_stale_wakeup(l, now))
            .collect();
        loops.sort_by(|a, b| {
            b.started_at
                .partial_cmp(&a.started_at)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let active_loop_count = loops.iter().filter(|l| l.cancelled != Some(true)).count();
        let non_ambient_subagents = subagents
            .iter()
            .filter(|t| is_activity_countable_task(t))
            .count();
        let attention = running_count
            + non_ambient_subagents
            + usize::from(i.pending_permission)
            + running_procs
            + active_loop_count;
        let running_bg = running_procs + non_ambient_subagents;
        let busy = !i.ready || i.pending || running_bg > 0;
        let _ = i.session_id;
        Lists {
            running_count,
            subagents: subagents.iter().map(|t| t.task_id.clone()).collect(),
            system_tasks: system.iter().map(|t| t.task_id.clone()).collect(),
            earlier,
            recent,
            running_bashes: running_bashes
                .iter()
                .map(|b| b.tool_use_id.clone())
                .collect(),
            running_process_tasks: process.iter().map(|t| t.task_id.clone()).collect(),
            running_procs,
            stoppable: stoppable.into_iter().collect(),
            loops: loops.iter().map(|l| l.id.clone()).collect(),
            active_loop_count,
            non_ambient_subagents,
            attention,
            running_bg,
            busy,
        }
    }

    /// The task id that stops a shell (`taskByToolUseId.get(..)?.taskId`).
    pub fn stop_task_for_bash(tasks: &JsRecord<TaskInfo>, tool_use_id: &str) -> Option<String> {
        tasks
            .values()
            .rev()
            .find(|t| t.tool_use_id.as_deref() == Some(tool_use_id) && !tool_use_id.is_empty())
            .map(|t| t.task_id.clone())
            .filter(|id| !id.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, status: &str) -> TaskInfo {
        TaskInfo::new(id, format!("desc {id}"), status)
    }

    fn input<'a>(
        tasks: &'a JsRecord<TaskInfo>,
        bashes: &'a JsRecord<BackgroundBash>,
        loops: &'a JsRecord<ScheduledLoop>,
    ) -> ListsInput<'a> {
        ListsInput {
            tasks,
            live_background_task_ids: None,
            background_bashes: bashes,
            scheduled_loops: loops,
            tool_history: &[],
            pending_permission: false,
            ready: true,
            pending: false,
            session_id: Some("s1"),
        }
    }

    #[test]
    fn process_tasks_stay_out_of_tasks_and_go_under_running() {
        let mut tasks = JsRecord::new();
        let mut a = task("a", "running");
        a.task_type = Some("local_agent".into());
        let mut m = task("m", "running");
        m.task_type = Some("local_monitor".into());
        tasks.insert("a".into(), a);
        tasks.insert("m".into(), m);
        let (b, l) = (JsRecord::new(), JsRecord::new());
        let lists = Lists::of(input(&tasks, &b, &l), 0.0);
        assert_eq!(lists.subagents, ["a"]);
        assert_eq!(lists.running_process_tasks, ["m"]);
        assert_eq!(lists.running_procs, 1);
        assert_eq!(lists.stoppable, ["a", "m"]);
        assert_eq!(lists.running_bg, 2);
        assert_eq!(lists.attention, 2);
        assert!(lists.busy);
    }

    #[test]
    fn a_stale_running_task_drops_off_with_a_live_snapshot() {
        let mut tasks = JsRecord::new();
        tasks.insert("a".into(), task("a", "running"));
        tasks.insert("b".into(), task("b", "running"));
        let (bs, ls) = (JsRecord::new(), JsRecord::new());
        let ids: IndexSet<String> = ["b".to_owned()].into_iter().collect();
        let mut i = input(&tasks, &bs, &ls);
        i.live_background_task_ids = Some(&ids);
        assert_eq!(Lists::of(i, 0.0).subagents, ["b"]);
    }

    #[test]
    fn recent_keeps_the_last_three_ended_newest_first() {
        let mut tasks = JsRecord::new();
        for id in ["a", "b", "c", "d"] {
            tasks.insert(id.into(), task(id, "completed"));
        }
        let mut done = task("e", "failed");
        done.task_type = Some("local_agent".into());
        tasks.insert("e".into(), done);
        let (bs, ls) = (JsRecord::new(), JsRecord::new());
        let lists = Lists::of(input(&tasks, &bs, &ls), 0.0);
        assert_eq!(lists.recent, ["d", "c", "b"]);
        assert_eq!(lists.earlier, ["e"]);
    }

    #[test]
    fn a_shell_whose_task_ended_drops_off() {
        let mut tasks = JsRecord::new();
        let mut t = task("t1", "completed");
        t.tool_use_id = Some("tu1".into());
        tasks.insert("t1".into(), t);
        let mut bashes = JsRecord::new();
        for id in ["tu1", "tu2"] {
            bashes.insert(
                id.into(),
                BackgroundBash {
                    tool_use_id: id.into(),
                    bash_id: None,
                    command: "sleep 9".into(),
                    started_at: 0.0,
                    killed: None,
                    timed_out_after_ms: None,
                    ends_with_agent_final_response: None,
                },
            );
        }
        let ls = JsRecord::new();
        let lists = Lists::of(input(&tasks, &bashes, &ls), 0.0);
        assert_eq!(lists.running_bashes, ["tu2"]);
        // No task resolves tu2: Stop-all doesn't count it.
        assert!(lists.stoppable.is_empty());
        assert_eq!(lists.running_procs, 1);
    }

    #[test]
    fn task_elapsed_ticks_while_running_else_reads_the_duration() {
        let mut t = task("a", "running");
        t.started_at = Some(1000.0);
        assert_eq!(task_elapsed_seconds(&t, 6000.0), Some(5.0));
        assert_eq!(task_elapsed_seconds(&t, 0.0), Some(0.0));
        t.status = "completed".into();
        assert_eq!(task_elapsed_seconds(&t, 6000.0), None);
        t.duration_ms = Some(2500.0);
        assert_eq!(task_elapsed_seconds(&t, 6000.0), Some(2.5));
    }

    #[test]
    fn task_status_label_marks_a_worker_restart() {
        let mut t = task("a", "stopped");
        assert_eq!(task_status_label(&t), "stopped");
        assert_eq!(task_status_title(&t), None);
        t.reason = Some("worker_restart".into());
        assert_eq!(task_status_label(&t), "stopped (restarted)");
        assert!(task_status_title(&t).is_some());
    }

    #[test]
    fn task_icon_follows_the_kind() {
        assert_eq!(task_icon(Some("local_bash")), "Terminal");
        assert_eq!(task_icon(Some("local_monitor")), "Activity");
        assert_eq!(task_icon(Some("local_agent")), "Bot");
        assert_eq!(task_icon(None), "Bot");
    }
}
