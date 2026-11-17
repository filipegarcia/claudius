//! U01i: status, usage and mode. The `usage_snapshot`, `plan_usage`,
//! `plan_usage_unavailable`, `effort_applied`, `model_changed` and
//! `advisor_disabled_on_model_change` events, and the picker actions `setModel`,
//! `setEffort` (with `effortChangeWaits` through `effort_wait`),
//! `setUltracode`, `setFast`, `setAdvisorModel`, `reEnableAdvisor` and
//! `setAgent`, and the `dismiss*` notices (the nudges, fast mode, the model
//! switch, the chat-command model, the advisor and auto mode).
//!
//! Still open (U01i): `moveToActiveAccount`, whose outcome is the
//! promise's value rather than state. `fastModeState`'s other writers are
//! `system` init (U01h) and the session reset (U01k).

use claudius_core::js_string::spread_into;
use serde_json::{Map, Value, json};

use crate::apply::Cx;
use crate::effect::{Effect, FetchOutcome};
use crate::effort_wait::{EffortPick, effort_applied, effort_picked};
use crate::env::ClientEnv;
use crate::event::JsObject;
use crate::state::{ChatState, Then};
use crate::text::{as_str, prop, truthy, wire_str};

/// What a status action's fetch continues with.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum StatusThen {
    /// `setModel`'s POST: a rejected switch reverts and raises the notice.
    Model { attempted: Option<String> },
    /// `.catch(() => {})` with the response unused.
    Ignore,
}

const JSON_HEADERS: &[(&str, &str)] = &[("Content-Type", "application/json")];

impl ChatState {
    /// `sessionIdRef.current` where the action's `if (!id) return;` lets
    /// it through.
    fn bound_id(&self) -> Option<String> {
        self.session_id.clone().filter(|id| !id.is_empty())
    }

    /// A `POST /api/sessions/{id}/{route}` with a JSON body.
    fn post_status(
        &mut self,
        cx: &mut Cx<'_>,
        id: &str,
        route: &str,
        body: &Value,
        then: StatusThen,
    ) {
        self.fetch(
            cx,
            "POST",
            format!("/api/sessions/{id}/{route}"),
            JSON_HEADERS.to_vec(),
            Some(claudius_agent::js::stringify(body)),
            Then::Status(then),
        );
    }

    // ------------------------------------------------------------ events

    /// `usage_snapshot`: `setUsage({ ...ev.usage })`, replacing the
    /// estimate wholesale.
    pub(crate) fn on_usage_snapshot(&mut self, ev: &JsObject) {
        let mut next = Map::new();
        if let Some(usage) = ev.get("usage") {
            spread_into(&mut next, usage);
        }
        self.usage = Value::Object(next);
    }

    /// `plan_usage`: the subscription type ref and the panel's data, fresh.
    pub(crate) fn on_plan_usage(&mut self, ev: &JsObject) {
        self.subscription_type = ev.get("subscriptionType").cloned().unwrap_or(Value::Null);
        let mut next = Map::new();
        // `undefined` fields stay out (the snapshot drops them anyway).
        let mut put = |key: &str, v: Option<&Value>| {
            if let Some(v) = v {
                next.insert(key.to_owned(), v.clone());
            }
        };
        put("subscriptionType", ev.get("subscriptionType"));
        put("rateLimitsAvailable", ev.get("rateLimitsAvailable"));
        put(
            "rateLimits",
            Some(ev.get("rateLimits").unwrap_or(&Value::Null)),
        );
        for key in ["modelScoped", "spendLimit", "extraUsage"] {
            let v = ev.get(key);
            if truthy(v) {
                put(key, v);
            }
        }
        put("fetchedAt", ev.get("fetchedAt"));
        put("stale", Some(&Value::Bool(false)));
        self.plan_usage = Value::Object(next);
    }

    /// `plan_usage_unavailable`: what the panel shows is last-known.
    pub(crate) fn on_plan_usage_unavailable(&mut self) {
        if let Value::Object(prev) = &mut self.plan_usage {
            prev.insert("stale".into(), Value::Bool(true));
        }
    }

    /// `effort_applied`: the level the SDK applied (`null`: the model
    /// takes no effort), which may settle a waiting pick.
    pub(crate) fn on_effort_applied(&mut self, ev: &JsObject) {
        let applied = ev.get("effort");
        self.applied_effort = applied.cloned();
        if self.effort_wait.in_force.is_some() {
            let next = effort_applied(&self.effort_wait, applied);
            self.effort_change_waits = next.waits;
            self.effort_wait = next;
        }
    }

    /// `model_changed`: the pill, plus the chat-command / auto-fallback,
    /// fast-mode capability and auto-mode-off notices.
    pub(crate) fn on_model_changed(&mut self, ev: &JsObject, cx: &mut Cx<'_>) {
        let model = ev.get("model");
        self.model = model.cloned().unwrap_or(Value::Null);
        let has_model = truthy(model);
        let source = as_str(ev.get("source"));
        let reason = match source {
            Some("chat_command") if has_model => Some("chat_command"),
            Some("auto") if has_model => Some("auto"),
            _ => None,
        };
        if let Some(reason) = reason {
            self.chat_command_model_notice = json!({
                "uuid": cx.env.random_uuid(),
                "model": model,
                "reason": reason,
            });
        }
        if let Some(now_supported) = ev.get("fastModeNowSupported")
            && has_model
        {
            self.fast_mode_notice = json!({
                "uuid": cx.env.random_uuid(),
                "kind": "model-switch",
                "model": model,
                "nowSupported": now_supported,
            });
        }
        let off_for = ev.get("autoModeOffFor");
        if truthy(off_for) && !self.replaying {
            self.auto_mode_off_notice = json!({
                "uuid": cx.env.random_uuid(),
                "model": off_for,
            });
        }
    }

    /// `advisor_disabled_on_model_change`: the advisor is cleared, with a
    /// toast to turn it back on.
    pub(crate) fn on_advisor_disabled(&mut self, ev: &JsObject, cx: &mut Cx<'_>) {
        self.advisor_model = None;
        let mut notice = Map::new();
        notice.insert("uuid".into(), json!(cx.env.random_uuid()));
        for key in ["previousAdvisor", "newModel"] {
            if let Some(v) = ev.get(key) {
                notice.insert(key.into(), v.clone());
            }
        }
        self.advisor_disabled_notice = Value::Object(notice);
    }

    /// A status action's fetch settled.
    pub(crate) fn status_settled(
        &mut self,
        then: StatusThen,
        outcome: &FetchOutcome,
        cx: &mut Cx<'_>,
    ) {
        let StatusThen::Model { attempted } = then else {
            return;
        };
        let FetchOutcome::Response { status, .. } = outcome else {
            // A network blip leaves the optimistic pick.
            return;
        };
        if outcome.ok() {
            return;
        }
        // `await r.json().catch(() => ({}))`; a `null` body throws on
        // `body.model`, which the `try` swallows.
        let body = outcome.json().unwrap_or_else(|| json!({}));
        if body.is_null() {
            return;
        }
        let model = as_str(prop(Some(&body), "model"));
        self.model = model.map_or(Value::Null, |m| json!(m));
        let error = match prop(Some(&body), "error") {
            None | Some(Value::Null) => json!(format!("HTTP {status}")),
            Some(e) => e.clone(),
        };
        self.model_switch_notice = json!({
            "uuid": cx.env.random_uuid(),
            "attempted": attempted,
            "error": error,
        });
    }

    // ----------------------------------------------------------- actions

    /// `setModel(m, source = "picker")`: mirror the pick, then ask the
    /// server; a rejection (409 + the current model) reverts it.
    pub fn set_model(
        &mut self,
        m: Option<&str>,
        source: Option<&str>,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        self.model = m.map_or(Value::Null, |m| json!(m));
        let body = json!({ "model": m, "source": source.unwrap_or("picker") });
        let attempted = m.map(str::to_owned);
        self.post_status(
            &mut cx,
            &id,
            "model",
            &body,
            StatusThen::Model { attempted },
        );
        cx.out
    }

    /// `setEffort(level, opts)`: note a mid-turn pick on the pill
    /// (`effortChangeWaits`), mirror it, drop the applied level and POST it
    /// with the current ultracode state.
    pub fn set_effort(
        &mut self,
        level: &str,
        session_only: bool,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        // `appliedEffortRef.current ?? effortRef.current`.
        let shown = match &self.applied_effort {
            Some(v) if !v.is_null() => v,
            _ => &self.effort,
        };
        let shown_before = wire_str(Some(shown));
        let next = effort_picked(
            &self.effort_wait,
            EffortPick {
                pending: self.pending,
                picked: level,
                shown_before: &shown_before,
                no_effort_param: matches!(self.applied_effort, Some(Value::Null)),
            },
        );
        self.effort_change_waits = next.waits;
        self.effort_wait = next;
        self.effort = json!(level);
        self.applied_effort = None;
        let mut body = json!({ "level": level, "ultracode": self.ultracode });
        if session_only {
            body["sessionOnly"] = json!(true);
        }
        self.post_status(&mut cx, &id, "effort", &body, StatusThen::Ignore);
        cx.out
    }

    /// `setUltracode(enabled)`; the effort mirror is left alone.
    pub fn set_ultracode(&mut self, enabled: bool, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        self.ultracode = enabled;
        let body = json!({ "enabled": enabled });
        self.post_status(&mut cx, &id, "ultracode", &body, StatusThen::Ignore);
        cx.out
    }

    /// `setFast(enabled)`.
    pub fn set_fast(&mut self, enabled: bool, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        self.fast_mode = enabled;
        let body = json!({ "enabled": enabled });
        self.post_status(&mut cx, &id, "fast", &body, StatusThen::Ignore);
        cx.out
    }

    /// `setAdvisorModel(model)`: `null` clears the per-session override.
    pub fn set_advisor_model(
        &mut self,
        model: Option<&str>,
        env: &mut dyn ClientEnv,
    ) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        self.advisor_model = model.map(str::to_owned);
        let body = json!({ "model": model });
        self.post_status(&mut cx, &id, "advisor", &body, StatusThen::Ignore);
        cx.out
    }

    /// `reEnableAdvisor(advisorModel)`: the advisor route again, with the
    /// auto-disabled toast cleared.
    pub fn re_enable_advisor(&mut self, model: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        self.advisor_model = Some(model.to_owned());
        self.advisor_disabled_notice = Value::Null;
        let body = json!({ "model": model });
        self.post_status(&mut cx, &id, "advisor", &body, StatusThen::Ignore);
        cx.out
    }

    /// `setAgent(name)`: mirror the badge; the server's `agent_changed`
    /// syncs the other tabs. `null` resets to the default agent.
    pub fn set_agent(&mut self, name: Option<&str>, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let Some(id) = self.bound_id() else {
            return cx.out;
        };
        self.main_agent = Some(name.map_or(Value::Null, |n| json!(n)));
        let body = json!({ "agent": name });
        self.post_status(&mut cx, &id, "agent", &body, StatusThen::Ignore);
        cx.out
    }

    // ---------------------------------------------------------- dismiss*

    /// `dismissFeedback()`.
    pub fn dismiss_feedback(&mut self) {
        self.feedback_survey = None;
    }

    /// `dismissOpusOverloadNudge()`.
    pub fn dismiss_opus_overload_nudge(&mut self) {
        self.opus_overload_nudge = None;
    }

    /// `dismissLongContextCreditsNudge()`.
    pub fn dismiss_long_context_credits_nudge(&mut self) {
        self.long_context_credits_nudge = None;
    }

    /// `dismissAuthFailedNudge()`.
    pub fn dismiss_auth_failed_nudge(&mut self) {
        self.auth_failed_nudge = None;
    }

    /// `dismissTokenExpiringNudge()`.
    pub fn dismiss_token_expiring_nudge(&mut self) {
        self.token_expiring_nudge = None;
    }

    /// `dismissFastModeNotice()`.
    pub fn dismiss_fast_mode_notice(&mut self) {
        self.fast_mode_notice = Value::Null;
    }

    /// `dismissChatCommandModelNotice()`.
    pub fn dismiss_chat_command_model_notice(&mut self) {
        self.chat_command_model_notice = Value::Null;
    }

    /// `dismissModelSwitchNotice()`.
    pub fn dismiss_model_switch_notice(&mut self) {
        self.model_switch_notice = Value::Null;
    }

    /// `dismissAdvisorDisabledNotice()`.
    pub fn dismiss_advisor_disabled_notice(&mut self) {
        self.advisor_disabled_notice = Value::Null;
    }

    /// `dismissAutoModeOffNotice()`.
    pub fn dismiss_auto_mode_off_notice(&mut self) {
        self.auto_mode_off_notice = Value::Null;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;
    use crate::effort_wait::NO_EFFORT_WAIT;

    fn bound() -> ChatState {
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("sess-1".into());
        s
    }

    #[test]
    fn actions_need_a_bound_session() {
        let mut env = FixedEnv::new(1.0);
        for id in [None, Some(String::new())] {
            let mut s = ChatState::new("tab-1");
            s.session_id = id;
            let before = s.clone();
            assert!(s.set_model(Some("m"), None, &mut env).is_empty());
            assert!(s.set_effort("low", true, &mut env).is_empty());
            assert!(s.set_ultracode(true, &mut env).is_empty());
            assert!(s.set_fast(true, &mut env).is_empty());
            assert!(s.set_advisor_model(Some("m"), &mut env).is_empty());
            assert!(s.re_enable_advisor("m", &mut env).is_empty());
            assert_eq!(s, before);
        }
    }

    #[test]
    fn a_pick_on_a_model_without_effort_never_waits() {
        // `appliedEffort === null` (no effort parameter), mid-turn.
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        s.pending = true;
        s.applied_effort = Some(Value::Null);
        s.set_effort("low", false, &mut env);
        assert_eq!(s.effort_wait, NO_EFFORT_WAIT);
        assert!(!s.effort_change_waits);
        assert_eq!(s.applied_effort, None);
    }

    #[test]
    fn a_mid_turn_pick_waits_on_the_applied_level() {
        // The pill showed the applied level, not the pick.
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        s.pending = true;
        s.effort = json!("low");
        s.applied_effort = Some(json!("high"));
        s.set_effort("high", false, &mut env);
        assert_eq!(s.effort_wait.in_force.as_deref(), Some("high"));
        assert!(!s.effort_change_waits);
        s.set_effort("low", false, &mut env);
        assert_eq!(s.effort_wait.in_force.as_deref(), Some("high"));
        assert!(s.effort_change_waits);
        assert_eq!(s.effort, json!("low"));
    }

    #[test]
    fn re_enabling_the_advisor_clears_its_notice() {
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        s.advisor_disabled_notice = json!({ "uuid": "u" });
        let fx = s.re_enable_advisor("claude-opus-4-5", &mut env);
        assert_eq!(s.advisor_disabled_notice, Value::Null);
        assert_eq!(s.advisor_model.as_deref(), Some("claude-opus-4-5"));
        assert_eq!(fx.len(), 1);
    }
}
