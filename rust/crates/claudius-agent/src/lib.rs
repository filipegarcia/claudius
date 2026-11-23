//! `claudius-agent` — drive the Claude Code CLI from Rust.
//!
//! There is no official Rust Agent SDK. The TS SDK
//! (`@anthropic-ai/claude-agent-sdk`) is itself a thin host around the native
//! `claude` binary speaking newline-delimited JSON over stdio
//! (`--input-format stream-json --output-format stream-json`), plus a
//! bidirectional control channel. This crate reimplements that host side.
//!
//! ```no_run
//! # async fn demo() -> Result<(), claudius_agent::AgentError> {
//! use claudius_agent::{Options, Query};
//! use serde_json::json;
//!
//! let mut q = Query::spawn(Options { model: Some("haiku".into()), ..Default::default() }).await?;
//! q.handle()
//!     .send_user_message(&json!({
//!         "type": "user",
//!         "message": {"role": "user", "content": "hello"},
//!         "parent_tool_use_id": null,
//!         "session_id": "",
//!     }))
//!     .await?;
//! while let Some(msg) = q.next().await {
//!     let msg = msg?;
//!     if msg["type"] == "result" { break; }
//! }
//! # Ok(()) }
//! ```

/// The `@anthropic-ai/claude-agent-sdk` version whose behaviour this crate
/// mirrors. `rust/scripts/sdk-diff.sh` fails when the installed SDK, the
/// version baked into its bundle, or `rust/scripts/sdk-snapshot.json`
/// disagrees with it.
pub const SDK_VERSION: &str = "0.3.312";

pub mod binary;
pub mod error;
pub mod hooks;
pub mod js;
pub mod mcp;
pub mod options;
pub mod permission;
pub mod query;
pub mod redact;
pub mod sandbox;
mod stream;

pub use error::{AgentError, signal_name};
pub use hooks::{HookCallback, HookMatcher, hook_fn};
pub use mcp::{SdkMcpServer, SdkServerSettings, ToolDef, ToolOutput, ToolServer};
pub use options::{McpServerConfig, Options, SystemPrompt, ThinkingConfig, Tools};
pub use permission::{
    CanUseTool, ComputerFolder, ElicitationRequest, OnElicitation, PermissionResult,
    ToolPermissionContext,
};
#[cfg(unix)]
pub use query::close_leaked_fds;
pub use query::{
    ExitInfo, FeedbackOptions, Query, QueryHandle, QueryId, begin_exit, oneshot, prepare_fork,
    run_end_ceiling_ms,
};
pub use stream::Utf8Decoder;
