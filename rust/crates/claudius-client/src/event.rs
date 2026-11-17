//! `ServerEvent` (lib/shared/events.ts): one message of a session's SSE
//! stream, as `onmessage` parses it, keyed by its `type`.
//!
//! The hook reads these without validating them, so the payloads here don't
//! either: each field the hook reads is a [`Field`], the JSON value as sent
//! or `None` when the key is missing (`undefined`), and the handler applies
//! the TS's own coercions (`?? null`, truthiness, `=== "running"`). A
//! payload with a missing or odd field still parses into its variant, the
//! way the TS still runs the handler. Events whose handler stores the whole
//! object (`setFeedbackSurvey(ev)`) keep it as a [`JsObject`].
//!
//! Every type the server sends has a variant. The ones a later U01 slice
//! ports still carry their raw object ([`JsObject`]) until that slice types
//! them; [`ServerEvent::Unknown`] is any other `type`, or a message that
//! isn't an object, kept as it came.

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

use crate::JsThrow;

/// A JSON object as sent, in its key order.
pub type JsObject = Map<String, Value>;

/// A field the hook reads off an event: `None` for a missing key (JS
/// `undefined`), else the value as sent, `null` included.
pub type Field = Option<Value>;

/// Deserializes a present key as `Some`, `null` included (serde's `Option`
/// would read `null` as `None`); with `#[serde(default)]` a missing key is
/// `None`.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Field, D::Error> {
    Value::deserialize(d).map(Some)
}

macro_rules! payload {
    ($(#[$doc:meta])* $name:ident { $($(#[$fdoc:meta])* $field:ident: $key:literal),* $(,)? }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Default, PartialEq, Deserialize)]
        pub struct $name {
            $(
                $(#[$fdoc])*
                #[serde(default, rename = $key, deserialize_with = "present")]
                pub $field: Field,
            )*
        }
    };
}

payload!(
    /// `SessionReadyEvent`.
    ReadyEvent {
        session_id: "sessionId",
        agent: "agent",
        fallback_model: "fallbackModel",
        /// Missing means "keep the path you have"; `null` clears it.
        transcript_path: "transcriptPath",
        account: "account",
    }
);

payload!(
    /// `HolderChangedEvent`: which tab holds the write lock.
    HolderChangedEvent { holder_id: "holderId" }
);

payload!(
    /// `SessionErrorEvent`.
    ErrorEvent {
        message: "message",
        session_ended: "sessionEnded",
    }
);

payload!(
    /// `CwdChangedEvent`: the agent's effective working directory.
    CwdChangedEvent { cwd: "cwd" }
);

payload!(
    /// `SessionTitleEvent`.
    SessionTitleEvent { title: "title" }
);

payload!(
    /// `GoalChangedEvent`: the whole goal state (`goal` falsy clears it).
    GoalChangedEvent {
        goal: "goal",
        achieved: "achieved",
        summary: "summary",
        set_at: "setAt",
        achieved_at: "achievedAt",
    }
);

payload!(
    /// `SessionAccountChangedEvent`.
    AccountChangedEvent { account: "account" }
);

payload!(
    /// `AgentChangedEvent`.
    AgentChangedEvent { agent: "agent" }
);

payload!(
    /// `ModeChangedEvent`.
    ModeChangedEvent { mode: "mode" }
);

payload!(
    /// `TipsEvent`: the spinner-tip catalog.
    TipsEvent { tips: "tips" }
);

payload!(
    /// `McpNeedsAuthNoticeEvent` / `McpDisconnectedNoticeEvent`.
    McpNoticeEvent { servers: "servers" }
);

payload!(
    /// `SessionRecapEvent`.
    SessionRecapEvent {
        text: "text",
        at: "at",
        origin: "origin",
    }
);

payload!(
    /// `SessionRecapErrorEvent`.
    SessionRecapErrorEvent {
        reason: "reason",
        message: "message",
    }
);

payload!(
    /// `TurnStatusEvent`: the server's "is the agent busy?".
    TurnStatusEvent {
        status: "status",
        background_tasks: "backgroundTasks",
    }
);

payload!(
    /// `ReplayDoneEvent`: the end of the subscribe replay.
    ReplayDoneEvent { has_more_above: "hasMoreAbove" }
);

payload!(
    /// `PromptSettledEvent`: a pending prompt left the server's set
    /// (answered, aborted with its tool call, or drained).
    PromptSettledEvent {
        kind: "kind",
        request_id: "requestId",
    }
);

payload!(
    /// `PlanApprovalRequestEvent`: an ExitPlanMode plan to approve.
    PlanApprovalRequestEvent {
        request_id: "requestId",
        tool_use_id: "toolUseId",
        plan: "plan",
        raw: "raw",
    }
);

#[derive(Debug, Clone, PartialEq)]
pub enum ServerEvent {
    Ready(ReadyEvent),
    HolderChanged(HolderChangedEvent),
    Error(ErrorEvent),
    CwdChanged(CwdChangedEvent),
    SessionTitle(SessionTitleEvent),
    GoalChanged(GoalChangedEvent),
    AccountChanged(AccountChangedEvent),
    AgentChanged(AgentChangedEvent),
    ModeChanged(ModeChangedEvent),
    Tips(TipsEvent),
    /// Stored whole as the survey prompt.
    FeedbackSurvey(JsObject),
    /// The four one-shot banners, each stored whole.
    OpusOverloadNudge(JsObject),
    LongContextCreditsRequired(JsObject),
    AuthFailedRequired(JsObject),
    TokenExpiringRequired(JsObject),
    McpNeedsAuthNotice(McpNoticeEvent),
    McpDisconnectedNotice(McpNoticeEvent),
    SessionRecap(SessionRecapEvent),
    SessionRecapError(SessionRecapErrorEvent),
    TurnStatus(TurnStatusEvent),
    ReplayDone(ReplayDoneEvent),
    // Ported by later U01 slices; the reducer ignores them until then.
    /// `{ type: "sdk", message, at }`: the message is read unchecked, as
    /// the TS does (`sdk.rs`; U01d, with U01e / U01g / U01h still to come).
    Sdk(JsObject),
    /// U01f: the three queued prompts, each stored whole.
    PermissionRequest(JsObject),
    AskUserQuestion(JsObject),
    McpElicitationRequest(JsObject),
    PromptSettled(PromptSettledEvent),
    PlanApprovalRequest(PlanApprovalRequestEvent),
    /// U01i.
    EffortApplied(JsObject),
    ModelChanged(JsObject),
    AdvisorDisabledOnModelChange(JsObject),
    UsageSnapshot(JsObject),
    PlanUsage(JsObject),
    PlanUsageUnavailable(JsObject),
    /// U01g.
    TaskSnapshot(JsObject),
    TodosAutoCleared(JsObject),
    /// U01h.
    SessionSnapshot(JsObject),
    /// U01j.
    QueueUpdated(JsObject),
    /// The hook has no handler for it.
    AccountAutoRotated(JsObject),
    /// Any other `type`, or a message that isn't an object (`null`, `5`,
    /// `[...]`), as it came.
    Unknown(Value),
}

impl ServerEvent {
    /// `JSON.parse(data)` of an SSE message, or V8's `SyntaxError`.
    pub fn parse(data: &str) -> Result<Self, JsThrow> {
        claudius_core::js_string::parse(data)
            .map(Self::from_value)
            .map_err(|message| JsThrow {
                name: "SyntaxError",
                message,
            })
    }

    /// The event a parsed message is.
    pub fn from_value(v: Value) -> Self {
        let Value::Object(obj) = v else {
            return Self::Unknown(v);
        };
        let Some(kind) = obj.get("type").and_then(Value::as_str) else {
            return Self::Unknown(Value::Object(obj));
        };
        fn typed<T: for<'de> Deserialize<'de>>(obj: JsObject) -> T {
            serde_json::from_value(Value::Object(obj)).expect("every field is a Field")
        }
        match kind {
            "ready" => Self::Ready(typed(obj)),
            "holder_changed" => Self::HolderChanged(typed(obj)),
            "error" => Self::Error(typed(obj)),
            "cwd_changed" => Self::CwdChanged(typed(obj)),
            "session_title" => Self::SessionTitle(typed(obj)),
            "goal_changed" => Self::GoalChanged(typed(obj)),
            "account_changed" => Self::AccountChanged(typed(obj)),
            "agent_changed" => Self::AgentChanged(typed(obj)),
            "mode_changed" => Self::ModeChanged(typed(obj)),
            "tips" => Self::Tips(typed(obj)),
            "feedback_survey" => Self::FeedbackSurvey(obj),
            "opus_overload_nudge" => Self::OpusOverloadNudge(obj),
            "long_context_credits_required" => Self::LongContextCreditsRequired(obj),
            "auth_failed_required" => Self::AuthFailedRequired(obj),
            "token_expiring_required" => Self::TokenExpiringRequired(obj),
            "mcp_needs_auth_notice" => Self::McpNeedsAuthNotice(typed(obj)),
            "mcp_disconnected_notice" => Self::McpDisconnectedNotice(typed(obj)),
            "session_recap" => Self::SessionRecap(typed(obj)),
            "session_recap_error" => Self::SessionRecapError(typed(obj)),
            "turn_status" => Self::TurnStatus(typed(obj)),
            "replay_done" => Self::ReplayDone(typed(obj)),
            "sdk" => Self::Sdk(obj),
            "permission_request" => Self::PermissionRequest(obj),
            "ask_user_question" => Self::AskUserQuestion(obj),
            "mcp_elicitation_request" => Self::McpElicitationRequest(obj),
            "prompt_settled" => Self::PromptSettled(typed(obj)),
            "plan_approval_request" => Self::PlanApprovalRequest(typed(obj)),
            "effort_applied" => Self::EffortApplied(obj),
            "model_changed" => Self::ModelChanged(obj),
            "advisor_disabled_on_model_change" => Self::AdvisorDisabledOnModelChange(obj),
            "usage_snapshot" => Self::UsageSnapshot(obj),
            "plan_usage" => Self::PlanUsage(obj),
            "plan_usage_unavailable" => Self::PlanUsageUnavailable(obj),
            "task_snapshot" => Self::TaskSnapshot(obj),
            "todos_auto_cleared" => Self::TodosAutoCleared(obj),
            "session_snapshot" => Self::SessionSnapshot(obj),
            "queue:updated" => Self::QueueUpdated(obj),
            "account_auto_rotated" => Self::AccountAutoRotated(obj),
            _ => Self::Unknown(Value::Object(obj)),
        }
    }
}

impl<'de> Deserialize<'de> for ServerEvent {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Value::deserialize(d).map(Self::from_value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fields_tell_missing_from_null() {
        let ServerEvent::Ready(r) = ServerEvent::from_value(json!({
            "type": "ready", "sessionId": "s", "transcriptPath": null, "agent": 5
        })) else {
            panic!("not ready");
        };
        assert_eq!(r.session_id, Some(json!("s")));
        assert_eq!(r.transcript_path, Some(Value::Null));
        assert_eq!(r.agent, Some(json!(5)));
        assert_eq!(r.account, None);
    }

    #[test]
    fn unknown_and_unported_types_keep_their_payload() {
        let raw = json!({ "type": "brand_new", "x": 1 });
        assert_eq!(
            ServerEvent::from_value(raw.clone()),
            ServerEvent::Unknown(raw)
        );
        assert_eq!(
            ServerEvent::from_value(json!({ "type": 5 })),
            ServerEvent::Unknown(json!({ "type": 5 }))
        );
        assert_eq!(
            ServerEvent::from_value(json!(null)),
            ServerEvent::Unknown(Value::Null)
        );
        let ServerEvent::QueueUpdated(q) =
            ServerEvent::from_value(json!({ "type": "queue:updated", "queue": [] }))
        else {
            panic!("not queue:updated");
        };
        assert_eq!(q.get("queue"), Some(&json!([])));
        let e: ServerEvent = serde_json::from_str(r#"{"type":"tips"}"#).unwrap();
        assert_eq!(e, ServerEvent::Tips(TipsEvent { tips: None }));
        assert_eq!(ServerEvent::parse("{").unwrap_err().name, "SyntaxError");
    }
}
