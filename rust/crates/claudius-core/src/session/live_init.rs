//! The hooks TS `broadcast()` runs on every live `system/init` (one that
//! isn't a transcript replay), wherever the init comes from: the CLI's stream
//! or the dev-only `dev-broadcast` route (S28a). In TS order:
//! `noteMcpNeedsAuthAtStartup` / `noteMcpDisconnectedAtStartup` (started
//! before subscribers see the init), `enforceAdvisorModelCompatibility`
//! against the init's `model`, and `refreshAppliedEffort`. All three are
//! `void`ed there, so none holds up the broadcast or the consume loop
//! (S28b). The token-expiry nudge is the fourth, and it stays in
//! `State::broadcast` (it broadcasts from inside the broadcast).

use serde_json::{Value, json};

use super::Session;
use crate::events::ev_type;
use crate::{log, settings};

/// The `model` of `ev` when it is a live `system/init` (`Null` when it has
/// none), else `None`. `replaying` is `isReplayingTranscript`.
pub(super) fn live_init_model(ev: &Value, replaying: bool) -> Option<Value> {
    if replaying || ev_type(ev) != "sdk" {
        return None;
    }
    let m = ev.get("message")?;
    let system_init = m.get("type").and_then(Value::as_str) == Some("system")
        && m.get("subtype").and_then(Value::as_str) == Some("init");
    system_init.then(|| m.get("model").cloned().unwrap_or(Value::Null))
}

/// `if (!model || !model.includes("fable")) return` on the init's model:
/// `Ok(true)` to go on and clear the advisor. A string is searched for the
/// substring and an array for an element `=== "fable"`. Any other truthy
/// value has no `includes`, so TS throws inside the `void`ed call: an
/// unhandled rejection Next only logs, and nothing is cleared.
pub(crate) fn includes_fable(model: &Value) -> Result<bool, String> {
    if !claudius_agent::js::truthy(model) {
        return Ok(false);
    }
    match model {
        Value::String(s) => Ok(s.contains("fable")),
        Value::Array(items) => Ok(items.iter().any(|v| v.as_str() == Some("fable"))),
        _ => Err("TypeError: model.includes is not a function".into()),
    }
}

impl Session {
    /// Before the fan-out of a live init: the MCP startup notices, so they
    /// count as running before any subscriber sees the init. The model, for
    /// [`Session::after_live_init`]; `None` for any other event.
    pub(super) fn before_live_init(&self, ev: &Value) -> Option<Value> {
        let model = self.with(|st| live_init_model(ev, st.is_replaying))?;
        // `this.sawLiveInit = true` (R03's `came_up_live`), set where TS sets
        // it: beside the startup notices, for any init that isn't a replay.
        self.with(|st| st.saw_live_init = true);
        crate::mcp_notices::note_at_startup(self.arc());
        Some(model)
    }

    /// After the fan-out: the advisor check and the effort refresh, neither
    /// awaited.
    pub(super) fn after_live_init(&self, model: Value) {
        self.spawn_advisor_compat(model);
        self.refresh_applied_effort();
    }

    /// `void this.enforceAdvisorModelCompatibility(sdkMsg.model)`: decides
    /// now (`previousAdvisor` is the advisor at the init), clears off the
    /// caller, so the messages the CLI sends meanwhile reach subscribers
    /// first (S28b).
    fn spawn_advisor_compat(&self, model: Value) {
        // `if (!this.advisorModel) return`: an empty advisor is no advisor.
        let Some(previous) = self.advisor_model().filter(|a| !a.is_empty()) else {
            return;
        };
        match includes_fable(&model) {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) => {
                tracing::error!(target: log::SESSION, "[session.advisor-compat] {e}");
                return;
            }
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let me = self.arc();
        rt.spawn(async move { me.clear_incompatible_advisor(previous, model).await });
    }

    /// The rest of `enforceAdvisorModelCompatibility` once it clears: the
    /// user settings.json key first (`applyFlagSettings({advisorModel:
    /// null})` falls back to the file), then the flag layer, then the notice.
    pub(super) async fn clear_incompatible_advisor(&self, previous_advisor: String, model: Value) {
        if let Err(e) = settings::clear_user_advisor_model(&self.cwd) {
            tracing::error!(target: log::SESSION, "[session.advisor-compat] settings write failed: {e}");
        }
        self.set_advisor_model(None).await;
        self.broadcast(json!({
            "type": "advisor_disabled_on_model_change",
            "previousAdvisor": previous_advisor,
            "newModel": model,
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_live_system_init_counts() {
        let init = |m: Value| json!({"type": "sdk", "message": m});
        let sys = json!({"type": "system", "subtype": "init", "model": "m"});
        assert_eq!(live_init_model(&init(sys.clone()), false), Some(json!("m")));
        assert_eq!(live_init_model(&init(sys.clone()), true), None);
        assert_eq!(
            live_init_model(&init(json!({"type": "system", "subtype": "init"})), false),
            Some(Value::Null)
        );
        for m in [
            json!({"type": "assistant", "subtype": "init"}),
            json!({"subtype": "init"}),
            json!({"type": "system", "subtype": "status"}),
            Value::Null,
        ] {
            assert_eq!(live_init_model(&init(m.clone()), false), None, "{m}");
        }
        assert_eq!(
            live_init_model(&json!({"type": "error", "message": sys}), false),
            None
        );
    }

    #[test]
    fn includes_follows_the_js_value() {
        assert_eq!(includes_fable(&json!("claude-fable-5")), Ok(true));
        assert_eq!(includes_fable(&json!("claude-opus-4-5")), Ok(false));
        assert_eq!(includes_fable(&json!(["fable"])), Ok(true));
        assert_eq!(includes_fable(&json!(["claude-fable-5"])), Ok(false));
        for falsy in [json!(""), json!(0), json!(false), Value::Null] {
            assert_eq!(includes_fable(&falsy), Ok(false), "{falsy}");
        }
        for odd in [json!(5), json!(true), json!({"fable": true})] {
            assert!(includes_fable(&odd).is_err(), "{odd}");
        }
    }
}
