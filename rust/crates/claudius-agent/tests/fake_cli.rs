//! Protocol tests against the scripted `claudius-fake-claude` binary.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use claudius_agent::{
    AgentError, CanUseTool, FeedbackOptions, HookMatcher, McpServerConfig, Options,
    PermissionResult, Query, SdkMcpServer, SdkServerSettings, ToolDef, ToolOutput,
    ToolPermissionContext, ToolServer, hook_fn,
};
use indexmap::IndexMap;
use serde_json::{Value, json};

fn fake_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_claudius-fake-claude"))
}

fn base_options() -> Options {
    Options {
        path_to_claude_code_executable: Some(fake_bin()),
        session_id: Some("11111111-1111-4111-8111-111111111111".into()),
        ..Default::default()
    }
}

fn user(text: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": text},
           "parent_tool_use_id": null, "session_id": ""})
}

/// Drain until a `result`, returning the assistant text seen.
async fn run_turn(q: &mut Query) -> String {
    let mut text = String::new();
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), q.next())
            .await
            .expect("timed out waiting for CLI")
            .expect("stream ended early")
            .expect("stream error");
        match msg["type"].as_str() {
            Some("assistant") => {
                text = msg["message"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            }
            Some("result") => return text,
            _ => {}
        }
    }
}

#[tokio::test]
async fn init_message_and_echo_turn() {
    let mut q = Query::spawn(Options {
        model: Some("m1".into()),
        ..base_options()
    })
    .await
    .unwrap();
    let h = q.handle();
    let init = h.initialization_result().await.unwrap();
    assert_eq!(init["account"]["email"], "fake@example.com");
    h.send_user_message(&user("hello")).await.unwrap();
    // First message is the system/init the fake emits on initialize.
    let first = q.next().await.unwrap().unwrap();
    assert_eq!(first["subtype"], "init");
    assert_eq!(first["model"], "m1");
    assert_eq!(run_turn(&mut q).await, "echo:hello");
    h.close().await;
}

struct Policy {
    allow: bool,
}

#[async_trait]
impl CanUseTool for Policy {
    async fn can_use_tool(
        &self,
        tool: &str,
        input: Value,
        ctx: ToolPermissionContext,
    ) -> Option<PermissionResult> {
        assert_eq!(tool, "Bash");
        assert_eq!(ctx.tool_use_id.as_deref(), Some("toolu_1"));
        assert!(ctx.suggestions.is_some());
        Some(if self.allow {
            PermissionResult::allow(input)
        } else {
            PermissionResult::deny("nope")
        })
    }
}

#[tokio::test]
async fn can_use_tool_round_trip_allow_and_deny() {
    for (allow, expect) in [(true, "permission:allow"), (false, "permission:deny")] {
        let argv_file = tempfile::NamedTempFile::new().unwrap();
        let mut opts = base_options();
        opts.can_use_tool = Some(Arc::new(Policy { allow }));
        opts.env = Some(
            std::env::vars()
                .chain([(
                    "FAKE_CLAUDE_ARGV".to_string(),
                    argv_file.path().display().to_string(),
                )])
                .collect(),
        );
        let mut q = Query::spawn(opts).await.unwrap();
        q.handle()
            .send_user_message(&user("tool: ls -la"))
            .await
            .unwrap();
        assert_eq!(run_turn(&mut q).await, expect);
        let argv: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(argv_file.path()).unwrap()).unwrap();
        assert!(argv.contains(&"--permission-prompt-tool=stdio".to_string()));
        q.handle().close().await;
    }
}

#[tokio::test]
async fn sdk_mcp_server_is_served_over_control_channel() {
    let mut opts = base_options();
    let server = ToolServer::new(
        "claudius_goal",
        "1.0.0",
        vec![ToolDef::new(
            "report",
            "Report",
            json!({"type": "object"}),
            |_| async { ToolOutput::text("goal-ok") },
        )],
    );
    opts.mcp_servers.insert(
        "claudius_goal".into(),
        McpServerConfig::Sdk(Arc::new(server)),
    );
    let mut q = Query::spawn(opts).await.unwrap();
    q.handle()
        .send_user_message(&user("mcp: go"))
        .await
        .unwrap();
    assert_eq!(run_turn(&mut q).await, "mcp:goal-ok");
    q.handle().close().await;
}

#[tokio::test]
async fn hook_callbacks_are_registered_and_invoked() {
    let mut opts = base_options();
    opts.hooks.insert(
        "PostToolUse".into(),
        vec![HookMatcher::new(hook_fn(|input, tool_use_id| async move {
            json!({"continue": true, "saw": input["hook_event_name"], "tool": tool_use_id})
        }))],
    );
    let mut q = Query::spawn(opts).await.unwrap();
    q.handle()
        .send_user_message(&user("hook please"))
        .await
        .unwrap();
    let text = run_turn(&mut q).await;
    let v: Value = serde_json::from_str(text.strip_prefix("hook:").unwrap()).unwrap();
    assert_eq!(
        v,
        json!({"continue": true, "saw": "PostToolUse", "tool": "toolu_h"})
    );
    q.handle().close().await;
}

#[tokio::test]
async fn control_requests_resolve() {
    let q = Query::spawn(base_options()).await.unwrap();
    let h = q.handle();
    h.set_permission_mode("plan").await.unwrap();
    assert!(h.interrupt().await.unwrap().is_empty());
    assert_eq!(h.mcp_server_status().await.unwrap(), json!([]));
    assert_eq!(h.supported_commands().await.unwrap()[0]["name"], "clear");
    h.close().await;
}

#[tokio::test]
async fn nonzero_exit_surfaces_with_stderr_tail() {
    let mut q = Query::spawn(base_options()).await.unwrap();
    q.handle().send_user_message(&user("exit:3")).await.unwrap();
    let mut last = None;
    while let Some(m) = tokio::time::timeout(Duration::from_secs(10), q.next())
        .await
        .unwrap()
    {
        last = Some(m);
    }
    match last {
        Some(Err(AgentError::ProcessExited { code, stderr })) => {
            assert_eq!(code, 3);
            assert!(stderr.contains("boom"), "stderr tail: {stderr}");
        }
        other => panic!("expected ProcessExited, got {other:?}"),
    }
}

/// The `stderr` callback gets every decoded chunk, like the SDK's
/// `options.stderr`: invalid bytes become U+FFFD, a code point split across
/// writes arrives whole, and nothing is split into lines or dropped.
#[tokio::test]
async fn stderr_callback_gets_decoded_chunks() {
    let got = Arc::new(std::sync::Mutex::new(String::new()));
    let script = json!({"turns": [{"steps": [
        {"$stderr_bytes": [97, 0xff, 98, 10, 0xc3]},
        {"$delay_ms": 50},
        {"$stderr_bytes": [0xa9, 13, 10, 99]},
        {"$exit": 1},
    ], "result": false}]});
    let mut opts = base_options();
    opts.env
        .get_or_insert_default()
        .insert("FAKE_CLAUDE_SCRIPT".into(), script.to_string());
    let sink = got.clone();
    opts.stderr = Some(Arc::new(move |chunk: &str| {
        sink.lock().unwrap().push_str(chunk)
    }));
    let mut q = Query::spawn(opts).await.unwrap();
    q.handle().send_user_message(&user("go")).await.unwrap();
    let mut last = None;
    while let Some(m) = tokio::time::timeout(Duration::from_secs(10), q.next())
        .await
        .unwrap()
    {
        last = Some(m);
    }
    assert_eq!(*got.lock().unwrap(), "a\u{fffd}b\n\u{e9}\r\nc");
    match last {
        Some(Err(e)) => assert_eq!(
            e.to_string(),
            "Claude Code process exited with code 1. stderr: a\u{fffd}b\n\u{e9}\r\nc"
        ),
        other => panic!("expected the exit error, got {other:?}"),
    }
}

#[tokio::test]
async fn close_terminates_process_and_ends_the_stream_aborted() {
    let mut q = Query::spawn(base_options()).await.unwrap();
    let h = q.handle();
    h.close().await;
    // Writes from then on: the transport's `vZ()`.
    let prompt = json!({"type": "user", "message": {"role": "user", "content": "hi"}, "parent_tool_use_id": null});
    match h.send_user_message(&prompt).await {
        Err(e) => assert_eq!(e.to_string(), "Operation aborted"),
        Ok(()) => panic!("a prompt after close() was written"),
    }
    let exit = tokio::time::timeout(Duration::from_secs(5), h.wait_exit())
        .await
        .unwrap();
    assert_ne!(exit, claudius_agent::ExitInfo::Code(1));
    // Like the SDK after `abort()`, the stream's last item is the abort
    // (cleanup_golden pins the rest).
    let mut last = None;
    while let Some(m) = tokio::time::timeout(Duration::from_secs(5), q.next())
        .await
        .unwrap()
    {
        last = Some(m);
    }
    match last {
        Some(Err(e)) => assert_eq!(e.to_string(), "Operation aborted"),
        other => panic!("expected the abort, got {other:?}"),
    }
}

// ---- scripted fake (`FAKE_CLAUDE_SCRIPT`, `script:` prompts, control log) ----

fn with_env(mut opts: Options, vars: &[(&str, String)]) -> Options {
    opts.env = Some(
        std::env::vars()
            .chain(vars.iter().map(|(k, v)| (k.to_string(), v.clone())))
            .collect(),
    );
    opts
}

/// Every message up to and including the next `result`.
async fn collect_turn(q: &mut Query) -> Vec<Value> {
    let mut out = vec![];
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), q.next())
            .await
            .expect("timed out waiting for CLI")
            .expect("stream ended early")
            .expect("stream error");
        let done = msg["type"] == "result";
        out.push(msg);
        if done {
            return out;
        }
    }
}

#[tokio::test]
async fn script_turns_emit_sequences_with_placeholders() {
    let script = json!({
        "turns": [
            {"match": "compact", "steps": [
                {"type": "system", "subtype": "compact_boundary",
                 "compact_metadata": {"trigger": "manual", "pre_tokens": 1234}},
                {"type": "stream_event", "event": {"type": "content_block_delta",
                 "delta": {"type": "text_delta", "text": "tu"}}, "parent_tool_use_id": null},
                {"type": "system", "subtype": "task_started", "task_id": "$UUID", "turn": "$N",
                 "description": "for $PROMPT in $SESSION_ID"},
                {"$text": "compacted ($MODEL)"}
            ]},
            {"steps": [{"$text": "fallback"}], "result": {"num_turns": 7}}
        ]
    });
    let mut q = Query::spawn(with_env(
        Options {
            model: Some("m-script".into()),
            ..base_options()
        },
        &[("FAKE_CLAUDE_SCRIPT", script.to_string())],
    ))
    .await
    .unwrap();
    let h = q.handle();
    h.send_user_message(&user("please compact")).await.unwrap();
    let msgs = collect_turn(&mut q).await;
    let kinds: Vec<String> = msgs
        .iter()
        .map(|m| {
            format!(
                "{}/{}",
                m["type"].as_str().unwrap(),
                m["subtype"].as_str().unwrap_or("")
            )
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "system/init",
            "system/compact_boundary",
            "stream_event/",
            "system/task_started",
            "assistant/",
            "result/success"
        ]
    );
    let sid = "11111111-1111-4111-8111-111111111111";
    for m in &msgs[1..] {
        assert_eq!(m["session_id"], sid, "session_id filled in: {m}");
        assert!(
            m["uuid"].as_str().is_some_and(|u| u.len() == 36),
            "uuid filled in: {m}"
        );
    }
    let task = &msgs[3];
    assert_eq!(task["turn"], 1);
    assert_eq!(task["description"], format!("for please compact in {sid}"));
    assert_eq!(task["task_id"].as_str().unwrap().len(), 36);
    assert_eq!(
        msgs[4]["message"]["content"][0]["text"],
        "compacted (m-script)"
    );
    // Absent `result` → success carrying the turn's last assistant text.
    assert_eq!(msgs[5]["result"], "compacted (m-script)");

    // The matched turn is consumed; the catch-all runs next, its result object
    // merged over the default.
    h.send_user_message(&user("please compact")).await.unwrap();
    let msgs = collect_turn(&mut q).await;
    assert_eq!(msgs[0]["message"]["content"][0]["text"], "fallback");
    assert_eq!(msgs[1]["result"], "fallback");
    assert_eq!(msgs[1]["num_turns"], 7);
    // Script exhausted → built-in echo.
    h.send_user_message(&user("third")).await.unwrap();
    assert_eq!(run_turn(&mut q).await, "echo:third");
    h.close().await;
}

#[tokio::test]
async fn script_prompt_runs_inline_turns() {
    let mut q = Query::spawn(base_options()).await.unwrap();
    let h = q.handle();
    let _init = q.next().await;
    h.send_user_message(&user(
        r#"<reminder/> script:[{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed"},{"$text":"done"}] trailing prose"#,
    ))
    .await
    .unwrap();
    let msgs = collect_turn(&mut q).await;
    assert_eq!(msgs[0]["subtype"], "task_notification");
    assert_eq!(msgs[0]["task_id"], "t1");
    assert_eq!(msgs[1]["message"]["content"][0]["text"], "done");
    assert_eq!(msgs[2]["result"], "done");
    // Turn object form, explicit string result.
    h.send_user_message(&user(r#"script:{"steps":[],"result":"custom"}"#))
        .await
        .unwrap();
    let msgs = collect_turn(&mut q).await;
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["result"], "custom");
    h.close().await;
}

#[tokio::test]
async fn canned_control_responses_and_control_log() {
    let log = tempfile::NamedTempFile::new().unwrap();
    let q = Query::spawn(with_env(
        base_options(),
        &[("FAKE_CLAUDE_CONTROL_LOG", log.path().display().to_string())],
    ))
    .await
    .unwrap();
    let h = q.handle();
    h.apply_flag_settings(json!({"effortLevel": "high"}))
        .await
        .unwrap();
    h.set_model(Some("m2")).await.unwrap();
    let settings = h.request(json!({"subtype": "get_settings"})).await.unwrap();
    assert_eq!(
        settings["applied"],
        json!({"model": "m2", "effort": "high"})
    );
    assert_eq!(settings["effective"]["effortLevel"], "high");

    let set = |servers: Value| h.request(json!({"subtype": "mcp_set_servers", "servers": servers}));
    assert_eq!(
        set(json!({"a": {}, "b": {}})).await.unwrap(),
        json!({"added": ["a", "b"], "removed": [], "errors": {}})
    );
    assert_eq!(
        set(json!({"b": {}, "c": {}})).await.unwrap(),
        json!({"added": ["c"], "removed": ["a"], "errors": {}})
    );
    let bg = h
        .request(json!({"subtype": "background_tasks", "tool_use_id": "toolu_1"}))
        .await
        .unwrap();
    assert_eq!(bg["backgrounded"], true);
    let plugins = h
        .request(json!({"subtype": "reload_plugins"}))
        .await
        .unwrap();
    assert_eq!(plugins["error_count"], 0);
    assert_eq!(plugins["commands"][0]["name"], "clear");
    let usage = h.request(json!({"subtype": "get_usage"})).await.unwrap();
    assert_eq!(usage["session"]["total_cost_usd"], 0.0);
    assert_eq!(usage["rate_limits_available"], false);
    for ack in [
        json!({"subtype": "seed_read_state", "path": "/tmp/x", "mtime": 1}),
        json!({"subtype": "update_settings", "source": "localSettings", "settings": {"outputStyle": "x"}}),
        json!({"subtype": "submit_feedback", "description": "hi", "surface": "claudius"}),
    ] {
        assert_eq!(h.request(ack).await.unwrap(), json!({}));
    }
    h.close().await;

    let logged: Vec<Value> = std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let subtypes: Vec<&str> = logged
        .iter()
        .map(|m| m["request"]["subtype"].as_str().unwrap())
        .collect();
    assert_eq!(
        subtypes,
        [
            "initialize",
            "apply_flag_settings",
            "set_model",
            "get_settings",
            "mcp_set_servers",
            "mcp_set_servers",
            "background_tasks",
            "reload_plugins",
            "get_usage",
            "seed_read_state",
            "update_settings",
            "submit_feedback"
        ]
    );
    assert!(
        logged
            .iter()
            .all(|m| m["type"] == "control_request" && m["request_id"].is_string())
    );
    assert_eq!(logged[10]["request"]["settings"]["outputStyle"], "x");
}

#[tokio::test]
async fn scripted_control_overrides_errors_and_emits() {
    let script = json!({
        "control": {
            "get_settings": {"applied": {"effort": "low"}, "model": "$MODEL"},
            "submit_feedback": {"$error": "feedback disabled"},
            "interrupt": {"$response": {"still_queued": []},
                          "$emit": [{"type": "result", "subtype": "error_during_execution", "is_error": true}]}
        },
        "turns": [{"match": "long", "steps": [{"$text": "working"}], "result": false}]
    });
    let mut q = Query::spawn(with_env(
        base_options(),
        &[("FAKE_CLAUDE_SCRIPT", script.to_string())],
    ))
    .await
    .unwrap();
    let h = q.handle();
    let s = h.request(json!({"subtype": "get_settings"})).await.unwrap();
    assert_eq!(
        s,
        json!({"applied": {"effort": "low"}, "model": "fake-model"})
    );
    match h
        .request(json!({"subtype": "submit_feedback", "description": "x"}))
        .await
    {
        Err(AgentError::ControlError(e)) => assert_eq!(e, "feedback disabled"),
        other => panic!("expected ControlError, got {other:?}"),
    }
    // `result: false` leaves the turn open until the interrupt's `$emit`.
    h.send_user_message(&user("a long task")).await.unwrap();
    let _init = q.next().await;
    let working = q.next().await.unwrap().unwrap();
    assert_eq!(working["message"]["content"][0]["text"], "working");
    assert!(h.interrupt().await.unwrap().is_empty());
    let end = tokio::time::timeout(Duration::from_secs(10), q.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(end["type"], "result");
    assert_eq!(end["subtype"], "error_during_execution");
    h.close().await;
}

struct WritePolicy;

#[async_trait]
impl CanUseTool for WritePolicy {
    async fn can_use_tool(
        &self,
        tool: &str,
        input: Value,
        ctx: ToolPermissionContext,
    ) -> Option<PermissionResult> {
        assert_eq!(tool, "Write");
        assert_eq!(ctx.tool_use_id.as_deref(), Some("toolu_w"));
        Some(PermissionResult::allow(input))
    }
}

#[tokio::test]
async fn script_file_init_overrides_on_init_and_control_steps() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("script.json");
    std::fs::write(
        &path,
        json!({
            "init": {"model": "scripted", "tools": ["Bash", "Read", "Write"]},
            "initialize": {"agents": [{"name": "reviewer", "description": "Reviews"}]},
            "on_init": [{"type": "system", "subtype": "status", "status": "compacting"}],
            "turns": [{"repeat": true, "match": "write", "steps": [
                {"type": "assistant", "message": {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "toolu_w", "name": "Write", "input": {"file_path": "/x"}}]},
                 "parent_tool_use_id": null},
                {"$control": {"subtype": "can_use_tool", "tool_name": "Write",
                              "input": {"file_path": "/x"}, "tool_use_id": "toolu_w"}},
                {"$text": "$LAST:/behavior"}
            ]}]
        })
        .to_string(),
    )
    .unwrap();
    let mut opts = with_env(
        base_options(),
        &[("FAKE_CLAUDE_SCRIPT", path.display().to_string())],
    );
    opts.can_use_tool = Some(Arc::new(WritePolicy));
    let mut q = Query::spawn(opts).await.unwrap();
    let h = q.handle();
    assert_eq!(h.supported_agents().await.unwrap()[0]["name"], "reviewer");
    let init = q.next().await.unwrap().unwrap();
    assert_eq!(init["model"], "scripted");
    assert_eq!(init["tools"][2], "Write");
    let status = q.next().await.unwrap().unwrap();
    assert_eq!(status["status"], "compacting");
    for _ in 0..2 {
        h.send_user_message(&user("write it")).await.unwrap();
        let msgs = collect_turn(&mut q).await;
        assert_eq!(msgs[0]["message"]["content"][0]["type"], "tool_use");
        assert_eq!(msgs.last().unwrap()["result"], "allow");
    }
    h.close().await;
}

#[tokio::test]
async fn bad_script_fails_fast_with_stderr() {
    let mut q = Query::spawn(with_env(
        base_options(),
        &[("FAKE_CLAUDE_SCRIPT", "{not json".into())],
    ))
    .await
    .unwrap();
    let mut last = None;
    while let Some(m) = tokio::time::timeout(Duration::from_secs(10), q.next())
        .await
        .unwrap()
    {
        last = Some(m);
    }
    match last {
        Some(Err(AgentError::ProcessExited { code, stderr })) => {
            assert_eq!(code, 2);
            assert!(stderr.contains("bad JSON"), "{stderr}");
        }
        other => panic!("expected ProcessExited, got {other:?}"),
    }
}

/// A01: the typed `Query` methods `lib/server` uses send exactly the SDK
/// 0.3.312 request bodies (`sdk.mjs`) and unwrap the replies the same way.
#[tokio::test]
async fn typed_query_methods_send_sdk_request_shapes() {
    let log = tempfile::NamedTempFile::new().unwrap();
    let q = Query::spawn(with_env(
        base_options(),
        &[("FAKE_CLAUDE_CONTROL_LOG", log.path().display().to_string())],
    ))
    .await
    .unwrap();
    let h = q.handle();

    h.seed_read_state("/repo/a.rs", 1_792_970_818_569)
        .await
        .unwrap();
    h.update_settings("localSettings", json!({"outputStyle": "Explanatory"}))
        .await
        .unwrap();
    h.apply_flag_settings(json!({"effortLevel": "high"}))
        .await
        .unwrap();
    let settings = h.get_settings().await.unwrap();
    assert_eq!(settings["applied"]["effort"], "high");
    let fb = FeedbackOptions {
        surface: Some("claudius".into()),
        attach_transcript: Some(false),
        ..Default::default()
    };
    assert_eq!(h.submit_feedback("it broke", &fb).await.unwrap(), json!({}));
    let mut servers = IndexMap::new();
    servers.insert(
        "ext".to_string(),
        McpServerConfig::External(json!({"type": "stdio", "command": "echo"})),
    );
    assert_eq!(
        h.set_mcp_servers(servers).await.unwrap(),
        json!({"added": ["ext"], "removed": [], "errors": {}})
    );
    let plugins = h.reload_plugins(true).await.unwrap();
    assert_eq!(plugins["error_count"], 0);
    h.reload_plugins(false).await.unwrap();
    assert!(h.background_tasks(Some("toolu_1")).await.unwrap());
    assert!(h.background_tasks(None).await.unwrap());
    let usage = h.get_usage(true).await.unwrap();
    assert_eq!(usage["rate_limits_available"], false);
    h.get_usage(false).await.unwrap();
    h.close().await;

    let bodies: Vec<Value> = std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["request"].clone())
        .filter(|r| r["subtype"] != "initialize")
        .collect();
    assert_eq!(
        bodies,
        vec![
            json!({"subtype": "seed_read_state", "path": "/repo/a.rs", "mtime": 1_792_970_818_569_i64}),
            json!({"subtype": "update_settings", "source": "localSettings", "settings": {"outputStyle": "Explanatory"}}),
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": "high"}}),
            json!({"subtype": "get_settings"}),
            // Unset options are dropped, like JSON.stringify on `undefined`.
            json!({"subtype": "submit_feedback", "description": "it broke", "surface": "claudius", "attach_transcript": false}),
            json!({"subtype": "mcp_set_servers", "servers": {"ext": {"type": "stdio", "command": "echo"}}}),
            // `…holdOnCacheImpact && {hold_on_cache_impact: true}`.
            json!({"subtype": "reload_plugins", "hold_on_cache_impact": true}),
            json!({"subtype": "reload_plugins"}),
            json!({"subtype": "background_tasks", "tool_use_id": "toolu_1"}),
            // `tool_use_id: undefined` is omitted.
            json!({"subtype": "background_tasks"}),
            json!({"subtype": "get_usage", "skip_behaviors": true}),
            json!({"subtype": "get_usage"}),
        ]
    );
    // Byte order matters too: serde keeps insertion order like JS objects.
    let raw = std::fs::read_to_string(log.path()).unwrap();
    assert!(raw.contains(r#""subtype":"submit_feedback","description":"it broke","surface":"claudius","attach_transcript":false"#), "{raw}");
}

/// `setMcpServers` reconciles in-process servers like the SDK: ones missing
/// from the new set are disconnected (even spawn-time ones), new ones are
/// connected and routable, and the request lists external configs first,
/// then `{type: "sdk", name}` entries.
#[tokio::test]
async fn set_mcp_servers_reconciles_in_process_servers() {
    let log = tempfile::NamedTempFile::new().unwrap();
    let tool_server = |name: &str, tool: &'static str| {
        Arc::new(ToolServer::new(
            name,
            "1.0.0",
            vec![ToolDef::new(
                tool,
                "t",
                json!({"type": "object"}),
                |_| async { ToolOutput::text("ok") },
            )],
        ))
    };
    let mut opts = with_env(
        base_options(),
        &[("FAKE_CLAUDE_CONTROL_LOG", log.path().display().to_string())],
    );
    opts.mcp_servers.insert(
        "claudius_goal".into(),
        McpServerConfig::Sdk(tool_server("claudius_goal", "report_goal")),
    );
    let mut q = Query::spawn(opts).await.unwrap();
    let h = q.handle();
    assert_eq!(h.sdk_mcp_server_names(), ["claudius_goal"]);

    // The CLI asks a named in-process server for its first tool.
    let first_tool = |server: &str| {
        user(&format!(
            "script:{}",
            json!([
                {"$control": {"subtype": "mcp_message", "server_name": server,
                              "message": {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}}},
                {"$text": "$LAST:/mcp_response/result/tools/0/name"}
            ])
        ))
    };
    let mut ask = async |server: &str| {
        h.send_user_message(&first_tool(server)).await.unwrap();
        collect_turn(&mut q).await.last().unwrap()["result"].clone()
    };
    assert_eq!(ask("claudius_goal").await, "report_goal");

    let mut servers = IndexMap::new();
    servers.insert(
        "aux".to_string(),
        McpServerConfig::Sdk(tool_server("aux", "aux_tool")),
    );
    servers.insert(
        "ext".to_string(),
        McpServerConfig::External(json!({"type": "http", "url": "http://127.0.0.1:9/mcp"})),
    );
    h.set_mcp_servers(servers).await.unwrap();
    assert_eq!(
        h.sdk_mcp_server_names(),
        ["aux"],
        "claudius_goal disconnected"
    );
    assert_eq!(ask("aux").await, "aux_tool");
    assert_ne!(
        ask("claudius_goal").await,
        "report_goal",
        "a removed server must not answer"
    );

    // Same name again with a different instance: the connected one is kept.
    let mut again = IndexMap::new();
    again.insert(
        "aux".to_string(),
        McpServerConfig::Sdk(tool_server("aux", "other_tool")),
    );
    h.set_mcp_servers(again).await.unwrap();
    assert_eq!(ask("aux").await, "aux_tool");
    h.close().await;

    let sets: Vec<Value> = std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["request"].clone())
        .filter(|r| r["subtype"] == "mcp_set_servers")
        .collect();
    assert_eq!(
        sets[0]["servers"],
        json!({"ext": {"type": "http", "url": "http://127.0.0.1:9/mcp"}, "aux": {"type": "sdk", "name": "aux"}})
    );
    let keys: Vec<&String> = sets[0]["servers"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["ext", "aux"], "external first, then sdk");
    assert_eq!(
        sets[1]["servers"],
        json!({"aux": {"type": "sdk", "name": "aux"}})
    );
}

/// `initialize` carries in-process server settings and the pre-captured
/// manifests right after `sdkMcpServers`, like SDK 0.3.312; a server's
/// settings also ride along in its `mcp_set_servers` entry.
#[tokio::test]
async fn initialize_carries_sdk_server_configs_and_manifests() {
    let log = tempfile::NamedTempFile::new().unwrap();
    let goal = ToolServer::new(
        "claudius_goal",
        "1.0.0",
        vec![ToolDef::new(
            "report_goal_achieved",
            "Report",
            json!({"type": "object"}),
            |_| async { ToolOutput::text("ok") },
        )],
    )
    .with_timeout(10_000);
    let mut opts = with_env(
        base_options(),
        &[("FAKE_CLAUDE_CONTROL_LOG", log.path().display().to_string())],
    );
    opts.mcp_servers
        .insert("claudius_goal".into(), McpServerConfig::Sdk(Arc::new(goal)));
    // No tools: no settings entry and no manifest (its tools/list errors).
    opts.mcp_servers.insert(
        "aux".into(),
        McpServerConfig::Sdk(Arc::new(ToolServer::new("aux", "0.1.0", vec![]))),
    );
    // A hand-written server: its `settings()` count, and an initialize
    // error means no manifest.
    struct Custom;
    #[async_trait]
    impl SdkMcpServer for Custom {
        async fn handle(&self, m: Value) -> Option<Value> {
            let id = m.get("id")?.clone();
            Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32603, "message": "no"}}))
        }
        fn settings(&self) -> SdkServerSettings {
            SdkServerSettings {
                timeout: None,
                disable_auto_background: true,
            }
        }
    }
    opts.mcp_servers
        .insert("custom".into(), McpServerConfig::Sdk(Arc::new(Custom)));
    let q = Query::spawn(opts).await.unwrap();
    let h = q.handle();
    let mut servers = IndexMap::new();
    servers.insert(
        "bg".to_string(),
        McpServerConfig::Sdk(Arc::new(
            ToolServer::new("bg", "1.0.0", vec![])
                .with_timeout(5_000)
                .with_disable_auto_background(true),
        )),
    );
    h.set_mcp_servers(servers).await.unwrap();
    h.close().await;

    let logged: Vec<Value> = std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["request"].clone())
        .collect();
    let init = &logged[0];
    assert_eq!(init["subtype"], "initialize");
    let keys: Vec<&str> = init
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let at = keys.iter().position(|k| *k == "sdkMcpServers").unwrap();
    assert_eq!(
        keys[at..at + 3],
        [
            "sdkMcpServers",
            "sdkMcpServerConfigs",
            "sdkMcpServerManifests"
        ]
    );
    assert_eq!(
        init["sdkMcpServers"],
        json!(["claudius_goal", "aux", "custom"])
    );
    assert_eq!(
        init["sdkMcpServerConfigs"],
        json!({"claudius_goal": {"timeout": 10000}, "custom": {"disableAutoBackground": true}})
    );
    let manifests = init["sdkMcpServerManifests"].as_object().unwrap();
    assert_eq!(manifests.keys().collect::<Vec<_>>(), ["claudius_goal"]);
    assert_eq!(
        manifests["claudius_goal"]["initializeResult"]["protocolVersion"],
        "2025-11-25"
    );
    assert_eq!(
        manifests["claudius_goal"]["toolsListResult"]["tools"][0],
        json!({"name": "report_goal_achieved", "description": "Report",
               "inputSchema": {"type": "object"}, "execution": {"taskSupport": "forbidden"}})
    );

    let set = logged
        .iter()
        .find(|r| r["subtype"] == "mcp_set_servers")
        .unwrap();
    assert_eq!(
        serde_json::to_string(&set["servers"]).unwrap(),
        r#"{"bg":{"type":"sdk","name":"bg","timeout":5000,"disableAutoBackground":true}}"#
    );
}

/// A descriptor the host process holds without close-on-exec (as one
/// mid-`pipe()` on another thread is, on macOS) must not reach the CLI:
/// a CLI holding another CLI's stdin keeps it from ever seeing EOF.
#[cfg(unix)]
#[tokio::test]
async fn cli_does_not_inherit_leaked_descriptors() {
    let mut fds = [0; 2];
    // SAFETY: `pipe` fills the two-element array; plain `pipe` leaves both
    // ends inheritable.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let report = tempfile::NamedTempFile::new().unwrap();
    let mut opts = base_options();
    opts.env = Some(
        std::env::vars()
            .chain([(
                "FAKE_CLAUDE_FDS".to_string(),
                report.path().display().to_string(),
            )])
            .collect(),
    );
    let q = Query::spawn(opts).await.unwrap();
    q.handle().initialization_result().await.unwrap();
    let inherited: Vec<i32> =
        serde_json::from_str(&std::fs::read_to_string(report.path()).unwrap()).unwrap();
    q.handle().close().await;
    // SAFETY: closing the pipe this test opened.
    unsafe {
        libc::close(fds[0]);
        libc::close(fds[1]);
    }
    assert!(
        !inherited.contains(&fds[0]) && !inherited.contains(&fds[1]),
        "the CLI inherited {fds:?} (it has {inherited:?})"
    );
}

/// A missing executable still fails `spawn` itself (the descriptor cleanup
/// runs before exec but keeps `std`'s close-on-exec error pipe).
#[tokio::test]
async fn missing_executable_fails_spawn() {
    let opts = Options {
        path_to_claude_code_executable: Some("/nonexistent/claudius-test/claude".into()),
        ..Default::default()
    };
    match Query::spawn(opts).await {
        Err(AgentError::Spawn { path, source, .. }) => {
            assert_eq!(path, "/nonexistent/claudius-test/claude");
            assert_eq!(source.kind(), std::io::ErrorKind::NotFound);
        }
        Err(e) => panic!("wrong error: {e}"),
        Ok(_) => panic!("spawned a missing executable"),
    }
}

/// `control.<subtype>.$sequence`: the n-th request gets the n-th entry (a
/// literal or a directive), the last one repeats; an empty sequence leaves
/// the canned reply, and other subtypes are untouched.
#[tokio::test]
async fn control_sequences_answer_in_turn() {
    let script = json!({"control": {
        "mcp_status": {"$sequence": [
            {"mcpServers": [{"name": "a", "status": "failed"}]},
            {"$error": "second"},
            {"$response": {"mcpServers": ["third"]}},
            {"mcpServers": ["last"]},
        ]},
        "get_settings": {"$sequence": []},
    }});
    let q = Query::spawn(with_env(
        base_options(),
        &[("FAKE_CLAUDE_SCRIPT", script.to_string())],
    ))
    .await
    .unwrap();
    let h = q.handle();
    assert_eq!(
        h.mcp_server_status().await.unwrap(),
        json!([{"name": "a", "status": "failed"}])
    );
    assert_eq!(
        h.mcp_server_status().await.unwrap_err().to_string(),
        "second"
    );
    assert_eq!(h.mcp_server_status().await.unwrap(), json!(["third"]));
    for _ in 0..2 {
        assert_eq!(h.mcp_server_status().await.unwrap(), json!(["last"]));
    }
    assert_eq!(
        h.get_settings().await.unwrap()["applied"]["model"],
        json!("fake-model")
    );
    assert_eq!(h.interrupt().await.unwrap(), Vec::<String>::new());
    h.close().await;
}

// ---- lone surrogates (I17) ----

/// The stdout lines of a fake driven over raw stdin, on a thread, so a line
/// that never comes fails the test instead of hanging it.
fn stdout_lines(child: &mut std::process::Child) -> std::sync::mpsc::Receiver<String> {
    use std::io::BufRead;
    let out = std::io::BufReader::new(child.stdout.take().unwrap());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in out.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

fn next_line(rx: &std::sync::mpsc::Receiver<String>) -> Value {
    let line = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the fake never answered");
    serde_json::from_str(&line).unwrap()
}

/// The SDK writes a lone surrogate as its escape (`JSON.stringify`), which
/// serde_json refuses. The fake reads such a line as the CLI's `JSON.parse`
/// does, with U+FFFD in its place, and answers it instead of leaving the
/// host waiting.
#[test]
fn a_lone_surrogate_control_request_gets_its_reply() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let control_log = dir.path().join("control.log");
    let mut child = std::process::Command::new(fake_bin())
        .current_dir(dir.path())
        .env("FAKE_CLAUDE_CONTROL_LOG", &control_log)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let rx = stdout_lines(&mut child);
    let request = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"submit_feedback","description":"[+1] a\ud800b","surface":"\udc00\ud83d","attach_transcript":false}}"#;
    writeln!(stdin, "{request}").unwrap();
    assert_eq!(
        next_line(&rx),
        json!({"type": "control_response",
               "response": {"subtype": "success", "request_id": "r1", "response": {}}})
    );
    // A prompt too: echoed, with U+FFFD for the lone surrogate.
    writeln!(
        stdin,
        r#"{{"type":"user","message":{{"role":"user","content":"hi \ud800"}}}}"#
    )
    .unwrap();
    let assistant = next_line(&rx);
    assert_eq!(
        assistant["message"]["content"][0]["text"],
        "echo:hi \u{fffd}"
    );
    assert_eq!(next_line(&rx)["result"], "echo:hi \u{fffd}");
    drop(stdin);
    assert!(child.wait().unwrap().success());
    assert_eq!(
        std::fs::read_to_string(&control_log).unwrap(),
        "{\"type\":\"control_request\",\"request_id\":\"r1\",\"request\":{\"subtype\":\"submit_feedback\",\
         \"description\":\"[+1] a\u{fffd}b\",\"surface\":\"\u{fffd}\u{fffd}\",\"attach_transcript\":false}}\n"
    );
}

/// The host reads such a line from the CLI too, as the SDK's `JSON.parse`
/// does (U+FFFD where the SDK keeps the lone surrogate), so the turn's
/// messages and its `result` arrive instead of the turn never ending.
#[tokio::test]
async fn the_host_reads_lone_surrogate_lines() {
    let raw = |line: &str| json!({"$stdout_bytes": format!("{line}\n").into_bytes()});
    let script = json!({"turns": [{"steps": [
        raw(r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a\ud800b\udfff"}]},"parent_tool_use_id":null}"#),
        raw(r#"{"type":"result","subtype":"success","is_error":false,"result":"\udc00","num_turns":1,"total_cost_usd":1e400}"#),
    ], "result": false}]});
    let mut q = Query::spawn(with_env(
        base_options(),
        &[("FAKE_CLAUDE_SCRIPT", script.to_string())],
    ))
    .await
    .unwrap();
    let h = q.handle();
    h.send_user_message(&user("go")).await.unwrap();
    let msgs = collect_turn(&mut q).await;
    let n = msgs.len();
    assert_eq!(
        msgs[n - 2]["message"]["content"][0]["text"],
        "a\u{fffd}b\u{fffd}"
    );
    assert_eq!(msgs[n - 1]["result"], "\u{fffd}");
    assert_eq!(msgs[n - 1]["total_cost_usd"], Value::Null);
    h.close().await;
}

// ---- shared logs (I22) ----

/// `path`'s lines: each of `want`'s sequences whole and in order,
/// interleaved, plus each of `also`'s lines its number of times (lines any
/// writer may write, e.g. every fake's `eof`).
fn assert_interleaved(
    name: &str,
    path: &std::path::Path,
    want: &[Vec<String>],
    also: &[(&str, usize)],
) {
    use std::collections::HashSet;
    let text = std::fs::read_to_string(path).unwrap();
    let got: Vec<&str> = text.lines().collect();
    let total = want.iter().map(Vec::len).sum::<usize>() + also.iter().map(|a| a.1).sum::<usize>();
    let all: HashSet<&str> = want
        .iter()
        .flatten()
        .map(String::as_str)
        .chain(also.iter().map(|a| a.0))
        .collect();
    let stray: Vec<&str> = got
        .iter()
        .copied()
        .filter(|l| !all.contains(l))
        .take(3)
        .collect();
    assert!(
        stray.is_empty(),
        "{name}: lines no fake wrote, e.g. {stray:?}"
    );
    assert_eq!(got.len(), total, "{name}: line count");
    for (line, n) in also {
        assert_eq!(
            got.iter().filter(|l| *l == line).count(),
            *n,
            "{name}: {line}"
        );
    }
    for (k, w) in want.iter().enumerate() {
        let mine: HashSet<&str> = w.iter().map(String::as_str).collect();
        let sub: Vec<&str> = got.iter().copied().filter(|l| mine.contains(l)).collect();
        assert!(sub == *w, "{name}: fake {k}'s lines out of order");
    }
}

/// Every fake CLI a server spawns appends to the same `$FAKE_CLAUDE_LOG`
/// (and `$FAKE_CLAUDE_CONTROL_LOG`, `$FAKE_CLAUDE_EVENTS`, where the stdin
/// thread's `eof` also races the main thread's marks). Each line goes out in
/// one write, so however the writers interleave every line stays whole.
/// Written as the text and then its newline, another fake's line got in
/// between: `memory`'s probe lost its user message to an unparsable
/// `{…get_usage…}{"type":"user",…}` line (I22).
#[test]
fn fakes_sharing_their_logs_never_merge_lines() {
    const FAKES: usize = 8;
    const LINES: usize = 2000;
    const MARKS: usize = 2000;
    let dir = tempfile::tempdir().unwrap();
    let path = |name: &str| dir.path().join(name);
    let (mut stdin, mut control, mut marks) = (vec![], vec![], vec![]);
    let children: Vec<_> = (0..FAKES)
        .map(|k| {
            let cancels: Vec<String> = (0..LINES)
                .map(|i| {
                    json!({"type": "control_cancel_request", "request_id": format!("{k}-{i}")})
                        .to_string()
                })
                .collect();
            let steps: Vec<Value> = (0..MARKS)
                .map(|i| json!({"$mark": format!("{k}-{i}")}))
                .collect();
            // The marks first, so the stdin thread's `eof` races them.
            let mut lines = vec![user(&format!("script:{}", Value::Array(steps))).to_string()];
            lines.extend(cancels.iter().cloned());
            let input = path(&format!("stdin-{k}"));
            std::fs::write(
                &input,
                lines.iter().map(|l| format!("{l}\n")).collect::<String>(),
            )
            .unwrap();
            stdin.push(lines);
            control.push(cancels);
            marks.push(
                (0..MARKS)
                    .map(|i| json!({"mark": format!("{k}-{i}")}).to_string())
                    .collect(),
            );
            std::process::Command::new(fake_bin())
                .current_dir(dir.path())
                .env("FAKE_CLAUDE_LOG", path("stdin.log"))
                .env("FAKE_CLAUDE_CONTROL_LOG", path("control.log"))
                .env("FAKE_CLAUDE_EVENTS", path("events.log"))
                .stdin(std::fs::File::open(input).unwrap())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap()
        })
        .collect();
    for mut c in children {
        assert!(c.wait().unwrap().success());
    }
    assert_interleaved("stdin", &path("stdin.log"), &stdin, &[]);
    assert_interleaved("control", &path("control.log"), &control, &[]);
    assert_interleaved(
        "events",
        &path("events.log"),
        &marks,
        &[(r#"{"eof":true}"#, FAKES)],
    );
}
