#!/usr/bin/env node
// Golden fixture for the host side of CLI-initiated control requests: what
// the REAL TypeScript SDK replies to every `control_request` the CLI can
// send (`Query.handleControlRequest` / `processControlRequest`).
//
//   node rust/scripts/control-golden.mjs     (builds claudius-fake-claude)
//
// The SDK's `query()` runs against `claudius-fake-claude` with a script
// whose `on_init` fires every request below (`$send`, or a raw message for
// malformed ones), then collects replies for a while and exits. Each case
// runs twice:
//   bare   no callbacks, hooks or SDK MCP servers: the error / default replies
//   wired  canUseTool, onElicitation, one PreToolUse hook and an SDK MCP
//          server `srv` (tool `echo`). The callbacks echo what they were
//          given (minus the abort signal), so the replies also pin how the
//          SDK maps a request onto the callback arguments. `silent` inputs
//          make them return null (the request stays unanswered).
// Replies are keyed by request id; `null` means unanswered. Written to
// rust/crates/claudius-agent/tests/fixtures/control_golden.json and replayed
// against the Rust `Query` by crates/claudius-agent/tests/control_golden.rs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const { query, createSdkMcpServer, tool } = await import(pathToFileURL(join(sdkPath, "sdk.mjs")).href);
const { z } = await import(pathToFileURL(join(repo, "node_modules/zod/index.js")).href);
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
const COLLECT_MS = 1500;

const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" };
const rpc = (message) => ({ subtype: "mcp_message", server_name: "srv", message });
// [name, request body] for `$send`, or [name, {raw: message}] for a raw line.
const REQUESTS = [
  ["can_use_tool", { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_1", permission_suggestions: [suggestion], blocked_path: "/tmp/x", decision_reason: "rule says ask", title: "Run ls", display_name: "Bash", description: "List files", agent_id: "agent_1" }],
  ["can_use_tool_all_fields", {
    subtype: "can_use_tool", tool_name: "mcp__srv__echo", input: { msg: "hi" }, tool_use_id: "toolu_2",
    mcp_server: { name: "srv", source: "sdk", extra: 1 }, decision_reason_type: "rule", decision_reason_code: "ask_rule",
    default_to_no: true, suppress_always_allow_rule: true, plugin: "plug@market", requires_user_interaction: true,
    server_prompt: "why", computer_folder: { path: "/p", computer_name: "mac", extra: 1 },
    matched_ask_rule: { source: "userSettings", tool_name: "Bash", rule_content: "ls:*" },
  }],
  ["can_use_tool_odd_types", {
    subtype: "can_use_tool", tool_name: "Read", input: {}, decision_reason_type: 5, decision_reason_code: null, plugin: 7,
    requires_user_interaction: "yes", server_prompt: false, computer_folder: { path: 1, computer_name: "mac" },
    mcp_server: "named", matched_ask_rule: { source: "projectSettings" },
  }],
  ["can_use_tool_odd_shapes", {
    subtype: "can_use_tool", tool_name: "Read", input: {}, computer_folder: { path: "/p", computer_name: 3 },
    mcp_server: { name: null, other: 1 }, matched_ask_rule: "x", default_to_no: false,
  }],
  ["can_use_tool_null_rule_fields", {
    subtype: "can_use_tool", tool_name: "Read", input: {}, computer_folder: ["/p", "mac"],
    mcp_server: ["srv"], matched_ask_rule: { source: null, tool_name: "T", rule_content: null },
  }],
  ["can_use_tool_minimal", { subtype: "can_use_tool", tool_name: "Read", input: { file_path: "/a" } }],
  ["can_use_tool_deny", { subtype: "can_use_tool", tool_name: "deny", input: {}, tool_use_id: "toolu_3" }],
  ["can_use_tool_always", { subtype: "can_use_tool", tool_name: "always", input: { a: 1 }, tool_use_id: "toolu_4", permission_suggestions: [suggestion] }],
  ["can_use_tool_silent", { subtype: "can_use_tool", tool_name: "silent", input: {} }],
  ["hook_callback", { subtype: "hook_callback", callback_id: "hook_0", input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, tool_use_id: "toolu_5" }],
  ["hook_callback_no_tool_use_id", { subtype: "hook_callback", callback_id: "hook_0", input: { hook_event_name: "PreToolUse" } }],
  ["hook_callback_unknown_id", { subtype: "hook_callback", callback_id: "hook_99", input: {} }],
  ["hook_callback_numeric_id", { subtype: "hook_callback", callback_id: 0, input: {} }],
  ["hook_callback_missing_id", { subtype: "hook_callback", input: {} }],
  ["mcp_initialize", rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } })],
  ["mcp_tools_list", rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })],
  ["mcp_tools_call", rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { msg: "hi" } } })],
  ["mcp_tools_call_string_id", rpc({ jsonrpc: "2.0", id: "call-a", method: "tools/call", params: { name: "echo", arguments: { msg: "a" } } })],
  ["mcp_ping", rpc({ jsonrpc: "2.0", id: 5, method: "ping" })],
  ["mcp_unknown_method", rpc({ jsonrpc: "2.0", id: 6, method: "resources/list" })],
  ["mcp_notification", rpc({ jsonrpc: "2.0", method: "notifications/initialized" })],
  ["mcp_null_id", rpc({ jsonrpc: "2.0", id: null, method: "ping" })],
  ["mcp_response_shaped", rpc({ jsonrpc: "2.0", id: 9, result: {} })],
  ["mcp_numeric_method", rpc({ jsonrpc: "2.0", id: 10, method: 5 })],
  ["mcp_no_jsonrpc", rpc({ id: 11, method: "ping" })],
  ["mcp_tools_call_unknown_tool", rpc({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "nope", arguments: {} } })],
  ["mcp_initialize_old_version", rpc({ jsonrpc: "2.0", id: 13, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } } })],
  ["mcp_initialize_unsupported_version", rpc({ jsonrpc: "2.0", id: 14, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "c", version: "1" } } })],
  ["mcp_initialize_no_params", rpc({ jsonrpc: "2.0", id: 15, method: "initialize" })],
  ["mcp_tools_call_bad_args", rpc({ jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "echo", arguments: { msg: 5 } } })],
  ["mcp_tools_call_no_args", rpc({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "echo" } })],
  ["mcp_tools_call_no_name", rpc({ jsonrpc: "2.0", id: 18, method: "tools/call", params: {} })],
  ["mcp_float_id", rpc({ jsonrpc: "2.0", id: 1.5, method: "ping" })],
  ["mcp_bool_id", rpc({ jsonrpc: "2.0", id: true, method: "ping" })],
  ["mcp_unsafe_id", rpc({ jsonrpc: "2.0", id: 2 ** 53, method: "ping" })],
  ["mcp_max_safe_id", rpc({ jsonrpc: "2.0", id: 2 ** 53 - 1, method: "ping" })],
  ["mcp_negative_id", rpc({ jsonrpc: "2.0", id: -4, method: "ping" })],
  ["mcp_extra_key", rpc({ jsonrpc: "2.0", id: 21, method: "ping", extra: 1 })],
  ["mcp_null_params", rpc({ jsonrpc: "2.0", id: 22, method: "ping", params: null })],
  ["mcp_string_params", rpc({ jsonrpc: "2.0", id: 23, method: "ping", params: "x" })],
  ["mcp_bad_progress_token", rpc({ jsonrpc: "2.0", id: 24, method: "ping", params: { _meta: { progressToken: 1.5 } } })],
  ["mcp_bad_related_task", rpc({ jsonrpc: "2.0", id: 25, method: "ping", params: { _meta: { "io.modelcontextprotocol/related-task": { taskId: 1 } } } })],
  ["mcp_ping_with_meta", rpc({ jsonrpc: "2.0", id: 26, method: "ping", params: { _meta: { progressToken: "t", other: 1 }, extra: true } })],
  ["mcp_wrong_jsonrpc", rpc({ jsonrpc: "1.0", id: 27, method: "ping" })],
  ["mcp_array_message", { subtype: "mcp_message", server_name: "srv", message: [1] }],
  ["mcp_number_message", { subtype: "mcp_message", server_name: "srv", message: 5 }],
  ["mcp_null_message", { subtype: "mcp_message", server_name: "srv", message: null }],
  ["mcp_number_server_name", { subtype: "mcp_message", server_name: 5, message: { jsonrpc: "2.0", id: 19, method: "ping" } }],
  ["mcp_missing_server_name", { subtype: "mcp_message", message: { jsonrpc: "2.0", id: 20, method: "ping" } }],
  ["mcp_unknown_server", { subtype: "mcp_message", server_name: "nope", message: { jsonrpc: "2.0", id: 1, method: "ping" } }],
  ["mcp_no_message", { subtype: "mcp_message", server_name: "srv" }],
  ["mcp_string_message", { subtype: "mcp_message", server_name: "srv", message: "hello" }],
  ["elicitation_form", { subtype: "elicitation", mcp_server_name: "srv", message: "Need input", mode: "form", requested_schema: { type: "object", properties: { a: { type: "string" } } }, title: "T", display_name: "D", description: "Desc" }],
  ["elicitation_url", { subtype: "elicitation", mcp_server_name: "srv", message: "Sign in", mode: "url", url: "https://example.com/auth", elicitation_id: "el_1" }],
  ["elicitation_minimal", { subtype: "elicitation", message: "?" }],
  ["elicitation_silent", { subtype: "elicitation", mcp_server_name: "srv", message: "silent" }],
  ["request_user_dialog", { subtype: "request_user_dialog", dialog_kind: "confirm", payload: { a: 1 }, tool_use_id: "toolu_6" }],
  ["oauth_token_refresh", { subtype: "oauth_token_refresh" }],
  ["host_auth_token_refresh", { subtype: "host_auth_token_refresh" }],
  ["remote_control_work_secret", { subtype: "remote_control_work_secret", session_id: "session_abcd" }],
  ...["ui_copy", "ui_prompt_read", "ui_prompt_fill", "ui_prompt_suggest", "ui_read_selection"].map((s) => [s, { subtype: s, text: "x" }]),
  ...["remote_tool_call", "remote_plumbing_call", "remote_tools_probe", "remote_tools_reannounce"].map((s) => [s, { subtype: s }]),
  ["unknown_subtype", { subtype: "zz_unknown", a: 1 }],
  ["missing_subtype", { a: 1 }],
  ["number_subtype", { subtype: 7 }],
  ["null_subtype", { subtype: null }],
  ["array_subtype", { subtype: ["can_use_tool", 2] }],
  ["nested_array_subtype", { subtype: ["a", null, [1, null], {}, 1.5] }],
  ["bool_subtype", { subtype: false }],
  ["object_subtype", { subtype: { a: 1 } }],
  ["missing_request", { raw: { type: "control_request", request_id: "raw_missing" } }],
  ["null_request", { raw: { type: "control_request", request_id: "raw_null", request: null } }],
];

function buildFake() {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  return join(rustDir, "target/debug/claudius-fake-claude");
}

/** The fake CLI script: fire everything, collect, exit. Returns [script, ids]. */
function script() {
  const steps = [];
  const ids = {};
  for (const [name, body] of REQUESTS) {
    if (body.raw) {
      ids[name] = body.raw.request_id;
      steps.push(body.raw);
    } else {
      ids[name] = `cli_0_s${steps.length}`;
      steps.push({ $send: body });
    }
  }
  steps.push({ $collect_ms: COLLECT_MS }, { $exit: 0 });
  return [{ on_init: steps }, ids];
}

function wiredOptions() {
  return {
    canUseTool: async (toolName, input, ctx) => {
      const { signal, ...rest } = ctx;
      if (toolName === "silent") return null;
      if (toolName === "deny") return { behavior: "deny", message: `no ${ctx.toolUseID}`, interrupt: true };
      if (toolName === "always") return { behavior: "allow", updatedInput: input, updatedPermissions: ctx.suggestions };
      return { behavior: "allow", updatedInput: { input, ctx: rest, aborted: signal.aborted } };
    },
    onElicitation: async (req, { signal, requestId }) => {
      if (req.message === "silent") return null;
      return { action: "accept", content: { req, requestId, aborted: signal.aborted } };
    },
    hooks: {
      PreToolUse: [{ hooks: [async (input, toolUseID, { signal }) => ({ continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", echo: { input, toolUseID: toolUseID ?? null, aborted: signal.aborted } } })] }],
    },
    mcpServers: {
      srv: createSdkMcpServer({
        name: "srv",
        version: "1.0.0",
        tools: [tool("echo", "Echo the message", { msg: z.string().describe("text") }, async ({ msg }) => ({ content: [{ type: "text", text: `echo:${msg}` }] }))],
      }),
    },
  };
}

async function record(fake, wired) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "control-golden-")));
  const log = join(tmp, "stdin.log");
  const [s, ids] = script();
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* prompt() {
    await done; // never sends a message: everything happens in on_init
  }
  const q = query({
    prompt: prompt(),
    options: {
      pathToClaudeCodeExecutable: fake,
      cwd: tmp,
      env: { PATH: "/usr/bin:/bin", HOME: tmp, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SCRIPT: JSON.stringify(s) },
      ...(wired ? wiredOptions() : {}),
    },
  });
  try {
    for await (const msg of q) void msg;
  } catch (e) {
    // The fake exits 0 after collecting; anything else is a real failure.
    if (!/exited|closed/i.test(String(e))) throw e;
  } finally {
    finish();
  }
  const responses = new Map();
  for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.type === "control_response" && typeof m.response?.request_id === "string") {
      if (responses.has(m.response.request_id)) throw new Error(`two replies to ${m.response.request_id}`);
      responses.set(m.response.request_id, m.response);
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  return Object.fromEntries(REQUESTS.map(([name]) => [name, responses.get(ids[name]) ?? null]));
}

const fake = buildFake();
const [scriptJson, ids] = script();
const cases = { bare: await record(fake, false), wired: await record(fake, true) };
const file = join(rustDir, "crates/claudius-agent/tests/fixtures/control_golden.json");
writeFileSync(file, `${JSON.stringify({ sdkVersion, collectMs: COLLECT_MS, script: scriptJson, ids, cases }, null, 2)}\n`);
for (const [name, replies] of Object.entries(cases)) {
  const unanswered = Object.entries(replies).filter(([, r]) => r === null).map(([n]) => n);
  console.log(`${name}: ${Object.keys(replies).length} requests, unanswered: ${unanswered.join(", ")}`);
}
console.log(`wrote ${file.slice(repo.length + 1)}`);
