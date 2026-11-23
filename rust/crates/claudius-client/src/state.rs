//! `ChatState`: everything `useSession` keeps between renders.
//!
//! # Design
//!
//! The hook is a reducer with side effects. Its state is ~80 `useState`
//! cells plus the `useRef`s its callbacks read; its inputs are SSE
//! messages, user actions, fetch replies and timer expiries; its outputs are
//! the state the UI renders and the I/O it starts. The port keeps exactly
//! that shape, with no React and no I/O:
//!
//! - [`ChatState`] holds every cell and the refs as plain fields. A ref that
//!   mirrors a state cell (`sessionIdRef`, `pendingRef`, `replayingRef`,
//!   `sessionsRef`, `hasMoreAboveRef`, `queueRef`, `pendingPlanRef`,
//!   `modelRef`, the effort mirrors) is that field: the hook writes both
//!   together, or syncs the ref in an effect right after the commit, and
//!   every event is its own commit, so they only differ inside one event
//!   that both writes the cell and reads the ref. The slice that ports such
//!   a reader must check it (no U01c handler is one).
//! - Inputs are methods ([`apply()`](crate::apply::apply) for a
//!   [`ServerEvent`](crate::event::ServerEvent), plus
//!   `on_message`, `fetch_settled`, `timer_fired` and the actions in
//!   `apply.rs`). Each mutates the state in place, as the hook's updaters
//!   would in order, and returns the [`Effect`](crate::effect::Effect)s the hook would have
//!   started, in call order. A `.then()` continuation is a pending entry
//!   keyed by the fetch's id, run by `fetch_settled`; a timer callback is a
//!   [`TimerFn`] keyed by the timer's id, run by `timer_fired`.
//! - [`ChatState::snapshot`] is what the hook returns minus its functions,
//!   with the derived values (`readOnly`, the prompt heads and counts, the
//!   chronologically sorted `messages`, `skippedBootSession`), in the
//!   recorder's snapshot JSON. The golden test compares it after every step.
//! - Types follow what the hook stores. A cell it fills with a value it
//!   built is typed (`bool`, epoch ms as `f64`, [`SessionRecap`]). A cell
//!   it fills straight from an event without checking it holds that JSON:
//!   a [`Field`] (`None` = `undefined`) or a `Value`, so an odd payload
//!   derives what the TS derives (`holder_changed` without `holderId` makes
//!   the tab read-only, as in the TS). Cells owned by later slices are
//!   `Value` / list placeholders with their TS initial values until those
//!   slices type them.
//!
//! U01c drives the simple events (see `apply.rs`), plus what their realistic
//! sequences need from other slices, each flagged where it lives:
//! `replay_done` with the pending-prompts merge (U01k / U01f), the 30 s
//! poll and `refreshSessions` (U01k), and the `requestRecap` /
//! `dismissRecap` actions (U01j). U01d adds the `sdk` messages that build
//! the transcript (`sdk.rs`).

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::api_retry::ApiRetryState;
use crate::boot_guard::{SkippedBoot, scope_skipped_boot};
use crate::effect::{FetchId, FetchOutcome, TimerId};
use crate::effort_wait::{EffortWaitState, NO_EFFORT_WAIT};
use crate::event::{Field, JsObject};
use crate::idle_reconcile::ToolHistoryEntry;
use crate::loops::ScheduledLoop;
use crate::messages::sort_messages_by_chronology;
use crate::prompt_queue::Keyed;
use crate::sdk::DeltaScratch;
use crate::task_status::TaskInfo;
use crate::types::num;
use crate::{
    AgentTodo, BackgroundBash, DisplayMessage, JsRecord, RateLimitInfo, SystemEntry,
    ToolProgressInfo,
};

/// `ChatState["sessionRecap"]["status"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecapStatus {
    Idle,
    Loading,
    Ready,
    Error,
}

/// The "Where were we?" banner. `text` / `at` / `origin` come straight off
/// `session_recap`, and `errorReason` off `session_recap_error`'s `message`
/// (`?? "failed"`).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRecap {
    pub status: RecapStatus,
    pub text: Field,
    pub at: Field,
    pub origin: Field,
    pub error_reason: Field,
}

impl SessionRecap {
    /// `{ status: "idle", text: null, at: null, origin: null, errorReason: null }`.
    pub fn idle() -> Self {
        Self {
            status: RecapStatus::Idle,
            text: Some(Value::Null),
            at: Some(Value::Null),
            origin: Some(Value::Null),
            error_reason: Some(Value::Null),
        }
    }

    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("status".into(), json!(self.status));
        for (k, v) in [
            ("text", &self.text),
            ("at", &self.at),
            ("origin", &self.origin),
            ("errorReason", &self.error_reason),
        ] {
            if let Some(v) = v {
                m.insert(k.into(), v.clone());
            }
        }
        Value::Object(m)
    }
}

/// `GoalState`, built by `goal_changed`. `text` is the event's truthy
/// `goal` as sent; the rest are `?? null` of their fields.
#[derive(Debug, Clone, PartialEq)]
pub struct GoalState {
    pub text: Value,
    pub achieved: bool,
    pub summary: Value,
    pub set_at: Value,
    pub achieved_at: Value,
}

/// A queued interactive prompt (`PermissionRequestEvent`,
/// `AskUserQuestionEvent`, `McpElicitationRequestEvent`) as the server sent
/// it (U01f types them). The queues key on its `requestId`
/// ([`Keyed`]); one that isn't a string reads as `""`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Prompt(pub Value);

impl Keyed for Prompt {
    fn request_id(&self) -> &str {
        self.0
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }
}

/// A timer callback the machine armed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerFn {
    /// The 30 s safety-net poll (`setInterval(..., 30_000)` on mount).
    SessionsPoll,
}

/// What a settled fetch continues with.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Then {
    /// `replay_done`'s `/pending-prompts` merge, for the session bound then.
    PendingPrompts { session_id: String },
    /// `requestRecap`'s POST.
    Recap,
    /// A prompt answer's or mode pick's POST (U01f, `prompts.rs`);
    /// `uncaught`: the hook has no `.catch` on it.
    Answer { uncaught: bool },
    /// One half of a `refreshSessions` (`disk` is `/api/sessions/all`).
    Sessions { op: u64, disk: bool },
    /// A status action's POST (U01i, `status.rs`).
    Status(crate::status::StatusThen),
    /// `loadOlder`'s transcript page (U01h, `system_events.rs`), and the
    /// `jumpToUuid` it pages for, if any.
    Older(Option<crate::system_events::Jump>),
    /// A todo action's POST (U01g, `task_events.rs`).
    Todos(crate::task_events::TodosThen),
    /// A transcript page `task_snapshot`'s orphan hunt asked for (U01g).
    TaskPage(crate::task_events::TaskHunt),
    /// `moveToActiveAccount`'s POST (U01n, `account.rs`).
    Account,
    /// A queue or send action's fetch (U01j, `queue.rs`).
    Queue(crate::queue::QueueThen),
}

/// What runs after a `refreshSessions` settles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AfterRefresh {
    /// The poll: settle a turn the server says is over.
    Poll,
    /// `result`'s `void refreshSessions()`.
    Nothing,
}

/// A `refreshSessions` waiting for its two fetches (`Promise.allSettled`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Refresh {
    pub live: Option<FetchOutcome>,
    pub disk: Option<FetchOutcome>,
    pub then: AfterRefresh,
}

/// The hook's state cells (in declaration order) and the refs its callbacks
/// read. See the module docs.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatState {
    /// `myTabId`: this mount's tab id (`?tabId=` on the stream URL).
    pub my_tab_id: String,
    /// `defaultCwdRef` (U01k).
    pub default_cwd: Option<String>,
    pub session_id: Option<String>,
    pub ready: bool,
    pub transcript_path: Option<String>,
    pub pending: bool,
    /// `turn_status`'s `backgroundTasks ?? 0`, as sent.
    pub background_tasks: Value,
    pub turn_started_at: Option<f64>,
    pub last_turn_completed_at: Option<f64>,
    /// `holder_changed`'s `holderId`, as sent (`None` = `undefined`).
    pub holder_tab_id: Field,
    pub messages: Vec<DisplayMessage>,
    pub system_entries: Vec<SystemEntry>,
    /// U01h.
    pub running_hook: Value,
    /// `runningHookIdRef`: `hook_started`'s `hook_id ?? null`, as sent.
    pub running_hook_id: Value,
    pub needs_input: bool,
    pub tool_progress: JsRecord<ToolProgressInfo>,
    /// U01j.
    pub queue: Vec<Value>,
    /// The prompt FIFOs (U01f); the UI shows each head.
    pub pending_permissions: Vec<Prompt>,
    pub pending_asks: Vec<Prompt>,
    pub pending_elicitations: Vec<Prompt>,
    /// `promptGoneRef`: request ids seen leaving (U01f).
    pub prompt_gone: IndexSet<String>,
    pub feedback_survey: Option<JsObject>,
    pub opus_overload_nudge: Option<JsObject>,
    /// U01h.
    pub api_retry: Option<ApiRetryState>,
    pub long_context_credits_nudge: Option<JsObject>,
    pub auth_failed_nudge: Option<JsObject>,
    pub token_expiring_nudge: Option<JsObject>,
    pub tips: Field,
    pub session_recap: SessionRecap,
    /// Each `error` event's `message` as sent (`undefined` as `null`).
    pub errors: Vec<Value>,
    pub process_exited: bool,
    /// U01k.
    pub create_error: Option<String>,
    /// `InitInfo`'s lists (U01h).
    pub slash_commands: Vec<String>,
    pub agents: Vec<String>,
    pub main_agent: Field,
    pub account: Field,
    /// `subscriptionTypeRef` (U01i).
    pub subscription_type: Value,
    pub skills: Vec<String>,
    /// U01k / U01h.
    pub cwd: Value,
    pub agent_cwd: Field,
    /// The assistant handler's mid-turn estimate, until U01i's
    /// `usage_snapshot` replaces it.
    pub usage: Value,
    pub plan_usage: Value,
    /// U01g.
    pub tasks: JsRecord<TaskInfo>,
    pub live_background_task_ids: Option<IndexSet<String>>,
    pub subagent_messages: JsRecord<Vec<DisplayMessage>>,
    /// U01f (also `pendingPlanRef`).
    pub pending_plan: Value,
    /// U01i.
    pub fast_mode_state: Value,
    pub fast_mode_disabled_reason: Value,
    pub fast_mode_notice: Value,
    pub model_switch_notice: Value,
    pub chat_command_model_notice: Value,
    pub advisor_disabled_notice: Value,
    pub auto_mode_off_notice: Value,
    /// `prevFastModeStateRef` (U01i).
    pub prev_fast_mode_state: Value,
    pub prompt_suggestions: Vec<String>,
    pub suggested_uuids: IndexSet<String>,
    pub goal_uuids: IndexSet<String>,
    /// Also `replayingRef`.
    pub replaying: bool,
    /// U01k.
    pub skipped_boot: Option<SkippedBoot>,
    /// `"live"` / `"reconnecting"` (U01k).
    pub stream_status: &'static str,
    /// `replay_done`'s `hasMoreAbove`, as sent (also `hasMoreAboveRef`).
    pub has_more_above: Field,
    pub loading_older: bool,
    /// U01g.
    pub latest_todos: Vec<AgentTodo>,
    pub todos_stale: Value,
    pub todos_auto_cleared: Value,
    /// U01e.
    pub recent_edits: Vec<crate::user_events::RecentEdit>,
    pub background_bashes: JsRecord<BackgroundBash>,
    /// U01g.
    pub scheduled_loops: JsRecord<ScheduledLoop>,
    /// U01j.
    pub sdk_queued_turns: Value,
    /// U01e. `turn_status: idle` marks every entry done.
    pub tool_history: Vec<ToolHistoryEntry>,
    pub session_title: Value,
    pub goal: Option<GoalState>,
    /// The picker mirrors (U01i).
    pub permission_mode: Field,
    pub model: Value,
    pub effort: Value,
    pub applied_effort: Field,
    /// `effortWaitRef`, and `effortChangeWaits` is its `waits`.
    pub effort_wait: EffortWaitState,
    pub effort_change_waits: bool,
    pub ultracode: bool,
    pub fast_mode: bool,
    pub advisor_model: Option<String>,
    /// The polled list (U01k), as merged from the two endpoints.
    pub sessions: Vec<Value>,
    pub accounts_configured: f64,
    // ---- refs the SSE / replay lifecycle reads (U01k) ----
    pub reconnect_timer: Option<TimerId>,
    pub reconnect_attempts: u32,
    pub stream_down_since: Option<f64>,
    pub badge_timer: Option<TimerId>,
    pub switch_gen: u64,
    /// `document.hidden`, which the host keeps current.
    pub hidden: bool,
    // ---- refs the message reducer reads (U01d, U01e, U01h) ----
    /// `scratchRef`: per-message stream delta scratch.
    pub scratch: IndexMap<String, DeltaScratch>,
    /// `lastAssistantUuidRef`: what new system entries anchor after.
    pub last_assistant_uuid: String,
    pub counted_usage: IndexSet<String>,
    pub last_rate_limit_info: Option<RateLimitInfo>,
    /// `fallbackModelRef`: `ready`'s `fallbackModel ?? null`, as sent.
    pub fallback_model: Value,
    pub seen_result_uuids: IndexSet<String>,
    pub handled_fast_credits_notice_uuids: IndexSet<String>,
    pub pending_compact: bool,
    pub seen_compact_slash_uuids: IndexSet<String>,
    pub applied_wakeup_stops: IndexSet<String>,
    pub scope_message_id: IndexMap<String, String>,
    // ---- the machine's own bookkeeping ----
    pub(crate) next_fetch: u64,
    pub(crate) next_timer: u64,
    pub(crate) next_refresh: u64,
    pub(crate) in_flight: IndexMap<FetchId, Then>,
    pub(crate) refreshes: IndexMap<u64, Refresh>,
    /// Armed timers: the callback, and whether it repeats (an interval).
    pub(crate) timers: IndexMap<TimerId, (TimerFn, bool)>,
}

impl ChatState {
    /// The state of a fresh mount (every cell at its TS initial value),
    /// for the tab `my_tab_id`.
    pub fn new(my_tab_id: impl Into<String>) -> Self {
        Self {
            my_tab_id: my_tab_id.into(),
            default_cwd: None,
            session_id: None,
            ready: false,
            transcript_path: None,
            pending: false,
            background_tasks: json!(0),
            turn_started_at: None,
            last_turn_completed_at: None,
            holder_tab_id: Some(Value::Null),
            messages: Vec::new(),
            system_entries: Vec::new(),
            running_hook: Value::Null,
            running_hook_id: Value::Null,
            needs_input: false,
            tool_progress: JsRecord::new(),
            queue: Vec::new(),
            pending_permissions: Vec::new(),
            pending_asks: Vec::new(),
            pending_elicitations: Vec::new(),
            prompt_gone: IndexSet::new(),
            feedback_survey: None,
            opus_overload_nudge: None,
            api_retry: None,
            long_context_credits_nudge: None,
            auth_failed_nudge: None,
            token_expiring_nudge: None,
            tips: Some(json!([])),
            session_recap: SessionRecap::idle(),
            errors: Vec::new(),
            process_exited: false,
            create_error: None,
            slash_commands: Vec::new(),
            agents: Vec::new(),
            main_agent: Some(Value::Null),
            account: Some(Value::Null),
            subscription_type: Value::Null,
            skills: Vec::new(),
            cwd: Value::Null,
            agent_cwd: Some(Value::Null),
            usage: Value::Null,
            plan_usage: Value::Null,
            tasks: JsRecord::new(),
            live_background_task_ids: None,
            subagent_messages: JsRecord::new(),
            pending_plan: Value::Null,
            fast_mode_state: Value::Null,
            fast_mode_disabled_reason: Value::Null,
            fast_mode_notice: Value::Null,
            model_switch_notice: Value::Null,
            chat_command_model_notice: Value::Null,
            advisor_disabled_notice: Value::Null,
            auto_mode_off_notice: Value::Null,
            prev_fast_mode_state: Value::Null,
            prompt_suggestions: Vec::new(),
            suggested_uuids: IndexSet::new(),
            goal_uuids: IndexSet::new(),
            replaying: true,
            skipped_boot: None,
            stream_status: "live",
            has_more_above: Some(Value::Bool(false)),
            loading_older: false,
            latest_todos: Vec::new(),
            todos_stale: Value::Bool(false),
            todos_auto_cleared: Value::Null,
            recent_edits: Vec::new(),
            background_bashes: JsRecord::new(),
            scheduled_loops: JsRecord::new(),
            sdk_queued_turns: json!(0),
            tool_history: Vec::new(),
            session_title: Value::Null,
            goal: None,
            permission_mode: Some(json!("default")),
            model: Value::Null,
            effort: json!("auto"),
            applied_effort: None,
            effort_wait: NO_EFFORT_WAIT,
            effort_change_waits: false,
            ultracode: false,
            fast_mode: false,
            advisor_model: None,
            sessions: Vec::new(),
            accounts_configured: 0.0,
            reconnect_timer: None,
            reconnect_attempts: 0,
            stream_down_since: None,
            badge_timer: None,
            switch_gen: 0,
            hidden: false,
            scratch: IndexMap::new(),
            last_assistant_uuid: String::new(),
            counted_usage: IndexSet::new(),
            last_rate_limit_info: None,
            fallback_model: Value::Null,
            seen_result_uuids: IndexSet::new(),
            handled_fast_credits_notice_uuids: IndexSet::new(),
            pending_compact: false,
            seen_compact_slash_uuids: IndexSet::new(),
            applied_wakeup_stops: IndexSet::new(),
            scope_message_id: IndexMap::new(),
            next_fetch: 0,
            next_timer: 0,
            next_refresh: 0,
            in_flight: IndexMap::new(),
            refreshes: IndexMap::new(),
            timers: IndexMap::new(),
        }
    }

    /// `readOnly`: another tab holds the write lock (`holderTabId !== null
    /// && holderTabId !== myTabId`; `undefined` counts as another tab).
    pub fn read_only(&self) -> bool {
        match &self.holder_tab_id {
            Some(Value::Null) => false,
            Some(Value::String(s)) => *s != self.my_tab_id,
            _ => true,
        }
    }

    /// `skippedBootSession`: the skipped session's id while the fresh one it
    /// was skipped for is bound (`scopeSkippedBoot(skippedBoot, sessionId)?.id
    /// ?? null`).
    pub fn skipped_boot_session(&self) -> Option<String> {
        scope_skipped_boot(self.skipped_boot.clone(), self.session_id.as_deref()).map(|b| b.id)
    }

    /// The timer callbacks armed now.
    pub fn armed_timers(&self) -> impl Iterator<Item = (TimerId, TimerFn)> + '_ {
        self.timers.iter().map(|(id, (f, _))| (*id, *f))
    }

    /// What `useSession()` returns minus its actions, in snapshot JSON (the
    /// hook's key order; a top-level `undefined` is `{"$undefined": true}`,
    /// `Record`s are `[key, value]` pairs, `Set`s arrays).
    pub fn snapshot(&self) -> Value {
        fn ser<T: Serialize + ?Sized>(v: &T) -> Value {
            serde_json::to_value(v).expect("snapshot types serialize")
        }
        fn field(f: &Field) -> Value {
            f.clone().unwrap_or_else(|| json!({ "$undefined": true }))
        }
        fn time(t: Option<f64>) -> Value {
            t.map_or(Value::Null, num::to_value)
        }
        fn record<T: Serialize>(r: &JsRecord<T>) -> Value {
            Value::Array(r.iter().map(|(k, v)| json!([k, ser(v)])).collect())
        }
        fn opt<T: Serialize>(v: &Option<T>) -> Value {
            v.as_ref().map_or(Value::Null, ser)
        }
        fn set(s: &IndexSet<String>) -> Value {
            Value::Array(s.iter().map(|x| Value::String(x.clone())).collect())
        }
        fn head(list: &[Prompt]) -> Value {
            list.first().map_or(Value::Null, |p| p.0.clone())
        }
        let mut messages = self.messages.clone();
        sort_messages_by_chronology(&mut messages);
        let goal = self.goal.as_ref().map_or(Value::Null, |g| {
            json!({
                "text": g.text,
                "achieved": g.achieved,
                "summary": g.summary,
                "setAt": g.set_at,
                "achievedAt": g.achieved_at,
            })
        });
        let entries: [(&str, Value); 79] = [
            ("sessionId", opt(&self.session_id)),
            ("ready", json!(self.ready)),
            ("pending", json!(self.pending)),
            ("backgroundTasks", self.background_tasks.clone()),
            ("turnStartedAt", time(self.turn_started_at)),
            ("lastTurnCompletedAt", time(self.last_turn_completed_at)),
            ("readOnly", json!(self.read_only())),
            ("messages", ser(&messages)),
            ("systemEntries", ser(&self.system_entries)),
            ("runningHook", self.running_hook.clone()),
            ("needsInput", json!(self.needs_input)),
            ("toolProgress", record(&self.tool_progress)),
            ("queue", ser(&self.queue)),
            ("pendingPermission", head(&self.pending_permissions)),
            (
                "pendingPermissionCount",
                json!(self.pending_permissions.len()),
            ),
            ("pendingAsk", head(&self.pending_asks)),
            ("pendingAskCount", json!(self.pending_asks.len())),
            ("pendingElicitation", head(&self.pending_elicitations)),
            (
                "pendingElicitationCount",
                json!(self.pending_elicitations.len()),
            ),
            ("feedbackSurvey", opt(&self.feedback_survey)),
            ("opusOverloadNudge", opt(&self.opus_overload_nudge)),
            ("apiRetry", opt(&self.api_retry)),
            (
                "longContextCreditsNudge",
                opt(&self.long_context_credits_nudge),
            ),
            ("authFailedNudge", opt(&self.auth_failed_nudge)),
            ("tokenExpiringNudge", opt(&self.token_expiring_nudge)),
            ("tips", field(&self.tips)),
            ("sessionRecap", self.session_recap.to_value()),
            ("errors", ser(&self.errors)),
            ("processExited", json!(self.process_exited)),
            ("createError", opt(&self.create_error)),
            ("slashCommands", ser(&self.slash_commands)),
            ("agents", ser(&self.agents)),
            ("mainAgent", field(&self.main_agent)),
            ("account", field(&self.account)),
            ("transcriptPath", opt(&self.transcript_path)),
            ("skippedBootSession", opt(&self.skipped_boot_session())),
            (
                "accountsConfigured",
                num::to_value(self.accounts_configured),
            ),
            ("permissionMode", field(&self.permission_mode)),
            ("model", self.model.clone()),
            ("effort", self.effort.clone()),
            ("appliedEffort", field(&self.applied_effort)),
            ("effortChangeWaits", json!(self.effort_change_waits)),
            ("ultracode", json!(self.ultracode)),
            ("fastMode", json!(self.fast_mode)),
            ("advisorModel", opt(&self.advisor_model)),
            ("sessions", ser(&self.sessions)),
            ("skills", ser(&self.skills)),
            ("cwd", self.cwd.clone()),
            ("agentCwd", field(&self.agent_cwd)),
            ("usage", self.usage.clone()),
            ("planUsage", self.plan_usage.clone()),
            ("tasks", record(&self.tasks)),
            (
                "liveBackgroundTaskIds",
                self.live_background_task_ids
                    .as_ref()
                    .map_or(Value::Null, set),
            ),
            ("subagentMessages", record(&self.subagent_messages)),
            ("pendingPlan", self.pending_plan.clone()),
            ("fastModeState", self.fast_mode_state.clone()),
            (
                "fastModeDisabledReason",
                self.fast_mode_disabled_reason.clone(),
            ),
            ("fastModeNotice", self.fast_mode_notice.clone()),
            ("modelSwitchNotice", self.model_switch_notice.clone()),
            (
                "chatCommandModelNotice",
                self.chat_command_model_notice.clone(),
            ),
            (
                "advisorDisabledNotice",
                self.advisor_disabled_notice.clone(),
            ),
            ("autoModeOffNotice", self.auto_mode_off_notice.clone()),
            ("promptSuggestions", ser(&self.prompt_suggestions)),
            ("suggestedUuids", set(&self.suggested_uuids)),
            ("goalUuids", set(&self.goal_uuids)),
            ("replaying", json!(self.replaying)),
            ("streamStatus", json!(self.stream_status)),
            ("hasMoreAbove", field(&self.has_more_above)),
            ("loadingOlder", json!(self.loading_older)),
            ("latestTodos", ser(&self.latest_todos)),
            ("todosStale", self.todos_stale.clone()),
            ("recentEdits", ser(&self.recent_edits)),
            ("backgroundBashes", record(&self.background_bashes)),
            ("scheduledLoops", record(&self.scheduled_loops)),
            ("sdkQueuedTurns", self.sdk_queued_turns.clone()),
            ("toolHistory", ser(&self.tool_history)),
            ("sessionTitle", self.session_title.clone()),
            ("goal", goal),
            ("todosAutoCleared", self.todos_auto_cleared.clone()),
        ];
        Value::Object(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_is_strict_inequality_with_this_tab() {
        let mut s = ChatState::new("tab-1");
        assert!(!s.read_only());
        s.holder_tab_id = Some(json!("tab-1"));
        assert!(!s.read_only());
        s.holder_tab_id = Some(json!("tab-2"));
        assert!(s.read_only());
        s.holder_tab_id = None;
        assert!(s.read_only());
        s.holder_tab_id = Some(json!(1));
        assert!(s.read_only());
    }

    #[test]
    fn skipped_boot_is_scoped_to_the_fresh_session() {
        let mut s = ChatState::new("tab-1");
        let old = || Some("old".to_owned());
        assert_eq!(s.skipped_boot_session(), None);
        s.skipped_boot = Some(SkippedBoot {
            id: "old".into(),
            fresh_id: None,
        });
        assert_eq!(s.skipped_boot_session(), old());
        s.session_id = Some("old".into());
        assert_eq!(s.skipped_boot_session(), None);
        s.session_id = Some("other".into());
        assert_eq!(s.skipped_boot_session(), old());
        s.skipped_boot.as_mut().unwrap().fresh_id = Some("fresh".into());
        assert_eq!(s.skipped_boot_session(), None);
        s.session_id = Some("fresh".into());
        assert_eq!(s.skipped_boot_session(), old());
        // `!boundId`: an empty id counts as nothing bound yet.
        s.session_id = Some(String::new());
        assert_eq!(s.skipped_boot_session(), old());
    }

    #[test]
    fn the_snapshot_sorts_messages_by_time() {
        use crate::{DisplayBlock, Role};
        let mut s = ChatState::new("tab-1");
        for (uuid, at) in [("late", 20.0), ("early", 10.0)] {
            let mut m = DisplayMessage::new(uuid, Role::User, vec![DisplayBlock::text("x")]);
            m.created_at = Some(at);
            s.messages.push(m);
        }
        let snap = s.snapshot();
        let uuids: Vec<&str> = snap["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["uuid"].as_str().unwrap())
            .collect();
        assert_eq!(uuids, ["early", "late"]);
        assert_eq!(s.messages[0].uuid, "late", "the state keeps arrival order");
    }

    #[test]
    fn a_fresh_snapshot_has_every_key_once() {
        let snap = ChatState::new("tab-1").snapshot();
        let keys = snap.as_object().unwrap();
        assert_eq!(keys.len(), 79);
        assert_eq!(keys["appliedEffort"], json!({ "$undefined": true }));
        assert_eq!(keys["readOnly"], json!(false));
    }
}
