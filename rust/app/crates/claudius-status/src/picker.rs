//! The model picker (`components/panels/widgets/ModelPicker.tsx`, the
//! SessionCard's popover) as data: the model list it fetches, the rows,
//! the effort chips, the Dynamic Workflows (ultracode) and fast-mode
//! toggles, and the action each choice calls (`SessionCard.tsx:308`:
//! `setModel`, `setEffort`, `setUltracode`, `setFast`). The advisor rows
//! and "More models" (the probe) are not ported yet.
//!
//! Plus the two host reads the status line makes: the settings
//! (`useDisableAutoMode` and `useMaxEffortLevel`, both
//! `GET /api/settings?scope=user&cwd=…`) and the context poll
//! (`useContextWatcher`).

use claudius_agent::js;
use claudius_client::effect::FetchOutcome;
use claudius_client::shared::{
    canonical_model_id, opus48_fast_deprecation_text, pretty_model_name,
};
use serde_json::Value;

/// A `ModelInfo` row (ModelPicker.tsx:39), as the picker reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelInfo {
    pub value: String,
    pub resolved_model: Option<String>,
    pub display_name: String,
    pub description: String,
    pub supports_effort: bool,
    pub supported_effort_levels: Option<Vec<String>>,
    /// `supportsAdaptiveThinking !== false`: absent reads as supported.
    pub supports_adaptive_thinking: Option<bool>,
    pub supports_fast_mode: bool,
}

fn s(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}

impl ModelInfo {
    /// A row off the wire; one without a string `value` is skipped.
    pub fn parse(v: &Value) -> Option<ModelInfo> {
        let o = v.as_object()?;
        Some(ModelInfo {
            value: s(o.get("value"))?,
            resolved_model: s(o.get("resolvedModel")),
            display_name: s(o.get("displayName")).unwrap_or_default(),
            description: s(o.get("description")).unwrap_or_default(),
            supports_effort: o.get("supportsEffort").is_some_and(js::truthy),
            supported_effort_levels: o
                .get("supportedEffortLevels")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                }),
            supports_adaptive_thinking: o.get("supportsAdaptiveThinking").and_then(Value::as_bool),
            supports_fast_mode: o.get("supportsFastMode").is_some_and(js::truthy),
        })
    }

    /// `m.displayName || m.value`.
    pub fn label(&self) -> &str {
        if self.display_name.is_empty() {
            &self.value
        } else {
            &self.display_name
        }
    }

    /// The row's canonical id, `resolvedModel ?? value`.
    pub fn active_id(&self) -> &str {
        self.resolved_model.as_deref().unwrap_or(&self.value)
    }
}

/// `ONE_M_TAG.test(m.trim())` / `stripOneMTag` (model-id.ts:63): a
/// trailing `[1m]`, any case.
fn strip_one_m_tag(model: &str) -> Option<&str> {
    let t = js::trim(model);
    let n = t.len();
    if n >= 4 && t.is_char_boundary(n - 4) && t[n - 4..].eq_ignore_ascii_case("[1m]") {
        Some(&t[..n - 4])
    } else {
        None
    }
}

fn bare(model: &str) -> String {
    let t = js::trim(model);
    strip_one_m_tag(t).unwrap_or(t).to_lowercase()
}

/// `findModelEntry(models, current)` (model-id.ts:70): the exact `value`,
/// else (only for a `[1m]`-tagged current) the tag-insensitive `value`,
/// then the row resolving to it, a non-`default` row first.
pub fn find_model_entry<'a>(
    models: &'a [ModelInfo],
    current: Option<&str>,
) -> Option<&'a ModelInfo> {
    let current = current.filter(|c| !c.is_empty())?;
    if let Some(exact) = models.iter().find(|m| m.value == current) {
        return Some(exact);
    }
    strip_one_m_tag(current)?;
    let want = bare(current);
    if let Some(by_value) = models.iter().find(|m| bare(&m.value) == want) {
        return Some(by_value);
    }
    let by_resolved: Vec<&ModelInfo> = models
        .iter()
        .filter(|m| {
            m.resolved_model
                .as_deref()
                .is_some_and(|r| !r.is_empty() && bare(r) == want)
        })
        .collect();
    by_resolved
        .iter()
        .find(|m| m.value != "default")
        .or(by_resolved.first())
        .copied()
}

/// `EFFORT_TIER_ORDER` (effort-flags.ts:28).
pub const EFFORT_TIER_ORDER: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// `capEffortLevels(levels, maxEffortLevel)` (effort-flags.ts:36): the
/// tiers at or under the cap; `max`, no cap or an unknown one keep all.
pub fn cap_effort_levels(levels: &[String], max_effort_level: Option<&str>) -> Vec<String> {
    let Some(cap) = max_effort_level.filter(|c| !c.is_empty() && *c != "max") else {
        return levels.to_vec();
    };
    let Some(cap_idx) = EFFORT_TIER_ORDER.iter().position(|t| *t == cap) else {
        return levels.to_vec();
    };
    // `indexOf(l) <= capIdx`: a level not in the order (-1) passes.
    levels
        .iter()
        .filter(|l| {
            EFFORT_TIER_ORDER
                .iter()
                .position(|t| t == l)
                .is_none_or(|i| i <= cap_idx)
        })
        .cloned()
        .collect()
}

/// `EFFORT_LABEL` (ModelPicker.tsx:68).
pub fn effort_label(level: &str) -> Option<&'static str> {
    Some(match level {
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Very High",
        "max" => "Max",
        _ => return None,
    })
}

/// `fastModeLabel(modelId)` (fast-mode.ts:155): `Fast mode (<name>)` for
/// a known Claude model, else plain `Fast mode`.
pub fn fast_mode_label(model_id: Option<&str>) -> String {
    if canonical_model_id(model_id).is_none() {
        return "Fast mode".into();
    }
    format!("Fast mode ({})", pretty_model_name(model_id))
}

/// `OPUS48_FAST_MIGRATE_HINT` (fast-mode.ts:120).
pub const OPUS48_FAST_MIGRATE_HINT: &str = "Switch to Opus 5.5 to keep the speedup.";

/// What a chip or a toggle in the picker calls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pick {
    /// `onPickModel(value)` → `setModel(value)`; the picker stays open.
    Model(String),
    /// `onPickEffort(level)` → `setEffort(level)` (`"auto"` included);
    /// the picker closes.
    Effort(String),
    /// `onToggleUltracode(enabled)` → `setUltracode(enabled)`; closes.
    Ultracode(bool),
    /// `onToggleFast(enabled)` → `setFast(enabled)`; closes.
    Fast(bool),
}

impl Pick {
    /// Whether the picker closes after it (SessionCard.tsx:313).
    pub fn closes(&self) -> bool {
        !matches!(self, Pick::Model(_))
    }
}

/// An effort chip (ModelPicker.tsx:654): its label, `data-effort` tone
/// and what it calls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffortChip {
    pub label: &'static str,
    /// `adaptive`, a level, or `ultracode`.
    pub tone: String,
    pub pick: Pick,
}

/// A model row.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelRow {
    pub value: String,
    pub label: String,
    pub description: String,
    pub current: bool,
    pub effort_tag: bool,
    pub fast_tag: bool,
    /// "Draws from usage credits" while fast mode is on.
    pub credits: bool,
}

/// The fast-mode toggle (ModelPicker.tsx:575).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FastRow {
    pub label: String,
    pub enabled: bool,
    /// The Opus 4.8 deprecation line with the migrate hint.
    pub deprecation: Option<String>,
    pub pick: Pick,
}

/// The Dynamic Workflows toggle (ModelPicker.tsx:354).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UltracodeRow {
    pub enabled: bool,
    pub pick: Pick,
}

/// The model list's fetch (ModelPicker.tsx:262).
#[derive(Clone, Debug, PartialEq)]
pub enum ModelList {
    Loading,
    /// "Couldn't load models", with the error.
    Failed(String),
    Loaded(Vec<ModelInfo>),
}

/// `fetchUrl` (ModelPicker.tsx:250) for a session picker:
/// `/api/sessions/<id>/model`, none without a session.
pub fn models_url(session_id: Option<&str>) -> Option<String> {
    session_id
        .filter(|s| !s.is_empty())
        .map(|id| format!("/api/sessions/{id}/model"))
}

/// The list with no session to ask (`setError("No active session")`).
pub fn no_session() -> ModelList {
    ModelList::Failed("No active session".into())
}

/// V8's message for a property read on `null` (`body.error`, `data.models`).
fn null_read(key: &str) -> String {
    format!("Cannot read properties of null (reading '{key}')")
}

/// The fetch's `.then` / `.catch` (ModelPicker.tsx:279): a failed status
/// shows the body's `error` or `HTTP <status>`; a 2xx lists `models` (none
/// when it isn't an array); a body that isn't JSON or a failed fetch
/// shows the error's message.
pub fn models_from(outcome: &FetchOutcome) -> ModelList {
    let (status, body) = match outcome {
        FetchOutcome::Failed(e) => return ModelList::Failed(e.clone()),
        FetchOutcome::Response { status, body } => (*status, body),
    };
    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
    let parsed = claudius_core::js_string::parse(text);
    if !outcome.ok() {
        // `await r.json().catch(() => ({}))`.
        let body = parsed.unwrap_or_else(|_| Value::Object(Default::default()));
        if body.is_null() {
            return ModelList::Failed(null_read("error"));
        }
        return ModelList::Failed(match js::prop(Some(&body), "error") {
            None | Some(Value::Null) => format!("HTTP {status}"),
            Some(e) => js::to_string(Some(e)),
        });
    }
    let data = match parsed {
        Ok(d) => d,
        Err(e) => return ModelList::Failed(e),
    };
    if data.is_null() {
        return ModelList::Failed(null_read("models"));
    }
    let rows = js::prop(Some(&data), "models")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(ModelInfo::parse).collect())
        .unwrap_or_default();
    ModelList::Loaded(rows)
}

/// What the picker's host passes it (SessionCard.tsx:308).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PickerInputs {
    /// `currentModel`: the session's model.
    pub current_model: Option<String>,
    /// `maxEffortLevel` (the settings).
    pub max_effort_level: Option<String>,
    pub ultracode: bool,
    /// `fastMode`: the toggle's mirror.
    pub fast_mode: bool,
    /// `fastModeState === "on"`.
    pub fast_mode_active: bool,
    /// `Date.now()` (the Opus 4.8 deprecation's removal check).
    pub now_ms: f64,
}

/// The open picker's sections below the header, for a loaded list.
#[derive(Clone, Debug, PartialEq)]
pub struct PickerModel {
    pub rows: Vec<ModelRow>,
    /// The effort section's header names the active row
    /// (`displayName || value`); no section without effort levels.
    pub effort: Option<(String, Vec<EffortChip>)>,
    pub ultracode: Option<UltracodeRow>,
    pub fast: Option<FastRow>,
}

/// The loaded picker (ModelPicker.tsx:104 on).
pub fn picker(models: &[ModelInfo], i: &PickerInputs) -> PickerModel {
    let active = find_model_entry(models, i.current_model.as_deref());
    let rows = models
        .iter()
        .map(|m| ModelRow {
            value: m.value.clone(),
            label: m.label().to_owned(),
            description: m.description.clone(),
            // Identity, so one row is checked even when two would match.
            current: active.is_some_and(|a| std::ptr::eq(a, m)),
            effort_tag: m.supports_effort,
            fast_tag: m.supports_fast_mode,
            credits: (i.fast_mode || i.fast_mode_active) && m.supports_fast_mode,
        })
        .collect();
    let levels = active
        .filter(|a| a.supports_effort)
        .and_then(|a| a.supported_effort_levels.as_ref())
        .filter(|l| !l.is_empty());
    let effort = levels.map(|levels| {
        let a = active.expect("levels come from the active row");
        let mut chips = Vec::new();
        if a.supports_adaptive_thinking != Some(false) {
            chips.push(EffortChip {
                label: "Auto",
                tone: "adaptive".into(),
                pick: Pick::Effort("auto".into()),
            });
        }
        for level in cap_effort_levels(levels, i.max_effort_level.as_deref()) {
            // `EFFORT_LABEL[level]`: an unknown level's chip is blank.
            chips.push(EffortChip {
                label: effort_label(&level).unwrap_or(""),
                tone: level.clone(),
                pick: Pick::Effort(level),
            });
        }
        if levels.iter().any(|l| l == "xhigh") {
            chips.push(EffortChip {
                label: "Ultracode",
                tone: "ultracode".into(),
                pick: Pick::Ultracode(true),
            });
        }
        (a.label().to_owned(), chips)
    });
    let xhigh = active
        .and_then(|a| a.supported_effort_levels.as_ref())
        .is_some_and(|l| l.iter().any(|x| x == "xhigh"));
    let ultracode = xhigh.then_some(UltracodeRow {
        enabled: i.ultracode,
        pick: Pick::Ultracode(!i.ultracode),
    });
    let fast = active.filter(|a| a.supports_fast_mode).map(|a| {
        let id = a.active_id();
        FastRow {
            label: fast_mode_label(Some(id)),
            enabled: i.fast_mode,
            deprecation: opus48_fast_deprecation_text(Some(id), i.now_ms)
                .map(|d| format!("{d}. {OPUS48_FAST_MIGRATE_HINT}")),
            pick: Pick::Fast(!i.fast_mode),
        }
    });
    PickerModel {
        rows,
        effort,
        ultracode,
        fast,
    }
}

/// The effort note under the chips (ModelPicker.tsx:342).
pub const EFFORT_NOTE: &str = "Applies on the next turn. If a turn is in flight, queues behind it.";

// ------------------------------------------------------------ the settings

/// `useDisableAutoMode` / `useMaxEffortLevel`'s request
/// (useDisableAutoMode.ts:28): none without a cwd.
pub fn settings_url(cwd: Option<&str>) -> Option<String> {
    let cwd = cwd?;
    let enc = claudius_core::js_string::encode_uri_component(cwd)?;
    Some(format!("/api/settings?scope=user&cwd={enc}"))
}

/// What the status line reads from the user settings.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StatusSettings {
    /// `isAutoModeDisabled(settings)`: Auto leaves the menu and the cycle.
    pub auto_mode_disabled: bool,
    /// `settings.maxEffortLevel`.
    pub max_effort_level: Option<String>,
}

impl StatusSettings {
    /// `disabledPermissionModes` (ChatSurface.tsx:443).
    pub fn disabled_modes(&self) -> Vec<String> {
        if self.auto_mode_disabled {
            vec!["auto".into()]
        } else {
            Vec::new()
        }
    }
}

/// The settings reply: a non-2xx, a failed fetch or a body that isn't
/// JSON leave the defaults (`if (!res.ok) return`, and the `.catch`).
pub fn settings_from(outcome: &FetchOutcome) -> StatusSettings {
    let FetchOutcome::Response { body, .. } = outcome else {
        return StatusSettings::default();
    };
    if !outcome.ok() {
        return StatusSettings::default();
    }
    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
    let Ok(data) = claudius_core::js_string::parse(text) else {
        return StatusSettings::default();
    };
    let settings = js::prop(Some(&data), "settings");
    StatusSettings {
        auto_mode_disabled: claudius_core::auto_mode_disabled::is_auto_mode_disabled(settings),
        // `data.settings.maxEffortLevel` (a `null` settings throws into
        // the `.catch`: no cap).
        max_effort_level: s(js::prop(settings, "maxEffortLevel")),
    }
}

// -------------------------------------------------------- the context poll

/// `useContextWatcher`'s first poll after a session or turn change, ms
/// (useContextWatcher.ts:76).
pub const CONTEXT_FIRST_POLL_MS: u64 = 1_500;

/// The next poll's delay: 8 s mid-turn, 30 s idle (useContextWatcher.ts:63).
pub fn context_poll_delay_ms(pending: bool) -> u64 {
    if pending { 8_000 } else { 30_000 }
}

/// The poll's request (useContextWatcher.ts:47).
pub fn context_url(session_id: &str) -> String {
    format!("/api/sessions/{session_id}/context?detail=summary")
}

/// A 2xx reply's `percentage ?? 0`, `None` (the reading kept) for
/// anything else; `Some(None)` for a percentage that isn't a number (no
/// chip: `typeof contextPercent === "number"` fails).
pub fn context_from(outcome: &FetchOutcome) -> Option<Option<f64>> {
    let FetchOutcome::Response { body, .. } = outcome else {
        return None;
    };
    if !outcome.ok() {
        return None;
    }
    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
    let d = claudius_core::js_string::parse(text).ok()?;
    // `d.percentage` on `null` throws, into the `catch`.
    if d.is_null() {
        return None;
    }
    Some(match js::prop(Some(&d), "percentage") {
        None | Some(Value::Null) => Some(0.0),
        Some(Value::Number(n)) => n.as_f64(),
        Some(_) => None,
    })
}
