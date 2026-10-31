#!/usr/bin/env node
// Golden fixture for the stream audit (S28): `broadcast()`,
// `captureSnapshotState()`, `captureTaskState()` and `consume()`, recorded
// from the TS sources:
//
//   node rust/scripts/session-stream-golden.mjs   (node@22: session.ts needs
//                                                  better-sqlite3, which bun
//                                                  can't load; builds
//                                                  claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir and a resolve hook for the extensionless /
// `@/` imports, twice (two temp roots); both recordings must agree byte for
// byte. The hook maps session.ts's SDK import to a shim that calls the real
// `query()` with one option added, `pathToClaudeCodeExecutable` (the fake
// CLI).
//
// Two parts:
// - `broadcast`: the real `Session.prototype.broadcast` on a real
//   `new Session({id, cwd})` that never starts, one session per case, fed
//   scripted events (`steps`: `{ev}` broadcasts it; `{set}` sets session
//   fields first: `replaying` (`isReplayingTranscript`), `overrides`
//   (`manualTodoOverrides`), `todosAt` (`latestTodosSnapshotAt`),
//   `turnInFlight`; `{burst}`
//   broadcasts `count` assistant messages with `at` 0, 1, ...). After each
//   step: what a subscriber registered before the first step received
//   (`live`), what `broadcast` threw (`threw`, or null) and the captured
//   state (`state`, see `project`). After the last step: the replay buffer
//   (`buffer`, or for a burst its length and ends), `bufferTrimmed`, the
//   queued reminders (both channels), the `session_tasks` rows as
//   `listSessionTasks` returns them and the session row's `state` text.
// - `consume`: the real `new Session({id, cwd}).start()` against the fake
//   CLI, one session per case, with the case's `script` (the fake's
//   `FAKE_CLAUDE_SCRIPT`) and user `settings`. Each prompt goes through the
//   real `sendInput`; its `events` are what a subscriber registered after
//   start saw from the send until the turn settled, split into `ordered`
//   (everything but `ASYNC_TYPES`, in order) and `async` (those, sorted by
//   their JSON text), and the unhandled rejections the turn left
//   (`rejections`). After the last prompt: the sessions row (`row`:
//   `model`, and whether `updated_at` / `last_seen_at` moved past
//   `created_at`) and the user settings.json text.
//
// Numbers stamped from the clock (`at`, `fetchedAt`, `todosAt` at or past
// 1e12) read `$NOW`; in `consume`, every `at` reads `$AT`, ids minted per
// run read `$UUID` / `$MSG`, and paths under the temp root `$ROOT`.
//
// Written to rust/crates/claudius-core/tests/fixtures/session_stream_golden.json
// and replayed by crates/claudius-core/src/session/tests/stream_golden.rs
// (broadcast) and crates/claudius-core/tests/session_consume_golden.rs
// (consume).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/session_stream_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SESSION_STREAM_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-stream-golden-")));
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
            SESSION_STREAM_GOLDEN_CHILD: root,
            SESSION_STREAM_GOLDEN_FAKE: fake,
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
    writeFileSync(join(tmpdir(), "session-stream-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "session-stream-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.broadcast.reduce((n, c) => n + c.steps.length, 0);
  const prompts = fixture.consume.reduce((n, c) => n + c.prompts.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.broadcast.length} broadcast cases (${steps} steps), ${fixture.consume.length} consume cases (${prompts} prompts; SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.SESSION_STREAM_GOLDEN_CHILD;
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.SESSION_STREAM_GOLDEN_FAKE } });
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
const { takeMidTurnReminders, takePendingReminders } = await import(join(repo, "lib/server/system-reminders.ts"));
const { listSessionTasks } = await import(join(repo, "lib/server/session-tasks-db.ts"));
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await sleep(5);
};
const json = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])]),
        )
      : v;
const NOW_KEYS = new Set(["at", "fetchedAt", "todosAt"]);
// Clock-stamped numbers read `$NOW`, temp paths `$ROOT`.
function norm(v, key) {
  if (typeof v === "number" && NOW_KEYS.has(key) && v >= 1e12) return "$NOW";
  if (typeof v === "string") return v.split(ROOT_DIR).join("$ROOT");
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, k)]));
  return v;
}

const PROJECT = join(ROOT_DIR, "project");
mkdirSync(PROJECT, { recursive: true });
const HOME = process.env.HOME;
const settingsFile = join(HOME, ".claude", "settings.json");
mkdirSync(dirname(settingsFile), { recursive: true });

// ------------------------------- broadcast -------------------------------

const sdk = (message, at) => (at === undefined ? { type: "sdk", message } : { type: "sdk", message, at });
const sys = (subtype, rest = {}) => ({ type: "system", subtype, ...rest });
const user = (content, rest = {}) => ({ type: "user", message: { role: "user", content }, ...rest });
const asst = (content, rest = {}) => ({ type: "assistant", message: { role: "assistant", content }, ...rest });
const tu = (id, name, input) => ({ type: "tool_use", id, name, input });
const tr = (id, content, rest = {}) => ({ type: "tool_result", tool_use_id: id, content, ...rest });
const uses = (blocks, at, rest) => ({ ev: sdk(asst(blocks, rest), at) });
const results = (blocks, at, rest) => ({ ev: sdk(user(blocks, rest), at) });
const ev = (e) => ({ ev: e });
const set = (fields) => ({ set: fields });
const TEXT = [{ type: "text", text: "hi" }];
const LIST = "#1 [completed] Ship it\n#2 [in_progress] Write the notes\n#3 [pending] Tag the release";
const WT = "/r/.claude/worktrees";

const BROADCAST = [
  [
    "stamp",
    [
      ev({ type: "sdk", message: asst(TEXT) }),
      ev({ type: "sdk", message: asst(TEXT), at: null }),
      ev(sdk(asst(TEXT), 0)),
      ev(sdk(asst(TEXT), 7.5)),
      ev(sdk(asst(TEXT), -3)),
      ev(sdk(asst(TEXT), "x")),
      ev({ type: "sdk", at: null, message: asst(TEXT) }),
      ev({ type: "error", message: "boom" }),
      ev({ type: "error", message: "boom", at: null }),
    ],
  ],
  [
    "buffer rules",
    [
      ev({ type: "queue:updated", sessionId: "x", queue: [], sdkQueuedTurns: 0 }),
      ev({ type: "holder_changed", holderId: null }),
      ev({ type: "usage_snapshot", usage: {} }),
      ev({ type: "prompt_settled", kind: "ask", requestId: "r" }),
      ev({ type: "effort_applied", effort: "high" }),
      ev(sdk({ type: "command_lifecycle", phase: "start" }, 1)),
      ev(sdk("text", 2)),
      ev(sdk(5, 3)),
      ev(sdk([], 4)),
      ev({ type: "turn_status", status: "idle", backgroundTasks: 0 }),
      ev({ type: "cwd_changed", cwd: "/elsewhere" }),
      ev({ type: "model_changed", model: "claude-sonnet-4-5", source: "picker" }),
      ev({ type: "session_snapshot", todos: [] }),
      ev({ type: "plan_usage_unavailable" }),
      ev({ type: "feedback_survey" }),
      ev({ type: "made_up", n: 1 }),
      ev({ type: 5 }),
      ev({}),
    ],
  ],
  ["sdk message null", [ev(sdk(null, 1)), ev(sdk(asst(TEXT), 2))]],
  ["sdk message missing", [ev({ type: "sdk", at: 1 }), ev(sdk(asst(TEXT), 2))]],
  ["buffer cap", [{ burst: { count: 1003 } }, ev(sdk(asst(TEXT), 5000))]],
  ["buffer exactly full", [{ burst: { count: 1000 } }]],
  [
    "init",
    [
      ev(
        sdk(
          sys("init", {
            model: "claude-opus-4-5",
            slash_commands: ["clear", 5, "compact", null],
            agents: ["reviewer"],
            skills: "not-an-array",
            cwd: "/w",
            tools: ["Bash", "advisor"],
            plugin_errors: [{ plugin: "p", type: "t", message: "m" }],
          }),
          1,
        ),
      ),
      ev(sdk(sys("commands_changed", { commands: [{ name: "a" }, { name: "" }, { name: 5 }, null, {}, { name: "b" }] }), 2)),
      ev(sdk(sys("commands_changed", { commands: [] }), 3)),
      ev(sdk(sys("commands_changed", { commands: [{ name: "" }] }), 4)),
      ev(sdk(sys("commands_changed"), 5)),
      ev(sdk(sys("init", { model: "", cwd: "", slash_commands: ["x"] }), 6)),
      ev(sdk(sys("init", { model: 5, cwd: 7, agents: ["a", "a"], skills: ["s"] }), 7)),
      ev(sdk(sys("init", { model: "claude-sonnet-4-5", parent_tool_use_id: "p" }), 8)),
    ],
  ],
  ["commands before init", [ev(sdk(sys("commands_changed", { commands: [{ name: "a" }] }), 1)), ev(sdk(sys("init"), 2))]],
  ["commands not an array", [ev(sdk(sys("init", { slash_commands: ["a"] }), 1)), ev(sdk(sys("commands_changed", { commands: { name: "x" } }), 2))]],
  ["init replayed", [set({ replaying: true }), ev(sdk(sys("init", { model: "claude-haiku-4-5", cwd: "/r" }), 1))]],
  [
    "denials",
    [
      ev(sdk(sys("permission_denied", { tool_name: "Bash", decision_reason_type: "rule" }), 1)),
      ev(sdk(sys("permission_denied"), 2)),
      ev(sdk(sys("permission_denied", { tool_name: null, decision_reason_type: null, decision_reason: "classifier" }), 3)),
      ev(sdk(sys("permission_denied", { tool_name: "", decision_reason_type: "", decision_reason: "x" }), 4)),
      ev(sdk(sys("permission_denied", { tool_name: "Edit", decision_reason: "mode" }))),
      ev(sdk(sys("permission_denied", { tool_name: "Read", decision_reason_type: "hook" }), 2.5)),
      ...Array.from({ length: 17 }, (_, i) => ev(sdk(sys("permission_denied", { tool_name: `T${i}` }), 10 + i))),
    ],
  ],
  [
    "denials odd types",
    [
      ev(sdk(sys("permission_denied", { tool_name: 5, decision_reason_type: 7 }), 1)),
      ev(sdk(sys("permission_denied", { tool_name: { a: 1 }, decision_reason_type: null, decision_reason: ["x"] }), 2)),
      ev(sdk(sys("permission_denied", { tool_name: "Bash", decision_reason_type: false }), 3)),
      ev(sdk(sys("permission_denied", { tool_name: "Bash" }), "x")),
    ],
  ],
  [
    "prompts",
    [
      ev(sdk(user("first", { uuid: "u1" }), 10)),
      ev(sdk(user([{ type: "text", text: "sec" }, { type: "image" }, { type: "text", text: "ond" }], { uuid: "u2" }), 5)),
      ev(sdk(user("third", { uuid: "u3" }), 10)),
      ev(sdk(user("no uuid"), 11)),
      ev(sdk(user("empty uuid", { uuid: "" }), 12)),
      ev(sdk(user("subagent", { uuid: "u4", parent_tool_use_id: "p" }), 13)),
      ev(sdk(user([tr("t1", "out")], { uuid: "u5" }), 14)),
      ev(sdk(user([{ type: "image", source: {} }], { uuid: "u6" }), 15)),
      ev(sdk(user("<task-notification>done</task-notification>", { uuid: "u7" }), 16)),
      ev(sdk(user("<system-reminder>x</system-reminder>\nreal text", { uuid: "u8" }), 17)),
      ev(sdk(user("", { uuid: "u9" }), 18)),
      ev(sdk(user("at as text", { uuid: "u10" }), "x")),
      ev(sdk(user("older", { uuid: "u11" }), 19)),
      ev(sdk({ type: "user", uuid: "u12", message: "str" }, 20)),
      ev(sdk({ type: "user", uuid: "u13" }, 21)),
    ],
  ],
  ["prompt uuid odd", [ev(sdk(user("n", { uuid: 5 }), 1)), ev(sdk(user("t", { uuid: true }), 2)), ev(sdk(user("z", { uuid: 0 }), 3))]],
  [
    "odd blocks",
    [
      uses([tu("t0", "TaskCreate", { subject: "A" }), tu("l0", "TaskList", {})], 1),
      results([null, 5, "str", { type: "tool_result" }, tr(5, "Task #1 created"), tr(null, "x"), tr("t0", null)], 2),
      ev(sdk({ type: "user", uuid: "m1", message: null }, 3)),
      ev(sdk({ type: "user", uuid: "m2", message: { content: null } }, 4)),
      ev(sdk(user("empty parent", { uuid: "m3", parent_tool_use_id: "" }), 5)),
      ev(sdk(user("null parent", { uuid: "m4", parent_tool_use_id: null }), 6)),
      uses([null, 5, { type: "tool_use" }, { type: "tool_use", name: 5, id: "n" }, tu("x", "TodoWrite", { todos: [{ id: "q" }] })], 7),
      results([tr("l0", 7)], 8),
      ev(sdk({ type: "assistant", message: { content: "str" } }, 9)),
      ev(sdk({ type: "assistant" }, 10)),
    ],
  ],
  [
    "todo write",
    [
      uses([tu("w1", "TodoWrite", { todos: [{ id: "1", content: "A", status: "pending" }, { content: "B", status: "completed" }] })], 10),
      uses([tu("w2", "TodoWrite", { todos: [{ id: "x", content: "old" }] })], 5),
      uses([tu("w3", "TodoWrite", { todos: "nope" })], 20),
      uses([tu("w4", "TodoWrite", null)], 21),
      uses([tu("w5", "TodoWrite", { todos: [] })], 10),
      uses([tu("w6", "TodoWrite", { todos: [null, 5, { id: 3 }] })], 30),
      uses([{ type: "text", text: "t" }, tu("w7", "TodoWrite", { todos: [{ id: "z" }] }), { type: "thinking" }], 31, { parent_tool_use_id: "p" }),
    ],
  ],
  [
    "task create",
    [
      uses([tu("tc1", "TaskCreate", { subject: "Alpha", activeForm: "Doing alpha" })], 10),
      uses([tu("tc1", "TaskCreate", { subject: "dup" })], 11),
      uses([tu("tc2", "TaskCreate", { subject: 5, activeForm: 6 }), tu("tc3", "TaskCreate", {})], 12),
      uses([tu("tc4", "TaskCreate", null), tu("", "TaskCreate", { subject: "empty id" }), tu(7, "TaskCreate", { subject: "num" })], 13),
      results([tr("tc1", "Task #1 created successfully: Alpha")], 14),
      results([tr("tc2", JSON.stringify({ task: { id: "7" } }))], 15),
      results([tr("tc3", "garbage")], 16),
      results([tr("tc4", "Task #9 created", { is_error: true })], 17),
      results([tr("", "Task #3 created")], 18),
      uses([tu("tc5", "TaskCreate", { subject: "Five" }), tu("tc6", "TaskCreate", { subject: "Six" })], 19),
      results(
        [
          tr("tc5", [{ type: "text", text: "Task #" }, { type: "text", text: 12 }, { type: "image" }, { type: "text", text: " created" }]),
          tr("tc6", "task #ab-c  CREATED ok"),
          tr("tc1", "Task #99 created"),
        ],
        20,
      ),
      uses([tu("tc5", "TaskCreate", { subject: "replayed" })], 21),
    ],
  ],
  [
    "task create json fallback",
    [
      uses([tu("j1", "TaskCreate", { subject: "a" }), tu("j2", "TaskCreate", { subject: "b" }), tu("j3", "TaskCreate", { subject: "c" })], 1),
      results([tr("j1", JSON.stringify({ task: { id: "" } })), tr("j2", JSON.stringify({ task: { id: 4 } })), tr("j3", "null")], 2),
    ],
  ],
  [
    "task create cutoff",
    [
      set({ todosAt: 100 }),
      uses([tu("c1", "TaskCreate", { subject: "old" })], 50),
      uses([tu("c2", "TaskCreate", { subject: "new" })], 150),
      uses([tu("c3", "TaskCreate", { subject: "same" })], 150),
      uses([tu("c4", "TaskCreate", { subject: "now" })]),
    ],
  ],
  [
    "task list",
    [
      uses([tu("l1", "TaskList", {}), tu(5, "TaskList", {})], 10),
      results([tr("l1", LIST)], 11),
      uses([tu("l2", "TaskList", {})], 12),
      results([tr("l2", "unknown shape")], 13),
      uses([tu("l3", "TaskList", {})], 14),
      results([tr("l3", LIST, { is_error: true })], 15),
      uses([tu("l4", "TaskList", {})], 16),
      results([tr("l4", [{ type: "text", text: "#4 [pending] Four" }, { type: "text", text: "" }])], 17),
      uses([tu("l5", "TaskList", {})], 18),
      results([tr("l5", "  \n ")], 19),
      results([tr("l1", LIST)], 20),
    ],
  ],
  [
    "task list cutoff",
    [
      set({ todosAt: 100 }),
      uses([tu("l1", "TaskList", {})], 10),
      results([tr("l1", LIST)], 50),
      uses([tu("l2", "TaskList", {})], 10),
      results([tr("l2", LIST)]),
    ],
  ],
  [
    "task list replayed",
    [set({ replaying: true }), uses([tu("l1", "TaskList", {})], 10), results([tr("l1", LIST)], 11)],
  ],
  [
    "task update",
    [
      uses([tu("u0", "TaskUpdate", { taskId: "1", status: "completed" })], 1),
      uses([tu("w", "TodoWrite", { todos: [{ id: "1", content: "A", status: "pending" }, { id: "2", content: "B" }, { id: "3", content: "C", status: "pending" }] })], 2),
      uses([tu("u1", "TaskUpdate", { taskId: "1", status: "completed", subject: "A2" })], 3),
      uses([tu("u2", "TaskUpdate", { taskId: "2", status: "in_progress" })], 4),
      uses([tu("u3", "TaskUpdate", { taskId: "3", status: "deleted" })], 5),
      uses([tu("u4", "TaskUpdate", { taskId: 1, status: "pending" })], 6),
      uses([tu("u5", "TaskUpdate", { taskId: "", status: "pending" })], 7),
      uses([tu("u6", "TaskUpdate", { taskId: "1", status: "", subject: "" })], 8),
      uses([tu("u7", "TaskUpdate", { taskId: "1", status: 5, subject: 6 })], 9),
      uses([tu("u8", "TaskUpdate", { taskId: "missing", status: "completed" })], 10),
      uses([tu("u9", "TaskUpdate", null)], 11),
    ],
  ],
  ["task update empty list", [uses([tu("w", "TodoWrite", { todos: [] })], 1), uses([tu("u1", "TaskUpdate", { taskId: "1", status: "completed" })], 2)]],
  [
    "overrides",
    [
      set({ overrides: { 10: "pending", 1: "completed", toolu_y: "deleted", z: "in_progress" } }),
      uses([tu("w", "TodoWrite", { todos: [{ id: "1", status: "pending" }, { id: "z", status: "pending" }] })], 1, { replay: 1 }),
      uses([tu("toolu_y", "TaskCreate", { subject: "Y" })], 2),
      set({ overrides: { toolu_q: "completed", 2: "deleted" } }),
      uses([tu("toolu_q", "TaskCreate", { subject: "Q" }), tu("toolu_r", "TaskCreate", { subject: "R" })], 3),
      set({ overrides: { toolu_r: "completed", 2: "deleted" } }),
      results([tr("toolu_r", "Task #2 created successfully: R")], 4),
      uses([tu("u", "TaskUpdate", { taskId: "z", status: "completed" })], 5),
    ],
  ],
  [
    "overrides replayed",
    [
      set({ overrides: { 1: "completed", t1: "deleted", 5: "pending" } }),
      set({ replaying: true }),
      uses([tu("w", "TodoWrite", { todos: [{ id: "1", status: "pending" }, { id: "5" }] })], 1),
      uses([tu("t1", "TaskCreate", { subject: "T" })], 2),
      uses([tu("t9", "TaskCreate", { subject: "T9" })], 3),
      set({ overrides: { t9: "in_progress", 1: "completed" } }),
      results([tr("t9", "Task #8 created")], 4),
      uses([tu("u", "TaskUpdate", { taskId: "8", status: "completed" })], 5),
      set({ replaying: false }),
      uses([tu("l", "TaskList", {})], 6),
      results([tr("l", "#1 [pending] One\n#8 [pending] Eight\n#9 [pending] Nine")], 7),
    ],
  ],
  [
    "mid-turn reminder",
    [
      uses([tu("w", "TodoWrite", { todos: [{ id: "1", content: "A", status: "pending" }] })], 1),
      ...Array.from({ length: 11 }, (_, i) => uses([tu(`b${i}`, "Bash", { command: "ls" })], 2 + i)),
      uses([tu("b11", "Read", {}), tu("b12", "Grep", {})], 20),
      uses([tu("b13", "Bash", {})], 21),
      uses([tu("tl", "TaskList", {})], 22),
      ...Array.from({ length: 12 }, (_, i) => uses([tu(`c${i}`, "Bash", {})], 30 + i)),
    ],
  ],
  [
    "mid-turn without open items",
    [
      uses([tu("w", "TodoWrite", { todos: [{ id: "1", status: "completed" }] })], 1),
      ...Array.from({ length: 13 }, (_, i) => uses([tu(`b${i}`, "Bash", {})], 2 + i)),
      uses([tu("w2", "TodoWrite", { todos: [{ id: "1", status: "pending" }, { id: "2", status: "in_progress" }] })], 20),
      ...Array.from({ length: 12 }, (_, i) => uses([tu(`c${i}`, "Bash", {})], 21 + i)),
    ],
  ],
  [
    "mid-turn replayed and subagent",
    [
      uses([tu("w", "TodoWrite", { todos: [{ id: "1", status: "pending" }] })], 1),
      set({ replaying: true }),
      ...Array.from({ length: 12 }, (_, i) => uses([tu(`r${i}`, "Bash", {})], 2 + i)),
      set({ replaying: false }),
      ...Array.from({ length: 12 }, (_, i) => uses([tu(`s${i}`, "Bash", {})], 20 + i, { parent_tool_use_id: "task" })),
      ...Array.from({ length: 11 }, (_, i) => uses([tu(`l${i}`, "Bash", {})], 40 + i)),
      uses([tu("x", "TodoWrite", { todos: [{ id: "1", status: "pending" }] }), tu("y", "Bash", {})], 60),
    ],
  ],
  [
    "worktree",
    [
      uses([tu("e1", "Edit", { file_path: `${WT}/one/src/a.ts` })], 1),
      uses([tu("e2", "Write", { file_path: `${WT}/one/b.ts` })], 2),
      uses([tu("e3", "NotebookEdit", { notebook_path: `${WT}/two/n.ipynb` })], 3),
      uses([tu("e4", "MultiEdit", { file_path: 5, notebook_path: `${WT}/three` })], 4),
      uses([tu("e5", "Edit", { file_path: "", notebook_path: `${WT}/four/x` })], 5),
      uses([tu("e6", "Edit", null), tu("e7", "Edit", { file_path: "/r/src/a.ts" })], 6),
      uses([tu("e8", "Write", { file_path: `${WT}/` })], 7),
      uses([tu("e9", "Edit", { file_path: `/a/.claude/worktrees/five\nx/y` })], 8),
      uses([tu("e10", "Edit", { file_path: `${WT}/one/c.ts` })], 9),
      uses([tu("e11", "Edit", { file_path: `${WT}/six/c.ts` })], 10, { parent_tool_use_id: "p" }),
      uses([tu("e12", "Read", { file_path: `${WT}/seven/c.ts` })], 11),
      ev({ type: "cwd_changed", cwd: `${WT}/one` }),
      uses([tu("e13", "Edit", { file_path: `${WT}/one/d.ts` })], 12),
    ],
  ],
  [
    "tasks and turn status",
    [
      ev(sdk(sys("task_started", { task_id: "t1", tool_use_id: "tu1", description: "Survey", task_type: "local_agent" }), 1)),
      ev(sdk(asst(TEXT, { parent_tool_use_id: "tu1" }), 2)),
      ev(sdk(sys("task_started", { task_id: "t2", tool_use_id: "tu2", is_backgrounded: true }), 3)),
      ev(sdk(sys("task_progress", { task_id: "t1", summary: "half", usage: { total_tokens: 5, tool_uses: 1, duration_ms: 2 } }), 4)),
      ev(sdk(sys("task_updated", { task_id: "t1", patch: { is_backgrounded: true } }), 5)),
      ev(sdk(sys("task_started", { task_id: "t3", tool_use_id: "tu3", ambient: true }), 6)),
      ev(sdk(sys("task_notification", { task_id: "t2", status: "completed" }), 7)),
      ev(sdk(sys("task_updated", { task_id: "t1", patch: { status: "failed", error: "boom" } }), 8)),
      ev(sdk(sys("task_notification", { task_id: "t9", status: "running" }), 9)),
      ev(sdk(sys("task_notification", { task_id: "t9" }), 10)),
      set({ turnInFlight: true }),
      ev(sdk(sys("task_started", { task_id: "t4", tool_use_id: "tu4" }), 11)),
      set({ turnInFlight: false }),
      ev(sdk(sys("task_updated", { task_id: "t4", patch: { status: "completed" } }), 12)),
    ],
  ],
  [
    "task odd types",
    [
      ev(sdk(sys("task_started", { task_id: "o1", tool_use_id: "otu1", description: 5, is_backgrounded: "yes" }), 1)),
      ev(sdk(asst(TEXT, { parent_tool_use_id: 5 }), 2)),
    ],
  ],
  [
    "tasks from replay",
    [
      set({ replaying: true }),
      ev(sdk(sys("task_started", { task_id: "r1", tool_use_id: "rtu1" }), 1)),
      ev(sdk(user([tr("x", "y")], { parent_tool_use_id: "rtu1" }), 2)),
      ev(sdk(sys("task_notification", { task_id: "r1", status: "completed", summary: "done" }), 3)),
    ],
  ],
];

const sessionStateText = async (id) => {
  const row = (await openDb(PROJECT)).prepare("SELECT state FROM sessions WHERE id = ?").get(id);
  return row ? row.state : null;
};

function project(s) {
  const at = s.latestTodosSnapshotAt;
  return {
    prompt: json(s.latestUserPromptSnapshot ?? null),
    todos: json(s.latestTodosSnapshot ?? null),
    todosAt: Number.isFinite(at) ? at : String(at),
    pendingCreates: [...s.pendingTaskCreates.keys()].sort(),
    pendingLists: [...s.pendingTaskLists].sort(),
    rebuiltFromTaskList: s.todosRebuiltFromTaskListThisTurn,
    toolUsesSinceTodoTouch: s.toolUsesSinceTodoTouch,
    firedMidTurn: s.firedMidTurnTodoReminderThisTurn,
    turnsSinceTodoWrite: s.turnsSinceTodoWrite,
    overrides: json(s.manualTodoOverrides),
    init: json(s.latestInitSnapshot ?? null),
    sdkModel: s.sdkModel ?? null,
    denials: json(s.recentDenials),
    lastCwd: s.lastCwdBroadcast,
    // In-memory task metadata, keys sorted (TS builds each object in arrival
    // order; only the row and `task_snapshot` order is observable).
    tasks: [...s.taskMetaById.values()].map((m) => {
      const rest = { ...m };
      delete rest.innerMessages;
      return canon(json(rest));
    }),
    inner: Object.fromEntries([...s.subagentMsgsByToolUseId.entries()].map(([k, v]) => [k, v.length]).sort()),
    status: s.getStatus(),
    backgroundTasks: s.countActiveBackgroundTasks(),
  };
}

const broadcast = [];
for (const [ci, [name, steps]] of BROADCAST.entries()) {
  const id = `s28-broadcast-${ci}`;
  const s = new Session({ id, cwd: PROJECT });
  let live = [];
  s.subscribers.add((e) => live.push(json(e)));
  const recorded = [];
  let burst = null;
  for (const step of steps) {
    let threw = null;
    if (step.set) {
      if ("replaying" in step.set) s.isReplayingTranscript = step.set.replaying;
      if ("overrides" in step.set) s.manualTodoOverrides = { ...step.set.overrides };
      if ("todosAt" in step.set) s.latestTodosSnapshotAt = step.set.todosAt;
      if ("turnInFlight" in step.set) s.turnInFlight = step.set.turnInFlight;
    } else if (step.burst) {
      burst = step.burst.count;
      try {
        for (let i = 0; i < step.burst.count; i++) s.broadcast(sdk(asst(TEXT), i));
      } catch (e) {
        threw = e.message;
      }
    } else {
      try {
        s.broadcast(step.ev);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
    }
    await settle();
    const rec = { ...step, threw, live: norm(burst !== null && step.burst ? live.length : live), state: norm(project(s)) };
    recorded.push(rec);
    live = [];
  }
  const buffer = norm(json(s.buffer));
  // By id: rows written in the same millisecond tie on `updated_at`.
  const tasks = norm(json(await listSessionTasks(PROJECT, id))).sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
  broadcast.push({
    name,
    id,
    steps: recorded,
    buffer:
      burst === null
        ? buffer
        : { length: buffer.length, head: buffer.slice(0, 2), tail: buffer.slice(-2) },
    bufferTrimmed: s.bufferTrimmed,
    midTurnReminders: takeMidTurnReminders(s),
    reminders: takePendingReminders(s),
    tasksDb: tasks,
    stateRow: await sessionStateText(id),
  });
}

// -------------------------------- consume --------------------------------

// Event types whose arrival rides a control round trip or an awaited read,
// so their place among the rest is timing: compared as a sorted multiset.
const ASYNC_TYPES = new Set([
  "effort_applied",
  "plan_usage",
  "plan_usage_unavailable",
  "mcp_needs_auth_notice",
  "mcp_disconnected_notice",
  "advisor_disabled_on_model_change",
  "feedback_survey",
]);
const cp = (n) => String.fromCodePoint(n);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Per-run values: every `at`, minted uuids and message ids, `fetchedAt`,
// the case's cwd.
function normConsume(v, cwd, key) {
  if (key === "at" && typeof v === "number") return "$AT";
  if (key === "fetchedAt" && typeof v === "number") return "$NOW";
  if (typeof v === "string") {
    if (UUID_RE.test(v)) return "$UUID";
    if (key === "id" && /^msg_[0-9a-f]{32}$/.test(v)) return "$MSG";
    return v.split(cwd).join("$CWD");
  }
  if (Array.isArray(v)) return v.map((x) => normConsume(x, cwd));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normConsume(x, cwd, k)]));
  return v;
}
const byText = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);

const turn = (match, steps, result) => (result === undefined ? { match, steps } : { match, steps, result });
const text = (t) => ({ $text: t });
const localCmd = (content) => ({ type: "system", subtype: "local_command_output", content });
const FULL_USAGE = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 0.5, resets_at: "2026-01-01T00:00:00Z" },
    seven_day: null,
    seven_day_oauth_apps: { utilization: 1 },
    seven_day_opus: 0,
    seven_day_sonnet: false,
    model_scoped: [{ display_name: "Opus", utilization: 0.25, resets_at: 1767225600, extra: 1 }],
    spend_limit: { limit_usd: 100, used_usd: null, utilization: 0.1, other: "x" },
    extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 1.5 },
  },
};
// [usage response (a fake `control.get_usage` entry), label]
const USAGE = [
  [FULL_USAGE, "full"],
  [{ $response: {} }, "empty"],
  [{ $response: { rate_limits: {} } }, "no windows"],
  [{ $response: { rate_limits: 5, subscription_type: 5, rate_limits_available: "yes" } }, "primitive limits"],
  [{ $response: { rate_limits: "str" } }, "string limits"],
  [{ $response: { rate_limits: 0, subscription_type: "", rate_limits_available: 0 } }, "falsy limits"],
  [{ $response: { rate_limits: { model_scoped: [] } } }, "empty model scoped"],
  [{ $response: { rate_limits: { model_scoped: [5, "x", {}, [1]] } } }, "odd model scoped"],
  [{ $response: { rate_limits: { model_scoped: {} } } }, "model scoped object"],
  [{ $response: { rate_limits: { model_scoped: [null] } } }, "model scoped null entry"],
  [{ $response: { rate_limits: { model_scoped: "", spend_limit: null, extra_usage: 0 } } }, "falsy model scoped"],
  [{ $response: { rate_limits: { spend_limit: 0, extra_usage: false } } }, "falsy extras"],
  [{ $response: { rate_limits: { spend_limit: "x", extra_usage: {} } } }, "truthy primitive extras"],
  [
    {
      $response: {
        rate_limits: {
          extra_usage: { is_enabled: "yes", monthly_limit: 0, used_credits: null, utilization: 2, currency: "USD" },
          spend_limit: { limit_usd: 0, used_usd: 1, utilization: null, currency: "EUR" },
        },
      },
    },
    "extras fields",
  ],
  [
    {
      $response: {
        rate_limits: {
          five_hour: [],
          seven_day: { utilization: null, resets_at: null },
          seven_day_oauth_apps: "x",
          seven_day_opus: { resets_at: 5 },
          seven_day_sonnet: 1,
        },
      },
    },
    "odd windows",
  ],
  [{ $error: "usage unavailable" }, "error"],
  [{ $response: null }, "null response"],
  [{ $response: "str" }, "string response"],
  [{ $response: [] }, "array response"],
  [{ $response: { subscription_type: null, rate_limits_available: null, rate_limits: null } }, "nulls"],
];
// [name, {options, settings, script, prompts}]
const CONSUME = [
  [
    "plan usage",
    {
      script: {
        control: { get_usage: { $sequence: USAGE.map(([r]) => r) } },
        turns: USAGE.map(([, label], i) => turn(`usage ${i}:`, [text(label)])),
      },
      prompts: USAGE.map(([, label], i) => `usage ${i}: ${label}`),
    },
  ],
  [
    "result subtypes",
    {
      script: {
        turns: [
          turn("max turns", [text("a")], { subtype: "error_max_turns", is_error: true, errors: ["Reached max turns"] }),
          turn("execution", [text("b")], { subtype: "error_during_execution", is_error: true, errors: [] }),
          turn("no subtype", [text("c")], { subtype: null, errors: [] }),
          turn("success again", [text("d")]),
        ],
      },
      prompts: ["max turns", "execution", "no subtype", "success again"],
    },
  ],
  [
    "queued turns",
    {
      script: {
        turns: [2, 2, 2.7, 0, "3", -1, 1e300, 18446744073709551616, 0.5, null, 1e21, 7].map((n, i) =>
          turn(`q${i}:`, [text(`q${i}`)], { queued_turn_count: n }),
        ),
      },
      prompts: Array.from({ length: 12 }, (_, i) => `q${i}:`),
    },
  ],
  [
    "model command",
    {
      script: {
        turns: [
          ["Set model to claude-sonnet-4-5"],
          ["set   MODEL to opus[1m] and more"],
          ["set model to opus[1m]"],
          ["Model set to x"],
          [5],
          [["Set model to array-model"]],
          [null],
          [`Set${cp(0xa0)}model${cp(0x3000)}to nbsp-model`],
          [`Set${cp(0xfeff)}model to bom-model`],
          [`Set${cp(0x85)}model to nel-model`],
          [`${cp(0x17f)}et model to long-s-model`],
          [`SET MODEL TO ${cp(0x1f600)}x`],
          ["Set model to"],
          ["  Set model to leading-space"],
          [`Set model to tab${cp(9)}rest`],
          [`Set model to nel${cp(0x85)}in${cp(0xfeff)}bom`],
        ].map(([content], i) => turn(`m${i}:`, [localCmd(content)])),
      },
      prompts: Array.from({ length: 16 }, (_, i) => `m${i}:`),
    },
  ],
  [
    "model command without content",
    {
      script: { turns: [turn("m:", [{ type: "system", subtype: "local_command_output" }])] },
      prompts: ["m:"],
    },
  ],
  ["cli exits mid-turn", { script: { turns: [turn("crash", [text("partial"), { $exit: 3 }], false)] }, prompts: ["crash"] }],
  ["cli ends without result", { script: { turns: [turn("end", [text("partial"), { $exit: 0 }], false)] }, prompts: ["end"] }],
];

const consumeRow = async (cwd, id) => {
  const r = (await openDb(cwd)).prepare("SELECT model, created_at, updated_at, last_seen_at FROM sessions WHERE id = ?").get(id);
  return r ? { model: r.model, updatedMoved: r.updated_at > r.created_at, lastSeenMoved: r.last_seen_at > r.created_at } : null;
};

async function waitFor(pred, ms) {
  for (let t = 0; t < ms; t += 10) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

// Next logs an unhandled rejection and carries on; so does the recorder,
// noting it on the prompt (`rejections`).
let rejections = [];
process.on("unhandledRejection", (e) => rejections.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));

const consume = [];
for (const [ci, [name, spec]] of CONSUME.entries()) {
  const id = `s28-consume-${ci}`;
  const cwd = join(ROOT_DIR, "consume", String(ci));
  mkdirSync(cwd, { recursive: true });
  const settings = spec.settings ?? { feedbackSurveyRate: 0 };
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify(spec.script);
  const s = new Session({ id, cwd, ...(spec.options ?? {}) });
  await s.start();
  if (!(await waitFor(() => s.buffer.some((e) => e.type === "sdk" && e.message?.subtype === "init"), 10_000))) {
    throw new Error(`${name}: no init`);
  }
  // The init's own round trips (effort, MCP status) settle first.
  await sleep(400);
  let all = [];
  s.subscribers.add((e) => all.push(json(e)));
  const prompts = [];
  for (const prompt of spec.prompts) {
    const from = all.length;
    rejections = [];
    s.sendInput(prompt);
    const settled = () => {
      const evs = all.slice(from);
      const end = evs.findIndex((e) => (e.type === "sdk" && e.message?.type === "result") || e.type === "error");
      const idle = (e) => e.type === "turn_status" && e.status === "idle";
      // A stream that ends without a result settles when consume() ends.
      return end >= 0 ? evs.slice(end).some(idle) : s.done && evs.some(idle);
    };
    if (!(await waitFor(settled, 15_000))) throw new Error(`${name}: ${prompt} never settled: ${JSON.stringify(all.slice(from))}`);
    await sleep(400);
    const evs = normConsume(all.slice(from), cwd);
    prompts.push({
      prompt,
      ordered: evs.filter((e) => !ASYNC_TYPES.has(e.type)),
      async: evs.filter((e) => ASYNC_TYPES.has(e.type)).sort(byText),
      rejections,
    });
  }
  consume.push({
    name,
    id,
    options: spec.options ?? {},
    settings,
    script: spec.script,
    prompts,
    row: await consumeRow(cwd, id),
    settingsAfter: readFileSync(settingsFile, "utf8"),
  });
  await s.end();
}
delete process.env.FAKE_CLAUDE_SCRIPT;
rmSync(settingsFile, { force: true });

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ sdkVersion, broadcast, consume }));
process.exit(0);
