#!/usr/bin/env node
// Golden fixture for the notification routes (G01b) and their SSE (G01c):
// `app/api/notifications/route.ts` (GET), `counts`, `[id]/read`, `read-all`,
// `read-by-kind`, `read-by-session`, `dev-emit` and `stream`, on the real
// `lib/server/notification-bus.ts` / `notifications-db.ts` and the real
// migrations:
//
//   node rust/scripts/notifications-routes-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself twice under `--experimental-transform-types` with the repo
// as its cwd (db.ts reads the migrations from there), HOME and
// CLAUDE_CONFIG_DIR in a fresh temp root and a resolve hook for the `@/`
// imports; both recordings must agree byte for byte. The JSON routes run
// inside Next's own `AppRouteRouteModule.handle`, so `cookies()` reads the
// request's Cookie header (`resolveActiveWorkspace`). The stream route is
// called directly and read chunk by chunk; aborting its request's signal is
// the client going away.
//
// Stubbed, so the replay can map the values:
// * `Date.now`: the request's pinned clock, `BASE + n * 1_000_003` for the
//   n-th request (it moves only on requests).
// * `crypto.randomUUID`: a counter, `00000000-0000-4000-a000-<n>`.
// * `setTimeout` from notification-bus.ts: queued. The bus's coalesced
//   `state` flushes run after each step, once the handler has answered.
//   (TS's real order is a race: dev-emit's `getAllWorkspaceStates` reads
//   workspaces.json while the flush timer is pending, and either can land
//   first.)
// * `setInterval` from the stream route: captured, not armed. A `ping` step
//   fires a stream's heartbeat once; `heartbeat` records its period.
//
// `getAllWorkspaceStates` inserts each key as its reads settle: workspaces
// whose read-only handle db.ts has cached (or whose rootPath isn't a
// string) settle at once, in order; the others wait on an fs.mkdir and land
// in I/O order. The steps keep at most one workspace in the second group
// whenever counts, dev-emit or a stream seed run, so the order is stable.
//
// Steps run in order: `ws` (write workspaces.json with an explicit mtime,
// `text: null` removes it), `sql` (hand-written SQL on a connection of its
// own; `fresh`: a bare file without the migrations), `req` (an HTTP request:
// `got` is the status, content type and body text, or `threw`, Next's empty
// 500; `clock` is its pinned time; `prod` runs it with NODE_ENV=production),
// `open` / `close` / `ping` (a stream). After every step, `envs` holds the
// chunks each open stream received during it, and `rows` the notifications
// rows of each watched cwd that changed (`{len, changed: [[index, row]]}`;
// a row is `[typeof, value]` per column in table order, integers as their
// decimal text, blobs as hex; `null`: no database file).
//
// Written to rust/crates/claudius-core/tests/fixtures/notifications_routes_golden.json;
// replayed by crates/claudius-server/tests/notifications_routes.rs against
// the real binary.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, register, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/notifications_routes_golden.json");

if (!process.env.NR_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "notifications-routes-golden-")));
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
            NR_GOLDEN_CHILD: root,
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
    if (process.env.NR_GOLDEN_DIFF_DIR) runs.forEach((r, i) => writeFileSync(join(process.env.NR_GOLDEN_DIFF_DIR, `run${i}.json`), r));
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const reqs = fixture.steps.filter((s) => s.op === "req").length;
  const chunks = fixture.steps.reduce((n, s) => n + Object.values(s.envs ?? {}).reduce((m, c) => m + c.length, 0), 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.steps.length} steps (${reqs} requests, ${chunks} stream chunks) (stable)`);
  process.exit(0);
}

const ROOT_DIR = process.env.NR_GOLDEN_CHILD;
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

// ------------------------------- stubs -------------------------------

const BASE = 1_700_000_000_000;
let clock = BASE;
Date.now = () => clock;

let ids = 0;
const require = createRequire(join(repo, "package.json"));
const crypto = require("node:crypto");
crypto.randomUUID = () => `00000000-0000-4000-a000-${String(++ids).padStart(12, "0")}`;
syncBuiltinESMExports();

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const caller = () => new Error().stack ?? "";
const timers = [];
globalThis.setTimeout = (fn, ms, ...args) => {
  if (!caller().includes("notification-bus.ts")) return realSetTimeout(fn, ms, ...args);
  const handle = { fn, bus: true };
  timers.push(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  if (handle?.bus) {
    const i = timers.indexOf(handle);
    if (i >= 0) timers.splice(i, 1);
    return;
  }
  realClearTimeout(handle);
};
let lastInterval = null;
globalThis.setInterval = (fn, ms, ...args) => {
  if (!caller().includes("notifications/stream/route.ts")) return realSetInterval(fn, ms, ...args);
  lastInterval = { fn, ms, cleared: false, stream: true };
  return lastInterval;
};
globalThis.clearInterval = (handle) => {
  if (handle?.stream) {
    handle.cleared = true;
    return;
  }
  realClearInterval(handle);
};
/** Run every queued bus timer in order (a flush that throws is a bug here). */
function runTimers() {
  while (timers.length > 0) timers.shift().fn();
}
/** Let pending I/O and the stream readers catch up. */
async function drain() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => realSetTimeout(r, 5));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

const { default: Database } = await import("better-sqlite3");
const { AppRouteRouteModule } = require("next/dist/server/route-modules/app-route/module.js");
const { NextRequest } = require("next/server.js");
const { notificationBus } = await import(join(repo, "lib/server/notification-bus.ts"));
if (typeof notificationBus.list !== "function") throw new Error("no bus"); // instantiates the singleton
const bus = () => globalThis.__claudiusNotificationBus;

function routeModule(userland, pathname) {
  return new AppRouteRouteModule({
    userland: () => userland,
    definition: { kind: "APP_ROUTE", page: `${pathname}/route`, pathname, filename: "route", bundlePath: "" },
    distDir: ".next",
    relativeProjectDir: "",
    resolvedPagePath: `app${pathname}/route.ts`,
    nextConfigOutput: undefined,
  });
}
const api = join(repo, "app/api/notifications");
const N = "/api/notifications";
const ROUTES = {
  list: routeModule(await import(join(api, "route.ts")), N),
  counts: routeModule(await import(join(api, "counts/route.ts")), `${N}/counts`),
  read: routeModule(await import(join(api, "[id]/read/route.ts")), `${N}/[id]/read`),
  "read-all": routeModule(await import(join(api, "read-all/route.ts")), `${N}/read-all`),
  "read-by-kind": routeModule(await import(join(api, "read-by-kind/route.ts")), `${N}/read-by-kind`),
  "read-by-session": routeModule(await import(join(api, "read-by-session/route.ts")), `${N}/read-by-session`),
  "dev-emit": routeModule(await import(join(api, "dev-emit/route.ts")), `${N}/dev-emit`),
};
const streamRoute = await import(join(api, "stream/route.ts"));
const context = (params) => ({
  params,
  previewProps: { previewModeId: "p", previewModeSigningKey: "s", previewModeEncryptionKey: "e" },
  renderOpts: {
    experimental: {},
    cacheComponents: false,
    supportsDynamicResponse: true,
    waitUntil: undefined,
    onClose: () => {},
    onAfterTaskError: undefined,
  },
  sharedContext: { buildId: "golden" },
});
/** The route module and params Next's router picks for a path. */
function routeFor(path) {
  const segs = path.split("?")[0].split("/").slice(3);
  if (segs.length === 0) return [ROUTES.list, undefined];
  if (segs.length === 2 && segs[1] === "read") return [ROUTES.read, { id: decodeURIComponent(segs[0]) }];
  return [ROUTES[segs[0]], undefined];
}

// ------------------------------- the world -------------------------------

const WS_FILE = join(HOME, ".claude", ".claudius", "workspaces.json");
const dbPath = (cwd) => join(HOME, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), ".claudius.db");

const COLS = ["id", "session_id", "run_id", "job_id", "kind", "title", "body", "payload", "request_id", "created_at", "read_at"];
const ROWS_SQL = `SELECT ${COLS.map(
  (c) => `typeof(${c}), CASE typeof(${c}) WHEN 'integer' THEN CAST(${c} AS TEXT) WHEN 'blob' THEN hex(${c}) ELSE ${c} END`,
).join(", ")} FROM notifications ORDER BY rowid`;
/** The notifications rows of `cwd`'s database, read on a connection of its own. */
function dump(cwd) {
  const path = dbPath(cwd);
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(ROWS_SQL)
      .raw()
      .all()
      .map((r) => COLS.map((_, i) => [r[2 * i], r[2 * i + 1]]));
  } finally {
    db.close();
  }
}
function rowsDiff(prev, now) {
  if (now === null) return prev === null ? undefined : null;
  if (!Array.isArray(prev)) return { len: now.length, changed: now.map((r, i) => [i, r]) };
  const changed = [];
  now.forEach((r, i) => {
    if (JSON.stringify(r) !== JSON.stringify(prev[i])) changed.push([i, r]);
  });
  if (changed.length === 0 && now.length === prev.length) return undefined;
  return { len: now.length, changed };
}
/** Hand-written SQL on a connection of its own. */
function runSql(cwd, sql, fresh) {
  const path = dbPath(cwd);
  if (fresh) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    if (fresh) db.pragma("journal_mode = WAL");
    db.exec(sql);
  } finally {
    db.close();
  }
}

// ------------------------------- streams -------------------------------

const streams = new Map();
async function openStream(label) {
  const before = bus().subscribers.size;
  const ac = new AbortController();
  lastInterval = null;
  const res = await streamRoute.GET(new Request("http://localhost/api/notifications/stream", { signal: ac.signal }));
  const s = { ac, chunks: [], done: false, interval: null };
  streams.set(label, s);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        s.done = true;
        return;
      }
      s.chunks.push(dec.decode(value));
    }
  })();
  // The seed is in once the route has subscribed (it does so right after).
  for (let i = 0; bus().subscribers.size === before; i++) {
    if (i > 100000) throw new Error("the stream never subscribed");
    await new Promise((r) => setImmediate(r));
  }
  s.interval = lastInterval;
  const headers = {};
  for (const k of ["content-type", "cache-control", "connection", "x-accel-buffering"]) headers[k] = res.headers.get(k);
  return { status: res.status, headers, heartbeatMs: s.interval?.ms ?? null };
}

// ------------------------------- steps -------------------------------

const CWD = {
  a: "/claudius-golden/a",
  b: "/claudius-golden/b",
  c: "/claudius-golden/c",
  d: "/claudius-golden/d",
  e: "/claudius-golden/e",
};
const WATCH = Object.values(CWD);
const A = "wks_aaaaaaaaaaaa";
const B = "wks_bbbbbbbbbbbb";
const C = "wks_cccccccccccc";
const D = "wks_dddddddddddd";
const E = "wks_eeeeeeeeeeee";
const entry = (id, name, rootPath, extra = {}) => ({
  id,
  name,
  rootPath,
  icon: { kind: "letter", letter: name, color: "#123456" },
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const WA = entry(A, "A", CWD.a);
const WB = entry(B, "B", CWD.b);
const WC = entry(C, "C", CWD.c);
const WD = entry(D, "D", CWD.d, { defaults: { notifications: { enabled: false } } });
const WE = entry(E, "E", CWD.e, {
  defaults: { notifications: { enabledKinds: ["session_error", "permission_request", "session_idle"] } },
});
let mtime = 1_600_000_000;
const WS = (workspaces, extra = {}) => ({ op: "ws", text: JSON.stringify({ version: 1, workspaces, ...extra }, null, 2), mtime: ++mtime });
const WSTEXT = (text) => ({ op: "ws", text, mtime: ++mtime });
const SQL = (cwd, sql, fresh = false) => ({ op: "sql", cwd, sql, ...(fresh ? { fresh } : {}) });
const REQ = (method, path, extra = {}) => ({ op: "req", method, path, ...extra });
const GET = (path, extra) => REQ("GET", path, extra);
const POST = (path, body, extra = {}) => REQ("POST", path, { ...(body === undefined ? {} : { body }), ...extra });
const PJ = (path, v, extra) => POST(path, JSON.stringify(v), extra);
const LIST = (q = "", extra) => GET(`${N}${q}`, extra);
const COUNTS = GET(`${N}/counts`);
const EMIT = (v, extra) => PJ(`${N}/dev-emit`, v, extra);
const EMITTO = (cwd, sessionId, event, more = {}) => EMIT({ cwd, sessionId, event, ...more });
const OPEN = (stream) => ({ op: "open", stream });
const CLOSE = (stream) => ({ op: "close", stream });
const PING = (stream) => ({ op: "ping", stream });
const cookie = (v) => ({ cookie: v });
const perm = (requestId, extra = {}) => ({ type: "permission_request", requestId, toolName: "Bash", toolUseId: `tu-${requestId}`, title: "Run ls", ...extra });
const ins = (cwd, id, sid, kind, title, created, read = "NULL", extra = {}) =>
  SQL(
    cwd,
    `INSERT INTO notifications(id, session_id, run_id, job_id, kind, title, body, payload, request_id, created_at, read_at) VALUES ('${id}', ${sid === null ? "NULL" : `'${sid}'`}, ${extra.run ?? "NULL"}, ${extra.job ?? "NULL"}, '${kind}', '${title}', ${extra.body ?? "NULL"}, ${extra.payload ?? "NULL"}, ${extra.req ?? "NULL"}, ${created}, ${read});`,
  );
const OLD = 1_650_000_000_000;

const STEPS = [
  // ---- No workspaces yet.
  OPEN("monitor"),
  COUNTS,
  LIST(),
  LIST("?workspace=all"),
  LIST("?workspace=wks_nope"),
  LIST("?workspace="),
  POST(`${N}/read-all`),
  POST(`${N}/read-all`, "null"),
  POST(`${N}/read-all`, "{"),
  PJ(`${N}/read-all`, { workspaceId: "wks_nope" }),
  PJ(`${N}/read-all`, { workspaceId: 5 }),
  PJ(`${N}/read-all`, { workspaceId: true }),
  PJ(`${N}/read-all`, { workspaceId: {} }),
  PJ(`${N}/read-all`, []),
  POST(`${N}/read-all`, '"wks_nope"'),
  POST(`${N}/x/read`),
  EMIT({}),
  POST(`${N}/dev-emit`, "null"),
  POST(`${N}/dev-emit`, ""),
  EMITTO(CWD.a, "s-1", { type: "ready" }),
  EMITTO(5, "s-1", { type: "ready" }),
  EMITTO("  ", "s-1", { type: "ready" }),
  // ---- Three workspaces; C never gets a read-only handle before the end.
  WS([WC, WA, WB]),
  LIST(),
  PJ(`${N}/read-all`, { workspaceId: A }),
  LIST(`?workspace=${A}`),
  PJ(`${N}/read-all`, { workspaceId: B }),
  LIST(`?workspace=${B}`),
  COUNTS,
  OPEN("s2"),
  CLOSE("s2"),
  COUNTS,
  // ---- dev-emit: every event family, then the validation.
  EMITTO(CWD.a, "s-1", perm("req-1")),
  EMITTO(CWD.a, "s-1", perm("req-1")),
  EMITTO(CWD.a, "s-2", {
    type: "ask_user_question",
    requestId: "req-2",
    toolUseId: "tu-2",
    questions: [{ question: "Which one?", header: "Pick" }],
  }, { hasSubscribers: false }),
  EMITTO(CWD.b, "s-3", { type: "plan_approval_request", requestId: "req-3", toolUseId: "tu-3", plan: "  Step one  \nStep two" }),
  EMITTO(CWD.b, "s-3", { type: "mcp_elicitation_request", requestId: "req-4", serverName: "srv", mode: "url", message: "Sign in please\nmore" }),
  EMITTO(CWD.b, "s-3", { type: "mcp_elicitation_request", requestId: "req-5", serverName: "srv", mode: "form", message: "" }),
  EMITTO(CWD.b, "s-6", {
    type: "plan_approval_request",
    requestId: `req-u-${String.fromCodePoint(0xe9)}`,
    toolUseId: "tu-u",
    plan: `${String.fromCodePoint(0x1f680)} ${"x".repeat(195)}${String.fromCodePoint(0xe9, 0x4e2d)} tail\nsecond`,
  }),
  EMITTO(CWD.a, "s-1", { type: "error", message: "boom" }),
  EMITTO(CWD.a, "s-1", { type: "turn_status", status: "idle" }),
  EMITTO(CWD.a, "s-1", { type: "sdk", message: { type: "result", subtype: "success" } }),
  EMITTO(CWD.a, "s-1", { type: "sdk", message: { type: "assistant", parent_tool_use_id: "tu-x" } }),
  EMITTO(CWD.a, "s-1", { type: "sdk", message: { type: "result", parent_tool_use_id: "tu-x" } }),
  EMITTO(CWD.a, "s-1", { type: "text_delta", text: "hi" }),
  EMITTO(CWD.a, "s-1", 5),
  EMITTO(CWD.a, "s-1", "permission_request"),
  EMITTO(CWD.a, "s-1", [1]),
  EMITTO(CWD.a, "s-1", {}),
  EMITTO(CWD.a, "s-1", perm("req-6", { title: undefined, toolName: "Edit" }), { hasSubscribers: true }),
  EMITTO(CWD.a, "s-1", perm("req-7"), { hasSubscribers: "false" }),
  EMITTO(CWD.a, 7, { type: "ready" }),
  EMITTO(CWD.a, true, { type: "turn_status", status: "running" }),
  EMITTO(`${CWD.a}/`, "s-1", perm("req-8")),
  EMITTO(`${CWD.a}/../b`, "s-4", perm("req-9")),
  EMITTO(`${CWD.a}/./`, "s-1", { type: "ready" }),
  EMITTO("/claudius-golden/zzz", "s-1", perm("req-x")),
  EMITTO("relative/path", "s-1", perm("req-x")),
  EMITTO(CWD.a.toUpperCase(), "s-1", perm("req-x")),
  EMITTO("", "s-1", perm("req-x")),
  EMITTO(CWD.a, "", perm("req-x")),
  EMITTO(CWD.a, "s-1", null),
  EMITTO(CWD.a, "s-1", 0),
  EMITTO(CWD.a, 0, perm("req-x")),
  EMIT({ cwd: CWD.a, sessionId: "s-1" }),
  EMIT({ sessionId: "s-1", event: perm("req-x") }),
  PJ(`${N}/dev-emit`, [CWD.a, "s-1", perm("req-x")]),
  POST(`${N}/dev-emit`, '"x"'),
  POST(`${N}/dev-emit`, `\uFEFF${JSON.stringify({ cwd: CWD.a, sessionId: "s-5", event: perm("req-10") })}`),
  POST(`${N}/dev-emit`, `{"cwd":"${CWD.a}","sessionId":"s-5","event":${JSON.stringify(perm("req-11"))}} x`),
  // ---- Listing: limits, cursors, filters.
  LIST(`?workspace=${A}`),
  LIST(`?workspace=${B}`),
  LIST(`?workspace=${A}&limit=1`),
  LIST(`?workspace=${A}&limit=0`),
  LIST(`?workspace=${A}&limit=-5`),
  LIST(`?workspace=${A}&limit=abc`),
  LIST(`?workspace=${A}&limit=2.5`),
  LIST(`?workspace=${A}&limit=Infinity`),
  LIST(`?workspace=${A}&limit=-Infinity`),
  LIST(`?workspace=${A}&limit=1e1`),
  LIST(`?workspace=${A}&limit=`),
  LIST(`?workspace=${A}&limit=%20%202%20`),
  LIST(`?workspace=${A}&limit=0x2`),
  LIST(`?workspace=${A}&limit=2&limit=1`),
  LIST(`?workspace=${A}&limit=999`),
  LIST(`?workspace=${A}&unreadOnly=1`),
  LIST(`?workspace=${A}&unreadOnly=true`),
  LIST("?workspace=all"),
  LIST("?workspace=all&limit=2"),
  LIST("?workspace=all&limit=2.5"),
  LIST("?workspace=all&unreadOnly=1&limit=3"),
  LIST(`?workspace=all&workspace=${A}`),
  LIST(`?workspace=${B}&workspace=all`),
  LIST("?workspace=%61ll"),
  LIST("?workspace=ALL"),
  LIST(`?workspace=${A.replace("_", "%5F")}`),
  LIST("?workspace=wks+aaaaaaaaaaaa"),
  // Hand-written rows: older than anything the routes write, for the cursor.
  ins(CWD.a, "old-1", "s-old", "session_idle", "Old one", OLD + 1),
  ins(CWD.a, "old-2", "s-old", "session_idle", "Old two", OLD + 2, OLD + 100),
  ins(CWD.a, "old-3", null, "scheduled_run_finished", "Old three", OLD + 3, "NULL", { run: "'run-1'", job: "'job-1'", payload: "'{\"status\":\"success\"}'" }),
  ins(CWD.a, "old-4", "s-old", "session_error", "Old four", OLD + 4, "NULL", { body: "'bad'", payload: "'not json'" }),
  ins(CWD.a, "old-5", "s-old", "session_idle", "Old five", OLD + 4),
  LIST(`?workspace=${A}`),
  LIST(`?workspace=${A}&before=${OLD + 4}`),
  LIST(`?workspace=${A}&before=${OLD + 4}&limit=1`),
  LIST(`?workspace=${A}&before=${OLD + 3}&unreadOnly=1`),
  LIST(`?workspace=${A}&before=abc`),
  LIST(`?workspace=${A}&before=0`),
  LIST(`?workspace=${A}&before=-1`),
  LIST(`?workspace=${A}&before=Infinity`),
  LIST(`?workspace=${A}&before=1e400`),
  LIST(`?workspace=${A}&before=${OLD + 3}.5`),
  LIST(`?workspace=all&before=${OLD + 2}`),
  // ---- The active workspace: cookie, then the store's hint.
  LIST("", cookie(`claudius.workspace=${A}`)),
  LIST("", cookie(`claudius.workspace=${B}`)),
  LIST("", cookie("claudius.workspace=wks_nope")),
  LIST("", cookie("claudius.workspace=")),
  LIST("", cookie(`claudius.workspace=%77ks_bbbbbbbbbbbb`)),
  LIST("", cookie(`claudius.workspace=${A}; claudius.workspace=${B}`)),
  LIST("", cookie(`x=1; claudius.workspace=${B}; y`)),
  LIST("?workspace=", cookie(`claudius.workspace=${B}`)),
  LIST(`?workspace=${A}`, cookie(`claudius.workspace=${B}`)),
  COUNTS,
  // ---- Single reads. `$ID<n>` is the n-th id the bus generated.
  PJ(`${N}/$ID1/read`, { workspaceId: A }),
  PJ(`${N}/$ID1/read`, { workspaceId: A }),
  POST(`${N}/$ID3/read`, undefined, cookie(`claudius.workspace=${A}`)),
  PJ(`${N}/$ID4/read`, { workspaceId: A }),
  PJ(`${N}/$ID4/read`, { workspaceId: B }),
  PJ(`${N}/old-1/read`, {}, cookie(`claudius.workspace=${A}`)),
  PJ(`${N}/old-1/read`, { workspaceId: "" }),
  PJ(`${N}/nope/read`, { workspaceId: A }),
  PJ(`${N}/nope/read`, { workspaceId: "wks_nope" }),
  POST(`${N}/nope/read`, "null"),
  POST(`${N}/nope/read`, "[]", cookie(`claudius.workspace=${A}`)),
  PJ(`${N}/a%20b/read`, { workspaceId: A }),
  PJ(`${N}/a%2Fb/read`, { workspaceId: A }),
  PJ(`${N}/old-2/read`, { workspaceId: A }),
  LIST(`?workspace=${A}`),
  LIST(`?workspace=${A}&unreadOnly=true`),
  LIST(`?workspace=${A}&unreadOnly=0`),
  // ---- By kind: validated before the workspace.
  POST(`${N}/read-by-kind`),
  POST(`${N}/read-by-kind`, "null"),
  PJ(`${N}/read-by-kind`, { kind: null }),
  PJ(`${N}/read-by-kind`, { kind: "" }),
  PJ(`${N}/read-by-kind`, { kind: "   " }),
  PJ(`${N}/read-by-kind`, { kind: 5 }),
  PJ(`${N}/read-by-kind`, { kind: false }),
  PJ(`${N}/read-by-kind`, { kind: ["permission_request"] }),
  PJ(`${N}/read-by-kind`, { kind: "nope", workspaceId: "wks_nope" }),
  PJ(`${N}/read-by-kind`, { kind: "Permission_request", workspaceId: A }),
  PJ(`${N}/read-by-kind`, { kind: "permission_request", workspaceId: "wks_nope" }),
  PJ(`${N}/read-by-kind`, { kind: "permission_request", workspaceId: 5 }),
  PJ(`${N}/read-by-kind`, { kind: " ask_user_question\n", workspaceId: A }),
  PJ(`${N}/read-by-kind`, { kind: "ask_user_question", workspaceId: A }),
  PJ(`${N}/read-by-kind`, { kind: "session_idle" }, cookie(`claudius.workspace=${A}`)),
  PJ(`${N}/read-by-kind`, { kind: "plan_approval_request" }),
  PJ(`${N}/read-by-kind`, { kind: "plan_approval_request", workspaceId: B }),
  PJ(`${N}/read-by-kind`, { kind: "scheduled_run_finished", workspaceId: A }),
  // ---- By session: actionable kinds survive.
  POST(`${N}/read-by-session`),
  POST(`${N}/read-by-session`, "null"),
  PJ(`${N}/read-by-session`, { sessionId: "" }),
  PJ(`${N}/read-by-session`, { sessionId: " \t " }),
  PJ(`${N}/read-by-session`, { sessionId: 5 }),
  PJ(`${N}/read-by-session`, { sessionId: {} }),
  PJ(`${N}/read-by-session`, { sessionId: "s-1", workspaceId: "wks_nope" }),
  PJ(`${N}/read-by-session`, { sessionId: " s-1 ", workspaceId: A }),
  PJ(`${N}/read-by-session`, { sessionId: "s-old", workspaceId: A }),
  PJ(`${N}/read-by-session`, { sessionId: "s-old", workspaceId: A }),
  PJ(`${N}/read-by-session`, { sessionId: "s-3" }, cookie(`claudius.workspace=${B}`)),
  LIST("?workspace=all&unreadOnly=1"),
  // ---- read-all.
  PJ(`${N}/read-all`, { workspaceId: B }),
  PJ(`${N}/read-all`, { workspaceId: B }),
  PJ(`${N}/read-all`, {}, cookie(`claudius.workspace=${A}`)),
  COUNTS,
  // ---- A master switch that's off; a workspace that opts into errors; a muted session.
  WS([WC, WA, WB, WD, WE]),
  PJ(`${N}/read-all`, { workspaceId: E }),
  LIST(`?workspace=${E}`),
  PJ(`${N}/read-all`, { workspaceId: D }),
  // D has a read-write handle only: it settles after the others.
  COUNTS,
  LIST(`?workspace=${D}`),
  COUNTS,
  EMITTO(CWD.d, "s-d", perm("req-d1")),
  EMITTO(CWD.d, "s-d", { type: "turn_status", status: "idle" }),
  EMITTO(CWD.e, "s-e", { type: "error", message: "it broke\nbadly" }, { hasSubscribers: false }),
  EMITTO(CWD.e, "s-e", { type: "error", message: "again" }, { hasSubscribers: true }),
  EMITTO(CWD.e, "s-e", { type: "error", message: "  Claude Code process aborted by user  " }),
  EMITTO(CWD.e, "s-e", { type: "ask_user_question", requestId: "req-e1", questions: [] }),
  SQL(CWD.e, "INSERT INTO session_notification_prefs(session_id, blocked, snooze_until) VALUES ('s-muted', 1, NULL), ('s-snoozed', 0, 9000000000000000), ('s-woke', 0, 1);"),
  EMITTO(CWD.e, "s-muted", perm("req-e2")),
  EMITTO(CWD.e, "s-snoozed", perm("req-e3")),
  EMITTO(CWD.e, "s-woke", perm("req-e4")),
  LIST(`?workspace=${E}`),
  PJ(`${N}/read-by-session`, { sessionId: "s-e", workspaceId: E }),
  PJ(`${N}/read-by-kind`, { kind: "session_error", workspaceId: E }),
  PJ(`${N}/read-by-kind`, { kind: "permission_request", workspaceId: D }),
  OPEN("s3"),
  EMITTO(CWD.b, "s-3", perm("req-12"), { hasSubscribers: false }),
  CLOSE("s3"),
  EMITTO(CWD.b, "s-3", perm("req-13")),
  LIST("?workspace=all&limit=4"),
  // ---- The hint: activeId, a missing one, an empty one.
  WS([WC, WA, WB, WD, WE], { activeId: B }),
  LIST(),
  PJ(`${N}/read-all`, {}),
  LIST("", cookie(`claudius.workspace=${A}`)),
  WS([WC, WA, WB, WD, WE], { activeId: "wks_gone" }),
  LIST(),
  PJ(`${N}/read-all`, {}),
  PJ(`${N}/read-by-kind`, { kind: "session_idle" }),
  PJ(`${N}/read-by-session`, { sessionId: "s-1" }),
  LIST("", cookie(`claudius.workspace=${A}`)),
  WS([WC, WA, WB, WD, WE], { activeId: "" }),
  LIST(),
  WS([WC, WA, WB, WD, WE], { activeId: null }),
  LIST(),
  PJ(`${N}/read-all`, {}),
  // ---- Odd entries: a rootPath that isn't a string settles at once; an
  // empty one waits on its fs.mkdir like any uncached root.
  WS([WC, WA, entry("wks_odd1", "O", 5), entry("wks_odd3", "Q", ""), WB, entry("wks_odd2", "P", undefined), WD, WE]),
  COUNTS,
  OPEN("s4"),
  CLOSE("s4"),
  LIST("?workspace=wks_odd1"),
  LIST("?workspace=wks_odd2"),
  PJ(`${N}/read-all`, { workspaceId: "wks_odd1" }),
  PJ(`${N}/read-all`, { workspaceId: "wks_odd2" }),
  PJ(`${N}/read-by-kind`, { kind: "session_idle", workspaceId: "wks_odd1" }),
  PJ(`${N}/read-by-session`, { sessionId: "s-1", workspaceId: "wks_odd1" }),
  PJ(`${N}/x/read`, { workspaceId: "wks_odd1" }),
  LIST("?workspace=all"),
  EMITTO(CWD.a, "s-1", perm("req-14")),
  // ---- A null entry: getWorkspace throws once it reaches it.
  WS([WA, null, WB, WC]),
  COUNTS,
  OPEN("s5"),
  CLOSE("s5"),
  LIST(`?workspace=${A}`),
  LIST(`?workspace=${B}`),
  LIST("?workspace=all"),
  LIST(),
  PJ(`${N}/read-all`, { workspaceId: A }),
  PJ(`${N}/read-all`, { workspaceId: B }),
  COUNTS,
  // ---- Stores the workspace store can't read.
  WSTEXT("{"),
  COUNTS,
  LIST(),
  LIST("?workspace=all"),
  LIST(`?workspace=${A}`),
  PJ(`${N}/read-all`, { workspaceId: A }),
  PJ(`${N}/read-by-kind`, { kind: "session_idle" }),
  PJ(`${N}/read-by-kind`, { kind: "nope" }),
  EMITTO(5, "s-1", { type: "ready" }),
  OPEN("s6"),
  CLOSE("s6"),
  WSTEXT("null"),
  COUNTS,
  LIST(),
  LIST(`?workspace=${A}`),
  WSTEXT(JSON.stringify({ version: 2, workspaces: [WA] })),
  COUNTS,
  LIST(),
  LIST(`?workspace=${A}`),
  PJ(`${N}/read-all`, {}),
  WSTEXT(null),
  COUNTS,
  LIST(),
  // ---- Back to three; C reads first now (its handle is cached).
  WS([WC, WA, WB]),
  COUNTS,
  OPEN("s7"),
  PJ(`${N}/read-all`, { workspaceId: C }),
  EMITTO(CWD.c, "s-c", perm("req-c1")),
  LIST(`?workspace=${C}`),
  COUNTS,
  CLOSE("s7"),
  LIST("?workspace=all&limit=200"),
  PING("monitor"),
  EMIT({ cwd: CWD.a, sessionId: "s-1", event: perm("req-16") }, { prod: true }),
  POST(`${N}/dev-emit`, "null", { prod: true }),
  CLOSE("monitor"),
];

// ------------------------------- run -------------------------------

/** `$ID<n>` in a step is the n-th generated row id. */
const withIds = (s) => (typeof s === "string" ? s.replace(/\$ID(\d+)/g, (_, n) => `00000000-0000-4000-a000-${String(Number(n)).padStart(12, "0")}`) : s);

let n = 0;
let last = Object.fromEntries(WATCH.map((c) => [c, null]));
const steps = [];
for (const s of STEPS) {
  const step = { ...s };
  if (s.op === "ws") {
    if (s.text === null) rmSync(WS_FILE, { force: true });
    else {
      mkdirSync(dirname(WS_FILE), { recursive: true });
      writeFileSync(WS_FILE, s.text);
      utimesSync(WS_FILE, s.mtime, s.mtime);
    }
  } else if (s.op === "sql") {
    runSql(s.cwd, s.sql, s.fresh);
  } else if (s.op === "open") {
    step.got = await openStream(s.stream);
  } else if (s.op === "close") {
    const st = streams.get(s.stream);
    st.ac.abort();
    await drain();
    step.got = { done: st.done, heartbeatCleared: st.interval?.cleared ?? null };
  } else if (s.op === "ping") {
    streams.get(s.stream).interval.fn();
  } else {
    n += 1;
    clock = BASE + n * 1_000_003;
    step.clock = clock;
    const path = withIds(s.path);
    const [mod, params] = routeFor(path);
    const headers = {};
    if (s.method === "POST") headers["content-type"] = "application/json";
    if (s.cookie !== undefined) headers.cookie = s.cookie;
    const req = new NextRequest(`http://localhost${path}`, { method: s.method, headers, body: s.body });
    const prev = process.env.NODE_ENV;
    if (s.prod) process.env.NODE_ENV = "production";
    let got;
    try {
      const res = await mod.handle(req, context(params));
      got = { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
    } catch (e) {
      got = { threw: e instanceof Error ? e.message : String(e) };
    } finally {
      if (s.prod) {
        if (prev === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prev;
      }
    }
    step.got = got;
  }
  await drain();
  runTimers();
  await drain();
  runTimers();
  await drain();
  const envs = {};
  for (const [label, st] of streams) {
    if (st.chunks.length) envs[label] = st.chunks.splice(0);
    if (s.op === "close" && label === s.stream) streams.delete(label);
  }
  if (Object.keys(envs).length) step.envs = envs;
  const rows = {};
  for (const cwd of WATCH) {
    const now = dump(cwd);
    const d = rowsDiff(last[cwd], now);
    if (d !== undefined) rows[cwd] = d;
    last[cwd] = now;
  }
  if (Object.keys(rows).length) step.rows = rows;
  steps.push(step);
}
if (timers.length) throw new Error("a flush is still queued");
if (streams.size) throw new Error("a stream is still open");

const fixture = {
  base: BASE,
  heartbeat: { ms: steps.find((s) => s.op === "open").got.heartbeatMs, chunk: steps.find((s) => s.op === "ping").envs.monitor[0] },
  watch: WATCH,
  steps,
};
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify(fixture));
process.exit(0);
