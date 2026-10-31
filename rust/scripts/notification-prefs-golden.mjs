#!/usr/bin/env node
// Golden fixture for the per-session notification prefs (S24):
// `GET/POST /api/sessions/:id/notification-prefs` and the prefs half of
// `lib/server/notifications-db.ts` (`getSessionPrefs`, `setSessionPrefs`,
// `isSessionMuted`), recorded from the real TS sources:
//
//   node rust/scripts/notification-prefs-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd (db.ts reads the migrations from there), HOME and CLAUDE_CONFIG_DIR at
// a temp dir, a resolve hook for the `@/` imports, and `Date.now` stubbed.
// Three parts:
// * `steps`: the route handlers, in order. Reaped sessions resolve their cwd
//   (and so their per-project DB) from a transcript under
//   <config>/projects (`transcripts`); the one live session (`live`) has
//   `sessionManager.get` stubbed to its own cwd while its transcript names
//   another. Interleaved: hand-written SQL (`sql`; `fresh` = a bare DB file
//   without the migrations) and dumps of a DB's rows (`rows`: each column's
//   SQLite type and value). Every request runs at its own `clock`, so each
//   computed `snoozeUntil` is distinct; a POST that computed one records the
//   `snoozeMinutes` it was given. `got` is the status, content type and raw
//   body text, or `threw` (Next's empty 500).
// * `snooze`: `Date.now() + Math.floor(m) * 60_000` as the route answers it
//   (the raw `snoozeUntil` text) for every pair of clock values and minutes.
// * `db`: the DB functions called directly, in order: `set` (a patch;
//   `"Infinity"` stands for the number), `get`, `muted` (`isSessionMuted` at
//   a pinned clock), `sql` and `rows`, over rows from those calls,
//   hand-written ones with foreign column values, and a table created with
//   other column types.
//
// Written to rust/crates/claudius-core/tests/fixtures/notification_prefs_golden.json;
// replayed by crates/claudius-core/tests/notification_prefs_golden.rs (`snooze`
// and `db`) and crates/claudius-server/tests/notification_prefs.rs (`steps`,
// against the real binary).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/notification_prefs_golden.json");

if (!process.env.NP_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "notification-prefs-golden-")));
  try {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      {
        cwd: repo,
        stdio: "inherit",
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: join(root, "config"),
          NP_GOLDEN_CHILD: "1",
        },
      },
    );
    process.exit(r.status ?? 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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

const BASE = 1_700_000_000_000; // well before any real clock the replay runs at
let clock = BASE;
Date.now = () => clock;

const { default: Database } = await import("better-sqlite3");
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const { getSessionPrefs, setSessionPrefs, isSessionMuted } = await import(join(repo, "lib/server/notifications-db.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const route = await import(join(repo, "app/api/sessions/[id]/notification-prefs/route.ts"));

/** `00000000-0000-4000-8000-<n>`: a session id. */
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CWD = {
  live: "/claudius-golden/live",
  a: "/claudius-golden/projA",
  nodb: "/claudius-golden/nodb",
  foreign: "/claudius-golden/foreign",
  broken: "/claudius-golden/broken",
  snooze: "/claudius-golden/snooze",
  db: "/claudius-golden/db",
  dbBroken: "/claudius-golden/db-broken",
  dbLoose: "/claudius-golden/db-loose",
};
const LIVE = u(1);
const R1 = u(2); // projA: the main sequence
const R3 = u(3); // projA: no row in an existing DB
const NODB = u(4); // a cwd whose DB is never created
const NOCWD = u(5); // a transcript without a cwd
const EMPTYCWD = u(6); // a transcript whose cwd is ""
const MISSING = u(7); // no transcript at all
const BROKEN = u(8); // a DB from a newer schema, without the table
const SNOOZE = u(9); // the `snooze` table
const F = { b2: u(10), btext: u(11), stext: u(12), sreal: u(13), sblob: u(14), sbig: u(15), sinf: u(16) };

// ------------------------------- transcripts -------------------------------

// The SDK's project dir name for a short absolute path.
const dirName = (abs) => abs.replace(/[^a-zA-Z0-9]/g, "-");
/** One user turn; `cwd: undefined` leaves the field out. */
function transcript(id, cwd) {
  const line = {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId: id,
    version: "2.1.300",
    type: "user",
    message: { role: "user", content: "hello" },
    uuid: `${id.slice(0, 24)}aaaaaaaaaaaa`,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  return `${JSON.stringify(line)}\n`;
}
const TRANSCRIPTS = [
  // The live session's transcript names projA, where a hand-written row for
  // it waits: the live cwd must win.
  { id: LIVE, cwd: CWD.a },
  { id: R1, cwd: CWD.a },
  { id: R3, cwd: CWD.a },
  { id: NODB, cwd: CWD.nodb },
  { id: NOCWD, cwd: undefined, dir: "/claudius-golden/odd" },
  { id: EMPTYCWD, cwd: "", dir: "/claudius-golden/odd" },
  { id: BROKEN, cwd: CWD.broken },
  { id: SNOOZE, cwd: CWD.snooze },
  ...Object.values(F).map((id) => ({ id, cwd: CWD.foreign })),
].map((t) => ({ id: t.id, dir: dirName(t.dir ?? t.cwd), text: transcript(t.id, t.cwd) }));
for (const t of TRANSCRIPTS) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", t.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${t.id}.jsonl`), t.text);
}
sessionManager.get = (id) => (id === LIVE ? { id: LIVE, cwd: CWD.live } : undefined);

// ------------------------------- helpers -------------------------------

const ROWS_SQL = `SELECT session_id,
    typeof(blocked), CASE typeof(blocked) WHEN 'integer' THEN CAST(blocked AS TEXT) WHEN 'blob' THEN hex(blocked) ELSE blocked END,
    typeof(snooze_until), CASE typeof(snooze_until) WHEN 'integer' THEN CAST(snooze_until AS TEXT) WHEN 'blob' THEN hex(snooze_until) ELSE snooze_until END
  FROM session_notification_prefs ORDER BY session_id`;
/** Every prefs row of `cwd`'s DB as `[session_id, typeof, value, typeof, value]`. */
async function rows(cwd) {
  const db = await openDb(cwd);
  return db.prepare(ROWS_SQL).raw().all();
}
/** Run hand-written SQL on `cwd`'s DB; `fresh`: a bare file, no migrations. */
async function runSql(cwd, sql, fresh) {
  if (fresh) {
    const path = join(process.env.HOME, ".claude", "projects", dirName(cwd), ".claudius.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(sql);
    db.close();
  } else {
    (await openDb(cwd)).exec(sql);
  }
}
const threw = (e) => ({ threw: e instanceof Error ? e.message : String(e) });

// ------------------------------- route steps -------------------------------

const G = (id) => ({ op: "get", id });
const P = (id, body) => ({ op: "post", id, body });
const J = (id, v) => P(id, JSON.stringify(v));
const SQL = (cwd, sql, fresh = false) => ({ op: "sql", cwd, sql, ...(fresh ? { fresh } : {}) });
const ROWS = (cwd) => ({ op: "rows", cwd });
const ins = (id, blocked, snooze) => `INSERT INTO session_notification_prefs(session_id, blocked, snooze_until) VALUES ('${id}', ${blocked}, ${snooze});`;

const STEPS = [
  // Unknown sessions: 404 before the body is looked at.
  G(MISSING),
  G("not-a-uuid"),
  G(NOCWD),
  G(EMPTYCWD),
  J(MISSING, { blocked: true }),
  P(MISSING, "null"),
  P(MISSING, "{"),
  P("not-a-uuid", "{}"),
  P(EMPTYCWD, "null"),
  // No DB, then a DB without the row.
  G(NODB),
  G(R1),
  P(R1, null),
  G(R1),
  G(R3),
  ROWS(CWD.a),
  // Bodies that aren't a patch object.
  P(R1, "{"),
  P(R1, ""),
  P(R1, "null"),
  P(R1, "[]"),
  P(R1, "[1,2]"),
  P(R1, '"blocked"'),
  P(R1, "7"),
  P(R1, "true"),
  P(R1, "1e400"),
  // blocked: booleans only.
  J(R1, { blocked: true }),
  G(R1),
  J(R1, { blocked: "yes" }),
  J(R1, { blocked: 0 }),
  J(R1, { blocked: null }),
  J(R1, { blocked: [] }),
  J(R1, { blocked: {} }),
  G(R1),
  J(R1, { blocked: false }),
  // snoozeMinutes: null clears, a finite number > 0 snoozes, the rest is 400.
  J(R1, { snoozeMinutes: 5 }),
  G(R1),
  J(R1, { blocked: true }),
  J(R1, {}),
  J(R1, { snoozeMinutes: null }),
  G(R1),
  J(R1, { snoozeMinutes: 0 }),
  J(R1, { snoozeMinutes: -1 }),
  P(R1, '{"snoozeMinutes":-0}'),
  J(R1, { snoozeMinutes: -0.5 }),
  J(R1, { snoozeMinutes: "5" }),
  J(R1, { snoozeMinutes: "" }),
  J(R1, { snoozeMinutes: "abc" }),
  J(R1, { snoozeMinutes: "NaN" }),
  J(R1, { snoozeMinutes: "Infinity" }),
  J(R1, { snoozeMinutes: true }),
  J(R1, { snoozeMinutes: false }),
  J(R1, { snoozeMinutes: [5] }),
  J(R1, { snoozeMinutes: { n: 5 } }),
  P(R1, '{"snoozeMinutes":1e400}'),
  P(R1, '{"snoozeMinutes":-1e400}'),
  P(R1, '{"blocked":false,"snoozeMinutes":1e999}'),
  G(R1),
  J(R1, { snoozeMinutes: 1.9 }),
  J(R1, { snoozeMinutes: 0.5 }),
  J(R1, { snoozeMinutes: 5e-324 }),
  J(R1, { snoozeMinutes: 1440 }),
  G(R1),
  ROWS(CWD.a),
  // Huge snoozes: past 2^53, past i64 (stored REAL), past 1e21, overflowing.
  J(R1, { snoozeMinutes: 1e12 }),
  ROWS(CWD.a),
  J(R1, { snoozeMinutes: 1e15 }),
  G(R1),
  ROWS(CWD.a),
  J(R1, { snoozeMinutes: 1.5e17 }),
  G(R1),
  J(R1, { snoozeMinutes: 2.9e303 }),
  G(R1),
  J(R1, { snoozeMinutes: 1e308 }),
  G(R1),
  ROWS(CWD.a),
  J(R1, { blocked: false }),
  P(R1, '{"snoozeMinutes":9007199254740993}'),
  J(R1, { snoozeMinutes: 123456789.123 }),
  // Combined patches: a bad snooze rejects the whole patch.
  J(R1, { blocked: true, snoozeMinutes: 10 }),
  G(R1),
  J(R1, { blocked: false, snoozeMinutes: null }),
  G(R1),
  J(R1, { blocked: true, snoozeMinutes: 0 }),
  J(R1, { blocked: true, snoozeMinutes: "x" }),
  G(R1),
  J(R1, { blocked: "true", snoozeMinutes: 2 }),
  P(R1, '{"snoozeMinutes":5,"snoozeMinutes":null,"blocked":true,"blocked":false}'),
  J(R1, { blocked: true, extra: { snoozeMinutes: 0 }, snoozeminutes: 0 }),
  P(R1, '\uFEFF{"blocked":false}'),
  P(R1, ' \n {"snoozeMinutes" : 3 } \n'),
  P(R1, '{"blocked":true} trailing'),
  G(R1),
  // A second session in the same DB.
  J(R3, { snoozeMinutes: null }),
  G(R3),
  J(R3, { snoozeMinutes: 60 }),
  ROWS(CWD.a),
  // Live session: its own cwd beats the transcript's (projA holds a blocked row for it).
  SQL(CWD.a, ins(LIVE, 1, 12345)),
  G(LIVE),
  J(LIVE, { blocked: true }),
  G(LIVE),
  J(LIVE, { snoozeMinutes: 3 }),
  G(LIVE),
  P(LIVE, "null"),
  ROWS(CWD.a),
  ROWS(CWD.live),
  // Foreign column values (only another writer could store them).
  SQL(
    CWD.foreign,
    [
      ins(F.b2, 2, "NULL"),
      ins(F.btext, "'yes'", "NULL"),
      ins(F.stext, 0, "'abc'"),
      ins(F.sreal, 1, "1.5"),
      ins(F.sblob, 0, "X'00ff'"),
      ins(F.sbig, 0, "9007199254740993"),
      ins(F.sinf, 0, "9e999"),
    ].join("\n"),
  ),
  ROWS(CWD.foreign),
  ...Object.values(F).map(G),
  ...Object.values(F).map((id) => J(id, {})),
  ROWS(CWD.foreign),
  ...Object.values(F).map((id) => J(id, { blocked: true })),
  ...Object.values(F).map(G),
  ROWS(CWD.foreign),
  // A DB from a newer schema without the table: the queries throw.
  SQL(CWD.broken, "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999');", true),
  G(BROKEN),
  J(BROKEN, { blocked: true }),
  J(BROKEN, { snoozeMinutes: 0 }),
  P(BROKEN, "null"),
  P(BROKEN, "[]"),
  G(BROKEN),
];

const steps = [];
let tick = 0;
for (const s of STEPS) {
  if (s.op === "sql") {
    await runSql(s.cwd, s.sql, s.fresh);
    steps.push(s);
    continue;
  }
  if (s.op === "rows") {
    steps.push({ ...s, got: await rows(s.cwd) });
    continue;
  }
  tick += 1;
  clock = BASE + tick * 1_000_003;
  const url = `http://localhost/api/sessions/${s.id}/notification-prefs`;
  const req =
    s.op === "get"
      ? new Request(url)
      : new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: s.body ?? undefined });
  let got;
  try {
    const res = await route[s.op === "get" ? "GET" : "POST"](req, { params: Promise.resolve({ id: s.id }) });
    got = { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  } catch (e) {
    got = threw(e);
  }
  const step = { ...s, clock, got };
  // The minutes behind a computed snoozeUntil (JSON.parse reads 1e400 as Infinity: not one).
  let parsed;
  try {
    parsed = JSON.parse(s.body ?? "");
  } catch {
    parsed = undefined;
  }
  const m = parsed?.snoozeMinutes;
  if (got.status === 200 && Number.isFinite(m) && m > 0) step.snoozeMinutes = m;
  steps.push(step);
}

// ------------------------------- snooze arithmetic -------------------------------

const NOWS = [0, 1, 999, BASE, BASE + 1, 2 ** 53 - 1, 8.64e15];
const MINUTES = [
  1, 1.9, 2, 0.5, 5e-324, 1e-7, 59.99, 60, 1440, 525600, 123.456, 1e6, 1e9, 1e12, 1.5e12, 2 ** 53, 2 ** 53 + 2,
  1e15, 1e16, 1.234567e17, 1.5e17, 1e21 / 60000, 1e20, 3e290, 2.9e303, 2.9961552247705e303, 2.99615522477053e303,
  3e303, 1.7976931348623157e308,
];
const snooze = [];
for (const now of NOWS) {
  for (const minutes of MINUTES) {
    clock = now;
    const res = await route.POST(
      new Request(`http://localhost/api/sessions/${SNOOZE}/notification-prefs`, {
        method: "POST",
        body: JSON.stringify({ snoozeMinutes: minutes }),
      }),
      { params: Promise.resolve({ id: SNOOZE }) },
    );
    const text = await res.text();
    const at = text.indexOf('"snoozeUntil":');
    if (res.status !== 200 || at < 0) throw new Error(`snooze ${minutes}: ${res.status} ${text}`);
    snooze.push({ now, minutes, got: text.slice(at + '"snoozeUntil":'.length, -1) });
  }
}

// ------------------------------- DB functions -------------------------------

const S = (id, patch, cwd) => ({ fn: "set", id, patch, ...(cwd ? { cwd } : {}) });
const GET = (id, cwd) => ({ fn: "get", id, ...(cwd ? { cwd } : {}) });
const M = (id, now, cwd) => ({ fn: "muted", id, now, ...(cwd ? { cwd } : {}) });
const DQ = (sql, fresh, cwd) => ({ fn: "sql", sql, ...(fresh ? { fresh } : {}), ...(cwd ? { cwd } : {}) });
const DROWS = (cwd) => ({ fn: "rows", ...(cwd ? { cwd } : {}) });
const D = {
  foreign: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35].map(u),
};
const DB_STEPS = [
  // No DB, then no row.
  GET(u(1)),
  M(u(1), BASE),
  S(u(1), {}),
  GET(u(1)),
  GET(u(2)),
  M(u(2), BASE),
  M(u(1), BASE),
  // Patches keep what they don't name.
  S(u(1), { blocked: true }),
  M(u(1), BASE),
  S(u(1), { snoozeUntil: BASE + 1000 }),
  S(u(1), { blocked: false }),
  GET(u(1)),
  M(u(1), BASE + 999),
  M(u(1), BASE + 1000),
  M(u(1), BASE + 1001),
  S(u(1), {}),
  S(u(1), { snoozeUntil: null }),
  M(u(1), BASE),
  S(u(1), { blocked: true, snoozeUntil: null }),
  S(u(3), { blocked: true, snoozeUntil: BASE - 5 }),
  M(u(3), BASE),
  S(u(3), { blocked: false }),
  M(u(3), BASE),
  S(u(4), { snoozeUntil: "Infinity" }),
  GET(u(4)),
  M(u(4), BASE),
  M(u(4), 8.64e15),
  S(u(4), { blocked: false }),
  S(u(5), { snoozeUntil: 1.5 }),
  M(u(5), 1),
  M(u(5), 2),
  S(u(6), { snoozeUntil: 0 }),
  M(u(6), -1),
  M(u(6), 0),
  S(u(7), { snoozeUntil: -1 }),
  S(u(8), { snoozeUntil: 6e19 }),
  M(u(8), 8.64e15),
  S(u(9), { blocked: false, snoozeUntil: 2 ** 53 + 2 }),
  S(u(10), { snoozeUntil: 1.7976931348623157e308 }),
  S(u(11), { snoozeUntil: 1e21 }),
  S(u(12), { snoozeUntil: 123.456 }),
  DROWS(),
  // Hand-written rows with values only another writer could store.
  DQ(
    [
      ins(D.foreign[0], 2, "NULL"),
      ins(D.foreign[1], "'yes'", "NULL"),
      ins(D.foreign[2], "1.0", "NULL"),
      ins(D.foreign[3], "'1'", "NULL"),
      ins(D.foreign[4], 0, "'abc'"),
      ins(D.foreign[5], 0, "'Infinity'"),
      ins(D.foreign[6], 0, "X'00ff'"),
      ins(D.foreign[7], 0, "X'3939393939393939393939393939'"),
      ins(D.foreign[8], 0, "9007199254740993"),
      ins(D.foreign[9], 0, "'0x1FFFFFFFFFFF'"),
      ins(D.foreign[10], 0, "'  '"),
      ins(D.foreign[11], 0, "' 99999999999999 '"),
      ins(D.foreign[12], 0, "'1e400'"),
      ins(D.foreign[13], 0, "-9e999"),
      ins(D.foreign[14], "X'01'", "''"),
    ].join("\n"),
  ),
  DROWS(),
  ...D.foreign.flatMap((id) => [GET(id), M(id, BASE)]),
  ...D.foreign.map((id) => S(id, {})),
  DROWS(),
  ...D.foreign.map((id) => S(id, { blocked: true })),
  ...D.foreign.flatMap((id) => [GET(id), M(id, BASE)]),
  DROWS(),
  // A table another writer created with other column types (the migration's
  // CREATE TABLE IF NOT EXISTS keeps it). better-sqlite3 binds every number
  // as a REAL: `blocked` (no affinity) keeps 1.0, `snooze_until` (TEXT) stores
  // its text, and `setSessionPrefs` still answers what it was given. A REAL
  // 1.0 `blocked` is `=== 1`; a TEXT '1' (kept as text here) and a 2.5 aren't.
  DQ(
    [
      "DROP TABLE session_notification_prefs;",
      "CREATE TABLE session_notification_prefs (session_id TEXT PRIMARY KEY, blocked, snooze_until TEXT);",
      ins(u(4), "1.0", "NULL"),
      ins(u(5), "'1'", "NULL"),
      ins(u(6), "2.5", "NULL"),
    ].join("\n"),
    false,
    CWD.dbLoose,
  ),
  S(u(1), { blocked: true, snoozeUntil: BASE + 1000 }, CWD.dbLoose),
  S(u(2), { snoozeUntil: 1.5 }, CWD.dbLoose),
  S(u(3), { blocked: false, snoozeUntil: "Infinity" }, CWD.dbLoose),
  DROWS(CWD.dbLoose),
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => [GET(u(n), CWD.dbLoose), M(u(n), BASE, CWD.dbLoose)]),
  ...[1, 2, 3, 4, 5, 6].map((n) => S(u(n), {}, CWD.dbLoose)),
  S(u(1), { blocked: false }, CWD.dbLoose),
  M(u(1), BASE, CWD.dbLoose),
  DROWS(CWD.dbLoose),
  // A DB from a newer schema without the table.
  DQ("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999');", true, CWD.dbBroken),
  GET(u(1), CWD.dbBroken),
  M(u(1), BASE, CWD.dbBroken),
  S(u(1), { blocked: true }, CWD.dbBroken),
];

const db = [];
for (const s of DB_STEPS) {
  const cwd = s.cwd ?? CWD.db;
  let got;
  try {
    if (s.fn === "sql") {
      await runSql(cwd, s.sql, s.fresh);
      db.push(s);
      continue;
    } else if (s.fn === "rows") got = await rows(cwd);
    else if (s.fn === "get") got = await getSessionPrefs(cwd, s.id);
    else if (s.fn === "set") {
      const patch = { ...s.patch };
      if (patch.snoozeUntil === "Infinity") patch.snoozeUntil = Infinity;
      clock = BASE;
      got = await setSessionPrefs(cwd, s.id, patch);
    } else {
      clock = s.now;
      got = await isSessionMuted(cwd, s.id);
    }
    // JSON.stringify's view of it (Buffer -> {type, data}, Infinity -> null).
    got = got === undefined ? { undefined: true } : JSON.parse(JSON.stringify(got));
  } catch (e) {
    got = threw(e);
  }
  db.push({ ...s, got });
}

const fixture = { now: BASE, live: { id: LIVE, cwd: CWD.live }, transcripts: TRANSCRIPTS, steps, snooze, db };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(
  `wrote ${out.slice(repo.length + 1)}: ${steps.length} steps (${steps.filter((s) => s.op === "get" || s.op === "post").length} requests), ${snooze.length} snooze, ${db.length} db`,
);
process.exit(0);
