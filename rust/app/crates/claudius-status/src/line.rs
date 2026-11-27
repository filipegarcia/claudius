//! `components/chat/StatusLine.tsx` as data: [`StatusProps`] is what
//! `ChatSurface` passes it (ChatSurface.tsx:2428, from `useSession()`, plus
//! the host's context poll and settings), and [`status_line`] is what each
//! segment shows, its tone and its tooltip. No GPUI: the view
//! ([`crate::view`]) draws the model.
//!
//! The helpers it calls, each with its source: `workingStatusLabel`
//! (`lib/shared/turn-status-label.ts`), `formatElapsed` /
//! `useElapsedSeconds` (`lib/client/use-elapsed.ts`, ported in
//! `claudius_chat::tool_text`), `worktreeBadge` (`lib/client/worktree.ts`),
//! `modelDeprecationDate` (`lib/shared/model-deprecations.ts`),
//! `prettyModelName` (`lib/shared/advisor.ts`, ported in
//! `claudius_client::shared`), `fastModeDisabledReasonLabel`
//! (`lib/shared/fast-mode.ts`) and `formatClockTime`
//! (`lib/client/format-message-time.ts`).

use claudius_agent::js;
use claudius_chat::tool_text::{elapsed_seconds, format_elapsed};
use claudius_client::idle_reconcile::ToolHistoryKind;
use claudius_client::shared::pretty_model_name;
use claudius_client::state::ChatState;
use claudius_core::image_size::js_round;
use serde_json::Value;

use crate::modes::{self, ModeMeta};
use crate::tone::{Chip, Tone};

/// `DEEP_IN_THOUGHT_THRESHOLD_SEC` (turn-status-label.ts:23).
pub const DEEP_IN_THOUGHT_THRESHOLD_SEC: f64 = 45.0;

/// `workingStatusLabel(turnElapsedSec, { toolActive, resumingThought })`
/// (turn-status-label.ts:29): resuming after the output-token limit
/// first, then "Deep in thought" from 45 s on unless a tool runs.
pub fn working_status_label(
    turn_elapsed_sec: Option<f64>,
    tool_active: bool,
    resuming_thought: bool,
) -> &'static str {
    if resuming_thought {
        return "Picking the thought back up";
    }
    if !tool_active && turn_elapsed_sec.is_some_and(|s| s >= DEEP_IN_THOUGHT_THRESHOLD_SEC) {
        return "Deep in thought";
    }
    "Working"
}

/// `DEPRECATED_MODELS` (model-deprecations.ts:18): model id → end of life.
pub const DEPRECATED_MODELS: [(&str, &str); 17] = [
    ("claude-1.3", "November 6th, 2024"),
    ("claude-1.3-100k", "November 6th, 2024"),
    ("claude-instant-1.1", "November 6th, 2024"),
    ("claude-instant-1.1-100k", "November 6th, 2024"),
    ("claude-instant-1.2", "November 6th, 2024"),
    ("claude-2.0", "July 21st, 2025"),
    ("claude-2.1", "July 21st, 2025"),
    ("claude-3-sonnet-20240229", "July 21st, 2025"),
    ("claude-3-opus-20240229", "January 5th, 2026"),
    ("claude-3-7-sonnet-latest", "February 19th, 2026"),
    ("claude-3-7-sonnet-20250219", "February 19th, 2026"),
    ("claude-3-5-haiku-latest", "February 19th, 2026"),
    ("claude-3-5-haiku-20241022", "February 19th, 2026"),
    ("claude-opus-4-0", "June 15th, 2026"),
    ("claude-opus-4-20250514", "June 15th, 2026"),
    ("claude-sonnet-4-0", "June 15th, 2026"),
    ("claude-sonnet-4-20250514", "June 15th, 2026"),
];

/// `modelDeprecationDate(model)` (model-deprecations.ts:43): the id
/// verbatim, `None` when it isn't listed.
pub fn model_deprecation_date(model: Option<&str>) -> Option<&'static str> {
    let model = model.filter(|m| !m.is_empty())?;
    DEPRECATED_MODELS
        .iter()
        .find(|(id, _)| *id == model)
        .map(|(_, date)| *date)
}

/// `FAST_MODE_DISABLED_REASON_LABELS` (fast-mode.ts:34).
pub const FAST_MODE_DISABLED_REASON_LABELS: [(&str, &str); 10] = [
    ("free", "Your plan doesn't include fast mode."),
    ("preference", "Fast mode is turned off in your preferences."),
    (
        "extra_usage_disabled",
        "Extra usage is disabled, and fast mode requires it.",
    ),
    (
        "network_error",
        "Fast mode is unavailable \u{2014} a network error reaching the fast-mode backend.",
    ),
    (
        "unknown",
        "Fast mode is unavailable for an unspecified reason.",
    ),
    (
        "not_first_party",
        "Fast mode isn't available on this provider.",
    ),
    (
        "disabled_by_env",
        "Fast mode is disabled by your environment configuration.",
    ),
    (
        "model_not_allowed",
        "Fast mode isn't available for the current model.",
    ),
    (
        "sdk_opt_in_required",
        "Fast mode requires an SDK opt-in that hasn't been set.",
    ),
    (
        "pending",
        "Fast mode availability is still being determined.",
    ),
];

/// `fastModeDisabledReasonLabel(raw)` (fast-mode.ts:54): a known reason's
/// copy, else the neutral wording.
pub fn fast_mode_disabled_reason_label(raw: Option<&str>) -> &'static str {
    raw.and_then(|r| {
        FAST_MODE_DISABLED_REASON_LABELS
            .iter()
            .find(|(k, _)| *k == r)
            .map(|(_, v)| *v)
    })
    .unwrap_or("Fast mode is temporarily unavailable.")
}

/// `stripTrailingSlash` (worktree.ts:11): `s.replace(/\/+$/, "")`.
fn strip_trailing_slash(s: &str) -> &str {
    s.trim_end_matches('/')
}

/// `worktreeBadge(agentCwd, sessionRoot)` (worktree.ts:27): the badge's
/// label once the agent's cwd left the session root, else `None` (a path
/// missing, or the same directory once trailing slashes go).
pub fn worktree_badge(agent_cwd: Option<&str>, session_root: Option<&str>) -> Option<String> {
    let agent_cwd = agent_cwd.filter(|s| !s.is_empty())?;
    let session_root = session_root.filter(|s| !s.is_empty())?;
    let root = strip_trailing_slash(session_root);
    let dir = strip_trailing_slash(agent_cwd);
    if dir.is_empty() || dir == root {
        return None;
    }
    Some(worktree_badge_label(dir, root))
}

/// `worktreeBadgeLabel(agentCwd, sessionRoot)` (worktree.ts:48): relative
/// to the root when under it, else the last path segment.
pub fn worktree_badge_label(agent_cwd: &str, session_root: &str) -> String {
    let root = strip_trailing_slash(session_root);
    let dir = strip_trailing_slash(agent_cwd);
    if !root.is_empty()
        && let Some(rest) = dir.strip_prefix(root).and_then(|r| r.strip_prefix('/'))
    {
        return rest.to_owned();
    }
    match dir.split('/').rfind(|s| !s.is_empty()) {
        Some(base) => base.to_owned(),
        None => dir.to_owned(),
    }
}

/// `formatClockTime(at, {})` (format-message-time.ts:145) in en-US:
/// `Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" })`, the
/// hour unpadded and a space before AM / PM (node@22's ICU). The
/// clock settings (`timeFormat` / `timeZone`) aren't read yet: the
/// locale's default, in `tz`.
pub fn format_clock_time<Tz: chrono::TimeZone>(at_ms: f64, tz: &Tz) -> Option<String>
where
    Tz::Offset: std::fmt::Display,
{
    if !at_ms.is_finite() {
        return None;
    }
    let at = tz.timestamp_millis_opt(at_ms as i64).single()?;
    Some(at.format("%-I:%M %p").to_string())
}

/// `Number.prototype.toFixed(digits)`: the exact value rounded to
/// `digits` places, a tie going to the larger magnitude; `String(x)` from
/// `1e21` up. A copy of `claudius_client::sdk::to_fixed` (crate-private
/// there).
pub fn to_fixed(x: f64, digits: u32) -> String {
    let (sign, a) = if x < 0.0 { ("-", -x) } else { ("", x + 0.0) };
    if a.is_infinite() {
        return format!("{sign}Infinity");
    }
    if a >= 1e21 {
        return format!("{sign}{}", js::number_to_string(a));
    }
    // A tie is `a = j / 2^(digits + 1)` with `j` odd.
    let scaled = a * 2f64.powi(digits as i32 + 1);
    let body = if scaled.fract() == 0.0 && scaled % 2.0 == 1.0 {
        let n = ((scaled as u128) * 5u128.pow(digits)).div_ceil(2);
        let s = format!("{n:0>width$}", width = digits as usize + 1);
        let (int, frac) = s.split_at(s.len() - digits as usize);
        if digits == 0 {
            int.to_owned()
        } else {
            format!("{int}.{frac}")
        }
    } else {
        format!("{a:.prec$}", prec = digits as usize)
    };
    format!("{sign}{body}")
}

/// The cost chip's text (StatusLine.tsx:545): the cost to 4 places under
/// a cent, else 3, or an em dash with no cost.
pub fn cost_text(total_cost_usd: Option<f64>) -> String {
    match total_cost_usd.filter(|c| *c > 0.0) {
        Some(c) if c < 0.01 => format!("${}", to_fixed(c, 4)),
        Some(c) => format!("${}", to_fixed(c, 3)),
        None => "\u{2014}".into(),
    }
}

/// The cost chip's token count (StatusLine.tsx:548): `12.3K tok` from a
/// thousand on, `999 tok` under it, none without output tokens.
pub fn tokens_text(output_tokens: Option<f64>) -> Option<String> {
    let t = output_tokens.filter(|t| *t > 0.0)?;
    Some(if t >= 1000.0 {
        format!("{}K tok", to_fixed(t / 1000.0, 1))
    } else {
        format!("{} tok", js::number_to_string(t))
    })
}

/// The context chip's level (StatusLine.tsx:281).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CtxLevel {
    Ok,
    Warn,
    Danger,
}

impl CtxLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            CtxLevel::Ok => "ok",
            CtxLevel::Warn => "warn",
            CtxLevel::Danger => "danger",
        }
    }

    /// The chip's `title` (StatusLine.tsx:590).
    pub fn title(self) -> &'static str {
        match self {
            CtxLevel::Danger => "Context near full \u{2014} consider /compact",
            CtxLevel::Warn => "Context filling up",
            CtxLevel::Ok => "Context window",
        }
    }

    pub fn chip(self) -> Chip {
        match self {
            CtxLevel::Ok => Chip::Panel,
            CtxLevel::Warn => Chip::Amber,
            CtxLevel::Danger => Chip::Red,
        }
    }
}

/// `Math.round(contextPercent)` and its level: 90 and up is danger, 75
/// and up a warning (StatusLine.tsx:280).
pub fn context_level(context_percent: f64) -> (f64, CtxLevel) {
    let ctx = js_round(context_percent);
    let level = if ctx >= 90.0 {
        CtxLevel::Danger
    } else if ctx >= 75.0 {
        CtxLevel::Warn
    } else {
        CtxLevel::Ok
    };
    (ctx, level)
}

/// The four states the dot and the label show (StatusLine.tsx:235).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Starting,
    Working,
    /// Idle, with backgrounded subagents / workflows still running.
    Background,
    Idle,
}

impl Status {
    /// `data-status`.
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Starting => "starting",
            Status::Working => "working",
            Status::Background => "background",
            Status::Idle => "idle",
        }
    }

    /// The dot's color (StatusLine.tsx:242).
    pub fn tone(self) -> Tone {
        match self {
            Status::Starting => Tone::Amber400,
            Status::Working => Tone::Accent,
            Status::Background => Tone::Sky400,
            Status::Idle => Tone::Emerald400,
        }
    }
}

/// `ToNumber(v)` for a JSON value, as `v > 0` compares it.
fn js_to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js::to_number(s),
        Value::Array(_) => js::to_number(&js::to_string(Some(v))),
        Value::Object(_) => f64::NAN,
    }
}

/// `useSession()`'s `account`, as the badge reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub label: String,
    /// The account the default moved to since (`driftFromActive.label`).
    pub drift_to: Option<String>,
}

/// What `ChatSurface` passes `StatusLine` (ChatSurface.tsx:2428), the
/// host's parts included.
#[derive(Clone, Debug, PartialEq)]
pub struct StatusProps {
    pub session_id: Option<String>,
    pub ready: bool,
    pub pending: bool,
    /// `streamStatus` (`"live"` / `"reconnecting"`).
    pub stream_status: String,
    /// `backgroundTasks`, as sent (`turn_status`'s count).
    pub background_tasks: Value,
    pub turn_started_at: Option<f64>,
    /// `runningHook`: `{ event, startedAt }` or `null`.
    pub running_hook: Value,
    /// `toolHistory.some((e) => !e.done && e.kind !== "thinking")`.
    pub tool_active: bool,
    /// `apiRetry?.error === "max_output_tokens"`.
    pub resuming_thought: bool,
    pub last_turn_completed_at: Option<f64>,
    pub permission_mode: String,
    pub model: Option<String>,
    pub main_agent: Option<String>,
    pub account: Option<Account>,
    /// `session.cwd`.
    pub session_root: Option<String>,
    pub agent_cwd: Option<String>,
    /// `ctxSummary?.percentage`: the host's context poll.
    pub context_percent: Option<f64>,
    pub fast_mode_state: Value,
    pub fast_mode_disabled_reason: Option<String>,
    /// `usage?.totalCostUsd` / `usage?.outputTokens`, when numbers.
    pub total_cost_usd: Option<f64>,
    pub output_tokens: Option<f64>,
    /// `useDisableAutoMode(cwd) ? ["auto"] : undefined`.
    pub disabled_modes: Vec<String>,
    /// `focusLevel === "zen"`: everything but the focus toggle hides.
    pub zen: bool,
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}

impl StatusProps {
    /// The props off a chat's state (ChatSurface.tsx:2428), without the
    /// host's parts (no context reading, no disabled modes). A cell that
    /// isn't the JSON type the TS reads (a number for a model, say) reads
    /// as absent.
    pub fn of(s: &ChatState) -> StatusProps {
        let usage = Some(&s.usage);
        let account = s.account.as_ref().and_then(|a| {
            let a = a.as_object()?;
            Some(Account {
                id: js::to_string(a.get("id")),
                label: js::to_string(a.get("label")),
                // `account.driftFromActive && …`: its label as the
                // template prints it.
                drift_to: a
                    .get("driftFromActive")
                    .filter(|d| js::truthy(d))
                    .map(|d| js::to_string(js::prop(Some(d), "label"))),
            })
        });
        StatusProps {
            session_id: s.session_id.clone(),
            ready: s.ready,
            pending: s.pending,
            stream_status: s.stream_status.to_owned(),
            background_tasks: s.background_tasks.clone(),
            turn_started_at: s.turn_started_at,
            running_hook: s.running_hook.clone(),
            tool_active: s
                .tool_history
                .iter()
                .any(|e| e.done != Some(true) && e.kind != Some(ToolHistoryKind::Thinking)),
            resuming_thought: s
                .api_retry
                .as_ref()
                .is_some_and(|r| r.error == "max_output_tokens"),
            last_turn_completed_at: s.last_turn_completed_at,
            permission_mode: s
                .permission_mode
                .as_ref()
                .and_then(Value::as_str)
                .unwrap_or("default")
                .to_owned(),
            model: str_of(Some(&s.model)),
            main_agent: str_of(s.main_agent.as_ref()),
            account,
            session_root: str_of(Some(&s.cwd)),
            agent_cwd: str_of(s.agent_cwd.as_ref()),
            context_percent: None,
            fast_mode_state: s.fast_mode_state.clone(),
            fast_mode_disabled_reason: str_of(Some(&s.fast_mode_disabled_reason)),
            total_cost_usd: js::prop(usage, "totalCostUsd").and_then(Value::as_f64),
            output_tokens: js::prop(usage, "outputTokens").and_then(Value::as_f64),
            disabled_modes: Vec::new(),
            zen: false,
        }
    }
}

/// A badge with its tooltip.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Badge {
    pub text: String,
    pub title: String,
}

/// The model segment (StatusLine.tsx:413).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelChip {
    /// `prettyModelName(model)`.
    pub text: String,
    /// The raw id (the deprecation chip's `data-model`).
    pub model: String,
    pub title: String,
    /// On the deprecation list: an amber chip with a warning icon.
    pub deprecated: bool,
}

/// The agent pill (StatusLine.tsx:465): `ChatSurface` passes
/// `onPickAgent`, so it always shows, `Default` for the default agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPill {
    pub text: String,
    pub title: String,
    pub named: bool,
}

/// The account badge (StatusLine.tsx:495).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountBadge {
    pub id: String,
    pub text: String,
    pub title: String,
    /// Pinned to an account that is no longer the default: amber, and a
    /// click moves the session.
    pub drift: bool,
}

/// The cost / usage chip (StatusLine.tsx:539).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CostChip {
    pub cost: String,
    pub tokens: Option<String>,
}

/// The fast-mode chip (StatusLine.tsx:555).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FastChip {
    /// `data-fast-state`.
    pub state: String,
    /// `⚡ <state>`.
    pub text: String,
    pub title: String,
    /// On: amber, with `· credits` on a wide row.
    pub on: bool,
}

/// The context chip (StatusLine.tsx:581).
#[derive(Clone, Debug, PartialEq)]
pub struct ContextChip {
    /// `Math.round(contextPercent)`.
    pub percent: f64,
    /// `<percent>%`.
    pub text: String,
    pub level: CtxLevel,
}

/// The mode selector's trigger (ModeSelector.tsx:126).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModeTrigger {
    pub meta: &'static ModeMeta,
    pub title: String,
}

/// Every segment of the status line, left to right.
#[derive(Clone, Debug, PartialEq)]
pub struct StatusLineModel {
    pub status: Status,
    /// The dot pulses (anything but idle).
    pub busy: bool,
    /// `status-line-text`.
    pub label: String,
    pub label_title: Option<String>,
    pub worktree: Option<Badge>,
    /// The Reconnecting badge's tooltip, while the stream is down.
    pub reconnecting: Option<&'static str>,
    pub model: Option<ModelChip>,
    pub agent: AgentPill,
    pub account: Option<AccountBadge>,
    // ---- the right cluster (all hidden in zen but the focus toggle)
    pub zen: bool,
    pub cost: Option<CostChip>,
    pub fast: Option<FastChip>,
    pub context: Option<ContextChip>,
    /// The Compact button is disabled (`!ready || pending`).
    pub compact_disabled: bool,
    pub mode: ModeTrigger,
    /// `status-line-elapsed`: the running turn's time.
    pub elapsed: Option<String>,
    /// `status-line-hook`: the hook blocking the turn.
    pub hook: Option<Badge>,
    /// `status-line-done`: when the last turn ended.
    pub done_at: Option<String>,
}

/// The Reconnecting badge's tooltip (StatusLine.tsx:373).
pub const RECONNECTING_TITLE: &str = "Lost the live connection to this session \u{2014} reconnecting.\n\nNothing is lost: the transcript is written to disk by the agent itself and the server keeps its own buffer, both independently of this tab. What you see below may be behind until the connection is back, at which point the transcript rebuilds from the server.";

/// The default agent's pill tooltip (StatusLine.tsx:1004).
pub const DEFAULT_AGENT_TITLE: &str =
    "Running as the default general-purpose agent. Click to switch to a named agent.";

/// The cost chip's tooltip (StatusLine.tsx:542).
pub const COST_TITLE: &str = "Session cost & usage";
/// The elapsed chip's tooltip (StatusLine.tsx:691).
pub const ELAPSED_TITLE: &str = "Elapsed time for the current turn";
/// The done chip's tooltip (StatusLine.tsx:711).
pub const DONE_TITLE: &str = "Wall-clock time the last turn finished";

/// The worktree badge's tooltip (StatusLine.tsx:362): the raw cwd.
pub fn worktree_title(agent_cwd: &str) -> String {
    format!(
        "Agent is working in a git worktree, not your current checkout:\n{agent_cwd}\n\nEdits made here won't appear in your main working tree until the worktree is merged or removed."
    )
}

/// The background state's tooltip (StatusLine.tsx:396).
pub fn background_title(background_tasks: &Value) -> String {
    let n = js::to_string(Some(background_tasks));
    let one = background_tasks.as_f64() == Some(1.0);
    format!(
        "{n} background {} still running \u{2014} the turn is idle but work continues. See the Activity panel.",
        if one { "task is" } else { "tasks are" }
    )
}

/// "Deep in thought"'s tooltip (StatusLine.tsx:405).
pub fn deep_in_thought_title(turn_elapsed_sec: Option<f64>) -> String {
    let for_ = turn_elapsed_sec.map_or_else(|| "a while".to_owned(), format_elapsed);
    format!("Still working \u{2014} this turn has been running for {for_} without a break.")
}

/// The status line at `now_ms` (the elapsed tickers' clock), its clock
/// times in `tz`.
pub fn status_line<Tz: chrono::TimeZone>(p: &StatusProps, now_ms: f64, tz: &Tz) -> StatusLineModel
where
    Tz::Offset: std::fmt::Display,
{
    let bg_running = js_to_number(&p.background_tasks) > 0.0;
    let status = if !p.ready {
        Status::Starting
    } else if p.pending {
        Status::Working
    } else if bg_running {
        Status::Background
    } else {
        Status::Idle
    };
    let working = status == Status::Working;
    let turn_elapsed = elapsed_seconds(p.turn_started_at, working, now_ms);
    let hook_started = js::prop(Some(&p.running_hook), "startedAt").and_then(Value::as_f64);
    let hook_on = js::truthy(&p.running_hook);
    let hook_elapsed = elapsed_seconds(hook_started, hook_on, now_ms);
    let label = match status {
        Status::Background => format!(
            "Idle \u{b7} {} running",
            js::to_string(Some(&p.background_tasks))
        ),
        Status::Working => {
            working_status_label(turn_elapsed, p.tool_active, p.resuming_thought).to_owned()
        }
        Status::Starting => "Starting".into(),
        Status::Idle => "Idle".into(),
    };
    let label_title = if status == Status::Background {
        Some(background_title(&p.background_tasks))
    } else if label == "Deep in thought" {
        Some(deep_in_thought_title(turn_elapsed))
    } else {
        None
    };
    let done_at = if !working {
        p.last_turn_completed_at
            .and_then(|at| format_clock_time(at, tz))
    } else {
        None
    };
    let worktree =
        worktree_badge(p.agent_cwd.as_deref(), p.session_root.as_deref()).map(|text| Badge {
            text,
            title: worktree_title(p.agent_cwd.as_deref().unwrap_or_default()),
        });
    let model = p.model.as_deref().filter(|m| !m.is_empty()).map(|m| {
        let eol = model_deprecation_date(Some(m));
        ModelChip {
            text: pretty_model_name(Some(m)),
            model: m.to_owned(),
            title: match eol {
                Some(eol) => format!(
                    "Model {m} reaches end-of-life on {eol}. Switch to a current model to avoid an automatic fallback."
                ),
                None => m.to_owned(),
            },
            deprecated: eol.is_some(),
        }
    });
    // `currentAgent ?? "Default"` for the text, `currentAgent ? … : …`
    // for the rest: an empty name prints empty, as the default agent.
    let agent = match p.main_agent.as_deref() {
        Some("") => AgentPill {
            text: String::new(),
            title: DEFAULT_AGENT_TITLE.into(),
            named: false,
        },
        Some(a) => AgentPill {
            text: a.to_owned(),
            title: format!(
                "Main-thread agent: {a} (its system prompt, tools, and model apply). Click to switch."
            ),
            named: true,
        },
        None => AgentPill {
            text: "Default".into(),
            title: DEFAULT_AGENT_TITLE.into(),
            named: false,
        },
    };
    let account = p.account.as_ref().map(|a| match &a.drift_to {
        Some(to) => AccountBadge {
            id: a.id.clone(),
            text: a.label.clone(),
            title: format!(
                "This session is running as \"{l}\".\nYou've since switched the default account to \"{to}\".\n\nIts identity and billing stay on \"{l}\" so the conversation doesn't change accounts mid-thread.\n\nClick to move this session to \"{to}\" \u{2014} the session restarts and replays, nothing is lost.",
                l = a.label
            ),
            drift: true,
        },
        None => AccountBadge {
            id: a.id.clone(),
            text: a.label.clone(),
            title: format!("Running under account: {}", a.label),
            drift: false,
        },
    });
    let has_cost = p.total_cost_usd.is_some_and(|c| c > 0.0);
    let has_tokens = p.output_tokens.is_some_and(|t| t > 0.0);
    let cost = (has_cost || has_tokens).then(|| CostChip {
        cost: cost_text(p.total_cost_usd),
        tokens: tokens_text(p.output_tokens),
    });
    let fast =
        (js::truthy(&p.fast_mode_state) && p.fast_mode_state.as_str() != Some("off")).then(|| {
            let state = js::to_string(Some(&p.fast_mode_state));
            let on = state == "on" && p.fast_mode_state.is_string();
            FastChip {
                text: format!("\u{26a1} {state}"),
                title: if on {
                    "Fast mode active \u{2014} draws from usage credits".into()
                } else {
                    fast_mode_disabled_reason_label(p.fast_mode_disabled_reason.as_deref()).into()
                },
                state,
                on,
            }
        });
    let context = p.context_percent.map(|pct| {
        let (percent, level) = context_level(pct);
        ContextChip {
            text: format!("{}%", js::number_to_string(percent)),
            percent,
            level,
        }
    });
    let meta = modes::trigger_meta(&p.permission_mode);
    let hook = hook_on.then(|| {
        let event = js::to_string(js::prop(Some(&p.running_hook), "event"));
        let tail = hook_elapsed
            .map(|s| format!(" \u{b7} {}", format_elapsed(s)))
            .unwrap_or_default();
        Badge {
            text: format!("Running {event} hook{tail}"),
            title: format!("A {event} hook is running"),
        }
    });
    StatusLineModel {
        status,
        busy: status != Status::Idle,
        label,
        label_title,
        worktree,
        reconnecting: (p.stream_status == "reconnecting").then_some(RECONNECTING_TITLE),
        model,
        agent,
        account,
        zen: p.zen,
        cost,
        fast,
        context,
        compact_disabled: !p.ready || p.pending,
        mode: ModeTrigger {
            meta,
            title: modes::trigger_title(meta),
        },
        elapsed: turn_elapsed.map(format_elapsed),
        hook,
        done_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_ties_up_as_js() {
        assert_eq!(to_fixed(0.0625, 3), "0.063");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(-0.0, 1), "0.0");
        assert_eq!(to_fixed(2e21, 1), "2e+21");
    }
}
