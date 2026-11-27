//! What each list row of the rail shows: the Tasks rows
//! (BackgroundTasksPanel.tsx:707), System tasks (:806), the Running
//! section's shells (`BackgroundBashes.tsx`) and process tasks (:962),
//! "Earlier in this session" (:1019), Recent (:1078), the Tools section
//! (:845), `RecentEdits.tsx` and `ScheduledLoops.tsx`.

use std::collections::HashSet;

use claudius_agent::js;
use claudius_client::idle_reconcile::{ToolHistoryEntry, ToolHistoryKind};
use claudius_client::loops::{ScheduledLoop, ScheduledLoopKind};
use claudius_client::shared::pretty_model_name;
use claudius_client::task_status::TaskInfo;
use claudius_client::types::{BackgroundBash, ToolProgressInfo};
use claudius_client::user_events::RecentEdit;
use claudius_core::js_string::{from_units, units};

use crate::format::{compact_arg, fmt_elapsed, fmt_elapsed_sec, locale_number, to_fixed};
use crate::look::{Ink, Look, Paint, task_tone, task_tone_or_running};
use crate::tasks::{task_elapsed_seconds, task_icon, task_status_label, task_status_title};

/// A row's status text and its tooltip.
#[derive(Clone, Debug, PartialEq)]
pub struct StatusText {
    pub text: String,
    pub title: Option<&'static str>,
}

fn status_text(t: &TaskInfo) -> StatusText {
    StatusText {
        text: task_status_label(t),
        title: task_status_title(t),
    }
}

/// A row in "Tasks" (BackgroundTasksPanel.tsx:707).
#[derive(Clone, Debug, PartialEq)]
pub struct TaskRow {
    pub task_id: String,
    pub icon: &'static str,
    /// `workflowName ?? taskType ?? "Task"`.
    pub name: String,
    /// The `L<depth>` badge from depth 2 on, with its tooltip.
    pub nesting: Option<(String, String)>,
    pub status: StatusText,
    /// A Stop button (there's a session).
    pub stoppable: bool,
    pub look: Look,
    pub description: Option<String>,
    /// The live summary when it says something the description doesn't.
    pub summary: Option<String>,
    pub output_file: Option<String>,
    pub model: Option<String>,
    pub tokens: Option<String>,
    pub tools: Option<String>,
    /// The ticking wall clock (or the SDK's duration).
    pub elapsed: Option<String>,
    pub last_tool: Option<String>,
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.clone().filter(|s| !s.is_empty())
}

pub fn task_row(t: &TaskInfo, has_session: bool, now: f64) -> TaskRow {
    let depth = t.spawn_depth.filter(|d| *d >= 2.0);
    TaskRow {
        task_id: t.task_id.clone(),
        icon: task_icon(t.task_type.as_deref()),
        name: t
            .workflow_name
            .clone()
            .or_else(|| t.task_type.clone())
            .unwrap_or_else(|| "Task".into()),
        nesting: depth.map(|d| {
            (
                format!("L{}", crate::format::number_to_string(d)),
                format!(
                    "Nested subagent \u{2014} spawned from inside a depth-{} agent",
                    crate::format::number_to_string(d - 1.0)
                ),
            )
        }),
        status: status_text(t),
        stoppable: has_session,
        look: task_tone_or_running(&t.status),
        description: Some(t.description.clone()).filter(|d| !d.is_empty()),
        summary: non_empty(&t.summary).filter(|s| *s != t.description),
        output_file: non_empty(&t.output_file),
        model: non_empty(&t.model).map(|m| pretty_model_name(Some(&m))),
        tokens: t.total_tokens.map(|n| format!("{} tok", locale_number(n))),
        tools: t
            .tool_uses
            .map(|n| format!("{} tools", crate::format::number_to_string(n))),
        elapsed: task_elapsed_seconds(t, now).map(fmt_elapsed),
        last_tool: non_empty(&t.last_tool_name).map(|n| format!("\u{b7} {n}")),
    }
}

/// A row in "System tasks" (BackgroundTasksPanel.tsx:806).
#[derive(Clone, Debug, PartialEq)]
pub struct SystemRow {
    pub task_id: String,
    pub icon: &'static str,
    /// `description ?? workflowName ?? taskType ?? "System task"`: the
    /// description is always a string.
    pub text: String,
    pub status: String,
}

pub fn system_row(t: &TaskInfo) -> SystemRow {
    SystemRow {
        task_id: t.task_id.clone(),
        icon: task_icon(t.task_type.as_deref()),
        text: t.description.clone(),
        status: task_status_label(t),
    }
}

/// A process task under "Running" (BackgroundTasksPanel.tsx:962).
#[derive(Clone, Debug, PartialEq)]
pub struct ProcessRow {
    pub task_id: String,
    /// `workflowName ?? taskType ?? "Process"`.
    pub name: String,
    pub status: StatusText,
    pub stoppable: bool,
    pub look: Look,
    pub description: Option<String>,
}

pub fn process_row(t: &TaskInfo, has_session: bool) -> ProcessRow {
    ProcessRow {
        task_id: t.task_id.clone(),
        name: t
            .workflow_name
            .clone()
            .or_else(|| t.task_type.clone())
            .unwrap_or_else(|| "Process".into()),
        status: status_text(t),
        stoppable: has_session,
        look: task_tone_or_running(&t.status),
        description: Some(t.description.clone()).filter(|d| !d.is_empty()),
    }
}

/// A background shell (`BackgroundBashes.tsx`).
#[derive(Clone, Debug, PartialEq)]
pub struct BashRow {
    pub tool_use_id: String,
    /// The `timed out` badge's tooltip, when it timed out.
    pub timed_out: Option<String>,
    /// Owned by a synchronous subagent.
    pub ends_with_agent: bool,
    /// `killed`, or the uptime.
    pub right: String,
    /// The task id its Stop button stops, when one is known.
    pub stop_task_id: Option<String>,
    pub command: String,
    pub look: Look,
}

pub fn bash_row(b: &BackgroundBash, stop_task_id: Option<String>, now: f64) -> BashRow {
    let killed = b.killed == Some(true);
    let timed_out = (!killed)
        .then_some(b.timed_out_after_ms)
        .flatten()
        .map(|ms| {
            format!(
                "Auto-backgrounded after hitting its {}s timeout",
                crate::format::number_to_string(claudius_core::image_size::js_round(ms / 1000.0))
            )
        });
    let elapsed = ((now - b.started_at) / 1000.0).max(0.0);
    let look = if killed {
        Look::quiet(40.)
    } else if timed_out.is_some() {
        Look::tint("amber-500", 30., 10., "amber-200")
    } else {
        Look::tint("emerald-500", 30., 10., "emerald-200")
    };
    BashRow {
        tool_use_id: b.tool_use_id.clone(),
        ends_with_agent: !killed && b.ends_with_agent_final_response == Some(true),
        timed_out,
        right: if killed {
            "killed".into()
        } else {
            fmt_elapsed_sec(elapsed)
        },
        stop_task_id,
        command: b.command.clone(),
        look,
    }
}

/// A finished subagent under "Earlier in this session"
/// (BackgroundTasksPanel.tsx:1019).
#[derive(Clone, Debug, PartialEq)]
pub struct EarlierRow {
    pub task_id: String,
    pub description: String,
    pub status: StatusText,
    /// `TASK_TONES[t.status]`: none for an unknown status.
    pub look: Option<Look>,
    /// The Open button's transcript target.
    pub open: Option<String>,
}

pub fn earlier_row(t: &TaskInfo) -> EarlierRow {
    EarlierRow {
        task_id: t.task_id.clone(),
        description: t.description.clone(),
        status: status_text(t),
        look: task_tone(&t.status),
        open: non_empty(&t.tool_use_id),
    }
}

/// A row under "Recent" (BackgroundTasksPanel.tsx:1078).
#[derive(Clone, Debug, PartialEq)]
pub struct RecentRow {
    pub task_id: String,
    pub icon: &'static str,
    pub description: String,
    pub status: StatusText,
    pub look: Option<Look>,
}

pub fn recent_row(t: &TaskInfo) -> RecentRow {
    RecentRow {
        task_id: t.task_id.clone(),
        icon: task_icon(t.task_type.as_deref()),
        description: t.description.clone(),
        status: status_text(t),
        look: task_tone(&t.status),
    }
}

/// A row in "Tools" (BackgroundTasksPanel.tsx:845).
#[derive(Clone, Debug, PartialEq)]
pub struct ToolRow {
    pub tool_use_id: String,
    /// `MinusCircle`, `AlertTriangle`, `Check` or `Loader2`.
    pub status_icon: &'static str,
    pub icon_ink: Ink,
    pub spinning: bool,
    /// `Brain` for a thinking row, else `Wrench`.
    pub kind_icon: &'static str,
    pub name: String,
    /// `~1.2k tok` while a thinking row runs.
    pub thinking_tokens: Option<String>,
    pub elapsed: Option<String>,
    pub arg: Option<String>,
    /// `via subagent 1234abcd…`.
    pub via: Option<String>,
    pub look: Look,
    /// `opacity-60`.
    pub dim: bool,
    pub title: Option<String>,
    pub not_run: bool,
}

/// `s.slice(0, n)` in UTF-16 units.
fn head16(s: &str, n: usize) -> String {
    let u = units(s);
    from_units(&u[..n.min(u.len())])
}

pub fn tool_row(
    e: &ToolHistoryEntry,
    live: Option<&ToolProgressInfo>,
    disconnected: bool,
) -> ToolRow {
    let done = e.done == Some(true);
    let is_error = e.is_error == Some(true);
    let elapsed = if done && crate::tasks::num_truthy(e.ended_at) {
        Some((e.ended_at.expect("truthy") - e.started_at) / 1000.0)
    } else {
        live.and_then(|l| l.elapsed_seconds)
    };
    let not_run = is_error && e.not_run == Some(true);
    let (look, dim) = if not_run {
        (Look::quiet(40.).plain_text(), true)
    } else if is_error {
        (
            Look::tint("red-500", 30., 5., "red-500").plain_text(),
            false,
        )
    } else if done {
        (Look::quiet(40.).plain_text(), false)
    } else {
        (
            Look::tint("sky-500", 30., 5., "sky-500").plain_text(),
            false,
        )
    };
    let status_icon = if not_run {
        "MinusCircle"
    } else if is_error {
        "AlertTriangle"
    } else if done {
        "Check"
    } else {
        "Loader2"
    };
    let (icon_ink, spinning) = if not_run {
        (Ink::of(Paint::Muted), false)
    } else if is_error {
        (Ink::of(Paint::Step("red-400")), false)
    } else if done {
        (Ink::of(Paint::Step("emerald-400")), false)
    } else if disconnected {
        (Ink::at(Paint::Step("sky-400"), 50.), false)
    } else {
        (Ink::of(Paint::Step("sky-400")), true)
    };
    let thinking = e.kind == Some(ToolHistoryKind::Thinking);
    let primary = e.primary_arg.as_deref().filter(|a| !a.is_empty());
    let arg = primary
        .filter(|_| !thinking)
        .map(|a| compact_arg(&e.tool_name, a))
        .filter(|a| !a.is_empty());
    let thinking_tokens = (thinking && !done)
        .then_some(e.estimated_thinking_tokens)
        .flatten()
        .map(|n| {
            let n = if n >= 1000.0 {
                format!("{}k", to_fixed(n / 1000.0, 1))
            } else {
                crate::format::number_to_string(n)
            };
            format!("~{n} tok")
        });
    // `rejected` (CC 2.1.323) isn't in the client's ToolHistoryEntry yet.
    let rejected = false;
    let title = if thinking {
        None
    } else if not_run {
        Some(format!(
            "{}{}",
            if rejected {
                "Not run \u{b7} rejected"
            } else {
                "Not run \u{2014} auto mode's check had no usable answer"
            },
            primary.map(|a| format!(" \u{b7} {a}")).unwrap_or_default()
        ))
    } else {
        primary.map(str::to_owned)
    };
    let via = match &e.parent_tool_use_id {
        Some(Some(p)) if !p.is_empty() => Some(format!("via subagent {}\u{2026}", head16(p, 8))),
        _ => None,
    };
    ToolRow {
        tool_use_id: e.tool_use_id.clone(),
        status_icon,
        icon_ink,
        spinning,
        kind_icon: if thinking { "Brain" } else { "Wrench" },
        name: e.tool_name.clone(),
        thinking_tokens,
        elapsed: elapsed.map(fmt_elapsed),
        arg,
        via,
        look,
        dim,
        title,
        not_run,
    }
}

/// The Tools section's badge (BackgroundTasksPanel.tsx:831).
pub fn tools_badge(history_len: usize, running: usize) -> Option<String> {
    if history_len == 0 {
        None
    } else if running > 0 {
        Some(format!("({running} running \u{b7} {history_len})"))
    } else {
        Some(format!("({history_len})"))
    }
}

/// A row of `RecentEdits.tsx` (the first five).
#[derive(Clone, Debug, PartialEq)]
pub struct EditRow {
    pub tool_use_id: String,
    pub file_name: String,
    /// `multi`, or the tool's name in lower case.
    pub tag: String,
    pub ink: Ink,
    pub dim: bool,
    pub title: String,
}

pub fn edit_row(r: &RecentEdit) -> EditRow {
    let not_run = r.is_error == Some(true) && r.not_run == Some(true);
    let (ink, dim) = if not_run {
        (Ink::of(Paint::Muted), true)
    } else if r.is_error == Some(true) {
        (Ink::of(Paint::Step("red-300")), false)
    } else if r.done == Some(true) {
        (Ink::of(Paint::Foreground), false)
    } else {
        (Ink::of(Paint::Step("sky-300")), false)
    };
    // `rejected` (CC 2.1.323) isn't in the client's RecentEdit yet.
    let title = if not_run {
        format!(
            "{} \u{2014} not run (auto mode's check had no usable answer)",
            r.file_path
        )
    } else {
        r.file_path.clone()
    };
    EditRow {
        tool_use_id: r.tool_use_id.clone(),
        file_name: r
            .file_path
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_owned(),
        tag: if r.tool_name == "MultiEdit" {
            "multi".into()
        } else {
            js_lower(&r.tool_name)
        },
        ink,
        dim,
        title,
    }
}

fn js_lower(s: &str) -> String {
    claudius_core::js_string::to_lower(s)
}

/// A scheduled loop (`ScheduledLoops.tsx`).
#[derive(Clone, Debug, PartialEq)]
pub struct LoopRow {
    pub id: String,
    pub kind: ScheduledLoopKind,
    /// `Timer` for a wake-up, `Repeat` for a cron.
    pub icon: &'static str,
    pub cadence: String,
    pub recurring: bool,
    /// `next in 4m`, with its tooltip.
    pub next_fire: Option<(String, String)>,
    pub durable: bool,
    /// `quiet hold` (`×N` for a streak).
    pub noop: Option<String>,
    /// The X, with its aria label and tooltip.
    pub cancel: Option<(&'static str, &'static str)>,
    /// `cancelled` / `cancelling…`.
    pub state: Option<&'static str>,
    pub prompt_preview: Option<String>,
    pub armed: String,
    pub cron: Option<String>,
    pub reason: Option<String>,
    pub look: Look,
    /// The whole prompt (the row's tooltip).
    pub title: String,
}

/// `new Date(ms).toLocaleString()` in en-US: `11/27/2026, 4:05:00 AM`.
pub fn locale_date_time<Tz: chrono::TimeZone>(ms: f64, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    if !ms.is_finite() {
        return "Invalid Date".into();
    }
    match tz.timestamp_millis_opt(ms as i64).single() {
        Some(at) => at.format("%-m/%-d/%Y, %-I:%M:%S %p").to_string(),
        None => "Invalid Date".into(),
    }
}

pub fn loop_row<Tz: chrono::TimeZone>(
    l: &ScheduledLoop,
    can_cancel: bool,
    cancelling: &HashSet<String>,
    now: f64,
    tz: &Tz,
) -> LoopRow
where
    Tz::Offset: std::fmt::Display,
{
    let elapsed = ((now - l.started_at) / 1000.0).max(0.0);
    let wakeup = l.kind == ScheduledLoopKind::Wakeup;
    let cancelled = l.cancelled == Some(true);
    let is_cancelling = cancelling.contains(&l.id);
    let muted = cancelled || is_cancelling;
    let look = if muted {
        Look::quiet(40.)
    } else if wakeup {
        Look::tint("amber-500", 30., 10., "amber-100")
    } else {
        Look::tint("violet-500", 30., 10., "violet-100")
    };
    let cadence = if wakeup {
        if cancelled {
            "stopped".into()
        } else {
            match l.delay_seconds {
                None => "scheduled".into(),
                Some(d) => {
                    let remaining = d - elapsed;
                    if remaining <= 0.0 {
                        "due now".into()
                    } else {
                        format!("fires in {}", fmt_elapsed_sec(remaining))
                    }
                }
            }
        }
    } else {
        l.human_schedule
            .clone()
            .or_else(|| l.cron.clone())
            .unwrap_or_else(|| "scheduled".into())
    };
    let next_fire = l
        .next_fire_at
        .filter(|at| !wakeup && !muted && *at > now)
        .map(|at| {
            (
                format!("next in {}", fmt_elapsed_sec((at - now) / 1000.0)),
                format!("Next run {}", locale_date_time(at, tz)),
            )
        });
    let noop = (l.noop == Some(true)).then(|| match l.noop_streak {
        Some(n) if n > 1.0 => format!("quiet hold \u{d7}{}", crate::format::number_to_string(n)),
        _ => "quiet hold".into(),
    });
    let cancel = (can_cancel && !cancelled && !is_cancelling).then_some(if wakeup {
        (
            "Ask the agent to stop this self-paced loop",
            "Ask the agent to stop the loop (sends a ScheduleWakeup stop request)",
        )
    } else {
        (
            "Ask the agent to cancel this loop",
            "Ask the agent to cancel (sends a CronDelete request)",
        )
    });
    let state = if cancelled {
        Some("cancelled")
    } else if is_cancelling {
        Some("cancelling\u{2026}")
    } else {
        None
    };
    let preview = js::trim(&l.prompt).split('\n').next().unwrap_or_default();
    LoopRow {
        id: l.id.clone(),
        kind: l.kind,
        icon: if wakeup { "Timer" } else { "Repeat" },
        cadence,
        recurring: !wakeup && l.recurring,
        next_fire,
        durable: l.durable,
        noop,
        cancel,
        state,
        prompt_preview: Some(preview.to_owned()).filter(|p| !p.is_empty()),
        armed: format!("armed {} ago", fmt_elapsed_sec(elapsed)),
        cron: (!wakeup && l.human_schedule.as_deref().is_some_and(|h| !h.is_empty()))
            .then(|| l.cron.clone().filter(|c| !c.is_empty()))
            .flatten(),
        reason: non_empty(&l.reason).map(|r| format!("\u{b7} {r}")),
        look,
        title: l.prompt.clone(),
    }
}

/// The Scheduled loops section's badge (BackgroundTasksPanel.tsx:937).
pub fn loops_badge(all: usize, active: usize) -> String {
    if active > 0 {
        let cancelled = if all > active {
            format!(" \u{b7} {} cancelled", all - active)
        } else {
            String::new()
        };
        format!("({active}{cancelled})")
    } else {
        format!("({all})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wakeup(delay: Option<f64>) -> ScheduledLoop {
        ScheduledLoop {
            kind: ScheduledLoopKind::Wakeup,
            id: "w1".into(),
            tool_use_id: "tu".into(),
            cron: None,
            human_schedule: None,
            delay_seconds: delay,
            prompt: "  check the build\nand more".into(),
            reason: None,
            recurring: false,
            durable: false,
            started_at: 0.0,
            noop: None,
            noop_streak: None,
            next_fire_at: None,
            cancelled: None,
        }
    }

    #[test]
    fn a_wakeup_counts_down_then_reads_due_now_and_stopped_once_cancelled() {
        let none = HashSet::new();
        let l = wakeup(Some(300.0));
        let row = loop_row(&l, true, &none, 60_000.0, &chrono::Utc);
        assert_eq!(row.cadence, "fires in 4m");
        assert_eq!(row.armed, "armed 1m ago");
        assert_eq!(row.prompt_preview.as_deref(), Some("check the build"));
        assert!(row.cancel.is_some());
        let row = loop_row(&l, true, &none, 300_000.0, &chrono::Utc);
        assert_eq!(row.cadence, "due now");
        let mut l = l;
        l.cancelled = Some(true);
        let row = loop_row(&l, true, &none, 0.0, &chrono::Utc);
        assert_eq!(row.cadence, "stopped");
        assert_eq!(row.state, Some("cancelled"));
        assert!(row.cancel.is_none());
        assert_eq!(
            loop_row(&wakeup(None), true, &none, 0.0, &chrono::Utc).cadence,
            "scheduled"
        );
    }

    #[test]
    fn a_cancelling_loop_is_muted_and_has_no_x() {
        let ids: HashSet<String> = ["w1".to_owned()].into();
        let row = loop_row(&wakeup(Some(300.0)), true, &ids, 0.0, &chrono::Utc);
        assert_eq!(row.state, Some("cancelling\u{2026}"));
        assert!(row.cancel.is_none());
        assert_eq!(row.look, Look::quiet(40.));
    }

    #[test]
    fn loops_badge_counts_the_cancelled() {
        assert_eq!(loops_badge(3, 2), "(2 \u{b7} 1 cancelled)");
        assert_eq!(loops_badge(2, 2), "(2)");
        assert_eq!(loops_badge(2, 0), "(2)");
    }

    #[test]
    fn tools_badge_names_the_running_calls() {
        assert_eq!(tools_badge(0, 0), None);
        assert_eq!(tools_badge(4, 0).as_deref(), Some("(4)"));
        assert_eq!(tools_badge(4, 1).as_deref(), Some("(1 running \u{b7} 4)"));
    }
}
