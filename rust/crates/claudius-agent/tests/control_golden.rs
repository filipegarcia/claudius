//! Replays `fixtures/control_golden.json` (recorded by
//! `rust/scripts/control-golden.mjs` from the real TS SDK) against the Rust
//! `Query`: the same `claudius-fake-claude` script fires every
//! CLI-initiated control request, and each reply must match the SDK's
//! byte for byte (`JSON.stringify`), or be absent where the SDK leaves the
//! request unanswered.
//!
//! The callbacks here mirror the recorder's `wiredOptions()`: they echo what
//! they were handed in the shape the TS callbacks see it, so a field the Rust
//! context drops or renames shows up as a mismatch.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use claudius_agent::{
    CanUseTool, ElicitationRequest, HookCallback, HookMatcher, McpServerConfig, OnElicitation,
    Options, PermissionResult, Query, ToolDef, ToolOutput, ToolPermissionContext, ToolServer, js,
};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

/// Requests whose SDK reply depends on zod validation the Rust MCP server
/// doesn't do (see PORT_PLAN "SDK host gaps"). They must still differ, so
/// closing a gap forces this list to shrink.
const GAPS: &[(&str, &str)] = &[
    (
        "mcp_initialize_no_params",
        "initialize params are zod-validated (-32603 + the issue list)",
    ),
    (
        "mcp_tools_call_no_name",
        "tools/call params are zod-validated (-32603 + the issue list)",
    ),
    (
        "mcp_tools_call_bad_args",
        "tool arguments are zod-validated against the input schema",
    ),
    (
        "mcp_tools_call_no_args",
        "tool arguments are zod-validated against the input schema",
    ),
];

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/control_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Inserts `v` under `k` when present, like a JS object literal whose
/// `undefined` values `JSON.stringify` drops.
fn put(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(k.into(), v);
    }
}

/// The `ctx` the TS `canUseTool` receives, minus `signal`, in its key order.
fn ctx_json(ctx: &ToolPermissionContext) -> Value {
    let s = |v: &Option<String>| v.clone().map(Value::String);
    let b = |v: Option<bool>| v.map(Value::Bool);
    let mut m = Map::new();
    put(&mut m, "suggestions", ctx.suggestions.clone());
    put(&mut m, "blockedPath", s(&ctx.blocked_path));
    put(&mut m, "mcpServer", ctx.mcp_server.clone());
    put(&mut m, "decisionReason", s(&ctx.decision_reason));
    put(&mut m, "decisionReasonType", s(&ctx.decision_reason_type));
    put(&mut m, "decisionReasonCode", s(&ctx.decision_reason_code));
    put(&mut m, "title", s(&ctx.title));
    put(&mut m, "displayName", s(&ctx.display_name));
    put(&mut m, "description", s(&ctx.description));
    put(&mut m, "defaultToNo", b(ctx.default_to_no));
    put(
        &mut m,
        "suppressAlwaysAllowRule",
        b(ctx.suppress_always_allow_rule),
    );
    put(&mut m, "toolUseID", s(&ctx.tool_use_id));
    put(&mut m, "agentID", s(&ctx.agent_id));
    put(&mut m, "plugin", s(&ctx.plugin));
    m.insert("requestId".into(), json!(ctx.request_id));
    put(
        &mut m,
        "requiresUserInteraction",
        b(ctx.requires_user_interaction),
    );
    put(&mut m, "serverPrompt", s(&ctx.server_prompt));
    put(
        &mut m,
        "computerFolder",
        ctx.computer_folder
            .as_ref()
            .map(|f| json!({"path": f.path, "computer_name": f.computer_name})),
    );
    put(&mut m, "matchedAskRule", ctx.matched_ask_rule.clone());
    Value::Object(m)
}

/// The request the TS `onElicitation` receives, in its key order.
fn elicitation_json(req: &ElicitationRequest) -> Value {
    let s = |v: &Option<String>| v.clone().map(Value::String);
    let mut m = Map::new();
    put(&mut m, "serverName", s(&req.server_name));
    put(&mut m, "message", s(&req.message));
    put(&mut m, "mode", s(&req.mode));
    put(&mut m, "url", s(&req.url));
    put(&mut m, "elicitationId", s(&req.elicitation_id));
    put(&mut m, "requestedSchema", req.requested_schema.clone());
    put(&mut m, "title", s(&req.title));
    put(&mut m, "displayName", s(&req.display_name));
    put(&mut m, "description", s(&req.description));
    Value::Object(m)
}

struct EchoPermission;

#[async_trait]
impl CanUseTool for EchoPermission {
    async fn can_use_tool(
        &self,
        tool_name: &str,
        input: Value,
        ctx: ToolPermissionContext,
    ) -> Option<PermissionResult> {
        Some(match tool_name {
            "silent" => return None,
            "deny" => PermissionResult::Deny {
                message: format!("no {}", ctx.tool_use_id.as_deref().unwrap_or("undefined")),
                interrupt: true,
            },
            "always" => PermissionResult::Allow {
                updated_input: Some(input),
                updated_permissions: ctx.suggestions.as_ref().and_then(|s| s.as_array().cloned()),
            },
            _ => PermissionResult::allow(json!({
                "input": input,
                "ctx": ctx_json(&ctx),
                "aborted": ctx.cancel.is_cancelled(),
            })),
        })
    }
}

struct EchoElicitation;

#[async_trait]
impl OnElicitation for EchoElicitation {
    async fn on_elicitation(&self, req: ElicitationRequest) -> Option<Value> {
        if req.message.as_deref() == Some("silent") {
            return None;
        }
        Some(json!({
            "action": "accept",
            "content": {
                "req": elicitation_json(&req),
                "requestId": req.request_id,
                "aborted": req.cancel.is_cancelled(),
            },
        }))
    }
}

struct EchoHook;

#[async_trait]
impl HookCallback for EchoHook {
    async fn call(
        &self,
        input: Value,
        tool_use_id: Option<String>,
        cancel: CancellationToken,
    ) -> Value {
        json!({
            "continue": true,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "echo": {"input": input, "toolUseID": tool_use_id, "aborted": cancel.is_cancelled()},
            },
        })
    }
}

/// The recorder's `srv`: `tool("echo", "Echo the message", {msg:
/// z.string().describe("text")}, ...)`, as zod-to-json-schema prints it.
fn echo_server() -> ToolServer {
    let schema = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {"msg": {"type": "string", "description": "text"}},
        "required": ["msg"],
    });
    ToolServer::new(
        "srv",
        "1.0.0",
        vec![ToolDef::new(
            "echo",
            "Echo the message",
            schema,
            |args| async move { ToolOutput::text(format!("echo:{}", js::to_string(args.get("msg")))) },
        )],
    )
}

/// Runs the fixture script through the Rust `Query`; returns the replies by
/// request id, as the fake CLI logged them.
async fn replay(script: &Value, wired: bool) -> BTreeMap<String, Value> {
    let tmp = tempfile::tempdir().unwrap();
    let log = tmp.path().join("stdin.log");
    let mut opts = Options {
        path_to_claude_code_executable: Some(PathBuf::from(env!(
            "CARGO_BIN_EXE_claudius-fake-claude"
        ))),
        cwd: Some(tmp.path().to_path_buf()),
        env: Some(
            [
                ("PATH", "/usr/bin:/bin".to_owned()),
                ("HOME", tmp.path().display().to_string()),
                ("FAKE_CLAUDE_LOG", log.display().to_string()),
                ("FAKE_CLAUDE_SCRIPT", script.to_string()),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
        ),
        ..Default::default()
    };
    if wired {
        opts.can_use_tool = Some(Arc::new(EchoPermission));
        opts.on_elicitation = Some(Arc::new(EchoElicitation));
        opts.hooks = IndexMap::from([(
            "PreToolUse".to_owned(),
            vec![HookMatcher::new(Arc::new(EchoHook))],
        )]);
        opts.mcp_servers
            .insert("srv".into(), McpServerConfig::Sdk(Arc::new(echo_server())));
    }
    let mut q = Query::spawn(opts).await.unwrap();
    // The fake exits 0 once it has collected the replies.
    loop {
        match tokio::time::timeout(Duration::from_secs(30), q.next())
            .await
            .expect("fake CLI never exited")
        {
            None => break,
            Some(Ok(_)) => {}
            Some(Err(e)) => panic!("query failed: {e}"),
        }
    }
    let mut replies = BTreeMap::new();
    for line in std::fs::read_to_string(&log).unwrap().lines() {
        let msg: Value = serde_json::from_str(line).unwrap();
        if msg["type"] != "control_response" {
            continue;
        }
        if let Some(id) = msg["response"]["request_id"].as_str() {
            let dup = replies.insert(id.to_owned(), msg["response"].clone());
            assert!(dup.is_none(), "two replies to {id}");
        }
    }
    replies
}

#[tokio::test(flavor = "multi_thread")]
async fn control_requests_match_the_sdk() {
    let fx = fixture();
    let ids = fx["ids"].as_object().unwrap();
    let (bare, wired) = tokio::join!(replay(&fx["script"], false), replay(&fx["script"], true));
    let mut failures = Vec::new();
    let mut gaps_seen = Vec::new();
    for (case, replies) in [("bare", bare), ("wired", wired)] {
        let expected = fx["cases"][case].as_object().unwrap();
        assert_eq!(expected.len(), ids.len());
        for (name, id) in ids {
            let want = &expected[name];
            let got = replies.get(id.as_str().unwrap()).unwrap_or(&Value::Null);
            let same = js::stringify(want) == js::stringify(got);
            if GAPS.iter().any(|(g, _)| g == name) && case == "wired" {
                assert!(!same, "{name} now matches the SDK: drop it from GAPS");
                gaps_seen.push(name.as_str());
            } else if !same {
                failures.push(format!(
                    "{case}/{name}:\n  sdk:  {}\n  rust: {}",
                    js::stringify(want),
                    js::stringify(got)
                ));
            }
        }
    }
    assert_eq!(
        gaps_seen.len(),
        GAPS.len(),
        "a GAPS entry isn't in the fixture"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(ids.len() >= 75, "fixture has only {} requests", ids.len());
}

/// Every subtype the SDK handles or deliberately ignores (per
/// `rust/scripts/sdk-snapshot.json`, kept current by `sdk-diff.sh`) is
/// exercised by the fixture, so a subtype added in an SDK bump fails here
/// until `control-golden.mjs` records it.
#[test]
fn fixture_covers_every_sdk_subtype() {
    let snap: Value = serde_json::from_str(
        &std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/sdk-snapshot.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let fx = fixture();
    let sent: Vec<&str> = fx["script"]["on_init"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|step| step["$send"]["subtype"].as_str())
        .collect();
    let reqs = &snap["controlRequests"];
    let expected: Vec<&str> = ["hostHandles", "hostIgnores"]
        .iter()
        .flat_map(|k| reqs[k].as_array().unwrap())
        .map(|s| s.as_str().unwrap())
        .collect();
    assert!(expected.len() >= 17, "snapshot lists only {expected:?}");
    let missing: Vec<&str> = expected.into_iter().filter(|s| !sent.contains(s)).collect();
    assert!(missing.is_empty(), "not recorded: {missing:?}");
}
