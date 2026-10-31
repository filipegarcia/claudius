//! The model lists outside a session's own picker:
//! `lib/server/model-picker-curation.ts` (`applyModelPickerCuration`, shared
//! with `GET /api/sessions/:id/model`), the static fallback of
//! `app/api/models/route.ts`, and `app/api/models/probe/route.ts`
//! (`PROBE_CANDIDATES`, `probeOne`). The routes are `claudius-server`'s
//! `models.rs`.
//!
//! The probe's only outside call is the `claude` CLI it spawns per model
//! (the CLI talks to the API), so the CLI binary is the boundary: tests
//! point it at the fake CLI. No HTTPS client is involved.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use claudius_agent::{Options, Query, js};
use serde_json::{Map, Value, json};

/// The description of a curated row.
pub const CURATED_DESCRIPTION: &str = "Curated model (modelPicker setting).";

/// `applyModelPickerCuration(models, picker)`, with `picker` as
/// `readSettings` hands it over (any JSON value; `None` is `undefined`).
///
/// No usable entry (an `id` that is a string with something left after JS
/// `trim`) returns `models` as they are. Otherwise each entry becomes a
/// `{value, displayName, description}` row (`displayName` is the trimmed
/// `label`, else the `id`), and `mode: "replace"` returns only those, while
/// any other mode appends the ones whose `id` no row already has as its
/// `value`.
///
/// `Err` is the `TypeError` message V8 throws where the TS does: `entries`
/// that is neither nullish nor an array (or a picker that is an array,
/// whose `entries` is `Array.prototype.entries`), a `null` entry, a truthy
/// `id` or a non-nullish `label` that isn't a string, and (when appending)
/// a `null` row in `models`.
pub fn apply_model_picker_curation(
    models: Vec<Value>,
    picker: Option<&Value>,
) -> Result<Vec<Value>, String> {
    // `picker?.entries?.filter((e) => e.id && e.id.trim().length > 0) ?? []`
    let entries = match picker {
        Some(Value::Array(_)) => return Err("picker?.entries?.filter is not a function".into()),
        Some(Value::Object(p)) => p.get("entries"),
        _ => None,
    };
    let entries: Vec<&Map<String, Value>> = match entries {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut kept = Vec::new();
            for e in items {
                let id = match e {
                    Value::Null => {
                        return Err("Cannot read properties of null (reading 'id')".into());
                    }
                    Value::Object(m) => m.get("id"),
                    _ => None,
                };
                match id {
                    Some(Value::String(id)) if !js::trim(id).is_empty() => {
                        kept.push(e.as_object().expect("an entry with an id is an object"));
                    }
                    Some(v) if js::truthy(v) && !v.is_string() => {
                        return Err("e.id.trim is not a function".into());
                    }
                    _ => {}
                }
            }
            kept
        }
        Some(_) => return Err("picker?.entries?.filter is not a function".into()),
    };
    if entries.is_empty() {
        return Ok(models);
    }
    let mut curated = Vec::with_capacity(entries.len());
    for e in entries {
        let id = e["id"].as_str().expect("kept entries have a string id");
        // `e.label?.trim() || e.id`
        let label = match e.get("label") {
            None | Some(Value::Null) => "",
            Some(Value::String(l)) => js::trim(l),
            Some(_) => return Err("e.label?.trim is not a function".into()),
        };
        let display = if label.is_empty() { id } else { label };
        curated
            .push(json!({"value": id, "displayName": display, "description": CURATED_DESCRIPTION}));
    }
    if picker.and_then(|p| p.get("mode")).and_then(Value::as_str) == Some("replace") {
        return Ok(curated);
    }
    // `new Set(models.map((m) => m.value))`: only string values can match.
    let mut existing = HashSet::new();
    for m in &models {
        match m {
            Value::Null => return Err("Cannot read properties of null (reading 'value')".into()),
            Value::Object(o) => {
                if let Some(Value::String(v)) = o.get("value") {
                    existing.insert(v.clone());
                }
            }
            _ => {}
        }
    }
    let mut out = models;
    out.extend(
        curated
            .into_iter()
            .filter(|c| !existing.contains(c["value"].as_str().unwrap_or_default())),
    );
    Ok(out)
}

/// `STATIC_FALLBACK`: the list `GET /api/models` serves when no live
/// session answers `supportedModels()`.
pub fn static_fallback() -> Vec<Value> {
    vec![
        json!({
            "value": "default",
            "displayName": "Default (recommended)",
            "description": "Whichever model the SDK currently advertises as default.",
        }),
        json!({
            "value": "sonnet",
            "displayName": "Sonnet",
            "description": "Latest Sonnet \u{2014} best for everyday tasks.",
        }),
        json!({
            "value": "haiku",
            "displayName": "Haiku",
            "description": "Latest Haiku \u{2014} fastest for quick answers.",
        }),
        json!({
            "value": "opus",
            "displayName": "Opus",
            "description": "Latest Opus \u{2014} deepest reasoning, slower.",
        }),
        json!({
            "value": "fable",
            "displayName": "Fable 5.1",
            "description": "Most capable for your hardest and longest-running tasks. Uses your limits ~2\u{d7} faster than Opus.",
            "supportsEffort": true,
            "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
            "supportsAdaptiveThinking": true,
        }),
    ]
}

/// `ALWAYS_SHOWN_ALIASES` of `GET /api/sessions/:id/model`: rows the
/// session's picker shows even when the SDK leaves them out.
pub fn always_shown_aliases() -> Vec<Value> {
    vec![json!({
        "value": "fable",
        "displayName": "Fable 5.1",
        "description": "Most capable for your hardest and longest-running tasks. Uses your limits ~2\u{d7} faster than Opus.",
        "supportsEffort": true,
        "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
        "supportsAdaptiveThinking": true,
    })]
}

/// `(m.<key> ?? "").toLowerCase()` for one row of the list.
fn lower_field(m: &Value, key: &str) -> Result<String, String> {
    let v = match m {
        Value::Null => return Err(format!("Cannot read properties of null (reading '{key}')")),
        Value::Object(o) => o.get(key),
        _ => None,
    };
    match v {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.to_lowercase()),
        Some(_) => Err(format!("(m.{key} ?? \"\").toLowerCase is not a function")),
    }
}

/// `listAlreadyCoversAlias(list, alias)`: a row whose lowercased `value`
/// or `displayName` contains the alias's value. Each row reads both fields
/// before the test, and the scan stops at the first match.
fn list_covers_alias(list: &[Value], alias_value: &str) -> Result<bool, String> {
    let needle = alias_value.to_lowercase();
    for m in list {
        let v = lower_field(m, "value")?;
        let d = lower_field(m, "displayName")?;
        if v.contains(&needle) || d.contains(&needle) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The list `GET /api/sessions/:id/model` answers, from the SDK's
/// `supportedModels()` (`None` is `undefined`): `[...sdkModels]` (an array's
/// items, a string's code points; anything else throws), each
/// [`always_shown_aliases`] row that the managed `deniedModels` policy allows
/// and the list doesn't cover yet, then [`apply_model_picker_curation`].
/// `Err` is the `TypeError` message the route answers 503 with.
pub fn session_model_list(
    sdk_models: Option<Value>,
    policy: &crate::managed_settings::ManagedModelPolicy,
    picker: Option<&Value>,
) -> Result<Vec<Value>, String> {
    let mut augmented = match sdk_models {
        Some(Value::Array(items)) => items,
        Some(Value::String(s)) => s.chars().map(|c| Value::String(c.into())).collect(),
        _ => return Err("sdkModels is not iterable".into()),
    };
    for alias in always_shown_aliases() {
        let value = alias["value"].as_str().expect("aliases have a value");
        if crate::managed_settings::is_model_denied_by_managed(
            value,
            policy.denied_models.as_deref(),
            policy.available_models_match,
        ) {
            continue;
        }
        if !list_covers_alias(&augmented, value)? {
            augmented.push(alias);
        }
    }
    apply_model_picker_curation(augmented, picker)
}

/// One pinned model id the probe checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProbeCandidate {
    pub value: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
}

const fn candidate(
    value: &'static str,
    display_name: &'static str,
    description: &'static str,
) -> ProbeCandidate {
    ProbeCandidate {
        value,
        display_name,
        description,
    }
}

/// `PROBE_CANDIDATES`, in the order the probe answers.
pub const PROBE_CANDIDATES: [ProbeCandidate; 12] = [
    candidate(
        "claude-fable-5-1",
        "Fable 5.1",
        "Pinned to Fable 5.1. Most capable; 1M context, full effort tiers + adaptive thinking.",
    ),
    candidate(
        "claude-fable-5",
        "Fable 5",
        "Pinned to Fable 5 (prior generation). Full effort tiers + adaptive thinking.",
    ),
    candidate(
        "claude-opus-5-5",
        "Opus 5.5",
        "Pinned to Opus 5.5. Deepest reasoning on complex, long-horizon tasks; 1M context.",
    ),
    candidate(
        "claude-opus-5",
        "Opus 5",
        "Pinned to Opus 5 (prior generation). Deep reasoning on complex, long-horizon tasks.",
    ),
    candidate(
        "claude-opus-4-8",
        "Opus 4.8",
        "Pinned to Opus 4.8 (prior generation). Deepest reasoning on complex, long-horizon tasks.",
    ),
    candidate("claude-opus-4-7", "Opus 4.7", "Pinned to Opus 4.7."),
    candidate("claude-opus-4-6", "Opus 4.6", "Pinned to Opus 4.6."),
    candidate(
        "claude-sonnet-5-5",
        "Sonnet 5.5",
        "Pinned to Sonnet 5.5. Balanced speed and quality; supports adaptive thinking + xhigh effort.",
    ),
    candidate(
        "claude-sonnet-5",
        "Sonnet 5",
        "Pinned to Sonnet 5 (prior generation). Balanced speed and quality; adaptive thinking + xhigh effort.",
    ),
    candidate(
        "claude-sonnet-4-6",
        "Sonnet 4.6",
        "Pinned to Sonnet 4.6. Balanced speed and quality; supports adaptive thinking.",
    ),
    candidate(
        "claude-haiku-5-5",
        "Haiku 5.5",
        "Pinned to Haiku 5.5. Fastest responses for lightweight tasks; 1M context.",
    ),
    candidate(
        "claude-haiku-4-5",
        "Haiku 4.5",
        "Pinned to Haiku 4.5 (prior generation). Fast responses for lightweight tasks.",
    ),
];

/// `PROBE_TIMEOUT_MS`: each probe's budget, spawn included.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// The one prompt each probe sends.
pub const PROBE_PROMPT: &str = "Reply with exactly: ok";

/// `probeOne`'s `query()` options: one turn, no transcript, the `default`
/// permission mode, and the advisor pinned to the probed model. No `cwd`
/// or `env`, so the CLI runs in this process's cwd and env, like the SDK's.
pub fn probe_options(model: &str, claude_bin: Option<PathBuf>) -> Options {
    Options {
        model: Some(model.to_owned()),
        max_turns: Some(1.0),
        persist_session: Some(false),
        permission_mode: Some("default".into()),
        settings: Some(js::stringify(&json!({"advisorModel": model}))),
        path_to_claude_code_executable: claude_bin,
        ..Default::default()
    }
}

/// What one SDK message decides, if anything: `(ok, error)`.
///
/// The first `assistant` message is `ok` unless its `error` is truthy. A
/// `result` with a truthy `is_error` fails with its `error` (unless
/// nullish), else `api_error_<status>` for a truthy `api_error_status`,
/// else its `subtype` (unless nullish), else `unknown_error`. Any other
/// `result` is `ok` when its `subtype` is falsy or `"success"`, and fails
/// with that `subtype` otherwise. Every other message is passed over.
pub fn probe_verdict(e: &Value) -> Option<(bool, Option<Value>)> {
    let present = |k: &str| e.get(k).filter(|v| !v.is_null());
    match e.get("type").and_then(Value::as_str) {
        Some("assistant") => match e.get("error").filter(|v| js::truthy(v)) {
            Some(error) => Some((false, Some(error.clone()))),
            None => Some((true, None)),
        },
        Some("result") => {
            if e.get("is_error").is_some_and(js::truthy) {
                let error = match present("error") {
                    Some(v) => v.clone(),
                    None => match e.get("api_error_status").filter(|v| js::truthy(v)) {
                        Some(status) => {
                            Value::String(format!("api_error_{}", js::to_string(Some(status))))
                        }
                        None => present("subtype")
                            .cloned()
                            .unwrap_or_else(|| json!("unknown_error")),
                    },
                };
                return Some((false, Some(error)));
            }
            let subtype = e.get("subtype");
            let ok = !subtype.is_some_and(js::truthy)
                || subtype.and_then(Value::as_str) == Some("success");
            Some((ok, (!ok).then(|| subtype.cloned()).flatten()))
        }
        _ => None,
    }
}

/// A probe's answer: the candidate's fields, `ok`, and `error` when set.
pub fn probe_result(c: &ProbeCandidate, ok: bool, error: Option<Value>) -> Value {
    let mut m = Map::new();
    m.insert("value".into(), json!(c.value));
    m.insert("displayName".into(), json!(c.display_name));
    m.insert("description".into(), json!(c.description));
    m.insert("ok".into(), json!(ok));
    if let Some(error) = error {
        m.insert("error".into(), error);
    }
    Value::Object(m)
}

/// `probeOne(candidate)`: a one-turn query on `candidate.value` that ends at
/// the first message [`probe_verdict`] decides on (a stream that ends
/// without one is `ok`). An error is `ok: false` with its message, or
/// `timed out` once `timeout` passes. The query is closed afterwards either
/// way, which stops its CLI.
pub async fn probe_one(
    c: &ProbeCandidate,
    claude_bin: Option<PathBuf>,
    timeout: Duration,
) -> Value {
    let mut query: Option<Query> = None;
    let run = async {
        let q = query.insert(
            Query::spawn_prompt(PROBE_PROMPT, probe_options(c.value, claude_bin))
                .await
                .map_err(|e| e.to_string())?,
        );
        while let Some(msg) = q.next().await {
            if let Some(verdict) = probe_verdict(&msg.map_err(|e| e.to_string())?) {
                return Ok(verdict);
            }
        }
        Ok((true, None))
    };
    let outcome = tokio::time::timeout(timeout, run).await;
    if let Some(q) = query {
        q.handle().close().await;
    }
    match outcome {
        Ok(Ok((ok, error))) => probe_result(c, ok, error),
        Ok(Err(message)) => probe_result(c, false, Some(Value::String(message))),
        Err(_) => probe_result(c, false, Some(json!("timed out"))),
    }
}

/// The probe route's `results`: every candidate at once, in candidate
/// order. A probe that panics is `probe threw unexpectedly`, like a
/// rejected `probeOne` in `Promise.allSettled`.
pub async fn probe_all(claude_bin: Option<PathBuf>) -> Vec<Value> {
    let tasks: Vec<_> = PROBE_CANDIDATES
        .iter()
        .map(|c| tokio::spawn(probe_one(c, claude_bin.clone(), PROBE_TIMEOUT)))
        .collect();
    let mut results = Vec::with_capacity(tasks.len());
    for (c, task) in PROBE_CANDIDATES.iter().zip(tasks) {
        results.push(
            task.await.unwrap_or_else(|_| {
                probe_result(c, false, Some(json!("probe threw unexpectedly")))
            }),
        );
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_settings::ManagedModelPolicy;

    /// CC 2.1.283 (E13): a managed `deniedModels` entry hides the
    /// always-shown alias. Without a policy the alias is appended unless the
    /// SDK list already covers it.
    #[test]
    fn always_shown_alias_respects_managed_denied_models() {
        let sdk = json!([{"value": "default", "displayName": "Default"}]);
        let open = ManagedModelPolicy {
            denied_models: None,
            available_models_match: "prefix",
        };
        let values = |v: Vec<Value>| -> Vec<String> {
            v.iter()
                .map(|m| m["value"].as_str().unwrap().to_owned())
                .collect()
        };
        let list = |sdk: &Value, policy: &ManagedModelPolicy| {
            values(session_model_list(Some(sdk.clone()), policy, None).unwrap())
        };
        assert_eq!(list(&sdk, &open), ["default", "fable"]);
        for denied in ["fable", " FABLE ", "claude-fable"] {
            let policy = ManagedModelPolicy {
                denied_models: Some(vec![denied.into()]),
                available_models_match: "exact",
            };
            let want: &[&str] = if denied == "claude-fable" {
                &["default", "fable"]
            } else {
                &["default"]
            };
            assert_eq!(list(&sdk, &policy), want, "deniedModels [{denied:?}]");
        }
        let covered = json!([{"value": "claude-fable-5-1", "displayName": "Fable 5.1"}]);
        assert_eq!(list(&covered, &open), ["claude-fable-5-1"]);
        let by_name = json!([{"value": "x", "displayName": "My FABLE"}]);
        assert_eq!(list(&by_name, &open), ["x"]);
        // A row read before the match throws; one after it is never read.
        let bad = json!([{"value": "fable"}, {"value": 5}]);
        assert_eq!(
            session_model_list(Some(bad.clone()), &open, None),
            Ok(bad.as_array().unwrap().clone())
        );
        let bad = json!([{"value": "fable", "displayName": 5}]);
        assert_eq!(
            session_model_list(Some(bad), &open, None),
            Err("(m.displayName ?? \"\").toLowerCase is not a function".into())
        );
        let bad = json!([{"value": "x", "displayName": 5}, {"value": "fable"}]);
        assert_eq!(
            session_model_list(Some(bad), &open, None),
            Err("(m.displayName ?? \"\").toLowerCase is not a function".into())
        );
        assert_eq!(
            session_model_list(None, &open, None),
            Err("sdkModels is not iterable".into())
        );
    }

    #[test]
    fn verdicts_follow_probe_one() {
        let v = |m: Value| probe_verdict(&m);
        assert_eq!(v(json!({"type": "system"})), None);
        assert_eq!(v(json!(5)), None);
        assert_eq!(v(json!({"type": "assistant"})), Some((true, None)));
        assert_eq!(
            v(json!({"type": "assistant", "error": "x"})),
            Some((false, Some(json!("x"))))
        );
        assert_eq!(
            v(json!({"type": "result", "is_error": true, "subtype": null})),
            Some((false, Some(json!("unknown_error"))))
        );
        assert_eq!(
            v(
                json!({"type": "result", "is_error": true, "error": null, "api_error_status": 0, "subtype": ""})
            ),
            Some((false, Some(json!(""))))
        );
        assert_eq!(
            v(json!({"type": "result", "subtype": "success"})),
            Some((true, None))
        );
        assert_eq!(
            v(json!({"type": "result", "subtype": "error_max_turns"})),
            Some((false, Some(json!("error_max_turns"))))
        );
    }

    /// A spawn that fails settles as that error, without waiting out the
    /// timeout.
    #[tokio::test]
    async fn a_missing_binary_fails_at_once() {
        let started = std::time::Instant::now();
        let got = probe_one(
            &PROBE_CANDIDATES[0],
            Some("/nonexistent/claudius-models-unit/claude".into()),
            Duration::from_secs(30),
        )
        .await;
        assert_eq!(got["ok"], false);
        assert!(
            got["error"].as_str().unwrap().contains("not found at"),
            "{got}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
