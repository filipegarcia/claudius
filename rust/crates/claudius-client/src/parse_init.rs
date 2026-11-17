//! `lib/shared/parse-init.ts`: the SDK `system/init` message read into a
//! stable shape (tools, slash commands, subagents, skills, cwd, model,
//! permission mode, the advisor, fast mode, the applied effort and the
//! plugin load errors), tolerant of anything malformed.
//!
//! `plugin_errors` goes through the server's port of the same reader
//! (`claudius_core::plugins::plugin_error_array`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::text::{as_str, prop};

/// `PluginLoadError` (SDK 0.3.283): a plugin that hit a load-time error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginLoadError {
    pub plugin: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// `InitInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitInfo {
    pub tools: Vec<String>,
    pub slash_commands: Vec<String>,
    pub agents: Vec<String>,
    pub skills: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Any non-empty string (the TS casts it to `PermissionMode`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_code_version: Option<String>,
    /// `tools.includes("advisor")`.
    pub advisor_active: bool,
    /// `off`, `cooldown` or `on`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_mode_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_mode_disabled_reason: Option<String>,
    /// `None` when the message has no usable `effort` (`undefined`),
    /// `Some(None)` for an explicit `null` (no effort parameter will be
    /// sent), else the level.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub effort: Option<Option<String>>,
    pub plugin_errors: Vec<PluginLoadError>,
}

/// The applied effort levels `parseInitSystemMessage` accepts.
const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// `stringArray(v)`: the string items of an array, else `[]`.
fn string_array(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

/// `optionalString(v)`: a non-empty string.
fn optional_string(v: Option<&Value>) -> Option<String> {
    as_str(v).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// `parseInitSystemMessage(msg)`: the init fields of a raw `system/init`
/// message. `msg` may be anything; a field of the wrong type is empty or
/// absent, never an error.
pub fn parse_init_system_message(msg: Option<&Value>) -> InitInfo {
    // `(msg ?? {})`: `null`, like any other non-object, has none of these
    // keys.
    let get = |k: &str| prop(msg, k);
    let tools = string_array(get("tools"));
    let advisor_active = tools.iter().any(|t| t == "advisor");
    let fast_mode_state = as_str(get("fast_mode_state"))
        .filter(|s| matches!(*s, "off" | "cooldown" | "on"))
        .map(str::to_owned);
    let effort = match get("effort") {
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if EFFORT_LEVELS.contains(&s.as_str()) => Some(Some(s.clone())),
        _ => None,
    };
    let plugin_errors = claudius_core::plugins::plugin_error_array(get("plugin_errors"))
        .into_iter()
        .map(|row| serde_json::from_value(row).expect("plugin_error_array rows are well-formed"))
        .collect();
    InitInfo {
        tools,
        slash_commands: string_array(get("slash_commands")),
        agents: string_array(get("agents")),
        skills: string_array(get("skills")),
        cwd: optional_string(get("cwd")),
        model: optional_string(get("model")),
        permission_mode: optional_string(get("permissionMode")),
        claude_code_version: optional_string(get("claude_code_version")),
        advisor_active,
        fast_mode_state,
        fast_mode_disabled_reason: optional_string(get("fast_mode_disabled_reason")),
        effort,
        plugin_errors,
    }
}

/// `Option<Option<T>>` in snapshot JSON: absent (`None`, with
/// `skip_serializing_if = "Option::is_none"` and `default`), `null`
/// (`Some(None)`), or the value.
pub(crate) mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer, T: Serialize>(
        v: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match v {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}
