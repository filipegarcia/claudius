//! `CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS` turns the pre-`initialize`
//! manifest capture off. The SDK reads it from the *parent* process env, so
//! this test sets it on the test process; it lives in its own test binary so
//! no other test sees the variable.

use std::path::PathBuf;
use std::sync::Arc;

use claudius_agent::{McpServerConfig, Options, Query, ToolDef, ToolOutput, ToolServer};
use serde_json::{Value, json};

#[tokio::test]
async fn disable_env_var_skips_manifest_capture() {
    // SAFETY: the only test in this binary, set before any thread reads env.
    unsafe { std::env::set_var("CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS", "yes") };
    let log = tempfile::NamedTempFile::new().unwrap();
    let mut opts = Options {
        path_to_claude_code_executable: Some(PathBuf::from(env!(
            "CARGO_BIN_EXE_claudius-fake-claude"
        ))),
        ..Default::default()
    };
    opts.env = Some(
        std::env::vars()
            .chain([(
                "FAKE_CLAUDE_CONTROL_LOG".to_string(),
                log.path().display().to_string(),
            )])
            .collect(),
    );
    opts.mcp_servers.insert(
        "claudius_goal".into(),
        McpServerConfig::Sdk(Arc::new(
            ToolServer::new(
                "claudius_goal",
                "1.0.0",
                vec![ToolDef::new(
                    "report",
                    "Report",
                    json!({"type": "object"}),
                    |_| async { ToolOutput::text("ok") },
                )],
            )
            .with_timeout(10_000),
        )),
    );
    let q = Query::spawn(opts).await.unwrap();
    // One awaited round trip so the CLI has logged `initialize` before close.
    q.handle()
        .request(json!({"subtype": "get_settings"}))
        .await
        .unwrap();
    q.handle().close().await;

    let first = std::fs::read_to_string(log.path()).unwrap();
    let init: Value = serde_json::from_str(first.lines().next().unwrap()).unwrap();
    let init = &init["request"];
    assert_eq!(init["subtype"], "initialize");
    assert!(init.get("sdkMcpServerManifests").is_none(), "{init}");
    // Settings don't depend on the capture.
    assert_eq!(
        init["sdkMcpServerConfigs"],
        json!({"claudius_goal": {"timeout": 10000}})
    );
}
