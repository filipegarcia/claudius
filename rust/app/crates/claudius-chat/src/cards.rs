//! The tool cards as data (U06): what `AssistantMessage.tsx` renders for a
//! `tool_use` block, no GPUI. A block goes to one of four cards, as
//! `AssistantMessage` dispatches it (lines ~170–260):
//!
//! - `Task` / `Agent` ([`TaskCard`], `TaskBlock.tsx`), with the subagent's
//!   own messages and their tool calls inside,
//! - `Workflow` ([`WorkflowCard`], `WorkflowBlock.tsx`),
//! - `ProposeGoal` ([`GoalCard`], `ProposeGoalBlock.tsx`),
//! - every other tool ([`CallCard`], `ToolCall.tsx`: Bash, Read, Edit, Grep,
//!   WebFetch, MCP tools, … all through the one generic card).
//!
//! Each rule cites the component line it mirrors. A card's open state is
//! its default (the verbose level's `defaultOpen`) flipped by a click
//! ([`ViewOptions::toggled`]); a part inside a card (`<details>`, a fold, an
//! inner tool call) keys under its card (`<card key>/<part>`) and resets
//! when the card closes, as the React body unmounts.
//!
//! **Native additions:** a long `<pre>` (tool input JSON, a result, a
//! spawn prompt, a hand-back, a script) or plan folds past
//! [`ViewOptions::fold_bytes`] behind "Show more" (U00a: huge tool inputs
//! were the 12–30 KB rows that hitched), and the JSON view folds the same
//! way once expanded.

use std::collections::HashMap;
use std::sync::Arc;

use claudius_client::state::ChatState;
use claudius_client::task_status::{TaskInfo, TaskResourceLink};
use claudius_client::{DisplayBlock, DisplayMessage, Role, ToolResult};
use serde_json::Value;

use crate::rows::{Fold, IconRef, RowBuilder, ThinkingBody, ViewOptions};
use crate::text;
use crate::tool_text::{
    self, FileTarget, HandBack, JsonTokenType, PreviewType, SettledToolReason, capitalize,
    format_duration, safe_json_object, settled_tool_reason, str_value,
};

/// `JsonBlock`'s `maxCollapsedLines` default.
pub const JSON_COLLAPSED_LINES: usize = 12;

/// Where the cards' files resolve (`FileLinkBase`,
/// `lib/client/file-link-context.ts`): the active workspace and its root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileLink {
    pub workspace_id: String,
    pub cwd: String,
}

/// Which card a block gets (`AssistantMessage`'s dispatch).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardKind {
    Tool,
    /// `isSubagentToolName`: `Task` / `Agent`.
    Task,
    Workflow,
    ProposeGoal,
}

impl CardKind {
    pub fn of(name: &str) -> CardKind {
        match name {
            "Task" | "Agent" => CardKind::Task,
            "Workflow" => CardKind::Workflow,
            "ProposeGoal" => CardKind::ProposeGoal,
            _ => CardKind::Tool,
        }
    }
}

/// One card.
#[derive(Clone, Debug, PartialEq)]
pub enum Card {
    Call(CallCard),
    Task(TaskCard),
    Workflow(WorkflowCard),
    Goal(GoalCard),
}

impl Card {
    pub fn kind(&self) -> CardKind {
        match self {
            Card::Call(_) => CardKind::Tool,
            Card::Task(_) => CardKind::Task,
            Card::Workflow(_) => CardKind::Workflow,
            Card::Goal(_) => CardKind::ProposeGoal,
        }
    }

    /// The card's toggle key.
    pub fn key(&self) -> &str {
        match self {
            Card::Call(c) => &c.key,
            Card::Task(c) => &c.key,
            Card::Workflow(c) => &c.key,
            Card::Goal(c) => &c.key,
        }
    }

    pub fn open(&self) -> bool {
        match self {
            Card::Call(c) => c.open,
            Card::Task(c) => c.open,
            Card::Workflow(c) => c.open,
            Card::Goal(c) => c.open,
        }
    }

    /// Whether a running timer shows on this card or a call inside it.
    pub fn ticking(&self) -> bool {
        match self {
            Card::Call(c) => c.timer().is_some(),
            Card::Task(t) => t.body.as_ref().is_some_and(|b| {
                b.inner.iter().any(|m| match m {
                    SubMessage::Assistant { blocks, .. } => blocks
                        .iter()
                        .any(|b| matches!(b, SubBlock::Tool(c) if c.timer().is_some())),
                    SubMessage::User { .. } => false,
                })
            }),
            _ => false,
        }
    }
}

/// A `<pre>` text, folded past the fold size (a native addition).
#[derive(Clone, Debug, PartialEq)]
pub struct PreText {
    /// The fold's toggle key.
    pub key: String,
    /// What shows: all of it, or the part before the fold.
    pub text: Arc<str>,
    pub fold: PreFold,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreFold {
    Whole,
    /// "Show more (N KB)".
    Folded {
        hidden_bytes: usize,
    },
    /// "Show less".
    Expanded,
}

/// A `<details>` (closed until clicked); `body` only while open.
#[derive(Clone, Debug, PartialEq)]
pub struct Details<T> {
    pub key: String,
    pub summary: &'static str,
    pub body: Option<T>,
}

/// A markdown section of a card (the plan, the drafted report, a
/// subagent's text), folded as message text is.
#[derive(Clone, Debug, PartialEq)]
pub struct MdText {
    /// The markdown cache's key (and, `fold:`-prefixed, the fold's).
    pub key: String,
    pub text: Arc<str>,
    pub fold: Fold,
}

/// `JsonBlock`.
#[derive(Clone, Debug, PartialEq)]
pub struct JsonView {
    /// The fold toggle ("N lines — click to expand").
    pub key: String,
    /// `lineCount`: the newlines in the pretty text, plus one.
    pub lines: usize,
    /// Over [`JSON_COLLAPSED_LINES`] lines and not clicked open.
    pub collapsed: bool,
    /// The colored runs, `None` while collapsed; folded past the fold size
    /// like a [`PreText`] (`more` holds that fold).
    pub tokens: Option<Arc<[(String, JsonTokenType)]>>,
    pub more: PreFold,
}

/// `STATUS_CHIP`'s tints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChipTone {
    /// `pending`, and any status the map doesn't list.
    Pending,
    Sky,
    Emerald,
    Red,
    Amber,
}

/// What leads a chip's label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChipMark {
    None,
    /// The running dot (`animate-pulse`, or dimmed while disconnected).
    Pulse {
        dim: bool,
    },
    /// Paused's static dot.
    Dot,
    Check,
    Alert,
}

/// A status chip (`TaskBlock` / `WorkflowBlock`).
#[derive(Clone, Debug, PartialEq)]
pub struct Chip {
    pub tone: ChipTone,
    pub mark: ChipMark,
    /// As shown (`capitalize`).
    pub label: String,
    /// `opacity-60` (a disconnected subagent).
    pub dim: bool,
}

// ---------------------------------------------------------------- ToolCall

/// `ToolCall`: the generic card every other tool goes through.
#[derive(Clone, Debug, PartialEq)]
pub struct CallCard {
    pub key: String,
    pub name: String,
    pub open: bool,
    /// `Wrench`, or `MessageSquareHeart` for a feedback draft.
    pub icon: IconRef,
    /// The tool's name, or "Feedback draft".
    pub title: String,
    /// "— Plan" (`ExitPlanMode` with a plan).
    pub plan_suffix: bool,
    /// "— Run now" (`Schedule` / `RemoteTrigger`'s `action`).
    pub schedule_action: Option<String>,
    pub path: Option<PathLabel>,
    /// The AskUserQuestion pill.
    pub answer: Option<AnswerPill>,
    /// The paperclip badge (an `mcp_task`'s returned files).
    pub resource_count: Option<usize>,
    pub staged: bool,
    pub detached: bool,
    pub status: CallStatus,
    pub preview: Option<FilePreviewCard>,
    /// The expanded part, only while open.
    pub body: Option<CallBody>,
}

impl CallCard {
    /// The running timer's start (`useElapsedSeconds(startedAt, running)`).
    pub fn timer(&self) -> Option<f64> {
        match self.status {
            CallStatus::Running { since, .. } => since,
            _ => None,
        }
    }

    /// `data-not-run`: the dim card.
    pub fn dim(&self) -> bool {
        matches!(self.status, CallStatus::NotRun { .. })
    }
}

/// `TruncatedPath`: the directory (end-ellipsis) and the file name (whole).
#[derive(Clone, Debug, PartialEq)]
pub struct PathLabel {
    pub head: String,
    pub tail: String,
    /// The `title` (the whole path).
    pub full: String,
    /// The Files browser link, when the path is in the workspace.
    pub files: Option<FilesLink>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FilesLink {
    pub workspace_id: String,
    pub rel_path: String,
    /// `filesHref` (the route U12 / U04b open).
    pub href: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnswerPill {
    /// The SDK waits on this ask (pulsing "Answer"); else "Reopen".
    pub live: bool,
}

impl AnswerPill {
    pub fn label(self) -> &'static str {
        if self.live { "Answer" } else { "Reopen" }
    }

    pub fn title(self) -> &'static str {
        if self.live {
            "Open the question modal"
        } else {
            "Reopen this question — your answer will be sent as a follow-up message"
        }
    }
}

/// `ToolCall`'s `status`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CallStatus {
    /// The dot (dimmed while disconnected) and, with a start, the timer.
    Running {
        since: Option<f64>,
        disconnected: bool,
    },
    Ok,
    Error,
    /// A settled subagent's unfinished call.
    Interrupted(SettledToolReason),
    /// Auto mode skipped it (or the user rejected it).
    NotRun {
        rejected: bool,
    },
}

impl CallStatus {
    /// The `data-*` spelling: `running`, `ok`, `error`, `interrupted`,
    /// `notrun`.
    pub fn id(self) -> &'static str {
        match self {
            CallStatus::Running { .. } => "running",
            CallStatus::Ok => "ok",
            CallStatus::Error => "error",
            CallStatus::Interrupted(_) => "interrupted",
            CallStatus::NotRun { .. } => "notrun",
        }
    }

    /// The not-run label and its title.
    pub fn not_run_text(rejected: bool) -> (&'static str, &'static str) {
        if rejected {
            (
                "Not run · rejected",
                "Not run — you rejected this tool call",
            )
        } else {
            (
                "Not run",
                "Not run — auto mode's check had no usable answer, so this tool call was skipped",
            )
        }
    }
}

/// `FilePreview`: an image (open by default) or HTML (closed) under the
/// header, outside the expander.
#[derive(Clone, Debug, PartialEq)]
pub struct FilePreviewCard {
    pub key: String,
    pub kind: PreviewType,
    /// The basename.
    pub file_name: String,
    pub rel_path: String,
    pub workspace_id: String,
    /// The path as the tool had it (absolute inside the workspace).
    pub path: String,
    pub open: bool,
}

impl FilePreviewCard {
    /// The right-hand label.
    pub fn label(&self) -> &'static str {
        match (self.kind, self.open) {
            (PreviewType::Image, _) => "preview",
            (PreviewType::Html, true) => "html preview",
            (PreviewType::Html, false) => "render",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CallBody {
    pub main: CallMain,
    pub result: Option<ResultSection>,
    /// "files returned".
    pub links: Vec<ResourceLinkRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CallMain {
    /// "plan": `ExitPlanMode`'s markdown.
    Plan(MdText),
    /// "drafted report", with the `/feedback` note.
    Feedback(MdText),
    /// "input": `JSON.stringify(input, null, 2)`, and "Open" for a file.
    Input {
        editor: Option<EditorLink>,
        json: PreText,
    },
}

/// "Open" (`buildEditorUrl`); opening is the host's (U12 / U04b).
#[derive(Clone, Debug, PartialEq)]
pub struct EditorLink {
    pub path: String,
    pub line: Option<f64>,
    pub editor: String,
    pub url: String,
}

impl EditorLink {
    pub fn title(&self) -> String {
        format!("Open in editor ({})", self.editor)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResultSection {
    /// "result", "error", "not run" or "rejected".
    pub label: &'static str,
    pub tone: ResultTone,
    pub text: PreText,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultTone {
    Plain,
    /// `text-red-400`.
    Error,
    /// Not run: muted.
    Muted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceLinkRow {
    pub uri: String,
    /// `title ?? name`.
    pub label: String,
    /// `description ?? uri`.
    pub title: String,
}

/// `SCHEDULE_ACTION_LABELS[action] ?? action`.
pub fn schedule_action_label(action: &str) -> String {
    match action {
        "list" => "List routines",
        "get" => "Get routine",
        "create" => "Create routine",
        "update" => "Update routine",
        "run" => "Run now",
        "create_webhook_trigger" => "Create webhook trigger",
        "list_runs" => "List runs",
        "get_run_log" => "Get run log",
        other => other,
    }
    .to_owned()
}

// ---------------------------------------------------------------- TaskBlock

/// `TaskBlock`.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskCard {
    pub key: String,
    pub tool_use_id: String,
    pub open: bool,
    /// The agent-type pill (`subagent_type ?? agent ?? "Task"`).
    pub agent: String,
    /// "— {title}": the spawn intent, else the live activity.
    pub title: Option<String>,
    /// " · {activity}": the live activity when it differs from the intent.
    pub activity: Option<String>,
    /// "retrying 2/10" and its title.
    pub retrying: Option<(String, String)>,
    pub disconnected: bool,
    /// `data-task-status`.
    pub status: String,
    pub chip: Chip,
    /// "Opus 4.5 · high effort · 12,345 tok · 7 tools · 1m 2s".
    pub stats: Option<String>,
    pub body: Option<TaskBody>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskBody {
    /// "Spawn prompt".
    pub prompt: Option<Details<PreText>>,
    /// The task's error box.
    pub error: Option<String>,
    /// With no inner messages: why.
    pub empty_note: Option<&'static str>,
    pub inner: Vec<SubMessage>,
    /// "Returned to parent".
    pub returned: Option<Details<Returned>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Returned {
    pub text: PreText,
    /// `text-red-300` for an error result.
    pub error: bool,
    pub provenance: Vec<String>,
}

/// `SubMessage`: one message of the subagent's trail.
#[derive(Clone, Debug, PartialEq)]
pub enum SubMessage {
    /// "→ subagent" and the text.
    User { uuid: String, text: Arc<str> },
    /// "Subagent" and its blocks, all of them (the level doesn't filter a
    /// subagent's trail).
    Assistant { uuid: String, blocks: Vec<SubBlock> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum SubBlock {
    Text(MdText),
    Thinking {
        key: String,
        label: &'static str,
        open: bool,
        body: ThinkingBody,
    },
    /// Boxed: a card is much bigger than the other blocks.
    Tool(Box<CallCard>),
}

// ------------------------------------------------------------ WorkflowBlock

/// `WorkflowBlock`.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowCard {
    pub key: String,
    pub tool_use_id: String,
    pub open: bool,
    /// The open state outside ultra-verbose, before a click: open while
    /// no result is in, or when the card was first seen running (React's
    /// mount-time `useState(!result)`).
    pub live_default: bool,
    /// The name pill.
    pub name: String,
    /// "3 phases".
    pub phases_label: Option<String>,
    /// "size: medium" on a live run.
    pub size: Option<String>,
    /// `data-workflow-status`.
    pub status: String,
    pub chip: Chip,
    pub stats: Option<String>,
    pub body: Option<WorkflowBody>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowBody {
    pub description: Option<String>,
    /// The rolling summary while running, and whether its dot pulses.
    pub live_summary: Option<(String, bool)>,
    /// "Preparing workflow…".
    pub preparing: bool,
    /// `(number, title, detail)`.
    pub phases: Vec<(usize, String, Option<String>)>,
    pub error: Option<String>,
    /// "Result".
    pub result: Option<String>,
    pub run_id: Option<String>,
    pub transcript_dir: Option<String>,
    /// "Args".
    pub args: Option<Details<JsonView>>,
    /// "Raw output".
    pub raw: Option<Details<JsonView>>,
    /// "Show script".
    pub script: Option<Details<PreText>>,
}

// --------------------------------------------------------- ProposeGoalBlock

/// `ProposeGoalBlock`.
#[derive(Clone, Debug, PartialEq)]
pub struct GoalCard {
    pub key: String,
    pub open: bool,
    /// As [`WorkflowCard::live_default`].
    pub live_default: bool,
    pub condition: Option<String>,
    pub state: GoalState,
    pub body: Option<GoalBody>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GoalState {
    Error,
    Proposing,
    AwaitingApproval,
    GoalSet,
}

impl GoalState {
    pub fn label(self) -> &'static str {
        match self {
            GoalState::Error => "error",
            GoalState::Proposing => "proposing",
            GoalState::AwaitingApproval => "awaiting approval",
            GoalState::GoalSet => "goal set",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GoalBody {
    /// "Completion condition", or "Proposing a goal…" without one.
    pub condition: Option<String>,
    pub note: &'static str,
}

// ------------------------------------------------------------------- build

/// What a card reads besides its block.
pub(crate) struct Ctx<'a> {
    pub opts: &'a ViewOptions,
    pub state: &'a ChatState,
    /// `taskByToolUseId` (the last task per tool_use id wins, as `Map.set`).
    pub tasks: &'a HashMap<&'a str, &'a TaskInfo>,
    pub disconnected: bool,
    pub expand_all: bool,
    pub pending_ask: Option<&'a str>,
}

/// `taskByToolUseId`.
pub(crate) fn task_index(state: &ChatState) -> HashMap<&str, &TaskInfo> {
    let mut m = HashMap::new();
    for t in state.tasks.values() {
        if let Some(id) = t.tool_use_id.as_deref().filter(|s| !s.is_empty()) {
            m.insert(id, t);
        }
    }
    m
}

/// One `tool_use` block's card, keyed `key`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn card(
    ctx: &Ctx,
    b: &mut RowBuilder,
    key: String,
    id: &str,
    name: &str,
    input: &Value,
    result: Option<&ToolResult>,
    started_at: Option<f64>,
) -> Card {
    let task = ctx.tasks.get(id).copied();
    match CardKind::of(name) {
        CardKind::Task => Card::Task(task_card(ctx, b, key, id, input, result, task)),
        CardKind::Workflow => Card::Workflow(workflow_card(ctx, b, key, id, input, result, task)),
        CardKind::ProposeGoal => Card::Goal(goal_card(ctx, key, input, result)),
        CardKind::Tool => {
            // `isMcpTask`: only an `mcp_task` joins its status and files.
            let mcp = task.filter(|t| t.task_type.as_deref() == Some("mcp_task"));
            let call = Call {
                name,
                input,
                result,
                started_at,
                live_ask: name == "AskUserQuestion" && ctx.pending_ask == Some(id),
                reopen: name == "AskUserQuestion",
                default_open: ctx.expand_all,
                resource_links: mcp.and_then(|t| t.resource_links.as_deref()),
                task_status: mcp.map(|t| t.status.as_str()),
                settled: None,
            };
            Card::Call(call_card(ctx, b, key, &call))
        }
    }
}

fn toggled(opts: &ViewOptions, key: &str) -> bool {
    opts.toggled.contains(key)
}

/// A `<pre>`'s text, folded past the fold size unless clicked open.
pub(crate) fn pre_text(opts: &ViewOptions, b: &mut RowBuilder, key: String, full: &str) -> PreText {
    let fold_key = format!("{key}/more");
    match text::fold_cut(full, opts.fold_bytes) {
        None => PreText {
            text: b.text(key, full),
            key: fold_key,
            fold: PreFold::Whole,
        },
        Some(_) if toggled(opts, &fold_key) => PreText {
            text: b.text(key, full),
            key: fold_key,
            fold: PreFold::Expanded,
        },
        Some(cut) => PreText {
            text: b.text(key, &full[..cut]),
            key: fold_key,
            fold: PreFold::Folded {
                hidden_bytes: full.len() - cut,
            },
        },
    }
}

/// A markdown section, folded as message text is.
fn md_text(opts: &ViewOptions, b: &mut RowBuilder, key: String, full: &str) -> MdText {
    let fold_key = format!("fold:{key}");
    let fold = match text::fold_cut(full, opts.fold_bytes) {
        None => Fold::Whole,
        Some(_) if toggled(opts, &fold_key) => Fold::Expanded,
        Some(cut) => Fold::Folded {
            shown: b.text(format!("{key}/shown"), &text::folded_markdown(full, cut)),
            hidden_bytes: full.len() - cut,
        },
    };
    MdText {
        text: b.text(key.clone(), full),
        key,
        fold,
    }
}

/// `JsonBlock` over `value`, keyed `key` (its fold).
pub(crate) fn json_view(opts: &ViewOptions, key: String, value: &Value) -> JsonView {
    let tokens = tool_text::tokenize_json_value(value);
    // `tokens.reduce((n, t) => n + (t.text.match(/\n/g)?.length ?? 0), 0) + 1`.
    let lines = tokens
        .iter()
        .map(|(t, _)| t.matches('\n').count())
        .sum::<usize>()
        + 1;
    let collapsed = lines > JSON_COLLAPSED_LINES && !toggled(opts, &key);
    if collapsed {
        return JsonView {
            key,
            lines,
            collapsed,
            tokens: None,
            more: PreFold::Whole,
        };
    }
    let total: usize = tokens.iter().map(|(t, _)| t.len()).sum();
    let more_key = format!("{key}/more");
    let (tokens, more) = match fold_tokens(&tokens, total, opts.fold_bytes) {
        Some(cut) if !toggled(opts, &more_key) => {
            let shown: usize = cut.iter().map(|(t, _)| t.len()).sum();
            (
                cut,
                PreFold::Folded {
                    hidden_bytes: total - shown,
                },
            )
        }
        Some(_) => (tokens, PreFold::Expanded),
        None => (tokens, PreFold::Whole),
    };
    JsonView {
        key,
        lines,
        collapsed,
        tokens: Some(tokens.into()),
        more,
    }
}

/// The tokens before the fold of their concatenated text, the token the
/// fold falls in cut short.
fn fold_tokens(
    tokens: &[(String, JsonTokenType)],
    total: usize,
    cap: usize,
) -> Option<Vec<(String, JsonTokenType)>> {
    if total <= cap {
        return None;
    }
    let joined: String = tokens.iter().map(|(t, _)| t.as_str()).collect();
    let cut = text::fold_cut(&joined, cap)?;
    let mut out = Vec::new();
    let mut at = 0;
    for (t, kind) in tokens {
        if at >= cut {
            break;
        }
        let take = (cut - at).min(t.len());
        out.push((t[..take].to_owned(), *kind));
        at += t.len();
    }
    Some(out)
}

/// The inputs of one `ToolCall` (its props).
pub(crate) struct Call<'a> {
    pub name: &'a str,
    pub input: &'a Value,
    pub result: Option<&'a ToolResult>,
    pub started_at: Option<f64>,
    pub live_ask: bool,
    /// `onReopenAsk` is wired (every top-level AskUserQuestion row).
    pub reopen: bool,
    pub default_open: bool,
    pub resource_links: Option<&'a [TaskResourceLink]>,
    pub task_status: Option<&'a str>,
    pub settled: Option<SettledToolReason>,
}

/// `ToolCall`'s render, as data.
pub(crate) fn call_card(ctx: &Ctx, b: &mut RowBuilder, key: String, c: &Call) -> CallCard {
    let opts = ctx.opts;
    let open = c.default_open != toggled(opts, &key);
    let is_error = c.result.is_some_and(|r| r.is_error == Some(true));
    // CC 2.1.323: `rejected` (claudius-client doesn't carry it yet).
    let rejected = false;
    let status = match c.task_status {
        Some("completed") => CallStatus::Ok,
        Some("failed" | "killed") => CallStatus::Error,
        _ => match c.result {
            None => match c.settled {
                Some(reason) => CallStatus::Interrupted(reason),
                None => CallStatus::Running {
                    since: c.started_at.filter(|t| *t != 0.0 && !t.is_nan()),
                    disconnected: ctx.disconnected,
                },
            },
            Some(r) if is_error && r.not_run == Some(true) => CallStatus::NotRun { rejected },
            Some(_) if is_error => CallStatus::Error,
            Some(_) => CallStatus::Ok,
        },
    };
    let staged = !is_error && c.result.is_some_and(|r| r.staged == Some(true));
    let detached = !is_error && c.result.is_some_and(|r| r.detached == Some(true));
    let target = tool_text::path_from_tool_input(c.input);
    let link = opts.file_link.as_ref();
    let rel = match (&target, link) {
        (Some(t), Some(l)) => tool_text::to_workspace_relative(&t.path, &l.cwd),
        _ => None,
    };
    let files = match (&rel, link) {
        (Some(rel), Some(l)) => Some(FilesLink {
            workspace_id: l.workspace_id.clone(),
            rel_path: rel.clone(),
            href: tool_text::files_href(&l.workspace_id, rel),
        }),
        _ => None,
    };
    let preview_type = match (&target, &files) {
        (Some(t), Some(_)) if opts.show_previews && c.result.is_some() && !is_error && !staged => {
            tool_text::get_preview_type(&t.path)
        }
        _ => None,
    };
    let preview = match (preview_type, &target, &files) {
        (Some(kind), Some(t), Some(f)) => {
            let pkey = format!("preview:{key}");
            Some(FilePreviewCard {
                open: (kind == PreviewType::Image) != toggled(opts, &pkey),
                key: pkey,
                kind,
                file_name: t.path.rsplit('/').next().unwrap_or(&t.path).to_owned(),
                rel_path: f.rel_path.clone(),
                workspace_id: f.workspace_id.clone(),
                path: t.path.clone(),
            })
        }
        _ => None,
    };
    // `planText && …`: an empty plan is no plan.
    let plan = (c.name == "ExitPlanMode")
        .then(|| c.input.get("plan").and_then(Value::as_str))
        .flatten()
        .filter(|p| !p.is_empty());
    let feedback = c.name == "SendFeedback";
    let feedback_text = feedback
        .then(|| tool_text::extract_feedback_draft_text(c.input))
        .flatten();
    let schedule_action = matches!(c.name, "Schedule" | "RemoteTrigger")
        .then(|| c.input.get("action").and_then(Value::as_str))
        .flatten()
        .map(schedule_action_label)
        .filter(|a| !a.is_empty());
    let path = target.as_ref().map(|t| {
        let (head, tail) = tool_text::split_path_for_truncation(&t.path);
        PathLabel {
            head: head.to_owned(),
            tail: tail.to_owned(),
            full: t.path.clone(),
            files: files.clone(),
        }
    });
    let body = open.then(|| call_body(ctx, b, &key, c, plan, feedback_text, &target, status));
    CallCard {
        name: c.name.to_owned(),
        open,
        icon: if feedback {
            "MessageSquareHeart"
        } else {
            "Wrench"
        },
        title: if feedback {
            "Feedback draft".into()
        } else {
            c.name.to_owned()
        },
        plan_suffix: plan.is_some(),
        schedule_action,
        path,
        answer: (c.name == "AskUserQuestion" && c.reopen)
            .then_some(AnswerPill { live: c.live_ask }),
        resource_count: c.resource_links.map(<[_]>::len).filter(|n| *n > 0),
        staged,
        detached,
        status,
        preview,
        body,
        key,
    }
}

#[allow(clippy::too_many_arguments)]
fn call_body(
    ctx: &Ctx,
    b: &mut RowBuilder,
    key: &str,
    c: &Call,
    plan: Option<&str>,
    feedback: Option<String>,
    target: &Option<FileTarget>,
    status: CallStatus,
) -> CallBody {
    let opts = ctx.opts;
    let main = if let Some(plan) = plan {
        CallMain::Plan(md_text(opts, b, format!("{key}/plan"), plan))
    } else if let Some(text) = feedback {
        CallMain::Feedback(md_text(opts, b, format!("{key}/feedback"), &text))
    } else {
        let json = claudius_core::js_string::stringify_pretty(c.input);
        CallMain::Input {
            editor: target.as_ref().map(|t| EditorLink {
                path: t.path.clone(),
                line: t.line,
                editor: opts.editor.clone(),
                url: tool_text::build_editor_url(&t.path, t.line, &opts.editor),
            }),
            json: pre_text(opts, b, format!("{key}/input"), &json),
        }
    };
    let not_run = matches!(status, CallStatus::NotRun { .. });
    let result = c.result.map(|r| {
        let rejected = matches!(status, CallStatus::NotRun { rejected: true });
        let is_error = r.is_error == Some(true);
        ResultSection {
            label: if not_run {
                if rejected { "rejected" } else { "not run" }
            } else if is_error {
                "error"
            } else {
                "result"
            },
            tone: if not_run {
                ResultTone::Muted
            } else if is_error {
                ResultTone::Error
            } else {
                ResultTone::Plain
            },
            text: pre_text(opts, b, format!("{key}/result"), &r.content),
        }
    });
    let links = c
        .resource_links
        .unwrap_or_default()
        .iter()
        .map(|l| ResourceLinkRow {
            uri: l.uri.clone(),
            label: l.title.clone().unwrap_or_else(|| l.name.clone()),
            title: l.description.clone().unwrap_or_else(|| l.uri.clone()),
        })
        .collect();
    CallBody {
        main,
        result,
        links,
    }
}

/// `STATUS_CHIP[status] ?? STATUS_CHIP.pending` (`paused` only in the
/// workflow's map).
fn chip_tone(status: &str, workflow: bool) -> ChipTone {
    match status {
        "running" => ChipTone::Sky,
        "completed" => ChipTone::Emerald,
        "failed" | "killed" => ChipTone::Red,
        "stopped" => ChipTone::Amber,
        "paused" if workflow => ChipTone::Amber,
        _ => ChipTone::Pending,
    }
}

/// A JS value as JSX prints it in text (`{x}`): strings and numbers; the
/// rest (booleans, null) print nothing.
fn jsx_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => tool_text::js_number(n.as_f64().unwrap_or(f64::NAN)),
        _ => String::new(),
    }
}

/// `TaskBlock`'s render, as data.
fn task_card(
    ctx: &Ctx,
    b: &mut RowBuilder,
    key: String,
    id: &str,
    input: &Value,
    result: Option<&ToolResult>,
    task: Option<&TaskInfo>,
) -> TaskCard {
    let opts = ctx.opts;
    let open = ctx.expand_all != toggled(opts, &key);
    let get = |k: &str| input.get(k).filter(|v| !v.is_null());
    // `subagent_type ?? agent ?? "Task"`.
    let agent_v = get("subagent_type").or_else(|| get("agent"));
    let agent = agent_v.map_or_else(|| "Task".to_owned(), jsx_text);
    let intent = get("description").map(jsx_text).unwrap_or_default();
    let live = task.map(|t| t.description.clone()).unwrap_or_default();
    let title = if intent.is_empty() { &live } else { &intent };
    let activity = (!intent.is_empty() && !live.is_empty() && live != intent).then(|| live.clone());
    let status = match task {
        Some(t) => t.status.clone(),
        None => match result {
            Some(r) if r.is_error == Some(true) => "failed".into(),
            Some(_) => "completed".into(),
            None => "running".into(),
        },
    };
    let retrying = tool_text::find_subagent_retry(id, &status, &ctx.state.tool_progress).map(|r| {
        let n = |x: Option<f64>| x.map_or("undefined".to_owned(), tool_text::js_number);
        let (a, m) = (n(r.attempt), n(r.max_retries));
        (
            format!("retrying {a}/{m}"),
            format!("Waiting out an API rate-limit retry (attempt {a}/{m})"),
        )
    });
    let disconnected = ctx.disconnected && status == "running";
    let settled = settled_tool_reason(task.map(|t| t.status.as_str()));
    let mut stats = Vec::new();
    if let Some(m) = task
        .and_then(|t| t.model.as_deref())
        .filter(|m| !m.is_empty())
    {
        stats.push(tool_text::pretty_model_name(Some(m)));
    }
    if let Some(Value::String(effort)) = input.get("effort")
        && !effort.is_empty()
        && agent != "fork"
    {
        stats.push(format!("{effort} effort"));
    }
    if let Some(t) = task {
        if let Some(n) = t.total_tokens {
            stats.push(format!("{} tok", text::locale_number(n)));
        }
        if let Some(n) = t.tool_uses.filter(|n| *n > 0.0) {
            stats.push(format!("{} tools", tool_text::js_number(n)));
        }
        if let Some(ms) = t.duration_ms {
            stats.push(format_duration(ms));
        }
    }
    let chip = Chip {
        tone: chip_tone(&status, false),
        mark: match status.as_str() {
            "running" if !disconnected => ChipMark::Pulse { dim: false },
            "completed" => ChipMark::Check,
            "failed" | "killed" => ChipMark::Alert,
            _ => ChipMark::None,
        },
        label: capitalize(&status),
        dim: disconnected,
    };
    let body = open.then(|| {
        let prompt = get("prompt").map(jsx_text).filter(|p| !p.is_empty());
        let prompt = prompt.map(|p| {
            let k = format!("{key}/prompt");
            Details {
                body: toggled(opts, &k)
                    .then(|| pre_text(opts, b, format!("{key}/prompt-text"), &p)),
                key: k,
                summary: "Spawn prompt",
            }
        });
        let inner_msgs = ctx
            .state
            .subagent_messages
            .get(id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let inner: Vec<SubMessage> = inner_msgs
            .iter()
            .map(|m| sub_message(ctx, b, &key, m, settled))
            .collect();
        let empty_note = inner.is_empty().then_some(if disconnected {
            "Disconnected — reconnecting…"
        } else if status == "running" {
            "Subagent working…"
        } else {
            "No subagent messages captured."
        });
        let returned = result.map(|r| {
            let k = format!("{key}/returned");
            let body = toggled(opts, &k).then(|| {
                let HandBack { text, provenance } = tool_text::parse_subagent_hand_back(&r.content);
                Returned {
                    text: pre_text(opts, b, format!("{key}/returned-text"), &text),
                    error: r.is_error == Some(true),
                    provenance,
                }
            });
            Details {
                key: k,
                summary: "Returned to parent",
                body,
            }
        });
        TaskBody {
            prompt,
            error: task.and_then(|t| t.error.clone()).filter(|e| !e.is_empty()),
            empty_note,
            inner,
            returned,
        }
    });
    TaskCard {
        tool_use_id: id.to_owned(),
        open,
        agent,
        title: (!title.is_empty()).then(|| title.clone()),
        activity,
        retrying: retrying.filter(|_| !disconnected),
        disconnected,
        status,
        chip,
        stats: (!stats.is_empty()).then(|| stats.join(" · ")),
        body,
        key,
    }
}

/// The thinking card's label and body (`ThinkingBlock`).
pub(crate) fn thinking_parts(
    text: &str,
    redacted: bool,
    streaming: bool,
    body: impl FnOnce() -> Arc<str>,
) -> (&'static str, ThinkingBody) {
    let has_body = !text::js_trim(text).is_empty();
    let label = if redacted {
        "Thinking (encrypted)"
    } else if !has_body && !streaming {
        "Thinking (no trace)"
    } else {
        "Thinking"
    };
    let body = if redacted {
        ThinkingBody::Note(
            "Reasoning was redacted by the model and is not available to the client. The agent still uses it internally.",
        )
    } else if has_body {
        ThinkingBody::Text(body())
    } else if streaming {
        ThinkingBody::Note("Streaming the reasoning…")
    } else {
        ThinkingBody::Note("No readable trace for this turn.")
    };
    (label, body)
}

/// `SubMessage`'s render, as data.
fn sub_message(
    ctx: &Ctx,
    b: &mut RowBuilder,
    task_key: &str,
    m: &DisplayMessage,
    settled: Option<SettledToolReason>,
) -> SubMessage {
    if m.role == Role::User {
        let text: String = m.blocks.iter().filter_map(DisplayBlock::as_text).collect();
        return SubMessage::User {
            uuid: m.uuid.clone(),
            text: b.text(format!("{task_key}/inner:{}", m.uuid), &text),
        };
    }
    let blocks = m
        .blocks
        .iter()
        .enumerate()
        .map(|(i, block)| {
            let k = format!("{task_key}/inner:{}:{i}", m.uuid);
            match block {
                DisplayBlock::Text { text } => SubBlock::Text(md_text(ctx.opts, b, k, text)),
                DisplayBlock::Thinking { text, redacted } => {
                    let (label, body) =
                        thinking_parts(text, *redacted == Some(true), false, || {
                            b.text(format!("{k}/thinking"), text)
                        });
                    SubBlock::Thinking {
                        open: toggled(ctx.opts, &k),
                        key: k,
                        label,
                        body,
                    }
                }
                DisplayBlock::ToolUse {
                    name,
                    input,
                    result,
                    started_at,
                    ..
                } => {
                    let call = Call {
                        name,
                        input,
                        result: result.as_ref(),
                        started_at: *started_at,
                        live_ask: false,
                        reopen: false,
                        default_open: false,
                        resource_links: None,
                        task_status: None,
                        settled,
                    };
                    SubBlock::Tool(Box::new(call_card(ctx, b, k, &call)))
                }
            }
        })
        .collect();
    SubMessage::Assistant {
        uuid: m.uuid.clone(),
        blocks,
    }
}

/// Whether `key` opens without a click outside ultra-verbose: no result
/// yet, or first seen running (`useState(defaultOpen ?? !result)` runs at
/// mount).
fn live_default(opts: &ViewOptions, key: &str, result: Option<&ToolResult>) -> bool {
    result.is_none() || opts.opened_live.contains(key)
}

/// `WorkflowBlock`'s render, as data.
#[allow(clippy::too_many_arguments)]
fn workflow_card(
    ctx: &Ctx,
    b: &mut RowBuilder,
    key: String,
    id: &str,
    input: &Value,
    result: Option<&ToolResult>,
    task: Option<&TaskInfo>,
) -> WorkflowCard {
    let opts = ctx.opts;
    let live = live_default(opts, &key, result);
    let open = (ctx.expand_all || live) != toggled(opts, &key);
    let script = str_value(input.get("script"));
    let partial = str_value(input.get("__partial"));
    let source = script
        .clone()
        .or_else(|| partial.clone())
        .map(Value::String);
    let meta = claudius_client::workflow_meta::parse_workflow_meta(source.as_ref());
    let name = meta
        .name
        .clone()
        .or_else(|| str_value(input.get("name")))
        .unwrap_or_else(|| "Workflow".into());
    let streaming = script.is_none() && partial.is_some() && result.is_none();
    let status = match task {
        Some(t) => t.status.clone(),
        None if streaming => "pending".into(),
        None => match result {
            Some(r) if r.is_error == Some(true) => "failed".into(),
            Some(_) => "completed".into(),
            None => "running".into(),
        },
    };
    let terminal = matches!(
        status.as_str(),
        "completed" | "failed" | "killed" | "stopped"
    );
    let mut stats = Vec::new();
    if let Some(t) = task {
        if let Some(n) = t.total_tokens {
            stats.push(format!("{} tok", text::locale_number(n)));
        }
        if let Some(n) = t.tool_uses.filter(|n| *n > 0.0) {
            stats.push(format!("{} tools", tool_text::js_number(n)));
        }
        if let Some(ms) = t.duration_ms {
            stats.push(format_duration(ms));
        }
    }
    let n = meta.phases.len();
    let chip = Chip {
        tone: chip_tone(&status, true),
        mark: match status.as_str() {
            "running" => ChipMark::Pulse {
                dim: ctx.disconnected,
            },
            "completed" => ChipMark::Check,
            "failed" | "killed" => ChipMark::Alert,
            "paused" => ChipMark::Dot,
            _ => ChipMark::None,
        },
        label: capitalize(if streaming { "preparing" } else { &status }),
        dim: false,
    };
    let body = open.then(|| {
        let data = safe_json_object(result.map(|r| r.content.as_str()));
        let field = |k: &str| str_value(data.as_ref().and_then(|d| d.get(k)));
        // `str(resultData?.summary) ?? task?.summary`: the task's may be "".
        let summary = field("summary").or_else(|| task.and_then(|t| t.summary.clone()));
        let error = field("error")
            .or_else(|| task.and_then(|t| t.error.clone()))
            .or_else(|| {
                result
                    .filter(|r| r.is_error == Some(true))
                    .map(|r| r.content.clone())
            })
            .filter(|e| !e.is_empty());
        let description = meta
            .description
            .clone()
            .or_else(|| task.map(|t| t.description.clone()))
            .filter(|d| !d.is_empty());
        let live_summary = (status == "running")
            .then(|| task.and_then(|t| t.summary.clone()))
            .flatten()
            .filter(|s| !s.is_empty())
            .map(|s| (s, !ctx.disconnected));
        let args = input
            .get("args")
            .filter(|a| a.is_object() || a.is_array())
            .map(|a| {
                let k = format!("{key}/args");
                Details {
                    body: toggled(opts, &k).then(|| json_view(opts, format!("{k}/json"), a)),
                    key: k,
                    summary: "Args",
                }
            });
        let raw = data.as_ref().filter(|_| terminal).map(|d| {
            let k = format!("{key}/raw");
            Details {
                body: toggled(opts, &k).then(|| json_view(opts, format!("{k}/json"), d)),
                key: k,
                summary: "Raw output",
            }
        });
        let script_details = script.as_ref().map(|s| {
            let k = format!("{key}/script");
            Details {
                body: toggled(opts, &k).then(|| pre_text(opts, b, format!("{k}/text"), s)),
                key: k,
                summary: "Show script",
            }
        });
        WorkflowBody {
            preparing: streaming && description.is_none(),
            description,
            live_summary,
            phases: meta
                .phases
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    (
                        i + 1,
                        p.title.clone(),
                        p.detail.clone().filter(|d| !d.is_empty()),
                    )
                })
                .collect(),
            result: summary.filter(|s| !s.is_empty() && error.is_none() && terminal),
            error,
            run_id: field("runId"),
            transcript_dir: field("transcriptDir"),
            args,
            raw,
            script: script_details,
        }
    });
    WorkflowCard {
        tool_use_id: id.to_owned(),
        open,
        live_default: live,
        name,
        phases_label: (n > 0).then(|| format!("{n} {}", if n == 1 { "phase" } else { "phases" })),
        size: (!terminal).then(|| format!("size: {}", opts.workflow_size)),
        status,
        chip,
        stats: (!stats.is_empty()).then(|| stats.join(" · ")),
        body,
        key,
    }
}

/// `ProposeGoalBlock`'s render, as data.
fn goal_card(ctx: &Ctx, key: String, input: &Value, result: Option<&ToolResult>) -> GoalCard {
    let opts = ctx.opts;
    let live = live_default(opts, &key, result);
    let open = (ctx.expand_all || live) != toggled(opts, &key);
    let output = safe_json_object(result.map(|r| r.content.as_str()));
    let condition = str_value(output.as_ref().and_then(|o| o.get("condition")))
        .or_else(|| str_value(input.get("condition")));
    let ask_user = output
        .as_ref()
        .and_then(|o| o.get("askUser"))
        .and_then(Value::as_bool)
        .or_else(|| input.get("ask_user").and_then(Value::as_bool))
        .unwrap_or(true);
    let errored = result.is_some_and(|r| r.is_error == Some(true));
    let state = if errored {
        GoalState::Error
    } else if result.is_none() {
        GoalState::Proposing
    } else if ask_user {
        GoalState::AwaitingApproval
    } else {
        GoalState::GoalSet
    };
    let body = open.then(|| GoalBody {
        condition: condition.clone(),
        note: if errored {
            "The proposal was rejected or failed."
        } else if result.is_none() {
            if ask_user {
                "Awaiting your approval before this goal is set."
            } else {
                "Setting this goal directly (you can clear it with /goal clear)."
            }
        } else if ask_user {
            "Sent for your approval — set it from the goal prompt above the composer."
        } else {
            "Set directly from your earlier request — clear it any time with /goal clear."
        },
    });
    GoalCard {
        key,
        open,
        live_default: live,
        condition,
        state,
        body,
    }
}

#[cfg(test)]
mod tests;
