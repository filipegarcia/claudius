#!/usr/bin/env node
// Golden fixture for what the SDK's message reader (`Query.readMessages`)
// does beyond routing and run end:
// - drops `session_state_changed` messages flagged `sdk_host_only: true`;
// - turns the CLI's exit error into `Claude Code returned an error result:
//   <text>` when the last result was an error (`lastErrorResultText`,
//   `modelLessTurnEnded`, `errorTextBeforeModelLessTurns`), and formats the
//   exit error itself (code, signal name, stderr tail);
// - remembers `system/commands_changed` for `supportedCommands()`;
// - and, in the transport underneath, decodes stdout / stderr as UTF-8 with
//   replacement characters, splits stdout lines on `\n`, `\r\n` and bare
//   `\r`, and keeps the last 2048 UTF-16 units of stderr.
//
//   node rust/scripts/reader-golden.mjs     (builds claudius-fake-claude)
//
// Each case runs the real SDK's string-prompt `query()` against
// `claudius-fake-claude` with one scripted turn, and records what it yielded
// (`type/subtype`, plus `:state` for state changes and `:"status"` for
// `system/status`), the error the stream ended with (or null), and
// `supportedCommands()` once the stream is over. (Asking earlier would race
// the reader, which doesn't wait for the consumer.) Cases tagged with an
// `os` (Rust's name for it) only hold there (signal numbers differ). Written to
// rust/crates/claudius-agent/tests/fixtures/reader_golden.json and replayed
// against the Rust `Query` by crates/claudius-agent/tests/reader_golden.rs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scannerSafeJson } from "./scanner-safe-json.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const { query } = await import(pathToFileURL(join(sdkPath, "sdk.mjs")).href);
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;

const base = { duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
const ok = { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, ...base };
const err = (...errors) => ({ type: "result", subtype: "error_during_execution", is_error: true, errors, num_turns: 1, ...base });
const modelLess = { type: "result", subtype: "success", is_error: false, result: "", num_turns: 0, ...base };
const state = (s, extra = {}) => ({ type: "system", subtype: "session_state_changed", state: s, ...extra });
const assistant = { type: "assistant", message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null };
const sys = (subtype, extra = {}) => ({ type: "system", subtype, ...extra });
const exit = (code) => ({ $exit: code });
const bytes = (...parts) => [...Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : Buffer.from(p))))];
const out = (...parts) => ({ $stdout_bytes: bytes(...parts) });
const statusOpen = '{"type":"system","subtype":"status","status":"';
const status = (text) => `${statusOpen}${text}"}`;
// 1 + 3000 + 1 UTF-16 units: the 2048-unit tail window starts on a low
// surrogate, which the SDK drops.
const longTail = `x${"é😀".repeat(1000)}\n`;

// [name, steps]. No callbacks, so the first result ends the run (stdin
// closes) while the fake carries on with the rest of its steps.
const CASES = [
  ["host_only_states", [state("running", { sdk_host_only: true }), state("requires_action", { sdk_host_only: false }), state("running", { sdk_host_only: "true" }), state("idle", { sdk_host_only: true }), ok]],
  ["error_result_then_exit", [err("  boom  ", "", "two"), exit(1)]],
  ["success_is_error_then_exit", [{ ...ok, is_error: true, result: "API Error: 500" }, exit(1)]],
  ["assistant_clears", [err("boom"), assistant, exit(1)]],
  ["model_less_keeps_earlier_error", [err("boom"), modelLess, exit(1)]],
  ["init_after_model_less_clears", [err("boom"), modelLess, sys("init", { model: "m" }), exit(1)]],
  ["other_system_keeps_model_less", [err("boom"), modelLess, sys("status", { status: null }), exit(1)]],
  ["other_system_clears_last_error", [err("boom"), sys("status", { status: null }), exit(1)]],
  ["compact_boundary_clears", [err("boom"), modelLess, sys("compact_boundary", { compact_metadata: { trigger: "auto", pre_tokens: 1 } }), exit(1)]],
  ["state_change_keeps", [err("boom"), state("running"), exit(1)]],
  ["summary_keeps", [err("boom"), sys("post_turn_summary", { summary: "s" }), exit(1)]],
  ["active_goal_keeps", [err("boom"), { type: "active_goal", goal: null }, exit(1)]],
  ["autocompact_state_keeps", [err("boom"), { type: "autocompact_state", enabled: true }, exit(1)]],
  ["commands_changed_clears", [err("boom"), sys("commands_changed", { commands: [] }), exit(1)]],
  ["empty_result_text", [{ ...ok, is_error: true, result: "" }, exit(1)]],
  ["empty_errors", [{ ...err(), subtype: "error_max_turns" }, exit(1)]],
  ["blank_errors", [err(" ", "\n"), exit(1)]],
  ["error_then_exit_zero", [err("boom"), exit(0)]],
  ["model_less_alone", [modelLess, exit(1)]],
  ["latest_error_wins", [err("first"), err("second"), exit(1)]],
  ["non_string_result", [{ ...ok, is_error: true, result: 42 }, exit(1)]],
  ["truthy_is_error", [{ ...ok, is_error: 1, result: "x" }, exit(1)]],
  ["num_turns_string_not_model_less", [err("boom"), { ...modelLess, num_turns: "0" }, exit(1)]],
  ["model_less_needs_success", [err("boom"), { ...modelLess, subtype: "error_max_turns" }, exit(1)]],
  ["model_less_needs_no_error", [err("boom"), { ...modelLess, is_error: true }, exit(1)]],
  ["model_less_needs_empty_result", [err("boom"), { ...modelLess, result: "x" }, exit(1)]],
  ["assistant_after_model_less_clears", [err("boom"), modelLess, assistant, exit(1)]],
  ["plain_exit", [ok, exit(3)]],
  ["stderr_tail", [{ $stderr: "  oops  " }, { $stderr: "\u001b[31mred\u001b[0m" }, exit(2)]],
  ["signal", [ok, { $kill: "SIGTERM" }]],
  ["signal_after_error", [err("boom"), { $kill: "SIGKILL" }]],
  ["commands_changed", [sys("commands_changed", { commands: [{ name: "a", description: "A" }] }), ok]],
  ["commands_changed_non_array_ignored", [sys("commands_changed", { commands: [{ name: "a" }] }), sys("commands_changed", { commands: "nope" }), ok]],
  ["commands_changed_empty", [sys("commands_changed", { commands: [] }), ok]],
  ["commands_unchanged", [ok]],
  ["stdout_invalid_utf8", [out(statusOpen, "a", [0xff], "b", [0xc3, 0x28], [0xf0, 0x9f, 0x98], '"}\n'), ok]],
  ["stdout_split_code_point", [out(statusOpen, "caf", [0xc3]), { $delay_ms: 100 }, out([0xa9], '"}\n'), ok]],
  ["stdout_bare_cr_splits", [out(status("one"), "\r", status("two"), "\r\n", status("three"), "\r"), { $delay_ms: 100 }, out("\n", status("four"), "\n"), ok]],
  ["stdout_skips_non_json", [out("   \n", "not json\n", "\u00a0", status("nbsp"), "\n", "\t", status("tab"), "\t\n", "[1]\n", "5\n", "\"s\"\n"), ok]],
  ["stdout_unterminated_last_line", [ok, out(status("tail"))]],
  ["stderr_invalid_utf8_crlf", [{ $stderr_bytes: bytes(" bad ", [0xff, 0xfe], " end\r\nline2\r\n\u00a0") }, exit(2)]],
  ["stderr_long_tail", [{ $stderr_bytes: bytes(longTail) }, exit(2)]],
  ["stderr_unterminated", [{ $stderr_bytes: bytes("no newline") }, exit(4)]],
  ["stderr_redacted", [{ $stderr: "401 for Authorization: Bearer abcdefgh12345678" }, { $stderr: `key=sk-ant-api03-${"a1B2".repeat(10)} id=AKIA${"ABCDEFGHIJKLMNOP"}` }, exit(1)]],
  ["signal_by_number", [ok, { $kill: 15 }]],
  // SIGEMT on macOS; the tag is Rust's `std::env::consts::OS`.
  ["signal_unknown_to_node", [ok, { $kill: 7 }], "macos"],
];

function buildFake() {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  return join(rustDir, "target/debug/claudius-fake-claude");
}

const describe = (m) => {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return `value:${JSON.stringify(m)}`;
  const kind = m.subtype ? `${m.type}/${m.subtype}` : m.type;
  if (m.subtype === "session_state_changed") return `${kind}:${m.state}`;
  return m.subtype === "status" ? `${kind}:${JSON.stringify(m.status)}` : kind;
};

async function record(fake, [name, steps, os]) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "reader-golden-")));
  const script = { turns: [{ steps, result: false }] };
  const q = query({
    prompt: "go",
    options: {
      pathToClaudeCodeExecutable: fake,
      cwd: tmp,
      env: { PATH: "/usr/bin:/bin", HOME: tmp, FAKE_CLAUDE_SCRIPT: JSON.stringify(script) },
    },
  });
  const yielded = [];
  let error = null;
  try {
    for await (const msg of q) {
      yielded.push(describe(msg));
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const commands = await q.supportedCommands();
  rmSync(tmp, { recursive: true, force: true });
  return { name, ...(os && { os }), script, yielded, error, commands };
}

if (process.platform !== "darwin") throw new Error("record on macOS: the os-tagged cases assume darwin signal numbers");
const fake = buildFake();
const cases = await Promise.all(CASES.map((c) => record(fake, c)));
const file = join(rustDir, "crates/claudius-agent/tests/fixtures/reader_golden.json");
writeFileSync(file, scannerSafeJson(`${JSON.stringify({ sdkVersion, cases }, null, 2)}\n`));
for (const c of cases) console.log(`${c.name.padEnd(36)} ${JSON.stringify(c.yielded.slice(1))} ${JSON.stringify(c.error)}`);
console.log(`wrote ${file.slice(repo.length + 1)}`);
