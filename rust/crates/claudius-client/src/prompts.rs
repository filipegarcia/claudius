//! U01f: the interactive prompts the agent blocks on, and the user's
//! answers (`use-session.ts`'s prompt handlers and actions).
//!
//! Events: `permission_request`, `ask_user_question` and
//! `mcp_elicitation_request` each queue the whole event in its FIFO (the UI
//! shows the head), unless this tab already saw that request leave;
//! `prompt_settled` drops one and remembers it left; `plan_approval_request`
//! replaces the single pending plan. The `/pending-prompts` merge after a
//! replay is `apply.rs`'s (`replay_done`).
//!
//! Actions: `resolvePermission`, `resolveElicitation`, `submitAskAnswer`,
//! `resolvePlan` and `setPermissionMode`. Each changes the state first
//! (drop the prompt and remember it left, close the plan, show the new
//! mode), then POSTs. Nothing reads the reply: a failed POST leaves the
//! change in place (no rollback). Only `resolvePermission` has no
//! `.catch`, so its fetch failing is an [`Effect::UnhandledRejection`].
//!
//! The queues key on `requestId` through U01b's [`prompt_queue`]
//! ([`Keyed`]): one that isn't a string reads as `""`, as the crate reads
//! the other SDK ids the TS types as strings. The TS compares them with
//! `===` and its `Set`, so two odd ids of different types, or two object
//! ids, collide here and not there. The server always sends a UUID string.
//!
//! [`prompt_queue`]: crate::prompt_queue

use serde_json::{Map, Value};

use crate::ClientEnv;
use crate::apply::Cx;
use crate::effect::{Effect, FetchOutcome};
use crate::event::{Field, JsObject, PlanApprovalRequestEvent, PromptSettledEvent};
use crate::prompt_queue::{Keyed, drop_prompt, enqueue_prompt};
use crate::state::{ChatState, Prompt, Then};
use crate::text::truthy;

/// Which FIFO a prompt lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    /// `pendingPermissions` (`permission_request`).
    Permission,
    /// `pendingAsks` (`ask_user_question`).
    Ask,
    /// `pendingElicitations` (`mcp_elicitation_request`).
    Elicitation,
}

/// The queue key of a `requestId` as sent: the string, or `""`.
fn key(id: Option<&Value>) -> &str {
    id.and_then(Value::as_str).unwrap_or_default()
}

/// A queued prompt as the server sent it (U01m's [`Prompt`], keyed the
/// same way as [`key`]).
fn queued(ev: Value) -> Prompt {
    Prompt(ev)
}

/// `{ requestId, <key>: value }` as `JSON.stringify` writes it.
fn body(request_id: Field, key: &str, value: &Value) -> String {
    let mut m = Map::new();
    if let Some(id) = request_id {
        m.insert("requestId".into(), id);
    }
    m.insert(key.into(), value.clone());
    claudius_core::js_string::stringify(&Value::Object(m))
}

impl ChatState {
    fn prompt_queue(&mut self, kind: PromptKind) -> &mut Vec<Prompt> {
        match kind {
            PromptKind::Permission => &mut self.pending_permissions,
            PromptKind::Ask => &mut self.pending_asks,
            PromptKind::Elicitation => &mut self.pending_elicitations,
        }
    }

    /// `promptGoneRef.current.has(id)`.
    fn prompt_is_gone(&self, id: &str) -> bool {
        self.prompt_gone.contains(id)
    }

    /// `promptGoneRef.current.add(id)`.
    fn mark_prompt_gone(&mut self, id: &str) {
        self.prompt_gone.insert(id.to_owned());
    }

    /// `sessionIdRef.current`, when truthy (`if (!id) return`).
    fn bound_session(&self) -> Option<String> {
        self.session_id.clone().filter(|id| !id.is_empty())
    }

    // ---------------------------------------------------------- events

    /// `permission_request` / `ask_user_question` /
    /// `mcp_elicitation_request`: queue the prompt (a re-emit of one already
    /// queued replaces it in place), unless it already left this tab: a
    /// subscribe re-emit can race the answer's POST.
    pub(crate) fn on_prompt(&mut self, kind: PromptKind, ev: JsObject) {
        let item = queued(Value::Object(ev));
        if self.prompt_is_gone(item.request_id()) {
            return;
        }
        enqueue_prompt(self.prompt_queue(kind), item);
    }

    /// `prompt_settled`: answered in another tab, aborted, or drained.
    /// A `kind` other than `"permission"` or `"ask"` is an elicitation.
    pub(crate) fn on_prompt_settled(&mut self, e: PromptSettledEvent) {
        let id = key(e.request_id.as_ref());
        self.mark_prompt_gone(id);
        let kind = match e.kind.as_ref().and_then(Value::as_str) {
            Some("permission") => PromptKind::Permission,
            Some("ask") => PromptKind::Ask,
            _ => PromptKind::Elicitation,
        };
        drop_prompt(self.prompt_queue(kind), id);
    }

    /// `plan_approval_request`: `{ requestId, toolUseId, plan }` as sent
    /// (a missing one left out), plus `raw` when truthy, replacing any plan
    /// shown.
    pub(crate) fn on_plan_request(&mut self, e: PlanApprovalRequestEvent) {
        let mut next = Map::new();
        for (k, v) in [
            ("requestId", e.request_id),
            ("toolUseId", e.tool_use_id),
            ("plan", e.plan),
        ] {
            if let Some(v) = v {
                next.insert(k.into(), v);
            }
        }
        if let Some(raw) = e.raw.filter(|r| truthy(Some(r))) {
            next.insert("raw".into(), raw);
        }
        self.pending_plan = Value::Object(next);
    }

    // ---------------------------------------------------------- actions

    /// `resolvePermission(requestId, decision)`: drop the prompt (the next
    /// queued one shows) and POST `/permission`. No `.catch`.
    pub fn resolve_permission(
        &mut self,
        request_id: &str,
        decision: &Value,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        self.answer_prompt(
            PromptKind::Permission,
            request_id,
            ("permission", "decision", decision),
            true,
            env,
        )
    }

    /// `resolveElicitation(requestId, decision)`: POST `/elicitation`.
    pub fn resolve_elicitation(
        &mut self,
        request_id: &str,
        decision: &Value,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        self.answer_prompt(
            PromptKind::Elicitation,
            request_id,
            ("elicitation", "decision", decision),
            false,
            env,
        )
    }

    /// `submitAskAnswer(requestId, answers)`: POST `/ask-answer`.
    pub fn submit_ask_answer(
        &mut self,
        request_id: &str,
        answers: &Value,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        self.answer_prompt(
            PromptKind::Ask,
            request_id,
            ("ask-answer", "answers", answers),
            false,
            env,
        )
    }

    fn answer_prompt(
        &mut self,
        kind: PromptKind,
        request_id: &str,
        (path, field, value): (&str, &str, &Value),
        uncaught: bool,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_session() else {
            return cx.out;
        };
        self.mark_prompt_gone(request_id);
        drop_prompt(self.prompt_queue(kind), request_id);
        let body = body(Some(Value::String(request_id.to_owned())), field, value);
        self.post_answer(
            &mut cx,
            format!("/api/sessions/{id}/{path}"),
            body,
            uncaught,
        );
        cx.out
    }

    /// `resolvePlan(decision)`: close the plan now and POST `/plan` with
    /// its `requestId`; nothing pending means it was already resolved.
    pub fn resolve_plan(&mut self, decision: &Value, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_session() else {
            return cx.out;
        };
        let pending = std::mem::take(&mut self.pending_plan);
        if pending.is_null() {
            return cx.out;
        }
        let request_id = pending.get("requestId").cloned();
        let body = body(request_id, "decision", decision);
        self.post_answer(&mut cx, format!("/api/sessions/{id}/plan"), body, false);
        cx.out
    }

    /// `setPermissionMode(mode)`: show the mode now and POST `/mode`. A
    /// failed POST keeps it; the server's `mode_changed` is what corrects it.
    pub fn set_permission_mode(&mut self, mode: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_session() else {
            return cx.out;
        };
        let mode = Value::String(mode.to_owned());
        self.permission_mode = Some(mode.clone());
        let body = body(None, "mode", &mode);
        self.post_answer(&mut cx, format!("/api/sessions/{id}/mode"), body, false);
        cx.out
    }

    fn post_answer(&mut self, cx: &mut Cx<'_>, url: String, body: String, uncaught: bool) {
        self.fetch(
            cx,
            "POST",
            url,
            vec![("Content-Type", "application/json")],
            Some(body),
            Then::Answer { uncaught },
        );
    }

    /// An answer's POST settled: nothing reads the reply, and only a
    /// failed fetch without a `.catch` shows.
    pub(crate) fn answer_settled(
        &mut self,
        uncaught: bool,
        outcome: &FetchOutcome,
        cx: &mut Cx<'_>,
    ) {
        if let (true, FetchOutcome::Failed(error)) = (uncaught, outcome) {
            cx.out.push(Effect::UnhandledRejection {
                error: error.clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;
    use crate::effect::FetchRequest;
    use serde_json::json;

    fn bound() -> ChatState {
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("s1".into());
        s
    }

    fn obj(v: Value) -> JsObject {
        v.as_object().unwrap().clone()
    }

    fn ids<T: Keyed>(q: &[T]) -> Vec<&str> {
        q.iter().map(Keyed::request_id).collect()
    }

    fn only_fetch(fx: &[Effect]) -> &FetchRequest {
        let [Effect::Fetch(req)] = fx else {
            panic!("{fx:?}");
        };
        req
    }

    #[test]
    fn actions_need_a_truthy_session() {
        let mut env = FixedEnv::new(1.0);
        for session in [None, Some(String::new())] {
            let mut s = ChatState::new("tab-1");
            s.session_id = session;
            s.on_prompt(PromptKind::Ask, obj(json!({ "requestId": "a" })));
            s.pending_plan = json!({ "requestId": "p" });
            assert!(s.resolve_permission("a", &json!({}), &mut env).is_empty());
            assert!(s.resolve_elicitation("a", &json!({}), &mut env).is_empty());
            assert!(s.submit_ask_answer("a", &json!([]), &mut env).is_empty());
            assert!(s.resolve_plan(&json!({}), &mut env).is_empty());
            assert!(s.set_permission_mode("plan", &mut env).is_empty());
            assert_eq!(s.pending_asks.len(), 1);
            assert!(!s.prompt_is_gone("a"));
            assert_eq!(s.pending_plan, json!({ "requestId": "p" }));
            assert_eq!(s.permission_mode, Some(json!("default")));
        }
    }

    #[test]
    fn an_answer_drops_only_its_prompt_and_keeps_it_gone() {
        let mut s = bound();
        let mut env = FixedEnv::new(1.0);
        for id in ["a", "b"] {
            s.on_prompt(PromptKind::Ask, obj(json!({ "requestId": id })));
        }
        let fx = s.submit_ask_answer("a", &json!([{ "label": "Yes" }]), &mut env);
        let req = only_fetch(&fx);
        assert_eq!(req.url, "/api/sessions/s1/ask-answer");
        assert_eq!(req.headers, vec![("Content-Type", "application/json")]);
        assert_eq!(
            req.body.as_deref(),
            Some(r#"{"requestId":"a","answers":[{"label":"Yes"}]}"#)
        );
        assert_eq!(ids(&s.pending_asks), ["b"]);
        // A subscribe re-emit doesn't bring it back.
        s.on_prompt(PromptKind::Ask, obj(json!({ "requestId": "a" })));
        assert_eq!(ids(&s.pending_asks), ["b"]);
        // The settle is silent, even for a failure.
        let id = req.id;
        let out = s.fetch_settled(id, FetchOutcome::Failed("TypeError: x".into()), &mut env);
        assert!(out.is_empty());
    }

    #[test]
    fn only_a_failed_permission_post_is_uncaught() {
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        let fx = s.resolve_permission("p", &json!({ "kind": "allow_once" }), &mut env);
        let id = only_fetch(&fx).id;
        let failed = FetchOutcome::Failed("TypeError: Failed to fetch".into());
        assert_eq!(
            s.fetch_settled(id, failed.clone(), &mut env),
            vec![Effect::UnhandledRejection {
                error: "TypeError: Failed to fetch".into()
            }]
        );
        // Settled once.
        assert!(s.fetch_settled(id, failed.clone(), &mut env).is_empty());
        let fx = s.resolve_permission("p", &json!({}), &mut env);
        let id = only_fetch(&fx).id;
        let bad = FetchOutcome::Response {
            status: 500,
            body: "nope".into(),
        };
        assert!(s.fetch_settled(id, bad, &mut env).is_empty());
        let fx = s.resolve_elicitation("e", &json!({ "action": "cancel" }), &mut env);
        let id = only_fetch(&fx).id;
        assert!(s.fetch_settled(id, failed, &mut env).is_empty());
    }

    #[test]
    fn settled_kinds_pick_the_queue() {
        let mut s = bound();
        for kind in [
            PromptKind::Permission,
            PromptKind::Ask,
            PromptKind::Elicitation,
        ] {
            s.on_prompt(kind, obj(json!({ "requestId": "x" })));
        }
        let settle = |kind: Value| PromptSettledEvent {
            kind: Some(kind),
            request_id: Some(json!("x")),
        };
        s.on_prompt_settled(settle(json!("ask")));
        assert!(s.pending_asks.is_empty());
        assert_eq!(s.pending_permissions.len(), 1);
        assert_eq!(s.pending_elicitations.len(), 1);
        s.on_prompt_settled(settle(json!("PERMISSION")));
        assert!(s.pending_elicitations.is_empty());
        assert_eq!(s.pending_permissions.len(), 1);
        s.on_prompt_settled(settle(json!("permission")));
        assert!(s.pending_permissions.is_empty());
        assert!(s.prompt_is_gone("x"));
        s.mark_prompt_gone("x");
        assert_eq!(s.prompt_gone.len(), 1, "a set");
    }

    #[test]
    fn odd_ids_key_as_empty_strings() {
        // The deliberate difference: the TS keeps `5` and `{}` apart.
        let mut s = bound();
        for id in [json!(5), json!({}), json!("")] {
            s.on_prompt(
                PromptKind::Permission,
                obj(json!({ "requestId": id, "n": 1 })),
            );
        }
        assert_eq!(ids(&s.pending_permissions), [""]);
        s.on_prompt_settled(PromptSettledEvent {
            kind: Some(json!("permission")),
            request_id: None,
        });
        assert!(s.pending_permissions.is_empty());
        assert!(s.prompt_is_gone(""));
        assert!(!s.prompt_is_gone("5"));
    }

    #[test]
    fn a_plan_without_a_request_id_posts_without_one() {
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        s.on_plan_request(PlanApprovalRequestEvent {
            plan: Some(json!("p")),
            raw: Some(json!(0)),
            ..Default::default()
        });
        assert_eq!(s.pending_plan, json!({ "plan": "p" }));
        let fx = s.resolve_plan(&json!({ "kind": "accept" }), &mut env);
        assert_eq!(
            only_fetch(&fx).body.as_deref(),
            Some(r#"{"decision":{"kind":"accept"}}"#)
        );
        assert_eq!(s.pending_plan, Value::Null);
        assert!(s.resolve_plan(&json!({}), &mut env).is_empty());
    }
}
