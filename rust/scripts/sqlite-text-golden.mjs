#!/usr/bin/env node
// Golden fixture for SQLite text binds (I15): how better-sqlite3 binds a JS
// string (V8's `String::Utf8Value`: a lone surrogate as its own 3-byte
// sequence, `\ud800` -> ED A0 80) and how it reads TEXT back (V8's
// `String::NewFromUtf8`: one U+FFFD per maximal invalid subpart), through the
// real TS stores:
//
//   node rust/scripts/sqlite-text-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself twice under `--experimental-transform-types` (two temp
// roots; both recordings must agree byte for byte) with the repo as its cwd
// (db.ts reads its migrations from there), HOME and CLAUDE_CONFIG_DIR in the
// temp root, a resolve hook for the `@/` imports and `Date.now` pinned to
// T0. Parts:
//
// * `binds`: `SELECT typeof(?), hex(?)` of each JS string (the strings of
//   the scenarios plus a few more).
// * `decode`: `SELECT CAST(? AS TEXT)` of raw bytes (invalid UTF-8 of every
//   kind): the UTF-16 code units of the JS string better-sqlite3 returns.
// * `scenarios`: one cwd each. `writes` are store calls in order, then
//   `dump` holds every row of `tables` (`ORDER BY rowid`, each cell as
//   `[typeof, hex]`), then `reads` are store calls that change nothing.
//   Each call is `{op, args, result}`, `result` the `JSON.stringify` text of
//   what it returned (`null` for `undefined`, a Map as its entries, a
//   `listIndexedSessions` row as `[id, cwd, title, model]`) or
//   `{"throws": message}`. Strings mix lone surrogates (high, low, low then
//   high, high at the end), an astral character, NUL, a real U+FFFD, plain
//   and empty text; lookups also use the string as it reads back (each lone
//   surrogate as three U+FFFD), which TS doesn't match either. Scenarios:
//   `sessions:<string>` (sessions-db.ts, prompt-drafts-db.ts,
//   goal-messages-db.ts; the cwd itself holds the string), `notifications`
//   (notifications-db.ts: inbox and prefs), `queue` (queued-messages-db.ts),
//   `assets` (asset-ingest.ts `recordSendUses`, asset-list.ts), `open tabs`
//   (open-tabs-db.ts: JSON text, where JSON.stringify escapes lone
//   surrogates), `other stores` (session-usage-db.ts, session-tasks-db.ts,
//   loop-ticks-db.ts, feedback-store.ts, mcp-needs-auth-db.ts,
//   mcp-disconnected-db.ts, db-agents.ts, sessions-db.ts's
//   `getSessionAccountsByCwd`), `foreign` (raw SQL writes invalid UTF-8 into TEXT
//   columns, read back through the stores), `asset cursor` and `odd types`
//   (S29a: a `uuid` / `text` of every JSON type, as `POST /input` hands
//   them to queued-messages-db.ts, goal-messages-db.ts,
//   suggested-messages-db.ts and `recordSendUses`).
//
// Written to rust/crates/claudius-core/tests/fixtures/sqlite_text_golden.json;
// replayed by crates/claudius-core/tests/sqlite_text_golden.rs, which runs
// the writes through the Rust stores (dump compared hex for hex, time
// columns masked) and the reads both on its own database and on one
// rebuilt from this dump.
//
// The source is ASCII only: every non-ASCII string is built with
// `String.fromCharCode`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/sqlite_text_golden.json");

if (!process.env.SQLITE_TEXT_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sqlite-text-golden-")));
    try {
      for (const d of ["home", "config"]) mkdirSync(join(root, d));
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
            SQLITE_TEXT_GOLDEN_CHILD: root,
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
  const calls = fixture.scenarios.reduce((n, s) => n + s.writes.length + s.reads.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.binds.length} binds, ${fixture.decode.length} decodes, ` +
      `${fixture.scenarios.length} scenarios, ${calls} calls (stable)`,
  );
  process.exit(0);
}

const ROOT_DIR = process.env.SQLITE_TEXT_GOLDEN_CHILD;

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
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const T0 = 1_700_000_000_000;
Date.now = () => T0;

const lib = (p) => import(join(repo, "lib/server", p));
const sessionsDb = await lib("sessions-db.ts");
const drafts = await lib("prompt-drafts-db.ts");
const goals = await lib("goal-messages-db.ts");
const suggested = await lib("suggested-messages-db.ts");
const notifs = await lib("notifications-db.ts");
const queue = await lib("queued-messages-db.ts");
const ingest = await lib("asset-ingest.ts");
const assetList = await lib("asset-list.ts");
const tabs = await lib("open-tabs-db.ts");
const usage = await lib("session-usage-db.ts");
const tasks = await lib("session-tasks-db.ts");
const ticks = await lib("loop-ticks-db.ts");
const feedback = await lib("feedback-store.ts");
const needsAuth = await lib("mcp-needs-auth-db.ts");
const disconnected = await lib("mcp-disconnected-db.ts");
const dbAgents = await lib("db-agents.ts");
const { openDb } = await lib("db.ts");

const require = createRequire(join(repo, "package.json"));
const Database = require("better-sqlite3");
const probe = new Database(":memory:");
const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
/** The string as better-sqlite3 reads it back once bound. */
const rt = (s) => probe.prepare("SELECT ? AS v").pluck().get(s);

const ch = (...u) => String.fromCharCode(...u);
const STRINGS = [
  ["lone high", "a" + ch(0xd800) + "b"],
  ["lone low", ch(0xdc00)],
  ["low then high", ch(0xdfff, 0xd800)],
  ["high at the end", "z" + ch(0xdbff)],
  ["astral", "x" + ch(0xd83d, 0xde00) + "y"],
  ["nul", "n" + ch(0) + "l"],
  ["replacement char", ch(0xfffd)],
  ["plain", "plain"],
  ["empty", ""],
];
const S = STRINGS.map(([, s]) => s);

// ------------------------------- binds / decode ------------------------------

const BIND_ONLY = [
  ["two-byte", ch(0xe9)],
  ["three-byte", ch(0x20ac)],
  ["U+FFFF", ch(0xffff)],
  ["last BMP before surrogates", ch(0xd7ff)],
  ["first after surrogates", ch(0xe000)],
  ["U+10F7FF (below the stand-ins)", ch(0xdbfd, 0xdfff)],
  ["U+10F800 (a stand-in)", ch(0xdbfe, 0xdc00)],
  ["U+10FFFF (a stand-in)", ch(0xdbff, 0xdfff)],
  ["lone kinds around a pair", ch(0xd800, 0x41, 0xd83d, 0xde00, 0xdfff, 0xd83d)],
];
const binds = [...STRINGS, ...BIND_ONLY].map(([name, s]) => {
  const [t, h] = probe.prepare("SELECT typeof(?), hex(?)").raw().get(s, s);
  return { name, s, type: t, hex: h };
});

const DECODE = [
  "61eda08062", "eda080", "edb080", "edbfbf", "eda0bdedb880", "ed9fbf", "ee8080",
  "c0af", "c1bf", "e080af", "e08080", "f08f8080", "f4908080", "f5808080", "f8888080",
  "fc84808080", "fe", "ff", "80", "bf", "8080", "c3", "c3c3", "e282", "e28228",
  "f09f98", "f09f9828", "f0", "f4", "f48fbfbf", "f09f9880", "efbfbd", "efbfbf",
  "00", "610062", "6100ff62", "e2", "e228a1", "f0289f98",
];
const decode = DECODE.map((hex) => ({
  hex,
  units: units(probe.prepare("SELECT CAST(? AS TEXT)").pluck().get(Buffer.from(hex, "hex"))),
}));

// --------------------------------- scenarios ---------------------------------

const OPS = {
  exec: async (cwd, sql) => {
    (await openDb(cwd)).exec(sql);
  },
  upsertSession: (opts) => sessionsDb.upsertSession(opts),
  touchSession: (cwd, id) => sessionsDb.touchSession(cwd, id),
  setSessionTitle: (cwd, id, t) => sessionsDb.setSessionTitle(cwd, id, t),
  getSessionTitle: (cwd, id) => sessionsDb.getSessionTitle(cwd, id),
  setSessionGoal: (cwd, id, g) => sessionsDb.setSessionGoal(cwd, id, g),
  clearSessionGoal: (cwd, id) => sessionsDb.clearSessionGoal(cwd, id),
  setGoalAchieved: (cwd, id, s) => sessionsDb.setGoalAchieved(cwd, id, s),
  getSessionGoal: (cwd, id) => sessionsDb.getSessionGoal(cwd, id),
  mergeSessionState: (cwd, id, p) => sessionsDb.mergeSessionState(cwd, id, p),
  getSessionState: (cwd, id) => sessionsDb.getSessionState(cwd, id),
  listIndexedSessions: async (cwd) =>
    (await sessionsDb.listIndexedSessions(cwd)).map((r) => [r.id, r.cwd, r.title, r.model]),
  getSessionTitlesByCwd: async (pairs) => [...(await sessionsDb.getSessionTitlesByCwd(pairs)).entries()],
  setPromptDraft: (cwd, id, text, images) => drafts.setPromptDraft(cwd, id, text, images),
  getPromptDraft: (cwd, id) => drafts.getPromptDraft(cwd, id),
  clearPromptDraft: (cwd, id) => drafts.clearPromptDraft(cwd, id),
  recordGoalMessage: (cwd, input) => goals.recordGoalMessage(cwd, input),
  listGoalMessageUuids: (cwd, id) => goals.listGoalMessageUuids(cwd, id),
  recordSuggestedMessage: (cwd, input) => suggested.recordSuggestedMessage(cwd, input),
  listSuggestedMessageUuids: (cwd, id) => suggested.listSuggestedMessageUuids(cwd, id),
  insertNotification: (cwd, ws, input) => notifs.insertNotification(cwd, ws, input),
  listNotifications: (cwd, ws, opts) => notifs.listNotifications(cwd, ws, opts),
  getNotification: (cwd, ws, id) => notifs.getNotification(cwd, ws, id),
  markRead: (cwd, ids) => notifs.markRead(cwd, ids),
  markReadByRequestId: (cwd, id) => notifs.markReadByRequestId(cwd, id),
  markReadBySession: (cwd, id) => notifs.markReadBySession(cwd, id),
  unreadCountsBySession: (cwd) => notifs.unreadCountsBySession(cwd),
  setSessionPrefs: (cwd, id, patch) => notifs.setSessionPrefs(cwd, id, patch),
  getSessionPrefs: (cwd, id) => notifs.getSessionPrefs(cwd, id),
  enqueueTail: (cwd, input) => queue.enqueueTail(cwd, input),
  listQueue: (cwd, sid) => queue.listQueue(cwd, sid),
  updateByUuid: (cwd, sid, uuid, patch) => queue.updateByUuid(cwd, sid, uuid, patch),
  popByUuid: (cwd, sid, uuid) => queue.popByUuid(cwd, sid, uuid),
  popHead: (cwd, sid) => queue.popHead(cwd, sid),
  removeByUuid: (cwd, sid, uuid) => queue.removeByUuid(cwd, sid, uuid),
  clearAll: (cwd, sid) => queue.clearAll(cwd, sid),
  moveByUuid: (cwd, sid, uuid, dir) => queue.moveByUuid(cwd, sid, uuid, dir),
  recordSendUses: (opts) => ingest.recordSendUses(opts),
  listAssets: (opts) => assetList.listAssets(opts),
  listUses: (cwd, hash) => assetList.listUses(cwd, hash),
  deleteAssetRow: (cwd, hash) => assetList.deleteAssetRow(cwd, hash),
  backfillProject: (cwd) => ingest.backfillProject(cwd),
  writeTranscript: (dir, name, text, mtime) => {
    const d = join(process.env.HOME, ".claude", "projects", dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), text);
    utimesSync(join(d, name), mtime, mtime);
  },
  query: async (cwd, sql) => (await openDb(cwd)).prepare(sql).raw().all(),
  setOpenTabs: (cwd, ids) => tabs.setOpenTabs(cwd, ids),
  getOpenTabs: (cwd) => tabs.getOpenTabs(cwd),
  setPinnedTabs: (cwd, ids) => tabs.setPinnedTabs(cwd, ids),
  getPinnedTabs: (cwd) => tabs.getPinnedTabs(cwd),
  setActiveTab: (cwd, id) => tabs.setActiveTab(cwd, id),
  getActiveTab: (cwd) => tabs.getActiveTab(cwd),
  saveSessionUsage: (cwd, sid, u) => usage.saveSessionUsage(cwd, sid, u),
  getSessionUsage: (cwd, sid) => usage.getSessionUsage(cwd, sid),
  saveSessionTask: (cwd, sid, task) => tasks.saveSessionTask(cwd, sid, task),
  listSessionTasks: (cwd, sid) => tasks.listSessionTasks(cwd, sid),
  recordLoopTick: (cwd, tick) => ticks.recordLoopTick(cwd, tick),
  attachLoopTickTokens: (cwd, id, n) => ticks.attachLoopTickTokens(cwd, id, n),
  listLoopBreakdown: (cwd) => ticks.listLoopBreakdown(cwd),
  insertFeedback: (cwd, rec) => feedback.insertFeedback(cwd, rec),
  listFeedback: (cwd, limit) => feedback.listFeedback(cwd, limit),
  syncNeedsAuthNotifications: (cwd, names) => needsAuth.syncNeedsAuthNotifications(cwd, names),
  syncDisconnectedNotifications: (cwd, names) => disconnected.syncDisconnectedNotifications(cwd, names),
  upsertDbAgent: (cwd, name, def) => dbAgents.upsertDbAgent(cwd, name, def),
  listDbAgents: (cwd) => dbAgents.listDbAgents(cwd),
  getSessionAccountsByCwd: async (pairs) => [...(await sessionsDb.getSessionAccountsByCwd(pairs)).entries()],
};

async function dump(cwd, tables) {
  const db = await openDb(cwd);
  const outTables = {};
  for (const t of tables) {
    const cols = db.prepare("SELECT name FROM pragma_table_info(?)").pluck().all(t);
    const sel = cols.map((c) => `typeof("${c}"), hex("${c}")`).join(", ");
    const rows = db.prepare(`SELECT ${sel} FROM "${t}" ORDER BY rowid`).raw().all();
    outTables[t] = { cols, rows: rows.map((r) => cols.map((_, i) => [r[2 * i], r[2 * i + 1]])) };
  }
  return outTables;
}

// readLegacyTitle's file, for one plain id: copying it binds the cwd.
const LEGACY_ID = "legacy-id";
const LEGACY_TITLES = JSON.stringify({ version: 1, titles: { [LEGACY_ID]: "legacy title" } });
mkdirSync(join(process.env.HOME, ".claude", ".claudius"), { recursive: true });
writeFileSync(join(process.env.HOME, ".claude", ".claudius", "session-titles.json"), LEGACY_TITLES);

const scenarios = [];
async function scenario(name, cwd, tables, body) {
  const sc = { name, cwd, tables, writes: [], reads: [], dump: null };
  let list = sc.writes;
  const run = async (op, ...args) => {
    let value;
    let text;
    try {
      value = await OPS[op](...args);
      text = JSON.stringify(value === undefined ? null : value);
    } catch (e) {
      text = JSON.stringify({ throws: String(e?.message ?? e) });
    }
    list.push({ op, args, result: text });
    return value;
  };
  const toReads = async () => {
    sc.dump = await dump(cwd, tables);
    list = sc.reads;
  };
  await body(run, toReads);
  if (!sc.dump) throw new Error(`${name}: no dump`);
  scenarios.push(sc);
}

for (const [i, [name, s]] of STRINGS.entries()) {
  const cwd = `/p${i}/${s}/w`;
  const id = `id-${s}`;
  const other = `other-${s}`;
  await scenario(`sessions:${name}`, cwd, ["sessions", "prompt_drafts", "goal_messages"], async (run, toReads) => {
    await run("upsertSession", { id, cwd, title: `t${s}`, model: `m${s}` });
    await run("setSessionTitle", cwd, id, ` T${s} `);
    await run("setSessionGoal", cwd, id, `g${s}`);
    await run("setGoalAchieved", cwd, id, `sum${s}`);
    await run("mergeSessionState", cwd, id, { k: `v${s}` });
    await run("upsertSession", { id: other, cwd, title: s });
    await run("setPromptDraft", cwd, id, `d${s}`, []);
    await run("recordGoalMessage", cwd, { sessionId: id, messageUuid: `m${s}`, text: `x${s}` });
    // The binds that clear: a blank title, the goal, an empty draft.
    const cleared = `c-${s}`;
    await run("upsertSession", { id: cleared, cwd, title: "c" });
    await run("setSessionTitle", cwd, cleared, "  ");
    await run("setSessionGoal", cwd, cleared, "g");
    await run("clearSessionGoal", cwd, cleared);
    await run("setPromptDraft", cwd, other, "o", []);
    await run("setPromptDraft", cwd, other, "", []);
    await run("setPromptDraft", cwd, cleared, "c", []);
    await run("clearPromptDraft", cwd, cleared);
    // touchSession's WHERE: only its row leaves the old clock.
    await run("exec", cwd, "UPDATE sessions SET updated_at = 1, last_seen_at = 2");
    await run("touchSession", cwd, id);
    // A legacy title is copied into a row for this cwd.
    await run("getSessionTitle", cwd, LEGACY_ID);
    await toReads();
    await run("getSessionTitle", cwd, id);
    await run("getSessionTitle", cwd, other);
    await run("getSessionTitle", cwd, rt(id));
    await run("getSessionGoal", cwd, id);
    await run("getSessionState", cwd, id);
    await run("listIndexedSessions", cwd);
    await run("listIndexedSessions", rt(cwd));
    await run("getSessionTitlesByCwd", [
      { cwd, id },
      { cwd, id: other },
      { cwd, id: rt(id) },
    ]);
    await run("getPromptDraft", cwd, id);
    await run("getPromptDraft", cwd, rt(id));
    await run("listGoalMessageUuids", cwd, id);
    await run("listGoalMessageUuids", cwd, rt(id));
  });
}

await scenario("notifications", "/n/w", ["notifications", "session_notification_prefs"], async (run, toReads) => {
  const cwd = "/n/w";
  for (const [i, s] of S.entries()) {
    await run("insertNotification", cwd, "ws", {
      id: `n${i}${s}`,
      sessionId: `s${s}`,
      runId: `r${s}`,
      jobId: null,
      kind: "session_idle",
      title: `T${s}`,
      body: `B${s}`,
      payload: { p: s },
      requestId: `q${i}${s}`,
      createdAt: 1000 + i,
    });
  }
  // The request id is taken: ignored.
  await run("insertNotification", cwd, "ws", {
    id: "dup",
    kind: "session_idle",
    title: "dup",
    requestId: `q0${S[0]}`,
    createdAt: 2000,
  });
  await run("markReadByRequestId", cwd, `q0${S[0]}`);
  await run("markReadByRequestId", cwd, rt(`q1${S[1]}`));
  await run("markRead", cwd, [`n2${S[2]}`, rt(`n3${S[3]}`), `n4${S[4]}`]);
  await run("markReadBySession", cwd, `s${S[5]}`);
  await run("markReadBySession", cwd, rt(`s${S[3]}`));
  for (const [i, s] of S.entries()) {
    await run("setSessionPrefs", cwd, `s${s}`, { blocked: i % 2 === 0 });
  }
  await run("setSessionPrefs", cwd, `s${S[0]}`, { snoozeUntil: 99 });
  await toReads();
  await run("listNotifications", cwd, "ws", {});
  for (const [i, s] of S.entries()) await run("getNotification", cwd, "ws", `n${i}${s}`);
  await run("getNotification", cwd, "ws", rt(`n0${S[0]}`));
  await run("unreadCountsBySession", cwd);
  for (const s of S) await run("getSessionPrefs", cwd, `s${s}`);
  await run("getSessionPrefs", cwd, rt(`s${S[0]}`));
});

await scenario("queue", "/q/w", ["queued_messages"], async (run, toReads) => {
  const cwd = "/q/w";
  for (const [i, s] of S.entries()) {
    await run("enqueueTail", cwd, { sessionId: `s${s}`, uuid: `u${i}${s}`, text: `t${s}` });
  }
  await run("enqueueTail", cwd, { sessionId: `s${S[0]}`, uuid: `v${S[0]}`, text: "second" });
  await run("updateByUuid", cwd, `s${S[1]}`, `u1${S[1]}`, { text: `new${S[1]}` });
  await run("updateByUuid", cwd, rt(`s${S[1]}`), `u1${S[1]}`, { text: "x" });
  // Found by its key, then deleted by the uuid as it read back: a lone
  // surrogate's row stays.
  await run("popByUuid", cwd, `s${S[2]}`, `u2${S[2]}`);
  await run("popByUuid", cwd, `s${S[6]}`, `u6${S[6]}`);
  await run("removeByUuid", cwd, `s${S[3]}`, `u3${S[3]}`);
  await run("removeByUuid", cwd, `s${S[4]}`, rt(`u4${S[4]}`));
  await run("moveByUuid", cwd, `s${S[0]}`, `v${S[0]}`, "up");
  await run("popHead", cwd, `s${S[0]}`);
  await run("popHead", cwd, `s${S[5]}`);
  // Images with the text, then images alone.
  const img = [{ data: "QQ==", mediaType: "image/png" }];
  await run("updateByUuid", cwd, `s${S[1]}`, `u1${S[1]}`, { text: `img${S[1]}`, images: img });
  await run("updateByUuid", cwd, `s${S[1]}`, `u1${S[1]}`, { images: [...img, ...img] });
  await run("enqueueTail", cwd, { sessionId: `c${S[2]}`, uuid: "c1", text: "c" });
  await run("enqueueTail", cwd, { sessionId: `c${S[2]}`, uuid: "c2", text: "c" });
  await run("clearAll", cwd, `c${S[2]}`);
  await toReads();
  for (const s of S) await run("listQueue", cwd, `s${s}`);
  await run("listQueue", cwd, rt(`s${S[0]}`));
});

await scenario("assets", "/a/w", ["assets", "asset_uses"], async (run, toReads) => {
  const cwd = "/a/w";
  const hashes = [];
  for (const [i, s] of S.entries()) {
    const res = await run("recordSendUses", {
      cwd,
      sessionId: `s${s}`,
      messageUuid: `m${s}`,
      occurredMs: 5000 + i,
      images: [{ data: Buffer.from(`img-${i}`).toString("base64"), mediaType: i % 2 ? "image/png" : `x/${s}` }],
    });
    hashes.push(res[0].hash);
  }
  // Image 0 again, from another session: one asset, a second use.
  await run("recordSendUses", {
    cwd,
    sessionId: `s${S[1]}`,
    messageUuid: `m2${S[1]}`,
    occurredMs: 6000,
    images: [{ data: Buffer.from("img-0").toString("base64"), mediaType: `x/${S[2]}` }],
  });
  // Rows another writer left under lone-surrogate hashes.
  const lone = "CAST(X'68EDA080' AS TEXT)";
  await run(
    "exec",
    cwd,
    "INSERT INTO assets(hash, media_type, size_bytes, first_seen_ms, last_seen_ms) VALUES " +
      `(${lone}, 'image/png', 1, 1, 1), (CAST(X'6832EDB080' AS TEXT), 'image/png', 2, 2, 2);` +
      `INSERT INTO asset_uses(asset_hash, session_id, message_uuid, ordinal, occurred_ms) VALUES (${lone}, 'sx', 'mx', 0, 3);`,
  );
  await run("deleteAssetRow", cwd, `h2${ch(0xdc00)}`);
  await run("deleteAssetRow", cwd, rt(`h${ch(0xd800)}`));
  await toReads();
  for (const s of S) await run("listAssets", { scope: "project", cwd, q: s });
  await run("listAssets", { scope: "project", cwd, q: ch(0xfffd) });
  await run("listAssets", { scope: "project", cwd, q: rt(S[0]) });
  for (const h of hashes) await run("listUses", cwd, h);
  await run("listUses", cwd, `h${ch(0xd800)}`);
  await run("listUses", cwd, rt(`h${ch(0xd800)}`));
});

await scenario("open tabs", "/t/w", ["ui_state"], async (run, toReads) => {
  const cwd = "/t/w";
  await run("setOpenTabs", cwd, S.map((s) => `a${s}`));
  await run("setPinnedTabs", cwd, [S[0], S[4], S[0]]);
  await run("setActiveTab", cwd, `x${S[0]}`);
  await toReads();
  await run("getOpenTabs", cwd);
  await run("getPinnedTabs", cwd);
  await run("getActiveTab", cwd);
});

const OTHER_TABLES = [
  "session_usage",
  "session_tasks",
  "loop_ticks",
  "feedback",
  "mcp_needs_auth_notified",
  "mcp_disconnected_notified",
  "db_agents",
  "sessions",
];
await scenario("other stores", "/o/w", OTHER_TABLES, async (run, toReads) => {
  const cwd = "/o/w";
  for (const [i, s] of S.entries()) {
    await run("saveSessionUsage", cwd, `u${s}`, {
      totalCostUsd: 0.25,
      numTurns: 1,
      durationMs: 10,
      durationApiMs: 5,
      inputTokens: 3,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    await run("saveSessionTask", cwd, `s${s}`, {
      taskId: `t${s}`,
      toolUseId: `tu${s}`,
      subagentType: `st${s}`,
      description: `d${s}`,
      taskType: `tt${s}`,
      workflowName: `w${s}`,
      status: `run${s}`,
      summary: `sum${s}`,
      error: `e${s}`,
      innerMessages: [],
      outputFile: `o${s}`,
    });
    await run("recordLoopTick", cwd, {
      sessionId: `s${s}`,
      sessionTitle: `st${s}`,
      toolUseId: `tu${s}`,
      prompt: `p${s}`,
      firedAt: 100 + i,
      noop: false,
    });
    await run("attachLoopTickTokens", cwd, `tu${s}`, 10 + i);
    await run("insertFeedback", cwd, {
      id: `f${i}${s}`,
      sessionId: `s${s}`,
      rating: "up",
      comment: `c${s}`,
      surface: `sf${s}`,
      forwarded: false,
      attachTranscript: true,
      createdAt: 50 + i,
    });
    await run("mergeSessionState", cwd, `id${s}`, { accountProfileId: `acc${s}` });
  }
  // The last prompt of a plain session id, read back.
  await run("recordLoopTick", cwd, {
    sessionId: "plain-tick",
    sessionTitle: "pt",
    toolUseId: "tu-plain",
    prompt: `p${S[0]}`,
    firedAt: 90,
    noop: false,
  });
  // A name that reads back changed is never "already announced": TS
  // announces it again on every sync.
  await run("syncNeedsAuthNotifications", cwd, S.map((s) => `m${s}`));
  await run("syncNeedsAuthNotifications", cwd, S.map((s) => `m${s}`));
  await run("syncDisconnectedNotifications", cwd, [`d${S[0]}`, `d${S[4]}`, "dx"]);
  await run("syncDisconnectedNotifications", cwd, [`d${S[4]}`]);
  await run("upsertDbAgent", cwd, "agent-1", { description: `d${S[0]}`, prompt: `p${S[1]}` });
  await run("upsertDbAgent", cwd, `bad${S[0]}`, { description: "d", prompt: "p" });
  await toReads();
  for (const s of S) await run("getSessionUsage", cwd, `u${s}`);
  await run("getSessionUsage", cwd, rt(`u${S[0]}`));
  for (const s of S) await run("listSessionTasks", cwd, `s${s}`);
  await run("listLoopBreakdown", cwd);
  await run("listFeedback", cwd, 100);
  await run("listDbAgents", cwd);
  await run(
    "getSessionAccountsByCwd",
    [...S, rt(S[0])].map((s) => ({ cwd, id: `id${s}` })),
  );
});

const FOREIGN_TABLES = ["sessions", "queued_messages", "session_usage", "prompt_drafts", "session_tasks"];
await scenario("foreign", "/f/w", FOREIGN_TABLES, async (run, toReads) => {
  const cwd = "/f/w";
  const text = (hex) => `CAST(X'${hex}' AS TEXT)`;
  await run(
    "exec",
    cwd,
    "INSERT INTO sessions(id, cwd, title, model, created_at, updated_at, last_seen_at, goal, goal_summary, state) VALUES " +
      `('f1', '/f/w', ${text("54ED")}, ${text("6DC0AF")}, 1, 2, 3, ${text("67EDA080")}, ${text("F09F98")}, ` +
      `${text("7B226B223A2261ED227D")}), ` +
      `(${text("6632EDB080")}, '/f/w', ${text("74FF")}, NULL, 4, 5, 6, NULL, NULL, '{}');` +
      "INSERT INTO session_usage(session_id, model_usage_json, updated_at) VALUES " +
      `('uf', ${text("7B2261223A2278ED227D")}, 9);` +
      "INSERT INTO queued_messages(uuid, session_id, position, text, created_at_ms, images_json) VALUES " +
      `(${text("75EDB080")}, 'sf', 0, ${text("74F0")}, 7, NULL), ('u2', 'sf', 1, ${text("E28228")}, 8, ${text("5BED")});` +
      "INSERT INTO prompt_drafts(session_id, text, images, updated_at) VALUES " +
      `('pf', ${text("64ED")}, ${text("5BED")}, 10);` +
      "INSERT INTO session_tasks(session_id, task_id, status, inner_messages, resource_links, updated_at) VALUES " +
      `('tf', 'tk', ${text("72FF")}, ${text("5BED")}, ${text("5BED")}, 11);`,
  );
  await toReads();
  await run("getSessionTitle", cwd, "f1");
  await run("getSessionGoal", cwd, "f1");
  await run("getSessionState", cwd, "f1");
  await run("getSessionUsage", cwd, "uf");
  await run("listIndexedSessions", cwd);
  await run("getSessionTitlesByCwd", [
    { cwd, id: "f1" },
    { cwd, id: `f2${ch(0xdc00)}` },
    { cwd, id: rt(`f2${ch(0xdc00)}`) },
  ]);
  await run("listQueue", cwd, "sf");
  await run("getPromptDraft", cwd, "pf");
  await run("listSessionTasks", cwd, "tf");
});

await scenario("asset cursor", "/b/w", [], async (run, toReads) => {
  const cwd = "/b/w";
  // A cursor another writer left that isn't UTF-8: what reads back doesn't
  // parse, so the transcript is scanned again and the cursor rewritten.
  await run(
    "exec",
    cwd,
    "INSERT INTO schema_meta(key, value) VALUES ('last_jsonl_scan_sx', CAST(X'7BFF7D' AS TEXT))",
  );
  await run("writeTranscript", "-b-w", "sx.jsonl", "", 1_600_000_000);
  await run("backfillProject", cwd);
  await run(
    "query",
    cwd,
    "SELECT key, typeof(value), hex(value) FROM schema_meta WHERE key LIKE 'last_jsonl_scan_%' ORDER BY key",
  );
  await toReads();
});

// S29a: `POST /input` hands a posted `uuid` / `text` of any JSON type to the
// stores as it is. better-sqlite3 binds a number as a REAL (a TEXT column
// holds 7 as "7.0", and a lookup with 7 finds that row), spreads an array
// into the parameters that follow, binds a plain object as named parameters
// (there are none, so the values fall short) and throws on a boolean, or on
// an array or object inside an array. A falsy uuid records no provenance
// (`recordSendUses` doesn't check). A NULL uuid (`[null]`) matches no
// lookup, so `popHead` hands its row back without deleting it.
const ODD = [7, 1.5, 1e21, 0, "", true, false, null, {}, { a: 1 }, [], ["a"], ["a", "b"], [["a"]], [{}], [1], [null], [true]];
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
await scenario(
  "odd types",
  "/o/w",
  ["queued_messages", "goal_messages", "suggested_messages", "assets", "asset_uses"],
  async (run, toReads) => {
    const cwd = "/o/w";
    for (const [i, v] of ODD.entries()) {
      await run("enqueueTail", cwd, { sessionId: "su", uuid: v, text: `t${i}` });
      await run("enqueueTail", cwd, { sessionId: "st", uuid: `t${i}`, text: v });
      await run("recordGoalMessage", cwd, { sessionId: "sg", messageUuid: v, text: `g${i}` });
      await run("recordSuggestedMessage", cwd, { sessionId: "ss", messageUuid: `s${i}`, text: v });
      await run("recordSendUses", {
        cwd,
        sessionId: "sa",
        messageUuid: v,
        occurredMs: 7000 + i,
        images: [{ data: GIF, mediaType: "image/gif" }],
      });
    }
    // Two objects; and a value past the last parameter is checked for its
    // type first.
    await run("enqueueTail", cwd, { sessionId: "su", uuid: {}, text: { a: 1 } });
    for (const v of ["7", 7, "7.0", "1.5", 1e21, ["a"], [1], 0, null, true, {}, [], ["a", "b"], ["a", true], [["a"]]]) {
      await run("popByUuid", cwd, "su", v);
    }
    // The "" row first; then the NULL rows, whose delete (`uuid = NULL`)
    // spares another session's "" row.
    await run("popHead", cwd, "su");
    await run("enqueueTail", cwd, { sessionId: "sx", uuid: "", text: "kept" });
    for (let i = 0; i < 3; i++) await run("popHead", cwd, "su");
    await toReads();
    for (const sid of ["su", "st", "sx"]) await run("listQueue", cwd, sid);
    await run("listGoalMessageUuids", cwd, "sg");
    await run("listSuggestedMessageUuids", cwd, "ss");
  },
);

writeFileSync(
  join(ROOT_DIR, "out.json"),
  JSON.stringify({
    node: process.version,
    betterSqlite3: require("better-sqlite3/package.json").version,
    t0: T0,
    legacyTitles: LEGACY_TITLES,
    binds,
    decode,
    scenarios,
  }),
);
