//! `canUseTool` / `onElicitation` callback contracts.

use async_trait::async_trait;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::js;

/// Everything the CLI attached to a `can_use_tool` control request, in the
/// shape the TS SDK hands to `canUseTool(toolName, input, ctx)`.
#[derive(Clone, Debug)]
pub struct ToolPermissionContext {
    pub request_id: String,
    pub tool_use_id: Option<String>,
    pub agent_id: Option<String>,
    /// `permission_suggestions` — `PermissionUpdate[]` the CLI proposes for
    /// an "always allow" answer.
    pub suggestions: Option<Value>,
    pub blocked_path: Option<String>,
    pub decision_reason: Option<String>,
    pub title: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub default_to_no: Option<bool>,
    pub suppress_always_allow_rule: Option<bool>,
    /// `{ name, source }` for `mcp__*` tools: the SDK copies just those two
    /// keys off any truthy `mcp_server` (so a non-object gives `{}`).
    pub mcp_server: Option<Value>,
    /// `decision_reason_type` / `decision_reason_code`, when strings.
    pub decision_reason_type: Option<String>,
    pub decision_reason_code: Option<String>,
    /// The plugin that owns the tool, when a string.
    pub plugin: Option<String>,
    /// `requires_user_interaction`, when a boolean.
    pub requires_user_interaction: Option<bool>,
    /// `server_prompt`, when a string.
    pub server_prompt: Option<String>,
    /// `computer_folder`, when both its fields are strings.
    pub computer_folder: Option<ComputerFolder>,
    /// `{ source, toolName, ruleContent? }` from a truthy `matched_ask_rule`
    /// (`tool_name` / `rule_content` renamed, other keys dropped).
    pub matched_ask_rule: Option<Value>,
    /// The raw request body, for fields this crate doesn't model yet.
    pub raw: Value,
    /// Fires when the CLI sends `control_cancel_request` for this prompt or
    /// the query closes.
    pub cancel: CancellationToken,
}

/// The `computer_folder` of a `can_use_tool` request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerFolder {
    pub path: String,
    pub computer_name: String,
}

/// `{ k: v[k] }` for each key of `v` that's present, as an object literal
/// reading `v.a`, `v.b` off a JS value prints after `JSON.stringify`.
fn pick(v: &Value, keys: &[(&str, &str)]) -> Value {
    let mut out = Map::new();
    for (from, to) in keys {
        if let Some(x) = js::prop(Some(v), from) {
            out.insert((*to).into(), x.clone());
        }
    }
    Value::Object(out)
}

impl ToolPermissionContext {
    pub(crate) fn from_request(request_id: &str, req: &Value, cancel: CancellationToken) -> Self {
        let s = |k: &str| req.get(k).and_then(Value::as_str).map(str::to_owned);
        let b = |k: &str| req.get(k).and_then(Value::as_bool);
        let truthy = |k: &str| req.get(k).filter(|v| js::truthy(v));
        Self {
            request_id: request_id.to_owned(),
            tool_use_id: s("tool_use_id"),
            agent_id: s("agent_id"),
            suggestions: req
                .get("permission_suggestions")
                .cloned()
                .filter(|v| !v.is_null()),
            blocked_path: s("blocked_path"),
            decision_reason: s("decision_reason"),
            title: s("title"),
            display_name: s("display_name"),
            description: s("description"),
            default_to_no: b("default_to_no"),
            suppress_always_allow_rule: b("suppress_always_allow_rule"),
            mcp_server: truthy("mcp_server")
                .map(|v| pick(v, &[("name", "name"), ("source", "source")])),
            decision_reason_type: s("decision_reason_type"),
            decision_reason_code: s("decision_reason_code"),
            plugin: s("plugin"),
            requires_user_interaction: b("requires_user_interaction"),
            server_prompt: s("server_prompt"),
            computer_folder: req.get("computer_folder").and_then(|f| {
                Some(ComputerFolder {
                    path: f.get("path")?.as_str()?.to_owned(),
                    computer_name: f.get("computer_name")?.as_str()?.to_owned(),
                })
            }),
            matched_ask_rule: truthy("matched_ask_rule").map(|r| {
                pick(
                    r,
                    &[
                        ("source", "source"),
                        ("tool_name", "toolName"),
                        ("rule_content", "ruleContent"),
                    ],
                )
            }),
            raw: req.clone(),
            cancel,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PermissionResult {
    Allow {
        updated_input: Option<Value>,
        /// `PermissionUpdate[]`, e.g. `{type:"addRules", behavior:"allow", rules, destination}`.
        updated_permissions: Option<Vec<Value>>,
    },
    Deny {
        message: String,
        interrupt: bool,
    },
}

impl PermissionResult {
    pub fn allow(input: Value) -> Self {
        PermissionResult::Allow {
            updated_input: Some(input),
            updated_permissions: None,
        }
    }
    pub fn deny(message: impl Into<String>) -> Self {
        PermissionResult::Deny {
            message: message.into(),
            interrupt: false,
        }
    }

    /// Wire form: `{ ...result, toolUseID }` (see `processControlRequest`).
    pub fn to_wire(&self, tool_use_id: Option<&str>) -> Value {
        let mut m = Map::new();
        match self {
            PermissionResult::Allow {
                updated_input,
                updated_permissions,
            } => {
                m.insert("behavior".into(), json!("allow"));
                if let Some(i) = updated_input {
                    m.insert("updatedInput".into(), i.clone());
                }
                if let Some(p) = updated_permissions {
                    m.insert("updatedPermissions".into(), json!(p));
                }
            }
            PermissionResult::Deny { message, interrupt } => {
                m.insert("behavior".into(), json!("deny"));
                m.insert("message".into(), json!(message));
                if *interrupt {
                    m.insert("interrupt".into(), json!(true));
                }
            }
        }
        if let Some(id) = tool_use_id {
            m.insert("toolUseID".into(), json!(id));
        }
        Value::Object(m)
    }
}

#[async_trait]
pub trait CanUseTool: Send + Sync {
    /// Return `None` to leave the request unanswered (another client of the
    /// same session will settle it) — the TS SDK's `null` return.
    async fn can_use_tool(
        &self,
        tool_name: &str,
        input: Value,
        ctx: ToolPermissionContext,
    ) -> Option<PermissionResult>;
}

/// MCP elicitation request (`elicitation` control request).
#[derive(Clone, Debug)]
pub struct ElicitationRequest {
    pub request_id: String,
    pub server_name: Option<String>,
    pub message: Option<String>,
    pub mode: Option<String>,
    pub url: Option<String>,
    pub elicitation_id: Option<String>,
    pub requested_schema: Option<Value>,
    pub title: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub raw: Value,
    pub cancel: CancellationToken,
}

impl ElicitationRequest {
    pub(crate) fn from_request(request_id: &str, req: &Value, cancel: CancellationToken) -> Self {
        let s = |k: &str| req.get(k).and_then(Value::as_str).map(str::to_owned);
        Self {
            request_id: request_id.to_owned(),
            server_name: s("mcp_server_name"),
            message: s("message"),
            mode: s("mode"),
            url: s("url"),
            elicitation_id: s("elicitation_id"),
            requested_schema: req.get("requested_schema").cloned(),
            title: s("title"),
            display_name: s("display_name"),
            description: s("description"),
            raw: req.clone(),
            cancel,
        }
    }
}

#[async_trait]
pub trait OnElicitation: Send + Sync {
    /// `{ action: "accept" | "decline" | "cancel", content? }`, or `None` to
    /// leave it unanswered.
    async fn on_elicitation(&self, req: ElicitationRequest) -> Option<Value>;
}
