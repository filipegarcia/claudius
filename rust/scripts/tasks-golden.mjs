#!/usr/bin/env node
// Golden fixture for the session's subagent (Task) persistence.
//
//   node rust/scripts/tasks-golden.mjs     (node@22: needs better-sqlite3,
//                                           which bun can't load)
//
// Re-runs itself under `--experimental-transform-types` with HOME pointed at
// a temp dir (the TS database lives at `~/.claude/projects/<enc>/`), and
// registers a resolve hook so the extensionless / `@/` imports in the .ts
// sources resolve. Records, from the TS sources themselves:
// - `saveSessionTask` → the stored rows (every column's value and SQLite
//   type, `updated_at`'s type only) and `listSessionTasks`, after each save
//   (an upsert among them; the list is oldest update first);
// - `listSessionTasks` over hand-written rows (malformed JSON, a NULL
//   status, a foreign `reason`, non-array resource links, odd flags);
// - `Session.captureTaskState` + `persistTask` (the real prototype methods on
//   a bare session object, `Date.now` stubbed) over scripted wire events:
//   after each step, what `listSessionTasks` returns and what
//   `hasActiveSubagents` / `countActiveBackgroundTasks` say;
// - `MAX_INNER_MESSAGES` and `TASK_PERSIST_THROTTLE_MS`.
//
// Written to rust/crates/claudius-core/tests/fixtures/tasks_golden.json and
// replayed by crates/claudius-core/tests/tasks_golden.rs (the database
// half) and the `tasks_golden_capture` test in src/session.rs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/tasks_golden.json");

if (!process.env.TASKS_GOLDEN_CHILD) {
  const home = mkdtempSync(join(tmpdir(), "tasks-golden-"));
  const r = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, HOME: home, TASKS_GOLDEN_CHILD: "1" } },
  );
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

// `./db` → `./db.ts`, `@/lib/…` → `<repo>/lib/…`, and JSON imports typed.
const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
export async function resolve(spec, ctx, next) {
  const s = spec.startsWith("@/") ? new URL(spec.slice(2), ROOT).href : spec;
  if ((s.startsWith(".") || s.startsWith("file:")) && ctx.parentURL) {
    const p = fileURLToPath(new URL(s, ctx.parentURL));
    if (!existsSync(p)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(p + ext)) return next(pathToFileURL(p + ext).href, ctx);
      }
    }
  }
  return next(s, ctx);
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const { openDb } = await import(join(repo, "lib/server/db.ts"));
const { saveSessionTask, listSessionTasks } = await import(join(repo, "lib/server/session-tasks-db.ts"));
const { Session } = await import(join(repo, "lib/server/session.ts"));

const cwd = join(process.env.HOME, "proj");
mkdirSync(cwd, { recursive: true });
const db = await openDb(cwd);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// `persistTask` fires `saveSessionTask` without awaiting it.
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const columns = db.prepare("PRAGMA table_info(session_tasks)").all().map((c) => c.name);
function storedRows(sessionId) {
  const sel = columns.map((c) => `"${c}", typeof("${c}") AS "${c}:type"`).join(", ");
  return db
    .prepare(`SELECT ${sel} FROM session_tasks WHERE session_id = ? ORDER BY rowid`)
    .all(sessionId)
    .map((row) => {
      delete row.updated_at;
      return row;
    });
}

// ---- saveSessionTask → row → listSessionTasks ----------------------------
const SAVES = [
  {
    taskId: "full",
    toolUseId: "toolu_full",
    subagentType: "general-purpose",
    description: "Survey the repo",
    taskType: "local_agent",
    workflowName: "wf",
    status: "running",
    totalTokens: 1234,
    toolUses: 5,
    durationMs: 6789.5,
    summary: "Reading files",
    error: "none yet",
    isBackgrounded: true,
    spawnDepth: 2,
    ambient: false,
    resourceLinks: [{ uri: "file:///tmp/a.txt", name: "a.txt" }],
    reason: "worker_restart",
    outputFile: "/tmp/out.txt",
    innerMessages: [
      { at: 1700000000000, message: { type: "assistant", parent_tool_use_id: "toolu_full", n: 1 } },
      { message: { type: "user", parent_tool_use_id: "toolu_full", text: "héllo   🎉" } },
    ],
  },
  { taskId: "minimal", status: "completed", innerMessages: [] },
  {
    taskId: "odd",
    status: "stopped",
    reason: "other",
    resourceLinks: [],
    isBackgrounded: false,
    ambient: true,
    spawnDepth: 0,
    totalTokens: 0,
    durationMs: 1.25,
    innerMessages: [{ at: 0, message: null }],
  },
  // The upsert rewrites every column: what's left out goes back to NULL.
  { taskId: "full", status: "completed", summary: "Done", innerMessages: [] },
  // Falsy resource links aren't stored; an empty status is.
  { taskId: "falsy", status: "", resourceLinks: "", innerMessages: [] },
];
const saveSid = "golden-save";
const after = [];
for (const entry of SAVES) {
  await saveSessionTask(cwd, saveSid, entry);
  after.push({ rows: storedRows(saveSid), list: await listSessionTasks(cwd, saveSid) });
  await sleep(3); // distinct updated_at: the list is oldest-update-first
}
const save = { entries: SAVES, after };

// ---- hand-written rows → listSessionTasks ---------------------------------
const RAW = [
  {
    task_id: "r1",
    status: null,
    inner_messages: "not json",
    resource_links: "",
    reason: "worker_restart",
    is_backgrounded: 2,
    ambient: 0,
  },
  { task_id: "r2", status: "running", inner_messages: '{"message":1}', resource_links: '{"a":1}', reason: "other" },
  {
    task_id: "r3",
    status: "failed",
    inner_messages: '[1,null,"x",{"at":1},{"message":null},[],{"message":{"t":1},"extra":true},{"at":2,"message":0}]',
    resource_links: "[1,2]",
    total_tokens: 1.5,
    tool_uses: 3,
    duration_ms: 40,
    spawn_depth: 1,
    error: "bad",
  },
  { task_id: "r4", status: "completed", inner_messages: "[]", resource_links: "not json", is_backgrounded: 0 },
  { task_id: "r5", status: "pending", inner_messages: "7", resource_links: "null", ambient: 1 },
];
const rawSid = "golden-raw";
RAW.forEach((row, i) => {
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO session_tasks(session_id, ${cols.join(", ")}, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ?)`,
  ).run(rawSid, ...cols.map((c) => row[c]), 1000 + i);
});
const raw = { rows: RAW, list: await listSessionTasks(cwd, rawSid) };

// ---- captureTaskState over scripted events --------------------------------
let clock = 0;
const realNow = Date.now;
Date.now = () => clock;

function bareSession(id) {
  const s = Object.create(Session.prototype);
  Object.assign(s, {
    id,
    cwd,
    taskMetaById: new Map(),
    subagentMsgsByToolUseId: new Map(),
    taskPersistThrottleAt: new Map(),
    broadcastTurnStatusIfChanged() {},
  });
  return s;
}

const sdk = (message, at) => (at === undefined ? { type: "sdk", message } : { type: "sdk", message, at });
const sys = (subtype, rest) => ({ type: "system", subtype, ...rest });
const inner = (parent, n, at) => sdk({ type: "assistant", parent_tool_use_id: parent, n }, at);

const SCENARIOS = [
  {
    name: "lifecycle",
    steps: [
      {
        clock: 1000,
        events: [
          sdk(
            sys("task_started", {
              task_id: "t1",
              tool_use_id: "tu1",
              description: "Survey",
              task_type: "local_agent",
              workflow_name: "wf",
              is_backgrounded: false,
              spawn_depth: 1,
            }),
            10,
          ),
        ],
      },
      { clock: 1500, events: [inner("tu1", 1, 11)] }, // inside the window: no write
      { clock: 3000, events: [inner("tu1", 2, 12)] }, // exactly the window: write
      { clock: 3001, events: [inner("tu1", 3)] }, // no `at`
      {
        clock: 4999,
        events: [sdk(sys("task_progress", { task_id: "t1", description: "Later", usage: { total_tokens: 9 } }), 13)],
      },
      {
        clock: 5000,
        events: [
          sdk(
            sys("task_progress", {
              task_id: "t1",
              description: "Surveying",
              summary: "Half way",
              usage: { total_tokens: 100, tool_uses: 2, duration_ms: 450.5 },
            }),
            14,
          ),
        ],
      },
      {
        clock: 7000,
        events: [
          sdk(
            sys("task_progress", {
              task_id: "t1",
              description: "",
              summary: "",
              usage: { total_tokens: null, tool_uses: 0 },
            }),
            15,
          ),
        ],
      },
      { clock: 7001, events: [sdk(sys("task_updated", { task_id: "t1", patch: { is_backgrounded: true } }), 16)] },
      {
        clock: 7002,
        events: [
          sdk(sys("task_updated", { task_id: "t1", patch: { status: "", description: "Renamed", error: "boom" } }), 17),
        ],
      },
      {
        clock: 7003,
        events: [
          sdk(
            sys("task_notification", {
              task_id: "t1",
              status: "completed",
              summary: "All done",
              usage: { total_tokens: 321, tool_uses: 7, duration_ms: 9000 },
              ambient: false,
              resource_links: [{ uri: "file:///tmp/r.txt", name: "r.txt" }],
              reason: "worker_restart",
              output_file: "/tmp/t1.out",
            }),
            18,
          ),
        ],
      },
    ],
  },
  {
    name: "notification-only",
    steps: [
      { clock: 100, events: [sdk(sys("task_notification", { task_id: "n1", tool_use_id: "tuN" }), 1)] },
      { clock: 101, events: [sdk(sys("task_notification", { task_id: "n2", status: "" }), 2)] },
      {
        clock: 102,
        events: [sdk(sys("task_notification", { task_id: "n3", status: "stopped", reason: "other", resource_links: {} }), 3)],
      },
      {
        clock: 103,
        events: [sdk(sys("task_notification", { task_id: "n4", status: "failed", resource_links: [], ambient: null }), 4)],
      },
      {
        clock: 104,
        events: [
          sdk(
            sys("task_notification", { task_id: "n4", status: null, summary: "late", ambient: true, resource_links: null }),
            5,
          ),
        ],
      },
    ],
  },
  {
    name: "ambient",
    steps: [
      { clock: 0, events: [sdk(sys("task_started", { task_id: "am1", tool_use_id: "tuA1", ambient: true }), 1)] },
      {
        clock: 1,
        events: [sdk(sys("task_started", { task_id: "am2", tool_use_id: "tuA2", ambient: true, is_backgrounded: true }), 2)],
      },
      { clock: 2, events: [sdk(sys("task_started", { task_id: "bg", tool_use_id: "tuB", is_backgrounded: true }), 3)] },
      // A notification can flip a task ambient (task_updated can't).
      { clock: 3, events: [sdk(sys("task_notification", { task_id: "bg", status: "running", ambient: true }), 4)] },
      { clock: 4, events: [sdk(sys("task_updated", { task_id: "am1", patch: { status: "pending", ambient: false } }), 5)] },
    ],
  },
  {
    name: "ignored",
    steps: [
      {
        clock: 10,
        events: [
          { type: "turn_status", message: sys("task_started", { task_id: "x1", tool_use_id: "tuX" }) },
          sdk(sys("task_started", { tool_use_id: "tuX" }), 1),
          sdk(sys("task_started", { task_id: "", tool_use_id: "tuX" }), 2),
          sdk({ type: "assistant", subtype: "task_started", task_id: "x2" }, 3),
          sdk(sys("task_progress", { task_id: "ghost", summary: "s" }), 4),
          sdk(sys("task_updated", { task_id: "ghost", patch: { status: "failed" } }), 5),
          sdk(sys("task_unknown", { task_id: "ghost" }), 6),
          sdk({ type: "system", subtype: "init" }, 7),
        ],
      },
    ],
  },
  {
    name: "inner-before-start",
    steps: [
      { clock: 0, events: [inner("tu2", 1, 1), inner("tu2", 2)] },
      {
        clock: 1,
        events: [sdk(sys("task_started", { task_id: "t2", tool_use_id: "tu2", is_backgrounded: null, ambient: 0 }), 2)],
      },
      // A parented task_progress is a subagent message, not progress.
      {
        clock: 5000,
        events: [sdk(sys("task_progress", { task_id: "t2", parent_tool_use_id: "tu2", summary: "nope" }), 3)],
      },
      // An empty parent is no parent.
      { clock: 5001, events: [sdk(sys("task_updated", { task_id: "t2", parent_tool_use_id: "", patch: { status: "pending" } }), 4)] },
      { clock: 5002, events: [sdk(sys("task_updated", { task_id: "t2", parent_tool_use_id: null, patch: { status: "running" } }), 5)] },
    ],
  },
  {
    name: "shared-tool-use",
    steps: [
      {
        clock: 0,
        events: [
          sdk(sys("task_started", { task_id: "a", tool_use_id: "tu5", description: "first" }), 1),
          sdk(sys("task_started", { task_id: "b", tool_use_id: "tu5", description: "second", is_backgrounded: true }), 2),
        ],
      },
      { clock: 2500, events: [inner("tu5", 1, 3)] },
      {
        clock: 2600,
        events: [sdk(sys("task_notification", { task_id: "a", summary: "kept?" }), 4)],
      },
      // A second task_started for a known id replaces it (the summary goes).
      { clock: 2700, events: [sdk(sys("task_started", { task_id: "a", tool_use_id: "tu5" }), 5)] },
    ],
  },
  {
    name: "throttle-window",
    steps: [
      { clock: 0, events: [sdk(sys("task_started", { task_id: "w", tool_use_id: "tuW" }), 1)] },
      { clock: 1999, events: [inner("tuW", 1, 2)] },
      { clock: 1999, events: [sdk(sys("task_updated", { task_id: "w", patch: { description: "moved" } }), 3)] },
      { clock: 3998, events: [inner("tuW", 2, 4)] },
      { clock: 3999, events: [inner("tuW", 3, 5)] },
      { clock: 5000, events: [sdk(sys("task_progress", { task_id: "w", summary: "throttled" }), 6)] },
      { clock: 5999, events: [sdk(sys("task_progress", { task_id: "w", summary: "written" }), 7)] },
    ],
  },
  {
    name: "cap",
    steps: [
      { clock: 0, events: [sdk(sys("task_started", { task_id: "c", tool_use_id: "tuC" }), 1)] },
      // `burst`: `inner(parent, i, i)` for i in 0..count, generated on both sides.
      { clock: 1, burst: { parent: "tuC", count: 503 } },
      { clock: 2, events: [sdk(sys("task_updated", { task_id: "c", patch: { status: "completed" } }), 2)] },
    ],
  },
];

const capture = [];
for (const sc of SCENARIOS) {
  const sid = `golden-capture-${sc.name}`;
  const s = bareSession(sid);
  const steps = [];
  for (const step of sc.steps) {
    clock = step.clock;
    const events = step.burst
      ? Array.from({ length: step.burst.count }, (_, i) => inner(step.burst.parent, i, i))
      : step.events;
    for (const ev of events) s.captureTaskState(ev);
    await settle();
    const tasks = (await listSessionTasks(cwd, sid)).sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
    steps.push({
      clock: step.clock,
      ...(step.burst ? { burst: step.burst } : { events: step.events }),
      tasks,
      active: s.hasActiveSubagents(),
      background: s.countActiveBackgroundTasks(),
    });
  }
  capture.push({ name: sc.name, steps });
}
Date.now = realNow;

const fixture = {
  maxInnerMessages: Session.MAX_INNER_MESSAGES,
  throttleMs: Session.TASK_PERSIST_THROTTLE_MS,
  save,
  raw,
  capture,
};
writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
console.log(`wrote ${out}`);
process.exit(0);
