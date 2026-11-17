#!/usr/bin/env node
// Golden fixture for the session's notification-bus calls (S31), recorded
// from the TS sources:
//
//   node rust/scripts/session-notifications-golden.mjs   (node@22: session.ts
//                                                         needs better-sqlite3,
//                                                         which bun can't
//                                                         load; builds
//                                                         claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir, a resolve hook for the extensionless /
// `@/` imports and UV_THREADPOOL_SIZE=1 (the bus's file reads finish in the
// order they start), twice (two temp roots); both recordings must agree
// byte for byte. The hook maps session.ts's SDK import to a shim that calls
// the real `query()` with one option added, `pathToClaudeCodeExecutable`
// (the fake CLI).
//
// Each scenario runs the real `new Session({id, cwd})` against the fake CLI
// (`script`: FAKE_CLAUDE_SCRIPT) on the real notification bus and DB layer.
// workspaces.json lists one workspace per scenario (`workspace`: its
// `defaults.notifications`, or `null` for a cwd no workspace has). The
// steps drive every place session.ts calls the bus: `broadcast()`
// (recordSessionEvent with hasSubscribers / the title label /
// hasActiveBackgroundWork), consume()'s synthetic idle, markReadByRequestId
// at each prompt answer, abort and drain, markUserInput in sendInput, and
// the start-up sweep. Steps:
//   ["seed", [sql]]           SQL on the cwd's database (before start)
//   ["start", wait]           new Session(...).start(), then wait
//   ["subscribe", tab] / ["unsubscribe", tab]
//   ["send", text, wait]      sendInput(text)
//   ["answer", k, decision, wait]  the k-th prompt of the buffer, through
//                             resolvePermission / submitAskAnswer /
//                             resolvePlan / resolveElicitation
//   ["gate", name, wait]      write <cwd>/<name> (a `$wait_file` moves on)
//   ["broadcast", event]      the private broadcast(), as dev-broadcast does
//   ["rename", title]         rename(title)
//   ["mute", patch]           setSessionPrefs(cwd, id, patch)
//   ["end"]                   end()
// `wait`: "init" (the CLI's system/init is buffered), "result" / "prompt"
// (one more result / prompt event in the buffer than before the step),
// "done" (the stream ended) or "none". Then the recorder lets the bus's
// fire-and-forget work settle and records, for the step:
//   - `rows`: the scenario database's notifications rows (every column, as
//     better-sqlite3 reads them), ids as `$N<k>` and request ids as `$R<k>`
//     in order of first appearance, `created_at` / `read_at` as "$T";
//   - `envs`: the bus's `notification` events for the scenario's workspace,
//     normalized the same way;
//   - `state`: the last `state` event's `{totalUnread, perSession}` (its
//     version depends on how flushes coalesced), or null.
//
// Written to rust/crates/claudius-core/tests/fixtures/session_notifications_golden.json
// and replayed by crates/claudius-core/tests/session_notifications_golden.rs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/session_notifications_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SESSION_NOTIFY_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-notify-golden-")));
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
            UV_THREADPOOL_SIZE: "1",
            SESSION_NOTIFY_GOLDEN_CHILD: root,
            SESSION_NOTIFY_GOLDEN_FAKE: fake,
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
    writeFileSync(join(tmpdir(), "session-notify-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "session-notify-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.scenarios.reduce((n, s) => n + s.steps.length, 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.scenarios.length} scenarios, ${steps} steps (SDK ${fixture.sdkVersion})`);
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.SESSION_NOTIFY_GOLDEN_CHILD;
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.SESSION_NOTIFY_GOLDEN_FAKE } });
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
const { notificationBus } = await import(join(repo, "lib/server/notification-bus.ts"));
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const { setSessionPrefs } = await import(join(repo, "lib/server/notifications-db.ts"));
const { encodeProjectDir } = await import(join(repo, "lib/server/auto-memory.ts"));
const { default: Database } = await import("better-sqlite3");
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

// Non-ASCII without escapes in this file.
const cp = (n) => String.fromCodePoint(n);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  for (let t = 0; t < ms; t += 10) {
    if (pred()) return;
    await sleep(10);
  }
  if (!pred()) throw new Error(`timed out waiting for ${what}`);
}

// --------------------------------- steps ---------------------------------

const can = (tool, input, extra = {}) => ({ $control: { subtype: "can_use_tool", tool_name: tool, input, ...extra } });
const sendCan = (tool, input, extra = {}) => ({ $send: { subtype: "can_use_tool", tool_name: tool, input, ...extra } });
const elicit = (fields) => ({ $control: { subtype: "elicitation", ...fields } });
const sendElicit = (fields) => ({ $send: { subtype: "elicitation", ...fields } });
// Waits for `gate`, then cancels the `$send` at step 0 of turn `n`.
const cancelAfter = (gate, n) => [{ $wait_file: gate }, { type: "control_cancel_request", request_id: `cli_${n}_s0` }, { $collect_ms: 1500 }];
const task = (subtype, id, extra = {}) => ({ type: "system", subtype, task_id: id, ...extra });

const QUESTION = {
  question: "Which color?",
  header: "Color",
  options: [
    { label: "Red", description: "warm" },
    { label: "Blue", description: "cool" },
  ],
  multiSelect: false,
};
const PLAN = `# Plan ${cp(0x1f680)}\n1. Edit the file\n2. Run the tests\n`;
const ALL_KINDS = ["permission_request", "ask_user_question", "plan_approval_request", "session_idle", "session_error", "scheduled_run_finished"];

// [name, {workspace, script, steps}]: `workspace` is the workspace's
// `defaults.notifications` (`{}` for none), or null for no workspace.
const SCENARIOS = [
  [
    "an idle row per turn, toasted only while a tab watches",
    {
      steps: [
        ["start", "init"],
        ["subscribe", "a"],
        ["send", "hello", "result"],
        ["unsubscribe", "a"],
        ["send", "again", "result"],
        ["rename", `  Fix the caf${cp(0xe9)} ${cp(0x1f680)} bug  `],
        ["subscribe", "b"],
        ["send", "third", "result"],
        ["end"],
      ],
    },
  ],
  [
    "a result before any input is no idle row",
    {
      steps: [
        ["start", "init"],
        ["broadcast", { type: "sdk", message: { type: "result", subtype: "success", result: "early" } }],
        ["broadcast", { type: "sdk", message: { type: "result", parent_tool_use_id: "toolu_sub" } }],
        ["send", "hi", "result"],
        ["broadcast", { type: "sdk", message: { type: "result", subtype: "success" } }],
        ["broadcast", { type: "sdk", message: { type: "result", parent_tool_use_id: "toolu_sub" } }],
        ["end"],
      ],
    },
  ],
  [
    "permission prompts answered",
    {
      script: {
        turns: [
          { match: "go", steps: [can("Bash", { command: "ls" }, { tool_use_id: "tu_1", title: "Run ls" })], result: "ran" },
          { match: "deny", steps: [can("Write", { file_path: "/x" }, { tool_use_id: "tu_2" })], result: "denied" },
          { match: "always", steps: [can("Read", { file_path: "/y" }, { tool_use_id: "tu_3" })], result: "read" },
        ],
      },
      steps: [
        ["start", "init"],
        ["subscribe", "a"],
        ["send", "go", "prompt"],
        ["answer", 0, { perm: { kind: "allow_once" } }, "result"],
        ["send", "deny", "prompt"],
        ["answer", 1, { perm: { kind: "deny", message: "no" } }, "result"],
        ["unsubscribe", "a"],
        ["send", "always", "prompt"],
        ["answer", 2, { perm: { kind: "allow_always_session" } }, "result"],
        ["end"],
      ],
    },
  ],
  [
    "ask, plan and elicitation answered",
    {
      script: {
        turns: [
          {
            match: "go",
            steps: [
              can("AskUserQuestion", { questions: [QUESTION] }, { tool_use_id: "tu_a" }),
              can("ExitPlanMode", { plan: PLAN }, { tool_use_id: "tu_p" }),
              elicit({ mcp_server_name: "srv", message: "Fill this in\nsecond line", mode: "form", requested_schema: { type: "object", properties: {} } }),
            ],
            result: "done",
          },
          {
            match: "more",
            steps: [
              can("AskUserQuestion", { questions: [QUESTION] }, { tool_use_id: "tu_a2" }),
              can("ExitPlanMode", { plan: "  \n" }, { tool_use_id: "tu_p2" }),
              elicit({ mcp_server_name: "github", message: "  Sign in  ", mode: "url", url: "https://example.com/auth" }),
            ],
            result: "done",
          },
        ],
      },
      steps: [
        ["start", "init"],
        ["subscribe", "a"],
        ["send", "go", "prompt"],
        ["answer", 0, { ask: [{ label: "Blue" }] }, "prompt"],
        ["answer", 1, { plan: { kind: "reject", message: "More detail" } }, "prompt"],
        ["answer", 2, { elicit: { action: "accept", content: { name: "Ada" } } }, "result"],
        ["send", "more", "prompt"],
        ["answer", 3, { ask: [] }, "prompt"],
        ["answer", 4, { plan: { kind: "accept" } }, "prompt"],
        ["answer", 5, { elicit: { action: "decline" } }, "result"],
        ["end"],
      ],
    },
  ],
  [
    "prompts the CLI cancels",
    {
      script: {
        turns: [
          { match: "perm", steps: [sendCan("Bash", { command: "sleep 9" }, { tool_use_id: "tu_1" }), ...cancelAfter("g1", 1)], result: "done" },
          { match: "ask", steps: [sendCan("AskUserQuestion", { questions: [QUESTION] }, { tool_use_id: "tu_2" }), ...cancelAfter("g2", 2)], result: "done" },
          { match: "plan", steps: [sendCan("ExitPlanMode", { plan: PLAN }, { tool_use_id: "tu_3" }), ...cancelAfter("g3", 3)], result: "done" },
          { match: "elicit", steps: [sendElicit({ mcp_server_name: "srv", message: "m" }), ...cancelAfter("g4", 4)], result: "done" },
        ],
      },
      steps: [
        ["start", "init"],
        ["send", "perm", "prompt"],
        ["gate", "g1", "result"],
        ["send", "ask", "prompt"],
        ["gate", "g2", "result"],
        ["send", "plan", "prompt"],
        ["gate", "g3", "result"],
        ["send", "elicit", "prompt"],
        ["gate", "g4", "result"],
        ["end"],
      ],
    },
  ],
  [
    "open prompts drained by end",
    {
      script: {
        turns: [
          {
            match: "go",
            steps: [
              sendCan("Bash", { command: "a" }, { tool_use_id: "tu_1" }),
              { $wait_file: "g1" },
              sendCan("AskUserQuestion", { questions: [QUESTION] }, { tool_use_id: "tu_2" }),
              { $wait_file: "g2" },
              sendElicit({ mcp_server_name: "srv", message: "m" }),
              { $wait_file: "g3" },
              sendCan("ExitPlanMode", { plan: PLAN }, { tool_use_id: "tu_4" }),
              { $wait_file: "never" },
            ],
            result: false,
          },
        ],
      },
      steps: [
        ["start", "init"],
        ["send", "go", "prompt"],
        ["gate", "g1", "prompt"],
        ["gate", "g2", "prompt"],
        ["gate", "g3", "prompt"],
        ["end"],
      ],
    },
  ],
  [
    "errors and a crash",
    {
      workspace: { enabledKinds: ALL_KINDS },
      steps: [
        ["start", "init"],
        ["subscribe", "a"],
        ["broadcast", { type: "error", message: "boom-probe" }],
        ["broadcast", { type: "error", message: "  Claude Code process aborted by user \n" }],
        ["unsubscribe", "a"],
        ["broadcast", { type: "error", message: "unwatched" }],
        ["subscribe", "b"],
        ["send", "exit:3", "done"],
        ["end"],
      ],
    },
  ],
  [
    "a clean exit without a result",
    {
      script: { turns: [{ match: "go", steps: [{ $text: "partial" }, { $exit: 0 }], result: false }] },
      steps: [["start", "init"], ["subscribe", "a"], ["send", "go", "done"], ["end"]],
    },
  ],
  [
    "a clean exit with a prompt open",
    {
      script: {
        turns: [
          { match: "go", steps: [sendCan("Bash", { command: "a" }, { tool_use_id: "tu_1" }), { $wait_file: "g1" }, { $exit: 0 }], result: false },
        ],
      },
      steps: [["start", "init"], ["send", "go", "prompt"], ["gate", "g1", "done"], ["end"]],
    },
  ],
  [
    "a clean exit before any input",
    {
      script: { on_init: [{ $exit: 0 }] },
      steps: [["start", "done"], ["end"]],
    },
  ],
  [
    "background work holds the idle row",
    {
      script: {
        turns: [
          { match: "spawn", steps: [task("task_started", "t1", { tool_use_id: "toolu_t1", description: "Survey" })], result: "spawned" },
          { match: "finish", steps: [task("task_notification", "t1", { status: "completed", summary: "Done" })], result: "finished" },
          {
            match: "bg",
            steps: [
              task("task_started", "t2", { tool_use_id: "toolu_t2", description: "Long job" }),
              task("task_updated", "t2", { patch: { is_backgrounded: true } }),
            ],
            result: "bg",
          },
          { match: "later", steps: [task("task_notification", "t2", { status: "completed", summary: "Done" })], result: "later" },
        ],
      },
      steps: [
        ["start", "init"],
        ["subscribe", "a"],
        ["send", "spawn", "result"],
        ["send", "finish", "result"],
        ["send", "bg", "result"],
        ["send", "later", "result"],
        ["end"],
      ],
    },
  ],
  [
    "a muted session",
    {
      script: { turns: [{ match: "perm", steps: [can("Bash", { command: "x" }, { tool_use_id: "tu_m" })], result: "ok" }] },
      steps: [
        ["start", "init"],
        ["mute", { blocked: true }],
        ["send", "hello", "result"],
        ["send", "perm", "prompt"],
        ["answer", 0, { perm: { kind: "allow_once" } }, "result"],
        ["mute", { blocked: false }],
        ["send", "again", "result"],
        ["end"],
      ],
    },
  ],
  [
    "the workspace switch off",
    {
      workspace: { enabled: false },
      script: { turns: [{ match: "perm", steps: [can("Bash", { command: "x" }, { tool_use_id: "tu_o" })], result: "ok" }] },
      steps: [
        ["start", "init"],
        ["send", "hello", "result"],
        ["send", "perm", "prompt"],
        ["answer", 0, { perm: { kind: "allow_once" } }, "result"],
        ["broadcast", { type: "error", message: "nope" }],
        ["end"],
      ],
    },
  ],
  [
    "only some kinds",
    {
      workspace: { enabledKinds: ["permission_request"] },
      script: { turns: [{ match: "perm", steps: [can("Bash", { command: "x" }, { tool_use_id: "tu_k" })], result: "ok" }] },
      steps: [
        ["start", "init"],
        ["send", "hello", "result"],
        ["send", "perm", "prompt"],
        ["answer", 0, { perm: { kind: "deny" } }, "result"],
        ["broadcast", { type: "error", message: "not enabled" }],
        ["end"],
      ],
    },
  ],
  [
    "no workspace for the cwd",
    {
      workspace: null,
      steps: [["start", "init"], ["send", "hello", "result"], ["broadcast", { type: "error", message: "nobody" }], ["end"]],
    },
  ],
  [
    "the start sweep",
    {
      steps: [
        [
          "seed",
          [
            "INSERT INTO notifications (id, session_id, kind, title, request_id, created_at, read_at) VALUES ('n-perm', '$ID', 'permission_request', 'Claude needs permission', 'r-old-1', 1000, NULL)",
            "INSERT INTO notifications (id, session_id, kind, title, request_id, created_at, read_at) VALUES ('n-ask', '$ID', 'ask_user_question', 'Claude is asking a question', 'r-old-2', 1001, NULL)",
            "INSERT INTO notifications (id, session_id, kind, title, request_id, created_at, read_at) VALUES ('n-plan', '$ID', 'plan_approval_request', 'Claude has a plan to review', 'r-old-3', 1002, NULL)",
            "INSERT INTO notifications (id, session_id, kind, title, body, created_at, read_at) VALUES ('n-idle', '$ID', 'session_idle', 'Claude finished a turn', 'x', 1003, NULL)",
            "INSERT INTO notifications (id, session_id, kind, title, request_id, created_at, read_at) VALUES ('n-read', '$ID', 'permission_request', 'Claude needs permission', 'r-old-4', 1004, 1005)",
            "INSERT INTO notifications (id, session_id, kind, title, request_id, created_at, read_at) VALUES ('n-other', 'other-session', 'permission_request', 'Claude needs permission', 'r-old-5', 1006, NULL)",
          ],
        ],
        ["start", "init"],
        ["end"],
        ["start", "init"],
        ["end"],
      ],
    },
  ],
  [
    "events sent through broadcast",
    {
      workspace: { enabledKinds: ALL_KINDS },
      steps: [
        ["start", "init"],
        ["subscribe", "a"],
        ["broadcast", { type: "permission_request", requestId: "r-dup", toolName: "Bash", toolUseId: "tu_x", title: "Run it", input: {} }],
        ["broadcast", { type: "permission_request", requestId: "r-dup", toolName: "Bash", toolUseId: "tu_y" }],
        ["broadcast", { type: "mcp_elicitation_request", requestId: "r-el", serverName: "github", mode: "url", message: "  Sign in to GitHub  \r\nmore" }],
        ["broadcast", { type: "ask_user_question", requestId: "r-ask", toolUseId: "tu_a", questions: [{ question: "Pick one", header: "Choice" }] }],
        ["broadcast", { type: "plan_approval_request", requestId: "r-plan", toolUseId: "tu_p", plan: "\n\nStep one\nStep two" }],
        ["broadcast", { type: "run_finished", status: "error", note: "it broke", costUsd: 0.25 }],
        ["broadcast", { type: "error", message: "Session exploded" }],
        ["broadcast", { type: "turn_status", status: "idle", backgroundTasks: 0 }],
        ["broadcast", { type: "custom_thing", message: "ignored" }],
        ["unsubscribe", "a"],
        ["broadcast", { type: "error", message: `caf${cp(0xe9)} ${cp(0x1f680)}` }],
        ["end"],
      ],
    },
  ],
];

// ------------------------------- the world -------------------------------

const HOME = process.env.HOME;
mkdirSync(join(HOME, ".claude", ".claudius"), { recursive: true });
// No feedback nudge (its roll is random).
writeFileSync(join(HOME, ".claude", "settings.json"), `${JSON.stringify({ feedbackSurveyRate: 0 }, null, 2)}\n`);
const cwdOf = (i) => join(ROOT_DIR, "p", String(i));
const wsIdOf = (i) => `wks_s31_${i}`;
const workspaces = [];
for (const [i, [, spec]] of SCENARIOS.entries()) {
  mkdirSync(cwdOf(i), { recursive: true });
  if (spec.workspace === null) continue;
  workspaces.push({
    id: wsIdOf(i),
    name: `Scenario ${i}`,
    rootPath: cwdOf(i),
    ...(spec.workspace ? { defaults: { notifications: spec.workspace } } : {}),
  });
}
const workspacesJson = `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`;
writeFileSync(join(HOME, ".claude", ".claudius", "workspaces.json"), workspacesJson);

const envs = [];
notificationBus.subscribe((e) => envs.push(e));

// ------------------------------- recording ------------------------------

const PROMPT_TYPES = new Set(["permission_request", "ask_user_question", "plan_approval_request", "mcp_elicitation_request"]);
const dbFile = (cwd) => join(HOME, ".claude", "projects", encodeProjectDir(cwd), ".claudius.db");

function readRows(cwd) {
  const file = dbFile(cwd);
  if (!existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT * FROM notifications ORDER BY rowid").all();
  } finally {
    db.close();
  }
}

/** `$N<k>` / `$R<k>` by first appearance, times as "$T". */
function normalizer() {
  const ids = [];
  const reqs = [];
  const tag = (list, prefix, v) => {
    if (typeof v !== "string") return v;
    if (!list.includes(v)) list.push(v);
    return `${prefix}${list.indexOf(v)}`;
  };
  const time = (v) => (v === null || v === undefined ? v : "$T");
  return {
    row: (r) => ({ ...r, id: tag(ids, "$N", r.id), request_id: tag(reqs, "$R", r.request_id), created_at: time(r.created_at), read_at: time(r.read_at) }),
    env: (n) => ({ ...n, id: tag(ids, "$N", n.id), requestId: tag(reqs, "$R", n.requestId), createdAt: time(n.createdAt), readAt: time(n.readAt) }),
  };
}

const counts = (s) => ({
  results: s.buffer.filter((e) => e.type === "sdk" && e.message?.type === "result").length,
  prompts: s.buffer.filter((e) => PROMPT_TYPES.has(e.type)).length,
});

async function waitStep(s, wait, before, name) {
  if (wait === "init") {
    await waitFor(() => s.buffer.some((e) => e.type === "sdk" && e.message?.type === "system" && e.message?.subtype === "init"), 15_000, `${name}: init`);
  } else if (wait === "result") {
    await waitFor(() => counts(s).results > before.results, 15_000, `${name}: result`);
  } else if (wait === "prompt") {
    await waitFor(() => counts(s).prompts > before.prompts, 15_000, `${name}: prompt`);
  } else if (wait === "done") {
    await waitFor(() => s.done === true, 15_000, `${name}: done`);
  }
}

const scenarios = [];
for (const [i, [name, spec]] of SCENARIOS.entries()) {
  const id = `s31-${String(i).padStart(2, "0")}-${i % 2 ? "odd" : "even"}`;
  const cwd = cwdOf(i);
  const wsId = wsIdOf(i);
  const script = spec.script ? JSON.stringify(spec.script) : null;
  if (script) process.env.FAKE_CLAUDE_SCRIPT = script;
  else delete process.env.FAKE_CLAUDE_SCRIPT;
  const norm = normalizer();
  let s = null;
  const tabs = new Map();
  const steps = [];
  for (const step of spec.steps) {
    const [op] = step;
    envs.length = 0;
    const before = s ? counts(s) : { results: 0, prompts: 0 };
    if (op === "seed") {
      const db = await openDb(cwd, "readwrite");
      for (const sql of step[1]) db.prepare(sql.split("$ID").join(id)).run();
    } else if (op === "start") {
      s = new Session({ id, cwd });
      await s.start();
      await waitStep(s, step[1], { results: 0, prompts: 0 }, name);
    } else if (op === "subscribe") {
      tabs.set(step[1], s.subscribe(() => {}));
    } else if (op === "unsubscribe") {
      tabs.get(step[1])();
      tabs.delete(step[1]);
    } else if (op === "send") {
      s.sendInput(step[1]);
      await waitStep(s, step[2], before, name);
    } else if (op === "answer") {
      const ev = s.buffer.filter((e) => PROMPT_TYPES.has(e.type))[step[1]];
      const d = step[2];
      if (d.perm) s.resolvePermission(ev.requestId, d.perm);
      else if (d.ask) s.submitAskAnswer(ev.requestId, d.ask);
      else if (d.plan) await s.resolvePlan(ev.requestId, d.plan);
      else if (d.elicit) s.resolveElicitation(ev.requestId, d.elicit);
      await waitStep(s, step[3], before, name);
    } else if (op === "gate") {
      writeFileSync(join(cwd, step[1]), "");
      await waitStep(s, step[2], before, name);
    } else if (op === "broadcast") {
      s.broadcast(structuredClone(step[1]));
    } else if (op === "rename") {
      const r = await s.rename(step[1]);
      if (!r.ok) throw new Error(`${name}: rename: ${r.error}`);
    } else if (op === "mute") {
      await setSessionPrefs(cwd, id, step[1]);
    } else if (op === "end") {
      for (const off of tabs.values()) off();
      tabs.clear();
      await s.end();
    } else {
      throw new Error(`unknown step ${op}`);
    }
    // The bus's calls are fire-and-forget: let them (and their coalesced
    // `state` flushes) land.
    await sleep(300);
    const rows = readRows(cwd).map(norm.row);
    const mine = envs.filter((e) => (e.type === "state" ? e.workspaceId : e.notification.workspaceId) === wsId);
    const last = mine.filter((e) => e.type === "state").at(-1);
    steps.push({
      step,
      rows,
      envs: mine.filter((e) => e.type === "notification").map((e) => ({ type: e.type, notification: norm.env(e.notification) })),
      state: last ? { totalUnread: last.totalUnread, perSession: last.perSession } : null,
    });
  }
  scenarios.push({ name, id, workspace: spec.workspace === undefined ? {} : spec.workspace, script, steps });
}

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ sdkVersion, workspacesJson: workspacesJson.split(ROOT_DIR).join("$ROOT"), scenarios }));
process.exit(0);
