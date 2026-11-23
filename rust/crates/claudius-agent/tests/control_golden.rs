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
//!
//! The fixture's `redelivery` cases (R12) run one fake CLI each, whose
//! `initialize` reply lists `pending_permission_requests` /
//! `pending_user_dialog_requests`: each run must match the SDK's
//! `initializationResult()`, host request, `canUseTool` calls, replies and
//! the error the stream ended with.

#[path = "support/test_bins.rs"]
mod test_bins;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use claudius_agent::{
    AgentError, CanUseTool, ElicitationRequest, HookCallback, HookMatcher, McpServerConfig,
    OnElicitation, Options, PermissionResult, Query, ToolDef, ToolOutput, ToolPermissionContext,
    ToolServer, js,
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
    put(&mut m, "serverPolicyAskOnly", b(ctx.server_policy_ask_only));
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

/// The recorder's `canUseTool`. `calls` gets each call as the TS one logs
/// it (`{requestId, toolName, input}`), and `{aborted: requestId}` once a
/// `hold` call (which waits for its cancel) is aborted. `hold_slow` then
/// takes another 100 ms to settle.
#[derive(Default)]
struct EchoPermission {
    calls: Arc<Mutex<Vec<Value>>>,
}

#[async_trait]
impl CanUseTool for EchoPermission {
    async fn can_use_tool(
        &self,
        tool_name: &str,
        input: Value,
        ctx: ToolPermissionContext,
    ) -> Option<PermissionResult> {
        self.calls.lock().unwrap().push(
            json!({"requestId": ctx.request_id, "toolName": tool_name, "input": input.clone()}),
        );
        Some(match tool_name {
            "hold" | "hold_slow" => {
                ctx.cancel.cancelled().await;
                self.calls
                    .lock()
                    .unwrap()
                    .push(json!({"aborted": ctx.request_id}));
                if tool_name == "hold_slow" {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                PermissionResult::allow(json!({
                    "input": input,
                    "ctx": ctx_json(&ctx),
                    "aborted": ctx.cancel.is_cancelled(),
                }))
            }
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

/// The recorder's `query()` options: the fake CLI on `script`, logging its
/// stdin to `log`, plus `wiredOptions()` when `calls` is given.
fn options(
    dir: &Path,
    log: &Path,
    script: &Value,
    calls: Option<Arc<Mutex<Vec<Value>>>>,
) -> Options {
    let mut opts = Options {
        path_to_claude_code_executable: Some(test_bins::private_copy(env!(
            "CARGO_BIN_EXE_claudius-fake-claude"
        ))),
        cwd: Some(dir.to_path_buf()),
        env: Some(
            [
                ("PATH", "/usr/bin:/bin".to_owned()),
                ("HOME", dir.display().to_string()),
                ("FAKE_CLAUDE_LOG", log.display().to_string()),
                (
                    "FAKE_CLAUDE_EVENTS",
                    dir.join("events.log").display().to_string(),
                ),
                ("FAKE_CLAUDE_SCRIPT", script.to_string()),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
        ),
        ..Default::default()
    };
    if let Some(calls) = calls {
        opts.can_use_tool = Some(Arc::new(EchoPermission { calls }));
        opts.on_elicitation = Some(Arc::new(EchoElicitation));
        opts.hooks = IndexMap::from([(
            "PreToolUse".to_owned(),
            vec![HookMatcher::new(Arc::new(EchoHook))],
        )]);
        opts.mcp_servers
            .insert("srv".into(), McpServerConfig::Sdk(Arc::new(echo_server())));
    }
    opts
}

/// Runs the fixture script through the Rust `Query`; returns the replies by
/// request id, as the fake CLI logged them.
async fn replay(script: &Value, wired: bool) -> BTreeMap<String, Value> {
    let tmp = tempfile::tempdir().unwrap();
    let log = tmp.path().join("stdin.log");
    let opts = options(tmp.path(), &log, script, wired.then(Default::default));
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

/// Redelivery cases the Rust `Query` must still get wrong, with why. A
/// `control_request` without a string `request_id` is dropped (PORT_PLAN
/// "SDK host gaps"), where the SDK answers it with that id, or none.
const REDELIVERY_GAPS: &[(&str, &str)] = &[(
    "odd_request_ids",
    "a redelivered request whose request_id isn't a string is dropped",
)];

/// `e`'s message. A V8 `TypeError` message (the reader threw walking the
/// lists) must come as [`AgentError::TypeError`], to the stream and to
/// every waiter, not as a CLI error reply.
fn error_text(e: &AgentError) -> String {
    let text = e.to_string();
    if text.starts_with("Cannot read properties of ") || text.ends_with(" is not iterable") {
        assert!(
            matches!(e, AgentError::TypeError(_)),
            "{text:?} isn't a TypeError: {e:?}"
        );
    }
    text
}

/// One redelivery run in the fixture's shape: `{init, host?, messages,
/// calls?, replies, end, eof}`. `calls` waits for `want_aborts` aborts, as a `hold` call
/// logs its abort from its own task.
async fn replay_redelivery(case: &Value, wired: bool, want_aborts: usize) -> Value {
    let tmp = tempfile::tempdir().unwrap();
    let log = tmp.path().join("stdin.log");
    let calls: Arc<Mutex<Vec<Value>>> = Default::default();
    let opts = options(
        tmp.path(),
        &log,
        &case["script"],
        wired.then(|| calls.clone()),
    );
    let mut q = Query::spawn(opts).await.unwrap();
    let h = q.handle();
    let host = match case["host"].as_str() {
        None => None,
        // Sent right away: polled once here, so it's waiting before the
        // `initialize` reply can be read (`request()` registers it
        // synchronously).
        Some("set_permission_mode_early") => {
            let h = h.clone();
            let mut fut = Box::pin(async move { h.set_permission_mode("default").await });
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            Some(match fut.as_mut().poll(&mut cx) {
                std::task::Poll::Ready(r) => tokio::spawn(async move { r }),
                std::task::Poll::Pending => tokio::spawn(fut),
            })
        }
        Some("set_permission_mode") => {
            let h = h.clone();
            Some(tokio::spawn(async move {
                h.initialization_result().await?;
                h.set_permission_mode("default").await
            }))
        }
        Some("set_permission_mode_after") => None,
        Some(other) => panic!("unknown host request {other}"),
    };
    let mut end = Value::Null;
    let mut messages = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(30), q.next())
            .await
            .expect("the stream never ended")
        {
            None => break,
            Some(Ok(msg)) => {
                let ty = js::to_string(msg.get("type"));
                messages.push(match msg.get("subtype") {
                    Some(st) => json!(format!("{ty}/{}", js::to_string(Some(st)))),
                    None => json!(ty),
                });
            }
            Some(Err(e)) => {
                assert!(end.is_null(), "two stream errors: {end} and {e}");
                end = json!(error_text(&e));
            }
        }
    }
    let outcome = |r: Result<(), AgentError>| match r {
        Ok(()) => json!("ok"),
        Err(e) => json!({"error": error_text(&e)}),
    };
    let init = outcome(
        tokio::time::timeout(Duration::from_secs(30), h.initialization_result())
            .await
            .expect("initialize never settled")
            .map(|_| ()),
    );
    let host = match (host, case["host"].as_str()) {
        (None, Some("set_permission_mode_after")) => {
            let r = tokio::time::timeout(Duration::from_secs(30), h.set_permission_mode("default"))
                .await
                .expect("the host request never settled");
            Some(outcome(r))
        }
        (Some(task), _) => Some(outcome(
            tokio::time::timeout(Duration::from_secs(30), task)
                .await
                .expect("the host request never settled")
                .unwrap(),
        )),
        (None, _) => None,
    };
    tokio::time::timeout(Duration::from_secs(30), h.wait_exit())
        .await
        .expect("the fake CLI never exited");
    let eof = std::fs::read_to_string(tmp.path().join("events.log"))
        .is_ok_and(|events| events.contains("\"eof\""));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let aborts = || {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.get("aborted").is_some())
            .count()
    };
    while aborts() < want_aborts && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut replies: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for line in std::fs::read_to_string(&log).unwrap().lines() {
        let msg: Value = serde_json::from_str(line).unwrap();
        if msg["type"] != "control_response" {
            continue;
        }
        let key = match msg["response"].get("request_id") {
            Some(Value::String(id)) => id.clone(),
            Some(id) => format!("#{}", js::stringify(id)),
            None => "#undefined".to_owned(),
        };
        replies
            .entry(key)
            .or_default()
            .push(msg["response"].clone());
    }
    let mut run = Map::new();
    run.insert("init".into(), init);
    if let Some(host) = host {
        run.insert("host".into(), host);
    }
    run.insert("messages".into(), Value::Array(messages));
    if wired {
        run.insert("calls".into(), Value::Array(calls.lock().unwrap().clone()));
    }
    run.insert("replies".into(), json!(replies));
    run.insert("end".into(), end);
    run.insert("eof".into(), json!(eof));
    Value::Object(run)
}

/// A run with what's ordered only by scheduling put in a fixed order: each
/// request's replies, and the `hold` aborts (each is logged by the woken
/// callback's own task). The other calls keep their order, which is the
/// order the requests were read in.
fn normalize(run: &Value) -> Value {
    let sorted = |mut v: Vec<Value>| {
        v.sort_by_key(js::stringify);
        Value::Array(v)
    };
    let mut run = run.clone();
    if let Some(Value::Array(calls)) = run.get("calls").cloned() {
        let (aborts, calls): (Vec<Value>, Vec<Value>) =
            calls.into_iter().partition(|c| c.get("aborted").is_some());
        run["calls"] = Value::Array(calls);
        run["aborts"] = sorted(aborts);
    }
    if let Some(Value::Object(replies)) = run.get("replies").cloned() {
        run["replies"] = Value::Object(
            replies
                .into_iter()
                .map(|(k, v)| (k, sorted(v.as_array().cloned().unwrap_or_default())))
                .collect(),
        );
    }
    run
}

#[tokio::test(flavor = "multi_thread")]
async fn redelivered_prompts_match_the_sdk() {
    use futures::StreamExt;
    let fx = fixture();
    let cases = fx["redelivery"].as_array().unwrap();
    let runs: Vec<(&Value, &str, &Value)> = cases
        .iter()
        .flat_map(|case| {
            case["recorded"]
                .as_object()
                .unwrap()
                .iter()
                .map(move |(setup, want)| (case, setup.as_str(), want))
        })
        .collect();
    let results: Vec<_> =
        futures::stream::iter(runs.iter().map(|&(case, setup, want)| async move {
            let want_aborts = want.get("calls").and_then(Value::as_array).map_or(0, |c| {
                c.iter().filter(|c| c.get("aborted").is_some()).count()
            });
            let got = replay_redelivery(case, setup == "wired", want_aborts).await;
            (case["name"].as_str().unwrap(), setup, want, got)
        }))
        .buffer_unordered(8)
        .collect()
        .await;
    let mut failures = Vec::new();
    let mut gaps_seen = Vec::new();
    for (name, setup, want, got) in results {
        let (want, got) = (
            js::stringify(&normalize(want)),
            js::stringify(&normalize(&got)),
        );
        if REDELIVERY_GAPS.iter().any(|(g, _)| *g == name) {
            assert_ne!(
                want, got,
                "{name}/{setup} now matches the SDK: drop it from REDELIVERY_GAPS"
            );
            gaps_seen.push(name);
        } else if want != got {
            failures.push(format!("{name}/{setup}:\n  sdk:  {want}\n  rust: {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    for (gap, _) in REDELIVERY_GAPS {
        assert!(
            gaps_seen.contains(gap),
            "REDELIVERY_GAPS entry {gap} isn't in the fixture"
        );
    }
    assert!(
        runs.len() >= 40,
        "fixture has only {} redelivery runs",
        runs.len()
    );
    let threw = cases
        .iter()
        .filter(|c| {
            c["recorded"]
                .as_object()
                .unwrap()
                .values()
                .any(|r| r["end"].is_string())
        })
        .count();
    assert!(threw >= 10, "only {threw} redelivery cases end the stream");
}
