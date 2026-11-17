//! In-process ("sdk" type) MCP servers.
//!
//! The CLI reaches these through `mcp_message` control requests carrying a
//! raw JSON-RPC message; requests get `{ mcp_response: <json-rpc response> }`
//! back, notifications get a dummy ack (mirrors `processControlRequest`).
//!
//! [`ToolServer`] is the equivalent of the TS `createSdkMcpServer({ tools })`
//! and `tool()` helpers: enough MCP to serve `tools/list` and `tools/call`,
//! answering byte-for-byte like the SDK's `McpServer`.
//!
//! [`capture_manifests`] is the SDK's `captureSdkMcpServerManifests()`: the
//! pre-`initialize` handshake whose results go out as
//! `sdkMcpServerManifests`, so the CLI can skip its own handshake.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::options::MIRRORED_SDK_VERSION;

/// MCP protocol version the TS SDK's client requests (`LZ`), and the latest
/// one its bundled MCP server speaks (`$A`).
pub const MCP_PROTOCOL_VERSION: &str = "2025-11-25";

/// Versions the bundled MCP server accepts in `initialize` (`m0`); any
/// other request gets [`MCP_PROTOCOL_VERSION`] back.
pub const SUPPORTED_MCP_PROTOCOL_VERSIONS: &[&str] = &[
    MCP_PROTOCOL_VERSION,
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// How long the manifest capture waits for all servers (`NZ`). Servers that
/// haven't finished get no manifest and handshake over the control channel.
pub const MANIFEST_CAPTURE_DEADLINE: Duration = Duration::from_millis(250);

/// JSON-RPC id prefix of the capture handshake (`k_`).
const CAPTURE_ID_PREFIX: &str = "sdk-manifest-capture:";

/// Per-server settings the SDK forwards to the CLI: the `timeout` and
/// `disableAutoBackground` fields of a `createSdkMcpServer` config, validated
/// like the SDK's `Tw()` (0.3.312 `dw()`). They go out in
/// `initialize.sdkMcpServerConfigs` and in the server's `mcp_set_servers`
/// entry. SDK 0.3.312 also forwards a config's per-tool permission policy
/// (`tools: [{name, permission_policy}]`) and `connectorId`; neither is
/// modelled, because `createSdkMcpServer` never sets them and Claudius's one
/// in-process server (`claudius_goal`) doesn't add them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SdkServerSettings {
    /// Per-tool-call timeout in ms. `Some(0)` is dropped like the SDK's `sh()`
    /// (positive integers only).
    pub timeout: Option<u64>,
    /// Sent only when `true`.
    pub disable_auto_background: bool,
}

impl SdkServerSettings {
    /// `{timeout?, disableAutoBackground?}` in the SDK's key order.
    pub fn to_json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        if let Some(t) = self.timeout.filter(|t| *t > 0) {
            m.insert("timeout".into(), json!(t));
        }
        if self.disable_auto_background {
            m.insert("disableAutoBackground".into(), json!(true));
        }
        m
    }
}

#[async_trait]
pub trait SdkMcpServer: Send + Sync {
    /// Handle one JSON-RPC message. Return `Some(response)` for requests
    /// (messages with `id` + `method`), `None` for notifications.
    async fn handle(&self, message: Value) -> Option<Value>;

    /// Settings forwarded to the CLI (see [`SdkServerSettings`]).
    fn settings(&self) -> SdkServerSettings {
        SdkServerSettings::default()
    }
}

/// The `clientInfo` the SDK presents in the capture handshake (`IZ` plus
/// the SDK version).
fn capture_client_info() -> Value {
    json!({
        "name": "claude-code",
        "title": "Claude Code",
        "description": "Anthropic's agentic coding tool",
        "websiteUrl": "https://claude.com/claude-code",
        "version": MIRRORED_SDK_VERSION,
    })
}

/// One server's manifest: `initialize` → `notifications/initialized` →
/// `tools/list` (only with a `tools` capability). `None` when the server
/// answers either request with an error; the CLI then handshakes it itself.
async fn capture_one(server: &dyn SdkMcpServer) -> Option<Value> {
    let init = server
        .handle(json!({
            "jsonrpc": "2.0",
            "id": format!("{CAPTURE_ID_PREFIX}initialize"),
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": capture_client_info(),
            },
        }))
        .await?;
    let result = init.get("result")?.clone();
    let _ = server
        .handle(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        .await;
    let has_tools = result
        .get("capabilities")
        .and_then(|c| c.get("tools"))
        .is_some_and(|t| !t.is_null());
    let mut manifest = Map::new();
    manifest.insert("initializeResult".into(), result);
    if has_tools {
        let list = server
            .handle(json!({
                "jsonrpc": "2.0",
                "id": format!("{CAPTURE_ID_PREFIX}tools-list"),
                "method": "tools/list",
            }))
            .await?;
        let tools = list.get("result")?;
        // A paginated list isn't captured (`nextCursor === undefined` only).
        if tools.get("nextCursor").is_none() {
            manifest.insert("toolsListResult".into(), tools.clone());
        }
    }
    Some(Value::Object(manifest))
}

/// `captureSdkMcpServerManifests()`: handshake every in-process server
/// concurrently within [`MANIFEST_CAPTURE_DEADLINE`]. The result is keyed in
/// `servers` order. `None` when nothing was captured, so `initialize` omits
/// the field.
///
/// Not ported: the SDK also drops a server's `toolsListResult` if it emitted
/// `notifications/tools/list_changed` during the capture. [`SdkMcpServer`]
/// has no server-initiated messages, so that can't happen here.
pub async fn capture_manifests(
    servers: &IndexMap<String, Arc<dyn SdkMcpServer>>,
) -> Option<Map<String, Value>> {
    if servers.is_empty() {
        return None;
    }
    let deadline = tokio::time::Instant::now() + MANIFEST_CAPTURE_DEADLINE;
    let captured = futures::future::join_all(servers.iter().map(|(name, server)| async move {
        let m = tokio::time::timeout_at(deadline, capture_one(server.as_ref()))
            .await
            .ok()
            .flatten();
        (name.clone(), m)
    }))
    .await;
    let out: Map<String, Value> = captured
        .into_iter()
        .filter_map(|(name, m)| m.map(|m| (name, m)))
        .collect();
    (!out.is_empty()).then_some(out)
}

/// JS truthiness of an env flag, like the SDK's `Re()`: `1` / `true` /
/// `yes` / `on`, case-insensitive and trimmed.
pub(crate) fn env_flag_truthy(v: Option<&str>) -> bool {
    v.is_some_and(|v| {
        matches!(
            v.trim().to_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// The MCP SDK's `JSONRPCRequestSchema` (`y0`), which its server dispatches
/// on: a strict object (no keys beyond `jsonrpc`, `id`, `method`, `params`)
/// with `jsonrpc: "2.0"`, a string or safe-integer `id`, a string `method`,
/// and `params` absent or an object whose `_meta` (if any) is well formed.
/// Anything else that isn't a response or notification is dropped with no
/// reply.
pub fn is_jsonrpc_request(msg: &Value) -> bool {
    let Some(m) = msg.as_object() else {
        return false;
    };
    m.keys()
        .all(|k| matches!(k.as_str(), "jsonrpc" | "id" | "method" | "params"))
        && m.get("jsonrpc").is_some_and(|v| v == "2.0")
        && m.get("id").is_some_and(is_request_id)
        && m.get("method").is_some_and(Value::is_string)
        && m.get("params").is_none_or(params_ok)
}

/// `RequestIdSchema`: a string or a zod `int()` (a safe integer).
fn is_request_id(id: &Value) -> bool {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    match id {
        Value::String(_) => true,
        Value::Number(n) => n
            .as_f64()
            .is_some_and(|x| x.fract() == 0.0 && x.abs() <= MAX_SAFE),
        _ => false,
    }
}

/// Request `params` (`Kn.loose()`): an object, with `_meta` absent or an
/// object whose `progressToken` is a request id and whose related-task
/// entry has a string `taskId`.
fn params_ok(params: &Value) -> bool {
    let Some(p) = params.as_object() else {
        return false;
    };
    let Some(meta) = p.get("_meta") else {
        return true;
    };
    let Some(meta) = meta.as_object() else {
        return false;
    };
    meta.get("progressToken").is_none_or(is_request_id)
        && meta
            .get("io.modelcontextprotocol/related-task")
            .is_none_or(|t| t.get("taskId").is_some_and(Value::is_string))
}

type ToolFut = Pin<Box<dyn Future<Output = ToolOutput> + Send>>;
type ToolHandler = Arc<dyn Fn(Value) -> ToolFut + Send + Sync>;

/// Result of a tool call (`CallToolResult`).
#[derive(Clone, Debug)]
pub struct ToolOutput {
    pub content: Vec<Value>,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn text(t: impl Into<String>) -> Self {
        Self {
            content: vec![json!({"type": "text", "text": t.into()})],
            is_error: false,
        }
    }
    pub fn error(t: impl Into<String>) -> Self {
        Self {
            content: vec![json!({"type": "text", "text": t.into()})],
            is_error: true,
        }
    }
}

#[derive(Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    handler: ToolHandler,
}

impl ToolDef {
    pub fn new<F, Fut>(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
        f: F,
    ) -> Self
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ToolOutput> + Send + 'static,
    {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
            handler: Arc::new(move |args| Box::pin(f(args)) as ToolFut),
        }
    }
}

/// `createSdkMcpServer({name, version, tools, timeout?, disableAutoBackground?})`.
///
/// `tools` is always passed, like the TS `tools: [...]`. With an empty list,
/// the SDK's server still advertises `capabilities.tools` (`{}`), but
/// `tools/list` / `tools/call` answer "Method not found" (no tool handlers
/// are registered). The manifest capture then skips it, exactly like TS.
pub struct ToolServer {
    pub name: String,
    pub version: String,
    /// Insertion order, like the SDK's tool registry.
    tools: IndexMap<String, ToolDef>,
    settings: SdkServerSettings,
}

impl ToolServer {
    pub fn new(name: impl Into<String>, version: impl Into<String>, tools: Vec<ToolDef>) -> Self {
        Self {
            name: name.into(),
            version: version.into(),
            tools: tools.into_iter().map(|t| (t.name.clone(), t)).collect(),
            settings: SdkServerSettings::default(),
        }
    }

    /// `timeout` (ms): the CLI's per-tool-call timeout for this server.
    pub fn with_timeout(mut self, ms: u64) -> Self {
        self.settings.timeout = (ms > 0).then_some(ms);
        self
    }

    /// `disableAutoBackground: true`.
    pub fn with_disable_auto_background(mut self, on: bool) -> Self {
        self.settings.disable_auto_background = on;
        self
    }
}

/// JSON-RPC result, in the MCP SDK's key order (`result` first).
fn rpc_result(id: &Value, result: Value) -> Value {
    json!({"result": result, "jsonrpc": "2.0", "id": id})
}

/// JSON-RPC error, in the MCP SDK's key order.
fn rpc_error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn method_not_found(id: &Value) -> Value {
    rpc_error(id, -32601, "Method not found")
}

#[async_trait]
impl SdkMcpServer for ToolServer {
    async fn handle(&self, message: Value) -> Option<Value> {
        if !is_jsonrpc_request(&message) {
            return None; // notifications/initialized, cancelled, ...
        }
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        Some(match method {
            "initialize" => {
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .filter(|v| SUPPORTED_MCP_PROTOCOL_VERSIONS.contains(v))
                    .unwrap_or(MCP_PROTOCOL_VERSION);
                let tools_cap = if self.tools.is_empty() {
                    json!({})
                } else {
                    json!({"listChanged": true})
                };
                rpc_result(
                    &id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": tools_cap},
                        "serverInfo": {"name": self.name, "version": self.version},
                    }),
                )
            }
            "ping" => rpc_result(&id, json!({})),
            "tools/list" | "tools/call" if self.tools.is_empty() => method_not_found(&id),
            "tools/list" => {
                let tools: Vec<Value> = self
                    .tools
                    .values()
                    .map(|t| {
                        json!({
                            "name": t.name,
                            "description": t.description,
                            "inputSchema": t.input_schema,
                            "execution": {"taskSupport": "forbidden"},
                        })
                    })
                    .collect();
                rpc_result(&id, json!({"tools": tools}))
            }
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                // McpServer turns a thrown `McpError` into an error result.
                let Some(tool) = self.tools.get(name) else {
                    let out = ToolOutput::error(format!("MCP error -32602: Tool {name} not found"));
                    return Some(rpc_result(
                        &id,
                        json!({"content": out.content, "isError": true}),
                    ));
                };
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let out = (tool.handler)(args).await;
                let mut result = json!({"content": out.content});
                if out.is_error {
                    result["isError"] = json!(true);
                }
                rpc_result(&id, result)
            }
            _ => method_not_found(&id),
        })
    }

    fn settings(&self) -> SdkServerSettings {
        self.settings.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tool_server_round_trip() {
        let srv = ToolServer::new(
            "t",
            "1.0.0",
            vec![ToolDef::new(
                "echo",
                "Echo",
                json!({"type": "object"}),
                |a| async move { ToolOutput::text(a["msg"].as_str().unwrap_or_default().to_string()) },
            )],
        );
        let init = srv
            .handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}))
            .await
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert!(
            srv.handle(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
                .await
                .is_none()
        );
        let list = srv
            .handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
            .await
            .unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], "echo");
        let call = srv
            .handle(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"msg":"hi"}}}))
            .await
            .unwrap();
        assert_eq!(call["result"]["content"][0]["text"], "hi");
    }
    fn echo_server() -> ToolServer {
        ToolServer::new(
            "t",
            "1.0.0",
            vec![ToolDef::new(
                "echo",
                "Echo",
                json!({"type": "object"}),
                |_| async { ToolOutput::text("ok") },
            )],
        )
    }

    #[test]
    fn settings_json_matches_sdk_validation() {
        assert!(SdkServerSettings::default().to_json().is_empty());
        let zero = SdkServerSettings {
            timeout: Some(0),
            disable_auto_background: false,
        };
        assert!(
            zero.to_json().is_empty(),
            "sh() drops non-positive timeouts"
        );
        let both = SdkServerSettings {
            timeout: Some(10_000),
            disable_auto_background: true,
        };
        assert_eq!(
            serde_json::to_string(&both.to_json()).unwrap(),
            r#"{"timeout":10000,"disableAutoBackground":true}"#
        );
        // Builders: 0 means "unset", `false` is never sent.
        let srv = echo_server()
            .with_timeout(0)
            .with_disable_auto_background(false);
        assert_eq!(srv.settings(), SdkServerSettings::default());
        let srv = echo_server()
            .with_timeout(5)
            .with_disable_auto_background(true);
        assert_eq!(
            Value::Object(srv.settings().to_json()),
            json!({"timeout": 5, "disableAutoBackground": true})
        );
    }

    #[tokio::test]
    async fn tool_server_wire_shape_matches_mcp_sdk() {
        let srv = echo_server();
        // Results put `result` first, errors put it last: McpServer's order.
        let list = srv
            .handle(json!({"jsonrpc":"2.0","id":7,"method":"tools/list"}))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_string(&list).unwrap(),
            r#"{"result":{"tools":[{"name":"echo","description":"Echo","inputSchema":{"type":"object"},"execution":{"taskSupport":"forbidden"}}]},"jsonrpc":"2.0","id":7}"#
        );
        let missing = srv
            .handle(json!({"jsonrpc":"2.0","id":8,"method":"resources/list"}))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_string(&missing).unwrap(),
            r#"{"jsonrpc":"2.0","id":8,"error":{"code":-32601,"message":"Method not found"}}"#
        );
        let init = srv
            .handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
            .await
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], MCP_PROTOCOL_VERSION);
        assert_eq!(
            init["result"]["capabilities"],
            json!({"tools": {"listChanged": true}})
        );
    }

    #[tokio::test]
    async fn empty_tool_server_advertises_tools_but_cannot_list_them() {
        let srv = ToolServer::new("aux", "0.1.0", vec![]);
        let init = srv
            .handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
            .await
            .unwrap();
        assert_eq!(init["result"]["capabilities"], json!({"tools": {}}));
        for method in ["tools/list", "tools/call"] {
            let r = srv
                .handle(json!({"jsonrpc":"2.0","id":2,"method":method}))
                .await
                .unwrap();
            assert_eq!(r["error"]["code"], -32601, "{method}");
        }
    }

    /// Records every message and answers per the given behaviour.
    struct Scripted {
        seen: std::sync::Mutex<Vec<Value>>,
        behaviour: &'static str,
    }

    impl Scripted {
        fn new(behaviour: &'static str) -> Arc<Self> {
            Arc::new(Self {
                seen: Default::default(),
                behaviour,
            })
        }
    }

    #[async_trait]
    impl SdkMcpServer for Scripted {
        async fn handle(&self, message: Value) -> Option<Value> {
            self.seen.lock().unwrap().push(message.clone());
            let id = message.get("id")?.clone();
            let method = message["method"].as_str().unwrap_or_default();
            match (self.behaviour, method) {
                ("error", _) => Some(rpc_error(&id, -32603, "boom")),
                ("slow", _) => {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    None
                }
                ("no-tools", "initialize") => Some(rpc_result(
                    &id,
                    json!({"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "serverInfo": {"name": "n", "version": "1"}}),
                )),
                (_, "initialize") => Some(rpc_result(
                    &id,
                    json!({"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {"tools": {}}, "serverInfo": {"name": "p", "version": "1"}}),
                )),
                ("paged", "tools/list") => {
                    Some(rpc_result(&id, json!({"tools": [], "nextCursor": "2"})))
                }
                _ => Some(method_not_found(&id)),
            }
        }
    }

    #[tokio::test]
    async fn capture_manifests_like_the_sdk() {
        let paged = Scripted::new("paged");
        let mut servers: IndexMap<String, Arc<dyn SdkMcpServer>> = IndexMap::new();
        servers.insert("slow".into(), Scripted::new("slow"));
        servers.insert("goal".into(), Arc::new(echo_server()));
        servers.insert("empty".into(), Arc::new(ToolServer::new("e", "1", vec![])));
        servers.insert("error".into(), Scripted::new("error"));
        servers.insert("no_tools".into(), Scripted::new("no-tools"));
        servers.insert("paged".into(), paged.clone());

        let started = std::time::Instant::now();
        let got = capture_manifests(&servers).await.unwrap();
        let took = started.elapsed();
        assert!(
            took >= MANIFEST_CAPTURE_DEADLINE && took < Duration::from_secs(5),
            "the slow server is cut off at the deadline: {took:?}"
        );

        // Server order kept; failing, slow and empty-tools servers dropped.
        assert_eq!(
            got.keys().collect::<Vec<_>>(),
            ["goal", "no_tools", "paged"]
        );
        assert_eq!(got["goal"]["toolsListResult"]["tools"][0]["name"], "echo");
        assert_eq!(
            got["goal"]["initializeResult"]["serverInfo"],
            json!({"name": "t", "version": "1.0.0"})
        );
        // No tools capability → no tools/list round trip.
        assert_eq!(
            got["no_tools"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["initializeResult"]
        );
        // Paginated list → only the initialize result.
        assert!(got["paged"].get("toolsListResult").is_none());

        // The handshake the SDK sends.
        let seen = paged.seen.lock().unwrap().clone();
        assert_eq!(
            seen,
            [
                json!({"jsonrpc": "2.0", "id": "sdk-manifest-capture:initialize", "method": "initialize",
                       "params": {"protocolVersion": "2025-11-25", "capabilities": {},
                                  "clientInfo": capture_client_info()}}),
                json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                json!({"jsonrpc": "2.0", "id": "sdk-manifest-capture:tools-list", "method": "tools/list"}),
            ]
        );
        assert_eq!(capture_client_info()["version"], MIRRORED_SDK_VERSION);
    }

    #[tokio::test]
    async fn capture_manifests_omits_the_field_when_nothing_is_captured() {
        assert!(capture_manifests(&IndexMap::new()).await.is_none());
        let mut servers: IndexMap<String, Arc<dyn SdkMcpServer>> = IndexMap::new();
        servers.insert("empty".into(), Arc::new(ToolServer::new("e", "1", vec![])));
        servers.insert("error".into(), Scripted::new("error"));
        assert!(capture_manifests(&servers).await.is_none());
    }

    #[test]
    fn env_flag_truthiness_matches_re() {
        for on in ["1", "true", "TRUE", "yes", "On", " on "] {
            assert!(env_flag_truthy(Some(on)), "{on:?}");
        }
        for off in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("no"),
            Some("2"),
        ] {
            assert!(!env_flag_truthy(off), "{off:?}");
        }
    }
}
