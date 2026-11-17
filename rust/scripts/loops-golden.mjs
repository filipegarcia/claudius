#!/usr/bin/env node
// Golden fixture for the session's scheduled-loop tracker (S11a).
//
//   node rust/scripts/loops-golden.mjs     (node@22: needs better-sqlite3,
//                                           which bun can't load)
//
// Re-runs itself under `--experimental-transform-types` with HOME pointed at
// a temp dir (the TS database lives at `~/.claude/projects/<enc>/`), and
// registers a resolve hook so the extensionless / `@/` imports in the .ts
// sources resolve. Records, from the TS sources themselves:
// - `recordLoopTick` / `attachLoopTickTokens` → the stored `loop_ticks` rows
//   (every column's value and SQLite type, `created_at`'s type only);
// - `listLoopBreakdown` over hand-written rows, and on a cwd with no DB;
// - `Session.trackScheduledLoops` (the real prototype method on a bare
//   session object, `Date.now` stubbed) over scripted SDK messages: after
//   each step, `getScheduledLoops()`, the pending CronCreate entries, the
//   applied wake-up stops, the tick ids awaiting their turn's usage, and the
//   session's `loop_ticks` rows.
//
// Written to rust/crates/claudius-core/tests/fixtures/loops_golden.json and
// replayed by crates/claudius-core/tests/loops_golden.rs (the database half)
// and the `loops_golden_tracker` test in src/session.rs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/loops_golden.json");

if (!process.env.LOOPS_GOLDEN_CHILD) {
  const home = mkdtempSync(join(tmpdir(), "loops-golden-"));
  const r = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, HOME: home, LOOPS_GOLDEN_CHILD: "1" } },
  );
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

// `./db` → `./db.ts`, `@/lib/…` → `<repo>/lib/…`, bare `next/server` →
// `next/server.js`, and JSON imports typed.
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
  try {
    return await next(s, ctx);
  } catch (err) {
    if (!s.startsWith(".") && !s.startsWith("file:") && !s.startsWith("node:") && !s.endsWith(".js")) {
      return next(s + ".js", ctx);
    }
    throw err;
  }
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const { openDb } = await import(join(repo, "lib/server/db.ts"));
const { recordLoopTick, attachLoopTickTokens, listLoopBreakdown } = await import(
  join(repo, "lib/server/loop-ticks-db.ts")
);
const { Session } = await import(join(repo, "lib/server/session.ts"));

const cwd = join(process.env.HOME, "proj");
mkdirSync(cwd, { recursive: true });
const db = await openDb(cwd);
// `recordLoopTick` / `attachLoopTickTokens` are fired without awaiting.
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const columns = db.prepare("PRAGMA table_info(loop_ticks)").all().map((c) => c.name);
function storedRows(sessionId) {
  const sel = columns.map((c) => `"${c}", typeof("${c}") AS "${c}:type"`).join(", ");
  return db
    .prepare(`SELECT ${sel} FROM loop_ticks WHERE session_id = ? ORDER BY id`)
    .all(sessionId)
    .map((row) => {
      delete row.id;
      delete row.created_at;
      return row;
    });
}

// ---- recordLoopTick / attachLoopTickTokens → rows -------------------------
const dbSid = "golden-db";
const DB_STEPS = [
  ["record", { sessionId: dbSid, sessionTitle: "Title", toolUseId: "a", prompt: "/loop a", firedAt: 1000, noop: false }],
  ["record", { sessionId: dbSid, sessionTitle: null, toolUseId: "b", prompt: "", firedAt: 2000, noop: true }],
  // A second record for the same tool use is ignored, title and all.
  ["record", { sessionId: dbSid, sessionTitle: "Other", toolUseId: "a", prompt: "changed", firedAt: 3000, noop: true }],
  ["attach", "a", 12.5],
  // Only the first attach sticks.
  ["attach", "a", 99],
  ["attach", "b", -3],
  ["attach", "missing", 5],
  ["record", { sessionId: dbSid, sessionTitle: "Héllo 🎉", toolUseId: "c", prompt: "p", firedAt: 4000.5, noop: false }],
  ["attach", "c", 12.4],
  ["record", { sessionId: dbSid, sessionTitle: null, toolUseId: "d", prompt: "p", firedAt: 5000, noop: false }],
  ["attach", "d", -0.5],
  ["record", { sessionId: dbSid, sessionTitle: null, toolUseId: "e", prompt: "p", firedAt: 6000, noop: false }],
  ["attach", "e", 2.5],
  ["record", { sessionId: dbSid, sessionTitle: null, toolUseId: "f", prompt: "p", firedAt: 7000, noop: false }],
  ["attach", "f", 1e12],
];
const dbAfter = [];
for (const step of DB_STEPS) {
  if (step[0] === "record") await recordLoopTick(cwd, step[1]);
  else await attachLoopTickTokens(cwd, step[1], step[2]);
  dbAfter.push(storedRows(dbSid));
}

// ---- listLoopBreakdown over hand-written rows -----------------------------
const RAW = [
  { session_id: "s1", session_title: null, tool_use_id: "r1", prompt: "first", fired_at: 100, tokens: 10, noop: 0 },
  { session_id: "s1", session_title: "B title", tool_use_id: "r2", prompt: "second", fired_at: 300, tokens: null, noop: 1 },
  { session_id: "s1", session_title: "A title", tool_use_id: "r3", prompt: "middle", fired_at: 200, tokens: 5, noop: null },
  { session_id: "s2", session_title: null, tool_use_id: "r4", prompt: "only", fired_at: 500, tokens: null, noop: 0 },
  { session_id: "s3", session_title: "T", tool_use_id: "r5", prompt: "x", fired_at: 50, tokens: 7, noop: 0 },
  { session_id: "s3", session_title: "T", tool_use_id: "r6", prompt: "y", fired_at: 60, tokens: 0, noop: 0 },
  { session_id: "s3", session_title: "T", tool_use_id: "r7", prompt: "z", fired_at: 70, tokens: 0, noop: 0 },
  { session_id: "s4", session_title: "half", tool_use_id: "r8", prompt: "h1", fired_at: 40, tokens: 3, noop: 0 },
  { session_id: "s4", session_title: "half", tool_use_id: "r9", prompt: "h2", fired_at: 45, tokens: 2, noop: 0 },
];
const rawCwd = join(process.env.HOME, "raw");
mkdirSync(rawCwd, { recursive: true });
const rawDb = await openDb(rawCwd);
for (const row of RAW) {
  const cols = Object.keys(row);
  rawDb
    .prepare(`INSERT INTO loop_ticks(${cols.join(", ")}, created_at) VALUES (${cols.map(() => "?").join(", ")}, 0)`)
    .run(...cols.map((c) => row[c]));
}
const noDbCwd = join(process.env.HOME, "nodb");
mkdirSync(noDbCwd, { recursive: true });
const breakdown = {
  rows: RAW,
  list: await listLoopBreakdown(rawCwd),
  noDb: await listLoopBreakdown(noDbCwd),
};

// ---- trackScheduledLoops over scripted messages ---------------------------
let clock = 0;
Date.now = () => clock;

function bareSession(id, title) {
  const s = Object.create(Session.prototype);
  Object.assign(s, {
    id,
    cwd,
    title,
    scheduledLoops: new Map(),
    pendingScheduledLoops: new Map(),
    appliedWakeupStops: new Set(),
    pendingLoopTickAttribution: [],
  });
  return s;
}

const tu = (id, name, input) => ({ type: "tool_use", id, name, input });
const assistant = (...content) => ({ type: "assistant", message: { role: "assistant", content } });
const tr = (tool_use_id, content, extra = {}) => ({ type: "tool_result", tool_use_id, content, ...extra });
const user = (content, toolUseResult) => {
  const m = { type: "user", message: { role: "user", content } };
  if (toolUseResult !== undefined) m.tool_use_result = toolUseResult;
  return m;
};
const result = (usage) => (usage === undefined ? { type: "result", subtype: "success" } : { type: "result", subtype: "success", usage });

const SESSION_ONLY = "Scheduled recurring job abc123 (Every 5 minutes). Session-only (not written to disk, dies when Claude exits).";

const SCENARIOS = [
  {
    name: "cron-lifecycle",
    title: "Loop session",
    steps: [
      { clock: 1, at: 1000, message: assistant(tu("tu_c1", "CronCreate", { cron: "*/5 * * * *", prompt: "check", recurring: true })) },
      { clock: 2, at: 1100, message: user([tr("tu_c1", SESSION_ONLY)], { id: "abc123", nextFireAt: 1300000 }) },
      { clock: 3, at: 1200, message: assistant(tu("tu_l1", "CronList", {})) },
      {
        clock: 4,
        at: 1300,
        message: user([tr("tu_l1", "1 job")], {
          jobs: [
            { id: "abc123", nextFireAt: 1600000 },
            { id: "zzz", nextFireAt: 5 },
            { id: "", nextFireAt: 9 },
            { id: "abc123", nextFireAt: 0 },
            null,
            7,
            { id: 5, nextFireAt: 10 },
          ],
        }),
      },
      // A CronList that failed refreshes nothing; one with no jobs array either.
      { clock: 5, at: 1400, message: assistant(tu("tu_l2", "CronList", {}), tu("tu_l3", "CronList", {})) },
      {
        clock: 6,
        at: 1500,
        message: user([tr("tu_l2", "boom", { is_error: true }), tr("tu_l3", "ok")], { jobs: [{ id: "abc123", nextFireAt: 42 }] }),
      },
      { clock: 7, at: 1550, message: assistant(tu("tu_l4", "CronList", {})) },
      { clock: 8, at: 1560, message: user([tr("tu_l4", "ok")], { jobs: "nope" }) },
      // A failed CronList alone: its jobs are ignored.
      { clock: 8, at: 1570, message: assistant(tu("tu_l5", "CronList", {})) },
      {
        clock: 8,
        at: 1580,
        message: user([tr("tu_l5", "boom", { is_error: true })], { jobs: [{ id: "abc123", nextFireAt: 7777 }] }),
      },
      { clock: 9, at: 1600, message: assistant(tu("tu_d0", "CronDelete", { id: "nope" }), tu("tu_d1", "CronDelete", { id: "" })) },
      { clock: 10, at: 1700, message: assistant(tu("tu_d2", "CronDelete", { id: 5 }), tu("tu_d3", "CronDelete", { id: "abc123" })) },
      // Deleting twice is harmless.
      { clock: 11, at: 1800, message: assistant(tu("tu_d4", "CronDelete", { id: "abc123" })) },
    ],
  },
  {
    name: "cron-results",
    title: undefined,
    steps: [
      {
        clock: 10,
        message: assistant(
          tu("r1", "CronCreate", { cron: "0 9 * * *", prompt: "daily" }),
          tu("r2", "CronCreate", { cron: "0 * * * *", prompt: "hourly", recurring: "true" }),
          tu("r3", "CronCreate", { cron: "* * * * *", prompt: "minutely", recurring: false }),
          tu("r4", "CronCreate", { cron: "*/2 * * * *", prompt: "two" }),
          tu("r5", "CronCreate", { cron: "1 * * * *", prompt: "five" }),
          tu("r6", "CronCreate", { cron: "2 * * * *", prompt: "six" }),
          tu("r7", "CronCreate", { cron: "3 * * * *", prompt: "seven" }),
          tu("r8", "CronCreate", { cron: "4 * * * *", prompt: "eight" }),
          tu("r9", "CronCreate", { cron: "5 * * * *", prompt: "nine" }),
          tu("r10", "CronCreate", { cron: "6 * * * *", prompt: "ten" }),
          tu("r11", "CronCreate", { cron: "7 * * * *", prompt: "eleven" }),
          tu("r12", "CronCreate", { cron: "8 * * * *", prompt: "twelve" }),
          tu("r13", "CronCreate", { cron: "9 * * * *", prompt: "thirteen" }),
          tu("r14", "CronCreate", { cron: "10 * * * *", prompt: "fourteen" }),
          tu("r15", "CronCreate", { cron: "11 * * * *", prompt: "fifteen" }),
          tu("r16", "CronCreate", { cron: "12 * * * *", prompt: "sixteen" }),
        ),
      },
      {
        clock: 20,
        message: user(
          [
            tr("r1", [
              { type: "text", text: "Created job " },
              { type: "image", source: {} },
              { type: "text", text: "" },
              { type: "text", text: "x9Z (daily at 9am)." },
            ]),
            tr("r2", "No id in this text. session only"),
            tr("r3", "Failed", { is_error: true }),
            tr("r4", 42),
            tr("unknown", "job zz (never)"),
          ],
          { nextFireAt: 1.5 },
        ),
      },
      {
        clock: 30,
        message: user(
          [
            tr("r5", "JOB UPPER1 (Every minute) SESSION ONLY"),
            tr("r6", "job nbsp1 (nbsp)"),
            tr("r7", "job\u0085nel1 (next line) then job ok7 (fallback)"),
            tr("r8", "job﻿bom1 (bom)"),
            tr("r9", "job Kelvin (kelvin) ſession-only"),
            tr("r10", "job abc ( no close"),
            tr("r11", "job a_b (underscore) job c1(tight)"),
            tr("r12", "jobs abc (plural)"),
          ],
          { nextFireAt: -5 },
        ),
      },
      {
        clock: 40,
        message: user(
          [
            tr("r13", "job dup (first) session-Only"),
            tr("r14", "job dup (second)"),
            tr("r15", [{ type: "text", text: "job multi\n(line\nbreaks)" }]),
            tr("r16", "Job  spaced   (  padded  )"),
          ],
          { nextFireAt: "123" },
        ),
      },
    ],
  },
  {
    name: "cron-create-edge",
    title: "Edge",
    steps: [
      {
        clock: 100,
        message: assistant(
          tu("e1", "CronCreate", { cron: "", prompt: "empty" }),
          tu("e2", "CronCreate", { cron: 5, prompt: "number" }),
          tu("e3", "CronCreate", { cron: "* * * * *" }),
          tu("e4", "CronCreate", { cron: "* * * * *", prompt: 7, recurring: 1 }),
        ),
      },
      // Re-observed while pending: kept with its first startedAt.
      { clock: 200, message: assistant(tu("e3", "CronCreate", { cron: "1 1 * * *", prompt: "changed" })) },
      { clock: 300, message: user([tr("e3", "job edge1 (Every minute)")], { nextFireAt: 99 }) },
      { clock: 310, message: assistant(tu("del", "CronDelete", { id: "edge1" })) },
      // Re-observed after its promotion: pending again (the tracker only
      // dedupes pending entries), and a replayed result re-promotes it over
      // the cancelled entry, in place.
      { clock: 400, message: assistant(tu("e3", "CronCreate", { cron: "2 2 * * *", prompt: "again" })) },
      { clock: 500, message: user([tr("e3", "job edge1 (Every minute)")]) },
      // A pending entry whose result never comes stays pending.
      { clock: 600, message: user([tr("e4", "job e4id (x)")]) },
      // An empty tool_use id is a key like any other; a CronList job without
      // an id never refreshes it.
      { clock: 700, message: assistant(tu("", "CronCreate", { cron: "5 5 * * *", prompt: "blank" })) },
      { clock: 710, message: user([tr("", "no id here")]) },
      { clock: 720, message: assistant(tu("e_list", "CronList", {})) },
      { clock: 730, message: user([tr("e_list", "1 job")], { jobs: [{ id: "", nextFireAt: 77 }] }) },
    ],
  },
  {
    // SDK 0.3.299 / CC 2.1.311 \u2014 `nextFireAt` comes from the CronCreate
    // result's own `tool_use_result` only (the CronList refresh is gone).
    name: "cron-next-fire",
    title: "Next fire",
    steps: [
      {
        clock: 900,
        message: assistant(
          tu("n1", "CronCreate", { cron: "1 * * * *", prompt: "a" }),
          tu("n2", "CronCreate", { cron: "2 * * * *", prompt: "b" }),
          tu("n3", "CronCreate", { cron: "3 * * * *", prompt: "c" }),
          tu("n4", "CronCreate", { cron: "4 * * * *", prompt: "d" }),
          tu("n5", "CronCreate", { cron: "5 * * * *", prompt: "e" }),
          tu("n6", "CronCreate", { cron: "6 * * * *", prompt: "f" }),
          tu("n7", "CronCreate", { cron: "7 * * * *", prompt: "g" }),
        ),
      },
      // A positive finite number is taken; 0, negative, non-numeric,
      // Infinity and NaN are not. One `tool_use_result` serves every
      // tool_result in the message, as on the wire.
      { clock: 910, message: user([tr("n1", "job nf1 (hourly)")], { nextFireAt: 1700000000000 }) },
      { clock: 920, message: user([tr("n2", "job nf2 (hourly)")], { nextFireAt: 0 }) },
      { clock: 930, message: user([tr("n3", "job nf3 (hourly)")], { nextFireAt: 1e400 }) },
      { clock: 940, message: user([tr("n4", "job nf4 (hourly)")], { nextFireAt: NaN }) },
      { clock: 950, message: user([tr("n5", "job nf5 (hourly)")], { nextFireAt: null }) },
      // A non-object `tool_use_result`, and one with no such key.
      { clock: 960, message: user([tr("n6", "job nf6 (hourly)")], "text") },
      { clock: 970, message: user([tr("n7", "job nf7 (hourly)")], { other: 5 }) },
      // A CronList afterwards changes nothing now.
      { clock: 980, message: assistant(tu("n_list", "CronList", {})) },
      {
        clock: 990,
        message: user([tr("n_list", "7 jobs")], {
          jobs: [
            { id: "nf1", nextFireAt: 42 },
            { id: "nf2", nextFireAt: 99 },
          ],
        }),
      },
    ],
  },
  {
    name: "wakeup-chain",
    title: "Chain",
    steps: [
      {
        clock: 2000,
        message: assistant(tu("w1", "ScheduleWakeup", { delaySeconds: 60, reason: "watch CI", prompt: "/loop x", noop: false })),
      },
      {
        clock: 2100,
        message: result({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: 2.5 }),
      },
      // Nothing pending: the next result attaches nothing.
      { clock: 2150, message: result({ input_tokens: 1 }) },
      { clock: 2200, message: assistant(tu("w2", "ScheduleWakeup", { delaySeconds: 120.5, reason: "quiet", prompt: "/loop x", noop: true })) },
      { clock: 2300, message: assistant(tu("w3", "ScheduleWakeup", { delaySeconds: "60", reason: 5, prompt: "/loop x", noop: true })) },
      { clock: 2350, message: result() },
      { clock: 2400, message: assistant(tu("w4", "ScheduleWakeup", { delaySeconds: 1800, prompt: "/loop x", noop: "true" })) },
      { clock: 2450, message: result({ input_tokens: 3, output_tokens: 4 }) },
      // The live one, re-observed: skipped.
      { clock: 2500, message: assistant(tu("w4", "ScheduleWakeup", { delaySeconds: 5, prompt: "other", noop: true })) },
      // A superseded one, re-observed: armed again over the live one (its
      // tick row is already there; the attribution is queued again).
      { clock: 2600, message: assistant(tu("w2", "ScheduleWakeup", { delaySeconds: 120.5, reason: "quiet", prompt: "/loop x", noop: true })) },
      { clock: 2700, message: result({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 7 }) },
      // Two in one message: the second supersedes the first.
      {
        clock: 2800,
        message: assistant(
          tu("w5", "ScheduleWakeup", { delaySeconds: 60, prompt: "a", noop: true }),
          tu("w6", "ScheduleWakeup", { delaySeconds: 60, prompt: "b", noop: true }),
        ),
      },
      { clock: 2900, message: result({ input_tokens: 2, output_tokens: 2 }) },
      { clock: 3000, message: assistant(tu("w7", "ScheduleWakeup", {})) },
    ],
  },
  {
    name: "wakeup-stop",
    title: undefined,
    steps: [
      { clock: 5, at: 100, message: assistant(tu("s_w1", "ScheduleWakeup", { delaySeconds: 60, prompt: "p", noop: true })) },
      { clock: 6, at: 120, message: assistant(tu("s_c1", "CronCreate", { cron: "* * * * *", prompt: "c" })) },
      { clock: 7, at: 130, message: user([tr("s_c1", "job keep1 (Every minute)")]) },
      // Issued before the wake-up was armed: it can't stop it.
      { clock: 8, at: 50, message: assistant(tu("s_stop0", "ScheduleWakeup", { stop: true })) },
      { clock: 9, at: 200, message: assistant(tu("s_stop1", "ScheduleWakeup", { stop: true, delaySeconds: 60 })) },
      { clock: 10, at: 300, message: assistant(tu("s_w2", "ScheduleWakeup", { delaySeconds: 30, prompt: "p2", noop: true })) },
      // The same stop, replayed after a newer arm: applied once only.
      { clock: 11, at: 200, message: assistant(tu("s_stop1", "ScheduleWakeup", { stop: true })) },
      { clock: 12, at: 400, message: assistant(tu("s_stop0", "ScheduleWakeup", { stop: true })) },
      // Not a strict `true`: an arm.
      { clock: 13, at: 500, message: assistant(tu("s_stop2", "ScheduleWakeup", { stop: "true", delaySeconds: 9, prompt: "p3" })) },
      { clock: 14, at: 600, message: assistant(tu("s_d1", "CronDelete", { id: "s_stop2" })) },
      // A cancelled wake-up neither feeds the streak nor gets superseded.
      { clock: 15, at: 700, message: assistant(tu("s_w3", "ScheduleWakeup", { delaySeconds: 30, prompt: "p4", noop: true })) },
      { clock: 16, at: 800, message: assistant(tu("s_stop3", "ScheduleWakeup", { stop: true })) },
    ],
  },
  {
    name: "ignored",
    title: "Ignored",
    steps: [
      { clock: 1, message: { type: "system", subtype: "init" } },
      { clock: 2, message: { type: "assistant", message: { content: "CronCreate" } } },
      { clock: 3, message: { type: "assistant" } },
      { clock: 4, message: { type: "assistant", message: { content: [tr("x", "job a (b)"), { type: "text", text: "hi" }] } } },
      {
        clock: 5,
        message: assistant(
          tu("i1", "cronCreate", { cron: "* * * * *", prompt: "lower" }),
          tu("i2", "ScheduleWakeUp", { delaySeconds: 1 }),
          tu("i3", "Bash", { command: "ls" }),
        ),
      },
      { clock: 6, message: user([tu("i4", "CronCreate", { cron: "* * * * *" })]) },
      { clock: 7, message: { type: "user", message: { content: "job a (b)" } } },
      { clock: 8, message: { type: "result", subtype: "error_during_execution" } },
      { clock: 9, message: { type: "stream_event", message: { content: [tu("i5", "CronCreate", { cron: "* * * * *" })] } } },
    ],
  },
];

const scenarios = [];
for (const sc of SCENARIOS) {
  const sid = `golden-${sc.name}`;
  const s = bareSession(sid, sc.title);
  const after = [];
  for (const step of sc.steps) {
    clock = step.clock;
    s.trackScheduledLoops(step.message, step.at);
    await settle();
    // Copied now: the entries are live objects a later step mutates.
    const copy = (v) => JSON.parse(JSON.stringify(v));
    after.push({
      loops: copy(s.getScheduledLoops()),
      pending: copy([...s.pendingScheduledLoops.values()]),
      stops: [...s.appliedWakeupStops],
      attribution: [...s.pendingLoopTickAttribution],
      ticks: storedRows(sid),
    });
  }
  scenarios.push({ name: sc.name, sessionId: sid, title: sc.title ?? null, steps: sc.steps, after });
}

const fixture = { db: { sessionId: dbSid, steps: DB_STEPS, after: dbAfter }, breakdown, scenarios };
writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
console.log(`wrote ${out}: ${DB_STEPS.length} db steps, ${RAW.length} raw rows, ${scenarios.length} scenarios`);
process.exit(0);
