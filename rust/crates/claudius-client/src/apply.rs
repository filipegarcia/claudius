//! The reducer: `useSession`'s `applyEvent` and the callbacks around it, as
//! methods on [`ChatState`] that return the [`Effect`]s the hook would
//! start (see the `state` module for the design).
//!
//! Ported so far (U01c): `ready`, `holder_changed`, `error`, `cwd_changed`,
//! `session_title`, `goal_changed`, `account_changed`, `agent_changed`,
//! `mode_changed`, `tips`, `feedback_survey`, the four nudges, the two MCP
//! notices, `session_recap`, `session_recap_error` and `turn_status`
//! (with `setPendingTracked` and `reconcileToIdle`). Ported ahead of their
//! slices because realistic sequences need them: `replay_done` and its
//! `/pending-prompts` merge (U01k / U01f), the 30 s poll and
//! `refreshSessions` (U01k, in `refresh.rs`), and the `requestRecap` /
//! `dismissRecap` actions (U01j). U01d: the `sdk` event's `assistant`,
//! `stream_event`, `result` and `prompt_suggestion` messages (`sdk.rs`).
//! U01h: `system`, `conversation_reset`, `rate_limit_event`,
//! `session_snapshot`, `loadOlder` and `jumpToUuid` (`system_events.rs`).
//! U01g: `task_snapshot`, `todos_auto_cleared` and the todo actions
//! (`task_events.rs`).
//! U01j: `queue:updated` and the send / queue actions (`queue.rs`).
//! U01k: the stream's callbacks (`stream.rs`) and the mount, boot, switch
//! and create inputs (`lifecycle.rs`); every input ends with the hook's
//! commit effects (`ChatState::commit` in `lifecycle.rs`).
//! Every other event is accepted and ignored until its slice lands.

use serde_json::{Value, json};

use crate::compact::next_transcript_path;
use crate::effect::{Effect, FetchId, FetchOutcome, FetchRequest, TimerId};
use crate::effort_wait::NO_EFFORT_WAIT;
use crate::event::{
    Field, GoalChangedEvent, McpNoticeEvent, ReadyEvent, ServerEvent, SessionRecapErrorEvent,
    TurnStatusEvent,
};
use crate::idle_reconcile::{clear_streaming, sweep_tool_history_done};
use crate::prompt_queue::merge_server_prompts;
use crate::prompts::PromptKind;
use crate::state::{
    AfterRefresh, ChatState, GoalState, Prompt, RecapStatus, SessionRecap, Then, TimerFn,
};
use crate::text::{prop, push_js, strict_eq, to_js_string, truthy};
use crate::{ClientEnv, JsThrow, SystemEntry, SystemEntryKind};

/// One input's run: the environment it reads and the effects it starts.
pub(crate) struct Cx<'a> {
    pub env: &'a mut dyn ClientEnv,
    pub out: Vec<Effect>,
}

impl<'a> Cx<'a> {
    pub fn new(env: &'a mut dyn ClientEnv) -> Self {
        Self {
            env,
            out: Vec::new(),
        }
    }
}

/// Feed one server event through the reducer (`applyEvent`). A handler
/// that throws in the TS ends with [`Effect::BadPayload`], with what it set
/// before the throw kept.
pub fn apply(state: &mut ChatState, ev: ServerEvent, env: &mut dyn ClientEnv) -> Vec<Effect> {
    let mut cx = Cx::new(env);
    if let Err(error) = state.apply_event(ev, &mut cx) {
        cx.out.push(Effect::BadPayload { error });
    }
    state.commit(&mut cx);
    cx.out
}

/// `?? null`.
fn or_null(f: Field) -> Value {
    f.unwrap_or(Value::Null)
}

fn is_str(f: &Field, s: &str) -> bool {
    strict_eq(f.as_ref(), Some(&Value::String(s.to_owned())))
}

impl ChatState {
    /// [`apply()`] as a method.
    pub fn apply(&mut self, ev: ServerEvent, env: &mut dyn ClientEnv) -> Vec<Effect> {
        apply(self, ev, env)
    }

    /// `es.onmessage`: parse the SSE message's `data` and apply it; text
    /// that isn't JSON ends with [`Effect::BadPayload`] (V8's `SyntaxError`).
    pub fn on_message(&mut self, data: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        match ServerEvent::parse(data) {
            Ok(ev) => apply(self, ev, env),
            Err(error) => vec![Effect::BadPayload { error }],
        }
    }

    /// A fetch the machine started settled.
    pub fn fetch_settled(
        &mut self,
        id: FetchId,
        outcome: FetchOutcome,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        if let Some(pending) = self.in_flight.shift_remove(&id) {
            match pending {
                Then::PendingPrompts { session_id } => {
                    self.merge_pending_prompts(&session_id, &outcome);
                }
                Then::Recap => {
                    // `if (!res.ok)` and the `catch` both drop back to idle.
                    if !outcome.ok() {
                        self.session_recap = SessionRecap::idle();
                    }
                }
                Then::Sessions { op, disk } => self.refresh_half(op, disk, outcome, &mut cx),
                Then::Answer { uncaught } => self.answer_settled(uncaught, &outcome, &mut cx),
                Then::Status(then) => self.status_settled(then, &outcome, &mut cx),
                Then::Older(jump) => self.older_settled(jump, &outcome, &mut cx),
                Then::Account => self.account_settled(&outcome, &mut cx),
                Then::Queue(then) => self.queue_settled(then, &outcome, &mut cx),
                Then::Todos(then) => self.todos_settled(then, &outcome, &mut cx),
                Then::TaskPage(hunt) => self.task_page_settled(hunt, &outcome, &mut cx),
                Then::Life(then) => self.life_settled(then, outcome, &mut cx),
            }
        }
        self.commit(&mut cx);
        cx.out
    }

    /// A timer the machine armed went off.
    pub fn timer_fired(&mut self, id: TimerId, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(&(f, repeat)) = self.timers.get(&id) else {
            return cx.out;
        };
        // A timeout is spent once it fires; an interval stays armed.
        if !repeat {
            self.timers.shift_remove(&id);
        }
        match f {
            TimerFn::SessionsPoll => self.sessions_poll(&mut cx),
            TimerFn::StreamRecovery => self.stream_recovery_fired(&mut cx),
            TimerFn::ReconnectBadge => self.reconnect_badge_fired(),
            TimerFn::PromptSeed { wait } => self.prompt_seed_fired(wait, &mut cx),
            TimerFn::UrlWriter => self.url_write_fired(&mut cx),
        }
        self.commit(&mut cx);
        cx.out
    }

    // ---------------------------------------------------------- actions

    /// `requestRecap(origin = "manual")` (U01j): show the spinner and ask
    /// the server; `session_recap` / `session_recap_error` settle it.
    pub fn request_recap(&mut self, origin: Option<&str>, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        let origin = origin.unwrap_or("manual");
        self.session_recap.status = RecapStatus::Loading;
        self.session_recap.origin = Some(json!(origin));
        let body = claudius_agent::js::stringify(&json!({ "origin": origin }));
        self.fetch(
            &mut cx,
            "POST",
            format!("/api/sessions/{id}/recap"),
            vec![("content-type", "application/json")],
            Some(body),
            Then::Recap,
        );
        cx.out
    }

    /// `dismissRecap()` (U01j).
    pub fn dismiss_recap(&mut self) {
        self.session_recap = SessionRecap::idle();
    }

    // ---------------------------------------------------------- plumbing

    /// Start a fetch whose result continues with `then`.
    pub(crate) fn fetch(
        &mut self,
        cx: &mut Cx<'_>,
        method: &'static str,
        url: String,
        headers: Vec<(&'static str, &'static str)>,
        body: Option<String>,
        then: Then,
    ) {
        self.next_fetch += 1;
        let id = FetchId(self.next_fetch);
        self.in_flight.insert(id, then);
        cx.out.push(Effect::Fetch(FetchRequest {
            id,
            method,
            url,
            headers,
            body,
        }));
    }

    /// `setInterval(fn, ms)` / `setTimeout(fn, ms)`.
    pub(crate) fn set_timer(
        &mut self,
        cx_out: &mut Vec<Effect>,
        f: TimerFn,
        ms: f64,
        repeat: bool,
    ) -> TimerId {
        self.next_timer += 1;
        let id = TimerId(self.next_timer);
        self.timers.insert(id, (f, repeat));
        cx_out.push(Effect::SetTimer { id, ms, repeat });
        id
    }

    /// `clearTimeout(id)` / `clearInterval(id)`: an effect only while the
    /// timer is armed (clearing a spent or unknown id does nothing).
    pub(crate) fn clear_timer(&mut self, out: &mut Vec<Effect>, id: TimerId) {
        if self.timers.shift_remove(&id).is_some() {
            out.push(Effect::ClearTimer { id });
        }
    }

    /// `setPendingTracked`: stamp the turn edges, drop a "may wait" effort
    /// note once the turn is over, and set `pending`.
    pub(crate) fn set_pending_tracked(&mut self, p: bool, cx: &mut Cx<'_>) {
        if p != self.pending {
            let now = cx.env.now_ms();
            if p {
                self.turn_started_at = Some(now);
            } else {
                self.turn_started_at = None;
                self.last_turn_completed_at = Some(now);
            }
        }
        if !p && self.effort_wait.in_force.is_some() {
            self.effort_wait = NO_EFFORT_WAIT;
            self.effort_change_waits = false;
        }
        self.pending = p;
    }

    /// `reconcileToIdle`: the turn is over, so nothing is streaming or
    /// running any more.
    pub(crate) fn reconcile_to_idle(&mut self, cx: &mut Cx<'_>) {
        clear_streaming(&mut self.messages);
        sweep_tool_history_done(&mut self.tool_history, cx.env.now_ms());
        self.tool_progress.clear();
    }

    // ---------------------------------------------------------- events

    fn apply_event(&mut self, ev: ServerEvent, cx: &mut Cx<'_>) -> Result<(), JsThrow> {
        match ev {
            ServerEvent::Ready(r) => self.on_ready(r),
            ServerEvent::HolderChanged(e) => self.holder_tab_id = e.holder_id,
            ServerEvent::Error(e) => {
                self.errors.push(or_null(e.message));
                if truthy(e.session_ended.as_ref()) {
                    self.process_exited = true;
                }
                self.set_pending_tracked(false, cx);
            }
            ServerEvent::FeedbackSurvey(e) => self.feedback_survey = Some(e),
            ServerEvent::OpusOverloadNudge(e) => self.opus_overload_nudge = Some(e),
            ServerEvent::LongContextCreditsRequired(e) => {
                self.long_context_credits_nudge = Some(e);
            }
            ServerEvent::AuthFailedRequired(e) => self.auth_failed_nudge = Some(e),
            ServerEvent::TokenExpiringRequired(e) => self.token_expiring_nudge = Some(e),
            ServerEvent::McpNeedsAuthNotice(e) => {
                self.mcp_notice(e, ("server needs", "servers need"), "auth", "connect", cx)?;
            }
            ServerEvent::McpDisconnectedNotice(e) => {
                self.mcp_notice(e, ("server is", "servers are"), "unavailable", "check", cx)?;
            }
            ServerEvent::Tips(e) => self.tips = e.tips,
            ServerEvent::SessionRecap(e) => {
                self.session_recap = SessionRecap {
                    status: RecapStatus::Ready,
                    text: e.text,
                    at: e.at,
                    origin: e.origin,
                    error_reason: Some(Value::Null),
                };
            }
            ServerEvent::SessionRecapError(e) => self.on_recap_error(e),
            ServerEvent::ModeChanged(e) => self.permission_mode = e.mode,
            ServerEvent::AccountChanged(e) => self.account = e.account,
            ServerEvent::AgentChanged(e) => self.main_agent = e.agent,
            ServerEvent::SessionTitle(e) => self.session_title = or_null(e.title),
            ServerEvent::GoalChanged(e) => self.on_goal(e),
            ServerEvent::TurnStatus(e) => self.on_turn_status(e, cx),
            ServerEvent::CwdChanged(e) => self.agent_cwd = e.cwd,
            ServerEvent::PermissionRequest(e) => self.on_prompt(PromptKind::Permission, e),
            ServerEvent::AskUserQuestion(e) => self.on_prompt(PromptKind::Ask, e),
            ServerEvent::McpElicitationRequest(e) => self.on_prompt(PromptKind::Elicitation, e),
            ServerEvent::PromptSettled(e) => self.on_prompt_settled(e),
            ServerEvent::PlanApprovalRequest(e) => self.on_plan_request(e),
            ServerEvent::ReplayDone(e) => {
                self.replaying = false;
                self.has_more_above = e.has_more_above;
                self.catching_up = false;
                // Replayed history isn't streaming any more.
                clear_streaming(&mut self.messages);
                self.set_pending_tracked(false, cx);
                if let Some(id) = self.session_id.clone() {
                    self.fetch(
                        cx,
                        "GET",
                        format!("/api/sessions/{id}/pending-prompts"),
                        Vec::new(),
                        None,
                        Then::PendingPrompts { session_id: id },
                    );
                }
            }
            // `ev.type` of `null` throws before any branch.
            ServerEvent::Unknown(Value::Null) => {
                return Err(JsThrow::read_of_null("type"));
            }
            ServerEvent::Unknown(_) | ServerEvent::AccountAutoRotated(_) => {}
            ServerEvent::Sdk(e) => self.on_sdk(e, cx)?,
            ServerEvent::UsageSnapshot(e) => self.on_usage_snapshot(&e),
            ServerEvent::PlanUsage(e) => self.on_plan_usage(&e),
            ServerEvent::PlanUsageUnavailable(_) => self.on_plan_usage_unavailable(),
            ServerEvent::EffortApplied(e) => self.on_effort_applied(&e),
            ServerEvent::ModelChanged(e) => self.on_model_changed(&e, cx),
            ServerEvent::AdvisorDisabledOnModelChange(e) => self.on_advisor_disabled(&e, cx),
            ServerEvent::SessionSnapshot(e) => self.on_session_snapshot(&e)?,
            ServerEvent::QueueUpdated(e) => self.on_queue_updated(&e)?,
            ServerEvent::TaskSnapshot(e) => self.on_task_snapshot(&e, cx)?,
            ServerEvent::TodosAutoCleared(e) => self.on_todos_auto_cleared(&e, cx),
        }
        Ok(())
    }

    fn on_ready(&mut self, r: ReadyEvent) {
        self.ready = true;
        // `nextTranscriptPath` reads `"transcriptPath" in ev`.
        let probe = match &r.transcript_path {
            None => json!({}),
            Some(v) => json!({ "transcriptPath": v }),
        };
        if let Ok(next) = next_transcript_path(self.transcript_path.as_deref(), &probe) {
            self.transcript_path = next;
        }
        self.main_agent = Some(or_null(r.agent));
        self.account = Some(or_null(r.account));
        self.fallback_model = or_null(r.fallback_model);
    }

    fn on_goal(&mut self, e: GoalChangedEvent) {
        self.goal = match e.goal {
            Some(text) if claudius_agent::js::truthy(&text) => Some(GoalState {
                text,
                achieved: truthy(e.achieved.as_ref()),
                summary: or_null(e.summary),
                set_at: or_null(e.set_at),
                achieved_at: or_null(e.achieved_at),
            }),
            _ => None,
        };
    }

    fn on_recap_error(&mut self, e: SessionRecapErrorEvent) {
        // Only a request this tab is waiting on settles: a recap already on
        // screen stays.
        if self.session_recap.status != RecapStatus::Loading {
            return;
        }
        if is_str(&e.reason, "failed") {
            let reason = match e.message {
                None | Some(Value::Null) => json!("failed"),
                Some(v) => v,
            };
            self.session_recap = SessionRecap {
                status: RecapStatus::Error,
                text: Some(Value::Null),
                at: Some(Value::Null),
                origin: self.session_recap.origin.take(),
                error_reason: Some(reason),
            };
        } else {
            self.session_recap = SessionRecap::idle();
        }
    }

    fn on_turn_status(&mut self, e: TurnStatusEvent, cx: &mut Cx<'_>) {
        self.set_pending_tracked(is_str(&e.status, "running"), cx);
        self.needs_input = is_str(&e.status, "needs_input");
        clear_pending_messages(&mut self.messages);
        self.background_tasks = match e.background_tasks {
            None | Some(Value::Null) => json!(0),
            Some(v) => v,
        };
        if is_str(&e.status, "idle") {
            self.reconcile_to_idle(cx);
        }
    }

    /// The MCP notices: an info pill after the last assistant message
    /// (`MCP <word> <what>: <names> \u{b7} open /mcp to <verb>`).
    fn mcp_notice(
        &mut self,
        e: McpNoticeEvent,
        (one, many): (&str, &str),
        what: &str,
        verb: &str,
        cx: &mut Cx<'_>,
    ) -> Result<(), JsThrow> {
        // `ev.servers.length`, then `ev.servers.join(", ")`.
        let servers = match e.servers {
            None => {
                return Err(JsThrow::type_error(
                    "Cannot read properties of undefined (reading 'length')",
                ));
            }
            Some(Value::Null) => return Err(JsThrow::read_of_null("length")),
            Some(Value::Array(items)) => items,
            Some(_) => {
                return Err(JsThrow::type_error("ev.servers.join is not a function"));
            }
        };
        let mut names = String::new();
        for (i, s) in servers.iter().enumerate() {
            if i > 0 {
                names.push_str(", ");
            }
            if !s.is_null() {
                push_js(&mut names, &to_js_string(s)?);
            }
        }
        let word = if servers.len() == 1 { one } else { many };
        let label = format!("MCP {word} {what}: {names} \u{b7} open /mcp to {verb}");
        let uuid = cx.env.random_uuid();
        self.system_entries.push(SystemEntry::new(
            uuid,
            self.last_assistant_uuid.clone(),
            SystemEntryKind::Info,
            label,
        ));
        Ok(())
    }

    /// `replay_done`'s `/pending-prompts` reply: merge each list the server
    /// sent into its queue, unless the user switched away meanwhile.
    fn merge_pending_prompts(&mut self, session_id: &str, outcome: &FetchOutcome) {
        if !outcome.ok() {
            return;
        }
        // `res.json().catch(() => ({}))`.
        let body = outcome.json().unwrap_or_else(|| json!({}));
        if self.session_id.as_deref() != Some(session_id) {
            return;
        }
        // Destructuring `null` throws into the `.catch`; `prop` reads no
        // list off it either.
        let gone = &self.prompt_gone;
        for (key, queue) in [
            ("asks", &mut self.pending_asks),
            ("permissions", &mut self.pending_permissions),
            ("elicitations", &mut self.pending_elicitations),
        ] {
            if let Some(Value::Array(server)) = prop(Some(&body), key) {
                let server: Vec<Prompt> = server.iter().cloned().map(Prompt).collect();
                merge_server_prompts(queue, &server, gone);
            }
        }
    }
}

/// `clearPendingMessages` (lib/client/clear-pending.ts, not one of U01b's
/// modules).
fn clear_pending_messages(messages: &mut [crate::DisplayMessage]) {
    for m in messages {
        if m.pending == Some(true) {
            m.pending = Some(false);
        }
    }
}

impl AfterRefresh {
    pub(crate) fn run(self, state: &mut ChatState, merged: &[Value], cx: &mut Cx<'_>) {
        match self {
            AfterRefresh::Poll => {
                let Some(id) = state.session_id.clone() else {
                    return;
                };
                let id = Value::String(id);
                let Some(active) = merged
                    .iter()
                    .find(|s| strict_eq(prop(Some(s), "id"), Some(&id)))
                else {
                    return;
                };
                let running = Value::String("running".into());
                if state.pending && !strict_eq(prop(Some(active), "status"), Some(&running)) {
                    state.set_pending_tracked(false, cx);
                }
            }
            AfterRefresh::Nothing => {}
            AfterRefresh::Created(c) => state.created(c, cx),
            AfterRefresh::Resolve => cx.out.push(Effect::ActionResolved {
                action: crate::effect::Action::RefreshSessions,
                outcome: Value::Array(merged.to_vec()),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effort_wait::EffortWaitState;
    use crate::idle_reconcile::ToolHistoryEntry;
    use crate::{DisplayBlock, DisplayMessage, FixedEnv, Role};

    #[test]
    fn idle_turn_settles_streaming_messages_and_tool_rows() {
        let mut s = ChatState::new("tab-1");
        let mut m = DisplayMessage::new("a", Role::Assistant, vec![DisplayBlock::text("x")]);
        m.streaming = Some(true);
        m.pending = Some(true);
        s.messages.push(m);
        let row = |id: &str, done: Option<bool>, ended_at: Option<f64>| ToolHistoryEntry {
            tool_use_id: id.into(),
            tool_name: "Bash".into(),
            primary_arg: None,
            started_at: 1.0,
            ended_at,
            done,
            is_error: None,
            not_run: None,
            parent_tool_use_id: Some(None),
            kind: None,
            estimated_thinking_tokens: None,
            user_message_uuid: None,
        };
        s.tool_history = vec![
            row("t1", Some(false), None),
            row("t2", Some(true), Some(5.0)),
            row("t3", None, Some(7.0)),
            row("t5", Some(true), None),
        ];
        s.tool_progress.insert(
            "t1".into(),
            serde_json::from_value(json!({ "toolUseId": "t1", "toolName": "Bash" })).unwrap(),
        );
        let mut env = FixedEnv::new(1000.0);
        let fx = s.on_message(r#"{"type":"turn_status","status":"idle"}"#, &mut env);
        assert!(fx.is_empty());
        assert_eq!(s.messages[0].streaming, Some(false));
        assert_eq!(s.messages[0].pending, Some(false));
        assert_eq!(
            s.tool_history,
            vec![
                row("t1", Some(true), Some(1000.0)),
                row("t2", Some(true), Some(5.0)),
                row("t3", Some(true), Some(7.0)),
                row("t5", Some(true), None),
            ]
        );
        assert!(s.tool_progress.is_empty());
    }

    #[test]
    fn notices_anchor_after_the_last_assistant_message() {
        let mut s = ChatState::new("tab-1");
        s.last_assistant_uuid = "msg_9".into();
        let mut env = FixedEnv::new(1.0);
        s.on_message(
            r#"{"type":"mcp_needs_auth_notice","servers":["a"]}"#,
            &mut env,
        );
        assert_eq!(s.system_entries[0].after_message_uuid, "msg_9");
        assert_eq!(
            s.system_entries[0].uuid,
            "00000000-0000-4000-8000-000000000001"
        );
    }

    #[test]
    fn ready_keeps_the_fallback_model_for_the_limit_panel() {
        let mut s = ChatState::new("tab-1");
        let mut env = FixedEnv::new(1.0);
        s.on_message(
            r#"{"type":"ready","fallbackModel":"claude-sonnet-4-5"}"#,
            &mut env,
        );
        assert_eq!(s.fallback_model, json!("claude-sonnet-4-5"));
        s.on_message(r#"{"type":"ready"}"#, &mut env);
        assert_eq!(s.fallback_model, Value::Null);
    }

    #[test]
    fn a_reply_for_a_session_left_behind_is_dropped() {
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("a".into());
        let mut env = FixedEnv::new(1.0);
        let fx = s.on_message(r#"{"type":"replay_done","hasMoreAbove":false}"#, &mut env);
        let [Effect::Fetch(req)] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        assert_eq!(req.url, "/api/sessions/a/pending-prompts");
        s.session_id = Some("b".into());
        let body = r#"{"asks":[{"requestId":"x"}]}"#.to_owned();
        s.fetch_settled(
            req.id,
            FetchOutcome::Response { status: 200, body },
            &mut env,
        );
        assert!(s.pending_asks.is_empty());
    }

    #[test]
    fn recap_needs_a_bound_session() {
        let mut s = ChatState::new("tab-1");
        let mut env = FixedEnv::new(1.0);
        assert!(s.request_recap(None, &mut env).is_empty());
        assert_eq!(s.session_recap, SessionRecap::idle());
    }

    #[test]
    fn a_running_status_only_clears_the_pending_dimming() {
        let mut s = ChatState::new("tab-1");
        let mut m = DisplayMessage::new("a", Role::User, vec![DisplayBlock::text("x")]);
        m.streaming = Some(true);
        m.pending = Some(true);
        s.messages.push(m);
        let open = ToolHistoryEntry {
            tool_use_id: "t1".into(),
            tool_name: "Read".into(),
            primary_arg: None,
            started_at: 1.0,
            ended_at: None,
            done: None,
            is_error: None,
            not_run: None,
            parent_tool_use_id: Some(None),
            kind: None,
            estimated_thinking_tokens: None,
            user_message_uuid: None,
        };
        s.tool_history = vec![open.clone()];
        let mut env = FixedEnv::new(1000.0);
        s.on_message(r#"{"type":"turn_status","status":"running"}"#, &mut env);
        assert_eq!(s.messages[0].streaming, Some(true));
        assert_eq!(s.messages[0].pending, Some(false));
        assert_eq!(s.tool_history, vec![open.clone()]);
        assert_eq!(s.turn_started_at, Some(1000.0));
        // Blocked on a prompt, or an odd status: the turn settles, but
        // nothing is swept.
        for status in [r#""needs_input""#, "5", "null"] {
            let data = format!(r#"{{"type":"turn_status","status":{status}}}"#);
            s.on_message(&data, &mut env);
            assert!(!s.pending);
            assert_eq!(s.messages[0].streaming, Some(true), "{status}");
            assert_eq!(s.tool_history, vec![open.clone()], "{status}");
        }
    }

    #[test]
    fn a_settled_turn_drops_the_effort_wait_note() {
        let mut s = ChatState::new("tab-1");
        s.effort_wait = EffortWaitState {
            in_force: Some("high".into()),
            waits: true,
            applied_seen: false,
        };
        s.effort_change_waits = true;
        let mut env = FixedEnv::new(1.0);
        s.on_message(r#"{"type":"turn_status","status":"running"}"#, &mut env);
        assert!(s.effort_change_waits);
        s.on_message(r#"{"type":"error","message":"x"}"#, &mut env);
        assert!(!s.effort_change_waits);
        assert_eq!(s.effort_wait, NO_EFFORT_WAIT);
    }

    #[test]
    fn replayed_streaming_messages_settle_on_replay_done() {
        let mut s = ChatState::new("tab-1");
        let mut m = DisplayMessage::new("a", Role::Assistant, vec![DisplayBlock::text("x")]);
        m.streaming = Some(true);
        s.messages.push(m);
        let mut env = FixedEnv::new(1.0);
        // No session bound: nothing to fetch.
        let fx = s.on_message(r#"{"type":"replay_done","hasMoreAbove":true}"#, &mut env);
        assert!(fx.is_empty());
        assert_eq!(s.messages[0].streaming, Some(false));
        assert!(!s.replaying);
    }

    #[test]
    fn a_timeout_is_spent_once_it_fires() {
        let mut s = ChatState::new("tab-1");
        s.pending = true;
        let mut out = Vec::new();
        let id = s.set_timer(&mut out, TimerFn::SessionsPoll, 5.0, false);
        assert_eq!(
            out,
            vec![Effect::SetTimer {
                id,
                ms: 5.0,
                repeat: false
            }]
        );
        let mut env = FixedEnv::new(1.0);
        assert_eq!(s.timer_fired(id, &mut env).len(), 2, "the poll's fetches");
        assert_eq!(s.armed_timers().count(), 0);
        assert!(s.timer_fired(id, &mut env).is_empty());
        let mut out = Vec::new();
        s.clear_timer(&mut out, id);
        assert!(out.is_empty());
        let poll = s.start_sessions_poll();
        let Effect::SetTimer {
            id, repeat: true, ..
        } = poll[0]
        else {
            panic!("{poll:?}");
        };
        assert_eq!(id, TimerId(2));
        s.timer_fired(id, &mut env);
        assert_eq!(s.armed_timers().count(), 1, "an interval stays armed");
        s.clear_timer(&mut out, id);
        assert_eq!(out, vec![Effect::ClearTimer { id }]);
        assert_eq!(s.armed_timers().count(), 0);
    }

    #[test]
    fn json_replies_drop_a_leading_bom() {
        let r = FetchOutcome::Response {
            status: 200,
            body: "\u{feff}{\"a\":1}".into(),
        };
        assert_eq!(r.json(), Some(json!({ "a": 1 })));
        let r = FetchOutcome::Response {
            status: 299,
            body: "{".into(),
        };
        assert!(r.ok());
        assert_eq!(r.json(), None);
        assert!(
            !FetchOutcome::Response {
                status: 300,
                body: String::new()
            }
            .ok()
        );
        assert!(
            !FetchOutcome::Response {
                status: 199,
                body: String::new()
            }
            .ok()
        );
        assert!(!FetchOutcome::Failed("x".into()).ok());
    }

    #[test]
    fn prompts_seen_leaving_are_not_merged_back() {
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("a".into());
        s.pending_asks = vec![Prompt(json!({ "requestId": "a" }))];
        s.prompt_gone.insert("gone".into());
        let mut env = FixedEnv::new(1.0);
        let fx = s.on_message(r#"{"type":"replay_done"}"#, &mut env);
        let [Effect::Fetch(req)] = fx.as_slice() else {
            panic!("{fx:?}");
        };
        let body = r#"{"asks":[{"requestId":"a","v":2},{"requestId":"gone"},{"requestId":"b"},5,{"requestId":7}]}"#;
        s.fetch_settled(
            req.id,
            FetchOutcome::Response {
                status: 200,
                body: body.into(),
            },
            &mut env,
        );
        // A non-string `requestId` (or none) keys as `""`: one such prompt
        // is kept, the next is a duplicate of it.
        assert_eq!(
            s.pending_asks,
            vec![
                Prompt(json!({ "requestId": "a" })),
                Prompt(json!({ "requestId": "b" })),
                Prompt(json!(5)),
            ]
        );
    }
}
