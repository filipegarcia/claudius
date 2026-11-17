//! The create route's option reads, with the TS's JS semantics (S27d).
//!
//! `POST /api/sessions` hands every field of its merged body to
//! `new Session(...)` untyped (`lib/shared/session-defaults.ts` only picks the
//! keys), so each read applies its own test rather than a schema:
//! - numbers (`maxTurns`, `maxBudgetUsd`, `taskBudgetTokens`) need
//!   `typeof === "number"`, so `"5"` / `true` / `[8]` are dropped;
//! - flags (`sandboxEnabled`, `restrictedMode`, `enable1mContext`, …) are
//!   plain truthiness tests, except `persistSession`, which is `=== false`;
//! - string options (`model`, `agent`, `fallbackModel`, `permissionMode`,
//!   `resumeSessionAt`) are printed with `${}` (`--model=5`), after an SDK
//!   truthiness test the printed text of a falsy value can't pass — hence
//!   `""` for one here;
//! - `additionalDirectories` is gated on `.length > 0` and then iterated
//!   (`for … of`), so a string contributes one `--add-dir` per code point and
//!   a number/object contributes none (no `.length`);
//! - `sandboxNetworkAllowedDomains` reaches the CLI's settings as it came
//!   (a string stays a string);
//! - a non-string `planModeInstructions` throws in `.trim()`, and a model
//!   with no primitive form throws where the SDK prints it, so `start()`
//!   rejects and the route answers 500 with the error's `name`.
//!
//! The values TS keeps raw and hands back ([`OddTypes`]) ride along, since
//! the create response's `model` and the `ready` event's `agent` /
//! `fallbackModel` are the body's own values, not their printed text.

use serde_json::{Map, Value, json};

use super::{Session, SessionOptions, State};
use crate::js_string::{NoPrimitive, code_points, to_js_string};
use claudius_agent::js;

/// The raw body values a session hands back as they came, and the error a
/// start can't get past. Not part of the serde shape: only the create route
/// (and the TS it mirrors) sees untyped options.
#[derive(Clone, Debug, Default)]
pub struct OddTypes {
    /// `opts.model` when it wasn't a string ([`Session::model_value`]).
    pub model: Option<Value>,
    /// `opts.agent` when it wasn't a string ([`Session::ready_event`]).
    pub agent: Option<Value>,
    /// `opts.fallbackModel` when it wasn't a string.
    pub fallback_model: Option<Value>,
    /// What `start()` throws when it reads an option, as `(name, message)`:
    /// TS rejects there, so `sessionManager.create` fails with it.
    pub start_error: Option<(&'static str, String)>,
}

/// `typeof v === "number" ? v : undefined`.
fn number(v: Option<&Value>) -> Option<f64> {
    v?.as_f64()
}

/// A flag TS only ever tests for truthiness: `Some(true)` or `None`, so the
/// `== Some(true)` reads downstream keep working.
fn flag(v: Option<&Value>) -> Option<bool> {
    v.is_some_and(js::truthy).then_some(true)
}

/// A string option as the SDK prints it: absent for `undefined` / `null`, the
/// string itself, else `` `${v}` `` — except for a falsy value, which every
/// read tests before printing it, so `""` (the one text that fails that test)
/// stands in. `Err` for a value with no primitive form (an object whose own
/// `toString` isn't callable): TS throws where it prints it.
fn string_option(v: Option<&Value>) -> Result<Option<String>, NoPrimitive> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(v) if !js::truthy(v) => Ok(Some(String::new())),
        Some(v) => to_js_string(v).map(Some),
    }
}

/// `v.length` as `> 0` reads it: a string's UTF-16 length, an array's, and
/// `undefined` (so `false`) for everything else.
fn has_length(v: &Value) -> bool {
    match v {
        Value::String(s) => s.encode_utf16().next().is_some(),
        Value::Array(items) => !items.is_empty(),
        _ => false,
    }
}

/// `for (const dir of additionalDirectories)` once `.length > 0` passed: a
/// string iterates by code point, an array by item (printed with `${}`).
fn add_dirs(v: Option<&Value>) -> Result<Option<Vec<String>>, NoPrimitive> {
    let Some(v) = v.filter(|v| js::truthy(v) && has_length(v)) else {
        return Ok(None);
    };
    match v {
        Value::String(s) => Ok(Some(code_points(s))),
        Value::Array(items) => items
            .iter()
            .map(to_js_string)
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        _ => Ok(None),
    }
}

/// The raw value to keep for a string option, which is only ever the one the
/// body spelled with another type.
fn odd(v: Option<&Value>) -> Option<Value> {
    v.filter(|v| !v.is_null() && !v.is_string()).cloned()
}

/// `new Session({ …mergeSessionDefaults(body, defaults), resume, … })`:
/// every option of the merged body, read as TS reads it. `cwd` and `resume`
/// stay with the route (they have their own resolution); `resumeSessionAt`
/// comes from the body, which is where TS takes it from.
pub fn from_create_body(merged: &Map<String, Value>, body: &Map<String, Value>) -> SessionOptions {
    // Whether any option the SDK prints has no primitive form: they all
    // throw the same `TypeError` where it prints them.
    let mut unprintable = false;
    let mut text = |v: Option<&Value>| match string_option(v) {
        Ok(v) => v,
        Err(NoPrimitive) => {
            unprintable = true;
            None
        }
    };
    let model = text(merged.get("model"));
    let agent = text(merged.get("agent"));
    let permission_mode = text(merged.get("permissionMode"));
    let fallback_model = text(merged.get("fallbackModel"));
    let resume_session_at = text(body.get("resumeSessionAt"));
    let dirs = add_dirs(merged.get("additionalDirectories"));
    unprintable = unprintable || dirs.is_err();
    let dirs = dirs.unwrap_or(None);
    // `this.planModeInstructions && this.planModeInstructions.trim()`, while
    // the options object is built — before the SDK prints anything, so this
    // throw wins. A falsy value never reaches `.trim`.
    let plan = merged.get("planModeInstructions").filter(|v| js::truthy(v));
    let plan_throws = plan.is_some_and(|v| !v.is_string());
    let start_error = if plan_throws {
        Some((
            "TypeError",
            "this.planModeInstructions.trim is not a function".to_owned(),
        ))
    } else {
        unprintable.then(|| ("TypeError", NO_PRIMITIVE.to_owned()))
    };
    SessionOptions {
        id: None,
        cwd: None,
        model,
        agent,
        max_budget_usd: number(merged.get("maxBudgetUsd")),
        task_budget_tokens: number(merged.get("taskBudgetTokens")),
        max_turns: number(merged.get("maxTurns")),
        fallback_model,
        sandbox_enabled: flag(merged.get("sandboxEnabled")),
        sandbox_filesystem_disabled: flag(merged.get("sandboxFilesystemDisabled")),
        sandbox_network_allowed_domains: merged
            .get("sandboxNetworkAllowedDomains")
            .filter(|v| !v.is_null())
            .cloned(),
        sandbox_network_strict_allowlist: flag(merged.get("sandboxNetworkStrictAllowlist")),
        enable_1m_context: flag(merged.get("enable1mContext")),
        // `persistSession === false`: the one read that isn't truthiness.
        persist_session: (merged.get("persistSession") == Some(&Value::Bool(false)))
            .then_some(false),
        additional_directories: dirs,
        // `joinSystemPromptAppends` keeps `typeof p === "string"` parts only;
        // anything else contributes nothing (and doesn't throw).
        system_prompt_append: merged
            .get("systemPromptAppend")
            .and_then(Value::as_str)
            .map(str::to_owned),
        plan_mode_instructions: plan.and_then(Value::as_str).map(str::to_owned),
        permission_mode,
        restricted_mode: flag(merged.get("restrictedMode")),
        resume: None,
        resume_session_at,
        odd: OddTypes {
            model: odd(merged.get("model")),
            agent: odd(merged.get("agent")),
            fallback_model: odd(merged.get("fallbackModel")),
            start_error,
        },
        runtime: super::RuntimeOptions::default(),
    }
}

/// V8's `TypeError` message for a value with no primitive form.
const NO_PRIMITIVE: &str = "Cannot convert object to primitive value";

/// `sandbox` for the SDK: only under an enabled sandbox, with the body's own
/// `allowedDomains` value (a string stays a string) and a literal `true` for
/// the two flags.
pub(super) fn sandbox(o: &SessionOptions) -> Option<Value> {
    if o.sandbox_enabled != Some(true) {
        return None;
    }
    let mut sb =
        json!({"enabled": true, "autoAllowBashIfSandboxed": true, "failIfUnavailable": false});
    if o.sandbox_filesystem_disabled == Some(true) {
        sb["filesystem"] = json!({"disabled": true});
    }
    let domains = o
        .sandbox_network_allowed_domains
        .as_ref()
        .filter(|d| has_length(d));
    let strict = o.sandbox_network_strict_allowlist == Some(true);
    if domains.is_some() || strict {
        let mut net = Map::new();
        if let Some(d) = domains {
            net.insert("allowedDomains".into(), d.clone());
        }
        if strict {
            net.insert("strictAllowlist".into(), json!(true));
        }
        sb["network"] = Value::Object(net);
    }
    Some(sb)
}

/// The value TS holds for a string option whose text is `text`: the body's
/// own value when that is still what the session prints as `text`.
fn raw_or(text: Option<&str>, raw: Option<&Value>) -> Option<Value> {
    let text = text.filter(|t| !t.is_empty())?;
    match raw.filter(|r| same_text(r, Some(text))) {
        Some(r) => Some(r.clone()),
        None => Some(json!(text)),
    }
}

/// Whether `raw` is the value a session holding `text` came from: a falsy
/// one stands in as `""` ([`string_option`]).
fn same_text(raw: &Value, text: Option<&str>) -> bool {
    if js::truthy(raw) {
        to_js_string(raw).ok().as_deref() == text
    } else {
        text == Some("")
    }
}

impl Session {
    /// `session.model` as the create route hands it back: the body's own
    /// value while the session still runs the model it named, `Null` (an
    /// omitted key) for no model at all.
    pub fn model_value(&self) -> Value {
        let text = self.model();
        match &self.opts.odd.model {
            Some(raw) if same_text(raw, text.as_deref()) => raw.clone(),
            _ => match text {
                Some(t) => json!(t),
                None => Value::Null,
            },
        }
    }

    /// `{type: "ready", sessionId, …(agent ? {agent} : {}), …(fallbackModel ?
    /// {fallbackModel} : {})}`, both as the body spelled them.
    pub(super) fn ready_event(&self, st: &State) -> Value {
        let mut ready = json!({"type": "ready", "sessionId": self.id});
        if let Some(a) = raw_or(st.truthy_agent(), self.opts.odd.agent.as_ref()) {
            ready["agent"] = a;
        }
        if let Some(f) = raw_or(
            self.opts.fallback_model.as_deref(),
            self.opts.odd.fallback_model.as_ref(),
        ) {
            ready["fallbackModel"] = f;
        }
        ready
    }

    /// `this.model?.includes("fable")` in `start()`, on the body's own value:
    /// `Err` when it has no `includes` (TS throws, so the start rejects).
    pub(super) fn model_includes_fable(&self) -> Result<bool, (&'static str, String)> {
        let text = self.model();
        match &self.opts.odd.model {
            Some(raw) if same_text(raw, text.as_deref()) => super::live_init::includes_fable(raw)
                .map_err(|_| {
                    (
                        "TypeError",
                        "this.model?.includes is not a function".to_owned(),
                    )
                }),
            _ => Ok(text.is_some_and(|m| m.contains("fable"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(body: Value) -> SessionOptions {
        let m = body.as_object().unwrap().clone();
        from_create_body(&m, &m)
    }

    #[test]
    fn numbers_need_the_type() {
        let o = opts(json!({"maxTurns": "5", "maxBudgetUsd": true, "taskBudgetTokens": [8]}));
        assert_eq!(
            (o.max_turns, o.max_budget_usd, o.task_budget_tokens),
            (None, None, None)
        );
        let o = opts(json!({"maxTurns": 1e21, "maxBudgetUsd": -1.0, "taskBudgetTokens": 0.5}));
        assert_eq!(o.max_turns, Some(1e21));
        assert_eq!(o.max_budget_usd, Some(-1.0));
        assert_eq!(o.task_budget_tokens, Some(0.5));
    }

    #[test]
    fn string_options_print_the_value() {
        let o = opts(json!({"model": 5, "agent": ["a", null], "fallbackModel": {"a": 1}}));
        assert_eq!(o.model.as_deref(), Some("5"));
        assert_eq!(o.agent.as_deref(), Some("a,"));
        assert_eq!(o.fallback_model.as_deref(), Some("[object Object]"));
        assert_eq!(o.odd.model, Some(json!(5)));
        // A falsy value reads as the one text no SDK read prints.
        assert_eq!(opts(json!({"model": 0})).model.as_deref(), Some(""));
        assert_eq!(opts(json!({"model": null})).model, None);
    }

    #[test]
    fn flags_are_truthiness_but_persist_session_is_strict() {
        let o = opts(json!({"sandboxEnabled": "yes", "restrictedMode": 1, "persistSession": 0}));
        assert_eq!(o.sandbox_enabled, Some(true));
        assert_eq!(o.restricted_mode, Some(true));
        assert_eq!(o.persist_session, None);
        assert_eq!(
            opts(json!({"persistSession": false})).persist_session,
            Some(false)
        );
        assert_eq!(opts(json!({"sandboxEnabled": ""})).sandbox_enabled, None);
    }

    #[test]
    fn additional_directories_follow_the_iteration() {
        assert_eq!(
            opts(json!({"additionalDirectories": "a\u{1f600}b"})).additional_directories,
            Some(vec!["a".into(), "\u{1f600}".into(), "b".into()])
        );
        assert_eq!(
            opts(json!({"additionalDirectories": ["/x", 5]})).additional_directories,
            Some(vec!["/x".into(), "5".into()])
        );
        for v in [
            json!(5),
            json!({"a": "/x"}),
            json!(""),
            json!([]),
            Value::Null,
        ] {
            assert_eq!(
                opts(json!({"additionalDirectories": v})).additional_directories,
                None,
                "{v}"
            );
        }
    }

    #[test]
    fn unreadable_options_fail_the_start() {
        let o = opts(json!({"planModeInstructions": 5}));
        assert_eq!(
            o.odd.start_error,
            Some((
                "TypeError",
                "this.planModeInstructions.trim is not a function".into()
            ))
        );
        assert_eq!(
            opts(json!({"planModeInstructions": 0})).odd.start_error,
            None
        );
        let o = opts(json!({"model": {"toString": 1}}));
        assert_eq!(
            o.odd.start_error,
            Some((
                "TypeError",
                "Cannot convert object to primitive value".into()
            ))
        );
        assert_eq!(o.model, None);
    }

    #[test]
    fn the_sandbox_keeps_the_value_it_was_given() {
        let o = opts(json!({
            "sandboxEnabled": "yes",
            "sandboxFilesystemDisabled": "x",
            "sandboxNetworkAllowedDomains": "abc",
            "sandboxNetworkStrictAllowlist": 0,
        }));
        assert_eq!(
            sandbox(&o),
            Some(json!({
                "enabled": true,
                "autoAllowBashIfSandboxed": true,
                "failIfUnavailable": false,
                "filesystem": {"disabled": true},
                "network": {"allowedDomains": "abc"},
            }))
        );
        let o = opts(json!({
            "sandboxEnabled": 1,
            "sandboxNetworkAllowedDomains": [],
            "sandboxNetworkStrictAllowlist": "y",
        }));
        assert_eq!(
            sandbox(&o).unwrap()["network"],
            json!({"strictAllowlist": true})
        );
        assert_eq!(sandbox(&opts(json!({"sandboxEnabled": 0}))), None);
    }
}
