#!/usr/bin/env bun
// Golden wire fixtures: what the REAL TypeScript Agent SDK sends to the CLI.
//
//   bun rust/scripts/golden-wire.mjs            # (re)write every fixture
//   bun rust/scripts/golden-wire.mjs minimal    # just one case
//
// For each case it runs `query()` from node_modules/@anthropic-ai/claude-agent-sdk
// against `claudius-fake-claude`, sends one user message, waits for the
// result, and records:
//   argv        the CLI argv (no executable)
//   env         the child environment (fixed input env, so fully deterministic)
//   initialize  the `initialize` control request body
//   stdin       every stdin line, with random request ids normalized
// into rust/crates/claudius-agent/tests/fixtures/golden/<case>.json.
//
// `crates/claudius-agent/tests/golden_wire.rs` builds the same Options in Rust
// from the case's `spec`, captures the same things from the Rust `Query`,
// and diffs. Spec keys are TS `Options` keys; `$`-prefixed keys stand for
// callbacks / instances that can't be JSON:
//   $canUseTool: true            a canUseTool callback (allows everything)
//   $onElicitation: true         an onElicitation callback
//   $hooks: {Event: [{matcher?, timeout?, count?}]}   `count` callbacks each
//   $sdkMcpServers: {name: {version, timeout?, tools?: [{name, description,
//                    params: {arg: {description}}}]}}   in-process MCP servers
//                    (string args only; enough for the goal server)
// Re-run after bumping the SDK, then fix Rust until `cargo test` is green.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const { query, createSdkMcpServer, tool } = await import(join(sdkPath, "sdk.mjs"));
const { z } = await import(join(repo, "node_modules/zod/index.js"));
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
const outDir = join(rustDir, "crates/claudius-agent/tests/fixtures/golden");
const SESSION = "11111111-1111-4111-8111-111111111111";

// The fixed parent env every case starts from (written into each fixture as
// `baseEnv`, so golden_wire.rs uses the exact same input).
// Includes vars the SDK must strip or override, so the rules are exercised.
const BASE_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/golden/home",
  LANG: "en_US.UTF-8",
  NODE_OPTIONS: "--max-old-space-size=64",
  DEBUG: "1",
  CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES: "1",
  CLAUDE_CODE_QUESTION_EXTENDED: "1",
};

export const CASES = {
  minimal: {},
  // What lib/server/session.ts `start()` passes for a new session.
  claudius_session: {
    model: "claude-opus-4-8",
    permissionMode: "default",
    sessionId: SESSION,
    systemPrompt: { type: "preset", preset: "claude_code", append: "Claudius context." },
    planModeInstructions: "Plan carefully.",
    settingSources: ["user", "project", "local"],
    allowedTools: ["TodoWrite", "TaskCreate"],
    additionalDirectories: ["/golden/extra"],
    // Unsorted names on purpose: order must follow insertion, not the alphabet.
    mcpServers: { ext: { type: "stdio", command: "echo", args: ["hi"] }, alpha: { type: "http", url: "http://127.0.0.1:9/mcp" } },
    // claudius_goal mirrors Session.buildGoalMcpServer() (timeout → sdkMcpServerConfigs).
    $sdkMcpServers: {
      claudius_goal: {
        version: "1.0.0",
        timeout: 10000,
        tools: [
          {
            name: "report_goal_achieved",
            description: "Report that the user's stated session goal has been fully accomplished.",
            params: { summary: { description: "One sentence summarizing what was accomplished." } },
          },
        ],
      },
      aux_tools: { version: "0.1.0" },
    },
    $canUseTool: true,
    $onElicitation: true,
    $hooks: {
      PreToolUse: [{ matcher: "Bash", count: 2 }, { timeout: 30 }],
      PostToolUse: [{}],
      CwdChanged: [{}],
      PostModelSwitch: [{}],
    },
    includePartialMessages: true,
    includeHookEvents: true,
    perTaskStopAffordance: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    promptSuggestions: true,
    enableFileCheckpointing: true,
    thinking: { type: "adaptive" },
    toolConfig: { askUserQuestion: { previewFormat: "html" } },
    settings: { includeCoAuthoredBy: false },
  },
  // A resumed session plus the less common knobs.
  resume_and_limits: {
    resume: SESSION,
    resumeSessionAt: "22222222-2222-4222-8222-222222222222",
    resumeDropsTurn: "33333333-3333-4333-8333-333333333333",
    forkSession: true,
    model: "claude-sonnet-5",
    fallbackModel: "claude-haiku-4-5",
    agent: "reviewer",
    agents: { reviewer: { description: "Reviews code", prompt: "Review." } },
    effort: "high",
    maxTurns: 7,
    maxBudgetUsd: 2.5,
    taskBudget: { total: 50000 },
    betas: ["context-1m-2025-08-07"],
    disallowedTools: ["WebSearch"],
    tools: ["Bash", "Read"],
    skills: ["pdf", "docx"],
    persistSession: false,
    strictMcpConfig: true,
    permissionPromptToolName: "mcp__perm__ask",
    systemPrompt: "You are a custom prompt.",
    title: "Golden",
    extraArgs: { "replay-user-messages": null, "custom-flag": "-dash-value" },
    thinking: { type: "enabled", budgetTokens: 4096, display: "summarized" },
  },
  // Sandbox merge into --settings, bypass mode, continue.
  sandbox_bypass: {
    continue: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settings: { includeCoAuthoredBy: true, sandbox: { autoAllowBashIfSandboxed: true } },
    sandbox: { enabled: true },
    managedSettings: { model: "claude-opus-4-8" },
    systemPrompt: ["part one", "part two"],
    outputFormat: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
    thinking: { type: "disabled" },
    plugins: [{ type: "local", path: "/golden/plugin" }],
    toolConfig: { askUserQuestion: { extendedQuestions: true, optionalDescriptions: true } },
  },
};

function fakeBin() {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
  });
  return join(rustDir, "target/debug/claudius-fake-claude");
}

function buildOptions(spec, fake, cwd, files) {
  const opts = { ...spec };
  for (const k of Object.keys(opts)) if (k.startsWith("$")) delete opts[k];
  opts.pathToClaudeCodeExecutable = fake;
  opts.cwd = cwd;
  opts.env = {
    ...BASE_ENV,
    FAKE_CLAUDE_ARGV: files.argv,
    FAKE_CLAUDE_ENV: files.env,
    FAKE_CLAUDE_LOG: files.log,
  };
  if (spec.$canUseTool) opts.canUseTool = async (_tool, input) => ({ behavior: "allow", updatedInput: input });
  if (spec.$onElicitation) opts.onElicitation = async () => ({ action: "decline" });
  if (spec.$hooks) {
    opts.hooks = {};
    for (const [event, matchers] of Object.entries(spec.$hooks)) {
      opts.hooks[event] = matchers.map((m) => ({
        ...(m.matcher !== undefined ? { matcher: m.matcher } : {}),
        ...(m.timeout !== undefined ? { timeout: m.timeout } : {}),
        hooks: Array.from({ length: m.count ?? 1 }, () => async () => ({ continue: true })),
      }));
    }
  }
  if (spec.$sdkMcpServers) {
    opts.mcpServers = { ...opts.mcpServers };
    for (const [name, def] of Object.entries(spec.$sdkMcpServers)) {
      const tools = (def.tools ?? []).map((t) =>
        tool(
          t.name,
          t.description,
          Object.fromEntries(Object.entries(t.params ?? {}).map(([k, p]) => [k, z.string().describe(p.description)])),
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        ),
      );
      opts.mcpServers[name] = createSdkMcpServer({
        name,
        version: def.version,
        ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
        tools,
      });
    }
  }
  return opts;
}

/** Replace the per-run temp dir so fixtures are stable. */
function norm(value, tmp) {
  if (typeof value === "string") return value.split(tmp).join("$TMP");
  if (Array.isArray(value)) return value.map((v) => norm(v, tmp));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v, tmp)]));
  }
  return value;
}

async function record(name, spec, fake) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "golden-wire-")));
  const cwd = join(tmp, "proj");
  mkdirSync(cwd);
  const files = { argv: join(tmp, "argv.json"), env: join(tmp, "env.json"), log: join(tmp, "stdin.log") };
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* prompt() {
    yield {
      type: "user",
      message: { role: "user", content: "hello" },
      parent_tool_use_id: null,
      session_id: "",
    };
    await done; // keep stdin open until the turn's result arrives
  }
  const q = query({ prompt: prompt(), options: buildOptions(spec, fake, cwd, files) });
  try {
    for await (const msg of q) {
      if (msg.type === "result") break;
    }
  } finally {
    finish();
    q.close?.();
  }
  const argv = JSON.parse(readFileSync(files.argv, "utf8"));
  const env = JSON.parse(readFileSync(files.env, "utf8"));
  for (const k of Object.keys(env)) if (k.startsWith("FAKE_CLAUDE_") || k.startsWith("__CF")) delete env[k];
  const ids = new Map();
  const stdin = readFileSync(files.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((m) => {
      if (typeof m.request_id === "string") {
        if (!ids.has(m.request_id)) ids.set(m.request_id, `$ID${ids.size}`);
        return { ...m, request_id: ids.get(m.request_id) };
      }
      if (m.type === "control_response" && typeof m.response?.request_id === "string") {
        return { ...m, response: { ...m.response, request_id: "$CLI_ID" } };
      }
      return m;
    });
  const initialize = stdin.find((m) => m.type === "control_request" && m.request?.subtype === "initialize")?.request;
  const fixture = norm({ sdkVersion, case: name, spec, baseEnv: BASE_ENV, argv, env, initialize, stdin }, tmp);
  rmSync(tmp, { recursive: true, force: true });
  const out = join(outDir, `${name}.json`);
  writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`  ${name}: ${argv.length} args, ${Object.keys(env).length} env vars, ${stdin.length} stdin lines → ${out.slice(repo.length + 1)}`);
}

const only = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const fake = fakeBin();
console.log(`golden wire fixtures from @anthropic-ai/claude-agent-sdk ${sdkVersion}:`);
for (const [name, spec] of Object.entries(CASES)) {
  if (only.length && !only.includes(name)) continue;
  await record(name, spec, fake);
}
process.exit(0);
