//! One live agent session — port of the `Session` class in
//! `lib/server/session.ts`.
//!
//! Shape: all mutable state lives in one `std::sync::Mutex<State>` that is
//! never held across an `.await`. `broadcast` runs under that lock and fans
//! out over unbounded channels, so `subscribe()` (replay + register) is
//! atomic with respect to new events — the same guarantee the TS code gets
//! for free from the single-threaded event loop.
//!
//! Ported: replay buffer + window, `subscribe` ordering, `sendInput`
//! (text / images / slash, reminder prefixes), `canUseTool` →
//! permission / AskUserQuestion / ExitPlanMode prompts, elicitations,
//! interrupt, permission mode, model, turn status + subagent task tracking,
//! usage accounting, goal tool, server-side queue, transcript replay on
//! resume. See `rust/PORT_PLAN.md` for what is still TS-only.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};

use async_trait::async_trait;
use claudius_agent::{
    CanUseTool, ElicitationRequest, HookMatcher, McpServerConfig, OnElicitation, Options,
    PermissionResult, Query, QueryHandle, SystemPrompt, ThinkingConfig, ToolDef, ToolOutput,
    ToolPermissionContext, ToolServer, hook_fn, js,
};
use indexmap::IndexMap;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::effort;
use crate::events::{
    self, REPLAY_SKIP_TYPES, allow_rule_suggestions, build_session_snapshot, ev_type,
    select_replay_window, should_buffer_event,
};
use crate::jsonl_watch::{self, Fired, JsonlWatch};
use crate::prompt_events;
use crate::queue_db::{self, ImageInput, NewQueued, QueuedRow};
use crate::session_recap;
use crate::session_tasks_db::{self, TaskEntry};
use crate::session_titles::{self, FreshTitle};
use crate::sessions_db::{self, SdkCumulative, SessionGoal, UsageTotals};
use crate::settings::{self, Scope};
use crate::todos;
use crate::user_prompt::extract_user_prompt_text;
use crate::{log, now_ms, paths, sessions_store, transcript};

/// The create route's untyped option reads (S27d).
pub mod create_options;
/// `sendInput`'s reads of the raw input: slash parts, image blocks (S29).
mod input;
/// The live-`system/init` hooks behind [`Session::broadcast`] (S28a).
mod live_init;

pub const BUFFER_CAP: usize = 1000;
/// `recentDenials` keeps the last 20 permission denials (`/permissions` → Recent Denials).
pub const RECENT_DENIALS_CAP: usize = 20;
pub const TODO_TASK_TOOL_NAMES: [&str; 5] = [
    "TodoWrite",
    "TaskCreate",
    "TaskGet",
    "TaskUpdate",
    "TaskList",
];
pub const RESTRICTED_MODE_DISALLOWED_TOOLS: [&str; 5] =
    ["Bash", "BashOutput", "Monitor", "TaskStop", "WebFetch"];

/// `new Session(opts)` — deserializes straight from a `CreateSessionRequest`
/// body (camelCase), plus Rust-only runtime knobs.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionOptions {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub agent: Option<String>,
    pub max_budget_usd: Option<f64>,
    pub task_budget_tokens: Option<f64>,
    pub max_turns: Option<f64>,
    pub fallback_model: Option<String>,
    pub sandbox_enabled: Option<bool>,
    pub sandbox_filesystem_disabled: Option<bool>,
    /// Forwarded to the CLI's settings as it came, so a string stays a
    /// string ([`create_options`]).
    pub sandbox_network_allowed_domains: Option<Value>,
    pub sandbox_network_strict_allowlist: Option<bool>,
    #[serde(rename = "enable1mContext")]
    pub enable_1m_context: Option<bool>,
    pub persist_session: Option<bool>,
    pub additional_directories: Option<Vec<String>>,
    pub system_prompt_append: Option<String>,
    pub plan_mode_instructions: Option<String>,
    pub permission_mode: Option<String>,
    pub restricted_mode: Option<bool>,
    pub resume: Option<String>,
    pub resume_session_at: Option<String>,
    /// What the create route's untyped body held where a typed option
    /// couldn't ([`create_options::OddTypes`]).
    #[serde(skip)]
    pub odd: create_options::OddTypes,
    #[serde(skip)]
    pub runtime: RuntimeOptions,
}

#[derive(Clone, Debug, Default)]
pub struct RuntimeOptions {
    /// Explicit `claude` binary (else `claudius_agent::binary::locate`).
    pub claude_bin: Option<PathBuf>,
    /// Replaces the inherited process env for the CLI (account profiles).
    pub env_override: Option<HashMap<String, String>>,
}

/// `PermissionDecision` from the permission route.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    AllowAlwaysSession,
    AllowAlwaysSave { destination: String },
    Deny { message: Option<String> },
}

/// `PlanDecision`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanDecision {
    Accept {
        #[serde(default, rename = "editedPlan")]
        edited_plan: Option<String>,
    },
    Reject {
        #[serde(default)]
        message: Option<String>,
    },
}

#[derive(Clone, Debug, Default)]
pub struct SendOptions {
    /// `opts.uuid`: any JS value (the `input` route forwards the posted one).
    pub uuid: Option<Value>,
    pub slash: bool,
    pub priority_now: bool,
    pub inline_pastes: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnStatus {
    Running,
    Idle,
    NeedsInput,
}

impl TurnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TurnStatus::Running => "running",
            TurnStatus::Idle => "idle",
            TurnStatus::NeedsInput => "needs_input",
        }
    }
}

struct PendingPermission {
    tx: oneshot::Sender<PermissionResult>,
    meta: Value,
    input: Value,
    tool_name: String,
    suggestions: Option<Value>,
}
struct PendingAsk {
    tx: oneshot::Sender<PermissionResult>,
    tool_use_id: Option<Value>,
    questions: Vec<Value>,
}
struct PendingPlan {
    tx: oneshot::Sender<PermissionResult>,
    tool_use_id: Option<Value>,
    plan: String,
    raw: Value,
}
struct PendingElicitation {
    tx: oneshot::Sender<Value>,
    meta: Value,
}

/// `MAX_INNER_MESSAGES`: a subagent's conversation is capped per task (the
/// oldest dropped) so a marathon run can't bloat its row.
const MAX_INNER_MESSAGES: usize = 500;

/// `TASK_PERSIST_THROTTLE_MS`: the hot-path (inner message, progress) write
/// cadence per task; state transitions always write.
const TASK_PERSIST_THROTTLE_MS: i64 = 2_000;

/// `meta.status === "running" || meta.status === "pending"`.
fn task_is_live(m: &TaskEntry) -> bool {
    m.status == "running" || m.status == "pending"
}

struct Sub {
    id: u64,
    tx: mpsc::UnboundedSender<Value>,
}

#[derive(Default)]
struct State {
    buffer: Vec<Value>,
    buffer_trimmed: bool,
    subs: Vec<Sub>,
    next_sub_id: u64,
    holder_id: Option<String>,

    has_query: bool,
    done: bool,
    is_replaying: bool,
    /// CC 2.1.301 — the resumed transcript's JSONL, as found on disk by
    /// [`crate::resumed_transcript::find_resumed_transcript_path`] during
    /// `start()`. `None` for fresh sessions and when no candidate exists.
    resumed_transcript_file: Option<String>,
    turn_in_flight: bool,
    last_status: Option<(TurnStatus, usize)>,

    title: Option<String>,
    /// CC 2.1.309 — a title set through `rename()` whose SDK `renameSession`
    /// failed (no transcript yet) and that the engine didn't take either.
    /// Re-sent at the next turn boundary so the CLI, `--resume` and other
    /// sessions see the user's name instead of a generated one
    /// (`flushPendingTitleMirror`).
    pending_title_mirror: Option<String>,
    model: Option<String>,
    sdk_model: Option<String>,
    permission_mode: String,
    /// `appliedEffort`: the effort the next request will send, as the CLI's
    /// `get_settings` last reported it. `None` = not read yet (`undefined`),
    /// `Some(null)` = no effort parameter.
    applied_effort: Option<Value>,
    /// `appliedEffortSeq`: bumped per refresh so an older, slower
    /// `get_settings` reply can't overwrite a newer one.
    applied_effort_seq: u64,
    /// `agent`: the main-thread agent (SDK `Options.agent`). Starts as the
    /// create option; `set_agent` flips it mid-session.
    agent: Option<String>,
    /// Effective advisor (`advisorModel`) — `system:init` doesn't carry it,
    /// so it's cached from settings at start and tracked through
    /// `set_advisor_model`.
    advisor_model: Option<String>,
    last_cwd_broadcast: Option<String>,
    tips: Value,
    queue_dispatch_asap: bool,

    pending_permissions: IndexMap<String, PendingPermission>,
    pending_asks: IndexMap<String, PendingAsk>,
    pending_plans: IndexMap<String, PendingPlan>,
    pending_elicitations: IndexMap<String, PendingElicitation>,

    latest_user_prompt: Option<Value>,
    latest_user_prompt_at: f64,
    latest_init: Option<Value>,
    /// `pluginLoadErrors`: the newest `system/init`'s `plugin_errors`.
    plugin_load_errors: Vec<Value>,
    latest_todos: Option<Vec<Value>>,
    /// `latestTodosSnapshotAt`: the newest list write's time. Older
    /// writes (a pre-clear replay) bounce off it.
    latest_todos_at: f64,
    /// TaskCreate `tool_use_id`s awaiting their result.
    pending_task_creates: HashSet<String>,
    /// `lastRecapAt`: when the last recap started (the multi-tab dedupe).
    last_recap_at: Option<i64>,
    /// `recapAbort`: cancels the in-flight recap (a new turn, a newer recap).
    recap_abort: Option<CancellationToken>,
    /// `sawUserInput`: a prompt went through `send_input` in this process.
    /// Gates the feedback nudge.
    saw_user_input: bool,
    /// The feedback nudge's throttle and roll; `None` is the process-wide
    /// [`FeedbackSurvey::global`](crate::feedback_survey::FeedbackSurvey::global).
    feedback_survey: Option<Arc<crate::feedback_survey::FeedbackSurvey>>,
    /// TaskList `tool_use_id`s awaiting their result.
    pending_task_lists: HashSet<String>,
    /// A live TaskList result rebuilt the list this turn.
    todos_rebuilt_from_task_list_this_turn: bool,
    /// Non-todo tool uses since the model last touched the list.
    tool_uses_since_todo_touch: u32,
    fired_mid_turn_todo_reminder_this_turn: bool,
    /// User turns since the last TodoWrite (the stale-TodoWrite nudge).
    turns_since_todo_write: u32,
    /// Turns that ended with open items and no progress (more done, or a
    /// shorter list) against the previous turn end's counts below.
    turns_todos_no_progress: u32,
    last_todos_done_count: usize,
    last_todos_total_count: usize,
    /// The list is flagged stale (`session_snapshot.todosStale`).
    todos_stale: bool,
    /// `manualTodoOverrides`: the user's per-item edits (`completed` /
    /// `pending` / `in_progress` / `deleted`) by todo id, until the model
    /// touches that id. In insertion order; persisted in JS key order.
    manual_todo_overrides: IndexMap<String, &'static str>,
    /// `(cwd, id)` for the database writes made under the lock (overrides,
    /// task rows); `None` (no persistence) in unit tests.
    state_key: Option<(String, String)>,
    /// `taskMetaById`: subagent / background tasks by SDK task id.
    task_meta: IndexMap<String, TaskEntry>,
    /// `subagentMsgsByToolUseId`: `{at?, message}` envelopes of each
    /// subagent's conversation, by parent Task `tool_use_id`.
    subagent_msgs: HashMap<String, Vec<Value>>,
    /// `taskPersistThrottleAt`: last write per task id (ms).
    task_persist_throttle_at: HashMap<String, i64>,
    /// The throttle's clock (`Date.now`); `None` = the wall clock. Tests
    /// pin it.
    task_clock: Option<fn() -> i64>,
    recent_denials: Vec<Value>,

    goal: SessionGoal,
    goal_announced: bool,
    /// The session's all-time usage totals (`usageTotals`).
    usage_totals: UsageTotals,
    /// The SDK's cumulative counters as last seen for this CLI process,
    /// seeded with the checkpoint it restores (`sdkLastCumulative`).
    sdk_last_cumulative: SdkCumulative,

    queue: Vec<QueuedRow>,
    queue_loaded: bool,
    /// `sdkQueuedTurns`: a JS number (`Math.floor` of what the CLI sent).
    sdk_queued_turns: f64,

    reminders: crate::reminders::ReminderQueue,
    /// `pending-bash-output`: `!` results the next prompt carries.
    bash_blocks: Vec<String>,
    /// `scheduledLoops` and its pending maps (`trackScheduledLoops`).
    loops: crate::session_loops::LoopTracker,
    /// `recentReadPaths`: every file the model has Read this session, in
    /// first-read order. Never pruned; re-seeded after each compaction.
    recent_read_paths: indexmap::IndexSet<String>,
    mid_turn_reminders: crate::reminders::ReminderQueue,
    /// `postWriteSnapshots`: post-Edit/Write hashes for the
    /// linter-modified-file reminder.
    post_write_snapshots: crate::reminders::PostWriteSnapshots,
    last_seen_local_date: Option<String>,
    plan_awaiting_verify: bool,
    tool_budget_used: [u64; 2],
    /// `thinkingReplayRecoveryScheduled`: one auto-recovery per query
    /// lifetime, however often the 400 is surfaced.
    thinking_replay_recovery_scheduled: bool,
    /// The overload / long-context / auth / token-expiry nudges.
    nudges: crate::detectors::Nudges,
    /// `activeProfileExpiresAt`: the token expiry of the profile the session
    /// runs under (set at start, [`crate::account_pinning`]).
    active_profile_expires_at: Option<f64>,
    /// `accountProfileId` / `accountProfileLabel` / `accountDriftFromActive`
    /// (pinned at start; [`Session::refresh_account_drift`]).
    account_pin: crate::account_drift::AccountPin,
    /// `envOverride`: the CLI's environment under that profile, frozen at
    /// start (the recap runs under it too); `None` without a profile.
    account_env: Option<HashMap<String, String>>,
    /// `accountAutoRotated`: this session already rotated the active profile
    /// on a rate-limit wall.
    account_auto_rotated: bool,
    /// What `start()` threw (the JS error's `name` and `message`), for
    /// `SessionManager::create` to fail with ([`Session::take_start_error`]).
    start_error: Option<(&'static str, String)>,
    /// The session's notification-bus calls, queued in order
    /// ([`crate::session_notify`]); a bare state has none.
    bus: crate::session_notify::BusFeed,
    /// `diedOnItsOwn`: set by [`Session::end`] when the CLI had already gone
    /// on its own, so [`Session::is_dead`] stays true past the abort
    /// (CC 2.1.311).
    died_on_its_own: bool,
    /// `sawLiveInit`: this instance's CLI sent a live (not replayed)
    /// `system/init`, i.e. it came up ([`Session::came_up_live`]).
    saw_live_init: bool,
}

impl State {
    /// `this.agent ? { agent } : {}`: an empty name counts as none.
    fn truthy_agent(&self) -> Option<&str> {
        self.agent.as_deref().filter(|a| !a.is_empty())
    }

    /// `resumedTranscriptPath()`: the file `start()` found on disk, with the
    /// home shortened to `~`, for display only.
    fn resumed_transcript_path(&self) -> Option<String> {
        self.resumed_transcript_file
            .as_deref()
            .map(crate::resumed_transcript::display_path)
    }

    fn status(&self) -> TurnStatus {
        if !self.pending_permissions.is_empty()
            || !self.pending_asks.is_empty()
            || !self.pending_plans.is_empty()
            || !self.pending_elicitations.is_empty()
        {
            return TurnStatus::NeedsInput;
        }
        if self.turn_in_flight {
            return TurnStatus::Running;
        }
        let active_fg = self
            .task_meta
            .values()
            .any(|m| m.is_backgrounded != Some(true) && m.ambient != Some(true) && task_is_live(m));
        if active_fg {
            TurnStatus::Running
        } else {
            TurnStatus::Idle
        }
    }

    /// `hasActiveSubagents() || countActiveBackgroundTasks() > 0`.
    fn has_active_background_work(&self) -> bool {
        self.task_meta
            .values()
            .any(|m| m.ambient != Some(true) && task_is_live(m))
    }

    fn background_tasks(&self) -> usize {
        self.task_meta
            .values()
            .filter(|m| {
                m.is_backgrounded == Some(true) && m.ambient != Some(true) && task_is_live(m)
            })
            .count()
    }

    fn has_pending_user_prompts(&self) -> bool {
        self.status() == TurnStatus::NeedsInput
    }

    fn broadcast_turn_status_if_changed(&mut self) {
        let next = (self.status(), self.background_tasks());
        if self.last_status == Some(next) {
            return;
        }
        self.last_status = Some(next);
        self.broadcast(
            json!({"type": "turn_status", "status": next.0.as_str(), "backgroundTasks": next.1}),
        );
    }

    fn prompt_settled(&mut self, kind: &str, request_id: &str) {
        self.broadcast(json!({"type": "prompt_settled", "kind": kind, "requestId": request_id}));
    }

    fn usage_totals(&self) -> UsageTotals {
        self.usage_totals.clone()
    }

    fn queue_event(&self, session_id: &str) -> Value {
        json!({
            "type": "queue:updated",
            "sessionId": session_id,
            "queue": self.queue.iter().map(QueuedRow::meta).collect::<Vec<_>>(),
            "sdkQueuedTurns": crate::js_num(self.sdk_queued_turns),
        })
    }

    fn fan_out(&mut self, ev: &Value) {
        self.subs.retain(|s| s.tx.send(ev.clone()).is_ok());
    }

    /// The `recentDenials` ring (newest last, capped at 20).
    fn push_denial(&mut self, denial: Value) {
        self.recent_denials.push(denial);
        if self.recent_denials.len() > RECENT_DENIALS_CAP {
            let n = self.recent_denials.len() - RECENT_DENIALS_CAP;
            self.recent_denials.drain(..n);
        }
    }

    /// `broadcast()` — stamp, buffer, capture derived state, fan out.
    fn broadcast(&mut self, mut ev: Value) {
        if ev_type(&ev) == "sdk" && ev.get("at").is_none_or(Value::is_null) {
            ev["at"] = json!(now_ms());
        }
        if should_buffer_event(&ev) {
            self.buffer.push(ev.clone());
            if self.buffer.len() > BUFFER_CAP {
                self.buffer_trimmed = true;
                let drop_n = self.buffer.len() - BUFFER_CAP;
                self.buffer.drain(..drop_n);
            }
        }
        self.capture_snapshot_state(&ev);
        self.capture_task_state(&ev);
        if ev_type(&ev) == "sdk"
            && let Some(m) = ev.get("message")
            && m.get("type").and_then(Value::as_str) == Some("system")
        {
            let sub = m.get("subtype").and_then(Value::as_str).unwrap_or("");
            if sub == "init" {
                if let Some(model) = m
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    self.sdk_model = Some(model.to_owned());
                }
                self.latest_init = Some(events::init_snapshot(m));
                self.plugin_load_errors =
                    crate::plugins::plugin_error_array(m.get("plugin_errors"));
            }
            if sub == "commands_changed"
                && let Some(init) = self.latest_init.as_mut()
            {
                let names = events::command_names_from_changed(m.get("commands"));
                if !names.is_empty() {
                    init["slashCommands"] = Value::Array(names);
                }
            }
            // The token-expiry nudge goes out from inside this broadcast, as
            // in TS: buffered after the init, but fanned out before it.
            if sub == "init"
                && !self.is_replaying
                && let Some(nudge) = self
                    .nudges
                    .note_token_expiring_at_startup(self.active_profile_expires_at, now_ms() as f64)
            {
                self.broadcast(nudge);
            }
            if sub == "permission_denied" {
                // `??` keeps any non-null value as sent; a non-number `at` is now.
                let field = |k: &str| m.get(k).filter(|v| !v.is_null()).cloned();
                let tool = field("tool_name").unwrap_or_else(|| json!("(unknown)"));
                let reason = field("decision_reason_type")
                    .or_else(|| field("decision_reason"))
                    .unwrap_or_else(|| json!("unknown"));
                let at = ev.get("at").filter(|a| a.is_number()).cloned();
                let at = at.unwrap_or_else(|| json!(now_ms()));
                self.push_denial(json!({"toolName": tool, "reasonType": reason, "at": at}));
            }
        }
        self.fan_out(&ev);
        // `notificationBus.recordSessionEvent`, once the subscribers have it.
        let bg = || self.has_active_background_work();
        self.bus
            .record(&ev, self.subs.len(), self.title.as_deref(), bg);
    }

    /// `captureSnapshotState`: derived state a late subscriber needs even
    /// when the replay window has sliced off the event that set it — the
    /// latest user prompt and the to-do list (TodoWrite / TaskCreate /
    /// TaskUpdate / TaskList, with the `latest_todos_at` cutoff) — plus the
    /// mid-turn to-do reminder and the worktree heuristic on replayed edits.
    fn capture_snapshot_state(&mut self, ev: &Value) {
        if ev_type(ev) != "sdk" {
            return;
        }
        let Some(m) = ev.get("message") else { return };
        if m.get("parent_tool_use_id").is_some_and(js::truthy) {
            return;
        }
        // The envelope's `at` (disk replay pre-sets it from the JSONL
        // `timestamp`), else now.
        let at = ev
            .get("at")
            .and_then(Value::as_f64)
            .filter(|f| f.is_finite())
            .unwrap_or(now_ms() as f64);
        let content = m.get("message").and_then(|x| x.get("content"));
        match m.get("type").and_then(Value::as_str) {
            Some("user") => {
                // `text && m.uuid`: any truthy uuid, kept as sent.
                if let (Some(text), Some(uuid)) = (
                    extract_user_prompt_text(content),
                    m.get("uuid").filter(|u| js::truthy(u)),
                ) {
                    let prev = if self.latest_user_prompt.is_some() {
                        self.latest_user_prompt_at
                    } else {
                        f64::NEG_INFINITY
                    };
                    if at >= prev {
                        self.latest_user_prompt =
                            Some(json!({"uuid": uuid, "text": text, "at": crate::js_num(at)}));
                        self.latest_user_prompt_at = at;
                    }
                }
                for raw in content.and_then(Value::as_array).into_iter().flatten() {
                    self.capture_tool_result(raw, at);
                }
            }
            Some("assistant") => {
                for block in content.and_then(Value::as_array).into_iter().flatten() {
                    self.capture_tool_use(block, at);
                }
            }
            _ => {}
        }
    }

    /// A top-level `tool_result`: a TaskList result rebuilds the list from
    /// the SDK's own store; a TaskCreate result swaps the temp
    /// `tool_use_id` for the real task id.
    fn capture_tool_result(&mut self, raw: &Value, at: f64) {
        if raw.get("type").and_then(Value::as_str) != Some("tool_result") {
            return;
        }
        // Only string ids are ever registered, so any other truthy id misses.
        let Some(tool_use_id) = raw
            .get("tool_use_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return;
        };
        let is_error = raw.get("is_error").is_some_and(js::truthy);
        if self.pending_task_lists.remove(tool_use_id) {
            if is_error {
                return;
            }
            let Some(parsed) = todos::parse_task_list_result(Some(&tool_result_text(raw))) else {
                return; // unknown shape: leave the list alone
            };
            // A pre-clear TaskList replayed from disk must not resurrect a
            // cleared list; a live one (now) beats any disk cutoff.
            if at < self.latest_todos_at {
                return;
            }
            self.latest_todos = Some(parsed);
            self.latest_todos_at = at;
            // A read, not a fresh assertion per id: the user's edits still
            // win over the rebuilt view.
            self.apply_manual_todo_overrides();
            self.mark_todos_touched_this_turn();
            // Live only: a replayed rebuild must not suppress the first live
            // turn's all-completed clear.
            if !self.is_replaying {
                self.todos_rebuilt_from_task_list_this_turn = true;
            }
            return;
        }
        if !self.pending_task_creates.remove(tool_use_id) {
            return;
        }
        if is_error {
            if let Some(list) = self.latest_todos.as_mut() {
                list.retain(|t| !todo_has_id(t, tool_use_id));
            }
            return;
        }
        if let (Some(real_id), Some(list)) = (
            todos::task_create_real_id(&tool_result_text(raw)),
            self.latest_todos.as_mut(),
        ) {
            for t in list.iter_mut().filter(|t| todo_has_id(t, tool_use_id)) {
                t["id"] = json!(real_id);
            }
            // An edit made before the result landed (keyed by the temp id)
            // follows the item to its real id. Moved on replay too; only
            // the live move is persisted.
            if let Some(status) = self.manual_todo_overrides.shift_remove(tool_use_id) {
                self.manual_todo_overrides.insert(real_id, status);
                if !self.is_replaying {
                    self.persist_todo_overrides();
                }
            }
        }
    }

    /// An assistant `tool_use` block.
    fn capture_tool_use(&mut self, block: &Value, at: f64) {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            return;
        }
        let name = block.get("name").and_then(Value::as_str).unwrap_or("");
        let input = block.get("input");
        let is_todo_tool = matches!(name, "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList");
        // Mid-turn staleness: live only, open items only, once per turn
        // until the model touches the list again.
        if !self.is_replaying && !is_todo_tool && !self.fired_mid_turn_todo_reminder_this_turn {
            self.tool_uses_since_todo_touch += 1;
            if self.tool_uses_since_todo_touch >= todos::TODOS_MIDTURN_TOOLUSE_THRESHOLD
                && todos::open_todo_count(self.latest_todos.as_deref()) > 0
            {
                let body = todos::todos_mid_turn_reminder_body(
                    self.latest_todos.as_deref().unwrap_or(&[]),
                );
                self.mid_turn_reminders.push(&body);
                self.fired_mid_turn_todo_reminder_this_turn = true;
            }
        }
        let block_id = block.get("id").and_then(Value::as_str);
        match name {
            // The PreToolUse hook flags a worktree live, but doesn't re-fire
            // when a session is rebuilt from disk; the replayed edits do.
            "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
                let target = input
                    .and_then(|i| i.get("file_path").filter(|v| v.is_string()))
                    .or_else(|| input.and_then(|i| i.get("notebook_path")))
                    .and_then(Value::as_str);
                // ("" is falsy in TS; it has no worktree root here either.)
                if let Some(wt) = target.and_then(worktree_root_from_path) {
                    self.broadcast_cwd(&wt);
                }
            }
            // A full replacement (the legacy tool).
            "TodoWrite" => {
                if let Some(list) = input.and_then(|i| i.get("todos")).and_then(Value::as_array)
                    && at >= self.latest_todos_at
                {
                    self.latest_todos = Some(list.clone());
                    self.latest_todos_at = at;
                    // The model asserted these ids afresh: its word wins. (TS
                    // skips `""`, which never has an override.)
                    for id in list.iter().filter_map(|e| e.get("id")?.as_str()) {
                        self.clear_manual_todo_override_for(id);
                    }
                }
                // Any TodoWrite rearms the stale-TodoWrite counter, replayed
                // ones included.
                self.turns_since_todo_write = 0;
                self.mark_todos_touched_this_turn();
            }
            // A pending entry under the temp `tool_use_id`; the result
            // carries the real id.
            "TaskCreate" if block_id.is_some() => {
                let id = block_id.unwrap_or_default();
                if at < self.latest_todos_at
                    || self.pending_task_creates.contains(id)
                    || self
                        .latest_todos
                        .as_ref()
                        .is_some_and(|l| l.iter().any(|t| todo_has_id(t, id)))
                {
                    return;
                }
                let str_field = |k: &str| input.and_then(|i| i.get(k)).and_then(Value::as_str);
                self.pending_task_creates.insert(id.to_owned());
                let mut entry = json!({
                    "id": id,
                    "content": str_field("subject").unwrap_or(""),
                    "status": "pending",
                });
                // `activeForm: undefined` drops out of every serialization.
                if let Some(a) = str_field("activeForm") {
                    entry["activeForm"] = json!(a);
                }
                self.latest_todos.get_or_insert_default().push(entry);
                self.latest_todos_at = at;
                self.mark_todos_touched_this_turn();
                self.clear_manual_todo_override_for(id);
            }
            // The result rebuilds the list (not cut off: a post-clear
            // TaskList is the SDK's truth, not a pre-clear replay).
            "TaskList" if block_id.is_some() => {
                self.pending_task_lists
                    .insert(block_id.unwrap_or_default().to_owned());
            }
            "TaskUpdate" if self.latest_todos.is_some() => {
                let str_field = |k: &str| input.and_then(|i| i.get(k)).and_then(Value::as_str);
                let Some(task_id) = str_field("taskId").filter(|t| !t.is_empty()) else {
                    return;
                };
                let status = str_field("status");
                let subject = str_field("subject").filter(|s| !s.is_empty());
                let list = self.latest_todos.get_or_insert_default();
                if status == Some("deleted") {
                    list.retain(|t| !todo_has_id(t, task_id));
                } else {
                    for t in list.iter_mut().filter(|t| todo_has_id(t, task_id)) {
                        if let Some(st) = status.filter(|s| !s.is_empty()) {
                            t["status"] = json!(st);
                        }
                        if let Some(sub) = subject {
                            t["content"] = json!(sub);
                        }
                    }
                }
                self.mark_todos_touched_this_turn();
                self.clear_manual_todo_override_for(task_id);
            }
            _ => {}
        }
    }

    /// `markTodosTouchedThisTurn`: the model engaged the list, so the
    /// within-turn silence counters restart. (TS also sets
    /// `todosTouchedThisTurn`, which nothing reads.)
    fn mark_todos_touched_this_turn(&mut self) {
        self.tool_uses_since_todo_touch = 0;
        self.fired_mid_turn_todo_reminder_this_turn = false;
    }

    /// `setTodosStale`: flip the flag; only a change repaints (with the live
    /// list, so the flag-only snapshot doesn't wipe the client's).
    fn set_todos_stale(&mut self, stale: bool) {
        if self.todos_stale == stale {
            return;
        }
        self.todos_stale = stale;
        let todos = self.latest_todos.clone().unwrap_or_default();
        self.broadcast(json!({"type": "session_snapshot", "todos": todos, "todosStale": stale}));
    }

    /// No list, an all-done one, or a clear: progress tracking restarts.
    fn reset_todo_progress(&mut self) {
        self.turns_todos_no_progress = 0;
        self.last_todos_done_count = 0;
        self.last_todos_total_count = 0;
    }

    /// The decision half of `maybeAutoSyncTodosOnTurnEnd` (a successful
    /// turn ended): which clear to run, if any. Resets the per-turn flags;
    /// with open items, counts a turn without progress (flag stale at
    /// [`todos::TODOS_STALE_FLAG_TURNS`], clear at
    /// [`todos::TODOS_STALE_CLEAR_TURNS`]) or un-stales on progress, and
    /// queues the `todos-current` reminder for the next turn. An all-done
    /// list clears, except in the turn a live TaskList rebuilt it.
    fn todos_turn_end(&mut self) -> Option<TodosClearReason> {
        let rebuilt = std::mem::take(&mut self.todos_rebuilt_from_task_list_this_turn);
        self.tool_uses_since_todo_touch = 0;
        self.fired_mid_turn_todo_reminder_this_turn = false;
        let Some(list) = self.latest_todos.clone().filter(|l| !l.is_empty()) else {
            self.reset_todo_progress();
            return None;
        };
        let is_done = |t: &&Value| t.get("status").and_then(Value::as_str) == Some("completed");
        let done = list.iter().filter(is_done).count();
        if done == list.len() {
            self.reset_todo_progress();
            return (!rebuilt).then_some(TodosClearReason::Completed);
        }
        let progressed =
            done > self.last_todos_done_count || list.len() < self.last_todos_total_count;
        self.last_todos_done_count = done;
        self.last_todos_total_count = list.len();
        if progressed {
            self.turns_todos_no_progress = 0;
            self.set_todos_stale(false);
        } else {
            self.turns_todos_no_progress += 1;
            if self.turns_todos_no_progress >= todos::TODOS_STALE_CLEAR_TURNS {
                return Some(TodosClearReason::Stale);
            }
            if self.turns_todos_no_progress >= todos::TODOS_STALE_FLAG_TURNS {
                self.set_todos_stale(true);
            }
        }
        // The whole list, done items included, so the model sees the state.
        self.queue_reminder(&todos::todos_current_reminder_body(&list));
        None
    }

    /// `applyManualTodoOverrides`: lay the user's edits over the list in
    /// place (`deleted` filters the item out, any other status replaces
    /// `status`). An override for an id the list lacks is kept but does
    /// nothing. Returns how many overrides took effect.
    fn apply_manual_todo_overrides(&mut self) -> usize {
        let Some(list) = self.latest_todos.as_mut() else {
            return 0;
        };
        let mut applied = 0;
        for (id, &status) in &self.manual_todo_overrides {
            if status == "deleted" {
                let before = list.len();
                list.retain(|t| !todo_has_id(t, id));
                applied += usize::from(list.len() != before);
                continue;
            }
            let mut hit = false;
            for t in list.iter_mut().filter(|t| todo_has_id(t, id)) {
                t["status"] = json!(status);
                hit = true;
            }
            applied += usize::from(hit);
        }
        applied
    }

    /// `clearManualTodoOverrideFor`: the model touched `item_id` live, so
    /// the user's edit for it is dropped (and the drop persisted, best
    /// effort). Never on replay: a surviving persisted override is by
    /// construction one the live model never engaged with, so a replayed
    /// touch predates it.
    fn clear_manual_todo_override_for(&mut self, item_id: &str) {
        if self.is_replaying || self.manual_todo_overrides.shift_remove(item_id).is_none() {
            return;
        }
        self.persist_todo_overrides();
    }

    /// `mergeSessionState({manualTodoOverrides})`, best effort, keys in the
    /// order `JSON.stringify` writes a JS object's (integer-like first).
    fn persist_todo_overrides(&self) {
        let Some((cwd, id)) = &self.state_key else {
            return;
        };
        let raw: Map<String, Value> = self
            .manual_todo_overrides
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect();
        let ordered: Map<String, Value> = js::own_keys_order(&raw)
            .into_iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut patch = Map::new();
        patch.insert("manualTodoOverrides".into(), Value::Object(ordered));
        let _ = sessions_db::merge_session_state(cwd, id, patch);
    }

    /// `broadcastCwd`: a `cwd_changed` only when the effective cwd moved.
    fn broadcast_cwd(&mut self, cwd: &str) {
        if cwd.is_empty() || self.last_cwd_broadcast.as_deref() == Some(cwd) {
            return;
        }
        self.last_cwd_broadcast = Some(cwd.to_owned());
        self.broadcast(json!({"type": "cwd_changed", "cwd": cwd}));
    }

    /// `captureTaskState`: subagent / background task state off the wire.
    /// Feeds `getStatus()` (a live foreground subagent keeps the session
    /// "running") and persists each task (with its subagent's
    /// conversation) for `task_snapshot`. A message with a truthy
    /// `parent_tool_use_id` is a subagent's: kept under that id, then a
    /// throttled write. Then the `task_*` system messages: started (write),
    /// progress (throttled write), updated / notification (write).
    fn capture_task_state(&mut self, ev: &Value) {
        if ev_type(ev) != "sdk" {
            return;
        }
        let Some(m) = ev.get("message") else { return };
        if let Some(parent) = m
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            // `{at: event.at, message}`: an absent `at` drops out.
            let mut rec = Map::new();
            if let Some(at) = ev.get("at") {
                rec.insert("at".into(), at.clone());
            }
            rec.insert("message".into(), m.clone());
            let list = self.subagent_msgs.entry(parent.to_owned()).or_default();
            list.push(Value::Object(rec));
            if list.len() > MAX_INNER_MESSAGES {
                list.drain(..list.len() - MAX_INNER_MESSAGES);
            }
            self.persist_task_for_tool_use(parent);
            return;
        }
        if m.get("type").and_then(Value::as_str) != Some("system") {
            return;
        }
        let Some(task_id) = m
            .get("task_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        // TS assigns these raw; only the SDK's own types are kept here.
        let text = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_owned);
        let truthy_text = |v: Option<&Value>| text(v).filter(|s| !s.is_empty());
        let flag = |v: Option<&Value>| v.filter(|v| !v.is_null()).map(js::truthy);
        let usage = |k: &str| {
            m.get("usage")
                .and_then(|u| u.get(k))
                .and_then(Value::as_f64)
        };
        let apply_usage = |meta: &mut TaskEntry| {
            if let Some(n) = usage("total_tokens") {
                meta.total_tokens = Some(n);
            }
            if let Some(n) = usage("tool_uses") {
                meta.tool_uses = Some(n);
            }
            if let Some(n) = usage("duration_ms") {
                meta.duration_ms = Some(n);
            }
        };
        match m.get("subtype").and_then(Value::as_str) {
            Some("task_started") => {
                // Seeded from the start-of-life fields: a task backgrounded
                // from birth never gets a `task_updated` saying so.
                let meta = TaskEntry {
                    task_id: task_id.to_owned(),
                    tool_use_id: text(m.get("tool_use_id")),
                    description: text(m.get("description")),
                    task_type: text(m.get("task_type")),
                    workflow_name: text(m.get("workflow_name")),
                    status: "running".into(),
                    is_backgrounded: flag(m.get("is_backgrounded")),
                    spawn_depth: m.get("spawn_depth").and_then(Value::as_f64),
                    ambient: flag(m.get("ambient")),
                    ..Default::default()
                };
                self.task_meta.insert(task_id.to_owned(), meta);
                self.persist_task(task_id, false);
                self.broadcast_turn_status_if_changed();
            }
            Some("task_progress") => {
                let Some(meta) = self.task_meta.get_mut(task_id) else {
                    return;
                };
                if let Some(d) = truthy_text(m.get("description")) {
                    meta.description = Some(d);
                }
                if let Some(s) = truthy_text(m.get("summary")) {
                    meta.summary = Some(s);
                }
                apply_usage(meta);
                self.persist_task(task_id, true);
            }
            Some("task_updated") => {
                let Some(meta) = self.task_meta.get_mut(task_id) else {
                    return;
                };
                let patch = m.get("patch");
                let field = |k: &str| patch.and_then(|p| p.get(k));
                if let Some(s) = truthy_text(field("status")) {
                    meta.status = s;
                }
                if let Some(d) = truthy_text(field("description")) {
                    meta.description = Some(d);
                }
                if let Some(e) = truthy_text(field("error")) {
                    meta.error = Some(e);
                }
                if let Some(bg) = flag(field("is_backgrounded")) {
                    meta.is_backgrounded = Some(bg);
                }
                self.persist_task(task_id, false);
                self.broadcast_turn_status_if_changed();
            }
            Some("task_notification") => {
                let meta = self
                    .task_meta
                    .entry(task_id.to_owned())
                    .or_insert_with(|| TaskEntry {
                        task_id: task_id.to_owned(),
                        // `msg.status ?? "completed"`.
                        status: text(m.get("status")).unwrap_or_else(|| "completed".into()),
                        ..Default::default()
                    });
                if let Some(s) = truthy_text(m.get("status")) {
                    meta.status = s;
                }
                if let Some(s) = truthy_text(m.get("summary")) {
                    meta.summary = Some(s);
                }
                apply_usage(meta);
                if let Some(a) = flag(m.get("ambient")) {
                    meta.ambient = Some(a);
                }
                if let Some(links) = m.get("resource_links").filter(|v| !v.is_null()) {
                    meta.resource_links = Some(links.clone());
                }
                if let Some(r) = text(m.get("reason")) {
                    meta.reason = Some(r);
                }
                if let Some(f) = text(m.get("output_file")) {
                    meta.output_file = Some(f);
                }
                self.persist_task(task_id, false);
                self.broadcast_turn_status_if_changed();
            }
            _ => {}
        }
    }

    /// `persistTask`: write the task with its subagent's conversation
    /// (best effort). `throttle` skips it inside the window since the last
    /// write; any write restarts the window.
    fn persist_task(&mut self, task_id: &str, throttle: bool) {
        let now = self.task_clock.map_or_else(now_ms, |clock| clock());
        if throttle {
            let last = self
                .task_persist_throttle_at
                .get(task_id)
                .copied()
                .unwrap_or(0);
            if now - last < TASK_PERSIST_THROTTLE_MS {
                return;
            }
        }
        self.task_persist_throttle_at
            .insert(task_id.to_owned(), now);
        let (Some(meta), Some((cwd, id))) = (self.task_meta.get(task_id), &self.state_key) else {
            return;
        };
        let mut entry = meta.clone();
        entry.inner_messages = meta
            .tool_use_id
            .as_ref()
            .and_then(|t| self.subagent_msgs.get(t))
            .cloned()
            .unwrap_or_default();
        let _ = session_tasks_db::save_session_task(cwd, id, &entry);
    }

    /// `persistTaskForToolUse`: the throttled write for the first task
    /// whose parent `tool_use_id` this is (none yet: nothing to write).
    /// `trackScheduledLoops(message, at)`: `at` is the message's time (the
    /// transcript's on a replay), else now. Runs the tracker's database
    /// writes best effort, as TS fires them.
    fn track_scheduled_loops(&mut self, message: &Value, at: Option<i64>) {
        use crate::loop_ticks_db::{LoopTick, attach_loop_tick_tokens, record_loop_tick};
        use crate::session_loops::LoopEffect;
        let effects = self.loops.track(message, at.unwrap_or_else(now_ms));
        let Some((cwd, id)) = &self.state_key else {
            return;
        };
        for effect in effects {
            match effect {
                LoopEffect::RecordTick {
                    tool_use_id,
                    prompt,
                    fired_at,
                    noop,
                } => record_loop_tick(
                    cwd,
                    &LoopTick {
                        session_id: id.clone(),
                        session_title: self.title.clone(),
                        tool_use_id,
                        prompt,
                        fired_at: fired_at as f64,
                        noop,
                    },
                ),
                LoopEffect::AttachTokens {
                    tool_use_id,
                    tokens,
                } => attach_loop_tick_tokens(cwd, &tool_use_id, tokens),
            }
        }
    }

    fn persist_task_for_tool_use(&mut self, tool_use_id: &str) {
        let task_id = self
            .task_meta
            .values()
            .find(|m| m.tool_use_id.as_deref() == Some(tool_use_id))
            .map(|m| m.task_id.clone());
        if let Some(task_id) = task_id {
            self.persist_task(&task_id, true);
        }
    }

    fn queue_reminder(&mut self, body: &str) {
        self.reminders.push(body);
    }

    fn take_reminders(&mut self) -> String {
        self.reminders.take().unwrap_or_default()
    }

    /// `takePendingBashBlocks`: the queued `<bash-*>` blocks joined with
    /// newlines, plus one before the user's text; nothing when none queued.
    fn take_bash_blocks(&mut self) -> String {
        let blocks = std::mem::take(&mut self.bash_blocks);
        if blocks.is_empty() {
            String::new()
        } else {
            blocks.join("\n") + "\n"
        }
    }

    fn take_goal_reminder(&mut self) -> String {
        let Some(goal) = self.goal.goal.as_ref().filter(|_| !self.goal_announced) else {
            return String::new();
        };
        let out = format!(
            "<session-goal>\nThe user has set this goal for the session: {goal}\n\n\
             Work toward it. When you are confident it is fully accomplished, call the \
             mcp__claudius_goal__report_goal_achieved tool with a one-sentence summary. \
             Do not call it for partial progress.\n</session-goal>\n\n"
        );
        self.goal_announced = true;
        out
    }

    fn pending_prompt_events(&self) -> Vec<Value> {
        let mut out = Vec::new();
        for (id, p) in &self.pending_asks {
            out.push(prompt_events::ask_event(
                id,
                p.tool_use_id.as_ref(),
                &p.questions,
            ));
        }
        for p in self.pending_permissions.values() {
            out.push(p.meta.clone());
        }
        for p in self.pending_elicitations.values() {
            out.push(p.meta.clone());
        }
        for (id, p) in &self.pending_plans {
            let raw = Some(&p.raw).filter(|r| js::truthy(r));
            out.push(prompt_events::plan_event(
                id,
                p.tool_use_id.as_ref(),
                &p.plan,
                raw,
            ));
        }
        out
    }

    fn announce_holder(&mut self) {
        let ev = json!({"type": "holder_changed", "holderId": self.holder_id});
        self.fan_out(&ev);
    }

    /// `drainPendingDecisions(reason)`.
    fn drain_pending_decisions(&mut self, reason: &str) {
        for (id, p) in std::mem::take(&mut self.pending_permissions) {
            self.bus.mark_read(&id);
            let _ = p.tx.send(PermissionResult::deny(reason));
            self.prompt_settled("permission", &id);
        }
        for (id, p) in std::mem::take(&mut self.pending_asks) {
            self.bus.mark_read(&id);
            let _ = p.tx.send(PermissionResult::deny(reason));
            self.prompt_settled("ask", &id);
        }
        for (id, p) in std::mem::take(&mut self.pending_elicitations) {
            self.bus.mark_read(&id);
            let _ = p.tx.send(json!({"action": "cancel"}));
            self.prompt_settled("elicitation", &id);
        }
        for (id, p) in std::mem::take(&mut self.pending_plans) {
            self.bus.mark_read(&id);
            let _ = p.tx.send(PermissionResult::deny(reason));
        }
    }
}

/// `TODOS_AUTO_CLEAR_MS`: a replayed list untouched this long is dropped at
/// start.
const TODOS_AUTO_CLEAR_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// Why `clear_todos` ran (`todos_auto_cleared.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodosClearReason {
    /// The user's Clear: no toast.
    Manual,
    /// Untouched too long.
    Stale,
    /// Every item done.
    Completed,
}

impl TodosClearReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Stale => "stale",
            Self::Completed => "completed",
        }
    }
}

/// A user's per-item edit (`POST /:id/todos/:itemId` `action`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoItemAction {
    Complete,
    Reopen,
    InProgress,
    Delete,
}

impl TodoItemAction {
    /// The wire `action` → the edit, or `None` for anything else.
    pub fn parse(action: &str) -> Option<Self> {
        Some(match action {
            "complete" => Self::Complete,
            "reopen" => Self::Reopen,
            "in_progress" => Self::InProgress,
            "delete" => Self::Delete,
            _ => return None,
        })
    }

    /// The status the override records.
    fn override_status(self) -> &'static str {
        match self {
            Self::Complete => "completed",
            Self::Reopen => "pending",
            Self::InProgress => "in_progress",
            Self::Delete => "deleted",
        }
    }
}

/// What a persisted `manualTodoOverrides` value may be.
fn override_status_from(v: &Value) -> Option<&'static str> {
    match v.as_str()? {
        "completed" => Some("completed"),
        "pending" => Some("pending"),
        "in_progress" => Some("in_progress"),
        "deleted" => Some("deleted"),
        _ => None,
    }
}

/// A tool result's text: a string `content`, or the concatenated truthy
/// `text` of its `{type: "text"}` parts (`+=`, so a non-string prints as
/// `String(v)`).
fn tool_result_text(raw: &Value) -> String {
    match raw.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|c| c.get("text").filter(|t| js::truthy(t)))
            .map(|t| js::to_string(Some(t)))
            .collect(),
        _ => String::new(),
    }
}

/// `entry.id === id` for a to-do entry (only objects carry an id; TS
/// throws on a `null` entry).
fn todo_has_id(entry: &Value, id: &str) -> bool {
    entry.get("id").and_then(Value::as_str) == Some(id)
}

pub use crate::reminders::wrap_reminder;

pub fn midturn_inject_reminder_body() -> &'static str {
    "The user sent the message that follows while you were still working on the previous turn. After completing your current task, you MUST address that message. Do not ignore it. This is an automated reminder — the user has NOT acknowledged that the prior task is done."
}
pub fn auto_mode_exit_reminder_body() -> &'static str {
    "## Exited Auto Mode\nYou have exited auto mode. The user may now want to interact more directly. You should ask clarifying questions when the approach is ambiguous rather than making assumptions."
}
pub fn verify_plan_reminder_body() -> &'static str {
    "You have completed implementing the plan. Verify that all plan items were completed correctly by checking the work directly in this session, NOT via the Task tool or a subagent — the parent context already holds the plan's state, tool history, and edited files that a fresh sub-agent would lose."
}
pub fn plan_mode_reentry_reminder_body(prior: &str) -> String {
    format!(
        "## Re-entering Plan Mode\nYou are returning to plan mode after having previously exited it. A plan from your previous planning session is reproduced below — treat this as a fresh planning round rather than assuming the prior plan still applies.\n\nPrevious plan:\n{prior}"
    )
}
/// `ultrathinkReminderBody(text, inlinePastes)`. CC 2.1.311 — the keyword
/// only counts where the engine's quote- and path-aware finder sees it
/// ([`crate::ultrathink_keyword`]): not inside backticks, quotes or
/// brackets, not as part of a file path or flag, and not inside a large
/// paste.
pub fn ultrathink_reminder_body(text: &str, inline_pastes: &[String]) -> Option<&'static str> {
    crate::ultrathink_keyword::has_ultrathink_keyword(text, inline_pastes).then_some(
        "The user included the keyword \"ultrathink\", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants.",
    )
}
fn local_date_key() -> String {
    crate::reminders::local_date_key(chrono::Local::now().date_naive())
}

// JS `.` stops at every line terminator, not just `\n`.
static WORKTREE_ROOT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([^\n\r\u{2028}\u{2029}]*/\.claude/worktrees/[^/]+)(?:/|$)").unwrap()
});
/// `worktreeRootFromPath`.
pub fn worktree_root_from_path(p: &str) -> Option<String> {
    WORKTREE_ROOT.captures(p).map(|c| c[1].to_owned())
}

/// `buildQueryEnv`.
pub fn build_query_env(
    env_override: Option<&HashMap<String, String>>,
    restricted: bool,
) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = env_override
        .cloned()
        .unwrap_or_else(|| std::env::vars().collect());
    env.insert("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), "1".into());
    env.insert("CLAUDE_CODE_STARTUP_FAILURE_RESULTS".into(), "1".into());
    if restricted {
        env.insert("CLAUDE_CODE_RESTRICTED".into(), "1".into());
    }
    env
}

/// `readLimits(cwd).limits` → `(maxWebSearches, maxSubagents)`: the file
/// read as `readFile(…, "utf8")` + `JSON.parse` read it (S27b).
fn read_tool_budget_limits(cwd: &str) -> [Option<f64>; 2] {
    let file = paths::claudius_root()
        .join("limits")
        .join(format!("{}.json", paths::encode_project_dir(cwd)));
    let v: Value = std::fs::read(file)
        .ok()
        .and_then(|b| js::json_parse(&String::from_utf8_lossy(&b)).ok())
        .unwrap_or(Value::Null);
    let l = v.get("limits");
    let g = |k: &str| l.and_then(|l| l.get(k)).and_then(Value::as_f64);
    [g("maxWebSearches"), g("maxSubagents")]
}

pub struct Session {
    pub id: String,
    pub cwd: String,
    pub created_at: i64,
    opts: SessionOptions,
    weak: Weak<Session>,
    st: Mutex<State>,
    query: Mutex<Option<QueryHandle>>,
    input_tx: mpsc::UnboundedSender<Value>,
    input_rx: Mutex<Option<mpsc::UnboundedReceiver<Value>>>,
    abort: CancellationToken,
    sub_count: watch::Sender<usize>,
    draining: AtomicBool,
    tool_budget_limits: Mutex<[Option<f64>; 2]>,
    /// `jsonlWatcher` + `jsonlResyncTimer`: see [`Session::start_jsonl_watcher`].
    jsonl_watcher: Mutex<WatchSlot>,
    /// Watch starts still running on their thread (whether or not their
    /// watch will be installed): see [`Session::wait_jsonl_watcher`].
    jsonl_watch_pending: AtomicUsize,
    /// `jsonlResyncBusy`: set while [`Session::resync_from_disk`] runs, so a
    /// watch event that lands meanwhile re-arms instead of stacking work.
    jsonl_resync_busy: AtomicBool,
    /// `fullUsageMemo`: see [`Session::get_usage_behaviors`].
    full_usage: crate::usage_behaviors::FullUsageMemo<claudius_agent::QueryId>,
    /// The MCP needs-auth / disconnected notices ([`crate::mcp_notices`]).
    pub mcp_notices: crate::mcp_notices::McpNotices,
    /// The manager that created this session, for `recoverInPlace` and
    /// `noteThinkingRecoverySuccess`; the process-wide one otherwise.
    manager: std::sync::OnceLock<Weak<crate::session_manager::SessionManager>>,
}

/// The JSONL watcher's state ([`Session::start_jsonl_watcher`]).
enum WatchSlot {
    Idle,
    /// The watch is being set up on a blocking thread.
    Starting,
    /// Held for its `Drop`, which stops the watch.
    Running {
        _watch: JsonlWatch,
    },
}

/// A live SSE subscription. Dropping it unsubscribes (and releases the
/// holder slot if this tab held it).
pub struct Subscription {
    session: Arc<Session>,
    id: u64,
    tab_id: Option<String>,
    pub rx: mpsc::UnboundedReceiver<Value>,
}

impl Subscription {
    pub async fn recv(&mut self) -> Option<Value> {
        self.rx.recv().await
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let count = {
            let mut st = self.session.st.lock().unwrap();
            st.subs.retain(|s| s.id != self.id);
            if self.tab_id.is_some() && self.tab_id == st.holder_id {
                st.holder_id = None;
                st.announce_holder();
            }
            st.subs.len()
        };
        self.session.sub_count.send_replace(count);
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("invalid session id")]
    InvalidId,
}

impl Session {
    pub fn new(opts: SessionOptions) -> Result<Arc<Session>, SessionError> {
        let id = opts
            .id
            .clone()
            .or_else(|| opts.resume.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if !crate::is_safe_id(&id) {
            return Err(SessionError::InvalidId);
        }
        let cwd = opts.cwd.clone().unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "/".into())
        });
        let restricted = opts.restricted_mode == Some(true);
        let mut mode = opts
            .permission_mode
            .clone()
            .unwrap_or_else(|| "default".into());
        if restricted && mode == "bypassPermissions" {
            mode = "default".into();
        }
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let (sub_count, _) = watch::channel(0usize);
        let state = State {
            model: opts.model.clone(),
            agent: opts.agent.clone(),
            permission_mode: mode,
            tips: events::DEFAULT_TIPS.clone(),
            latest_user_prompt_at: f64::NEG_INFINITY,
            latest_todos_at: f64::NEG_INFINITY,
            state_key: Some((cwd.clone(), id.clone())),
            bus: crate::session_notify::BusFeed::new(&cwd, &id),
            ..Default::default()
        };
        Ok(Arc::new_cyclic(|weak| Session {
            id,
            cwd,
            created_at: now_ms(),
            opts,
            weak: weak.clone(),
            st: Mutex::new(state),
            query: Mutex::new(None),
            input_tx,
            input_rx: Mutex::new(Some(input_rx)),
            abort: CancellationToken::new(),
            sub_count,
            draining: AtomicBool::new(false),
            tool_budget_limits: Mutex::new([None, None]),
            jsonl_watcher: Mutex::new(WatchSlot::Idle),
            jsonl_watch_pending: AtomicUsize::new(0),
            jsonl_resync_busy: AtomicBool::new(false),
            full_usage: crate::usage_behaviors::FullUsageMemo::new(now_ms),
            mcp_notices: Default::default(),
            manager: std::sync::OnceLock::new(),
        }))
    }

    fn arc(&self) -> Arc<Session> {
        self.weak.upgrade().expect("session alive")
    }

    fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.st.lock().unwrap())
    }

    fn handle(&self) -> Option<QueryHandle> {
        self.query.lock().unwrap().clone()
    }

    pub fn broadcast(&self, ev: Value) {
        let model_changed = ev_type(&ev) == "model_changed";
        let live_init = self.before_live_init(&ev);
        // CC 2.1.300 — a live credits-rejected notice turns fast mode off.
        let fast_off =
            crate::fast_mode::is_credits_rejected_event(&ev) && !self.with(|st| st.is_replaying);
        self.with(|st| st.broadcast(ev));
        if fast_off {
            self.spawn_fast_off();
        }
        // A model switch (picker, `/model`, auto-fallback, resume) can change
        // the applied effort: each model has its own default and levels.
        if model_changed {
            self.refresh_applied_effort();
        }
        if let Some(model) = live_init {
            self.after_live_init(model);
        }
    }

    // ───────────────────────────── accessors ─────────────────────────────

    pub fn model(&self) -> Option<String> {
        self.with(|st| st.model.clone())
    }
    /// `session.agent`: the main-thread agent, `None` for the default one.
    pub fn agent(&self) -> Option<String> {
        self.with(|st| st.agent.clone())
    }
    pub fn effective_model(&self) -> Option<String> {
        self.with(|st| st.model.clone().or_else(|| st.sdk_model.clone()))
    }
    pub fn title(&self) -> Option<String> {
        self.with(|st| st.title.clone())
    }
    /// `pendingTitleMirror`: a rename still waiting for a transcript to
    /// append it to (CC 2.1.309). Read by the tests.
    pub fn pending_title_mirror(&self) -> Option<String> {
        self.with(|st| st.pending_title_mirror.clone())
    }
    /// The cached advisor (`GET /advisor` falls back to settings.json on `None`).
    pub fn advisor_model(&self) -> Option<String> {
        self.with(|st| st.advisor_model.clone())
    }
    pub fn permission_mode(&self) -> String {
        self.with(|st| st.permission_mode.clone())
    }
    pub fn status(&self) -> TurnStatus {
        self.with(|st| st.status())
    }
    pub fn is_done(&self) -> bool {
        self.with(|st| st.done)
    }
    pub fn has_pending_user_prompts(&self) -> bool {
        self.with(|st| st.has_pending_user_prompts())
    }
    pub fn subscriber_count(&self) -> usize {
        self.with(|st| st.subs.len())
    }
    pub fn subscriber_count_watch(&self) -> watch::Receiver<usize> {
        self.sub_count.subscribe()
    }
    pub fn queue_dispatch_asap(&self) -> bool {
        self.with(|st| st.queue_dispatch_asap)
    }
    pub fn buffer_snapshot(&self) -> Vec<Value> {
        self.with(|st| st.buffer.clone())
    }
    pub fn recent_denials(&self) -> Vec<Value> {
        self.with(|st| st.recent_denials.clone())
    }
    /// Wait until the notification-bus calls made so far have run
    /// ([`crate::session_notify`]).
    pub async fn notifications_settled(&self) {
        let feed = self.with(|st| st.bus.clone());
        feed.settled().await;
    }
    /// `injectDenialForTesting` (the dev-only `dev-inject-denial` route): seed
    /// the denial ring without a real `permission_denied` event.
    pub fn inject_denial_for_testing(&self, tool_name: &str, reason_type: &str) {
        self.with(|st| {
            st.push_denial(
                json!({"toolName": tool_name, "reasonType": reason_type, "at": now_ms()}),
            )
        });
    }
    pub fn options(&self) -> &SessionOptions {
        &self.opts
    }
    pub fn query_handle(&self) -> Option<QueryHandle> {
        self.handle()
    }

    // ── Account pin (crate::account_drift, crate::account_pinning) ──

    /// The account this session runs under, and its drift from the active one.
    pub fn account_pin(&self) -> crate::account_drift::AccountPin {
        self.with(|st| st.account_pin.clone())
    }

    /// Replace the session's account fields (start sets them).
    pub fn set_account_pin(&self, pin: crate::account_drift::AccountPin) {
        self.with(|st| st.account_pin = pin);
    }

    /// `refreshAccountDrift`: re-check the drift against `store`'s active
    /// profile (a store that fails to read counts as none) and tell every
    /// tab when it changed (`account_changed`). A session without a pin
    /// reads nothing.
    pub fn refresh_account_drift(&self, store: &crate::accounts::AccountsStore) {
        if !self.with(|st| st.account_pin.is_set()) {
            return;
        }
        let active = store.get_active_profile().ok().flatten();
        self.with(|st| {
            if let Some(ev) = st.account_pin.refresh(active.as_ref()) {
                st.broadcast(ev);
            }
        });
    }

    /// `noteAccountAutoRotateObservation` for a rate-limit wall: once per
    /// session, rotate the active profile when the user turned auto-rotate
    /// on ([`crate::account_pinning::auto_rotate`]) and tell every tab. The
    /// live query keeps its credential; the next session spawns on the new
    /// profile.
    fn note_account_auto_rotate_observation(&self) {
        if self.with(|st| st.account_auto_rotated) {
            return;
        }
        let store = crate::accounts::AccountsStore::from_env();
        if let Some(ev) = crate::account_pinning::auto_rotate(&store) {
            self.with(|st| {
                st.account_auto_rotated = true;
                st.broadcast(ev);
            });
        }
    }

    /// Set by [`SessionManager::create`](crate::session_manager::SessionManager::create).
    pub(crate) fn attach_manager(&self, manager: Weak<crate::session_manager::SessionManager>) {
        let _ = self.manager.set(manager);
    }

    fn manager(&self) -> Arc<crate::session_manager::SessionManager> {
        self.manager
            .get()
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| crate::session_manager::session_manager().clone())
    }

    /// `getRebuildOpts()`: every create option, with the live model, agent
    /// and permission mode, so a rebuild under the same id
    /// (`recover_in_place`, `restart_in_place`) changes nothing else. The
    /// caller adds `resume` / `resume_session_at`.
    pub fn rebuild_options(&self) -> SessionOptions {
        let (model, agent, permission_mode) = self.with(|st| {
            (
                st.model.clone(),
                st.agent.clone(),
                st.permission_mode.clone(),
            )
        });
        SessionOptions {
            id: None,
            cwd: Some(self.cwd.clone()),
            model,
            agent,
            permission_mode: Some(permission_mode),
            resume: None,
            resume_session_at: None,
            ..self.opts.clone()
        }
    }

    /// `resumeSessionAt` as TS reads it (`this.resumeAt ? … : …`): an empty
    /// one is unset, so it neither slices the replay nor reaches the CLI.
    fn resume_at(&self) -> Option<&str> {
        self.opts
            .resume_session_at
            .as_deref()
            .filter(|a| !a.is_empty())
    }

    // ─────────────────────────────── start ───────────────────────────────

    /// What the last `start()` threw, if it did (the JS error's `name` and
    /// `message`), taken once.
    pub fn take_start_error(&self) -> Option<(&'static str, String)> {
        self.with(|st| st.start_error.take())
    }

    /// `start()` — replay history (on resume), load per-session state, spawn
    /// the CLI and begin consuming its stream.
    pub async fn start(&self) {
        if self.handle().is_some() {
            return;
        }
        if let Err(msg) = validate_workspace_cwd(&self.cwd) {
            self.broadcast(json!({"type": "error", "message": msg}));
            return;
        }
        *self.tool_budget_limits.lock().unwrap() = read_tool_budget_limits(&self.cwd);
        // `sweepOrphanedActionableForSession`: an earlier life's prompts are unanswerable.
        self.with(|st| st.bus.sweep());

        // Seed the to-do cutoff from the durable clear marker before the
        // replay, so pre-clear TodoWrite / TaskCreate entries bounce
        // instead of resurrecting a cleared list on every restart.
        let persisted = sessions_db::get_session_state(&self.cwd, &self.id);
        if let Some(cleared_at) = persisted
            .get("todosClearedAt")
            .and_then(Value::as_f64)
            .filter(|f| f.is_finite())
        {
            self.with(|st| st.latest_todos_at = cleared_at);
        }
        // The user's per-item edits, applied after the replay (which can't
        // drop them: replayed touches predate every surviving override).
        // Unknown statuses and empty ids are skipped.
        if let Some(Value::Object(raw)) = persisted.get("manualTodoOverrides") {
            let overrides: IndexMap<String, &'static str> = js::own_keys_order(raw)
                .into_iter()
                .filter(|(id, _)| !id.is_empty())
                .filter_map(|(id, v)| Some((id.clone(), override_status_from(v)?)))
                .collect();
            self.with(|st| st.manual_todo_overrides = overrides);
        }
        self.with(|st| st.is_replaying = true);
        if let Some(resume) = self.opts.resume.clone() {
            self.replay_transcript(&resume);
        }
        let resume = self.opts.resume.as_deref();
        if let Some(t) = session_titles::start_title(&self.cwd, &self.id, resume) {
            // CC 2.1.309 — the fresh branch also seeds the pending mirror.
            let mirror = session_titles::start_mirror(&t, resume);
            self.with(|st| {
                st.title = Some(t);
                if let Some(m) = mirror {
                    st.pending_title_mirror = Some(m);
                }
            });
        }
        // `seedUsageBaseline`, before the first subscriber's echo: the
        // checkpoint the resumed CLI restores, then the persisted row or a
        // one-time estimate from the resumed transcripts.
        if let Some(cp) =
            resume.and_then(|r| crate::sdk_cost_state::last_recorded_cost_state(r, &self.cwd))
        {
            self.with(|st| st.sdk_last_cumulative = cp);
        }
        if let Some(totals) = crate::usage_seed::seed_usage_totals(&self.cwd, &self.id, resume) {
            self.with(|st| st.usage_totals = totals);
        }
        self.with(|st| st.is_replaying = false);

        // The replay may have rebuilt a list: drop it if it's been
        // untouched for `TODOS_AUTO_CLEAR_MS` (an abandoned session), or if
        // every item is done (a session that finished and went idle).
        let stale = self.with(|st| {
            st.latest_todos.as_ref().is_some_and(|l| !l.is_empty())
                && st.latest_todos_at.is_finite()
                && now_ms() as f64 - st.latest_todos_at > TODOS_AUTO_CLEAR_MS
        });
        if stale {
            self.clear_todos(TodosClearReason::Stale);
        }
        // The user's edits paint over the replayed list (no broadcast: no
        // one is subscribed yet; `subscribe()`'s snapshot carries it).
        self.with(|st| st.apply_manual_todo_overrides());
        let all_done = self.with(|st| {
            st.latest_todos.as_ref().is_some_and(|l| {
                !l.is_empty()
                    && l.iter()
                        .all(|t| t.get("status").and_then(Value::as_str) == Some("completed"))
            })
        });
        if all_done {
            self.clear_todos(TodosClearReason::Completed);
        }

        let (model, title) = self.with(|st| (st.model.clone(), st.title.clone()));
        let _ =
            sessions_db::upsert_session(&self.id, &self.cwd, model.as_deref(), title.as_deref());
        let goal = sessions_db::get_session_goal(&self.cwd, &self.id);
        self.with(|st| {
            st.goal_announced = goal.goal.is_some();
            st.goal = goal;
        });

        // `readSettings(…).catch(() => ({}))`, then `userSettings.spinnerTipsEnabled`,
        // which throws on a `null` file: `start()` fails.
        let user_settings = settings::read_settings_js(Scope::User, &self.cwd);
        let Some(mut user_settings) = user_settings.unwrap_or_else(|_| Some(Map::new())) else {
            let msg = settings::null_property_error("spinnerTipsEnabled");
            self.with(|st| st.start_error = Some(("TypeError", msg)));
            return;
        };
        // The account this session runs under (its pin, else the active
        // profile) and the CLI's environment for it; a profile whose config
        // dir can't be provisioned fails the start (S30).
        let account = crate::account_pinning::start_account(
            &crate::accounts::AccountsStore::from_env(),
            &self.cwd,
            &self.id,
            self.opts.runtime.env_override.as_ref(),
        );
        match account {
            Ok(a) => self.with(|st| {
                st.account_pin = a.pin;
                st.active_profile_expires_at = a.expires_at;
                st.account_env = a.env;
            }),
            Err(e) => {
                self.with(|st| st.start_error = Some(("Error", e.0)));
                return;
            }
        }
        // Fable-class request models reject any advisor tool (API 400), so an
        // advisor re-armed from settings.json against a fable model is dropped
        // before `build_options` forwards it to the flag layer.
        // `this.advisorModel && this.model?.includes("fable")`: an empty
        // advisor is no advisor, and a model with no `includes` throws there
        // (S27d), so the start rejects before anything is written.
        let armed = self.with(|st| {
            st.advisor_model = user_settings
                .get("advisorModel")
                .and_then(Value::as_str)
                .map(str::to_owned);
            st.advisor_model.as_deref().is_some_and(|a| !a.is_empty())
        });
        let fable = if armed {
            match self.model_includes_fable() {
                Ok(f) => f,
                Err(e) => {
                    self.with(|st| st.start_error = Some(e));
                    return;
                }
            }
        } else {
            false
        };
        let advisor_cleared = self.with(|st| if fable { st.advisor_model.take() } else { None });
        if advisor_cleared.is_some() {
            user_settings.shift_remove("advisorModel");
            if let Err(e) = settings::write_settings(Scope::User, &self.cwd, &user_settings) {
                tracing::error!(target: log::SESSION, "[session.start] advisor-fable-incompatible clear failed: {e}");
            }
        }
        // `spinnerTipsConfig`: any `tipsFile` is read here, once, not per subscribe.
        let tips = crate::spinner_tips::SpinnerTipsConfig::from_settings(
            &user_settings,
            &paths::home_dir(),
        )
        .tips();
        self.with(|st| {
            st.tips = tips;
            st.queue_dispatch_asap = user_settings
                .get("queueDispatchMode")
                .and_then(Value::as_str)
                == Some("asap");
        });

        // An option `start()` can't read: TS throws while it builds the
        // options (`planModeInstructions.trim()`) or where the SDK prints
        // them, so `create` answers 500 with the error's name (S27d).
        if let Some(e) = self.opts.odd.start_error.clone() {
            self.with(|st| st.start_error = Some(e));
            return;
        }
        let mut options = self.build_options(&user_settings);
        options.agents = crate::db_agents::load_db_agents_for_options(&self.cwd); // A-P3.8
        // Resolve the resumed JSONL before anything can read it: `subscribe()`
        // and the stream route echo it on every `ready`. Synchronous, like
        // the worktree probe above (TS awaits its `stat`s).
        if let Some(resume) = self.opts.resume.as_deref() {
            let base = crate::resumed_transcript::default_projects_base();
            let found = crate::resumed_transcript::find_resumed_transcript_path(
                resume,
                &self.cwd,
                &base.to_string_lossy(),
            );
            self.with(|st| st.resumed_transcript_file = found.clone());
        }
        let spawned = match Query::spawn(options).await {
            Ok(q) => Ok(q.into_parts()),
            // `query()` throws while it builds the argv (a fallback model
            // equal to the model, …): TS `start()` rejects, so `create` fails.
            Err(claudius_agent::AgentError::InvalidOptions(msg)) => {
                self.with(|st| st.start_error = Some(("Error", msg)));
                return;
            }
            Err(e) => Err(e.to_string()),
        };
        if let Ok((h, _)) = &spawned {
            *self.query.lock().unwrap() = Some(h.clone());
        }
        self.with(|st| {
            // TS `this.query` is set even when the CLI then fails to spawn.
            st.has_query = true;
            let mut ready = self.ready_event(st);
            if let Some(p) = st.resumed_transcript_path() {
                ready["transcriptPath"] = json!(p);
            }
            if let Some(account) = st.account_pin.account_json() {
                ready["account"] = account;
            }
            st.broadcast(ready);
            if let Some(t) = st.title.clone() {
                st.broadcast(json!({"type": "session_title", "title": t}));
            }
            if st.goal.goal.is_some() {
                let ev = sessions_db::goal_event(&st.goal);
                st.broadcast(ev);
            }
            if let Some(prev) = &advisor_cleared {
                let ev = json!({"type": "advisor_disabled_on_model_change", "previousAdvisor": prev, "newModel": st.model});
                st.broadcast(ev);
            }
            tracing::debug!(
                target: log::SESS_LOAD,
                id = %self.id,
                resumeFrom = ?self.opts.resume,
                bufferLen = st.buffer.len(),
                title = ?st.title,
                "[sess-load] start.complete"
            );
        });
        let (handle, messages) = match spawned {
            Ok(parts) => parts,
            Err(message) => {
                // TS runs start()'s tail before the stream's error lands
                // (S27a): the watcher, then a flush that pops the queue's
                // head into a CLI that never reads it. (The auto-mode
                // `supportedModels` check rejects there: nothing to run.)
                self.start_jsonl_watcher();
                self.flush_queue_if_idle(true);
                self.spawn_failed(message);
                return;
            }
        };

        // Input pump: the TS `inputQueue` AsyncIterable.
        if let Some(mut rx) = self.input_rx.lock().unwrap().take() {
            let h = handle.clone();
            let abort = self.abort.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        m = rx.recv() => match m {
                            Some(v) => if h.send_user_message(&v).await.is_err() { break },
                            None => break,
                        },
                        _ = abort.cancelled() => break,
                    }
                }
            });
        }

        let me = self.arc();
        tokio::spawn(async move { me.consume(messages).await });

        if self.permission_mode() == "auto" {
            let me = self.arc();
            tokio::spawn(async move {
                if let Ok(models) = handle.supported_models().await {
                    let m = me.effective_model();
                    me.leave_auto_if_model_unsupported(m.as_deref(), Some(&models))
                        .await;
                }
            });
        }
        // External writers (`claude --resume <id>` in a terminal) reach every
        // open tab without a manual refresh.
        self.start_jsonl_watcher();
        // `drainQueueOnStart` (CC 2.1.316): a head the user stopped behind
        // stays queued, as the replaced Session would have left it.
        self.spawn_drain_queue_on_start();
    }

    /// A CLI that can't be launched. The SDK spawns on its own and reports
    /// the failure on the stream, so TS has broadcast `ready` by then and
    /// consume() ends on the error: the same events as [`Self::consume`]'s
    /// end.
    fn spawn_failed(&self, message: String) {
        self.with(|st| {
            if !self.abort.is_cancelled() {
                // As on the stream's error (CC 2.1.311): the CLI is gone.
                st.broadcast(json!({"type": "error", "message": message, "sessionEnded": true}));
            }
            st.done = true;
            st.drain_pending_decisions("Aborted");
            st.turn_in_flight = false;
            st.broadcast_turn_status_if_changed();
        });
    }

    /// `startJsonlWatcher()` — watch the transcript's directory and resync
    /// (debounced, see [`jsonl_watch`]) when `<id>.jsonl` changes.
    ///
    /// Watches the directory the CLI writes the transcript to and
    /// [`Self::resync_from_disk`] reads it from,
    /// `<config>/projects/<sdk name>`. The TS app watches `projectRoot(cwd)`
    /// (`homedir()/.claude/projects/<encodeProjectDir(cwd)>`): the same
    /// directory, also through an account profile's symlinked `projects/`,
    /// except for cwds over 200 encoded chars (the SDK hashes the name) or a
    /// `CLAUDE_CONFIG_DIR` with its own `projects/`, where its watcher never
    /// fires.
    ///
    /// Best effort, like TS: if the directory doesn't exist yet the session
    /// runs without a watcher (subscribing still resyncs), and a watcher
    /// error stops it.
    fn start_jsonl_watcher(&self) {
        {
            let mut slot = self.jsonl_watcher.lock().unwrap();
            if !matches!(*slot, WatchSlot::Idle) {
                return;
            }
            *slot = WatchSlot::Starting;
        }
        let dir = paths::sdk_projects_dir().join(paths::sdk_project_dir_name(&self.cwd));
        let file_name = format!("{}.jsonl", self.id);
        let weak = self.weak.clone();
        let (fire_ref, error_ref) = (self.weak.clone(), self.weak.clone());
        let fire = move || Session::fire_jsonl_resync(&fire_ref);
        let on_error = move || {
            if let Some(s) = error_ref.upgrade() {
                s.stop_jsonl_watcher();
            }
        };
        // `FSEventStreamStart` can block for seconds (3-11 s measured on
        // macOS 27, for any path). libuv starts `fs.watch`'s stream on its own
        // thread, so TS `start()` never waits on it; neither does this. Events
        // before the stream is up are missed in both, and a subscribe resyncs
        // from disk anyway. A detached thread rather than `spawn_blocking`, so
        // a runtime shutting down doesn't wait for it either.
        let runtime = tokio::runtime::Handle::current();
        self.jsonl_watch_pending.fetch_add(1, Ordering::SeqCst);
        let started = std::thread::Builder::new()
            .name("jsonl-watch-start".into())
            .spawn(move || {
                let _rt = runtime.enter();
                let watch = jsonl_watch::watch(&dir, &file_name, fire, on_error);
                let Some(s) = weak.upgrade() else { return };
                {
                    let mut slot = s.jsonl_watcher.lock().unwrap();
                    // Stopped meanwhile (`end()`): this watch is dropped unused.
                    if matches!(*slot, WatchSlot::Starting) {
                        *slot = watch.map_or(WatchSlot::Idle, |w| WatchSlot::Running { _watch: w });
                    }
                }
                s.jsonl_watch_pending.fetch_sub(1, Ordering::SeqCst);
            });
        if started.is_err() {
            *self.jsonl_watcher.lock().unwrap() = WatchSlot::Idle;
            self.jsonl_watch_pending.fetch_sub(1, Ordering::SeqCst);
        }
    }

    /// The `scheduleJsonlResync` timer firing: resync, unless one is already
    /// running (then the timer re-arms) or the session is gone.
    fn fire_jsonl_resync(weak: &Weak<Session>) -> Fired {
        let Some(s) = weak.upgrade() else {
            return Fired::Gone;
        };
        if s.jsonl_resync_busy.load(Ordering::SeqCst) {
            return Fired::Busy;
        }
        // `void this.resyncFromDisk()`: it reads the file, so off the timer
        // task, which keeps coalescing events meanwhile.
        tokio::task::spawn_blocking(move || s.resync_from_disk());
        Fired::Started
    }

    /// `stopJsonlWatcher()` — close the watcher and drop a pending resync.
    fn stop_jsonl_watcher(&self) {
        let slot = std::mem::replace(&mut *self.jsonl_watcher.lock().unwrap(), WatchSlot::Idle);
        drop(slot);
    }

    /// Whether the JSONL watcher is running (not still starting).
    pub fn watching_jsonl(&self) -> bool {
        matches!(
            *self.jsonl_watcher.lock().unwrap(),
            WatchSlot::Running { .. }
        )
    }

    /// Waits until no watcher start is in flight (one that lost to `end()`
    /// included), then [`Self::watching_jsonl`].
    pub async fn wait_jsonl_watcher(&self) -> bool {
        while self.jsonl_watch_pending.load(Ordering::SeqCst) > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        self.watching_jsonl()
    }

    /// Replays `resume`'s transcript into the buffer and returns what it
    /// read (empty when there's none or it can't be read).
    fn replay_transcript(&self, resume: &str) -> Vec<Value> {
        // No transcript file yet → nothing to replay. The SDK's
        // `getSessionMessages` also returns [] for one it can't read (no
        // throw, so no TS error event), and decodes it lossily.
        let Some((file, _)) = sessions_store::find_file(resume, Some(&self.cwd)) else {
            return Vec::new();
        };
        let text = match transcript::read_file(&file) {
            Ok(t) => t,
            Err(e) => {
                tracing::debug!(target: log::SESSION, "[session] {}: transcript unreadable — {e}", self.id);
                return Vec::new();
            }
        };
        let mut historical = transcript::session_messages(&text, true);
        // `if (this.resumeAt)`: the SDK has no by-uuid cutoff, so slice the
        // replay to what the model sees; an unknown uuid keeps it whole.
        if let Some(at) = self.resume_at()
            && let Some(cut) = historical
                .iter()
                .position(|m| m.get("uuid").and_then(Value::as_str) == Some(at))
        {
            historical.truncate(cut + 1);
        }
        tracing::debug!(
            target: log::SESS_LOAD,
            id = %self.id,
            resumeFrom = resume,
            cwd = %self.cwd,
            count = historical.len(),
            "[sess-load] start.resume loaded historical"
        );
        let mut carried: Option<i64> = None;
        let loaded = historical.clone();
        self.with(|st| {
            for m in historical {
                // `Date.parse(ts)` (S27c).
                let parsed = m
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(crate::js_date::date_parse);
                let at = match parsed {
                    Some(p) => {
                        carried = Some(p);
                        Some(p)
                    }
                    None => carried.map(|c| {
                        carried = Some(c + 1);
                        c + 1
                    }),
                };
                // Disk-resident loops too, armed at their JSONL time.
                st.track_scheduled_loops(&m, at);
                let mut ev = json!({"type": "sdk", "message": m});
                if let Some(a) = at {
                    ev["at"] = json!(a);
                }
                st.broadcast(ev);
            }
        });
        loaded
    }

    fn build_options(&self, user_settings: &Map<String, Value>) -> Options {
        let o = &self.opts;
        let restricted = o.restricted_mode == Some(true);
        let goal_append = self.with(|st| goal_system_prompt_append(&st.goal));
        let combined = join_system_prompt_appends(&[
            goal_append.as_str(),
            o.system_prompt_append.as_deref().unwrap_or(""),
        ]);

        let mut opts = Options {
            cwd: Some(PathBuf::from(&self.cwd)),
            model: self.model(),
            env: Some(build_query_env(
                self.with(|st| st.account_env.clone())
                    .as_ref()
                    .or(o.runtime.env_override.as_ref()),
                restricted,
            )),
            path_to_claude_code_executable: o.runtime.claude_bin.clone(),
            agent: self.with(|st| st.truthy_agent().map(str::to_owned)),
            fallback_model: o.fallback_model.clone(),
            permission_mode: Some(self.permission_mode()),
            include_partial_messages: true,
            include_hook_events: true,
            per_task_stop_affordance: Some(true),
            forward_subagent_text: Some(true),
            agent_progress_summaries: Some(true),
            // `(promptSuggestionEnabled ?? promptSuggestions) !== false`
            prompt_suggestions: Some(
                user_settings
                    .get("promptSuggestionEnabled")
                    .filter(|v| !v.is_null())
                    .or_else(|| user_settings.get("promptSuggestions"))
                    .and_then(Value::as_bool)
                    != Some(false),
            ),
            allowed_tools: TODO_TASK_TOOL_NAMES.iter().map(|s| s.to_string()).collect(),
            thinking: Some(ThinkingConfig::Adaptive { display: None }),
            ..Default::default()
        };
        if !combined.is_empty() {
            opts.system_prompt = Some(SystemPrompt::Preset {
                append: Some(combined),
                exclude_dynamic_sections: None,
                snapshot: Some(false),
            });
        }
        if let Some(b) = o.max_budget_usd.filter(|b| *b > 0.0) {
            opts.max_budget_usd = Some(b);
        }
        if let Some(t) = o.task_budget_tokens.filter(|t| *t > 0.0) {
            opts.task_budget_total = Some(t);
        }
        if let Some(t) = o.max_turns.filter(|t| *t > 0.0) {
            opts.max_turns = Some(t);
        }
        opts.sandbox = create_options::sandbox(o);
        if o.enable_1m_context == Some(true) {
            opts.betas = vec!["context-1m-2025-08-07".into()];
        }
        if o.persist_session == Some(false) {
            opts.persist_session = Some(false);
        }
        if let Some(dirs) = o.additional_directories.as_ref().filter(|d| !d.is_empty()) {
            opts.additional_directories = dirs.iter().map(PathBuf::from).collect();
        }
        if let Some(p) = o
            .plan_mode_instructions
            .as_ref()
            .filter(|p| !js::trim(p).is_empty())
        {
            opts.plan_mode_instructions = Some(p.clone());
        }
        opts.project_config_root =
            crate::trusted_cwd::project_config_root_for(&self.cwd).map(PathBuf::from);
        if restricted {
            opts.disallowed_tools = RESTRICTED_MODE_DISALLOWED_TOOLS
                .iter()
                .map(|s| s.to_string())
                .collect();
        }
        // `settings` passthrough for the keys Claudius forwards.
        let mut fwd = Map::new();
        if let Some(v) = user_settings
            .get("includeCoAuthoredBy")
            .filter(|v| v.is_boolean())
        {
            fwd.insert("includeCoAuthoredBy".into(), v.clone());
        }
        if let Some(v) = user_settings.get("advisorModel").filter(|v| v.is_string()) {
            fwd.insert("advisorModel".into(), v.clone());
        }
        if let Some(v) = user_settings.get("workflowSizeGuideline").filter(|v| {
            matches!(
                v.as_str(),
                Some("unrestricted" | "small" | "medium" | "large")
            )
        }) {
            fwd.insert("workflowSizeGuideline".into(), v.clone());
        }
        if let Some(v) = user_settings
            .get("crossSessionInbound")
            .filter(|v| matches!(v.as_str(), Some("accept" | "hold" | "refuse")))
        {
            fwd.insert("crossSessionInbound".into(), v.clone());
        }
        if !fwd.is_empty() {
            opts.settings = Some(js::stringify(&Value::Object(fwd)));
        }
        opts.enable_file_checkpointing = true;
        opts.tool_config = Some(json!({"askUserQuestion": {"previewFormat": "html"}}));
        if let Some(r) = &o.resume {
            opts.resume = Some(r.clone());
        } else {
            opts.session_id = Some(self.id.clone());
        }
        opts.resume_session_at = self.resume_at().map(str::to_owned);

        let weak = self.weak.clone();
        opts.can_use_tool = Some(Arc::new(SessionPermissions(weak.clone())));
        opts.on_elicitation = Some(Arc::new(SessionPermissions(weak.clone())));
        opts.mcp_servers.insert(
            "claudius_goal".into(),
            McpServerConfig::Sdk(Arc::new(self.goal_mcp_server())),
        );
        opts.hooks = self.build_hooks();
        opts
    }

    fn goal_mcp_server(&self) -> ToolServer {
        let weak = self.weak.clone();
        ToolServer::new(
            "claudius_goal",
            "1.0.0",
            vec![ToolDef::new(
                "report_goal_achieved",
                "Report that the user's stated session goal has been fully accomplished. Only call this when the goal is genuinely complete — never for partial progress or intermediate steps. Calling it marks the goal as done in the UI.",
                // Exactly what zod emits for `{summary: z.string().describe(…)}`
                // (key order included): it goes out byte-for-byte in the
                // initialize manifest.
                json!({
                    "$schema": "http://json-schema.org/draft-07/schema#",
                    "type": "object",
                    "properties": {"summary": {"type": "string", "description": "One sentence summarizing what was accomplished."}},
                    "required": ["summary"]
                }),
                move |args: Value| {
                    let weak = weak.clone();
                    async move {
                        if let Some(s) = weak.upgrade() {
                            let summary = args
                                .get("summary")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                            s.mark_goal_achieved(&summary);
                        }
                        ToolOutput::text("Recorded: the session goal is marked achieved.")
                    }
                },
            )],
        )
        // SDK 0.3.248 per-server tool-call timeout (TS `timeout: 10_000`):
        // a stuck goal write can't hang a turn forever.
        .with_timeout(10_000)
    }

    fn build_hooks(&self) -> indexmap::IndexMap<String, Vec<HookMatcher>> {
        // Insertion order = TS `hooks` object order, so the CLI sees the
        // same `hook_<n>` ids the TS SDK would assign.
        let mut hooks = indexmap::IndexMap::new();
        let w = self.weak.clone();
        hooks.insert(
            "PreToolUse".into(),
            vec![HookMatcher::new(hook_fn(move |input: Value, _id| {
                let w = w.clone();
                async move {
                    let Some(s) = w.upgrade() else { return json!({"continue": true}) };
                    let tool = input.get("tool_name").and_then(Value::as_str).unwrap_or("");
                    let ti = input.get("tool_input");
                    // `file_path ?? notebook_path`: a `null` falls through too.
                    let target = ti
                        .and_then(|t| {
                            t.get("file_path")
                                .filter(|v| !v.is_null())
                                .or_else(|| t.get("notebook_path"))
                        })
                        .and_then(Value::as_str);
                    if let Some(t) = target
                        && ["Edit", "Write", "MultiEdit", "NotebookEdit"].contains(&tool)
                        && let Some(wt) = worktree_root_from_path(t)
                    {
                        s.broadcast_cwd(&wt);
                    }
                    match s.with(|st| st.mid_turn_reminders.take()) {
                        None => json!({"continue": true}),
                        Some(extra) => {
                            json!({"continue": true, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": extra}})
                        }
                    }
                }
            }))],
        );
        // The post-write snapshot behind the linter-modified-file reminder.
        let w = self.weak.clone();
        hooks.insert(
            "PostToolUse".into(),
            vec![HookMatcher::new(hook_fn(move |input: Value, _id| {
                let w = w.clone();
                async move {
                    if let Some(target) = crate::reminders::post_write_target(&input)
                        && let Some(hex) = crate::reminders::file_sha256_async(target).await
                        && let Some(s) = w.upgrade()
                    {
                        s.with(|st| st.post_write_snapshots.record(target, hex));
                    }
                    json!({"continue": true})
                }
            }))],
        );
        let w = self.weak.clone();
        hooks.insert(
            "CwdChanged".into(),
            vec![HookMatcher::new(hook_fn(move |input: Value, _id| {
                let w = w.clone();
                async move {
                    if let (Some(s), Some(cwd)) = (
                        w.upgrade(),
                        input
                            .get("new_cwd")
                            .and_then(Value::as_str)
                            .filter(|c| !c.is_empty()),
                    ) {
                        s.broadcast_cwd(cwd);
                    }
                    json!({"continue": true})
                }
            }))],
        );
        let w = self.weak.clone();
        hooks.insert(
            "PostModelSwitch".into(),
            vec![HookMatcher::new(hook_fn(move |input: Value, _id| {
                let w = w.clone();
                async move {
                    if let Some(s) = w.upgrade() {
                        s.on_post_model_switch(&input).await;
                    }
                    json!({"continue": true})
                }
            }))],
        );
        hooks
    }

    async fn on_post_model_switch(&self, input: &Value) {
        let source = input.get("source").and_then(Value::as_str).unwrap_or("");
        if !matches!(source, "auto" | "resume" | "sdk") {
            return;
        }
        let Some(to) = input
            .get("to_model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let current = self.model();
        if Some(to) == input.get("from_model").and_then(Value::as_str)
            || Some(to) == current.as_deref()
        {
            return;
        }
        self.with(|st| st.model = Some(to.to_owned()));
        let off = self.leave_auto_if_model_unsupported(Some(to), None).await;
        let mut ev = json!({"type": "model_changed", "model": to, "source": source});
        if let Some(o) = off {
            ev["autoModeOffFor"] = json!(o);
        }
        self.broadcast(ev);
        // The model moved without `set_model` (notably `resume`, where the
        // SDK resolves it from the transcript) — drop an incompatible advisor.
        self.enforce_advisor_model_compatibility(Some(to)).await;
        if source != "auto" {
            let title = self.title();
            let _ = sessions_db::upsert_session(&self.id, &self.cwd, Some(to), title.as_deref());
        }
    }

    /// `setEffort(level, keepUltracode, sessionOnly)`: the live override goes
    /// through `applyFlagSettings` (the flag layer, above user/project
    /// settings, below managed policy); unless it's "auto" (the writer can't
    /// delete) or session-only, the pick is also saved to user settings the
    /// way `/effort` saves it, so a resume keeps it. Levels pass through: the
    /// CLI validates them against the model. Errors are swallowed, like TS.
    pub async fn set_effort(&self, level: &str, keep_ultracode: bool, session_only: bool) {
        let Some(h) = self.handle() else {
            return;
        };
        let settings = effort::build_effort_flag_settings(level, keep_ultracode);
        let _ = h.apply_flag_settings(settings.clone()).await;
        if !settings["effortLevel"].is_null() && !session_only {
            let _ = h
                .update_settings(
                    "userSettings",
                    json!({"effortLevel": settings["effortLevel"]}),
                )
                .await;
        }
        // Report what the CLI settled on: "auto" resolves to the model
        // default or the saved level, and an explicit pick can be capped.
        self.refresh_applied_effort();
    }

    /// `clearTodos(reason)`: drop the to-do list — the user's Clear, or the
    /// stale / all-completed auto-clears. Always advances the cutoff,
    /// persists `todosClearedAt` (best effort) and broadcasts the empty
    /// snapshot, even when the list is already gone: a client may be
    /// showing a list it rebuilt from replayed tool uses. Only the
    /// automatic clears of a non-empty list announce themselves with
    /// `todos_auto_cleared`.
    pub fn clear_todos(&self, reason: TodosClearReason) {
        let at = now_ms();
        let prev_count = self.with(|st| {
            let prev = st.latest_todos.as_ref().map_or(0, Vec::len);
            st.latest_todos = None;
            st.latest_todos_at = at as f64;
            st.pending_task_creates.clear();
            st.turns_since_todo_write = 0;
            st.reset_todo_progress();
            st.todos_stale = false;
            st.tool_uses_since_todo_touch = 0;
            prev
        });
        let mut patch = Map::new();
        patch.insert("todosClearedAt".into(), json!(at));
        let _ = sessions_db::merge_session_state(&self.cwd, &self.id, patch);
        self.with(|st| {
            st.broadcast(json!({"type": "session_snapshot", "todos": [], "todosStale": false}));
            if reason != TodosClearReason::Manual && prev_count > 0 {
                st.broadcast(json!({"type": "todos_auto_cleared", "reason": reason.as_str(), "count": prev_count}));
            }
        });
        tracing::debug!(
            target: log::SESS_LOAD,
            id = %self.id,
            reason = reason.as_str(),
            prevCount = prev_count,
            "[sess-load] clearTodos"
        );
    }

    /// `updateTodoItem(itemId, action)`: the user marks one item done,
    /// reopened or active, or deletes it. Edits the list in place, bumps
    /// the cutoff (a racing older write can't undo it), records the
    /// override (persisted best effort, so a restart re-applies it over
    /// the replayed transcript) and repaints every tab. Errors: `"invalid
    /// item id"` (empty), `"no active todo list"` (none or empty), `"item
    /// not found"`.
    pub fn update_todo_item(
        &self,
        item_id: &str,
        action: TodoItemAction,
    ) -> Result<(), &'static str> {
        if item_id.is_empty() {
            return Err("invalid item id");
        }
        let at = now_ms();
        let status = action.override_status();
        self.with(|st| {
            let Some(list) = st.latest_todos.as_mut().filter(|l| !l.is_empty()) else {
                return Err("no active todo list");
            };
            if !list.iter().any(|t| todo_has_id(t, item_id)) {
                return Err("item not found");
            }
            if status == "deleted" {
                list.retain(|t| !todo_has_id(t, item_id));
            } else {
                for t in list.iter_mut().filter(|t| todo_has_id(t, item_id)) {
                    t["status"] = json!(status);
                }
            }
            st.latest_todos_at = at as f64;
            st.manual_todo_overrides.insert(item_id.to_owned(), status);
            st.persist_todo_overrides();
            let todos = st.latest_todos.clone().unwrap_or_default();
            let stale = st.todos_stale;
            st.broadcast(json!({"type": "session_snapshot", "todos": todos, "todosStale": stale}));
            Ok(())
        })
    }

    /// The user's live per-item overrides, in insertion order.
    pub fn manual_todo_overrides(&self) -> Vec<(String, &'static str)> {
        self.with(|st| {
            st.manual_todo_overrides
                .iter()
                .map(|(k, v)| (k.clone(), *v))
                .collect()
        })
    }

    /// `setAgent(name)`: switch the main-thread agent mid-session through
    /// `applyFlagSettings` (`null` resets to the default agent) and tell every
    /// tab. A no-op without a live query. A failed apply is swallowed: the
    /// name is still recorded and broadcast.
    pub async fn set_agent(&self, name: Option<&str>) {
        let Some(h) = self.handle() else {
            return;
        };
        let _ = h.apply_flag_settings(json!({"agent": name})).await;
        // `name ?? undefined`: only null clears it; "" is kept (and then
        // reads as no agent wherever it's spread).
        self.with(|st| st.agent = name.map(str::to_owned));
        self.broadcast(json!({"type": "agent_changed", "agent": name}));
    }

    /// `submitFeedback(description, surface = "claudius", attachTranscript =
    /// false)`: forward feedback to Anthropic through the CLI's undocumented
    /// `submit_feedback` control request, with `surface` and
    /// `attach_transcript` (the CLI then packages the transcript). Whether
    /// the CLI accepted it, and why not when it refused (its reply read by
    /// `interpretFeedbackResponse`); not forwarded, with no reason, without a
    /// query or when the request fails. The caller (`/api/feedback`, G10)
    /// keeps its own copy either way.
    pub async fn submit_feedback(
        &self,
        description: &str,
        surface: Option<&str>,
        attach_transcript: bool,
    ) -> crate::feedback_refusal::FeedbackForward {
        let Some(h) = self.handle() else {
            return Default::default();
        };
        let opts = claudius_agent::FeedbackOptions {
            surface: Some(
                surface
                    .unwrap_or(crate::feedback_survey::FEEDBACK_SURFACE)
                    .to_owned(),
            ),
            attach_transcript: Some(attach_transcript),
            ..Default::default()
        };
        match h.submit_feedback(description, &opts).await {
            Ok(res) => crate::feedback_refusal::interpret_feedback_response(&res),
            Err(_) => Default::default(),
        }
    }

    /// `maybeOfferFeedbackSurvey(message)` after every `result`: now and then,
    /// tell every tab to show the feedback nudge. The decision is in
    /// [`FeedbackSurvey::maybe_offer`](crate::feedback_survey::FeedbackSurvey::maybe_offer).
    /// TS broadcasts after an awaited settings read; here it's in place.
    fn maybe_offer_feedback_survey(&self, result: &Value) {
        let (saw_user_input, survey) =
            self.with(|st| (st.saw_user_input, st.feedback_survey.clone()));
        let survey = survey.unwrap_or_else(crate::feedback_survey::FeedbackSurvey::global);
        if survey.maybe_offer(result, saw_user_input, &self.cwd) {
            self.broadcast(crate::feedback_survey::feedback_survey_event(&self.id));
        }
    }

    /// Replace the process-wide feedback throttle and roll for this session
    /// (tests pin them).
    pub fn set_feedback_survey(&self, survey: Arc<crate::feedback_survey::FeedbackSurvey>) {
        self.with(|st| st.feedback_survey = Some(survey));
    }

    /// `setFast(enabled)`: fast mode (accelerated decoding on supported
    /// models) through `applyFlagSettings`. Orthogonal to effort, so the
    /// applied effort isn't refreshed. Not persisted: a resume starts with it
    /// off. Unsupported models are left to the CLI; errors are swallowed.
    pub async fn set_fast(&self, enabled: bool) {
        let Some(h) = self.handle() else {
            return;
        };
        let _ = h.apply_flag_settings(json!({"fastMode": enabled})).await;
    }

    /// `void this.setFast(false)` from `broadcast()` (CC 2.1.300): the
    /// engine retries a credits-refused fast request without fast but leaves
    /// the flag on, so every later request would be refused and re-sent.
    fn spawn_fast_off(&self) {
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let me = self.arc();
            rt.spawn(async move { me.set_fast(false).await });
        }
    }

    /// `setUltracode(enabled)`: ultracode (Dynamic Workflows: `xhigh` plus
    /// standing workflow orchestration) through `applyFlagSettings`. The CLI
    /// owns the preconditions (Workflows enabled, an `xhigh`-capable model).
    /// Not persisted. Refreshes the applied effort, which it can move.
    pub async fn set_ultracode(&self, enabled: bool) {
        let Some(h) = self.handle() else {
            return;
        };
        let _ = h.apply_flag_settings(json!({"ultracode": enabled})).await;
        self.refresh_applied_effort();
    }

    /// `setOutputStyle(name)`: live-apply through
    /// `updateSettings("localSettings", {outputStyle})` (best effort, and
    /// skipped without a CLI), then persist to the same file, the `local`
    /// scope (`.claude/settings.local.json`), so the two never disagree. A
    /// settings file that doesn't read or write is the error, as its message.
    pub async fn set_output_style(&self, name: &str) -> Result<String, String> {
        if let Some(h) = self.handle() {
            let _ = h
                .update_settings("localSettings", json!({"outputStyle": name}))
                .await;
        }
        // `{...current, outputStyle: name}`: an existing key keeps its place.
        let mut current =
            settings::read_settings(Scope::Local, &self.cwd).map_err(|e| e.to_string())?;
        current.insert("outputStyle".into(), json!(name));
        settings::write_settings(Scope::Local, &self.cwd, &current).map_err(|e| e.to_string())?;
        Ok(name.to_owned())
    }

    /// `void this.refreshAppliedEffort()`: read `applied.effort` from the
    /// CLI's `get_settings` and broadcast it as `effort_applied`, even when
    /// unchanged (the client clears its mirror on a pick and waits for this).
    /// Fire and forget; the sequence number is taken now, so of two quick
    /// refreshes only the later one's reply lands. A failed request, a stale
    /// reply or an unusable value leaves the state alone.
    fn refresh_applied_effort(&self) {
        let Some(h) = self.handle() else {
            return;
        };
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let seq = self.with(|st| {
            st.applied_effort_seq += 1;
            st.applied_effort_seq
        });
        let weak = self.weak.clone();
        rt.spawn(async move {
            let Ok(response) = h.get_settings().await else {
                return;
            };
            let Some(s) = weak.upgrade() else {
                return;
            };
            s.with(|st| {
                if st.applied_effort_seq != seq {
                    return;
                }
                let Some(effort) = effort::parse_applied_effort(&response) else {
                    return;
                };
                st.applied_effort = Some(effort.clone());
                st.broadcast(json!({"type": "effort_applied", "effort": effort}));
            });
        });
    }

    fn broadcast_cwd(&self, cwd: &str) {
        self.with(|st| st.broadcast_cwd(cwd));
    }

    // ────────────────────────────── consume ──────────────────────────────

    async fn consume(
        self: Arc<Self>,
        mut messages: mpsc::UnboundedReceiver<Result<Value, claudius_agent::AgentError>>,
    ) {
        let mut saw_error = false;
        let mut saw_result = false;
        while let Some(item) = messages.recv().await {
            match item {
                Ok(msg) => {
                    saw_result |= msg.get("type").and_then(Value::as_str) == Some("result");
                    self.on_message(msg).await
                }
                Err(e) => {
                    if !self.abort.is_cancelled() {
                        let message = e.to_string();
                        // CC 2.1.311 — the stream ended, so the CLI is gone
                        // (`done` follows below). The flag tells the client to
                        // send a message to restart it instead of leaving a
                        // bare "process exited" line.
                        self.broadcast(
                            json!({"type": "error", "message": message, "sessionEnded": true}),
                        );
                        saw_error = true;
                        // A thrown 529 / 401 counts like the synthetic message.
                        self.with(|st| {
                            for ev in st.nudges.observe_thrown(&message, st.model.as_deref()) {
                                st.broadcast(ev);
                            }
                        });
                    }
                    break;
                }
            }
        }
        self.with(|st| {
            st.done = true;
            st.drain_pending_decisions("Aborted");
            st.turn_in_flight = false;
            st.broadcast_turn_status_if_changed();
            // The synthetic `session_idle`: no `result`, no error, no abort.
            if !saw_result && !saw_error && !self.abort.is_cancelled() {
                st.bus.synthetic_idle(st.subs.len(), st.title.as_deref());
            }
        });
    }

    async fn on_message(&self, msg: Value) {
        let mtype = msg
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let subtype = msg
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        // `/model <id>` typed in chat: the CLI echoes "Set model to <id>".
        let chat_model = (mtype == "system" && subtype == "local_command_output")
            .then(|| crate::session_consume::set_model_target(msg.get("content")))
            .flatten();
        let result_msg = (mtype == "result").then(|| msg.clone());
        // The loop tracker and the Read-path tracking read the message on
        // their own (TS runs them right after the broadcast); here first, so
        // the message can move.
        let read_paths = crate::read_paths::extract_read_paths(&msg);
        let thinking_replay_error =
            crate::thinking_replay::thinking_replay_error_from(&msg).is_some();
        let nudge_signals = crate::detectors::Observed::of(&msg);
        let rate_limit_hit = crate::account_pinning::is_rate_limit_hit_sdk_message(&msg);
        self.with(|st| {
            st.track_scheduled_loops(&msg, None);
            st.recent_read_paths.extend(read_paths);
        });
        // A live `system/init` runs its hooks inside the broadcast (S28a).
        self.broadcast(json!({"type": "sdk", "message": msg}));
        // The thinking-block replay 400 arrives as a synthetic assistant
        // "API Error: …" message, then the turn ends with the poisoned turn
        // still at the tail: rewind past it (at most once per query).
        if thinking_replay_error {
            self.schedule_thinking_replay_recovery();
        }
        // The Opus overload, long-context credits and auth-failed nudges.
        let enable_1m = self.opts.enable_1m_context == Some(true);
        self.with(|st| {
            for ev in st
                .nudges
                .observe(nudge_signals, st.model.as_deref(), enable_1m)
            {
                st.broadcast(ev);
            }
        });
        if rate_limit_hit {
            self.note_account_auto_rotate_observation();
        }
        // B2.3: compaction strips the CLI's readFileState cache. Re-seed it
        // off the consume loop, which must keep draining.
        if mtype == "system" && subtype == "compact_boundary" {
            let me = self.arc();
            tokio::spawn(async move { me.reseed_read_paths_after_compact().await });
        }
        if let Some(new_model) = chat_model
            && self.model().as_deref() != Some(new_model.as_str())
        {
            self.with(|st| st.model = Some(new_model.clone()));
            let off = self
                .leave_auto_if_model_unsupported(Some(&new_model), None)
                .await;
            let mut ev =
                json!({"type": "model_changed", "model": new_model, "source": "chat_command"});
            if let Some(o) = off {
                ev["autoModeOffFor"] = json!(o);
            }
            self.broadcast(ev);
            let title = self.title();
            let _ = sessions_db::upsert_session(
                &self.id,
                &self.cwd,
                Some(&new_model),
                title.as_deref(),
            );
            settings::persist_model_to_user_settings(&self.cwd, Some(&new_model));
        }

        if let Some(result) = result_msg {
            // CC 2.1.309 — the turn's transcript now exists; land a rename
            // that couldn't reach it earlier (fire and forget).
            {
                let me = self.arc();
                tokio::spawn(async move { me.flush_pending_title_mirror().await });
            }
            // The turn boundary is the mid-session MCP poll point
            // (`recheckMcpStatusMidSession`, throttled).
            crate::mcp_notices::recheck_mid_session(self.arc());
            let (totals, todo_clear) = self.with(|st| {
                st.turn_in_flight = false;
                st.broadcast_turn_status_if_changed();
                let totals = self.fold_usage(st, &result);
                let next = crate::session_consume::queued_turns(result.get("queued_turn_count"));
                if next != st.sdk_queued_turns {
                    st.sdk_queued_turns = next;
                    let ev = st.queue_event(&self.id);
                    st.broadcast(ev);
                }
                if st.plan_awaiting_verify {
                    st.plan_awaiting_verify = false;
                    st.queue_reminder(verify_plan_reminder_body());
                }
                // `maybeAutoSyncTodosOnTurnEnd`, under the lock that ends
                // the turn: TS runs it before serving anything else, so a
                // prompt sent on the idle can't miss its `todos-current`.
                let todo_clear = (subtype == "success")
                    .then(|| st.todos_turn_end())
                    .flatten();
                (totals, todo_clear)
            });
            if let Some(t) = totals {
                let _ = sessions_db::save_session_usage(&self.cwd, &self.id, &t);
            }
            // `touchSession`: the sessions index sorts newest-active first.
            let _ = sessions_db::touch_session(&self.cwd, &self.id);
            self.maybe_offer_feedback_survey(&result);
            if subtype == "success" {
                // A successful turn clears the consecutive-recovery budget.
                self.manager().note_thinking_recovery_success(&self.id);
                self.spawn_plan_usage();
                // Its clear, before the drain so a drained queued turn
                // carries its `todos-current` reminder.
                if let Some(reason) = todo_clear {
                    self.clear_todos(reason);
                }
                self.spawn_drain_queue_after_success();
            }
        }
    }

    /// After a successful turn: `get_usage` (behaviors skipped) becomes
    /// `plan_usage`, or `plan_usage_unavailable` when it fails. Fire and
    /// forget, like the TS IIFE.
    fn spawn_plan_usage(&self) {
        let Some(h) = self.handle() else {
            return;
        };
        let weak = self.weak.clone();
        tokio::spawn(async move {
            let ev = match h.get_usage(true).await {
                Ok(usage) => crate::session_consume::plan_usage_event(&usage, now_ms()),
                Err(_) => Some(json!({"type": "plan_usage_unavailable"})),
            };
            if let (Some(ev), Some(s)) = (ev, weak.upgrade()) {
                s.broadcast(ev);
            }
        });
    }

    /// `foldUsageFromResult` (under the lock) → totals to persist.
    fn fold_usage(&self, st: &mut State, result: &Value) -> Option<UsageTotals> {
        let (totals, last) =
            sessions_db::fold_result_into_usage(&st.usage_totals, &st.sdk_last_cumulative, result)?;
        st.usage_totals = totals;
        st.sdk_last_cumulative = last;
        let totals = st.usage_totals();
        st.broadcast(json!({"type": "usage_snapshot", "usage": totals.to_json()}));
        Some(totals)
    }

    // ───────────────────────────── subscribe ─────────────────────────────

    /// `subscribe(fn, {tail, tabId})`.
    pub fn subscribe(&self, tail: Option<usize>, tab_id: Option<String>) -> Subscription {
        self.subscribe_with(tail, tab_id, &[])
    }

    /// `resumedTranscriptPath()`: for a resumed session, the engine
    /// transcript holding the turns from before its last compaction, home
    /// shortened to `~`. Display only; the stream route echoes it on its
    /// trailing `ready` (CC 2.1.301).
    pub fn resumed_transcript_path(&self) -> Option<String> {
        self.with(|st| st.resumed_transcript_path())
    }

    /// `subscribe` plus events delivered right after the synchronous replay
    /// and before the async extras (the stream route's trailing `ready`).
    pub fn subscribe_with(
        &self,
        tail: Option<usize>,
        tab_id: Option<String>,
        post_sync: &[Value],
    ) -> Subscription {
        let (tx, rx) = mpsc::unbounded_channel::<Value>();
        let (sub_id, count) = self.with(|st| {
            let (events, start_idx, more) = select_replay_window(&st.buffer, tail);
            let has_more = more || st.buffer_trimmed;
            tracing::debug!(
                target: log::SESS_LOAD,
                id = %self.id,
                tail = ?tail,
                bufferLen = st.buffer.len(),
                startIdx = start_idx,
                replayLen = events.len(),
                hasMoreAbove = has_more,
                priorSubscribers = st.subs.len(),
                "[sess-load] subscribe"
            );
            for ev in events {
                if !REPLAY_SKIP_TYPES.contains(&ev_type(&ev)) {
                    let _ = tx.send(ev);
                }
            }
            let _ = tx.send(json!({"type": "replay_done", "hasMoreAbove": has_more}));
            // Authoritative whenever the session has seen any to-do
            // activity (a finite cutoff): after a clear that's an explicit
            // `[]`, overriding the list a client rebuilt from replayed
            // tool uses the cutoff bounced server-side.
            let no_todos = Vec::new();
            let todos = st
                .latest_todos_at
                .is_finite()
                .then(|| (st.latest_todos.as_ref().unwrap_or(&no_todos), st.todos_stale));
            if let Some(snap) = build_session_snapshot(todos, st.latest_user_prompt.as_ref(), st.latest_init.as_ref()) {
                let _ = tx.send(snap);
            }
            if st.has_query {
                let mut ready = self.ready_event(st);
                if let Some(p) = st.resumed_transcript_path() {
                    ready["transcriptPath"] = json!(p);
                }
                let _ = tx.send(ready);
            }
            let _ = tx.send(json!({"type": "mode_changed", "mode": st.permission_mode}));
            if let Some(m) = st.model.clone().or_else(|| st.sdk_model.clone()) {
                let _ = tx.send(json!({"type": "model_changed", "model": m, "source": "sdk"}));
            }
            if let Some(e) = &st.applied_effort {
                let _ = tx.send(json!({"type": "effort_applied", "effort": e}));
            }
            let _ = tx.send(json!({"type": "turn_status", "status": st.status().as_str(), "backgroundTasks": st.background_tasks()}));
            let _ = tx.send(json!({"type": "usage_snapshot", "usage": st.usage_totals().to_json()}));
            let _ = tx.send(json!({"type": "tips", "tips": st.tips}));
            if let Some(c) = &st.last_cwd_broadcast {
                let _ = tx.send(json!({"type": "cwd_changed", "cwd": c}));
            }
            if st.goal.goal.is_some() {
                let _ = tx.send(sessions_db::goal_event(&st.goal));
            }
            for ev in st.pending_prompt_events() {
                let _ = tx.send(ev);
            }
            st.next_sub_id += 1;
            let id = st.next_sub_id;
            st.subs.push(Sub { id, tx: tx.clone() });
            if let Some(tab) = &tab_id {
                if st.holder_id.is_none() {
                    st.holder_id = Some(tab.clone());
                    st.announce_holder();
                } else {
                    let _ = tx.send(json!({"type": "holder_changed", "holderId": st.holder_id}));
                }
            }
            for ev in post_sync {
                let _ = tx.send(ev.clone());
            }
            (id, st.subs.len())
        });
        self.sub_count.send_replace(count);

        // sendFreshTitle / sendTaskSnapshot / sendQueueSnapshot.
        let me = self.arc();
        tokio::spawn(async move {
            me.send_fresh_title(sub_id, &tx);
            me.send_task_snapshot(sub_id, &tx);
            me.send_queue_snapshot(sub_id, &tx);
        });
        Subscription {
            session: self.arc(),
            id: sub_id,
            tab_id,
            rx,
        }
    }

    fn still_subscribed(&self, sub_id: u64) -> bool {
        self.with(|st| st.subs.iter().any(|s| s.id == sub_id))
    }

    fn send_fresh_title(&self, sub_id: u64, tx: &mpsc::UnboundedSender<Value>) {
        match session_titles::fresh_title(&self.cwd, &self.id, self.title().as_deref()) {
            FreshTitle::Moved(n) => {
                self.with(|st| {
                    st.title = Some(n.clone());
                    st.broadcast(json!({"type": "session_title", "title": n}));
                });
                let model = self.model();
                let _ =
                    sessions_db::upsert_session(&self.id, &self.cwd, model.as_deref(), Some(&n));
            }
            FreshTitle::Echo(t) if self.still_subscribed(sub_id) => {
                let _ = tx.send(json!({"type": "session_title", "title": t}));
            }
            FreshTitle::Echo(_) | FreshTitle::Quiet => {}
        }
    }

    /// `sendTaskSnapshot`: the persisted tasks (counters, status, subagent
    /// conversations), which a session rebuilt from disk can't replay from
    /// its buffer. Nothing stored: nothing sent.
    fn send_task_snapshot(&self, sub_id: u64, tx: &mpsc::UnboundedSender<Value>) {
        let tasks = session_tasks_db::list_session_tasks(&self.cwd, &self.id);
        if tasks.is_empty() || !self.still_subscribed(sub_id) {
            return;
        }
        let tasks: Vec<Value> = tasks.iter().map(TaskEntry::to_json).collect();
        let _ = tx.send(json!({"type": "task_snapshot", "tasks": tasks}));
    }

    fn load_queue_if_needed(&self) {
        if self.with(|st| st.queue_loaded) {
            return;
        }
        let rows = queue_db::list_queue(&self.cwd, &self.id);
        self.with(|st| {
            if !st.queue_loaded {
                st.queue = rows;
                st.queue_loaded = true;
            }
        });
    }

    fn refresh_queue_cache(&self) {
        let rows = queue_db::list_queue(&self.cwd, &self.id);
        self.with(|st| {
            st.queue = rows;
            st.queue_loaded = true;
        });
    }

    fn send_queue_snapshot(&self, sub_id: u64, tx: &mpsc::UnboundedSender<Value>) {
        self.load_queue_if_needed();
        let ev = self.with(|st| {
            (!st.queue.is_empty() || st.sdk_queued_turns > 0.0).then(|| st.queue_event(&self.id))
        });
        if let Some(ev) = ev
            && self.still_subscribed(sub_id)
        {
            let _ = tx.send(ev);
        }
    }

    fn broadcast_queue(&self) {
        self.with(|st| {
            let ev = st.queue_event(&self.id);
            st.broadcast(ev);
        });
    }

    // ────────────────────────────── input ────────────────────────────────

    /// `sendInput(text, images?, opts?)`.
    pub fn send_input(&self, text: &str, images: &[ImageInput], opts: SendOptions) {
        let _ = self.send_input_value(&json!(text), input::image_values(images).as_ref(), opts);
    }

    /// `sendInput` with `text` and `images` as the route's body holds them.
    /// `Err` is the TypeError TS throws, after the turn was marked running.
    pub fn send_input_value(
        &self,
        text: &Value,
        images: Option<&Value>,
        opts: SendOptions,
    ) -> Result<(), String> {
        let uuid = input::uuid_or_new(opts.uuid.clone());
        let queued = self.with(|st| -> Result<Option<Value>, String> {
            if st.done {
                return Ok(None);
            }
            let was_mid_turn = st.turn_in_flight;
            st.bus.mark_user_input();
            st.saw_user_input = true;
            st.turn_in_flight = true;
            st.broadcast_turn_status_if_changed();
            // A recap of a conversation that's about to move would mislead.
            if let Some(recap) = st.recap_abort.take() {
                recap.cancel();
            }
            if opts.slash {
                let text = input::text_str(text, "trim")?;
                let (command, args) = input::slash_parts(text);
                st.broadcast(json!({"type": "sdk", "message": {
                    "type": "system", "subtype": "slash_invoked", "command": command, "args": args,
                    "session_id": self.id, "uuid": uuid,
                }}));
                return Ok(Some(json!({
                    "type": "user",
                    "message": {"role": "user", "content": text},
                    "parent_tool_use_id": null,
                    "session_id": self.id,
                    "uuid": uuid,
                })));
            }
            let today = local_date_key();
            match &st.last_seen_local_date {
                None => st.last_seen_local_date = Some(today),
                Some(prev) if *prev != today => {
                    let now = chrono::Local::now().date_naive();
                    if let Some(b) = crate::reminders::date_change_reminder_body(prev, now) {
                        st.queue_reminder(&b);
                    }
                    st.last_seen_local_date = Some(today);
                }
                _ => {}
            }
            let text = input::text_str(text, "toLowerCase")?;
            if let Some(b) = ultrathink_reminder_body(text, &opts.inline_pastes) {
                st.queue_reminder(b);
            }
            if was_mid_turn {
                st.queue_reminder(midturn_inject_reminder_body());
            }
            // `flushLinterModifiedReminder`: files rewritten since the
            // model's last write to them.
            if let Some(b) = st.post_write_snapshots.flush() {
                st.queue_reminder(&b);
            }
            // The stale-TodoWrite nudge: every `STALE_TODO_TURN_THRESHOLD`
            // silent turns, and only about a list that exists.
            st.turns_since_todo_write += 1;
            if st.turns_since_todo_write >= todos::STALE_TODO_TURN_THRESHOLD {
                if let Some(list) = st.latest_todos.as_ref().filter(|l| !l.is_empty()) {
                    let body = todos::stale_todo_reminder_body(list);
                    st.queue_reminder(&body);
                }
                st.turns_since_todo_write = 0;
            }
            // Rearm the mid-turn counters for the coming turn.
            st.tool_uses_since_todo_touch = 0;
            st.fired_mid_turn_todo_reminder_this_turn = false;

            let (display_content, model_content) = match input::image_content(text, images)? {
                None => (json!(text), None),
                Some(blocks) => (Value::Array(blocks), Some(())),
            };
            st.broadcast(json!({"type": "sdk", "message": {
                "type": "user",
                "message": {"role": "user", "content": display_content},
                "parent_tool_use_id": null,
                "session_id": self.id,
                "uuid": uuid,
            }}));
            // `!` output first (past turns the user already saw), then the
            // goal and the reminders, closest to "now".
            let prefix = format!(
                "{}{}{}",
                st.take_bash_blocks(),
                st.take_goal_reminder(),
                st.take_reminders()
            );
            let content = match (model_content, prefix.is_empty()) {
                (None, true) => json!(text),
                (None, false) => json!(format!("{prefix}{text}")),
                (Some(()), true) => display_content,
                (Some(()), false) => {
                    let mut blocks = vec![json!({"type": "text", "text": prefix})];
                    blocks.extend(display_content.as_array().cloned().unwrap_or_default());
                    Value::Array(blocks)
                }
            };
            let mut msg = json!({
                "type": "user",
                "message": {"role": "user", "content": content},
                "parent_tool_use_id": null,
                "session_id": self.id,
                "uuid": uuid,
            });
            if opts.priority_now {
                msg["priority"] = json!("now");
                msg["origin"] = json!({"kind": "human"});
            }
            if !opts.inline_pastes.is_empty() {
                msg["inline_pastes"] = json!(opts.inline_pastes);
            }
            Ok(Some(msg))
        })?;
        if let Some(m) = queued {
            let _ = self.input_tx.send(m);
        }
        Ok(())
    }

    /// `enqueueMessage`: `text` and `uuid` of any JS type (S29a).
    pub fn enqueue_message(
        &self,
        text: &Value,
        images: Option<&Value>,
        uuid: Option<Value>,
        slash: bool,
        from_suggestion: bool,
        from_goal: bool,
    ) -> anyhow::Result<Value> {
        self.load_queue_if_needed();
        let uuid = input::uuid_or_new(uuid);
        let row = queue_db::enqueue_tail(
            &self.cwd,
            NewQueued {
                session_id: &self.id,
                uuid: uuid.clone(),
                text: text.clone(),
                images,
                slash,
                from_suggestion,
                from_goal,
            },
        )?;
        self.with(|st| st.queue.push(row));
        self.broadcast_queue();
        Ok(uuid)
    }

    pub fn remove_queued(&self, uuid: &str) -> anyhow::Result<bool> {
        self.load_queue_if_needed();
        let ok = queue_db::remove_by_uuid(&self.cwd, &self.id, uuid)?;
        if ok {
            self.with(|st| st.queue.retain(|r| r.uuid != uuid));
            self.broadcast_queue();
        }
        Ok(ok)
    }

    pub fn edit_queued(
        &self,
        uuid: &str,
        text: Option<&str>,
        images: Option<Option<&[ImageInput]>>,
    ) -> anyhow::Result<bool> {
        self.load_queue_if_needed();
        let ok = queue_db::update_by_uuid(&self.cwd, &self.id, uuid, text, images)?;
        if ok {
            self.refresh_queue_cache();
            self.broadcast_queue();
        }
        Ok(ok)
    }

    pub fn move_queued(&self, uuid: &str, up: bool) -> anyhow::Result<bool> {
        self.load_queue_if_needed();
        let ok = queue_db::move_by_uuid(&self.cwd, &self.id, uuid, up)?;
        if ok {
            self.refresh_queue_cache();
            self.broadcast_queue();
        }
        Ok(ok)
    }

    /// `sendQueuedNow`: `uuid` as a queue snapshot holds it (S29a).
    pub fn send_queued_now(&self, uuid: &Value, priority_now: bool) -> anyhow::Result<bool> {
        // CC 2.1.311 — `send_input` drops input once the CLI has ended, so a
        // dead session leaves the row queued for its restart to drain.
        if self.with(|st| st.done) {
            return Ok(false);
        }
        self.load_queue_if_needed();
        let Some(row) = queue_db::pop_by_uuid(&self.cwd, &self.id, uuid)? else {
            return Ok(false);
        };
        self.with(|st| st.queue.retain(|r| r.uuid != row.uuid));
        self.broadcast_queue();
        self.send_input_value(
            &row.text,
            row.images.map(Value::Array).as_ref(),
            SendOptions {
                uuid: Some(row.uuid),
                slash: row.slash,
                priority_now,
                ..Default::default()
            },
        )
        .map_err(anyhow::Error::msg)?;
        Ok(true)
    }

    pub fn queue_length(&self) -> usize {
        self.load_queue_if_needed();
        self.with(|st| st.queue.len())
    }

    pub fn queue_snapshot(&self) -> Vec<Value> {
        self.load_queue_if_needed();
        self.with(|st| st.queue.iter().map(QueuedRow::meta).collect())
    }

    fn spawn_flush_queue(&self) {
        let me = self.arc();
        tokio::spawn(async move { me.flush_queue_if_idle(false) });
    }

    /// `drainQueueOnStart`: the drain at the end of `start()`, which leaves
    /// a head held by a Stop (`unlessHeld`, CC 2.1.316).
    fn spawn_drain_queue_on_start(&self) {
        let me = self.arc();
        tokio::spawn(async move { me.flush_queue_if_idle(true) });
    }

    /// `drainQueueAfterSuccess`: a successful turn ends any Stop hold
    /// ([`Self::release_queue_holds`]), then drains as a Session that was
    /// never replaced does.
    fn spawn_drain_queue_after_success(&self) {
        let me = self.arc();
        tokio::spawn(async move {
            me.release_queue_holds();
            me.flush_queue_if_idle(false);
        });
    }

    /// `releaseQueueHolds` (CC 2.1.316): clear the Stop hold on this
    /// session's queue, only right before the success drain. The cache
    /// mirrors the DB's flag, so nothing is written when nothing is held,
    /// and a failed write leaves the cache held like the DB.
    fn release_queue_holds(&self) {
        self.load_queue_if_needed();
        if !self.with(|st| st.queue.iter().any(|r| r.held_by_stop)) {
            return;
        }
        if queue_db::release_holds(&self.cwd, &self.id).is_err() {
            return;
        }
        self.with(|st| st.queue.iter_mut().for_each(|r| r.held_by_stop = false));
    }

    /// `reseedReadPathsAfterCompact` (B2.3): replay every Read path through
    /// `seed_read_state(path, floored mtime)`. Best effort per path: a stat
    /// failure (deleted, no permission) or a refused or failed seed skips it,
    /// and so does a missing query (TS returns early, or throws per path).
    async fn reseed_read_paths_after_compact(&self) {
        // An index walk over the live set: a path Read mid-pass is still
        // visited, as iterating a JS `Set` would.
        let mut i = 0;
        while let Some(path) = self.with(|st| st.recent_read_paths.get_index(i).cloned()) {
            i += 1;
            let Ok(modified) = tokio::fs::metadata(&path).await.and_then(|m| m.modified()) else {
                continue;
            };
            let mtime = crate::read_paths::floored_mtime_ms(modified);
            if let Some(h) = self.handle() {
                let _ = h.seed_read_state(&path, mtime).await;
            }
        }
    }

    // ───────────────── thinking-block replay recovery ─────────────────

    /// `scheduleThinkingReplayRecovery`: once per query lifetime, announce
    /// the recovery and run it off the consume loop, which must unwind
    /// before the session is torn down.
    fn schedule_thinking_replay_recovery(&self) {
        if self.with(|st| std::mem::replace(&mut st.thinking_replay_recovery_scheduled, true)) {
            return;
        }
        self.broadcast(json!({"type": "error", "message":
            "Thinking-block replay error (HTTP 400) \u{2014} auto-recovering: rewinding past the failed turn and retrying."}));
        let me = self.arc();
        tokio::spawn(async move { me.run_thinking_replay_recovery().await });
    }

    /// `runThinkingReplayRecovery`: plan the rewind from the transcript on
    /// disk, then rebuild this session under its id, resumed at the plan's
    /// boundary, and re-send the prompt. Every failure becomes an `error`
    /// event; nothing is retried here.
    async fn run_thinking_replay_recovery(&self) {
        use crate::session_manager::RecoverError;
        let messages = self.transcript_messages(&self.id, false);
        let Some(plan) = crate::thinking_replay::plan_thinking_replay_recovery(&messages) else {
            self.broadcast(json!({"type": "error", "message":
                "Could not auto-recover from the thinking-block error (no safe rewind point). Start a new session, or fork before the failing turn."}));
            return;
        };
        let message = match self
            .manager()
            .recover_in_place(&self.id, &plan.resume_at, &plan.replay_prompt)
            .await
        {
            Ok(()) => return,
            Err(RecoverError::MaxAttempts) => "Auto-recovery gave up after repeated thinking-block failures on the same turn \u{2014} please start a new session.".to_owned(),
            Err(RecoverError::Gone) => "Auto-recovery could not rebuild the session (gone).".to_owned(),
            Err(RecoverError::Create(e)) => format!("Auto-recovery failed: {e}"),
        };
        self.broadcast(json!({"type": "error", "message": message}));
    }

    /// `getSessionMessages(id, { dir: cwd, includeSystemMessages })`:
    /// nothing without a transcript file, or for one it can't read (the
    /// SDK's read catches, so no rewind point rather than a failure).
    fn transcript_messages(&self, id: &str, include_system: bool) -> Vec<Value> {
        let Some((file, _)) = sessions_store::find_file(id, Some(&self.cwd)) else {
            return Vec::new();
        };
        let Ok(text) = transcript::read_file(&file) else {
            return Vec::new();
        };
        transcript::session_messages(&text, include_system)
    }

    /// `flushQueueIfIdle(opts)`. `unless_held` is `opts.unlessHeld`, the
    /// `start()` drain's (CC 2.1.316): a head held by a Stop stays queued.
    pub fn flush_queue_if_idle(&self, unless_held: bool) {
        // CC 2.1.318: a session scheduled for thinking-replay recovery is
        // about to be rebuilt with the failed prompt re-sent; the queue
        // waits for the rebuilt session.
        if self.with(|st| {
            st.done || st.thinking_replay_recovery_scheduled || st.status() != TurnStatus::Idle
        }) {
            return;
        }
        if self.draining.swap(true, Ordering::AcqRel) {
            return;
        }
        let _guard = scopeguard(|| self.draining.store(false, Ordering::Release));
        self.load_queue_if_needed();
        if self.with(|st| st.queue.is_empty() || st.status() != TurnStatus::Idle) {
            return;
        }
        let Ok(Some(head)) = queue_db::pop_head(&self.cwd, &self.id, unless_held) else {
            return;
        };
        self.with(|st| st.queue.retain(|r| r.uuid != head.uuid));
        self.broadcast_queue();
        let sent = self.send_input_value(
            &head.text,
            head.images.map(Value::Array).as_ref(),
            SendOptions {
                uuid: Some(head.uuid),
                slash: head.slash,
                ..Default::default()
            },
        );
        if let Err(e) = sent {
            tracing::warn!(target: log::API, id = %self.id, "[queue] flushQueueIfIdle: {e}");
        }
    }

    // ─────────────────────────── permissions ─────────────────────────────

    async fn can_use_tool(
        &self,
        tool_name: &str,
        input: Value,
        ctx: ToolPermissionContext,
    ) -> PermissionResult {
        let request_id = uuid::Uuid::new_v4().to_string();
        if tool_name.starts_with("mcp__claudius_goal__") {
            return PermissionResult::allow(input);
        }
        if let Some(kind) = prompt_events::budget_kind(tool_name) {
            let limits = *self.tool_budget_limits.lock().unwrap();
            let env = std::env::var_os(prompt_events::BUDGET_ENV[kind]);
            let cap = prompt_events::resolve_cap(
                limits[kind],
                env.as_deref().map(|e| e.to_string_lossy()).as_deref(),
            );
            let denied = self.with(|st| {
                let denied = prompt_events::budget_denial(kind, cap, st.tool_budget_used[kind]);
                if denied.is_none() {
                    st.tool_budget_used[kind] += 1;
                }
                denied
            });
            if let Some(msg) = denied {
                return PermissionResult::deny(msg);
            }
        }

        // CC 2.1.309: a dangerous rm/rmdir safety check in Bypass
        // permissions mode is denied at once with a rewrite hint instead of
        // parking a card, so an unattended session keeps going. Decided on
        // the session's mode: `ctx` doesn't carry a subagent's own.
        if let Some(msg) = crate::dangerous_rm_deny::bypass_dangerous_rm_denial(
            &self.permission_mode(),
            ctx.decision_reason.as_deref(),
            ctx.decision_reason_type.as_deref(),
            ctx.matched_ask_rule.is_some(),
        ) {
            return PermissionResult::deny(msg);
        }

        // The request's own `tool_use_id`, any type; `None` drops the key.
        let tool_use_id = prompt_events::tool_use_id(&ctx.raw);
        let (tx, rx) = oneshot::channel::<PermissionResult>();
        #[derive(Clone, Copy, PartialEq)]
        enum Kind {
            Plan,
            Ask,
            Perm,
        }
        let questions = if tool_name == "AskUserQuestion" {
            events::parse_ask_questions(&input)
        } else {
            vec![]
        };
        let kind = if tool_name == "ExitPlanMode" {
            Kind::Plan
        } else if !questions.is_empty() {
            Kind::Ask
        } else {
            Kind::Perm
        };
        // CC 2.1.310 — show where a symlinked file leads. The engine
        // resolves it for its own terminal card but doesn't forward it
        // through `canUseTool`, so resolve it here before the card goes out.
        // Only the file tools pay the hop; everything else parks as before.
        // Aborted during the lookup: settle here rather than park a card
        // nobody can answer.
        let symlink = if kind == Kind::Perm
            && crate::permission_symlink::permission_file_path(tool_name, &input).is_some()
        {
            let (tool, inp, cwd) = (tool_name.to_owned(), input.clone(), self.cwd.clone());
            let dirs = self.opts.additional_directories.clone().unwrap_or_default();
            let found = tokio::task::spawn_blocking(move || {
                crate::permission_symlink::resolve_permission_symlink(&tool, &inp, &cwd, &dirs)
            })
            .await
            .unwrap_or(None);
            if ctx.cancel.is_cancelled() {
                return PermissionResult::deny("Aborted");
            }
            found
        } else {
            None
        };
        self.with(|st| {
            match kind {
                Kind::Plan => {
                    let plan = prompt_events::plan_text(&input);
                    let ev = prompt_events::plan_event(
                        &request_id,
                        tool_use_id.as_ref(),
                        &plan,
                        Some(&input),
                    );
                    st.pending_plans.insert(
                        request_id.clone(),
                        PendingPlan {
                            tx,
                            tool_use_id,
                            plan,
                            raw: input,
                        },
                    );
                    st.broadcast(ev);
                }
                Kind::Ask => {
                    let ev =
                        prompt_events::ask_event(&request_id, tool_use_id.as_ref(), &questions);
                    st.pending_asks.insert(
                        request_id.clone(),
                        PendingAsk {
                            tx,
                            tool_use_id,
                            questions,
                        },
                    );
                    st.broadcast(ev);
                }
                Kind::Perm => {
                    let mut meta = prompt_events::permission_event(
                        &request_id,
                        tool_name,
                        &ctx.raw,
                        ctx.mcp_server.clone(),
                        crate::hook_ask::hook_ask(
                            ctx.decision_reason.as_deref(),
                            ctx.decision_reason_type.as_deref(),
                        ),
                    );
                    if let Some(s) = &symlink {
                        meta["symlink"] = s.to_json();
                    }
                    st.pending_permissions.insert(
                        request_id.clone(),
                        PendingPermission {
                            tx,
                            meta: meta.clone(),
                            input: input.clone(),
                            tool_name: tool_name.to_owned(),
                            suggestions: ctx.suggestions.clone(),
                        },
                    );
                    st.broadcast(meta);
                }
            }
            st.broadcast_turn_status_if_changed();
        });

        tokio::select! {
            r = rx => r.unwrap_or_else(|_| PermissionResult::deny("Aborted")),
            _ = ctx.cancel.cancelled() => {
                self.with(|st| {
                    let removed = match kind {
                        Kind::Plan => st.pending_plans.shift_remove(&request_id).map(|_| None),
                        Kind::Ask => st.pending_asks.shift_remove(&request_id).map(|_| Some("ask")),
                        Kind::Perm => st.pending_permissions.shift_remove(&request_id).map(|_| Some("permission")),
                    };
                    if let Some(settle) = removed {
                        st.bus.mark_read(&request_id);
                        if let Some(k) = settle {
                            st.prompt_settled(k, &request_id);
                        }
                        st.broadcast_turn_status_if_changed();
                    }
                });
                PermissionResult::deny("Aborted")
            }
        }
    }

    /// `resolvePermission(requestId, decision)`.
    pub fn resolve_permission(&self, request_id: &str, decision: PermissionDecision) -> bool {
        let ok = self.with(|st| {
            let Some(p) = st.pending_permissions.shift_remove(request_id) else { return false };
            st.bus.mark_read(request_id);
            st.prompt_settled("permission", request_id);
            if let PermissionDecision::Deny { message } = &decision {
                let _ = p.tx.send(PermissionResult::deny(message.clone().unwrap_or_else(|| "User denied".into())));
                return true;
            }
            let input = if p.input.is_object() { p.input.clone() } else { json!({}) };
            let destination = match &decision {
                PermissionDecision::AllowAlwaysSession => Some("session".to_owned()),
                PermissionDecision::AllowAlwaysSave { destination } => Some(destination.clone()),
                _ => None,
            };
            let updated_permissions = destination.map(|dest| {
                let narrow = allow_rule_suggestions(p.suggestions.as_ref());
                if narrow.is_empty() {
                    vec![json!({"type": "addRules", "behavior": "allow", "rules": [{"toolName": p.tool_name}], "destination": dest})]
                } else {
                    narrow
                        .iter()
                        .map(|u| json!({"type": "addRules", "behavior": "allow", "rules": u["rules"], "destination": dest}))
                        .collect()
                }
            });
            let _ = p.tx.send(PermissionResult::Allow { updated_input: Some(input), updated_permissions });
            st.broadcast_turn_status_if_changed();
            true
        });
        if ok {
            self.spawn_flush_queue();
        }
        ok
    }

    /// `submitAskAnswer(requestId, answers)`.
    pub fn submit_ask_answer(&self, request_id: &str, answers: &[Value]) -> bool {
        let ok = self.with(|st| {
            let Some(p) = st.pending_asks.shift_remove(request_id) else {
                return false;
            };
            st.bus.mark_read(request_id);
            st.prompt_settled("ask", request_id);
            let result = if events::ask_answers_have_content(answers) {
                PermissionResult::allow(events::build_ask_updated_input(&p.questions, answers))
            } else {
                PermissionResult::deny("User cancelled the question")
            };
            let _ = p.tx.send(result);
            st.broadcast_turn_status_if_changed();
            true
        });
        if ok {
            self.spawn_flush_queue();
        }
        ok
    }

    /// `resolvePlan(requestId, decision)`.
    pub fn resolve_plan(&self, request_id: &str, decision: PlanDecision) -> bool {
        let Some(p) = self.with(|st| st.pending_plans.shift_remove(request_id)) else {
            return false;
        };
        self.with(|st| st.bus.mark_read(request_id));
        match decision {
            PlanDecision::Reject { message } => {
                let deny = PermissionResult::deny(
                    message.unwrap_or_else(|| "User rejected the plan — keep iterating.".into()),
                );
                // TS broadcasts the status before the SDK writes the reply:
                // keep them together so the turn can't end in between.
                self.with(|st| {
                    let _ = p.tx.send(deny);
                    st.broadcast_turn_status_if_changed();
                });
                let mut patch = Map::new();
                patch.insert("priorPlan".into(), json!(p.plan));
                let _ = sessions_db::merge_session_state(&self.cwd, &self.id, patch);
            }
            PlanDecision::Accept { edited_plan } => {
                let raw = if p.raw.is_object() {
                    p.raw.clone()
                } else {
                    json!({})
                };
                let edited = edited_plan
                    .as_deref()
                    .map(js::trim)
                    .filter(|e| !e.is_empty());
                let mut updated_input = raw.clone();
                if let Some(e) = edited
                    && e != js::trim(&p.plan)
                {
                    updated_input["plan"] = json!(e);
                }
                let mut patch = Map::new();
                patch.insert(
                    "priorPlan".into(),
                    json!(edited.map(str::to_owned).unwrap_or_else(|| p.plan.clone())),
                );
                let _ = sessions_db::merge_session_state(&self.cwd, &self.id, patch);
                self.with(|st| {
                    st.permission_mode = "acceptEdits".into();
                    st.plan_awaiting_verify = true;
                    let _ = p.tx.send(PermissionResult::Allow {
                        updated_input: Some(updated_input),
                        updated_permissions: Some(vec![json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"})]),
                    });
                    st.broadcast(json!({"type": "mode_changed", "mode": "acceptEdits"}));
                    st.broadcast_turn_status_if_changed();
                });
            }
        }
        self.spawn_flush_queue();
        true
    }

    async fn on_elicitation(&self, req: ElicitationRequest) -> Value {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Value>();
        let meta = prompt_events::elicitation_event(&request_id, &req.raw);
        self.with(|st| {
            st.pending_elicitations.insert(
                request_id.clone(),
                PendingElicitation {
                    tx,
                    meta: meta.clone(),
                },
            );
            st.broadcast(meta);
            st.broadcast_turn_status_if_changed();
        });
        tokio::select! {
            r = rx => r.unwrap_or_else(|_| json!({"action": "cancel"})),
            _ = req.cancel.cancelled() => {
                self.with(|st| {
                    if st.pending_elicitations.shift_remove(&request_id).is_some() {
                        st.bus.mark_read(&request_id);
                        st.prompt_settled("elicitation", &request_id);
                        st.broadcast_turn_status_if_changed();
                    }
                });
                json!({"action": "cancel"})
            }
        }
    }

    /// `resolveElicitation(requestId, decision)`.
    pub fn resolve_elicitation(
        &self,
        request_id: &str,
        action: &str,
        content: Option<Value>,
    ) -> bool {
        let ok = self.with(|st| {
            let Some(p) = st.pending_elicitations.shift_remove(request_id) else {
                return false;
            };
            st.bus.mark_read(request_id);
            let result = if action == "accept" {
                let mut r = json!({"action": "accept"});
                if let Some(c) = content.filter(|c| !c.is_null()) {
                    r["content"] = c;
                }
                r
            } else {
                json!({"action": action})
            };
            let _ = p.tx.send(result);
            st.prompt_settled("elicitation", request_id);
            st.broadcast_turn_status_if_changed();
            true
        });
        if ok {
            self.spawn_flush_queue();
        }
        ok
    }

    // ───────────────────────── mode / model / misc ────────────────────────

    /// `interrupt()` → still-queued uuids from the CLI's receipt.
    ///
    /// CC 2.1.316: a Stop on a working turn marks what's queued behind it as
    /// held, so a replacement Session's `start()` drain (dead-process
    /// restart, account switch, idle revival, server restart) leaves it. The
    /// hold lasts until a turn here succeeds, or the user sends a held row
    /// (Send now / send-all). The status is read before any await, and a DB
    /// failure never stops the interrupt.
    pub async fn interrupt(&self) -> Vec<String> {
        let Some(h) = self.handle() else {
            return vec![];
        };
        if self.with(|st| st.status() != TurnStatus::Idle)
            && queue_db::hold_all(&self.cwd, &self.id).is_ok()
        {
            self.with(|st| st.queue.iter_mut().for_each(|r| r.held_by_stop = true));
        }
        h.interrupt().await.unwrap_or_default()
    }

    async fn model_catalog_info(&self, model: &str, models: Option<&Value>) -> Option<Value> {
        let fetched;
        let models = match models {
            Some(m) => m,
            None => {
                let h = self.handle()?;
                fetched =
                    tokio::time::timeout(std::time::Duration::from_secs(3), h.supported_models())
                        .await
                        .ok()?
                        .ok()?;
                &fetched
            }
        };
        models
            .as_array()?
            .iter()
            .find(|m| {
                m.get("value").and_then(Value::as_str) == Some(model)
                    || m.get("resolvedModel").and_then(Value::as_str) == Some(model)
            })
            .cloned()
    }

    /// `leaveAutoIfModelUnsupported` → display name when auto was turned off.
    async fn leave_auto_if_model_unsupported(
        &self,
        model: Option<&str>,
        models: Option<&Value>,
    ) -> Option<String> {
        let model = model?;
        if self.permission_mode() != "auto" {
            return None;
        }
        let info = self.model_catalog_info(model, models).await;
        if info.as_ref().and_then(|i| i.get("supportsAutoMode")) != Some(&Value::Bool(false)) {
            return None;
        }
        Box::pin(self.set_permission_mode("default", true)).await;
        Some(
            info.and_then(|i| {
                i.get("displayName")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| model.to_owned()),
        )
    }

    /// `setPermissionMode(mode, {skipAutoExitReminder})`, ignoring what
    /// [`Session::try_set_permission_mode`] throws.
    pub async fn set_permission_mode(&self, mode: &str, skip_auto_exit_reminder: bool) {
        let _ = self
            .try_set_permission_mode(mode, skip_auto_exit_reminder)
            .await;
    }

    /// `setPermissionMode(mode, {skipAutoExitReminder})`. `Err` is the
    /// `TypeError` TS throws, before changing anything, for `auto` over a
    /// `null` user settings file.
    pub async fn try_set_permission_mode(
        &self,
        mode: &str,
        skip_auto_exit_reminder: bool,
    ) -> Result<(), String> {
        let mut mode = mode.to_owned();
        if self.opts.restricted_mode == Some(true) && mode == "bypassPermissions" {
            mode = "default".into();
        }
        if mode == "auto" {
            // SDK 0.3.312 — `isAutoModeDisabled` reads both the top-level
            // and the `permissions.` spelling, and reports `false` for a
            // `null` file instead of throwing on its property read.
            let gate = settings::read_settings_js(Scope::User, &self.cwd)
                .unwrap_or_else(|_| Some(Map::new()))
                .map(Value::Object);
            if crate::auto_mode_disabled::is_auto_mode_disabled(gate.as_ref()) {
                mode = "default".into();
            }
        }
        if mode == "auto"
            && let Some(m) = self.effective_model()
            && let Some(info) = self.model_catalog_info(&m, None).await
            && info.get("supportsAutoMode") == Some(&Value::Bool(false))
        {
            mode = "default".into();
        }
        let (was_plan, was_auto) = self.with(|st| {
            let w = (st.permission_mode == "plan", st.permission_mode == "auto");
            st.permission_mode = mode.clone();
            w
        });
        if !was_plan && mode == "plan" {
            let state = sessions_db::get_session_state(&self.cwd, &self.id);
            if let Some(prior) = state
                .get("priorPlan")
                .and_then(Value::as_str)
                .map(js::trim)
                .filter(|s| !s.is_empty())
            {
                self.with(|st| st.queue_reminder(&plan_mode_reentry_reminder_body(prior)));
            }
        }
        if was_auto && mode != "auto" && !skip_auto_exit_reminder {
            self.with(|st| st.queue_reminder(auto_mode_exit_reminder_body()));
        }
        if let Some(h) = self.handle() {
            let _ = h.set_permission_mode(&mode).await;
        }
        self.broadcast(json!({"type": "mode_changed", "mode": mode}));
        Ok(())
    }

    /// `setModel(model, source)`.
    pub async fn set_model(
        &self,
        model: Option<String>,
        source: &str,
    ) -> Result<Option<String>, (String, Option<String>)> {
        let previous = self.model();
        if let Some(h) = self.handle()
            && let Err(e) = h.set_model(model.as_deref()).await
        {
            return Err((e.to_string(), previous));
        }
        let title = self.with(|st| {
            st.model = model.clone();
            st.title.clone()
        });
        let _ =
            sessions_db::upsert_session(&self.id, &self.cwd, model.as_deref(), title.as_deref());
        settings::persist_model_to_user_settings(&self.cwd, model.as_deref());
        let models = match self.handle() {
            Some(h) => h.supported_models().await.ok(),
            None => None,
        };
        let mut fast: Option<bool> = None;
        if let (Some(ms), Some(m), Some(p)) = (&models, &model, &previous)
            && m != p
        {
            let find = |id: &str| {
                ms.as_array().and_then(|a| {
                    a.iter()
                        .find(|x| {
                            x.get("value").and_then(Value::as_str) == Some(id)
                                || x.get("resolvedModel").and_then(Value::as_str) == Some(id)
                        })
                        .cloned()
                })
            };
            if let (Some(pi), Some(ni)) = (find(p), find(m)) {
                let f = |v: &Value| {
                    v.get("supportsFastMode")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                };
                if f(&pi) != f(&ni) {
                    fast = Some(f(&ni));
                }
            }
        }
        let off = match &models {
            Some(ms) => {
                let target = model
                    .clone()
                    .or_else(|| self.with(|st| st.sdk_model.clone()));
                self.leave_auto_if_model_unsupported(target.as_deref(), Some(ms))
                    .await
            }
            None => None,
        };
        let mut ev = json!({"type": "model_changed", "model": model, "source": source});
        if let Some(f) = fast {
            ev["fastModeNowSupported"] = json!(f);
        }
        if let Some(o) = off {
            ev["autoModeOffFor"] = json!(o);
        }
        self.broadcast(ev);
        // Auto-disable the advisor on any model change: not every model pairs
        // with every advisor (fable rejects them with a 400). Clear the file
        // too — `applyFlagSettings({advisorModel: null})` falls back to it.
        if let Some(previous_advisor) = self.advisor_model() {
            if let Err(e) = settings::clear_user_advisor_model(&self.cwd) {
                tracing::error!(target: log::SESSION, "[session.setModel] advisor settings write failed: {e}");
            }
            self.set_advisor_model(None).await;
            self.broadcast(json!({
                "type": "advisor_disabled_on_model_change",
                "previousAdvisor": previous_advisor,
                "newModel": model,
            }));
        }
        Ok(model)
    }

    /// `setAdvisorModel` — mid-session apply via the flag-settings layer.
    /// `None` clears the override (the SDK then falls back to settings.json).
    pub async fn set_advisor_model(&self, model: Option<String>) {
        let Some(h) = self.handle() else { return };
        let _ = h.apply_flag_settings(json!({"advisorModel": model})).await;
        self.with(|st| st.advisor_model = model);
    }

    /// `enforceAdvisorModelCompatibility` — fable-class request models reject
    /// any advisor; idempotent no-op otherwise.
    async fn enforce_advisor_model_compatibility(&self, model: Option<&str>) {
        // `if (!this.advisorModel) return`: an empty advisor is no advisor.
        let Some(previous_advisor) = self.advisor_model().filter(|a| !a.is_empty()) else {
            return;
        };
        if !model.is_some_and(|m| m.contains("fable")) {
            return;
        }
        self.clear_incompatible_advisor(previous_advisor, json!(model))
            .await;
    }

    pub async fn rename(&self, title: &str) -> Result<(), String> {
        let trimmed = js::trim(title).to_owned();
        if trimmed.is_empty() {
            return Err("title required".into());
        }
        sessions_db::set_session_title(&self.cwd, &self.id, &trimmed).map_err(|e| e.to_string())?;
        // CC 2.1.309 — tell the running engine too, the way an IDE host does
        // (`rename_session`, source "host", which the CLI counts as a user
        // rename). Without it the live process keeps its generated name, and
        // that is what other sessions see.
        let told_engine = self.rename_in_engine(&trimmed).await;
        match sessions_store::rename(&self.id, &trimmed, Some(&self.cwd)) {
            Ok(()) => self.with(|st| st.pending_title_mirror = None),
            // Usually "no JSONL yet" for a session that hasn't completed a
            // turn. Unless the engine took the name (it then persists it
            // itself), remember it and re-mirror at the next turn boundary.
            Err(_) => self.with(|st| {
                st.pending_title_mirror = (!told_engine).then(|| trimmed.clone());
            }),
        }
        self.with(|st| {
            st.title = Some(trimmed.clone());
            st.broadcast(json!({"type": "session_title", "title": trimmed}));
        });
        Ok(())
    }

    /// `renameInEngine(title)`: the SDK's `rename_session` control request,
    /// best effort and bounded at 5 s so a wedged control channel can't hang
    /// the rename route. Whether the engine accepted it.
    async fn rename_in_engine(&self, title: &str) -> bool {
        let Some(h) = self.handle() else {
            return false;
        };
        let request = h.rename_session(title, Some(&self.id));
        matches!(
            tokio::time::timeout(std::time::Duration::from_secs(5), request).await,
            Ok(Ok(_))
        )
    }

    /// `flushPendingTitleMirror()`: a rename whose transcript write failed
    /// (made before the first turn flushed) is re-sent once a turn has
    /// completed, and retried at each turn boundary until it lands or the
    /// user renames again. A newer rename that landed while this append was
    /// in flight is re-asserted, because its own append may have been
    /// written first.
    async fn flush_pending_title_mirror(&self) {
        let Some(title) = self.with(|st| st.pending_title_mirror.clone()) else {
            return;
        };
        if sessions_store::rename(&self.id, &title, Some(&self.cwd)).is_err() {
            // Still no transcript (or a transient write error) — next turn.
            return;
        }
        let next = self.with(|st| {
            let next = session_titles::mirror_after_append(
                st.pending_title_mirror.as_deref(),
                &title,
                st.title.as_deref(),
            );
            if next == session_titles::MirrorAfterAppend::Cleared {
                st.pending_title_mirror = None;
            }
            next
        });
        if let session_titles::MirrorAfterAppend::Reassert(current) = next {
            let _ = sessions_store::rename(&self.id, &current, Some(&self.cwd));
        }
    }

    pub fn goal(&self) -> SessionGoal {
        self.with(|st| st.goal.clone())
    }

    pub fn set_goal(&self, goal: &str) -> anyhow::Result<SessionGoal> {
        let g = sessions_db::set_session_goal(&self.cwd, &self.id, goal)?;
        self.with(|st| {
            st.goal = g.clone();
            st.goal_announced = false;
            let ev = sessions_db::goal_event(&st.goal);
            st.broadcast(ev);
        });
        Ok(g)
    }

    pub fn mark_goal_achieved(&self, summary: &str) {
        if self.with(|st| st.goal.goal.is_none() || st.goal.achieved) {
            return;
        }
        if let Ok(g) = sessions_db::set_goal_achieved(&self.cwd, &self.id, summary) {
            self.with(|st| {
                st.goal = g;
                let ev = sessions_db::goal_event(&st.goal);
                st.broadcast(ev);
            });
        }
    }

    pub fn clear_goal(&self) -> anyhow::Result<SessionGoal> {
        let g = sessions_db::clear_session_goal(&self.cwd, &self.id)?;
        self.with(|st| {
            st.goal = g.clone();
            st.goal_announced = true;
            let ev = sessions_db::goal_event(&st.goal);
            st.broadcast(ev);
        });
        Ok(g)
    }

    /// `claimHolder(tabId)`.
    pub fn claim_holder(&self, tab_id: &str) {
        self.with(|st| {
            st.holder_id = Some(tab_id.to_owned());
            st.announce_holder();
        });
    }

    /// `(asks, permissions, elicitations)` for `/pending-prompts`.
    pub fn pending_prompts(&self) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
        self.with(|st| {
            let asks = st
                .pending_asks
                .iter()
                .map(|(id, p)| prompt_events::ask_event(id, p.tool_use_id.as_ref(), &p.questions))
                .collect();
            let perms = st
                .pending_permissions
                .values()
                .map(|p| p.meta.clone())
                .collect();
            let elic = st
                .pending_elicitations
                .values()
                .map(|p| p.meta.clone())
                .collect();
            (asks, perms, elic)
        })
    }

    pub async fn stop_task(&self, task_id: &str) -> Result<(), String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        h.stop_task(task_id).await.map_err(|e| e.to_string())
    }

    /// `backgroundTasks(toolUseId?)`: push in-flight foreground work to the
    /// background (Ctrl+B): that one blocking task, or all of them. `false`
    /// only when the given tool use matched no foreground task.
    pub async fn background_tasks(&self, tool_use_id: Option<&str>) -> Result<bool, String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        h.background_tasks(tool_use_id)
            .await
            .map_err(|e| e.to_string())
    }

    /// `rewindFiles(userMessageId, opts?)`: put the files the session edited
    /// back as they were at that user message (`enableFileCheckpointing` is
    /// always on), or with `dry_run: Some(true)` only report what would
    /// change. The CLI's `RewindFilesResult`: `canRewind: false` with an
    /// `error` (unknown message, no checkpoint) is an `Ok`, not a failure.
    /// `POST /:id/rewind` reads the query itself, like the TS route.
    pub async fn rewind_files(
        &self,
        user_message_id: &str,
        dry_run: Option<bool>,
    ) -> Result<Value, String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        h.rewind_files(user_message_id, dry_run)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn get_context_usage(&self, summary: bool) -> Result<Value, String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        h.get_context_usage(summary.then(|| json!({"detail": "summary"})))
            .await
            .map_err(|e| e.to_string())
    }

    /// `getWeeklyUsedSkills()`: the skills invoked in the last 7 days, for
    /// the full `/context` fetch. `None` (unknown, not unused) without a
    /// query or when the scan fails.
    pub async fn get_weekly_used_skills(&self) -> Option<Vec<String>> {
        let usage = self.fetch_full_usage()?.await.ok()?;
        Some(crate::usage_behaviors::extract_weekly_used_skills(&usage))
    }

    /// `getUsageBehaviors()`: the day/week behaviours behind the Cost
    /// overlay's warnings. `None` without a query, when the scan fails, or
    /// when the CLI has none (not a claude.ai subscriber).
    pub async fn get_usage_behaviors(&self) -> Option<Value> {
        let usage = self.fetch_full_usage()?.await.ok()?;
        crate::usage_behaviors::extract_usage_behaviors(&usage)
    }

    /// `fetchFullUsage()`: the usage call with the local-transcript
    /// behaviours scan (`skipBehaviors: false`), shared per query for
    /// `FULL_USAGE_TTL_MS`. The idle plan-usage poll doesn't use it.
    fn fetch_full_usage(&self) -> Option<crate::usage_behaviors::Scan> {
        let h = self.handle()?;
        let id = h.id();
        Some(self.full_usage.get(&id, move || async move {
            h.get_usage(false).await.map_err(|e| e.to_string())
        }))
    }

    // ── MCP controls: each user-initiated change queues the `mcp-delta`
    // reminder (crate::mcp_delta) for the next turn ──

    /// `mcpServerStatus()`: the CLI's per-server status list (`Null` when its
    /// reply has none: the SDK's `undefined`).
    pub async fn mcp_server_status(&self) -> Result<Value, String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        h.mcp_server_status().await.map_err(|e| e.to_string())
    }

    /// `mcpServerStatus()` as `GET /api/mcp` reads it: `Ok(None)` when the
    /// reply has no `mcpServers` (the SDK's `undefined`, so the route leaves
    /// `status` out), and a `null` reply fails as the SDK's
    /// `response.mcpServers` does.
    pub async fn mcp_server_status_reply(&self) -> Result<Option<Value>, String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        match h.request(json!({"subtype": "mcp_status"})).await {
            Ok(Value::Null) => Err("Cannot read properties of null (reading 'mcpServers')".into()),
            Ok(reply) => Ok(reply.get("mcpServers").cloned()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// `reconnectMcp(name)`. The server can still be `pending` when the CLI
    /// answers, so the reminder says it "may still be connecting" instead of
    /// re-querying its status.
    pub async fn reconnect_mcp(&self, name: &str) -> Result<(), String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        h.reconnect_mcp_server(name)
            .await
            .map_err(|e| e.to_string())?;
        self.queue_mcp_delta(crate::mcp_delta::McpDelta {
            reconnecting: vec![name.to_owned()],
            ..Default::default()
        });
        Ok(())
    }

    /// `toggleMcp(name, enabled)`: the reminder names the server available
    /// again, or disabled by the user.
    pub async fn toggle_mcp(&self, name: &str, enabled: bool) -> Result<(), String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        h.toggle_mcp_server(name, enabled)
            .await
            .map_err(|e| e.to_string())?;
        let names = vec![name.to_owned()];
        self.queue_mcp_delta(if enabled {
            crate::mcp_delta::McpDelta {
                added: names,
                ..Default::default()
            }
        } else {
            crate::mcp_delta::McpDelta {
                disabled: names,
                ..Default::default()
            }
        });
        Ok(())
    }

    /// `setMcpServers(servers)`: replace the session's SDK-added MCP servers
    /// (an empty set removes them all; file-configured servers are left
    /// alone). Returns the CLI's `{added, removed, errors}` report. The
    /// reminder names what was added, except servers that failed to
    /// connect, and what was removed.
    pub async fn set_mcp_servers(
        &self,
        servers: impl IntoIterator<Item = (String, McpServerConfig)>,
    ) -> Result<Value, String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        let data = h
            .set_mcp_servers(servers.into_iter().collect())
            .await
            .map_err(|e| e.to_string())?;
        self.queue_mcp_delta(crate::mcp_delta::set_servers_delta(&data));
        Ok(data)
    }

    /// `getPluginLoadErrors()`: the plugins the newest `system/init` said
    /// failed to load ([`crate::plugins::plugin_error_array`]).
    pub fn plugin_load_errors(&self) -> Vec<Value> {
        self.with(|st| st.plugin_load_errors.clone())
    }

    /// `reloadPlugins({holdOnCacheImpact})`: the CLI's `reload_plugins`
    /// reply, or why it failed (`no active query` without a CLI).
    pub async fn reload_plugins(&self, hold_on_cache_impact: bool) -> Result<Value, String> {
        let h = self.handle().ok_or_else(|| "no active query".to_owned())?;
        h.reload_plugins(hold_on_cache_impact)
            .await
            .map_err(|e| e.to_string())
    }

    /// `queueReminder(this, "mcp-delta", body)`, unless the delta is empty.
    fn queue_mcp_delta(&self, delta: crate::mcp_delta::McpDelta) {
        if let Some(body) = crate::mcp_delta::mcp_delta_reminder_body(&delta) {
            self.with(|st| st.queue_reminder(&body));
        }
    }

    /// `notifyMemoryUpdate(updates)`: queue the `memory-update` reminder,
    /// naming the changed paths this session has Read as stale.
    pub fn notify_memory_update(&self, updates: &[crate::auto_memory::MemoryUpdate]) {
        self.with(|st| {
            let body = crate::auto_memory::memory_update_reminder(updates, &st.recent_read_paths);
            if let Some(body) = body {
                st.queue_reminder(&body);
            }
        });
    }

    /// `resyncFromDisk()` — append transcript entries the buffer hasn't seen
    /// (e.g. turns written by another client of the same session file).
    pub fn resync_from_disk(&self) -> usize {
        self.jsonl_resync_busy.store(true, Ordering::SeqCst);
        let _busy = ClearOnDrop(&self.jsonl_resync_busy);
        let log_empty = || {
            let buffer_len = self.with(|st| st.buffer.len());
            tracing::debug!(target: log::SESS_LOAD, id = %self.id, cwd = %self.cwd, bufferLen = buffer_len, "[sess-load] resyncFromDisk empty");
        };
        let Some((file, _)) = sessions_store::find_file(&self.id, Some(&self.cwd)) else {
            log_empty();
            return 0;
        };
        let text = match transcript::read_file(&file) {
            Ok(t) => t,
            Err(e) => {
                tracing::debug!(target: log::SESS_LOAD, id = %self.id, err = %e, "[sess-load] resyncFromDisk FAILED");
                return 0;
            }
        };
        let disk = transcript::session_messages(&text, true);
        if disk.is_empty() {
            log_empty();
            return 0;
        }
        let disk_len = disk.len();
        self.with(|st| {
            let seen: std::collections::HashSet<String> = st
                .buffer
                .iter()
                .filter(|e| ev_type(e) == "sdk")
                .filter_map(|e| {
                    e["message"]
                        .get("uuid")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect();
            let mut carried: Option<i64> = None;
            let mut added = 0;
            for m in disk {
                let parsed = m
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(crate::js_date::date_parse);
                match parsed {
                    Some(p) => carried = Some(p),
                    None => carried = carried.map(|c| c + 1),
                }
                let Some(uuid) = m.get("uuid").and_then(Value::as_str) else {
                    continue;
                };
                if seen.contains(uuid) {
                    continue;
                }
                // An external writer can arm or cancel loops on disk.
                st.track_scheduled_loops(&m, parsed.or(carried));
                let mut ev = json!({"type": "sdk", "message": m});
                if let Some(a) = parsed.or(carried) {
                    ev["at"] = json!(a);
                }
                st.broadcast(ev);
                added += 1;
            }
            tracing::debug!(
                target: log::SESS_LOAD,
                id = %self.id,
                diskLen = disk_len,
                added,
                bufferLen = st.buffer.len(),
                "[sess-load] resyncFromDisk done"
            );
            added
        })
    }

    /// `getScheduledLoops`: the loops and wake-ups the agent armed (with
    /// `CronCreate` / `ScheduleWakeup`) in this session's lifetime.
    pub fn scheduled_loops(&self) -> Vec<crate::session_loops::SessionLoop> {
        self.with(|st| st.loops.loops())
    }

    /// `hasArmedLoops(now)`: a loop that still needs this session's CLI (the
    /// reaper keeps the session). Evaluated outside the state lock: a
    /// one-shot cron's first fire runs the cron iterator.
    pub fn has_armed_loops(&self, now: i64) -> bool {
        // CC 2.1.311 — a dead CLI took the loop timers with it, so an ended
        // session has nothing to keep alive; without this the reaper re-armed
        // forever and pinned the dead session in memory.
        if self.with(|st| st.done) {
            return false;
        }
        crate::loop_keepalive::has_armed_loop(&self.scheduled_loops(), now)
    }

    /// `isDead()` (CC 2.1.311): the CLI ended on its own (a crash, a non-zero
    /// exit, a stream error) rather than through [`Session::end`], which the
    /// reaper, a rebuild and a delete all call first. [`Session::send_input`]
    /// drops every message once `done`, so a dead session silently swallows
    /// them until
    /// [`SessionManager::restart_if_dead`](crate::session_manager::SessionManager::restart_if_dead)
    /// rebuilds it.
    pub fn is_dead(&self) -> bool {
        self.with(|st| st.done && (st.died_on_its_own || !self.abort.is_cancelled()))
    }

    /// `cameUpLive()`: this instance's CLI sent a live `system/init`, so it
    /// did come up. Passive callers of `restart_if_dead` (a stream connect, a
    /// poller) only restart such a session — the "crashed between turns"
    /// case; one that dies on boot would only die again, while the rebuild
    /// unbinds the id and swaps the instance under its open tabs.
    pub fn came_up_live(&self) -> bool {
        self.with(|st| st.saw_live_init)
    }

    /// `closeStreams()`: drop every open subscriber so its SSE stream ends
    /// and the tab's `EventSource` reconnects — the session has been rebuilt
    /// under the same id, so the stream route resolves the new one and
    /// replays into it.
    ///
    /// TS closes only the streams the stream route registered an `onClose`
    /// for; Rust has one subscriber kind, so every subscription ends (the
    /// holder slot is released as each is dropped).
    pub fn close_streams(&self) {
        let count = self.with(|st| {
            st.subs.clear();
            st.subs.len()
        });
        self.sub_count.send_replace(count);
    }

    /// `requestRecap(origin)`: generate the "where were we?" recap and
    /// broadcast it as `session_recap`, or a `session_recap_error` with the
    /// reason it was skipped (`running`, `rate_limited`, `disabled`,
    /// `no_history`, `failed`). A recap cancelled by a new turn or a newer
    /// recap broadcasts nothing.
    pub async fn request_recap(&self, origin: &str) {
        let error = |reason: &str| json!({"type": "session_recap_error", "reason": reason});
        if self.status() == TurnStatus::Running {
            self.broadcast(error("running"));
            return;
        }
        let now = now_ms();
        if self.with(|st| {
            st.last_recap_at
                .is_some_and(|at| now - at < session_recap::RECAP_DEDUPE_WINDOW_MS)
        }) {
            self.broadcast(error("rate_limited"));
            return;
        }
        // `settings.sessionRecapEnabled` throws on a `null` file: the route
        // logs the rejection and nothing is broadcast.
        let user_settings = settings::read_settings_js(Scope::User, &self.cwd);
        let Some(user_settings) = user_settings.unwrap_or_else(|_| Some(Map::new())) else {
            let msg = settings::null_property_error("sessionRecapEnabled");
            tracing::warn!("[api/sessions/recap] requestRecap failed: {msg}");
            return;
        };
        if user_settings.get("sessionRecapEnabled") == Some(&Value::Bool(false)) {
            self.broadcast(error("disabled"));
            return;
        }
        // TS throws here (an `sdk` event without a message): the route logs
        // the rejection and nothing is broadcast.
        let Some((tail, turns)) =
            self.with(|st| session_recap::extract_transcript_tail(&st.buffer))
        else {
            tracing::warn!("[api/sessions/recap] requestRecap failed: an sdk event has no message");
            return;
        };
        // TS also checks `!tail.trim()`: a counted turn always leaves a
        // prefixed line, so `turns == 0` is the whole condition.
        if turns == 0 {
            self.broadcast(error("no_history"));
            return;
        }
        // Claim the dedupe slot before the query, and supersede an older
        // recap.
        let token = CancellationToken::new();
        self.with(|st| {
            st.last_recap_at = Some(now);
            if let Some(old) = st.recap_abort.replace(token.clone()) {
                old.cancel();
            }
        });
        let input = session_recap::RecapInput {
            cwd: self.cwd.clone(),
            transcript_tail: tail,
            model: self.model(),
            env: self
                .with(|st| st.account_env.clone())
                .or_else(|| self.opts.runtime.env_override.clone()),
            claude_bin: self.opts.runtime.claude_bin.clone(),
        };
        let outcome = session_recap::generate_recap(input, token.clone()).await;
        if token.is_cancelled() {
            return;
        }
        match outcome {
            session_recap::RecapOutcome::Ok(text) => self.broadcast(json!({
                "type": "session_recap", "text": text, "at": now_ms(), "origin": origin,
            })),
            session_recap::RecapOutcome::Aborted => {}
            session_recap::RecapOutcome::EmptyResponse => self.broadcast(json!({
                "type": "session_recap_error", "reason": "failed", "message": "empty response",
            })),
            session_recap::RecapOutcome::Failed(message) => self.broadcast(json!({
                "type": "session_recap_error", "reason": "failed", "message": message,
            })),
        }
    }

    /// `runBashCommand`: run a `!` command on the session's persistent shell.
    /// The result is broadcast as a synthetic user message (the chat's
    /// BashIO row; the model isn't invoked) and queued for the next prompt.
    /// `uuid` is the body's, any JSON value (`?? randomUUID()` already
    /// applied). `Err` is what the TS code throws (a non-string uuid with a
    /// sudo password): the route's empty 500. The password is never logged,
    /// broadcast or queued: the block carries the command as typed.
    pub async fn run_bash_command(
        &self,
        command: &str,
        sudo_password: Option<&str>,
        uuid: Value,
    ) -> Result<BashRun, &'static str> {
        let bash = crate::bash_mode::get_or_create_bash_session(&self.id, &self.cwd);
        let result = match crate::bash_mode::plan_bash_command(command, sudo_password, &uuid)? {
            crate::bash_mode::BashPlan::CompoundSudo => crate::bash_mode::BashExecResult {
                stdout: String::new(),
                stderr: crate::bash_mode::COMPOUND_SUDO_ERROR.to_owned(),
                exit_code: -1,
                truncated: false,
                timed_out: false,
            },
            crate::bash_mode::BashPlan::Run(wrapped) => {
                bash.exec(&wrapped, crate::bash_mode::DEFAULT_TIMEOUT).await
            }
        };
        let block = crate::bash_mode::format_bash_io_block(command, &result.stdout, &result.stderr);
        self.with(|st| {
            st.bash_blocks.push(block.clone());
            st.broadcast(json!({"type": "sdk", "message": {
                "type": "user",
                "message": {"role": "user", "content": block},
                "parent_tool_use_id": null,
                "session_id": self.id,
                "uuid": uuid,
            }}));
        });
        Ok(BashRun { uuid, result })
    }

    /// `end()` — close input, abort the CLI, settle every open prompt.
    pub async fn end(&self) {
        // A death that predates this call is remembered, because the abort
        // below would otherwise make `is_dead()` read false for a session
        // `restart_if_dead` removed and had to put back (CC 2.1.311).
        self.with(|st| {
            if st.done && !self.abort.is_cancelled() {
                st.died_on_its_own = true;
            }
        });
        self.abort.cancel();
        self.with(|st| st.done = true);
        self.stop_jsonl_watcher();
        // Ephemeral loop state goes too (a stale handle reads no ghosts).
        self.with(|st| {
            st.drain_pending_decisions("Aborted");
            st.loops.clear();
        });
        // The `!` shell and its process group go with the session.
        crate::bash_mode::drop_bash_session(&self.id);
        if let Some(h) = self.handle() {
            h.close().await;
            // Unlike the TS backend (a long-lived Node process reaps the child
            // later), the Rust server may be about to exit: wait for the CLI to
            // finish so it's never orphaned and its final JSONL writes land
            // before we return. Bounded: in a shutdown (`begin_exit`) close()
            // SIGTERMs at once and SIGKILLs 2 s later; otherwise it keeps the
            // SDK's 2 s + 5 s, and kills a CLI this gives up on by itself.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), h.wait_exit()).await;
        }
    }
}

/// What [`Session::run_bash_command`] returns: the uuid it broadcast under
/// and the shell's result.
#[derive(Debug)]
pub struct BashRun {
    pub uuid: Value,
    pub result: crate::bash_mode::BashExecResult,
}

/// Clears a flag when dropped: the `finally { busy = false }`.
struct ClearOnDrop<'a>(&'a AtomicBool);

impl Drop for ClearOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn validate_workspace_cwd(cwd: &str) -> Result<(), String> {
    let p = std::path::Path::new(cwd);
    if !p.is_absolute() {
        return Err(format!(
            "Workspace path `{cwd}` isn't an absolute folder path. Fix the path or re-add the workspace using its full path."
        ));
    }
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err(format!(
            "Workspace path `{cwd}` exists but isn't a directory. Pick a different folder for this workspace."
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(format!(
            "Workspace folder `{cwd}` doesn't exist. The folder was moved or deleted — recreate it, or remove this workspace from the sidebar and re-add the real path."
        )),
        Err(e) => Err(format!(
            "Can't read workspace folder `{cwd}` ({}). Fix the path or pick a different folder.",
            e.raw_os_error().map(errno_name).unwrap_or("unknown error")
        )),
    }
}

/// Node's `err.code`: libuv's name, `UNKNOWN` when it has none.
#[cfg(unix)]
fn errno_name(code: i32) -> &'static str {
    claudius_agent::binary::errno_name(code).unwrap_or("UNKNOWN")
}

#[cfg(not(unix))]
fn errno_name(code: i32) -> &'static str {
    match code {
        13 => "EACCES",
        1 => "EPERM",
        20 => "ENOTDIR",
        40 | 62 => "ELOOP",
        _ => "unknown error",
    }
}

fn goal_system_prompt_append(goal: &SessionGoal) -> String {
    let Some(g) = &goal.goal else {
        return String::new();
    };
    [
        "## Session goal",
        "",
        "The user has set an explicit goal for this session:",
        "",
        &format!("> {g}"),
        "",
        "Keep this objective in mind across turns. When — and only when — you are confident it has been fully accomplished, call the `mcp__claudius_goal__report_goal_achieved` tool with a one-sentence summary. Do not call it for partial progress, and don't bring the goal up unprompted.",
    ]
    .join("\n")
}

/// `joinSystemPromptAppends` — trimmed, non-empty parts joined by a blank line.
pub fn join_system_prompt_appends(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|p| js::trim(p))
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

struct ScopeGuard<F: FnMut()>(F);
impl<F: FnMut()> Drop for ScopeGuard<F> {
    fn drop(&mut self) {
        (self.0)()
    }
}
fn scopeguard<F: FnMut()>(f: F) -> ScopeGuard<F> {
    ScopeGuard(f)
}

/// Bridges the agent crate's callback traits to a (weakly held) session.
struct SessionPermissions(Weak<Session>);

#[async_trait]
impl CanUseTool for SessionPermissions {
    async fn can_use_tool(
        &self,
        tool_name: &str,
        input: Value,
        ctx: ToolPermissionContext,
    ) -> Option<PermissionResult> {
        let Some(s) = self.0.upgrade() else {
            return Some(PermissionResult::deny("Aborted"));
        };
        Some(s.can_use_tool(tool_name, input, ctx).await)
    }
}

#[async_trait]
impl OnElicitation for SessionPermissions {
    async fn on_elicitation(&self, req: ElicitationRequest) -> Option<Value> {
        let Some(s) = self.0.upgrade() else {
            return Some(json!({"action": "cancel"}));
        };
        Some(s.on_elicitation(req).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// S28: the broadcast / capture golden (`session/tests/stream_golden.rs`).
    mod stream_golden;

    /// A `State` as `Session::new` seeds it.
    fn todo_state() -> State {
        State {
            latest_user_prompt_at: f64::NEG_INFINITY,
            latest_todos_at: f64::NEG_INFINITY,
            ..Default::default()
        }
    }

    fn sdk(message: Value, at: f64) -> Value {
        json!({"type": "sdk", "message": message, "at": at})
    }

    fn uses(blocks: Value, at: f64) -> Value {
        sdk(
            json!({"type": "assistant", "message": {"role": "assistant", "content": blocks}}),
            at,
        )
    }

    fn results(blocks: Value, at: f64) -> Value {
        sdk(
            json!({"type": "user", "message": {"role": "user", "content": blocks}}),
            at,
        )
    }

    /// The token-expiry check rides the first live init, from inside its
    /// broadcast: subscribers get the nudge first, the buffer keeps the init
    /// first. A replayed init runs no check.
    #[test]
    fn the_token_nudge_rides_the_first_live_init() {
        let mut st = todo_state();
        let (tx, mut rx) = mpsc::unbounded_channel();
        st.subs.push(Sub { id: 1, tx });
        let expires_at = (now_ms() + 3_600_000) as f64;
        st.active_profile_expires_at = Some(expires_at);
        let init = sdk(json!({"type": "system", "subtype": "init"}), 1.0);
        st.is_replaying = true;
        st.broadcast(init.clone());
        st.is_replaying = false;
        assert!(!st.nudges.token_expiring_nudge_fired);
        st.broadcast(sdk(json!({"type": "system", "subtype": "status"}), 2.0));
        st.broadcast(init.clone());
        st.broadcast(init);
        let live: Vec<Value> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        let types = |evs: &[Value]| {
            evs.iter()
                .map(|e| ev_type(e).to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            types(&live),
            ["sdk", "sdk", "token_expiring_required", "sdk", "sdk"]
        );
        assert_eq!(
            types(&st.buffer),
            ["sdk", "sdk", "sdk", "token_expiring_required", "sdk"]
        );
        assert_eq!(
            live[2],
            json!({"type": "token_expiring_required", "expiresAt": crate::js_num(expires_at)})
        );
    }

    #[test]
    fn todo_writes_bounce_off_the_cutoff() {
        let mut st = todo_state();
        let write = |items: Value| json!([{"type": "tool_use", "id": "t", "name": "TodoWrite", "input": {"todos": items}}]);
        st.broadcast(uses(write(json!([{"content": "new"}])), 200.0));
        // An older write (a pre-clear replay) loses; an equal one wins.
        st.broadcast(uses(write(json!([{"content": "old"}])), 100.0));
        assert_eq!(st.latest_todos, Some(vec![json!({"content": "new"})]));
        st.broadcast(uses(write(json!([{"content": "same"}])), 200.0));
        assert_eq!(st.latest_todos, Some(vec![json!({"content": "same"})]));
        // Older TaskCreate / TaskList results bounce too.
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "c1", "name": "TaskCreate", "input": {"subject": "x"}}]),
            150.0,
        ));
        assert_eq!(st.latest_todos.as_ref().unwrap().len(), 1);
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "l1", "name": "TaskList", "input": {}}]),
            150.0,
        ));
        st.broadcast(results(
            json!([{"type": "tool_result", "tool_use_id": "l1", "content": "#1 [pending] stale"}]),
            150.0,
        ));
        assert_eq!(st.latest_todos, Some(vec![json!({"content": "same"})]));
        assert!(
            st.pending_task_lists.is_empty(),
            "the id is consumed either way"
        );
        // A non-array `todos` leaves the list but still rearms the counter.
        st.turns_since_todo_write = 4;
        st.broadcast(uses(write(json!("nope")), 300.0));
        assert_eq!(st.latest_todos, Some(vec![json!({"content": "same"})]));
        assert_eq!(st.turns_since_todo_write, 0);
        assert_eq!(st.latest_todos_at, 200.0);
    }

    #[test]
    fn task_create_dedupes_and_task_update_needs_a_list() {
        let mut st = todo_state();
        let update = json!([{"type": "tool_use", "id": "u", "name": "TaskUpdate", "input": {"taskId": "1", "status": "completed"}}]);
        st.broadcast(uses(update.clone(), 1.0));
        assert_eq!(st.latest_todos, None, "no list, no update");
        let create = json!([{"type": "tool_use", "id": "c", "name": "TaskCreate", "input": {"subject": "S", "activeForm": 5}}]);
        st.broadcast(uses(create.clone(), 2.0));
        st.broadcast(uses(create.clone(), 3.0));
        assert_eq!(
            st.latest_todos,
            Some(vec![
                json!({"id": "c", "content": "S", "status": "pending"})
            ]),
            "pending twice: one entry; a non-string activeForm drops out"
        );
        // An unrecognized result shape leaves the temp id.
        st.broadcast(results(
            json!([{"type": "tool_result", "tool_use_id": "c", "content": "done"}]),
            4.0,
        ));
        assert_eq!(st.latest_todos.as_ref().unwrap()[0]["id"], "c");
        // Still present under its id: a replayed TaskCreate is skipped.
        st.broadcast(uses(create, 5.0));
        assert_eq!(st.latest_todos.as_ref().unwrap().len(), 1);
        // Empty taskId, empty status, empty subject: no change.
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "u2", "name": "TaskUpdate", "input": {"taskId": "", "status": "deleted"}}]),
            6.0,
        ));
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "u3", "name": "TaskUpdate", "input": {"taskId": "c", "status": "", "subject": ""}}]),
            7.0,
        ));
        assert_eq!(
            st.latest_todos,
            Some(vec![
                json!({"id": "c", "content": "S", "status": "pending"})
            ])
        );
        // A TaskCreate without a string id adds nothing.
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": 9, "name": "TaskCreate", "input": {"subject": "n"}}]),
            8.0,
        ));
        assert_eq!(st.latest_todos.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn replay_and_subagents_stay_out_of_the_live_counters() {
        let mut st = todo_state();
        st.latest_todos = Some(vec![json!({"id": "1", "status": "pending"})]);
        let bash = |n: usize| {
            Value::Array(
                (0..n)
                    .map(|i| json!({"type": "tool_use", "id": format!("b{i}"), "name": "Bash", "input": {}}))
                    .collect(),
            )
        };
        st.is_replaying = true;
        st.broadcast(uses(bash(20), 1.0));
        assert_eq!(
            st.tool_uses_since_todo_touch, 0,
            "replayed tool uses don't count"
        );
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "l", "name": "TaskList", "input": {}}]),
            2.0,
        ));
        st.broadcast(results(
            json!([{"type": "tool_result", "tool_use_id": "l", "content": "#1 [completed] a"}]),
            2.0,
        ));
        assert!(
            !st.todos_rebuilt_from_task_list_this_turn,
            "replay doesn't arm the suppression"
        );
        assert_eq!(st.latest_todos.as_ref().unwrap()[0]["status"], "completed");
        st.is_replaying = false;
        // A subagent's messages (any truthy parent) are ignored outright.
        let mut nested = uses(bash(20), 3.0);
        nested["message"]["parent_tool_use_id"] = json!(7);
        st.broadcast(nested);
        assert_eq!(st.tool_uses_since_todo_touch, 0);
        // No open items: counting goes on, but nothing is queued.
        st.broadcast(uses(bash(12), 4.0));
        assert_eq!(st.tool_uses_since_todo_touch, 12);
        assert!(st.mid_turn_reminders.is_empty());
        // A live TaskList result arms it and resets the counter.
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "l2", "name": "TaskList", "input": {}}]),
            5.0,
        ));
        st.broadcast(results(
            json!([{"type": "tool_result", "tool_use_id": "l2", "content": [{"type": "text", "text": "#2 [pending] "}, {"type": "text", "text": "b"}]}]),
            5.0,
        ));
        assert!(st.todos_rebuilt_from_task_list_this_turn);
        assert_eq!(st.tool_uses_since_todo_touch, 0);
        assert_eq!(
            st.latest_todos,
            Some(vec![
                json!({"id": "2", "content": "b", "status": "pending"})
            ])
        );
        // An error result consumes the id and changes nothing.
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "l3", "name": "TaskList", "input": {}}]),
            6.0,
        ));
        st.broadcast(results(
            json!([{"type": "tool_result", "tool_use_id": "l3", "is_error": 1, "content": ""}]),
            6.0,
        ));
        assert!(st.pending_task_lists.is_empty());
        assert_eq!(st.latest_todos.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn touches_restart_the_count_and_non_touches_dont() {
        let mut st = todo_state();
        st.latest_todos = Some(vec![json!({"id": "1", "status": "pending"})]);
        let bash = |n: usize| {
            uses(
                Value::Array(
                    (0..n)
                        .map(|i| json!({"type": "tool_use", "id": format!("b{i}"), "name": "Bash", "input": {}}))
                        .collect(),
                ),
                10.0,
            )
        };
        let one = |id: Value, name: &str, input: Value| {
            uses(
                json!([{"type": "tool_use", "id": id, "name": name, "input": input}]),
                10.0,
            )
        };
        for (id, name, input) in [
            (
                "w",
                "TodoWrite",
                json!({"todos": [{"id": "1", "status": "pending"}]}),
            ),
            ("c", "TaskCreate", json!({"subject": "n"})),
            (
                "u",
                "TaskUpdate",
                json!({"taskId": "1", "status": "pending"}),
            ),
        ] {
            st.broadcast(bash(11));
            st.broadcast(one(json!(id), name, input));
            assert_eq!(
                st.tool_uses_since_todo_touch, 0,
                "{name} restarts the count"
            );
        }
        assert!(st.mid_turn_reminders.is_empty());
        // Neither counted nor a touch: a TaskList use (its result touches),
        // an empty taskId, a TaskCreate without a string id.
        st.broadcast(bash(5));
        st.broadcast(one(json!("l"), "TaskList", json!({})));
        st.broadcast(one(json!("u2"), "TaskUpdate", json!({"taskId": ""})));
        st.broadcast(one(json!(7), "TaskCreate", json!({"subject": "n"})));
        assert_eq!(st.tool_uses_since_todo_touch, 5);
    }

    #[test]
    fn a_pending_create_isnt_re_added_after_a_replace() {
        let mut st = todo_state();
        let create = uses(
            json!([{"type": "tool_use", "id": "c", "name": "TaskCreate", "input": {"subject": "S"}}]),
            1.0,
        );
        st.broadcast(create.clone());
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "w", "name": "TodoWrite", "input": {"todos": []}}]),
            1.0,
        ));
        st.broadcast(create);
        assert_eq!(st.latest_todos, Some(vec![]));
    }

    #[test]
    fn result_text_parts_and_prompts_follow_js() {
        let mut st = todo_state();
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "l", "name": "TaskList", "input": {}}]),
            1.0,
        ));
        // `c?.type === "text" && c.text` then `+=`: falsy texts and other
        // part types drop out, a truthy number prints.
        st.broadcast(results(
            json!([{"type": "tool_result", "tool_use_id": "l", "content": [
                {"type": "text", "text": "#1 [pending] a"},
                {"type": "text", "text": 0},
                {"type": "text", "text": 5},
                {"type": "text", "text": null},
                {"type": "text", "text": false},
                {"type": "image", "text": "Z"},
                {"text": "Y"},
            ]}]),
            1.0,
        ));
        assert_eq!(
            st.latest_todos,
            Some(vec![
                json!({"id": "1", "content": "a5", "status": "pending"})
            ])
        );
        // A prompt needs a truthy uuid.
        let prompt = |uuid: &str| {
            sdk(
                json!({"type": "user", "uuid": uuid, "message": {"role": "user", "content": "hi"}}),
                2.0,
            )
        };
        st.broadcast(prompt(""));
        assert_eq!(st.latest_user_prompt, None);
        st.broadcast(prompt("u1"));
        assert_eq!(st.latest_user_prompt.as_ref().unwrap()["uuid"], "u1");
    }

    fn todo_list(statuses: &[&str]) -> Vec<Value> {
        statuses
            .iter()
            .enumerate()
            .map(|(i, s)| json!({"id": i.to_string(), "content": format!("t{i}"), "status": s}))
            .collect()
    }

    /// The `todosStale` of every buffered `session_snapshot`.
    fn stale_flags(st: &State) -> Vec<Value> {
        st.buffer
            .iter()
            .filter(|e| e["type"] == "session_snapshot")
            .map(|e| e["todosStale"].clone())
            .collect()
    }

    #[test]
    fn turn_end_flags_then_clears_a_list_that_stops_moving() {
        let mut st = todo_state();
        let list = todo_list(&["pending", "pending", "pending"]);
        st.latest_todos = Some(list.clone());
        st.tool_uses_since_todo_touch = 5;
        st.fired_mid_turn_todo_reminder_this_turn = true;
        // A fresh list is no progress against (0 done, 0 total).
        assert_eq!(st.todos_turn_end(), None);
        assert_eq!(
            (
                st.tool_uses_since_todo_touch,
                st.fired_mid_turn_todo_reminder_this_turn
            ),
            (0, false)
        );
        assert_eq!(st.turns_todos_no_progress, 1);
        assert_eq!(
            st.take_reminders(),
            wrap_reminder(&todos::todos_current_reminder_body(&list))
        );
        assert_eq!(st.todos_turn_end(), None);
        assert!(!st.todos_stale && stale_flags(&st).is_empty());
        // The third flags it, repainting with the live list; the fourth
        // doesn't repaint.
        assert_eq!(st.todos_turn_end(), None);
        assert!(st.todos_stale);
        let flagged = st.buffer.last().unwrap();
        assert_eq!(
            (flagged["todos"].clone(), flagged["todosStale"].clone()),
            (Value::Array(list.clone()), json!(true))
        );
        assert_eq!(st.todos_turn_end(), None);
        assert_eq!(stale_flags(&st), [json!(true)]);
        // One more done is progress: un-staled, count restarted.
        st.latest_todos.as_mut().unwrap()[0]["status"] = json!("completed");
        assert_eq!(st.todos_turn_end(), None);
        assert_eq!(st.turns_todos_no_progress, 0);
        assert_eq!(stale_flags(&st), [json!(true), json!(false)]);
        // Reopening or adding isn't; a shorter list is.
        st.latest_todos.as_mut().unwrap()[0]["status"] = json!("pending");
        st.todos_turn_end();
        assert_eq!(st.turns_todos_no_progress, 1);
        st.latest_todos
            .as_mut()
            .unwrap()
            .push(json!({"id": "9", "status": "pending"}));
        st.todos_turn_end();
        assert_eq!(st.turns_todos_no_progress, 2);
        st.latest_todos.as_mut().unwrap().pop();
        st.todos_turn_end();
        assert_eq!(st.turns_todos_no_progress, 0);
        // The sixth turn without progress asks for the stale clear, and
        // queues no reminder.
        for _ in 1..=5 {
            assert_eq!(st.todos_turn_end(), None);
        }
        st.take_reminders();
        assert_eq!(st.todos_turn_end(), Some(TodosClearReason::Stale));
        assert_eq!(st.take_reminders(), "");
    }

    #[test]
    fn turn_end_clears_a_done_list_unless_a_task_list_just_rebuilt_it() {
        let mut st = todo_state();
        let rearm = |st: &mut State| {
            st.turns_todos_no_progress = 4;
            st.last_todos_done_count = 1;
            st.last_todos_total_count = 3;
            st.todos_rebuilt_from_task_list_this_turn = true;
        };
        let progress = |st: &State| {
            (
                st.turns_todos_no_progress,
                st.last_todos_done_count,
                st.last_todos_total_count,
                st.todos_rebuilt_from_task_list_this_turn,
            )
        };
        st.latest_todos = Some(todo_list(&["completed", "completed"]));
        rearm(&mut st);
        // Rebuilt by a TaskList this turn: shown for one turn.
        assert_eq!(st.todos_turn_end(), None);
        assert_eq!(progress(&st), (0, 0, 0, false));
        assert_eq!(st.todos_turn_end(), Some(TodosClearReason::Completed));
        assert_eq!(st.take_reminders(), "");
        // "Completed" only, exactly.
        st.latest_todos = Some(todo_list(&["completed", "Completed"]));
        assert_eq!(st.todos_turn_end(), None);
        // No list or an empty one: nothing to keep in view; the baseline
        // restarts.
        // (An empty list isn't an all-done one to clear, rebuilt or not.)
        for (list, rebuilt) in [
            (None, true),
            (None, false),
            (Some(vec![]), true),
            (Some(vec![]), false),
        ] {
            st.latest_todos = list;
            rearm(&mut st);
            st.todos_rebuilt_from_task_list_this_turn = rebuilt;
            st.take_reminders();
            assert_eq!(st.todos_turn_end(), None);
            assert_eq!(progress(&st), (0, 0, 0, false));
            assert_eq!(st.take_reminders(), "");
        }
    }

    #[test]
    fn item_actions_map_to_override_statuses() {
        let got: Vec<_> = ["complete", "reopen", "in_progress", "delete"]
            .into_iter()
            .map(|a| TodoItemAction::parse(a).unwrap().override_status())
            .collect();
        assert_eq!(got, ["completed", "pending", "in_progress", "deleted"]);
        for bad in ["", "Complete", "completed", "pending", "deleted", " delete"] {
            assert_eq!(TodoItemAction::parse(bad), None, "{bad:?}");
        }
    }

    fn overrides(pairs: &[(&str, &'static str)]) -> IndexMap<String, &'static str> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect()
    }

    fn override_ids(st: &State) -> Vec<&str> {
        st.manual_todo_overrides
            .keys()
            .map(String::as_str)
            .collect()
    }

    fn todo_write(id: &str, todos: Value, at: f64) -> Value {
        uses(
            json!([{"type": "tool_use", "id": id, "name": "TodoWrite", "input": {"todos": todos}}]),
            at,
        )
    }

    #[test]
    fn overrides_yield_to_live_touches_only() {
        let mut st = todo_state();
        st.manual_todo_overrides = overrides(&[
            ("a", "completed"),
            ("b", "deleted"),
            ("c", "in_progress"),
            ("u", "pending"),
            ("5", "completed"),
            ("d", "completed"),
        ]);
        // Replayed touches predate every surviving override: all kept.
        st.is_replaying = true;
        st.broadcast(todo_write(
            "w0",
            json!([{"id": "a", "content": "A", "status": "pending"}]),
            1.0,
        ));
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "u0", "name": "TaskUpdate", "input": {"taskId": "u", "status": "completed"}}]),
            1.0,
        ));
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "c", "name": "TaskCreate", "input": {"subject": "C"}}]),
            1.0,
        ));
        assert_eq!(override_ids(&st), ["a", "b", "c", "u", "5", "d"]);
        st.is_replaying = false;
        // A live TodoWrite drops the overrides of its non-empty string ids.
        st.broadcast(todo_write(
            "w1",
            json!([{"id": "a", "content": "A", "status": "pending"}, {"id": 5}, {"id": ""}, null, "b"]),
            2.0,
        ));
        assert_eq!(override_ids(&st), ["b", "c", "u", "5", "d"]);
        // One the cutoff bounces drops nothing.
        st.broadcast(todo_write("w2", json!([{"id": "b"}]), 1.5));
        assert_eq!(override_ids(&st), ["b", "c", "u", "5", "d"]);
        // TaskUpdate drops its id even when the list lacks it.
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "u1", "name": "TaskUpdate", "input": {"taskId": "u", "status": "completed"}}]),
            3.0,
        ));
        assert_eq!(override_ids(&st), ["b", "c", "5", "d"]);
        // TaskCreate drops the override under its temp id, unless it's a
        // duplicate that returns first.
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "c", "name": "TaskCreate", "input": {"subject": "C"}},
                   {"type": "tool_use", "id": "d", "name": "TaskCreate", "input": {"subject": "D"}}]),
            4.0,
        ));
        assert_eq!(override_ids(&st), ["b", "c", "5"]);
    }

    #[test]
    fn overrides_follow_promotion_and_survive_a_task_list() {
        let mut st = todo_state();
        let create = |id: &str, at: f64| {
            uses(
                json!([{"type": "tool_use", "id": id, "name": "TaskCreate", "input": {"subject": id}}]),
                at,
            )
        };
        let created = |id: &str, n: &str, at: f64| {
            results(
                json!([{"type": "tool_result", "tool_use_id": id, "content": format!("Task #{n} created successfully: {id}")}]),
                at,
            )
        };
        // Clicked between the tool use and its result: the edit moves to
        // the real id (replacing one already there, in its place; the rest
        // keep their order, as after a JS `delete`).
        st.broadcast(create("toolu_t", 1.0));
        st.manual_todo_overrides = overrides(&[
            ("7", "pending"),
            ("toolu_t", "completed"),
            ("y", "pending"),
            ("z", "deleted"),
        ]);
        st.broadcast(created("toolu_t", "7", 2.0));
        assert_eq!(override_ids(&st), ["7", "y", "z"]);
        assert_eq!(st.manual_todo_overrides["7"], "completed");
        // A failed create or an unparsed result moves nothing.
        st.broadcast(create("toolu_e", 3.0));
        st.manual_todo_overrides
            .insert("toolu_e".into(), "completed");
        st.broadcast(results(
            json!([{"type": "tool_result", "tool_use_id": "toolu_e", "content": "Task #8 created", "is_error": true}]),
            3.0,
        ));
        st.broadcast(create("toolu_q", 3.0));
        st.manual_todo_overrides.insert("toolu_q".into(), "deleted");
        st.broadcast(results(
            json!([{"type": "tool_result", "tool_use_id": "toolu_q", "content": "done"}]),
            3.0,
        ));
        assert_eq!(override_ids(&st), ["7", "y", "z", "toolu_e", "toolu_q"]);
        // On replay too.
        st.is_replaying = true;
        st.broadcast(create("toolu_r", 4.0));
        st.manual_todo_overrides
            .insert("toolu_r".into(), "in_progress");
        st.broadcast(created("toolu_r", "9", 4.0));
        st.is_replaying = false;
        assert_eq!(st.manual_todo_overrides.get("9"), Some(&"in_progress"));
        assert!(!st.manual_todo_overrides.contains_key("toolu_r"));
        // A TaskList rebuild is a read: the edits paint over it.
        st.broadcast(uses(
            json!([{"type": "tool_use", "id": "l", "name": "TaskList", "input": {}}]),
            5.0,
        ));
        st.broadcast(results(
            json!([{"type": "tool_result", "tool_use_id": "l", "content": "#7 [pending] a\n#z [pending] b\n#9 [completed] c\n#4 [pending] d"}]),
            5.0,
        ));
        assert_eq!(
            st.latest_todos,
            Some(vec![
                json!({"id": "7", "content": "a", "status": "completed"}),
                json!({"id": "9", "content": "c", "status": "in_progress"}),
                json!({"id": "4", "content": "d", "status": "pending"}),
            ])
        );
    }

    #[test]
    fn applying_overrides_counts_what_took() {
        let mut st = todo_state();
        st.manual_todo_overrides = overrides(&[
            ("1", "completed"),
            ("2", "deleted"),
            ("9", "pending"),
            ("3", "in_progress"),
            ("8", "deleted"),
        ]);
        assert_eq!(st.apply_manual_todo_overrides(), 0);
        st.latest_todos = Some(vec![]);
        assert_eq!(st.apply_manual_todo_overrides(), 0);
        st.latest_todos = Some(vec![
            json!({"id": "1", "content": "a", "status": "pending", "activeForm": "A"}),
            json!({"id": "2"}),
            json!({"content": "no id"}),
            json!({"id": "3", "content": "c"}),
            json!({"id": "3", "content": "dup"}),
            json!({"id": 9, "status": "pending"}),
        ]);
        // 1, 2 and 3 (once for both copies); 9 and 8 match nothing.
        assert_eq!(st.apply_manual_todo_overrides(), 3);
        let list = st.latest_todos.clone().unwrap();
        assert_eq!(
            list,
            vec![
                json!({"id": "1", "content": "a", "status": "completed", "activeForm": "A"}),
                json!({"content": "no id"}),
                json!({"id": "3", "content": "c", "status": "in_progress"}),
                json!({"id": "3", "content": "dup", "status": "in_progress"}),
                json!({"id": 9, "status": "pending"}),
            ]
        );
        // `{...entry, status}`: an existing key keeps its place, a new one
        // goes last.
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&list[0]), ["id", "content", "status", "activeForm"]);
        assert_eq!(keys(&list[2]), ["id", "content", "status"]);
    }

    #[test]
    fn replayed_edits_flag_the_worktree_once() {
        let mut st = todo_state();
        st.is_replaying = true;
        let edit = |name: &str, input: Value| {
            uses(
                json!([{"type": "tool_use", "id": "e", "name": name, "input": input}]),
                1.0,
            )
        };
        st.broadcast(edit("Edit", json!({"file_path": "/r/src/a.ts"})));
        st.broadcast(edit(
            "Write",
            json!({"file_path": "/r/.claude/worktrees/x/a.ts"}),
        ));
        st.broadcast(edit(
            "MultiEdit",
            json!({"file_path": "/r/.claude/worktrees/x/b.ts"}),
        ));
        // `file_path: ""` is a string, so `notebook_path` isn't consulted.
        st.broadcast(edit(
            "NotebookEdit",
            json!({"file_path": "", "notebook_path": "/r/.claude/worktrees/y/n.ipynb"}),
        ));
        st.broadcast(edit(
            "NotebookEdit",
            json!({"file_path": 3, "notebook_path": "/r/.claude/worktrees/z/n.ipynb"}),
        ));
        st.broadcast(edit(
            "Read",
            json!({"file_path": "/r/.claude/worktrees/w/a.ts"}),
        ));
        let cwds: Vec<&Value> = st
            .buffer
            .iter()
            .filter(|e| e["type"] == "cwd_changed")
            .map(|e| &e["cwd"])
            .collect();
        assert_eq!(
            cwds,
            vec!["/r/.claude/worktrees/x", "/r/.claude/worktrees/z"]
        );
    }

    /// A private Claude Code config dir for this test binary, so nothing
    /// touches the real `~/.claude/projects`.
    fn test_config_dir() -> &'static std::path::Path {
        static DIR: LazyLock<tempfile::TempDir> = LazyLock::new(|| {
            let d = tempfile::tempdir().unwrap();
            assert!(paths::set_config_dir_override(d.path().to_path_buf()));
            d
        });
        DIR.path()
    }

    fn wait_for(what: &str, f: impl Fn() -> bool) {
        let start = std::time::Instant::now();
        while !f() {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "timed out: {what}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// `jsonlResyncBusy`: while a resync is running, the watcher's timer
    /// re-arms instead of starting another; once it's done, the next firing
    /// resyncs; a dropped session stops the timer.
    #[tokio::test]
    async fn a_resync_in_flight_makes_the_watcher_wait() {
        let config = test_config_dir();
        let cwd = tempfile::tempdir().unwrap();
        let cwd = cwd.path().canonicalize().unwrap().display().to_string();
        let id = "0f1e2d3c-4b5a-4968-8776-655443322110";
        let s = Session::new(SessionOptions {
            id: Some(id.into()),
            cwd: Some(cwd.clone()),
            ..Default::default()
        })
        .unwrap();
        let dir = config
            .join("projects")
            .join(paths::sdk_project_dir_name(&cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let line = |uuid: &str| {
            format!(
                "{}\n",
                json!({"type":"user","uuid":uuid,"parentUuid":null,"sessionId":id,"cwd":cwd,
                       "timestamp":"2026-03-04T05:06:07.000Z","message":{"role":"user","content":"x"}})
            )
        };
        std::fs::write(dir.join(format!("{id}.jsonl")), line("r1")).unwrap();
        let weak = Arc::downgrade(&s);
        let has = |uuid: &str| s.with(|st| st.buffer.iter().any(|e| e["message"]["uuid"] == uuid));

        // Hold the state lock so the resync stalls after it marks itself busy
        // (it reads the file, then locks to broadcast). No awaits meanwhile.
        {
            let held = s.st.lock().unwrap();
            assert_eq!(Session::fire_jsonl_resync(&weak), Fired::Started);
            wait_for("resync starts", || {
                s.jsonl_resync_busy.load(Ordering::SeqCst)
            });
            assert_eq!(Session::fire_jsonl_resync(&weak), Fired::Busy);
            drop(held);
        }
        wait_for("resync ends", || {
            !s.jsonl_resync_busy.load(Ordering::SeqCst)
        });
        assert!(has("r1"));

        std::fs::write(dir.join(format!("{id}.jsonl")), line("r1") + &line("r2")).unwrap();
        assert_eq!(Session::fire_jsonl_resync(&weak), Fired::Started);
        wait_for("second resync", || has("r2"));

        drop(s);
        assert_eq!(Session::fire_jsonl_resync(&weak), Fired::Gone);
    }

    #[test]
    fn worktree_detection() {
        assert_eq!(
            worktree_root_from_path("/r/.claude/worktrees/x/a.ts").as_deref(),
            Some("/r/.claude/worktrees/x")
        );
        assert_eq!(worktree_root_from_path("/r/src/a.ts"), None);
    }

    #[test]
    fn decisions_deserialize() {
        let d: PermissionDecision = serde_json::from_value(
            json!({"kind":"allow_always_save","destination":"userSettings"}),
        )
        .unwrap();
        assert_eq!(
            d,
            PermissionDecision::AllowAlwaysSave {
                destination: "userSettings".into()
            }
        );
        let p: PlanDecision =
            serde_json::from_value(json!({"kind":"accept","editedPlan":"x"})).unwrap();
        assert_eq!(
            p,
            PlanDecision::Accept {
                edited_plan: Some("x".into())
            }
        );
        let o: SessionOptions =
            serde_json::from_value(json!({"cwd":"/x","enable1mContext":true,"maxTurns":3}))
                .unwrap();
        assert_eq!(o.enable_1m_context, Some(true));
    }

    /// A private home (the per-project databases) for this test binary.
    fn test_home() -> &'static std::path::Path {
        static DIR: LazyLock<tempfile::TempDir> = LazyLock::new(|| {
            let d = tempfile::tempdir().unwrap();
            assert!(paths::set_home_override(d.path().to_path_buf()));
            d
        });
        DIR.path()
    }

    thread_local! {
        static TASK_CLOCK: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };
    }

    fn pinned_task_clock() -> i64 {
        TASK_CLOCK.with(std::cell::Cell::get)
    }

    /// `backgroundTasks` before the query exists: `no active query` (the
    /// route's 503).
    #[tokio::test]
    async fn background_tasks_need_a_query() {
        test_home();
        test_config_dir();
        let cwd = tempfile::tempdir().unwrap();
        let s = Session::new(SessionOptions {
            cwd: Some(cwd.path().display().to_string()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            s.background_tasks(Some("toolu_1")).await,
            Err("no active query".to_owned())
        );
    }

    /// Replays the capture half of `tests/fixtures/tasks_golden.json`
    /// (rust/scripts/tasks-golden.mjs): the TS `captureTaskState` +
    /// `persistTask` over scripted wire events, `Date.now` pinned per step.
    /// After each step the stored tasks (by id) and the foreground-running /
    /// background counts match.
    #[test]
    fn tasks_golden_capture() {
        let fx: Value =
            serde_json::from_str(include_str!("../tests/fixtures/tasks_golden.json")).unwrap();
        assert_eq!(fx["maxInnerMessages"], MAX_INNER_MESSAGES);
        assert_eq!(fx["throttleMs"], TASK_PERSIST_THROTTLE_MS);
        let cwd = test_home().join("tasks-golden").display().to_string();
        for sc in fx["capture"].as_array().unwrap() {
            let name = sc["name"].as_str().unwrap();
            let sid = format!("golden-capture-{name}");
            let mut st = State {
                state_key: Some((cwd.clone(), sid.clone())),
                task_clock: Some(pinned_task_clock),
                ..todo_state()
            };
            for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
                TASK_CLOCK.with(|c| c.set(step["clock"].as_i64().unwrap()));
                let events: Vec<Value> = match step.get("burst") {
                    Some(b) => {
                        let parent = b["parent"].as_str().unwrap();
                        (0..b["count"].as_u64().unwrap())
                            .map(|n| {
                                json!({"type": "sdk", "at": n, "message":
                                    {"type": "assistant", "parent_tool_use_id": parent, "n": n}})
                            })
                            .collect()
                    }
                    None => step["events"].as_array().unwrap().clone(),
                };
                for ev in &events {
                    st.capture_task_state(ev);
                }
                let mut tasks = session_tasks_db::list_session_tasks(&cwd, &sid);
                tasks.sort_by(|a, b| a.task_id.cmp(&b.task_id));
                let got = Value::Array(tasks.iter().map(TaskEntry::to_json).collect());
                assert_eq!(
                    got.to_string(),
                    step["tasks"].to_string(),
                    "{name} step {i}"
                );
                assert_eq!(
                    st.status() == TurnStatus::Running,
                    step["active"] == true,
                    "{name} step {i}: active"
                );
                assert_eq!(
                    json!(st.background_tasks()),
                    step["background"],
                    "{name} step {i}: background"
                );
            }
        }
    }
}
