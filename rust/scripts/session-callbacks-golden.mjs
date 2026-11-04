#!/usr/bin/env node
// Golden fixture for the session's control-request callbacks (S27b): the
// real `canUseTool` (tool budgets, the goal tool, ExitPlanMode,
// AskUserQuestion, permission prompts), `onElicitation` and the four hooks
// `start()` registers (PreToolUse, PostToolUse, CwdChanged, PostModelSwitch),
// recorded from the TS sources:
//
//   node rust/scripts/session-callbacks-golden.mjs   (node@22: session.ts
//                                                     needs better-sqlite3,
//                                                     which bun can't load;
//                                                     builds
//                                                     claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir and a resolve hook for the extensionless /
// `@/` imports, twice (two temp roots); both recordings must agree byte for
// byte. The hook maps session.ts's SDK import to a shim that calls the real
// `query()` with one option added, `pathToClaudeCodeExecutable` (the fake
// CLI).
//
// Each case runs the real `new Session(options).start()` in its own project
// dir against the fake CLI with the case's `script` (FAKE_CLAUDE_SCRIPT, as
// written: number literals like `2.0` and `1e21` reach the CLI's stdout as
// is), a per-cwd limits file (`limits`: the file's text, or its bytes as an
// array, at `limitsPath`, or null) and the `CLAUDE_CODE_MAX_*_PER_SESSION`
// env (`env`), then sends one prompt. The script's turn fires `$control` /
// `$send` requests at the host; each prompt the session raises is answered
// with the case's next entry in `answers` through the real
// `resolvePermission` / `submitAskAnswer` / `resolvePlan` /
// `resolveElicitation` (`null` leaves it; `gate` writes that file in the cwd
// so the script's `$wait_file` moves on, e.g. to cancel it; `env` sets cap
// env vars first).
// Records:
// - `events`: every buffered event that isn't an `sdk` message, once the
//   turn's `result` is in and the fire-and-forget writes are done;
// - `live`: every non-`sdk` event a subscriber that joined right after
//   `start()` got, unbuffered ones (`prompt_settled`) included;
// - `late`: for each prompt, the prompt events a subscriber that joins while
//   it's pending gets (replay plus re-emit);
// - `answered`: what each resolve call returned (null when not answered);
// - `controls`: the `control_response` lines the CLI read, as written;
// - `state`: the permission mode, `getStatus()`, `hasPendingUserPrompts()`
//   and the session row's `state` text afterwards.
// Request ids read `$R0`, `$R1`, ... in order of first appearance in the
// live events; every path under the temp root reads `$ROOT` (and its
// `encodeProjectDir` form `$EROOT`); `plan_usage`'s `fetchedAt` reads 0.
//
// Written to rust/crates/claudius-core/tests/fixtures/session_callbacks_golden.json
// and replayed by crates/claudius-core/tests/session_callbacks_golden.rs.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/session_callbacks_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SESSION_CALLBACKS_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-callbacks-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          // db.ts reads its migrations from `process.cwd()/lib/server/db-migrations`.
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            NODE_OPTIONS: "--no-warnings",
            SESSION_CALLBACKS_GOLDEN_CHILD: root,
            SESSION_CALLBACKS_GOLDEN_FAKE: fake,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    writeFileSync(join(tmpdir(), "session-callbacks-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "session-callbacks-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} cases (SDK ${fixture.sdkVersion})`);
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.SESSION_CALLBACKS_GOLDEN_CHILD;
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.SESSION_CALLBACKS_GOLDEN_FAKE } });
}
`,
);

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SHIM = ${JSON.stringify(pathToFileURL(shim).href)};
export async function resolve(spec, ctx, next) {
  if (spec === ${JSON.stringify(SDK)} && ctx.parentURL && ctx.parentURL.endsWith("/lib/server/session.ts")) {
    return { url: SHIM, shortCircuit: true };
  }
  const s = spec.startsWith("@/") ? new URL(spec.slice(2), ROOT).href : spec;
  if ((s.startsWith(".") || s.startsWith("file:")) && ctx.parentURL) {
    const p = fileURLToPath(new URL(s, ctx.parentURL));
    if (!existsSync(p)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(p + ext)) return next(pathToFileURL(p + ext).href, ctx);
      }
    }
  }
  try {
    return await next(s, ctx);
  } catch (e) {
    // A bare CJS subpath without an exports map (\`next/server\`).
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !s.includes(":") && !s.startsWith(".")) return next(s + ".js", ctx);
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const { Session } = await import(join(repo, "lib/server/session.ts"));
const { encodeProjectDir } = await import(join(repo, "lib/server/auto-memory.ts"));
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

// Non-ASCII without escapes in this file.
const cp = (n) => String.fromCodePoint(n);
const LS = cp(0x2028);
const EMOJI = cp(0x1f680);
const E_ACUTE = cp(0xe9);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
async function waitFor(pred, ms) {
  for (let t = 0; t < ms; t += 10) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

// ------------------------------- the world -------------------------------

const HOME = process.env.HOME;
mkdirSync(join(HOME, ".claude", ".claudius", "limits"), { recursive: true });
// No feedback nudge (its roll is random).
writeFileSync(join(HOME, ".claude", "settings.json"), `${JSON.stringify({ feedbackSurveyRate: 0 }, null, 2)}\n`);
const CAP_ENV = ["CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION", "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"];

// -------------------------------- steps ---------------------------------

// `#num:<literal>` strings are written into the script as bare number
// literals, so the CLI prints them as written (`2.0`, `1e21`, `-0.0`).
const N = (literal) => `#num:${literal}`;
const scriptText = (steps) =>
  JSON.stringify({ turns: [{ steps, result: "done" }] }).replace(/"#num:([^"]*)"/g, "$1");

const can = (tool, input, extra = {}) => ({
  $control: { subtype: "can_use_tool", tool_name: tool, ...(input === undefined ? {} : { input }), ...extra },
});
const canRaw = (fields) => ({ $control: { subtype: "can_use_tool", ...fields } });
const sendCan = (tool, input, extra = {}) => ({ $send: { subtype: "can_use_tool", tool_name: tool, input, ...extra } });
const elicit = (fields) => ({ $control: { subtype: "elicitation", ...fields } });
const sendElicit = (fields) => ({ $send: { subtype: "elicitation", ...fields } });
const hookStep = (event, input, extra = {}) => ({
  $control: { subtype: "hook_callback", callback_id: `$HOOK:${event}`, ...(input === undefined ? {} : { input }), ...extra },
});
// Waits for the recorder to open `gate`, then cancels `cli_1_s<i>` (the
// `$send` at step i) and collects the replies.
const cancelAfter = (gate, i) => [
  { $wait_file: gate },
  { type: "control_cancel_request", request_id: `cli_1_s${i}` },
  { $collect_ms: 1500 },
];

const ALLOW = { perm: { kind: "allow_once" } };
const DENY = { perm: { kind: "deny" } };
const ws = (n) => Array.from({ length: n }, () => can("WebSearch", { query: "q" }, { tool_use_id: "tu_ws" }));
const allows = (n) => Array.from({ length: n }, () => ALLOW);

const QUESTION = (extra = {}) => ({
  question: "Which color?",
  header: "Color",
  options: [
    { label: "Red", description: "warm" },
    { label: "Blue", description: "cool", preview: "<b>blue</b>" },
  ],
  multiSelect: false,
  ...extra,
});
const PLAN = `# Plan ${EMOJI}\n1. Edit the file\n2. Run the tests\n`;
const RULE_SUGGESTIONS = [
  { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "git status:*" }], destination: "localSettings" },
  { type: "setMode", mode: "acceptEdits", destination: "session" },
  { type: "addRules", behavior: "deny", rules: [{ toolName: "Bash", ruleContent: "rm:*" }], destination: "session" },
  { type: "addRules", behavior: "allow", rules: [], destination: "session" },
  { type: "addRules", behavior: "allow", rules: [{ toolName: "Read" }, { toolName: "Bash", ruleContent: "ls:*" }], destination: "userSettings" },
];
const WT = (rest) => `/work/repo/.claude/worktrees/${rest}`;

// [name, {options, env, limits, steps, answers}]
const CASES = [
  // ---- the goal tool ----
  ["goal tool is allowed untouched", { steps: [can("mcp__claudius_goal__report_goal_achieved", { summary: "done", n: N("2.0") }, { tool_use_id: "tu_g" })] }],
  ["goal tool without tool_use_id", { steps: [can("mcp__claudius_goal__other", { a: [1, N("1e21")] })] }],

  // ---- tool budgets: the per-cwd limits ----
  ["web search cap 2", { limits: { limits: { maxWebSearches: 2 } }, steps: ws(3), answers: allows(2) }],
  ["web search cap 2.5", { limits: { limits: { maxWebSearches: 2.5 } }, steps: ws(4), answers: allows(3) }],
  ["web search cap 1", { limits: { limits: { maxWebSearches: 1 } }, steps: ws(3), answers: allows(1) }],
  ["denied prompts still count", { limits: { limits: { maxWebSearches: 2 } }, steps: ws(3), answers: [DENY, DENY] }],
  ["web search cap 0 disables", { limits: { limits: { maxWebSearches: 0 } }, steps: ws(2), answers: allows(2) }],
  ["web search cap negative", { limits: { limits: { maxWebSearches: -1 } }, steps: ws(2), answers: allows(2) }],
  ["web search cap huge", { limits: '{"limits":{"maxWebSearches":1e21}}', steps: ws(1), answers: allows(1) }],
  ["web search cap tiny", { limits: { limits: { maxWebSearches: 0.25 } }, steps: ws(2), answers: allows(1) }],
  ["web search cap 1e-7", { limits: '{"limits":{"maxWebSearches":1e-7}}', steps: ws(2), answers: allows(1) }],
  ["web search cap as text", { limits: '{"limits":{"maxWebSearches":2.0}}', steps: ws(3), answers: allows(2) }],
  [
    "subagent cap counts Task and Agent",
    {
      limits: { limits: { maxSubagents: 2, maxWebSearches: 1 } },
      steps: [can("Task", { prompt: "a" }), can("Agent", { prompt: "b" }), can("WebSearch", { query: "q" }), can("Agent", { prompt: "c" }), can("Task", { prompt: "d" })],
      answers: allows(3),
    },
  ],
  ["other tools are never capped", { limits: { limits: { maxWebSearches: 1 } }, steps: [can("websearch", { q: 1 }), can("WebFetch", { url: "u" }), can("Tasks", {})], answers: allows(3) }],
  // ---- tool budgets: the env fallback ----
  ["env 0b10", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "0b10" }, steps: ws(3), answers: allows(2) }],
  ["env 0x2", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "0x2" }, steps: ws(3), answers: allows(2) }],
  ["env 0o1", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "0o1" }, steps: ws(2), answers: allows(1) }],
  ["env padded", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: " \t2\n" }, steps: ws(3), answers: allows(2) }],
  ["env 2.0", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "2.0" }, steps: ws(3), answers: allows(2) }],
  ["env 1e0", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1e0" }, steps: ws(2), answers: allows(1) }],
  ["env +1", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "+1" }, steps: ws(2), answers: allows(1) }],
  ["env .1e1", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: ".1e1" }, steps: ws(2), answers: allows(1) }],
  ["env 1.5 is no cap", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1.5" }, steps: ws(3), answers: allows(3) }],
  ["env empty is no cap", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "" }, steps: ws(2), answers: allows(2) }],
  ["env 0 is no cap", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "0" }, steps: ws(2), answers: allows(2) }],
  ["env -1 is no cap", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "-1" }, steps: ws(2), answers: allows(2) }],
  ["env Infinity is no cap", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "Infinity" }, steps: ws(2), answers: allows(2) }],
  ["env 0x is no cap", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "0x" }, steps: ws(2), answers: allows(2) }],
  ["env 1_0 is no cap", { env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1_0" }, steps: ws(2), answers: allows(2) }],
  ["env subagents", { env: { CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: "0B1" }, steps: [can("Agent", {}), can("Task", {}), can("WebSearch", {})], answers: allows(2) }],
  [
    "a denied call is not counted",
    {
      env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1" },
      steps: [can("WebSearch", { query: "a" }), can("WebSearch", { query: "b" }), can("Bash", { command: "ls" }), can("WebSearch", { query: "c" })],
      answers: [ALLOW, { ...ALLOW, env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "2" } }, ALLOW],
    },
  ],
  ["limits win over env", { limits: { limits: { maxWebSearches: 1 } }, env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "3" }, steps: ws(2), answers: allows(1) }],
  ["limits 0 falls back to env", { limits: { limits: { maxWebSearches: 0 } }, env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1" }, steps: ws(2), answers: allows(1) }],
  ["limits string falls back to env", { limits: { limits: { maxWebSearches: "3" } }, env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1" }, steps: ws(2), answers: allows(1) }],
  ["limits true falls back to env", { limits: { limits: { maxWebSearches: true } }, env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1" }, steps: ws(2), answers: allows(1) }],
  ["limits malformed falls back to env", { limits: '{"limits":', env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1" }, steps: ws(2), answers: allows(1) }],
  ["limits null falls back to env", { limits: "null", env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1" }, steps: ws(2), answers: allows(1) }],
  ["limits 1e400 is an endless cap", { limits: '{"limits":{"maxWebSearches":1e400}}', env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1" }, steps: ws(2), answers: allows(2) }],
  ["limits with a lone surrogate", { limits: '{"n":"\\ud800","limits":{"maxWebSearches":1}}', env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "2" }, steps: ws(2), answers: allows(1) }],
  [
    "limits with invalid UTF-8",
    {
      limits: Buffer.concat([Buffer.from('{"n":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","limits":{"maxWebSearches":1}}')]),
      env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "2" },
      steps: ws(2),
      answers: allows(1),
    },
  ],
  ["limits with duplicate keys", { limits: '{"limits":{"maxWebSearches":3,"maxWebSearches":1}}', steps: ws(2), answers: allows(1) }],
  ["limits array falls back to env", { limits: '{"limits":[3]}', env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1" }, steps: ws(2), answers: allows(1) }],

  // ---- ExitPlanMode ----
  [
    "plan accepted",
    { options: { permissionMode: "plan" }, steps: [can("ExitPlanMode", { plan: PLAN, allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] }, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "accept" } }] },
  ],
  [
    "plan accepted with an edit",
    { options: { permissionMode: "plan" }, steps: [can("ExitPlanMode", { plan: PLAN, x: 1 }, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "accept", editedPlan: "  # Edited\n1. Only this  " } }] },
  ],
  ["plan accepted, edit equal once trimmed", { steps: [can("ExitPlanMode", { plan: PLAN }, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "accept", editedPlan: `\n${PLAN}  ` } }] }],
  ["plan accepted, blank edit", { steps: [can("ExitPlanMode", { plan: PLAN }, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "accept", editedPlan: " \n " } }] }],
  ["plan rejected with feedback", { steps: [can("ExitPlanMode", { plan: PLAN }, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "reject", message: "More detail please" } }] }],
  ["plan rejected", { steps: [can("ExitPlanMode", { plan: "" }, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "reject" } }] }],
  [
    "plan not a string: JSON text",
    {
      steps: [
        can(
          "ExitPlanMode",
          { b: 1, plan: { steps: ["a", "b"], n: N("2.0") }, "10": "ten", "2": "two", big: N("1e21"), small: N("1e-7"), neg0: N("-0.0"), frac: N("0.1"), e: N("1E3"), s: `caf${E_ACUTE} ${EMOJI}`, nested: { "1": [], z: {} } },
          { tool_use_id: "tu_p" },
        ),
      ],
      answers: [{ plan: { kind: "accept" } }],
    },
  ],
  ["plan missing", { steps: [can("ExitPlanMode", { allowedPrompts: [] }, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "reject" } }] }],
  ["plan input empty", { steps: [can("ExitPlanMode", {}, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "accept" } }] }],
  ["plan null", { steps: [can("ExitPlanMode", { plan: null }, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "accept", editedPlan: "new" } }] }],
  ["plan input an array", { steps: [can("ExitPlanMode", [1, N("2.50"), "x"], { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "accept" } }] }],
  ["plan input a string", { steps: [can("ExitPlanMode", "just text", { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "accept", editedPlan: "edited" } }] }],
  ["plan without tool_use_id", { steps: [can("ExitPlanMode", { plan: PLAN })], answers: [{ plan: { kind: "accept" } }] }],
  ["plan with a null tool_use_id", { steps: [can("ExitPlanMode", { plan: PLAN }, { tool_use_id: null })], answers: [{ plan: { kind: "reject" } }] }],
  ["plan with a numeric tool_use_id", { steps: [can("ExitPlanMode", { plan: PLAN }, { tool_use_id: 7 })], answers: [{ plan: { kind: "accept" } }] }],
  ["plan aborted", { steps: [sendCan("ExitPlanMode", { plan: PLAN }, { tool_use_id: "tu_p" }), ...cancelAfter("gate", 0)], answers: [{ gate: "gate" }] }],
  ["plan answered twice", { steps: [can("ExitPlanMode", { plan: PLAN }, { tool_use_id: "tu_p" })], answers: [{ plan: { kind: "accept" }, again: true }] }],

  // ---- AskUserQuestion ----
  ["ask single select", { steps: [can("AskUserQuestion", { questions: [QUESTION()] }, { tool_use_id: "tu_a" })], answers: [{ ask: [{ label: "Blue" }] }] }],
  ["ask single select without a preview", { steps: [can("AskUserQuestion", { questions: [QUESTION()] }, { tool_use_id: "tu_a" })], answers: [{ ask: [{ label: "Red" }] }] }],
  ["ask other path", { steps: [can("AskUserQuestion", { questions: [QUESTION()] }, { tool_use_id: "tu_a" })], answers: [{ ask: [{ label: null, custom: "  Green  " }] }] }],
  [
    "ask multi select",
    { steps: [can("AskUserQuestion", { questions: [QUESTION({ multiSelect: true })] }, { tool_use_id: "tu_a" })], answers: [{ ask: [{ selected: ["Red", "Blue"], custom: " Teal " }] }] },
  ],
  [
    "ask two questions",
    {
      steps: [can("AskUserQuestion", { questions: [QUESTION(), QUESTION({ question: "Which size?", header: "Size", multiSelect: true })] }, { tool_use_id: "tu_a" })],
      answers: [{ ask: [{ label: "Blue" }, { selected: [] }] }],
    },
  ],
  ["ask cancelled", { steps: [can("AskUserQuestion", { questions: [QUESTION()] }, { tool_use_id: "tu_a" })], answers: [{ ask: [] }] }],
  ["ask answered blank", { steps: [can("AskUserQuestion", { questions: [QUESTION()] }, { tool_use_id: "tu_a" })], answers: [{ ask: [{ label: "", custom: "   " }] }] }],
  [
    "ask odd question fields",
    {
      steps: [
        can(
          "AskUserQuestion",
          {
            questions: [
              null,
              "q",
              { question: 5, options: [{ label: "a" }, { label: "b" }] },
              { question: "Only one option?", options: [{ label: "a" }, { label: "" }, { label: 3 }] },
              {
                question: "Odd options",
                header: 7,
                multiSelect: "true",
                options: [null, { label: "x", description: 5, preview: 9 }, { label: "y", preview: "" }, "z", { label: "w", extra: 1 }],
              },
            ],
          },
          { tool_use_id: "tu_a" },
        ),
      ],
      answers: [{ ask: [{ label: "y" }] }],
    },
  ],
  ["ask malformed falls through", { steps: [can("AskUserQuestion", { questions: [{ question: "Q", options: [{ label: "only" }] }] }, { tool_use_id: "tu_a" })], answers: [DENY] }],
  ["ask questions not an array", { steps: [can("AskUserQuestion", { questions: "nope" }, { tool_use_id: "tu_a" })], answers: [ALLOW] }],
  ["ask without tool_use_id", { steps: [can("AskUserQuestion", { questions: [QUESTION()] })], answers: [{ ask: [{ label: "Red" }] }] }],
  ["ask aborted", { steps: [sendCan("AskUserQuestion", { questions: [QUESTION()] }, { tool_use_id: "tu_a" }), ...cancelAfter("gate", 0)], answers: [{ gate: "gate" }] }],

  // ---- permission prompts ----
  [
    "permission with every context field",
    {
      steps: [
        canRaw({
          tool_name: "mcp__srv__write",
          input: { path: "/tmp/x", n: N("1.50") },
          tool_use_id: "tu_1",
          title: "Write a file",
          description: "Writes /tmp/x",
          display_name: "Write",
          agent_id: "agent-7",
          default_to_no: true,
          suppress_always_allow_rule: false,
          mcp_server: { name: "srv", source: "plugin", extra: 1 },
          decision_reason: "asked",
          blocked_path: "/tmp",
          plugin: "p",
        }),
      ],
      answers: [ALLOW],
    },
  ],
  ["permission denied with a message", { steps: [can("Bash", { command: "rm -rf /" }, { tool_use_id: "tu_1" })], answers: [{ perm: { kind: "deny", message: "Not that" } }] }],
  ["permission denied", { steps: [can("Bash", { command: "ls" }, { tool_use_id: "tu_1" })], answers: [DENY] }],
  [
    "allow always for the session, narrow rules",
    { steps: [can("Bash", { command: "git status" }, { tool_use_id: "tu_1", permission_suggestions: RULE_SUGGESTIONS })], answers: [{ perm: { kind: "allow_always_session" } }] },
  ],
  [
    "allow always saved, narrow rules",
    { steps: [can("Bash", { command: "git status" }, { tool_use_id: "tu_1", permission_suggestions: RULE_SUGGESTIONS })], answers: [{ perm: { kind: "allow_always_save", destination: "projectSettings" } }] },
  ],
  ["allow always saved, whole tool", { steps: [can("Bash", { command: "ls" }, { tool_use_id: "tu_1" })], answers: [{ perm: { kind: "allow_always_save", destination: "userSettings" } }] }],
  [
    "allow always, only other suggestions",
    {
      steps: [can("Edit", { file_path: "/x" }, { tool_use_id: "tu_1", permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] })],
      answers: [{ perm: { kind: "allow_always_session" } }],
    },
  ],
  [
    "suggested rules with odd fields",
    {
      steps: [
        can(
          "Bash",
          { command: "x" },
          {
            tool_use_id: "tu_1",
            permission_suggestions: [
              {
                type: "addRules",
                behavior: "allow",
                rules: [
                  { ruleContent: "no tool name" },
                  { toolName: null },
                  { toolName: "Bash", ruleContent: 5 },
                  { toolName: "Bash", ruleContent: "" },
                  { toolName: "Bash", ruleContent: 0 },
                  { toolName: "Bash", ruleContent: { a: 1 } },
                  { toolName: "Bash", ruleContent: true },
                  { toolName: "Bash", ruleContent: false },
                  { toolName: "Bash", ruleContent: null },
                  { toolName: 5, ruleContent: ["x"] },
                  "Bash",
                  7,
                  [],
                ],
                destination: "session",
              },
            ],
          },
        ),
      ],
      answers: [{ perm: { kind: "allow_always_session" } }],
    },
  ],
  ["permission without tool_use_id", { steps: [can("Bash", { command: "ls" })], answers: [ALLOW] }],
  ["permission with a null tool_use_id", { steps: [can("Bash", { command: "ls" }, { tool_use_id: null })], answers: [ALLOW] }],
  ["permission with a numeric tool_use_id", { steps: [can("Bash", { command: "ls" }, { tool_use_id: 42 })], answers: [DENY] }],
  [
    "permission with odd context types",
    {
      steps: [
        canRaw({
          tool_name: "Bash",
          input: { command: "ls" },
          tool_use_id: "tu_1",
          title: 5,
          description: false,
          display_name: { x: 1 },
          agent_id: 3,
          default_to_no: "yes",
          suppress_always_allow_rule: 1,
          mcp_server: "srv",
        }),
      ],
      answers: [ALLOW],
    },
  ],
  [
    "permission with null context fields",
    {
      steps: [
        canRaw({
          tool_name: "Bash",
          input: { command: "ls" },
          tool_use_id: "tu_1",
          title: null,
          description: null,
          display_name: null,
          agent_id: null,
          default_to_no: null,
          suppress_always_allow_rule: null,
          mcp_server: null,
          permission_suggestions: null,
        }),
      ],
      answers: [ALLOW],
    },
  ],
  ["permission input a string", { steps: [can("Bash", "ls -la", { tool_use_id: "tu_1" })], answers: [ALLOW] }],
  ["permission input an array", { steps: [can("Bash", ["ls"], { tool_use_id: "tu_1" })], answers: [ALLOW] }],
  ["permission input null", { steps: [can("Bash", null, { tool_use_id: "tu_1" })], answers: [ALLOW] }],
  ["permission input missing", { steps: [can("Bash", undefined, { tool_use_id: "tu_1" })], answers: [ALLOW] }],
  [
    "permission input numbers and keys",
    { steps: [can("Bash", { z: N("2.0"), "10": N("1e21"), "2": N("-0.0"), a: [N("1.0"), N("5e-7")] }, { tool_use_id: "tu_1" })], answers: [ALLOW] },
  ],
  ["permission aborted", { steps: [sendCan("Bash", { command: "sleep 9" }, { tool_use_id: "tu_1" }), ...cancelAfter("gate", 0)], answers: [{ gate: "gate" }] }],
  [
    "two prompts at once",
    {
      steps: [
        sendCan("Bash", { command: "a" }, { tool_use_id: "tu_1" }),
        sendCan("Read", { file_path: "/b" }, { tool_use_id: "tu_2" }),
        { $wait_file: "gate" },
        { $collect_ms: 3000 },
      ],
      answers: [null, { gate: "gate" }],
      // Then both are answered, the second first.
      after: [{ index: 1, perm: { kind: "deny", message: "no" } }, { index: 0, perm: { kind: "allow_once" } }],
    },
  ],
  [
    "four prompts at once keep their order",
    {
      steps: [
        sendCan("Bash", { command: "a" }, { tool_use_id: "tu_1" }),
        sendCan("Read", { file_path: "/b" }, { tool_use_id: "tu_2" }),
        sendCan("Grep", { pattern: "c" }, { tool_use_id: "tu_3" }),
        sendCan("Glob", { pattern: "d" }, { tool_use_id: "tu_4" }),
        { $wait_file: "gate" },
        { $collect_ms: 3000 },
      ],
      answers: [null, null, null, { gate: "gate" }],
      after: [0, 1, 2, 3].map((index) => ({ index, perm: { kind: "allow_once" } })),
    },
  ],
  ["permission answered twice", { steps: [can("Bash", { command: "ls" }, { tool_use_id: "tu_1" })], answers: [{ ...ALLOW, again: true }] }],

  // ---- elicitation ----
  [
    "elicitation form",
    {
      steps: [
        elicit({
          mcp_server_name: "srv",
          message: "Fill this in",
          mode: "form",
          url: "",
          elicitation_id: "el-1",
          requested_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          title: "Sign up",
          display_name: "Signup",
          description: "Needs your name",
        }),
      ],
      answers: [{ elicit: { action: "accept", content: { name: "Ada", n: 2, ok: true, tags: ["a"] } } }],
    },
  ],
  ["elicitation url", { steps: [elicit({ mcp_server_name: "srv", message: "Sign in", mode: "url", url: "https://example.com/auth", elicitation_id: "el-2" })], answers: [{ elicit: { action: "decline" } }] }],
  ["elicitation cancelled by the user", { steps: [elicit({ mcp_server_name: "srv", message: "m" })], answers: [{ elicit: { action: "cancel" } }] }],
  ["elicitation accepted without content", { steps: [elicit({ mcp_server_name: "srv", message: "m", mode: "form" })], answers: [{ elicit: { action: "accept" } }] }],
  ["elicitation schema 0", { steps: [elicit({ mcp_server_name: "srv", message: "m", requested_schema: 0, elicitation_id: "e" })], answers: [{ elicit: { action: "decline" } }] }],
  ["elicitation schema empty string", { steps: [elicit({ mcp_server_name: "srv", message: "m", requested_schema: "", elicitation_id: "e" })], answers: [{ elicit: { action: "decline" } }] }],
  ["elicitation schema false", { steps: [elicit({ mcp_server_name: "srv", message: "m", requested_schema: false, elicitation_id: "e" })], answers: [{ elicit: { action: "decline" } }] }],
  ["elicitation schema null", { steps: [elicit({ mcp_server_name: "srv", message: "m", requested_schema: null, elicitation_id: "e" })], answers: [{ elicit: { action: "decline" } }] }],
  ["elicitation schema true", { steps: [elicit({ mcp_server_name: "srv", message: "m", requested_schema: true, title: "t" })], answers: [{ elicit: { action: "decline" } }] }],
  ["elicitation schema an empty array", { steps: [elicit({ mcp_server_name: "srv", message: "m", requested_schema: [], title: "t" })], answers: [{ elicit: { action: "decline" } }] }],
  ["elicitation schema a number", { steps: [elicit({ mcp_server_name: "srv", message: "m", requested_schema: N("2.0"), description: "d" })], answers: [{ elicit: { action: "decline" } }] }],
  [
    "elicitation odd types",
    {
      steps: [elicit({ mcp_server_name: 5, message: { a: 1 }, mode: 5, url: 7, elicitation_id: true, requested_schema: "s", title: 1, display_name: [], description: {} })],
      answers: [{ elicit: { action: "decline" } }],
    },
  ],
  [
    "elicitation falsy optional fields",
    { steps: [elicit({ mcp_server_name: "", message: "", mode: "", url: 0, elicitation_id: false, title: null, display_name: "", description: 0 })], answers: [{ elicit: { action: "cancel" } }] },
  ],
  ["elicitation with only a subtype", { steps: [elicit({})], answers: [{ elicit: { action: "decline" } }] }],
  ["elicitation url mode upper case", { steps: [elicit({ mcp_server_name: "srv", message: "m", mode: "URL", url: "https://x" })], answers: [{ elicit: { action: "decline" } }] }],
  ["elicitation aborted", { steps: [sendElicit({ mcp_server_name: "srv", message: "m" }), ...cancelAfter("gate", 0)], answers: [{ gate: "gate" }] }],
  ["elicitation answered twice", { steps: [elicit({ mcp_server_name: "srv", message: "m" })], answers: [{ elicit: { action: "decline" }, again: true }] }],

  // ---- hooks ----
  [
    "pre tool use: an edit in a worktree",
    {
      steps: [
        hookStep("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: WT("feat/src/a.ts") } }, { tool_use_id: "tu_h" }),
        hookStep("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: WT("feat/b.ts") } }),
        hookStep("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "MultiEdit", tool_input: { file_path: WT("other") } }),
      ],
    },
  ],
  [
    "pre tool use: null file_path falls through to notebook_path",
    { steps: [hookStep("PreToolUse", { tool_name: "NotebookEdit", tool_input: { file_path: null, notebook_path: WT("nb/x.ipynb") } })] },
  ],
  ["pre tool use: missing file_path falls through", { steps: [hookStep("PreToolUse", { tool_name: "NotebookEdit", tool_input: { notebook_path: WT("nb2/x.ipynb") } })] }],
  [
    "pre tool use: a non-string file_path stops there",
    { steps: [hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: 5, notebook_path: WT("nb/x.ipynb") } }), hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "", notebook_path: WT("nb3/y") } })] },
  ],
  [
    "pre tool use: not a mutating tool",
    { steps: [hookStep("PreToolUse", { tool_name: "Read", tool_input: { file_path: WT("r/x") } }), hookStep("PreToolUse", { tool_name: 5, tool_input: { file_path: WT("r/x") } })] },
  ],
  [
    "pre tool use: odd tool_input",
    {
      steps: [
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: null }),
        hookStep("PreToolUse", { tool_name: "Edit" }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: "str" }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: [WT("arr/x")] }),
        hookStep("PreToolUse", {}),
      ],
    },
  ],
  [
    "pre tool use: worktree path shapes",
    {
      steps: [
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/a/.claude/worktrees/x/.claude/worktrees/y/z.ts" } }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/a/.claude/worktrees/" } }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "relative/.claude/worktrees/rel" } }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: `/l${LS}s/.claude/worktrees/ls/f` } }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/c\r/.claude/worktrees/cr/f" } }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/n/.claude/worktrees/a\nb/f" } }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: `/u/.claude/worktrees/${EMOJI}${E_ACUTE}` } }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/q/.claude/worktreesX/q/f" } }),
      ],
    },
  ],
  [
    "cwd changed",
    {
      steps: [
        hookStep("CwdChanged", { hook_event_name: "CwdChanged", old_cwd: "/a", new_cwd: "/b" }),
        hookStep("CwdChanged", { new_cwd: "/b" }),
        hookStep("CwdChanged", { new_cwd: "" }),
        hookStep("CwdChanged", { new_cwd: 5 }),
        hookStep("CwdChanged", { new_cwd: null }),
        hookStep("CwdChanged", {}),
        hookStep("CwdChanged", { new_cwd: WT("feat") }),
        hookStep("PreToolUse", { tool_name: "Edit", tool_input: { file_path: WT("feat/x") } }),
        hookStep("CwdChanged", { new_cwd: "/b" }),
      ],
    },
  ],
  [
    "post tool use",
    {
      steps: [
        hookStep("PostToolUse", { tool_name: "Write", tool_input: { file_path: "/nonexistent/x" }, tool_response: {} }),
        hookStep("PostToolUse", { tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }),
        hookStep("PostToolUse", { tool_name: "Edit", tool_input: null }),
        hookStep("PostToolUse", {}),
      ],
    },
  ],
  [
    "post model switch",
    {
      steps: [
        hookStep("PostModelSwitch", { source: "command", to_model: "claude-a" }),
        hookStep("PostModelSwitch", { source: "auto", to_model: "claude-b", from_model: "claude-b" }),
        hookStep("PostModelSwitch", { source: "auto", to_model: "" }),
        hookStep("PostModelSwitch", { source: "auto", to_model: "claude-c", from_model: "claude-a" }),
        hookStep("PostModelSwitch", { source: "auto", to_model: "claude-c" }),
        hookStep("PostModelSwitch", { source: "picker", to_model: "claude-d" }),
      ],
    },
  ],
  ["hook callback with an unknown id", { steps: [{ $control: { subtype: "hook_callback", callback_id: "hook_99", input: {} } }] }],

  // ---- shapes the CLI never sends: TS throws inside the callback ----
  ["plan input null", { steps: [can("ExitPlanMode", null, { tool_use_id: "tu_p" })] }],
  ["plan input missing", { steps: [can("ExitPlanMode", undefined, { tool_use_id: "tu_p" })] }],
  ["ask input null", { steps: [can("AskUserQuestion", null, { tool_use_id: "tu_a" })], answers: [ALLOW] }],
  ["tool name a number", { steps: [canRaw({ tool_name: 5, input: {}, tool_use_id: "tu_1" })] }],
  ["tool name missing", { steps: [canRaw({ input: {}, tool_use_id: "tu_1" })] }],
  ["suggestions an object", { steps: [can("Bash", { command: "ls" }, { tool_use_id: "tu_1", permission_suggestions: { type: "addRules" } })] }],
  ["suggestions a string", { steps: [can("Bash", { command: "ls" }, { tool_use_id: "tu_1", permission_suggestions: "addRules" })] }],
  ["suggestions holding null", { steps: [can("Bash", { command: "ls" }, { tool_use_id: "tu_1", permission_suggestions: [null] })] }],
  [
    "suggested rules holding null",
    { steps: [can("Bash", { command: "ls" }, { tool_use_id: "tu_1", permission_suggestions: [{ type: "addRules", behavior: "allow", rules: [null], destination: "session" }] })] },
  ],
  [
    "budget counted before a throw",
    { limits: { limits: { maxWebSearches: 1 } }, steps: [canRaw({ tool_name: "WebSearch", input: {}, permission_suggestions: 5 }), can("WebSearch", {}, { tool_use_id: "tu_2" })] },
  ],
  [
    "hook input missing or null",
    {
      steps: [
        hookStep("PreToolUse", undefined),
        hookStep("PreToolUse", null),
        hookStep("PostToolUse", undefined),
        hookStep("PostToolUse", null),
        hookStep("CwdChanged", undefined),
        hookStep("CwdChanged", null),
        hookStep("PostModelSwitch", undefined),
        hookStep("PostModelSwitch", null),
      ],
    },
  ],
  ["post model switch to a non-string model", { steps: [hookStep("PostModelSwitch", { source: "sdk", to_model: 5 })] }],

  // ---- a turn with everything ----
  [
    "mixed turn",
    {
      options: { permissionMode: "plan" },
      limits: { limits: { maxWebSearches: 1 } },
      steps: [
        hookStep("PreToolUse", { tool_name: "WebSearch", tool_input: { query: "q" } }),
        can("WebSearch", { query: "q" }, { tool_use_id: "tu_1" }),
        can("WebSearch", { query: "q" }, { tool_use_id: "tu_2" }),
        can("AskUserQuestion", { questions: [QUESTION()] }, { tool_use_id: "tu_3" }),
        elicit({ mcp_server_name: "srv", message: "m", requested_schema: { type: "object" } }),
        can("ExitPlanMode", { plan: PLAN }, { tool_use_id: "tu_4" }),
        hookStep("PreToolUse", { tool_name: "Write", tool_input: { file_path: WT("mixed/x") } }),
      ],
      answers: [ALLOW, { ask: [{ label: "Red" }] }, { elicit: { action: "accept", content: {} } }, { plan: { kind: "accept" } }],
    },
  ],
];

// ------------------------------- recording ------------------------------

const PROMPT_TYPES = new Set(["permission_request", "ask_user_question", "plan_approval_request", "mcp_elicitation_request"]);

/** `$R<n>` for each request id, in order of first appearance in `events`. */
function idMap(events) {
  const ids = [];
  for (const e of events) {
    if (typeof e.requestId === "string" && !ids.includes(e.requestId)) ids.push(e.requestId);
  }
  return ids;
}
const ENCODED_ROOT = encodeProjectDir(ROOT_DIR);
function normalize(value, ids) {
  let text = JSON.stringify(value).split(ROOT_DIR).join("$ROOT").split(ENCODED_ROOT).join("$EROOT");
  ids.forEach((id, i) => {
    text = text.split(id).join(`$R${i}`);
  });
  return JSON.parse(text);
}

async function answer(s, ev, a) {
  if (a === null || a === undefined) return null;
  if (a.perm) return s.resolvePermission(ev.requestId, a.perm);
  if (a.ask) return s.submitAskAnswer(ev.requestId, a.ask);
  if (a.plan) return await s.resolvePlan(ev.requestId, a.plan);
  if (a.elicit) return s.resolveElicitation(ev.requestId, a.elicit);
  return null;
}

// `plan_usage` stamps the time it was read.
const unstamp = (events) => events.map((e) => (e.type === "plan_usage" && typeof e.fetchedAt === "number" ? { ...e, fetchedAt: 0 } : e));

const cases = [];
for (const [i, [name, spec]] of CASES.entries()) {
  const id = `s27b-case-${i}`;
  const cwd = join(ROOT_DIR, "cases", String(i));
  mkdirSync(cwd, { recursive: true });
  const dir = join(ROOT_DIR, "io", String(i));
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "stdin.log");
  const script = scriptText(spec.steps);
  const limitsPath = join(HOME, ".claude", ".claudius", "limits", `${encodeProjectDir(cwd)}.json`);
  // Text, or the file's bytes (a Buffer, recorded as a byte array).
  const limits =
    spec.limits === undefined
      ? null
      : typeof spec.limits === "string"
        ? spec.limits
        : Buffer.isBuffer(spec.limits)
          ? [...spec.limits]
          : JSON.stringify(spec.limits);
  if (limits !== null) writeFileSync(limitsPath, Array.isArray(limits) ? Buffer.from(limits) : limits);
  for (const k of CAP_ENV) delete process.env[k];
  for (const [k, v] of Object.entries(spec.env ?? {})) process.env[k] = v;
  process.env.FAKE_CLAUDE_SCRIPT = script;
  process.env.FAKE_CLAUDE_LOG = log;

  const s = new Session({ id, cwd, ...(spec.options ?? {}) });
  await s.start();
  const live = [];
  s.subscribe((e) => {
    if (e.type !== "sdk") live.push(e);
  });
  const initialized = () => (readText(log) ?? "").includes('"subtype":"initialize"');
  if (!(await waitFor(initialized, 10_000))) throw new Error(`${name}: no initialize`);
  // The init's `get_settings` reply lands on its own; let it in first.
  if (!(await waitFor(() => live.some((e) => e.type === "effort_applied"), 10_000))) throw new Error(`${name}: no effort_applied`);
  s.sendInput("go");

  const prompts = () => s.buffer.filter((e) => PROMPT_TYPES.has(e.type));
  const resultIn = () => s.buffer.some((e) => e.type === "sdk" && e.message?.type === "result");
  const answers = spec.answers ?? [];
  const late = [];
  const answered = [];
  for (let k = 0; ; k++) {
    if (!(await waitFor(() => prompts().length > k || resultIn(), 15_000))) throw new Error(`${name}: stuck after ${k} prompts`);
    const ev = prompts()[k];
    if (!ev) break;
    const seen = [];
    s.subscribe((e) => {
      if (PROMPT_TYPES.has(e.type)) seen.push(e);
    })();
    late.push(seen);
    const a = answers[k] ?? null;
    if (a?.gate) writeFileSync(join(cwd, a.gate), "");
    // `env`: the cap env from here on (set before the answer frees the CLI).
    for (const [k2, v] of Object.entries(a?.env ?? {})) process.env[k2] = v;
    const got = await answer(s, ev, a);
    answered.push(a?.again ? [got, await answer(s, ev, a)] : got);
    // `after`: answers to earlier prompts, once the last listed one is in.
    if (k === answers.length - 1) {
      for (const b of spec.after ?? []) answered.push(await answer(s, prompts()[b.index], b));
    }
  }
  // `mergeSessionState` and the notification writes are fire-and-forget.
  await sleep(150);

  const events = unstamp(s.buffer.filter((e) => e.type !== "sdk"));
  const ids = idMap(live);
  const controls = (readText(log) ?? "")
    .split("\n")
    .filter((l) => l.includes('"type":"control_response"') && l.includes('"request_id":"cli_'));
  const row = (await openDb(cwd)).prepare("SELECT state FROM sessions WHERE id = ?").get(id);
  cases.push({
    name,
    id,
    options: spec.options ?? {},
    env: spec.env ?? {},
    limitsPath: limits === null ? null : normalize(limitsPath, []),
    limits,
    script,
    answers,
    after: spec.after ?? [],
    events: normalize(events, ids),
    live: normalize(unstamp(live), ids),
    late: normalize(late, ids),
    answered,
    controls,
    state: {
      permissionMode: s.permissionMode,
      status: s.getStatus(),
      pendingPrompts: s.hasPendingUserPrompts(),
      row: row?.state ?? null,
    },
  });
  await s.end();
  if (limits !== null) rmSync(limitsPath, { force: true });
}
for (const k of CAP_ENV) delete process.env[k];

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ sdkVersion, cases }));
process.exit(0);
