//! What session.ts `canUseTool` and `onElicitation` work out from a CLI
//! control request before parking it: the tool-budget cap
//! (`lib/shared/tool-budget.ts` `resolveCap` / `checkToolBudget`), the
//! ExitPlanMode plan text, and the `permission_request` /
//! `ask_user_question` / `plan_approval_request` / `mcp_elicitation_request`
//! events in their TS key order (S27b).
//!
//! The SDK hands those callbacks the request's fields as they arrived
//! (`ctx.toolUseID`, `ctx.title`, `request.serverName`, …: any JSON type, or
//! `undefined` when the key is missing), and the events carry them on as
//! is, so these read the raw request rather than the typed context. `None`
//! is JS `undefined`: `JSON.stringify` drops the key.
//!
//! Replayed against the real TS session through the fake CLI in
//! `tests/session_callbacks_golden.rs`.

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::events::allow_rule_suggestions;

/// `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` / `_SUBAGENTS_`: the env
/// fallbacks of the two budgets, by [`budget_kind`] index.
pub const BUDGET_ENV: [&str; 2] = [
    "CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION",
    "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION",
];

/// `toolBudgetKindFor`: 0 for WebSearch, 1 for a subagent spawn (`Task`, or
/// `Agent`, its current wire name).
pub fn budget_kind(tool: &str) -> Option<usize> {
    match tool {
        "WebSearch" => Some(0),
        "Task" | "Agent" => Some(1),
        _ => None,
    }
}

/// `resolveCap(configured, envRaw)`: the per-cwd Limits value when it is a
/// positive number (as is: `2.5` stays `2.5`), else `parseEnvCap(envRaw)`:
/// `Number(raw.trim())` (`0x10`, `0b11`, `0o7`, `1e1`, ` 2 `) when that is a
/// positive integer.
pub fn resolve_cap(configured: Option<f64>, env_raw: Option<&str>) -> Option<f64> {
    if let Some(c) = configured.filter(|c| *c > 0.0) {
        return Some(c);
    }
    let n = js::to_number(env_raw?);
    // `Number.isInteger(n) && n > 0` (`fract()` is NaN for ±Infinity / NaN).
    (n.fract() == 0.0 && n > 0.0).then_some(n)
}

/// `checkToolBudget(kind, cap, used)`: the denial once `used` reaches the
/// cap, the cap printed as JS prints the number (`2.5`, `1e-7`).
pub fn budget_denial(kind: usize, cap: Option<f64>, used: u64) -> Option<String> {
    let cap = cap.filter(|c| *c > 0.0 && used as f64 >= *c)?;
    let label = if kind == 0 {
        "web search"
    } else {
        "subagent spawn"
    };
    Some(format!(
        "Session {label} cap reached ({}). Raise or disable it in Settings → Limits, or run /clear to start a fresh session with a reset count.",
        js::number_to_string(cap)
    ))
}

/// The plan an ExitPlanMode prompt shows: its string `plan`, else
/// `JSON.stringify(input, null, 2)`.
pub fn plan_text(input: &Value) -> String {
    match js::prop(Some(input), "plan") {
        Some(Value::String(p)) => p.clone(),
        _ => js::stringify_pretty(input),
    }
}

/// `ctx.toolUseID`: the request's `tool_use_id` as sent.
pub fn tool_use_id(raw: &Value) -> Option<Value> {
    js::prop(Some(raw), "tool_use_id").cloned()
}

fn put(m: &mut Map<String, Value>, key: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(key.into(), v);
    }
}

/// `{ type: "ask_user_question", requestId, toolUseId, questions }`.
pub fn ask_event(request_id: &str, tool_use_id: Option<&Value>, questions: &[Value]) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!("ask_user_question"));
    m.insert("requestId".into(), json!(request_id));
    put(&mut m, "toolUseId", tool_use_id.cloned());
    m.insert("questions".into(), json!(questions));
    Value::Object(m)
}

/// `{ type: "plan_approval_request", requestId, toolUseId, plan, raw }`.
/// `raw` is `None` where TS leaves it out: the subscribe re-emit drops a
/// falsy one (`...(pending.raw ? { raw } : {})`).
pub fn plan_event(
    request_id: &str,
    tool_use_id: Option<&Value>,
    plan: &str,
    raw: Option<&Value>,
) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!("plan_approval_request"));
    m.insert("requestId".into(), json!(request_id));
    put(&mut m, "toolUseId", tool_use_id.cloned());
    m.insert("plan".into(), json!(plan));
    put(&mut m, "raw", raw.cloned());
    Value::Object(m)
}

/// The `suggestedRules` of a `permission_request`: each rule of each
/// `addRules` / `allow` suggestion as `{ toolName, ruleContent? }`, with
/// `toolName` read as is (missing stays missing) and a truthy `ruleContent`
/// of any type kept.
pub fn suggested_rules(suggestions: Option<&Value>) -> Vec<Value> {
    allow_rule_suggestions(suggestions)
        .iter()
        .flat_map(|u| u["rules"].as_array().cloned().unwrap_or_default())
        .map(|r| {
            let mut o = Map::new();
            put(&mut o, "toolName", js::prop(Some(&r), "toolName").cloned());
            put(
                &mut o,
                "ruleContent",
                js::prop(Some(&r), "ruleContent")
                    .filter(|c| js::truthy(c))
                    .cloned(),
            );
            Value::Object(o)
        })
        .collect()
}

/// The `permission_request` `canUseTool` broadcasts. `raw` is the
/// `can_use_tool` request; `mcp_server` the SDK's `{ name, source }` copy of
/// a truthy `mcp_server`.
pub fn permission_event(
    request_id: &str,
    tool_name: &str,
    raw: &Value,
    mcp_server: Option<Value>,
) -> Value {
    let field = |k: &str| js::prop(Some(raw), k).cloned();
    let mut m = Map::new();
    m.insert("type".into(), json!("permission_request"));
    m.insert("requestId".into(), json!(request_id));
    m.insert("toolName".into(), json!(tool_name));
    put(&mut m, "toolUseId", field("tool_use_id"));
    put(&mut m, "input", field("input"));
    put(&mut m, "title", field("title"));
    put(&mut m, "description", field("description"));
    put(&mut m, "displayName", field("display_name"));
    put(&mut m, "agentId", field("agent_id"));
    put(&mut m, "defaultToNo", field("default_to_no"));
    put(
        &mut m,
        "suppressAlwaysAllowRule",
        field("suppress_always_allow_rule"),
    );
    put(&mut m, "mcpServer", mcp_server);
    m.insert(
        "suggestedRules".into(),
        Value::Array(suggested_rules(js::prop(
            Some(raw),
            "permission_suggestions",
        ))),
    );
    Value::Object(m)
}

/// The `mcp_elicitation_request` `onElicitation` broadcasts, from the
/// `elicitation` request: `serverName` and `message` as sent, `mode` `url`
/// or `form`, then each optional field only when truthy, in TS order.
pub fn elicitation_event(request_id: &str, raw: &Value) -> Value {
    let field = |k: &str| js::prop(Some(raw), k).cloned();
    let truthy = |k: &str| field(k).filter(js::truthy);
    let mut m = Map::new();
    m.insert("type".into(), json!("mcp_elicitation_request"));
    m.insert("requestId".into(), json!(request_id));
    put(&mut m, "serverName", field("mcp_server_name"));
    put(&mut m, "message", field("message"));
    let url_mode = field("mode").is_some_and(|v| v == "url");
    m.insert("mode".into(), json!(if url_mode { "url" } else { "form" }));
    put(&mut m, "url", truthy("url"));
    put(&mut m, "elicitationId", truthy("elicitation_id"));
    put(&mut m, "requestedSchema", truthy("requested_schema"));
    put(&mut m, "title", truthy("title"));
    put(&mut m, "displayName", truthy("display_name"));
    put(&mut m, "description", truthy("description"));
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_follow_resolve_cap() {
        assert_eq!(resolve_cap(Some(2.5), Some("9")), Some(2.5));
        assert_eq!(resolve_cap(Some(0.0), Some("0x10")), Some(16.0));
        assert_eq!(resolve_cap(Some(-1.0), Some("0b11")), Some(3.0));
        assert_eq!(resolve_cap(None, Some("0o7")), Some(7.0));
        assert_eq!(resolve_cap(None, Some(" 1e1\n")), Some(10.0));
        for raw in ["", "0", "-2", "1.5", "Infinity", "abc", "0x", "1_0"] {
            assert_eq!(resolve_cap(None, Some(raw)), None, "{raw:?}");
        }
        assert_eq!(resolve_cap(None, None), None);
    }

    #[test]
    fn denials_print_the_cap_like_js() {
        assert_eq!(budget_denial(0, Some(2.5), 2), None);
        let msg = budget_denial(0, Some(2.5), 3).unwrap();
        assert!(
            msg.starts_with("Session web search cap reached (2.5). "),
            "{msg}"
        );
        // JS prints `1e-7` where Rust's `Display` prints `0.0000001`.
        let msg = budget_denial(1, Some(1e-7), 1).unwrap();
        assert!(
            msg.starts_with("Session subagent spawn cap reached (1e-7). "),
            "{msg}"
        );
        assert_eq!(budget_denial(1, Some(1e-7), 0), None);
        assert_eq!(budget_denial(0, None, 99), None);
        assert_eq!(budget_denial(0, Some(0.0), 99), None);
        assert_eq!(budget_denial(1, Some(-1.0), 99), None);
    }

    #[test]
    fn plan_text_is_pretty_json_text() {
        let input: Value = serde_json::from_str(r#"{"b":2.0,"10":1e21,"2":[]}"#).unwrap();
        assert_eq!(
            plan_text(&input),
            "{\n  \"2\": [],\n  \"10\": 1e+21,\n  \"b\": 2\n}"
        );
        assert_eq!(plan_text(&json!({"plan": "p"})), "p");
        assert_eq!(plan_text(&json!("s")), "\"s\"");
    }
}
