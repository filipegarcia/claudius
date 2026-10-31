#!/usr/bin/env node
// Golden fixture for the notification bus (G01a): the real
// `lib/server/notification-bus.ts` and the inbox half of
// `lib/server/notifications-db.ts`, on the real migrations:
//
//   node rust/scripts/notification-bus-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself twice under `--experimental-transform-types` with the repo
// as its cwd (db.ts reads the migrations from there), HOME and
// CLAUDE_CONFIG_DIR in a temp root and a resolve hook for the `@/` imports;
// both recordings must agree byte for byte. Stubbed, so the replay can pin
// the same values:
// * `Date.now`: `clock += tick; return clock`, with `clock` / `tick` set by
//   the steps (tick 0 keeps it constant), except for db.ts's one-shot
//   `applyPostMigrationCleanups`, which gets BASE and isn't counted (no
//   database here holds the rows it sweeps). Each step records the clock it
//   left, so the replay checks how many times it was read.
// * `crypto.randomUUID`: a counter (`00000000-0000-4000-a000-<n>`), also
//   recorded after each step.
// * `setTimeout` / `clearTimeout`: a manual queue. The bus's coalesced
//   `state` flushes wait for a `flush` step, which runs every queued timer in
//   order and records what they threw.
//
// `scenarios` run in order on the one bus singleton, each from
// `resetForTests()` with its own subscribers, workspaces.json (text and an
// explicit mtime, which is what the bus's cwd cache keys on) and cwds. A step
// is a bus call, a notifications-db call, hand-written SQL, a workspaces.json
// write, `flush`, `reset`, `sub` / `unsub`. Each records `got` (the return
// value through `JSON.stringify`, or `threw`), `envs` (what each subscriber
// received since the step before, as `JSON.stringify` values), the clock and
// id counter it left, and, when they changed, the rows of each watched cwd's
// database (`rows`: per column its SQLite type and value, text and blobs as
// hex, read on a connection of its own; null when there is no file, "dir"
// when the path is a directory; after the first dump only `{len, changed}`,
// the rows that are new or differ) and which handles db.ts has cached for it
// (`cached`: [readwrite, readonly]). Each scenario restarts the id counter.
//
// `pure` holds direct calls of the exported `isKindEnabled` and
// `mapEventToKind`.
//
// Written to rust/crates/claudius-core/tests/fixtures/notification_bus_golden.json;
// replayed by crates/claudius-core/tests/notification_bus_golden.rs.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire, register, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/notification_bus_golden.json");

if (!process.env.NB_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "notification-bus-golden-")));
    try {
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "config"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            NB_GOLDEN_CHILD: root,
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
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.scenarios.reduce((n, s) => n + s.steps.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.scenarios.length} scenarios, ${steps} steps, ` +
      `${fixture.pure.length} pure (stable)`,
  );
  process.exit(0);
}

const ROOT_DIR = process.env.NB_GOLDEN_CHILD;
const HOME = process.env.HOME;

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
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !s.includes(":") && !s.startsWith(".")) return next(s + ".js", ctx);
    throw e;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

// ------------------------------- stubs -------------------------------

const BASE = 1_700_000_000_000;
let clock = BASE;
let tick = 0;
Date.now = () => {
  if ((new Error().stack ?? "").includes("applyPostMigrationCleanups")) return BASE;
  clock += tick;
  return clock;
};

let ids = 0;
const uuid = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const crypto = createRequire(import.meta.url)("node:crypto");
crypto.randomUUID = () => uuid(++ids);
syncBuiltinESMExports();

const timers = [];
globalThis.setTimeout = (fn) => {
  const handle = { fn };
  timers.push(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  const i = timers.indexOf(handle);
  if (i >= 0) timers.splice(i, 1);
};
/** Run every queued timer in order; what they threw. */
function runTimers() {
  const threw = [];
  while (timers.length > 0) {
    const { fn } = timers.shift();
    try {
      fn();
    } catch (e) {
      threw.push(e instanceof Error ? e.message : String(e));
    }
  }
  return threw;
}

const { default: Database } = await import("better-sqlite3");
const { getCachedDb, openDb } = await import(join(repo, "lib/server/db.ts"));
const ndb = await import(join(repo, "lib/server/notifications-db.ts"));
const { notificationBus, isKindEnabled, mapEventToKind } = await import(join(repo, "lib/server/notification-bus.ts"));

// ------------------------------- the world -------------------------------

const WS_FILE = join(HOME, ".claude", ".claudius", "workspaces.json");
const dbPath = (cwd) => join(HOME, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), ".claudius.db");

const COLS = ["id", "session_id", "run_id", "job_id", "kind", "title", "body", "payload", "request_id", "created_at", "read_at"];
const ROWS_SQL = `SELECT ${COLS.map(
  (c) => `typeof(${c}), CASE typeof(${c}) WHEN 'integer' THEN CAST(${c} AS TEXT) WHEN 'real' THEN ${c} ELSE hex(${c}) END`,
).join(", ")} FROM notifications ORDER BY rowid`;
/** The notifications rows of `cwd`'s database, read on a connection of its own. */
function dump(cwd) {
  const path = dbPath(cwd);
  if (!existsSync(path)) return null;
  if (statSync(path).isDirectory()) return "dir";
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(ROWS_SQL)
      .raw()
      .all()
      .map((r) => COLS.map((_, i) => [r[2 * i], r[2 * i + 1]]));
  } catch (e) {
    return { threw: e.message };
  } finally {
    db.close();
  }
}
const cachedOf = (cwd) => [!!getCachedDb(cwd, "readwrite"), !!getCachedDb(cwd, "readonly")];

/** Hand-written SQL on `cwd`'s database: through openDb (migrated, cached), or `fresh` on a bare file. */
async function runSql(cwd, sql, fresh) {
  if (fresh) {
    const path = dbPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(sql);
    db.close();
  } else {
    (await openDb(cwd)).exec(sql);
  }
}

function writeWs(text, mtime) {
  mkdirSync(dirname(WS_FILE), { recursive: true });
  if (text === null) {
    rmSync(WS_FILE, { force: true });
    return;
  }
  writeFileSync(WS_FILE, text);
  utimesSync(WS_FILE, mtime, mtime);
}

// ------------------------------- step constructors -------------------------------

const ALL_KINDS = [
  "permission_request",
  "ask_user_question",
  "plan_approval_request",
  "session_idle",
  "scheduled_run_finished",
  "session_error",
];
/** A workspaces.json entry. */
const W = (id, rootPath, defaults) => ({
  id,
  name: `ws ${id}`,
  rootPath,
  icon: { kind: "letter", letter: "W", color: "#5588dd" },
  createdAt: 1,
  updatedAt: 1,
  ...(defaults === undefined ? {} : { defaults }),
});
const allOn = { notifications: { enabledKinds: ALL_KINDS } };
let mtime = 1_000_000;
/** Write workspaces.json; `same` keeps the last mtime (the bus's cache key). */
const WS = (list, { same = false, raw } = {}) => {
  if (!same) mtime += 10;
  return { op: "ws", text: raw ?? JSON.stringify({ version: 1, workspaces: list }), mtime };
};
const RMWS = () => ({ op: "ws", text: null, mtime: 0 });
const REC = (cwd, sid, event, opts) => ({ op: "record", cwd, sid, event, ...(opts ? { opts } : {}) });
const SCHED = (cwd, runId, jobId, event) => ({ op: "sched", cwd, runId, jobId, event });
const INPUT = (sid, at) => ({ op: "input", sid, ...(at === undefined ? {} : { at }) });
const FLUSH = { op: "flush" };
const SQL = (cwd, sql, fresh = false) => ({ op: "sql", cwd, sql, ...(fresh ? { fresh } : {}) });
const AT = (c, t = 0) => ({ op: "clock", clock: c, tick: t });
const perm = (requestId, extra = {}) => ({
  type: "permission_request",
  requestId,
  toolName: "Bash",
  toolUseId: `tu-${requestId}`,
  input: { command: "ls" },
  title: `Run ${requestId}`,
  ...extra,
});
const err = (message) => ({ type: "error", message });
const sdkResult = (extra = {}) => ({ type: "sdk", message: { type: "result", subtype: "success", ...extra } });
const ins = (cwd, row) => {
  const cols = Object.keys(row);
  return SQL(cwd, `INSERT INTO notifications (${cols.join(", ")}) VALUES (${cols.map((c) => row[c]).join(", ")});`);
};
const insPrefs = (cwd, sid, blocked, snooze) =>
  SQL(cwd, `INSERT INTO session_notification_prefs(session_id, blocked, snooze_until) VALUES ('${sid}', ${blocked}, ${snooze});`);
const NEWER_SCHEMA =
  "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999');";

// ------------------------------- scenarios -------------------------------

const scenarios = [];
const S = (name, watch, steps, subs = 2) => scenarios.push({ name, watch, subs, steps });

// The kinds, dedupe, status sync, the idle heuristic.
{
  const A = "/g/kinds/a";
  const B = "/g/kinds/b";
  S("kinds", [A, B], [
    WS([W("wks_ka", A, {}), W("wks_kb", B, allOn)]),
    AT(BASE + 1_000),
    REC(A, "s1", perm("r1")),
    FLUSH,
    REC(A, "s1", perm("r1", { title: "again" })),
    FLUSH,
    REC(A, "s1", perm("r2", { title: undefined })),
    REC(A, "s1", perm("r3", { title: null })),
    REC(A, "s2", { type: "mcp_elicitation_request", requestId: "r4", serverName: "Linear", mode: "url", message: "  Sign in to Linear\r\nsecond line" }),
    REC(A, "s2", { type: "mcp_elicitation_request", requestId: "r5", serverName: "GitHub", mode: "form", message: "" }),
    REC(A, "s2", { type: "ask_user_question", requestId: "r6", toolUseId: "tu6", questions: [{ question: "Which one?", header: "Pick" }, { question: "second" }] }),
    REC(A, "s2", { type: "ask_user_question", requestId: "r7", toolUseId: "tu7", questions: [] }),
    REC(A, "s2", { type: "plan_approval_request", requestId: "r8", toolUseId: "tu8", plan: "# The plan\n\n1. step" }),
    FLUSH,
    REC(A, "s1", err("boom")),
    REC(B, "s1", err("boom")),
    REC(B, "s1", err("  Claude Code process aborted by user \n")),
    REC(B, "s1", err("Claude Code process aborted by user!")),
    FLUSH,
    REC(B, "s1", sdkResult()),
    FLUSH,
    INPUT("s1", 0),
    REC(B, "s1", sdkResult(), { sessionTitle: "zero" }),
    INPUT("s1"),
    REC(B, "s1", sdkResult(), { sessionTitle: "My tab" }),
    REC(B, "s1", sdkResult()),
    REC(B, "s1", sdkResult(), { sessionTitle: "" }),
    REC(B, "s1", sdkResult(), { hasActiveBackgroundWork: true }),
    REC(B, "s1", sdkResult(), { hasActiveBackgroundWork: false, sessionTitle: "bg done" }),
    REC(B, "s3", sdkResult(), { sessionTitle: "never typed" }),
    INPUT("s3", -5),
    REC(B, "s3", sdkResult(), { sessionTitle: "negative input time" }),
    FLUSH,
    REC(B, "s1", { type: "sdk", message: { type: "assistant", message: { content: [] } } }),
    FLUSH,
    REC(B, "s1", { type: "sdk", message: { type: "result", parent_tool_use_id: "toolu_1" } }),
    FLUSH,
    REC(B, "s1", { type: "sdk", message: { type: "result", parent_tool_use_id: null } }, { sessionTitle: "null parent" }),
    REC(B, "s1", { type: "sdk", message: { type: "assistant", parent_tool_use_id: "toolu_2" } }),
    FLUSH,
    REC(B, "s1", { type: "turn_status", status: "idle" }),
    REC(B, "s1", { type: "ready", sessionId: "s1" }),
    FLUSH,
    REC(B, "s1", { type: "ready" }),
    FLUSH,
    REC(B, "s1", { type: "mode_changed", mode: "plan" }),
    REC(B, "s1", { type: "session_title", title: "x" }),
    REC(B, "s1", { type: "foo" }),
    FLUSH,
    REC("/g/kinds/none", "s1", perm("r9")),
    REC("/g/kinds/none", "s1", { type: "turn_status", status: "idle" }),
    FLUSH,
    REC(B, "", err("no session id")),
    REC(B, "", { type: "turn_status", status: "running" }),
    FLUSH,
    REC(B, "", { type: "turn_status", status: "idle" }),
    FLUSH,
    { op: "list", ws: "wks_kb" },
    { op: "list", ws: "wks_ka", opts: { limit: 3 } },
    { op: "state", ws: "wks_ka" },
    { op: "states" },
    { op: "state", ws: "wks_nope" },
  ]);
}

// Scheduler rows.
{
  const A = "/g/sched/a";
  const B = "/g/sched/b";
  S("scheduler", [A, B], [
    WS([W("wks_sa", A), W("wks_sb", B, allOn)]),
    AT(BASE + 2_000, 1),
    SCHED(B, "run1", "job1", { type: "run_finished", status: "success", costUsd: 0.25, note: "all done" }),
    SCHED(B, "run2", "job1", { type: "run_finished", status: "failed", costUsd: 0 }),
    SCHED(B, "run3", "job1", { type: "run_finished" }),
    SCHED(B, "run4", "job2", { type: "run_finished", status: "error", costUsd: 1e21, note: null }),
    SCHED(B, "run5", "job2", err("Claude Code process aborted by user")),
    SCHED(B, "", "job2", err("Claude Code process aborted by user")),
    SCHED(B, "", "job2", err("plain")),
    SCHED(B, "run6", "job2", sdkResult()),
    SCHED(B, "run7", "job2", perm("sr1")),
    SCHED(B, "run7", "job2", { type: "turn_status", status: "idle" }),
    FLUSH,
    SCHED(A, "run8", "job3", { type: "run_finished", status: "success" }),
    SCHED(A, "run8", "job3", err("scheduler errors are opt-in")),
    FLUSH,
    SCHED(B, "run9", "job3", { type: "turn_status", status: "idle" }),
    FLUSH,
    { op: "list", ws: "wks_sb", opts: { limit: 20 } },
  ]);
}

// Coalescing, reset, the request-id and orphan sweeps.
{
  const C = "/g/co/c";
  const D = "/g/co/d";
  const Z = "/g/co/unmapped";
  S("coalesce", [C, D, Z], [
    WS([W("wks_cc", C), W("wks_cd", D)]),
    AT(BASE + 3_000),
    REC(C, "s1", perm("c1")),
    REC(C, "s1", perm("c2")),
    REC(C, "s2", perm("c3")),
    FLUSH,
    FLUSH,
    REC(C, "s1", perm("c4")),
    { op: "byRequest", cwd: C, rid: "c4" },
    FLUSH,
    { op: "byRequest", cwd: C, rid: "c4" },
    { op: "byRequest", cwd: C, rid: "unknown" },
    { op: "byRequest", cwd: C, rid: "" },
    FLUSH,
    REC(C, "s1", perm("c5")),
    FLUSH,
    { op: "byRequest", cwd: C, rid: "c5" },
    FLUSH,
    REC(D, "s9", perm("d1")),
    REC(C, "s1", perm("c6")),
    REC(D, "s9", perm("d2")),
    FLUSH,
    REC(C, "s1", perm("c7")),
    { op: "reset" },
    FLUSH,
    { op: "sub" },
    REC(C, "s1", perm("c8")),
    FLUSH,
    { op: "sweep", cwd: C, sid: "s1" },
    FLUSH,
    { op: "sweep", cwd: C, sid: "s1" },
    { op: "sweep", cwd: C, sid: "" },
    FLUSH,
    REC(C, "s2", err("not enabled")),
    INPUT("s2"),
    REC(C, "s2", sdkResult(), { sessionTitle: "s2 idle" }),
    { op: "sweep", cwd: C, sid: "s2" },
    FLUSH,
    { op: "sweep", cwd: Z, sid: "s1" },
    { op: "byRequest", cwd: Z, rid: "c1" },
    FLUSH,
    { op: "byRequest", cwd: "/g/co/never", rid: "c1" },
    { op: "unsub", index: 0 },
    REC(D, "s9", perm("d3")),
    FLUSH,
    { op: "states" },
  ]);
}

// Background suppression of the toast-only event.
{
  const A = "/g/bg/a";
  S("background", [A], [
    WS([W("wks_bg", A, allOn)]),
    AT(BASE + 4_000),
    INPUT("s1"),
    REC(A, "s1", sdkResult(), { hasSubscribers: false, sessionTitle: "bg" }),
    REC(A, "s1", err("bg error"), { hasSubscribers: false }),
    REC(A, "s1", perm("b1"), { hasSubscribers: false }),
    REC(A, "s1", { type: "ask_user_question", requestId: "b2", questions: [{ question: "?" }] }, { hasSubscribers: false }),
    FLUSH,
    REC(A, "s1", sdkResult(), { hasSubscribers: true, sessionTitle: "fg" }),
    REC(A, "s1", err("fg error"), { hasSubscribers: true }),
    REC(A, "s1", err("unknown subscribers")),
    REC(A, "", err("no session, no subscribers"), { hasSubscribers: false }),
    FLUSH,
    { op: "list", ws: "wks_bg", opts: { limit: 50 } },
  ]);
}

// Workspace prefs: master switch, enabledKinds shapes.
{
  const C = (n) => `/g/filters/${n}`;
  const cases = [
    ["off", { notifications: { enabled: false, enabledKinds: ALL_KINDS } }],
    ["offString", { notifications: { enabled: "false" } }],
    ["empty", { notifications: { enabledKinds: [] } }],
    ["string", { notifications: { enabledKinds: "session_error,permission_request" } }],
    ["number", { notifications: { enabledKinds: 5 } }],
    ["object", { notifications: { enabledKinds: { 0: "permission_request" } } }],
    ["nullKinds", { notifications: { enabledKinds: null } }],
    ["notifString", { notifications: "x" }],
    ["notifNull", { notifications: null }],
    ["defaultsNumber", 7],
    ["defaultsNull", null],
    ["defaultsArray", []],
  ];
  const steps = [WS(cases.map(([n, d]) => W(`wks_f_${n}`, C(n), d))), AT(BASE + 5_000)];
  for (const [n] of cases) {
    steps.push(
      REC(C(n), "s1", perm(`f-${n}`)),
      REC(C(n), "s1", err(`err ${n}`)),
      FLUSH,
      REC(C(n), "s1", { type: "turn_status", status: "idle" }),
      FLUSH,
    );
  }
  S("filters", cases.map(([n]) => C(n)), steps, 1);
}

// Per-session mute through the S24 prefs rows, on a counting clock.
{
  const A = "/g/mute/a";
  const N = "/g/mute/noprefs";
  S("mute", [A, N], [
    WS([W("wks_m", A), W("wks_mn", N)]),
    AT(BASE + 6_000, 1),
    SQL(A, "SELECT 1"),
    insPrefs(A, "blocked", 1, "NULL"),
    insPrefs(A, "blockedPast", 1, BASE),
    insPrefs(A, "future", 0, BASE + 6_100),
    insPrefs(A, "past", 0, BASE),
    insPrefs(A, "text", 0, "'abc'"),
    insPrefs(A, "textNum", 0, `'${BASE + 7_000}'`),
    insPrefs(A, "inf", 0, "9e999"),
    insPrefs(A, "edge", 0, BASE + 6_050),
    ...["blocked", "blockedPast", "future", "past", "text", "textNum", "inf", "none"].flatMap((sid) => [
      REC(A, sid, perm(`m-${sid}`)),
      FLUSH,
    ]),
    AT(BASE + 6_050, 0),
    REC(A, "edge", perm("m-edge")),
    AT(BASE + 6_049, 0),
    REC(A, "edge", perm("m-edge2")),
    FLUSH,
    SQL(N, "DROP TABLE session_notification_prefs;"),
    AT(BASE + 6_200, 1),
    REC(N, "s1", perm("m-noprefs")),
    FLUSH,
    AT(BASE + 6_300, 1),
    INPUT("s1"),
    INPUT("s2", 5),
  ]);
}

// Reads: list paging, the cross-workspace merge, the mark-read family, states.
{
  const R = "/g/reads/r";
  const R2 = "/g/reads/r2";
  const E = "/g/reads/empty";
  const steps = [WS([W("wks_r", R, allOn), W("wks_r2", R2, allOn), W("wks_re", E)])];
  const at = [10, 20, 20, 30, 40, 40, 50];
  at.forEach((t, i) => {
    steps.push(AT(BASE + t), REC(i % 2 ? R2 : R, `s${i % 3}`, i % 3 === 0 ? perm(`q${i}`) : err(`e${i}`)));
  });
  steps.push(
    AT(BASE + 40),
    INPUT("s1"),
    REC(R, "s1", sdkResult(), { sessionTitle: "idle r" }),
    REC(R2, "s1", sdkResult(), { sessionTitle: "idle r2" }),
    FLUSH,
    { op: "list", ws: "wks_r" },
    ...[2, 0, -5, 2.5, 3, 1000, 1e300, null].map((limit) => ({ op: "list", ws: "wks_r", opts: { limit } })),
    { op: "list", ws: "wks_r", opts: { before: BASE + 40 } },
    { op: "list", ws: "wks_r", opts: { before: BASE + 40.5, limit: 1 } },
    { op: "list", ws: "wks_r", opts: { before: 0 } },
    { op: "list", ws: "wks_r", opts: { before: 1 } },
    { op: "list", ws: "wks_r", opts: { unreadOnly: true } },
    { op: "list", ws: "wks_re" },
    { op: "list", ws: "wks_unknown" },
    { op: "across" },
    { op: "across", opts: { limit: 3 } },
    { op: "across", opts: { limit: 4, unreadOnly: true } },
    { op: "across", opts: { limit: 2.5 } },
    { op: "across", opts: { limit: 0 } },
    AT(BASE + 100, 1),
    { op: "read", ws: "wks_r", ids: [] },
    { op: "read", ws: "wks_r", ids: [uuid(1)] },
    FLUSH,
    { op: "read", ws: "wks_r", ids: [uuid(1)] },
    { op: "read", ws: "wks_r", ids: ["nope"] },
    { op: "read", ws: "wks_r2", ids: [uuid(1)] },
    { op: "read", ws: "wks_unknown", ids: [uuid(2)] },
    { op: "read", ws: "wks_r", ids: [uuid(3), uuid(5), uuid(7), "x"] },
    FLUSH,
    { op: "across", opts: { unreadOnly: true } },
    { op: "bySession", ws: "wks_r", sid: "s0" },
    { op: "bySession", ws: "wks_r", sid: "s1" },
    { op: "bySession", ws: "wks_r", sid: "" },
    { op: "bySession", ws: "wks_unknown", sid: "s1" },
    FLUSH,
    { op: "byKind", ws: "wks_r2", kind: "session_idle" },
    { op: "byKind", ws: "wks_r2", kind: "" },
    { op: "byKind", ws: "wks_r2", kind: "nonsense" },
    FLUSH,
    { op: "state", ws: "wks_r2" },
    { op: "state", ws: "wks_r2" },
    { op: "state", ws: "wks_re" },
    { op: "states" },
    { op: "readAll", ws: "wks_r" },
    { op: "readAll", ws: "wks_r" },
    { op: "readAll", ws: "wks_re" },
    { op: "readAll", ws: "wks_unknown" },
    FLUSH,
    { op: "list", ws: "wks_r", opts: { unreadOnly: true } },
    { op: "states" },
  );
  S("reads", [R, R2, E], steps);
}

// notifications-db called directly.
{
  const A = "/g/db/a";
  const NO = "/g/db/nodb";
  S("db", [A, NO], [
    AT(BASE + 7_000, 1),
    { op: "db.list", cwd: NO, ws: "w" },
    { op: "db.count", cwd: NO },
    { op: "db.perSession", cwd: NO },
    { op: "db.get", cwd: NO, ws: "w", id: "x" },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { kind: "session_error", title: "t" } },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { id: "fixed-id", sessionId: "s1", runId: "r", jobId: "j", kind: "permission_request", title: "t2", body: "b", payload: { a: 1, b: [1.5, "x"], "2": true, "1": null }, requestId: "req", createdAt: 42.5 } },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { id: "other", kind: "permission_request", title: "dup", requestId: "req" } },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { id: "fixed-id", kind: "session_idle", title: "same id" } },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { kind: "session_idle", title: "empty payload", payload: {}, sessionId: null, body: null } },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { kind: "session_idle", title: "zero created", createdAt: 0 } },
    { op: "db.list", cwd: A, ws: "wks_db" },
    { op: "db.list", cwd: A, ws: "other_ws", opts: { limit: 2, unreadOnly: true } },
    { op: "db.count", cwd: A },
    { op: "db.perSession", cwd: A },
    { op: "db.get", cwd: A, ws: "wks_db", id: "fixed-id" },
    { op: "db.get", cwd: A, ws: "wks_db", id: "missing" },
    { op: "db.read", cwd: A, ids: [] },
    { op: "db.read", cwd: A, ids: ["fixed-id", "fixed-id", "missing"] },
    { op: "db.read", cwd: NO, ids: [] },
    { op: "db.byKind", cwd: A, kind: "" },
    { op: "db.byKind", cwd: A, kind: "session_idle" },
    { op: "db.bySession", cwd: A, sid: "" },
    { op: "db.actionable", cwd: A, sid: "" },
    { op: "db.byRequest", cwd: A, rid: "" },
    { op: "db.byRequest", cwd: A, rid: "nope" },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { sessionId: "s1", kind: "ask_user_question", title: "q", requestId: "req2" } },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { sessionId: "s1", kind: "session_error", title: "e" } },
    { op: "db.bySession", cwd: A, sid: "s1" },
    { op: "db.actionable", cwd: A, sid: "s1" },
    { op: "db.actionable", cwd: A, sid: "s1" },
    { op: "db.byRequest", cwd: A, rid: "req2" },
    { op: "db.readAll", cwd: A },
    { op: "db.readAll", cwd: A },
    { op: "db.count", cwd: A },
    { op: "db.readAll", cwd: NO },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { kind: "session_error", title: "object body", body: { a: 1 } } },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { kind: "session_error", title: "array body", body: [1, 2] } },
    { op: "db.insert", cwd: A, ws: "wks_db", input: { kind: "session_error", title: "bool body", body: true } },
  ]);
}

// Rows another writer stored, and a table created with other column types.
{
  const F = "/g/foreign/f";
  const L = "/g/foreign/loose";
  const G = "/g/foreign/g";
  const row = (o) => ({
    id: "'f'",
    session_id: "NULL",
    run_id: "NULL",
    job_id: "NULL",
    kind: "'session_error'",
    title: "'t'",
    body: "NULL",
    payload: "NULL",
    request_id: "NULL",
    created_at: "1",
    read_at: "NULL",
    ...o,
  });
  S("foreign", [F, L, G], [
    WS([W("wks_ff", F, allOn), W("wks_fl", L, allOn), W("wks_fg", G, allOn)]),
    AT(BASE + 8_000),
    SQL(F, "SELECT 1"),
    ins(F, row({ id: "'p-obj'", payload: `'{"b":1,"a":[1.0,1e2,1e21],"10":"ten","2":"two","__proto__":{"x":1},"b":2}'`, created_at: "100" })),
    ins(F, row({ id: "'p-arr'", payload: "'[1,2]'", created_at: "101" })),
    ins(F, row({ id: "'p-num'", payload: "'5'", created_at: "102" })),
    ins(F, row({ id: "'p-bad'", payload: "'{nope'", created_at: "103" })),
    ins(F, row({ id: "'p-empty'", payload: "''", created_at: "104" })),
    ins(F, row({ id: "'p-null-json'", payload: "'null'", created_at: "105" })),
    ins(F, row({ id: "'p-blob'", payload: `X'${Buffer.from('{"blob":true}').toString("hex")}'`, created_at: "106" })),
    ins(F, row({ id: "'p-int'", payload: "7", created_at: "107" })),
    ins(F, row({ id: "'p-zero'", payload: "0", created_at: "108" })),
    ins(F, row({ id: "'p-ws'", payload: `' \n{"ws":1} '`, created_at: "109" })),
    ins(F, row({ id: "'c-real'", created_at: "110.75" })),
    ins(F, row({ id: "'c-text'", created_at: "'111'" })),
    ins(F, row({ id: "'c-big'", created_at: "9007199254740993" })),
    ins(F, row({ id: "'c-inf'", created_at: "9e999", read_at: "-9e999" })),
    ins(F, row({ id: "'c-null'", created_at: "NULL" })),
    ins(F, row({ id: "'c-blob'", created_at: "X'313132'" })),
    ins(F, row({ id: "7", session_id: "10", kind: "'weird_kind'", title: "X'00ff'", body: "2.5", created_at: "112" })),
    ins(F, row({ id: "X'abcd'", session_id: "'2'", run_id: "3", job_id: "X'01'", body: "'b'", created_at: "113" })),
    ins(F, row({ id: "NULL", session_id: "X'6162'", created_at: "114" })),
    ins(F, row({ id: "'u8'", session_id: "CAST(X'C328' AS TEXT)", title: "CAST(X'F09F98' AS TEXT)", created_at: "115" })),
    ins(F, row({ id: "'ab'", session_id: "'ab'", created_at: "116" })),
    ins(F, row({ id: "'read-int'", read_at: "5", created_at: "119" })),
    ins(F, row({ id: "'read-real'", read_at: "1.5", created_at: "117" })),
    ins(F, row({ id: "'read-text'", read_at: "'yes'", created_at: "118" })),
    { op: "list", ws: "wks_ff", opts: { limit: 200 } },
    { op: "list", ws: "wks_ff", opts: { before: 112 } },
    { op: "list", ws: "wks_ff", opts: { unreadOnly: true, limit: 200 } },
    { op: "db.count", cwd: F },
    { op: "db.perSession", cwd: F },
    { op: "state", ws: "wks_ff" },
    { op: "db.get", cwd: F, ws: "wks_ff", id: "7" },
    { op: "db.get", cwd: F, ws: "wks_ff", id: "p-obj" },
    { op: "bySession", ws: "wks_ff", sid: "10" },
    { op: "bySession", ws: "wks_ff", sid: "2" },
    { op: "read", ws: "wks_ff", ids: ["7"] },
    { op: "byKind", ws: "wks_ff", kind: "weird_kind" },
    FLUSH,
    // Numeric created_at only: the cross-workspace sort is well defined.
    SQL(G, "SELECT 1"),
    ins(G, row({ id: "'g1'", created_at: "'115'" })),
    ins(G, row({ id: "'g2'", created_at: "NULL" })),
    ins(G, row({ id: "'g3'", created_at: "112.5" })),
    ins(G, row({ id: "'g4'", created_at: "9007199254740993" })),
    ins(G, row({ id: "'g5'", created_at: "-1" })),
    { op: "across", opts: { limit: 200 } },
    // A table without column affinities: bound values keep their JS types.
    SQL(L, [
      "DROP TABLE notifications;",
      "CREATE TABLE notifications (id PRIMARY KEY, session_id, run_id, job_id, kind, title, body, payload, request_id, created_at, read_at);",
    ].join("\n")),
    AT(BASE + 8_000.5),
    REC(L, "s1", perm("l1", { title: 12 })),
    REC(L, "s1", perm(5)),
    REC(L, "s1", perm("5")),
    FLUSH,
    { op: "list", ws: "wks_fl" },
    AT(BASE + 8_001.25),
    { op: "readAll", ws: "wks_fl" },
    { op: "list", ws: "wks_fl" },
    { op: "db.perSession", cwd: L },
    FLUSH,
  ]);
}

// Cold caches and broken databases.
{
  const K = "/g/cold/k";
  const K2 = "/g/cold/k2";
  const BRK = "/g/cold/broken";
  const OLD = "/g/cold/newer";
  const OFF = "/g/cold/off";
  S("cold", [K, K2, BRK, OLD, OFF], [
    WS([
      W("wks_k", K),
      W("wks_k2", K2),
      W("wks_brk", BRK, allOn),
      W("wks_old", OLD, allOn),
      W("wks_off", OFF, { notifications: { enabled: false } }),
      { id: "wks_noroot", name: "no root" },
      { id: "wks_numroot", rootPath: 42 },
    ]),
    AT(BASE + 9_000, 1),
    REC(OFF, "s1", { type: "turn_status", status: "idle" }),
    FLUSH,
    REC(K, "s1", { type: "turn_status", status: "idle" }),
    FLUSH,
    REC(K, "s1", { type: "mode_changed", mode: "default" }),
    FLUSH,
    { op: "state", ws: "wks_k2" },
    REC(K2, "s1", perm("k2")),
    FLUSH,
    { op: "dir", cwd: BRK },
    REC(BRK, "s1", { type: "turn_status", status: "idle" }),
    FLUSH,
    REC(BRK, "s1", perm("brk")),
    FLUSH,
    { op: "state", ws: "wks_brk" },
    { op: "list", ws: "wks_brk" },
    { op: "read", ws: "wks_brk", ids: ["x"] },
    { op: "readAll", ws: "wks_brk" },
    { op: "sweep", cwd: BRK, sid: "s1" },
    { op: "byRequest", cwd: BRK, rid: "brk" },
    FLUSH,
    SQL(OLD, NEWER_SCHEMA, true),
    REC(OLD, "s1", { type: "turn_status", status: "idle" }),
    FLUSH,
    REC(OLD, "s1", perm("old")),
    FLUSH,
    { op: "state", ws: "wks_old" },
    { op: "list", ws: "wks_old" },
    { op: "readAll", ws: "wks_old" },
    { op: "bySession", ws: "wks_old", sid: "s1" },
    { op: "byKind", ws: "wks_old", kind: "session_idle" },
    { op: "sweep", cwd: OLD, sid: "s1" },
    { op: "byRequest", cwd: OLD, rid: "x" },
    FLUSH,
    { op: "state", ws: "wks_noroot" },
    { op: "state", ws: "wks_numroot" },
    { op: "list", ws: "wks_noroot" },
    { op: "list", ws: "wks_numroot" },
    { op: "read", ws: "wks_noroot", ids: ["x"] },
    { op: "read", ws: "wks_noroot", ids: [] },
    { op: "readAll", ws: "wks_numroot" },
    { op: "bySession", ws: "wks_noroot", sid: "s" },
    { op: "byKind", ws: "wks_numroot", kind: "session_idle" },
    { op: "bySession", ws: "wks_noroot", sid: "" },
    { op: "byKind", ws: "wks_numroot", kind: "" },
    { op: "across" },
    { op: "states" },
  ]);
}

// The cwd -> workspace cache: keyed on workspaces.json's mtime.
{
  const X = "/g/map/x";
  const Y = "/g/map/y";
  const U = "/g/map/\u00fcnic\u00f6de \u{1F600}";
  S("cwdmap", [X, Y, U], [
    AT(BASE + 10_000),
    REC(X, "s1", perm("x0")),
    WS([W("wks_x", X)]),
    REC(X, "s1", perm("x1")),
    FLUSH,
    WS([W("wks_x", Y)], { same: true }),
    REC(X, "s1", perm("x2")),
    REC(Y, "s1", perm("y1")),
    FLUSH,
    { op: "list", ws: "wks_x" },
    WS([W("wks_x", Y)]),
    REC(X, "s1", perm("x3")),
    REC(Y, "s1", perm("y2")),
    FLUSH,
    WS([W("wks_first", X), W("wks_second", X), W("wks_y", Y)]),
    REC(X, "s1", perm("x4")),
    FLUSH,
    WS([W("", X), W("wks_y", Y)]),
    REC(X, "s1", perm("x5")),
    REC(Y, "s1", perm("y3")),
    FLUSH,
    WS([W("wks_x", X), "a string", 5, [W("wks_y", Y)], W("wks_u", U)]),
    REC(X, "s1", perm("x6")),
    REC(Y, "s1", perm("y4")),
    REC(U, "s1", perm("u1")),
    FLUSH,
    { op: "state", ws: "wks_u" },
    WS([], { raw: "{not json" }),
    REC(X, "s1", perm("x7")),
    WS([], { raw: `\ufeff${JSON.stringify({ version: 1, workspaces: [W("wks_x", X)] })}` }),
    REC(X, "s1", perm("x8")),
    WS([], { raw: JSON.stringify({ version: 2, workspaces: [W("wks_x", X)] }) }),
    REC(X, "s1", perm("x9")),
    WS([], { raw: JSON.stringify({ version: 1.0, workspaces: { 0: W("wks_x", X) } }) }),
    REC(X, "s1", perm("x10")),
    WS([], { raw: "null" }),
    REC(X, "s1", perm("x11")),
    WS([], { raw: '{"version":1e0,"workspaces":[{"id":"wks_x","rootPath":"/g/map/x"}],"extra":true}' }),
    REC(X, "s1", perm("x12")),
    FLUSH,
    WS([W("wks_x", X), null, W("wks_y", Y)]),
    REC(X, "s1", perm("x13")),
    { op: "read", ws: "wks_x", ids: ["nothing"] },
    { op: "read", ws: "wks_y", ids: ["nothing"] },
    { op: "state", ws: "wks_x" },
    { op: "state", ws: "wks_y" },
    { op: "list", ws: "wks_y" },
    { op: "states" },
    { op: "state", ws: "wks_x" },
    { op: "across" },
    { op: "byRequest", cwd: X, rid: "x1" },
    { op: "sweep", cwd: X, sid: "s1" },
    FLUSH,
    WS([W("wks_x", X), W("wks_y", Y)]),
    { op: "state", ws: "wks_y" },
    { op: "sweep", cwd: X, sid: "s1" },
    FLUSH,
    RMWS(),
    REC(X, "s1", perm("x14")),
    { op: "states" },
    { op: "across" },
    FLUSH,
  ]);
}

// Event fields of odd types (dev-emit passes any JSON through).
{
  const O = "/g/odd/o";
  const long = (n, ch = "a") => ch.repeat(n);
  const events = [
    perm("o1", { title: 5 }),
    perm("o2", { title: 0.1 }),
    perm("o3", { title: 1 / 3 }),
    perm("o4", { title: 1e21 }),
    perm("o5", { title: 2 ** 53 + 2 }),
    perm("o6", { title: 1e-7 }),
    perm("o7", { title: ["x"] }),
    perm("o8", { title: [] }),
    perm("o9", { title: ["x", "y"] }),
    perm("o10", { title: true }),
    perm("o11", { title: {} }),
    perm(["o12a", "o12b"], { title: {} }),
    perm("o13", { title: "" }),
    perm("o14", { title: null, toolName: null }),
    perm("o15", { title: undefined, toolName: { name: "Bash", n: [1.0, 1e21, -0.5], "3": 3, "1": 1 } }),
    perm(7, { title: "numeric request id" }),
    perm("7.0", { title: "same text as the numeric id" }),
    perm({}, { title: "object request id" }),
    perm(null, { title: "null request id" }),
    perm(null, { title: "second null request id" }),
    perm(undefined, { title: "no request id" }),
    perm("o16", { title: [5] }),
    perm("o17", { title: [null] }),
    perm("o18", { title: [[1]] }),
    perm("o19", { title: false }),
    perm("o20", { title: "\u00e9t\u00e9 \u{1F600} \u4e2d\u6587" }),
    { type: "mcp_elicitation_request", requestId: "e1", serverName: "S", message: 5 },
    { type: "mcp_elicitation_request", requestId: "e2", serverName: "S", message: 0 },
    { type: "mcp_elicitation_request", requestId: "e3", serverName: "S", message: true },
    { type: "mcp_elicitation_request", requestId: "e4", message: "no server" },
    { type: "mcp_elicitation_request", requestId: "e5", serverName: { a: 1 }, mode: "url", message: "x" },
    { type: "mcp_elicitation_request", requestId: "e6", serverName: [1, [2, 3], null], mode: "URL", message: "x" },
    { type: "mcp_elicitation_request", requestId: "e7", serverName: null, mode: null, message: "x" },
    { type: "mcp_elicitation_request", requestId: "e8", serverName: 1.5e300, message: "a\rb\r\nc" },
    { type: "plan_approval_request", requestId: "p1", plan: "\n\nfirst blank" },
    { type: "plan_approval_request", requestId: "p2", plan: " \t\u00a0\ufeff padded \u2003\n2" },
    { type: "plan_approval_request", requestId: "p3", plan: "\u0085nel\u0085" },
    { type: "plan_approval_request", requestId: "p4", plan: long(200) },
    { type: "plan_approval_request", requestId: "p5", plan: long(201) },
    { type: "plan_approval_request", requestId: "p6", plan: `${long(196)}\u{1F600}${long(10)}` },
    { type: "plan_approval_request", requestId: "p7", plan: `${long(195)}\u{1F600}\u{1F600}${long(10)}` },
    { type: "plan_approval_request", requestId: "p8", plan: long(100, "\u00e9") + long(150, "b") },
    { type: "plan_approval_request", requestId: "p9", plan: `${long(198)}\r\n${long(5)}` },
    { type: "plan_approval_request", requestId: "p10", plan: 42 },
    { type: "plan_approval_request", requestId: "p11", plan: "" },
    { type: "plan_approval_request", requestId: "p12" },
    { type: "ask_user_question", requestId: "a1", questions: "abc" },
    { type: "ask_user_question", requestId: "a2", questions: { 0: { question: "from an object", header: "h" } } },
    { type: "ask_user_question", requestId: "a3", questions: [null] },
    { type: "ask_user_question", requestId: "a4", questions: [{ question: 5, header: [1] }] },
    { type: "ask_user_question", requestId: "a5", questions: [{ question: null, header: null }] },
    { type: "ask_user_question", requestId: "a6", questions: 3 },
    { type: "ask_user_question", requestId: "a7", questions: null },
    { type: "ask_user_question", requestId: "a8", questions: [{ question: {} }] },
    err(5),
    err(0),
    err(""),
    { type: "error" },
    err(["Claude Code process aborted by user"]),
    { type: "sdk", message: "result" },
    { type: "sdk", message: ["result"] },
    { type: "sdk", message: null },
    { type: "sdk" },
    { type: 5 },
    { type: ["permission_request"] },
    "permission_request",
    ["permission_request"],
    42,
    true,
    { type: "run_finished", status: "success" },
  ];
  S("odd", [O], [
    WS([W("wks_o", O, allOn)]),
    AT(BASE + 11_000),
    INPUT("s1"),
    ...events.flatMap((e) => [REC(O, "s1", e), FLUSH]),
    { op: "list", ws: "wks_o", opts: { limit: 200 } },
  ], 1);
}

// Paging past the default limit and the 200 cap.
{
  const P = "/g/paging/p";
  S("paging", [], [
    WS([W("wks_p", P)]),
    AT(BASE + 12_000),
    SQL(P, [
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 210)",
      "INSERT INTO notifications (id, kind, title, created_at) SELECT 'p' || i, 'session_error', 't', i FROM n;",
    ].join("\n")),
    { op: "list", ws: "wks_p" },
    { op: "list", ws: "wks_p", opts: { limit: 250, unreadOnly: true } },
    { op: "across" },
    { op: "state", ws: "wks_p" },
  ], 1);
}

// The cross-workspace merge with a NULL created_at (0 to the comparator),
// in a table recreated without the NOT NULL.
{
  const N1 = "/g/nullsort/a";
  const N2 = "/g/nullsort/b";
  const ins1 = (cwd, id, at) =>
    SQL(cwd, `INSERT INTO notifications (id, kind, title, created_at) VALUES ('${id}', 'session_error', 't', ${at});`);
  S("nullsort", [N1, N2], [
    WS([W("wks_na", N1), W("wks_nb", N2)]),
    AT(BASE + 14_000),
    SQL(N1, [
      "DROP TABLE notifications;",
      "CREATE TABLE notifications (id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, job_id TEXT, kind TEXT,",
      "  title TEXT, body TEXT, payload TEXT, request_id TEXT, created_at INTEGER, read_at INTEGER);",
    ].join("\n")),
    ins1(N1, "a10", 10),
    ins1(N1, "anull", "NULL"),
    ins1(N2, "b5", 5),
    ins1(N2, "bneg", -1),
    { op: "across" },
    { op: "across", opts: { unreadOnly: true, limit: 3 } },
  ], 1);
}

// A database file the bus can only read: the read-write open fails at its
// migration, the mute check caches a read-only handle, and the state flush
// reads through that.
{
  const RO = "/g/readonly/r";
  S("readonly", [RO], [
    WS([W("wks_ro", RO, allOn)]),
    AT(BASE + 15_000),
    SQL(RO, [
      "CREATE TABLE notifications (id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, job_id TEXT, kind TEXT NOT NULL,",
      "  title TEXT NOT NULL, body TEXT, payload TEXT, request_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER);",
      "INSERT INTO notifications (id, session_id, kind, title, created_at) VALUES ('ro1', 's1', 'session_error', 't', 1);",
    ].join("\n"), true),
    { op: "chmod", cwd: RO, mode: 0o444 },
    REC(RO, "s1", { type: "turn_status", status: "idle" }),
    FLUSH,
    REC(RO, "s1", perm("ro-1")),
    FLUSH,
    REC(RO, "s1", { type: "turn_status", status: "idle" }),
    FLUSH,
    { op: "state", ws: "wks_ro" },
    { op: "list", ws: "wks_ro" },
    { op: "readAll", ws: "wks_ro" },
    { op: "byRequest", cwd: RO, rid: "ro-1" },
    FLUSH,
    { op: "chmod", cwd: RO, mode: 0o644 },
  ], 1);
}

// ------------------------------- pure functions -------------------------------

const pure = [];
{
  const PREFS = [
    undefined,
    null,
    {},
    { enabled: false },
    { enabled: true },
    { enabled: 0 },
    { enabledKinds: [] },
    { enabledKinds: ["session_error"] },
    { enabledKinds: ALL_KINDS },
    { enabledKinds: "permission_request" },
    { enabledKinds: "permission_request_extra" },
    { enabledKinds: 5 },
    { enabledKinds: { length: 1, 0: "session_idle" } },
    { enabledKinds: null },
    { enabledKinds: ["session_idle", 5, null] },
    "session_idle",
    7,
  ];
  const KINDS = [...ALL_KINDS, "", "unknown", "permission"];
  for (const prefs of PREFS) {
    for (const kind of KINDS) pure.push({ fn: "kindEnabled", kind, ...(prefs === undefined ? {} : { prefs }) });
  }
  const CTX = [
    { cwd: "/c", sessionId: "s1" },
    { cwd: "/c", sessionId: "s1", sessionTitle: "Title", hasActiveBackgroundWork: false },
    { cwd: "/c", sessionId: "s1", hasActiveBackgroundWork: true },
    { cwd: "/c", sessionId: "" },
    { cwd: "/c", sessionId: "s2" },
    { cwd: "/c", runId: "run", jobId: "job" },
    { cwd: "/c", runId: "", jobId: "job" },
  ];
  const INPUTS = [
    ["s1", 1],
    ["s2", 0],
  ];
  const EVENTS = [
    perm("r1"),
    perm("r2", { title: undefined }),
    { type: "mcp_elicitation_request", requestId: "e", serverName: "Srv", mode: "url", message: "line1\nline2" },
    { type: "ask_user_question", requestId: "a", toolUseId: "t", questions: [{ question: "Q", header: "H" }] },
    { type: "plan_approval_request", requestId: "p", toolUseId: "t", plan: "  plan  \n rest" },
    err("e"),
    err(" Claude Code process aborted by user "),
    err(7),
    sdkResult(),
    { type: "sdk", message: { type: "assistant" } },
    { type: "run_finished", status: "success", costUsd: 2, note: "n" },
    { type: "run_finished", status: 3, costUsd: NaN },
    { type: "run_finished", status: "x", note: null },
    { type: "ask_user_question", requestId: "a", questions: [{ question: null, header: null }] },
    { type: "turn_status", status: "idle" },
    null,
    "x",
  ];
  for (const event of EVENTS) {
    for (const ctx of CTX) pure.push({ fn: "map", event, ctx, inputs: INPUTS });
  }
}

// ------------------------------- run -------------------------------

const threw = (e) => ({ threw: e instanceof Error ? e.message : String(e) });
const json = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

async function runStep(s, subs) {
  switch (s.op) {
    case "ws":
      writeWs(s.text, s.mtime);
      return undefined;
    case "clock":
      clock = s.clock;
      tick = s.tick;
      return undefined;
    case "sql":
      await runSql(s.cwd, s.sql, s.fresh);
      return undefined;
    case "dir":
      mkdirSync(dbPath(s.cwd), { recursive: true });
      return undefined;
    case "chmod":
      chmodSync(dbPath(s.cwd), s.mode);
      return undefined;
    case "flush":
      return runTimers();
    case "reset":
      notificationBus.resetForTests();
      for (const sub of subs) sub.active = false;
      return undefined;
    case "sub": {
      const sub = { got: [], active: true };
      sub.off = notificationBus.subscribe((env) => sub.got.push(JSON.parse(JSON.stringify(env))));
      subs.push(sub);
      return undefined;
    }
    case "unsub":
      subs[s.index].off();
      subs[s.index].active = false;
      return undefined;
    case "record":
      return notificationBus.recordSessionEvent(s.cwd, s.sid, s.event, s.opts);
    case "sched":
      return notificationBus.recordSchedulerEvent(s.cwd, s.runId, s.jobId, s.event);
    case "input":
      return notificationBus.markUserInput(s.sid, s.at);
    case "list":
      return notificationBus.list(s.ws, s.opts);
    case "across":
      return notificationBus.listAcrossWorkspaces(s.opts);
    case "read":
      return notificationBus.markRead(s.ws, s.ids);
    case "readAll":
      return notificationBus.markAllRead(s.ws);
    case "bySession":
      return notificationBus.markReadBySession(s.ws, s.sid);
    case "byKind":
      return notificationBus.markReadByKind(s.ws, s.kind);
    case "byRequest":
      return notificationBus.markReadByRequestId(s.cwd, s.rid);
    case "sweep":
      return notificationBus.sweepOrphanedActionableForSession(s.cwd, s.sid);
    case "state":
      return notificationBus.getWorkspaceState(s.ws);
    case "states":
      // Sorted by key: TS inserts each workspace's entry as its DB reads
      // settle, so the order follows I/O completion when a handle isn't
      // cached yet (Rust keeps the workspace order).
      return Object.entries(await notificationBus.getAllWorkspaceStates()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    case "db.insert":
      return ndb.insertNotification(s.cwd, s.ws, s.input);
    case "db.list":
      return ndb.listNotifications(s.cwd, s.ws, s.opts);
    case "db.count":
      return ndb.unreadCount(s.cwd);
    case "db.perSession":
      return Object.entries(await ndb.unreadCountsBySession(s.cwd));
    case "db.get":
      return ndb.getNotification(s.cwd, s.ws, s.id);
    case "db.read":
      return ndb.markRead(s.cwd, s.ids);
    case "db.readAll":
      return ndb.markAllRead(s.cwd);
    case "db.byKind":
      return ndb.markReadByKind(s.cwd, s.kind);
    case "db.bySession":
      return ndb.markReadBySession(s.cwd, s.sid);
    case "db.actionable":
      return ndb.markReadActionableBySession(s.cwd, s.sid);
    case "db.byRequest":
      return ndb.markReadByRequestId(s.cwd, s.rid);
    default:
      throw new Error(`unknown op ${s.op}`);
  }
}

/**
 * What changed between two dumps: the new value when either isn't a row list
 * (no file, a directory, a failed read), else `{len, changed: [[index, row]]}`
 * for the rows that are new or differ; `undefined` when nothing did.
 */
function rowsDiff(before, after) {
  if (before === undefined || !Array.isArray(before) || !Array.isArray(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? undefined : after;
  }
  const changed = [];
  after.forEach((row, i) => {
    if (JSON.stringify(row) !== JSON.stringify(before[i])) changed.push([i, row]);
  });
  return changed.length === 0 && after.length === before.length ? undefined : { len: after.length, changed };
}

const recorded = [];
for (const sc of scenarios) {
  notificationBus.resetForTests();
  ids = 0;
  runTimers();
  const subs = [];
  for (let i = 0; i < sc.subs; i++) await runStep({ op: "sub" }, subs);
  const lastRows = new Map();
  const lastCached = new Map();
  const steps = [];
  for (const s of sc.steps) {
    let got;
    try {
      got = json(await runStep(s, subs));
    } catch (e) {
      got = threw(e);
    }
    const step = { ...s, got };
    step.envs = subs.map((sub) => sub.got.splice(0));
    const rows = {};
    const cached = {};
    for (const cwd of sc.watch) {
      const r = rowsDiff(lastRows.get(cwd), dump(cwd));
      if (r !== undefined) rows[cwd] = r;
      lastRows.set(cwd, dump(cwd));
      const c = JSON.stringify(cachedOf(cwd));
      if (lastCached.get(cwd) !== c) cached[cwd] = JSON.parse(c);
      lastCached.set(cwd, c);
    }
    if (Object.keys(rows).length > 0) step.rows = rows;
    if (Object.keys(cached).length > 0) step.cached = cached;
    step.clockAfter = clock;
    step.idsAfter = ids;
    steps.push(step);
  }
  if (timers.length > 0) throw new Error(`${sc.name}: timers left over`);
  recorded.push({ ...sc, steps });
}

const pureOut = pure.map((p) => {
  let got;
  try {
    if (p.fn === "kindEnabled") got = isKindEnabled(p.kind, p.prefs);
    else got = json(mapEventToKind(p.event, p.ctx, new Map(p.inputs)));
  } catch (e) {
    got = threw(e);
  }
  return { ...p, got };
});

const fixture = { base: BASE, scenarios: recorded, pure: pureOut };
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify(fixture).split(ROOT_DIR).join("$ROOT"));
process.exit(0);
