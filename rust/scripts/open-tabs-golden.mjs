#!/usr/bin/env node
// Golden fixture for the persistent tab strip (D21): `GET/PUT
// /api/sessions/open-tabs`, `lib/server/open-tabs-db.ts`, and what the route
// imports: `resolveActiveCwd` (active-customization.ts + active-workspace.ts,
// read through Next's real `cookies()`) and `getSessionTitlesByCwd`
// (sessions-db.ts, with its legacy `session-titles.json` shadow read).
// Recorded from the real TS sources:
//
//   node rust/scripts/open-tabs-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself twice under `--experimental-transform-types` (two temp
// roots; both recordings must agree byte for byte) with the repo as its cwd
// (db.ts reads its migrations from there at load), HOME and
// CLAUDE_CONFIG_DIR in the temp root and a resolve hook for the `@/` imports.
// Once everything is loaded it moves to `<root>/project`, which becomes
// `process.cwd()`, the route's fallback cwd. Each request runs inside Next's
// own request scope (`createRequestStoreForAPI` under `workAsyncStorage` /
// `workUnitAsyncStorage`), so `cookies()` parses the request's Cookie header
// exactly as Next does. Paths are written with `$HOME` (the temp home) and
// `$PROC` (the fallback cwd) in place of the temp root. Parts:
//
// * `steps`: the route handlers in order, against one world, interleaved with
//   world edits: `file` (a file under $HOME: `text`, `hex` bytes, a `dir`, or
//   `rm`), `sql` (hand-written SQL on a cwd's DB: through `openDb`, so
//   migrated, or `fresh`: a bare file, `journal: "delete"` leaves it out of
//   WAL), `dbfile` (garbage at a cwd's DB path), `rows` (the `ui_state` rows
//   of a cwd's DB through a separate read-only handle: each key and value as
//   [typeof, value], integers as text and blobs as hex; or `nodb` / an
//   `error`), `exists` (the cwd's project dir and DB file), `concurrent`
//   (requests started together; their answers, in order) and `rowsOneOf`
//   (after concurrent writes, which land in any order in TS too: each listed
//   key holds one of its candidate texts, checked here before it is written
//   down). `got` is the status, content type and body text, or `threw`
//   (Next's empty 500).
// * `db`: the module's functions called directly over seeded rows: `lit`
//   writes one SQL literal into all four keys and reads all four back. This
//   and the parts below start from an empty $HOME (every handle closed) and
//   run in this order on one world.
// * `clamp`: `setTabLabelMaxWidth(cwd, n)` and the text it stored, for odd
//   numbers (`n` as `String(n)`, `-0` kept).
// * `titles`: `getSessionTitlesByCwd(pairs)` as `[key, title]` entries in Map
//   order, or `threw`.
// * `active`: `resolveActiveCwd()` under a Cookie header: the cwd (or
//   `{nonString}`: `JSON.stringify` of it, `typeof` when it has none),
//   `customizationId`, and the workspace object it picked.
// * `cookies`: Next's `RequestCookies` on raw Cookie header values: the parsed
//   entries in order.
//
// Written to rust/crates/claudius-core/tests/fixtures/open_tabs_golden.json;
// replayed by crates/claudius-core/tests/open_tabs_golden.rs (`db`, `clamp`,
// `titles`, `active`) and crates/claudius-server/tests/open_tabs.rs (`steps`
// on the real binary, and `cookies`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/open_tabs_golden.json");

if (!process.env.OT_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "open-tabs-golden-")));
    try {
      for (const d of ["home", "config", "project"]) mkdirSync(join(root, d));
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
            OT_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.stdout.write(r.stdout);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    if (process.env.OT_GOLDEN_DUMP) runs.forEach((r, i) => writeFileSync(join(process.env.OT_GOLDEN_DUMP, `run${i}.json`), r));
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const requests = fixture.steps.filter((s) => s.op === "get" || s.op === "put").length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.steps.length} steps (${requests} requests), ` +
      `${fixture.db.length} db, ${fixture.clamp.length} clamp, ${fixture.titles.length} titles, ` +
      `${fixture.active.length} active, ${fixture.cookies.length} cookies (stable)`,
  );
  process.exit(0);
}

const ROOT_DIR = process.env.OT_GOLDEN_CHILD;
const HOME = process.env.HOME;
const PROC = join(ROOT_DIR, "project");

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

// What Next's node runtime installs before any request scope exists.
globalThis.AsyncLocalStorage = (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(join(repo, "package.json"));
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { createRequestStoreForAPI } = require("next/dist/server/async-storage/request-store.js");
const { RequestCookies } = require("next/dist/compiled/@edge-runtime/cookies");

const { default: Database } = await import("better-sqlite3");
const { openDb, closeAll } = await import(join(repo, "lib/server/db.ts"));
const tabsDb = await import(join(repo, "lib/server/open-tabs-db.ts"));
const { getSessionTitlesByCwd } = await import(join(repo, "lib/server/sessions-db.ts"));
const { resolveActiveCwd } = await import(join(repo, "lib/server/active-customization.ts"));
const route = await import(join(repo, "app/api/sessions/open-tabs/route.ts"));
process.chdir(PROC);
if (process.cwd() !== PROC) throw new Error(`cwd ${process.cwd()} is not ${PROC}`);

// ------------------------------- helpers -------------------------------

const ch = (...codes) => String.fromCharCode(...codes);
const cp = (...codes) => String.fromCodePoint(...codes);
const EMOJI = cp(0x1f600);
const NFC_E = ch(0xe9);
const NFD_E = `e${ch(0x301)}`;
const CJK = ch(0x4f1a, 0x8a71);
const LONE = ch(0xd800);
/** The raw escape text `\uXXXX` (kept out of this file's source as is). */
const esc = (hex) => `${"\\"}u${hex}`;

/** `$PROC` / `$HOME` in place of the temp paths, everywhere in a string. */
const sym = (s) => s.split(PROC).join("$PROC").split(HOME).join("$HOME");
const unsym = (s) => s.split("$PROC").join(PROC).split("$HOME").join(HOME);
const encodeProjectDir = (abs) => abs.replace(/[^A-Za-z0-9]/g, "-");
const dbPathOf = (cwd) => join(HOME, ".claude", "projects", encodeProjectDir(unsym(cwd)), ".claudius.db");
const msg = (e) => (e instanceof Error ? e.message : String(e));
/** `JSON.stringify`'s view of a result (`undefined` is `{undefined: true}`). */
const view = (v) => (v === undefined ? { undefined: true } : JSON.parse(JSON.stringify(v)));
const numRepr = (n) => (Object.is(n, -0) ? "-0" : String(n));

const ROWS_SQL = `SELECT
    typeof(key), CASE typeof(key) WHEN 'integer' THEN CAST(key AS TEXT) WHEN 'blob' THEN hex(key) ELSE key END,
    typeof(value), CASE typeof(value) WHEN 'integer' THEN CAST(value AS TEXT) WHEN 'blob' THEN hex(value) ELSE value END
  FROM ui_state ORDER BY rowid`;
function rows(cwd) {
  const path = dbPathOf(cwd);
  if (!existsSync(path)) return { nodb: true };
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    return db.prepare(ROWS_SQL).raw().all();
  } catch (e) {
    return { error: msg(e) };
  } finally {
    db?.close();
  }
}
function exists(cwd) {
  const path = dbPathOf(cwd);
  return { dir: existsSync(dirname(path)), db: existsSync(path) };
}
async function runSql(s) {
  if (s.fresh) {
    const path = dbPathOf(s.cwd);
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    if (s.journal !== "delete") db.pragma("journal_mode = WAL");
    db.exec(s.sql);
    db.close();
  } else {
    (await openDb(unsym(s.cwd))).exec(s.sql);
  }
}
function writeWorldFile(s) {
  const path = join(HOME, s.path);
  rmSync(path, { recursive: true, force: true });
  if (s.rm) return;
  mkdirSync(dirname(path), { recursive: true });
  if (s.dir) mkdirSync(path);
  else if (s.hex !== undefined) writeFileSync(path, Buffer.from(s.hex, "hex"));
  else writeFileSync(path, s.text);
}
async function world(s) {
  if (s.op === "file") writeWorldFile(s);
  else if (s.op === "sql") await runSql(s);
  else if (s.op === "dbfile") {
    const path = dbPathOf(s.cwd);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    if (s.dir) mkdirSync(path);
    else writeFileSync(path, s.text);
  } else return false;
  return true;
}

/** `fn()` inside Next's request scope for `req` (what an App Route handler runs in). */
function inRequest(req, fn) {
  const store = createRequestStoreForAPI(req, new URL(req.url), undefined, undefined, undefined);
  const work = { route: "/api/sessions/open-tabs", forceStatic: false, dynamicShouldError: false };
  return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(store, fn));
}
const URL_ = "http://localhost/api/sessions/open-tabs";
function request(s) {
  const headers = {};
  if (s.cookie !== undefined) headers.cookie = s.cookie;
  if (s.op === "get") return new Request(URL_, { headers });
  const body = s.hex !== undefined ? Buffer.from(s.hex, "hex") : (s.body ?? undefined);
  return new Request(URL_, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body });
}
async function call(s) {
  const req = request(s);
  try {
    const res = await inRequest(req, () => (s.op === "get" ? route.GET() : route.PUT(req)));
    return { status: res.status, type: res.headers.get("content-type"), body: sym(await res.text()) };
  } catch (e) {
    return { threw: msg(e) };
  }
}

// ------------------------------- world -------------------------------

const WS_A = "/claudius-golden/ws-a";
const WS_B = "/claudius-golden/ws-b";
const WS_C = "/claudius-golden/ws-c";
const WS_U = `/claudius-golden/ws ${NFC_E} ${EMOJI}`;
const WS_L = `/claudius-golden/lone-${LONE}`;
const CUST_ROOT = "$HOME/.claude/.claudius/customizations";
const WSJSON = ".claude/.claudius/workspaces.json";
const CUSTJSON = ".claude/.claudius/customizations/index.json";
const LEGACY = ".claude/.claudius/session-titles.json";

const ws = (id, rootPath, extra = {}) => ({
  id,
  name: `ws ${id}`,
  ...(rootPath === undefined ? {} : { rootPath }),
  icon: { kind: "letter", letter: "W", color: "#5588dd" },
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});
const wsFile = (workspaces, extra = {}) => ({
  op: "file",
  path: WSJSON,
  text: JSON.stringify({ version: 1, ...extra, workspaces }, null, 2),
});
const custFile = (customizations, extra = {}) => ({
  op: "file",
  path: CUSTJSON,
  text: JSON.stringify({ version: 1, customizations, publishes: [], ...extra }),
});
const legacyFile = (titles) => ({ op: "file", path: LEGACY, text: JSON.stringify({ version: 1, titles }) });
const FILE = (path, content) => ({ op: "file", path, ...content });
const SQL = (cwd, sql, extra = {}) => ({ op: "sql", cwd, sql, ...extra });
const ROWS = (cwd) => ({ op: "rows", cwd });
const EXISTS = (cwd) => ({ op: "exists", cwd });
const G = (cookie) => ({ op: "get", ...(cookie === undefined ? {} : { cookie }) });
const P = (body, cookie) => ({ op: "put", body, ...(cookie === undefined ? {} : { cookie }) });
const PX = (hex, cookie) => ({ op: "put", hex, ...(cookie === undefined ? {} : { cookie }) });
const J = (v, cookie) => P(JSON.stringify(v), cookie);
const WSC = (id) => `claudius.workspace=${encodeURIComponent(id)}`;
const CUC = (id) => `claudius.customization=${encodeURIComponent(id)}`;
const sessionRow = (id, cwd, title) =>
  `INSERT INTO sessions(id, cwd, title, created_at, updated_at, last_seen_at) VALUES (${id}, '${cwd}', ${title}, 1, 2, 3);`;
const q = (s) => `'${s.replaceAll("'", "''")}'`;
const utf8hex = (s) => Buffer.from(s, "utf8").toString("hex");
const uniq = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);

// ------------------------------- route steps -------------------------------

const WIDTHS = [
  200, 0, -5, 59.4, 59.5, 59.49999999999999, 60, 61, 180.5, 333.333, 599, 599.5, 600, 600.4, 600.5, 1e21, 5e-324, 1e308,
  1.7976931348623157e308, -1e308, 0.49999999999999994,
];
const STEPS = [
  // No workspace: the fallback cwd, no DB yet. A GET only makes the project dir.
  G(),
  EXISTS("$PROC"),
  ROWS("$PROC"),
  // Bodies: malformed is a 400; `null` throws on `body.tabs`; any other value patches nothing.
  P(null),
  P(""),
  P("{"),
  P("nul"),
  P("{} x"),
  P('{"tabs":undefined}'),
  P('{"tabs":["a"],}'),
  P("null"),
  P("[]"),
  P('"tabs"'),
  P("7"),
  P("true"),
  P("false"),
  P("1e400"),
  P("{}"),
  P('{"tabs":["a"]} trailing'),
  EXISTS("$PROC"),
  // tabs: only an array passes; non-strings are dropped, then dedupe in order.
  J({ tabs: "a" }),
  J({ tabs: null }),
  J({ tabs: {} }),
  J({ tabs: { length: 1, 0: "a" } }),
  J({ tabs: 5 }),
  J({ tabs: true }),
  P('{"tabs":1e400}'),
  EXISTS("$PROC"),
  J({ tabs: [] }),
  EXISTS("$PROC"),
  ROWS("$PROC"),
  G(),
  J({ tabs: ["a", 1, "b", "a", null, "", {}, ["c"], "B", true, 2.5, "b"] }),
  ROWS("$PROC"),
  G(),
  // activeId: a string or null.
  J({ activeId: 5 }),
  J({ activeId: true }),
  J({ activeId: false }),
  J({ activeId: [] }),
  J({ activeId: {} }),
  J({ activeId: 0 }),
  P('{"activeId":1e400}'),
  P('{"activeId":-1e400}'),
  ROWS("$PROC"),
  J({ activeId: "a" }),
  ROWS("$PROC"),
  G(),
  J({ activeId: "" }),
  ROWS("$PROC"),
  G(),
  J({ activeId: null }),
  ROWS("$PROC"),
  G(),
  J({ activeId: null }),
  J({ activeId: "zzz-not-a-tab" }),
  G(),
  // pinned: like tabs, its own row.
  J({ pinned: "x" }),
  J({ pinned: null }),
  J({ pinned: { 0: "a" } }),
  J({ pinned: ["b", "b", 7, "a", "zzz"] }),
  ROWS("$PROC"),
  G(),
  J({ pinned: [] }),
  G(),
  // labelMaxWidth: a finite number, clamped to [60, 600] after Math.round.
  J({ labelMaxWidth: "200" }),
  J({ labelMaxWidth: null }),
  J({ labelMaxWidth: true }),
  J({ labelMaxWidth: [200] }),
  J({ labelMaxWidth: {} }),
  P('{"labelMaxWidth":1e400}'),
  P('{"labelMaxWidth":-1e400}'),
  ROWS("$PROC"),
  ...WIDTHS.flatMap((w) => [J({ labelMaxWidth: w }), G()]),
  P('{"labelMaxWidth":-0}'),
  G(),
  P('{"labelMaxWidth":2.5e2}'),
  ROWS("$PROC"),
  // Fields are checked and written one at a time, in this order: tabs, activeId, pinned, labelMaxWidth.
  J({ tabs: ["x"], activeId: 5 }),
  ROWS("$PROC"),
  J({ tabs: ["y"], activeId: "y", pinned: 7 }),
  ROWS("$PROC"),
  J({ labelMaxWidth: "bad", tabs: ["z"], pinned: ["z"] }),
  ROWS("$PROC"),
  J({ pinned: ["p"], labelMaxWidth: 300, activeId: null, tabs: 1 }),
  ROWS("$PROC"),
  J({ tabs: ["q", "r"], activeId: "r", pinned: ["r"], labelMaxWidth: 250.6 }),
  ROWS("$PROC"),
  G(),
  // Body forms.
  P('{"tabs":["d1"],"tabs":["d2"]}'),
  G(),
  P('{"__proto__":{"tabs":["proto"]},"pinned":["pp"]}'),
  G(),
  P(`${ch(0xfeff)}{"tabs":["bom"]}`),
  G(),
  PX(`efbbbfefbbbf${utf8hex('{"tabs":["bom2"]}')}`),
  G(),
  PX(`efbbbfefbbbfefbbbf${utf8hex('{"tabs":["bom3"]}')}`),
  P(' \n {"tabs" : [ "ws" ] } \n'),
  G(),
  PX(`${utf8hex('{"tabs":["a')}ff${utf8hex('b", "c')}c3${utf8hex('"]}')}`),
  ROWS("$PROC"),
  G(),
  P(`{"tabs":["${esc("00e9")}", "${esc("d83d")}${esc("de00")}", "${esc("0041")}"]}`),
  ROWS("$PROC"),
  G(),
  // Where the Rust port is known to differ (its replay lists it): V8 parses nesting past serde_json's
  // 127 levels.
  P(`{"tabs":["deep",${"[".repeat(150)}${"]".repeat(150)}]}`),
  ROWS("$PROC"),
  // Lone surrogates are kept, and JSON.stringify writes them back as escapes.
  P(`{"tabs":["${esc("d800")}x"],"activeId":"${esc("dc00")}"}`),
  ROWS("$PROC"),
  G(),
  J({ activeId: "r" }),
  // 200 at most, counted after dropping non-strings and duplicates.
  J({ tabs: uniq(250, "cap-") }),
  ROWS("$PROC"),
  G(),
  J({ tabs: [...Array(150).fill("dup"), ...uniq(260, "u-")] }),
  ROWS("$PROC"),
  J({ pinned: uniq(205, "p-").flatMap((id, i) => (i % 3 ? [id] : [i, id, null])) }),
  ROWS("$PROC"),
  G(),
  // Unicode and odd characters.
  J({
    tabs: [EMOJI, NFC_E, NFD_E, CJK, ch(0x2028), ch(0), ch(0x1f), 'q"uote', "back\\slash", "/sl/ash", "<script>", "x".repeat(5000)],
    activeId: `${EMOJI}${ch(0)}`,
    pinned: [NFD_E, NFC_E],
  }),
  ROWS("$PROC"),
  G(),

  // Titles: the cwd's `sessions` rows (the route trims, and drops blank ones).
  SQL(
    "$PROC",
    [
      sessionRow("'t1'", "x", "'  Title One  '"),
      sessionRow("'t2'", "x", "'   '"),
      sessionRow("'t3'", "x", "NULL"),
      sessionRow("'t4'", "/elsewhere", "'Another cwd'"),
      sessionRow("'10'", "x", "'ten'"),
      sessionRow("'2'", "x", "'two'"),
      sessionRow("'01'", "x", "'zero one'"),
      sessionRow("'4294967295'", "x", "'max'"),
      sessionRow("'4294967294'", "x", "'max-1'"),
      sessionRow("'__proto__'", "x", "'proto title'"),
      sessionRow("'constructor'", "x", "'ctor title'"),
      sessionRow("'nbsp'", "x", q(`${ch(0xa0)}X${ch(0xfeff)}`)),
      sessionRow("'nel'", "x", q(`${ch(0x85)}N${ch(0x85)}`)),
      sessionRow(q(`uni-${EMOJI}`), "x", q(`${EMOJI} smile ${CJK}`)),
      sessionRow("'lf'", "x", q("\n\tline\r\n")),
    ].join("\n"),
  ),
  J({
    tabs: ["t1", "t2", "t3", "t4", "10", "2", "01", "4294967295", "4294967294", "__proto__", "constructor", "nbsp", "nel", "missing", `uni-${EMOJI}`, "", "lf"],
  }),
  G(),
  // A strip another writer stored with duplicates and non-strings: read as is.
  SQL("$PROC", `UPDATE ui_state SET value = '["t1",5,"t1","2",null,"x"]' WHERE key = 'open_tabs';`),
  G(),
  // The legacy file fills ids without a usable row title (row titles win).
  legacyFile({ missing: " Legacy ", t3: "legacy t3", t1: "legacy t1", t2: "legacy t2", nope: "not a tab" }),
  J({ tabs: ["t1", "t2", "t3", "missing", "ghost"] }),
  G(),
  legacyFile({ missing: false, t3: 0, t2: null, ghost: "" }),
  G(),
  legacyFile({ missing: "   " }),
  G(),
  // A truthy non-string legacy title throws inside the lookup: no titles at all.
  legacyFile({ missing: 5 }),
  G(),
  legacyFile({ ghost: { t: "x" } }),
  G(),
  legacyFile({ ghost: true }),
  G(),
  // ... but only for an id the lookup reaches.
  legacyFile({ t1: 5 }),
  G(),
  // An array of titles is indexed; `length` (and Array.prototype) is not a string.
  legacyFile(["zero", "one"]),
  J({ tabs: ["0", "1", "2", "t1"] }),
  G(),
  J({ tabs: ["0", "length"] }),
  G(),
  J({ tabs: ["1", "map"] }),
  G(),
  // Object.prototype names reach the prototype unless the file has its own key.
  legacyFile({ a: "A" }),
  J({ tabs: ["t1", "hasOwnProperty"] }),
  G(),
  legacyFile({ hasOwnProperty: " own wins " }),
  G(),
  legacyFile({}),
  G(),
  // Files that aren't a titles map.
  FILE(LEGACY, { text: "null" }),
  G(),
  FILE(LEGACY, { text: '{"titles":"str"}' }),
  G(),
  FILE(LEGACY, { text: '[{"titles":{"hasOwnProperty":"x"}}]' }),
  G(),
  FILE(LEGACY, { text: `${ch(0xfeff)}{"titles":{"hasOwnProperty":"bom"}}` }),
  G(),
  FILE(LEGACY, { text: '{"titles":{"hasOwnProperty":"x"}' }),
  G(),
  FILE(LEGACY, { hex: utf8hex('{"titles":{"hasOwnProperty":"a') + "ff" + utf8hex('b"}}') }),
  G(),
  FILE(LEGACY, { text: '{"titles":{"hasOwnProperty":"dup1","hasOwnProperty":"dup2"}}' }),
  G(),
  FILE(LEGACY, { dir: true }),
  G(),
  FILE(LEGACY, { rm: true }),
  // A BLOB title throws in the lookup (`title.trim` isn't a function): no titles.
  J({ tabs: ["t1", "10"] }),
  G(),
  SQL("$PROC", "UPDATE sessions SET title = X'4142' WHERE id = '10';"),
  G(),
  SQL("$PROC", "UPDATE sessions SET title = X'' WHERE id = '10';"),
  G(),
  SQL("$PROC", "UPDATE sessions SET title = 'ten' WHERE id = '10';"),
  G(),

  // Workspaces: the cookie's workspace, else the stored hint, else the first.
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: "wks_b" }),
  G(),
  EXISTS(WS_B),
  J({ tabs: ["b1"], activeId: "b1" }),
  ROWS(WS_B),
  G(),
  G(WSC("wks_a")),
  EXISTS(WS_A),
  J({ tabs: ["a1"], labelMaxWidth: 99 }, WSC("wks_a")),
  ROWS(WS_A),
  G(WSC("wks_a")),
  G(WSC("nope")),
  G("claudius.workspace="),
  G(WSC("wks_b")),
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)]),
  G(),
  G(WSC("wks_b")),
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: "" }),
  G(),
  G(WSC("wks_b")),
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: null }),
  G(),
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: "wks_gone" }),
  G(),
  wsFile([ws("wks_a", WS_A), ws(5, WS_B)], { activeId: 5 }),
  G(),
  G(WSC("5")),
  wsFile([null, ws("wks_a", WS_A)]),
  G(),
  G(WSC("wks_a")),
  wsFile([ws("wks_a", WS_A), null]),
  G(WSC("wks_a")),
  G(WSC("wks_x")),
  wsFile(["str", ws("wks_b", WS_B)]),
  G(),
  G(WSC("wks_b")),
  FILE(WSJSON, { text: JSON.stringify({ version: 2, activeId: "wks_b", workspaces: [ws("wks_b", WS_B)] }) }),
  G(),
  FILE(WSJSON, { text: JSON.stringify({ version: "1", activeId: "wks_b", workspaces: [ws("wks_b", WS_B)] }) }),
  G(),
  FILE(WSJSON, { text: `{"version":1.0,"activeId":"wks_b","workspaces":${JSON.stringify([ws("wks_b", WS_B)])}}` }),
  G(),
  FILE(WSJSON, { text: JSON.stringify({ version: 1, activeId: "wks_b", workspaces: { 0: ws("wks_b", WS_B) } }) }),
  G(),
  FILE(WSJSON, { text: "{" }),
  G(),
  FILE(WSJSON, { text: "" }),
  G(),
  FILE(WSJSON, { text: "null" }),
  G(),
  FILE(WSJSON, { text: "[]" }),
  G(),
  FILE(WSJSON, { dir: true }),
  G(),
  FILE(WSJSON, { text: `${ch(0xfeff)}${JSON.stringify({ version: 1, workspaces: [ws("wks_b", WS_B)] })}` }),
  G(),
  // A workspace with odd fields (only id and rootPath matter here).
  wsFile([{ id: "wks_b", rootPath: WS_B, name: 7, extra: [1] }]),
  G(),
  // A unicode root.
  wsFile([ws("wks_u", WS_U)]),
  J({ tabs: [`u-${EMOJI}`] }),
  ROWS(WS_U),
  G(),
  // rootPath "" is a cwd too (projects/.claudius.db); its title lookup fans out over every workspace.
  wsFile([ws("wks_e", ""), ws("wks_a", WS_A), ws("wks_n", 5), ws("wks_b", WS_B)], { activeId: "wks_e" }),
  G(),
  EXISTS(""),
  J({ tabs: ["fa", "fb", "fz", "t1", ""], activeId: "fa" }),
  ROWS(""),
  SQL(WS_A, [sessionRow("'fa'", "x", "' from A '"), sessionRow("'fz'", "x", "'   '")].join("\n")),
  SQL(WS_B, [sessionRow("'fa'", "x", "'from B'"), sessionRow("'fb'", "x", "'from B too'")].join("\n")),
  SQL("", sessionRow("'fz'", "x", "'own row is never read'")),
  G(),
  legacyFile({ fz: " legacy fz ", t1: "legacy t1" }),
  G(),
  FILE(LEGACY, { rm: true }),
  wsFile([ws("wks_e", ""), ws("wks_a", WS_A), null, ws("wks_b", WS_B)], { activeId: "wks_e" }),
  G(),
  wsFile([ws("wks_e", ""), { id: "wks_s" }, 7, ws("wks_b", WS_B)], { activeId: "wks_e" }),
  G(),
  // A rootPath that isn't a string: openDb throws, so a GET reads nothing and a write is a 500.
  wsFile([ws("wks_n", 5)]),
  G(),
  P("{}"),
  J({ tabs: 5 }),
  J({ tabs: ["n"] }),
  J({ activeId: null }),
  J({ labelMaxWidth: "x" }),
  wsFile([ws("wks_m", undefined)]),
  G(),
  J({ pinned: [] }),
  wsFile([ws("wks_o", { p: "/claudius-golden/ws-a" })]),
  G(),
  // Lone surrogates are code units of their own: the hint \ud800 picks its own workspace, not the \udc00
  // one before it, and a cookie's U+FFFD (a cookie can't carry a lone surrogate) matches neither. The
  // rootPath is the cwd as is: its DB, its rows, its title lookup (which binds the id's code units; a row
  // whose id is a lone surrogate's bytes reads back as three U+FFFD, so it titles nothing).
  wsFile([ws(ch(0xdc00), WS_A), ws(LONE, WS_L)], { activeId: LONE }),
  G(),
  J({ tabs: ["l1", LONE, `${LONE}x`, ch(0xdc00), "l2"], activeId: LONE, pinned: [ch(0xdc00)] }),
  ROWS(WS_L),
  ROWS(WS_A),
  SQL(WS_L, [sessionRow("'l1'", "x", "' lone root '"), sessionRow("CAST(X'eda080' AS TEXT)", "x", "'lone id'")].join("\n")),
  G(),
  G(WSC(ch(0xfffd))),
  wsFile([ws(ch(0xfffd), WS_A), ws(LONE, WS_L)], { activeId: LONE }),
  G(),
  G(WSC(ch(0xfffd))),
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: "wks_b" }),

  // Customizations: the customization cookie wins over the workspace one.
  custFile([{ id: "cust_1", name: "C" }]),
  G(CUC("cust_1")),
  J({ tabs: ["c1"] }, CUC("cust_1")),
  ROWS(`${CUST_ROOT}/cust_1/src`),
  EXISTS(`${CUST_ROOT}/cust_1/src`),
  G(CUC("cust_1")),
  G(`${CUC("cust_1")}; ${WSC("wks_a")}`),
  G(`${WSC("wks_a")}; ${CUC("cust_1")}`),
  G(`${CUC("cust_9")}; ${WSC("wks_a")}`),
  G(`claudius.customization=; ${WSC("wks_a")}`),
  custFile([{ id: "cust_1" }], { version: 2 }),
  G(CUC("cust_1")),
  FILE(CUSTJSON, { text: JSON.stringify({ version: 1, customizations: [{ id: "cust_1" }] }) }),
  G(CUC("cust_1")),
  FILE(CUSTJSON, { text: "{" }),
  G(CUC("cust_1")),
  FILE(CUSTJSON, { text: "null" }),
  G(CUC("cust_1")),
  FILE(CUSTJSON, { dir: true }),
  G(CUC("cust_1")),
  custFile([null, { id: "cust_1" }]),
  G(CUC("cust_1")),
  custFile([{ id: "cust_1" }, null]),
  G(CUC("cust_1")),
  custFile([7, { id: 1 }, { id: "cust_1" }]),
  G(CUC("cust_1")),
  G(CUC("1")),
  FILE(CUSTJSON, { text: `{"version":1.0,"customizations":[{"id":"cust_1"}],"publishes":[]}` }),
  G(CUC("cust_1")),
  // The id goes through path.join: normalized, `..` climbs, a leading `/` doesn't reset.
  custFile([{ id: "../../esc" }, { id: "/abs" }, { id: "." }, { id: "a/b" }, { id: `k ${EMOJI}` }, { id: "x//y/" }]),
  J({ tabs: ["e1"] }, CUC("../../esc")),
  ROWS("$HOME/.claude/esc/src"),
  J({ tabs: ["e2"] }, CUC("/abs")),
  ROWS(`${CUST_ROOT}/abs/src`),
  J({ tabs: ["e3"] }, CUC(".")),
  ROWS(`${CUST_ROOT}/src`),
  J({ tabs: ["e4"] }, "claudius.customization=a%2Fb"),
  ROWS(`${CUST_ROOT}/a/b/src`),
  J({ tabs: ["e5"] }, CUC(`k ${EMOJI}`)),
  ROWS(`${CUST_ROOT}/k ${EMOJI}/src`),
  J({ tabs: ["e6"] }, CUC("x//y/")),
  ROWS(`${CUST_ROOT}/x/y/src`),
  FILE(CUSTJSON, { rm: true }),

  // Next's cookie parsing: `; *` separators, last value wins, a bad %-escape is skipped.
  G(`${WSC("wks_b")}; ${WSC("wks_a")}`),
  G(`${WSC("wks_a")}; claudius.workspace=%E0%A4%A`),
  G("claudius.workspace=wks%5Fa"),
  G("claudius.workspace=%77ks_a"),
  G('claudius.workspace="wks_a"'),
  G("claudius.workspace =wks_a"),
  G("claudius.workspace= wks_a"),
  G("foo=1;claudius.workspace=wks_a"),
  G("foo=1;   claudius.workspace=wks_a;bar"),
  G("foo=1;\tclaudius.workspace=wks_a"),
  G("claudius.workspace=wks_a=x"),
  G("claudius.workspace"),
  wsFile([ws("true", WS_C), ws("wks_a", WS_A)], { activeId: "wks_a" }),
  G("claudius.workspace"),
  G("claudius.workspace;claudius.workspace=wks_a"),
  G("claudius.workspace=;"),
  G(";;claudius.workspace=wks_a;;"),
  G("Claudius.Workspace=wks_a"),
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: "wks_b" }),

  // A DB from a newer schema without the table: reads are empty, writes throw.
  wsFile([ws("wks_n", "/claudius-golden/newer")]),
  SQL("/claudius-golden/newer", "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999');", { fresh: true }),
  G(),
  J({ tabs: ["n1"] }),
  J({ activeId: null }),
  J({ pinned: ["n"] }),
  J({ labelMaxWidth: 100 }),
  P("{}"),
  ROWS("/claudius-golden/newer"),
  // A strip in a DB with `ui_state` but no `sessions`: the tabs read, the titles don't.
  wsFile([ws("wks_n", "/claudius-golden/no-sessions")]),
  SQL(
    "/claudius-golden/no-sessions",
    "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999'); CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ui_state VALUES ('open_tabs', '[\"s1\"]'), ('active_tab', '\"s1\"');",
    { fresh: true },
  ),
  G(),
  legacyFile({ s1: "legacy s1" }),
  G(),
  FILE(LEGACY, { rm: true }),
  // A file that isn't a database.
  wsFile([ws("wks_n", "/claudius-golden/garbage")]),
  { op: "dbfile", cwd: "/claudius-golden/garbage", text: "this is not a sqlite database, just text that is long enough" },
  G(),
  J({ tabs: ["g"] }),
  P("{}"),
  // A directory where the DB file goes.
  wsFile([ws("wks_n", "/claudius-golden/dir")]),
  { op: "dbfile", cwd: "/claudius-golden/dir", dir: true },
  G(),
  J({ activeId: "d" }),
  // A DB outside WAL mode: the read-only open can't switch it, so reads are empty until a write does.
  wsFile([ws("wks_n", "/claudius-golden/rollback")]),
  SQL(
    "/claudius-golden/rollback",
    "CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ui_state VALUES ('open_tabs', '[\"r1\"]'), ('tab_label_max_width', '321');",
    { fresh: true, journal: "delete" },
  ),
  G(),
  J({ activeId: "r1" }),
  G(),
  ROWS("/claudius-golden/rollback"),
  // A foreign table: no PRIMARY KEY, so the upsert's ON CONFLICT fails; the first row reads.
  wsFile([ws("wks_n", "/claudius-golden/nopk")]),
  SQL(
    "/claudius-golden/nopk",
    "CREATE TABLE ui_state (key TEXT, value TEXT); INSERT INTO ui_state VALUES ('open_tabs', '[\"first\"]'), ('open_tabs', '[\"second\"]'), ('active_tab', '\"k\"');",
    { fresh: true },
  ),
  G(),
  J({ tabs: ["w"] }),
  J({ activeId: null }),
  G(),
  ROWS("/claudius-golden/nopk"),

  // Concurrent requests: no lock in TS; each field's row is one PUT's value.
  wsFile([ws("wks_c", WS_C)]),
  {
    op: "concurrent",
    steps: Array.from({ length: 8 }, (_, i) => J({ tabs: [`c${i}`, "c"], activeId: `c${i}`, labelMaxWidth: 100 + i })),
  },
  {
    op: "rowsOneOf",
    cwd: WS_C,
    keys: {
      open_tabs: Array.from({ length: 8 }, (_, i) => JSON.stringify([`c${i}`, "c"])),
      active_tab: Array.from({ length: 8 }, (_, i) => JSON.stringify(`c${i}`)),
      tab_label_max_width: Array.from({ length: 8 }, (_, i) => String(100 + i)),
    },
  },
  wsFile([ws("wks_c", "/claudius-golden/conc-read")]),
  SQL(
    "/claudius-golden/conc-read",
    "INSERT INTO ui_state VALUES ('open_tabs', '[\"r1\",\"r2\"]'), ('pinned_tabs', '[\"r2\"]'), ('active_tab', '\"r2\"'), ('tab_label_max_width', '222');",
  ),
  { op: "concurrent", steps: Array.from({ length: 6 }, () => G()) },
  wsFile([ws("wks_c", "/claudius-golden/conc-first")]),
  {
    op: "concurrent",
    steps: [J({ tabs: ["f1"] }), J({ pinned: ["f2"] }), J({ activeId: "f3" }), J({ labelMaxWidth: 444 })],
  },
  {
    op: "rowsOneOf",
    cwd: "/claudius-golden/conc-first",
    keys: { open_tabs: ['["f1"]'], pinned_tabs: ['["f2"]'], active_tab: ['"f3"'], tab_label_max_width: ["444"] },
  },
  G(),
];

const steps = [];
for (const s of STEPS) {
  if (await world(s)) {
    steps.push(s);
    continue;
  }
  if (s.op === "rows") steps.push({ ...s, got: rows(s.cwd) });
  else if (s.op === "rowsOneOf") {
    // Concurrent writers land in any order: each key holds one of its candidates.
    const got = rows(s.cwd);
    const keys = Object.keys(s.keys).sort();
    const seen = got.map((r) => r[1]).sort();
    const ok =
      JSON.stringify(seen) === JSON.stringify(keys) &&
      got.every((r) => r[0] === "text" && r[2] === "text" && s.keys[r[1]].includes(r[3]));
    if (!ok) throw new Error(`rowsOneOf ${s.cwd}: ${JSON.stringify(got)}`);
    steps.push(s);
  }
  else if (s.op === "exists") steps.push({ ...s, got: exists(s.cwd) });
  else if (s.op === "concurrent") {
    const got = await Promise.all(s.steps.map(call));
    steps.push({ ...s, got });
  } else steps.push({ ...s, got: await call(s) });
}

// The module-level parts start from an empty world (no files, no DBs, no handles).
closeAll();
rmSync(join(HOME, ".claude"), { recursive: true, force: true });

// ------------------------------- DB functions -------------------------------

const KEYS = ["open_tabs", "pinned_tabs", "active_tab", "tab_label_max_width"];
/** All four getters at once. */
async function readAll(cwd) {
  const c = unsym(cwd);
  return view({
    openTabs: await tabsDb.getOpenTabs(c),
    pinned: await tabsDb.getPinnedTabs(c),
    active: await tabsDb.getActiveTab(c),
    width: await tabsDb.getTabLabelMaxWidth(c),
  });
}
/** Every key's value set to one SQL literal. */
const seedAll = (lit) =>
  KEYS.map((k) => `INSERT INTO ui_state(key, value) VALUES ('${k}', ${lit}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`).join("\n");

const TEXT_LITS = [
  `'["a","b"]'`,
  "'[]'",
  "''",
  "' '",
  `'[1,"a",null,{"x":1},["b"],"a",true,1.5,"a"]'`,
  `'{"0":"a","length":1}'`,
  `'"a"'`,
  `'""'`,
  `'"${esc("0000")}"'`,
  "'5'",
  "'0'",
  "'-0'",
  "'0.0'",
  "'180'",
  "'59.5'",
  "'599.5'",
  "'1e3'",
  "'1E3'",
  "'1e+21'",
  "'1e400'",
  "'-1e400'",
  "'4.5e-324'",
  `'"200"'`,
  "'null'",
  "'true'",
  "'false'",
  "'['",
  "'a'",
  `'"'`,
  `' ["a"] '`,
  `'${ch(9)}250${ch(10)}'`,
  `'${ch(0xfeff)}["a"]'`,
  `'["${esc("00e9")}","${esc("d83d")}${esc("de00")}"]'`,
  `'["${esc("d800")}"]'`,
  `'"${esc("dbff")}x"'`,
  `'[1e400,"x"]'`,
  "'NaN'",
  "'Infinity'",
  "'0x10'",
  "'1_0'",
  "'+5'",
  "'.5e3'",
  "'250.'",
  `'["x",${"[".repeat(150)}${"]".repeat(150)}]'`,
  `'${"[".repeat(150)}"deep"${"]".repeat(150)}'`,
  `CAST(X'${utf8hex('["a')}ff${utf8hex('"]')}' AS TEXT)`,
  `CAST(X'${utf8hex('"b')}c0af${utf8hex('"')}' AS TEXT)`,
  q(JSON.stringify([EMOJI, NFD_E, CJK, `${LONE}`])),
  q(JSON.stringify(uniq(260, "big-"))),
];
const BLOB_LITS = [
  `X'${utf8hex('["a"]')}'`,
  "X''",
  `X'${utf8hex('"b""')}'`,
  `X'${utf8hex('"4"')}'`,
  `X'${utf8hex("300")}'`,
  `X'efbbbf${utf8hex("[]")}'`,
  `X'${utf8hex('["a')}ff${utf8hex('"]')}'`,
  `X'${utf8hex('"')}ff${utf8hex('"')}'`,
  `X'00'`,
];
const LOOSE_LITS = [
  "5",
  "0",
  "-3",
  "250",
  "9007199254740993",
  "-9223372036854775808",
  "1.5",
  "250.4",
  "599.5",
  "0.5",
  "1e21",
  "1e-7",
  "123456789012345680000",
  "9e999",
  "-9e999",
  "-0.0",
  "NULL",
  `'"t"'`,
  `X'${utf8hex("250")}'`,
];

const D = (cwd) => `/claudius-golden/db-${cwd}`;
const DB_STEPS = [
  // No DB: empty reads (the read-only open makes the project dir only).
  { fn: "readAll", cwd: D("main") },
  { fn: "exists", cwd: D("main") },
  { fn: "setActiveTab", cwd: D("main"), arg: null },
  { fn: "exists", cwd: D("main") },
  { fn: "rows", cwd: D("main") },
  { fn: "setOpenTabs", cwd: D("main"), arg: ["a", "b", "a", "", "B", ""] },
  { fn: "setPinnedTabs", cwd: D("main"), arg: ["b"] },
  { fn: "setActiveTab", cwd: D("main"), arg: "a" },
  { fn: "setTabLabelMaxWidth", cwd: D("main"), arg: 250.5 },
  { fn: "rows", cwd: D("main") },
  { fn: "readAll", cwd: D("main") },
  { fn: "setOpenTabs", cwd: D("main"), arg: uniq(201, "x-") },
  { fn: "setPinnedTabs", cwd: D("main"), arg: [] },
  { fn: "setActiveTab", cwd: D("main"), arg: "" },
  { fn: "rows", cwd: D("main") },
  { fn: "readAll", cwd: D("main") },
  { fn: "setActiveTab", cwd: D("main"), arg: null },
  { fn: "setActiveTab", cwd: D("main"), arg: null },
  { fn: "setActiveTab", cwd: D("main"), arg: `${EMOJI}${LONE}"q` },
  { fn: "rows", cwd: D("main") },
  { fn: "readAll", cwd: D("main") },
  // Foreign values in the migrated table (TEXT affinity: numbers turn into text, blobs stay).
  ...[...TEXT_LITS, ...BLOB_LITS, "5", "1.5", "1e400"].flatMap((lit) => [
    { fn: "sql", cwd: D("main"), sql: seedAll(lit) },
    { fn: "lit", cwd: D("main"), lit },
  ]),
  { fn: "rows", cwd: D("main") },
  // A table another writer created without column types: numbers stay numbers.
  {
    fn: "sql",
    cwd: D("loose"),
    sql: "DROP TABLE ui_state; CREATE TABLE ui_state (key PRIMARY KEY, value);",
  },
  ...LOOSE_LITS.flatMap((lit) => [
    { fn: "sql", cwd: D("loose"), sql: seedAll(lit) },
    { fn: "lit", cwd: D("loose"), lit },
  ]),
  { fn: "setOpenTabs", cwd: D("loose"), arg: ["l"] },
  { fn: "setTabLabelMaxWidth", cwd: D("loose"), arg: 77 },
  { fn: "rows", cwd: D("loose") },
  // A table whose key isn't unique: the first row reads; the upsert fails.
  {
    fn: "sql",
    cwd: D("nopk"),
    sql: `DROP TABLE ui_state; CREATE TABLE ui_state (key TEXT, value TEXT); INSERT INTO ui_state VALUES ('open_tabs', '["first"]'), ('open_tabs', '["second"]'), ('active_tab', NULL), ('active_tab', '"second"'), ('tab_label_max_width', '200'), ('tab_label_max_width', '300');`,
  },
  { fn: "readAll", cwd: D("nopk") },
  { fn: "setOpenTabs", cwd: D("nopk"), arg: ["x"] },
  { fn: "setActiveTab", cwd: D("nopk"), arg: null },
  { fn: "setActiveTab", cwd: D("nopk"), arg: "x" },
  { fn: "readAll", cwd: D("nopk") },
  { fn: "rows", cwd: D("nopk") },
  // A key column with another type.
  {
    fn: "sql",
    cwd: D("keys"),
    sql: `DROP TABLE ui_state; CREATE TABLE ui_state (key PRIMARY KEY, value); INSERT INTO ui_state VALUES (X'${utf8hex("open_tabs")}', '["blob key"]'), ('active_tab ', '"spaced"'), ('ACTIVE_TAB', '"upper"');`,
  },
  { fn: "readAll", cwd: D("keys") },
  // A newer schema without the table.
  {
    fn: "sql",
    cwd: D("newer"),
    fresh: true,
    sql: "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999');",
  },
  { fn: "readAll", cwd: D("newer") },
  { fn: "setOpenTabs", cwd: D("newer"), arg: ["a"] },
  { fn: "setPinnedTabs", cwd: D("newer"), arg: ["a"] },
  { fn: "setActiveTab", cwd: D("newer"), arg: null },
  { fn: "setActiveTab", cwd: D("newer"), arg: "a" },
  { fn: "setTabLabelMaxWidth", cwd: D("newer"), arg: 1 },
  // An old schema (v2): reads fail until a write migrates it.
  {
    fn: "sql",
    cwd: D("old"),
    fresh: true,
    sql: "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '2');",
  },
  { fn: "readAll", cwd: D("old") },
  { fn: "setPinnedTabs", cwd: D("old"), arg: ["o"] },
  { fn: "readAll", cwd: D("old") },
  // Not a database; a directory; a rollback-journal database.
  { fn: "dbfile", cwd: D("garbage"), text: "this is not a sqlite database, just text that is long enough" },
  { fn: "readAll", cwd: D("garbage") },
  { fn: "setOpenTabs", cwd: D("garbage"), arg: ["a"] },
  { fn: "setActiveTab", cwd: D("garbage"), arg: null },
  { fn: "dbfile", cwd: D("dir"), dir: true },
  { fn: "readAll", cwd: D("dir") },
  { fn: "setTabLabelMaxWidth", cwd: D("dir"), arg: 100 },
  {
    fn: "sql",
    cwd: D("rollback"),
    fresh: true,
    journal: "delete",
    sql: `CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ui_state VALUES ('open_tabs', '["r"]'), ('pinned_tabs', '["r"]'), ('active_tab', '"r"'), ('tab_label_max_width', '321');`,
  },
  { fn: "readAll", cwd: D("rollback") },
  { fn: "setTabLabelMaxWidth", cwd: D("rollback"), arg: 123 },
  { fn: "readAll", cwd: D("rollback") },
  // The empty cwd and an odd one.
  { fn: "setOpenTabs", cwd: "", arg: ["empty"] },
  { fn: "readAll", cwd: "" },
  { fn: "exists", cwd: "" },
  { fn: "setOpenTabs", cwd: `rel/${NFD_E}/${EMOJI}`, arg: ["odd"] },
  { fn: "readAll", cwd: `rel/${NFD_E}/${EMOJI}` },
];

const db = [];
for (const s of DB_STEPS) {
  const cwd = unsym(s.cwd);
  if (s.fn === "sql") {
    await runSql(s);
    db.push(s);
    continue;
  }
  if (s.fn === "dbfile") {
    await world({ ...s, op: "dbfile" });
    db.push(s);
    continue;
  }
  let got;
  try {
    if (s.fn === "rows") got = rows(s.cwd);
    else if (s.fn === "exists") got = exists(s.cwd);
    else if (s.fn === "readAll" || s.fn === "lit") got = await readAll(s.cwd);
    else got = view(await tabsDb[s.fn](cwd, s.arg));
  } catch (e) {
    got = { threw: msg(e) };
  }
  db.push({ ...s, got });
}

// ------------------------------- clamp -------------------------------

const CLAMP = [
  NaN, Infinity, -Infinity, 0, -0, 1, 59, 59.4, 59.5, 59.49999999999999, 59.50000000000001, 60, 60.5, 61.5, 180, 180.5,
  -180.5, 333.333, 599.4, 599.5, 599.49999999999994, 600, 600.5, 601, 1e21, -1e21, 5e-324, -5e-324, 1e308, 0.5,
  0.49999999999999994, -0.5, 2 ** 53, 2 ** 53 + 2, 123.5, 124.5, 1.7976931348623157e308,
];
const clamp = [];
for (const n of CLAMP) {
  await tabsDb.setTabLabelMaxWidth(D("clamp"), n);
  const r = rows(D("clamp")).find((row) => row[1] === "tab_label_max_width");
  clamp.push({ n: numRepr(n), stored: r[3] });
}

// ------------------------------- titles -------------------------------

const T = (cwd) => `/claudius-golden/titles-${cwd}`;
const pairs = (cwd, ids) => ids.map((id) => (cwd === undefined ? { id } : { cwd, id }));
const many = uniq(620, "m-");
const TITLE_STEPS = [
  { op: "titles", pairs: pairs(T("none"), ["a", "b"]) },
  { op: "titles", pairs: [] },
  SQL(
    T("a"),
    [
      sessionRow("'a1'", "x", "' A one '"),
      sessionRow("'a2'", "x", "'   '"),
      sessionRow("'a3'", "x", "NULL"),
      sessionRow("'a4'", "x", "''"),
      sessionRow("'a5'", "x", q(`${ch(0xa0, 0xfeff)}`)),
      sessionRow("'a6'", "x", q(`${ch(0x85)}`)),
      sessionRow("'shared'", "x", "'shared from A'"),
      sessionRow("'m-610'", "x", "'second chunk'"),
      sessionRow("'m-002'", "x", "'first chunk'"),
      sessionRow("'m-500'", "x", "'chunk edge'"),
      sessionRow(q(`${EMOJI}`), "x", q(`${CJK}`)),
      sessionRow("''", "x", "'empty id'"),
    ].join("\n"),
  ),
  SQL(T("b"), [sessionRow("'shared'", "x", "'shared from B'"), sessionRow("'b1'", "x", "'B one'")].join("\n")),
  { op: "titles", pairs: pairs(T("a"), ["a1", "a2", "a3", "a4", "a5", "a6", "zz", "", "a1", "shared", EMOJI]) },
  { op: "titles", pairs: [...pairs(T("b"), ["shared", "b1", "a1"]), ...pairs(T("a"), ["shared", "a1"])] },
  { op: "titles", pairs: pairs(T("a"), many) },
  { op: "titles", pairs: pairs(T("a"), [...many, ...many]) },
  // Rows come back in id order within a chunk of 500, in pair order across chunks.
  { op: "titles", pairs: pairs(T("a"), ["shared", ...uniq(499, "f-"), "a1"]) },
  { op: "titles", pairs: pairs(T("a"), ["shared", ...uniq(498, "f-"), "a1"]) },
  // No cwd (or ""): every workspace's DB, first hit wins, `*:` keys.
  { op: "titles", pairs: pairs(undefined, ["shared", "b1", "a1"]) },
  wsFile([ws("wks_b", T("b")), ws("wks_a", T("a")), ws("wks_z", T("none"))]),
  { op: "titles", pairs: pairs(undefined, ["shared", "b1", "a1", "zz", "", "a1"]) },
  { op: "titles", pairs: pairs("", ["shared", "a1"]) },
  { op: "titles", pairs: [...pairs(undefined, ["shared"]), ...pairs(T("a"), ["shared"])] },
  SQL("", sessionRow("'a1'", "x", "'from the empty cwd'")),
  wsFile([ws("wks_e", ""), ws("wks_n", 7), ws("wks_o", { a: 1 }), "str", 9, ws("wks_a", T("a"))]),
  { op: "titles", pairs: pairs(undefined, ["shared", "a1"]) },
  wsFile([ws("wks_a", T("a")), null]),
  { op: "titles", pairs: pairs(undefined, ["a1"]) },
  { op: "titles", pairs: pairs(undefined, ["a1", "nope"]) },
  { op: "titles", pairs: pairs(T("a"), ["a1"]) },
  FILE(WSJSON, { text: "{" }),
  { op: "titles", pairs: pairs(undefined, ["a1"]) },
  FILE(WSJSON, { rm: true }),
  // The legacy file, shadow-read for every pair still missing.
  legacyFile({ zz: " legacy zz ", a1: "legacy a1", nope: "legacy nope", a2: "legacy a2", "": "legacy empty" }),
  { op: "titles", pairs: [...pairs(T("a"), ["a1", "a2", "zz", ""]), ...pairs(undefined, ["nope", "zz"])] },
  legacyFile({ zz: 0, a2: false, a3: null, a4: "" }),
  { op: "titles", pairs: pairs(T("a"), ["a1", "a2", "a3", "a4", "zz"]) },
  legacyFile({ zz: 1 }),
  { op: "titles", pairs: pairs(T("a"), ["a1", "zz"]) },
  { op: "titles", pairs: pairs(T("a"), ["a1"]) },
  legacyFile({ zz: [] }),
  { op: "titles", pairs: pairs(T("a"), ["zz"]) },
  legacyFile({ zz: "" }),
  { op: "titles", pairs: pairs(T("a"), ["toString", "valueOf", "__proto__"]) },
  { op: "titles", pairs: pairs(T("a"), ["constructor"]) },
  { op: "titles", pairs: pairs(T("a"), ["__proto__"]) },
  { op: "titles", pairs: pairs(T("a"), ["__defineGetter__"]) },
  FILE(LEGACY, { text: '{"titles":{"__proto__":" own proto ","toString":"own toString"}}' }),
  { op: "titles", pairs: pairs(T("a"), ["__proto__", "toString", "valueOf"]) },
  { op: "titles", pairs: pairs(T("a"), ["__proto__", "toString"]) },
  legacyFile(["l0", " ", 3]),
  { op: "titles", pairs: pairs(T("a"), ["0", "1", "3", "00", "-0", "1.0"]) },
  { op: "titles", pairs: pairs(T("a"), ["2"]) },
  { op: "titles", pairs: pairs(T("a"), ["length"]) },
  { op: "titles", pairs: pairs(T("a"), ["push"]) },
  { op: "titles", pairs: pairs(T("a"), ["toString"]) },
  legacyFile([]),
  { op: "titles", pairs: pairs(T("a"), ["length", "push", "zz"]) },
  legacyFile({ zz: "z" }),
  { op: "titles", pairs: pairs(T("a"), ["length", "push", "zz"]) },
  FILE(LEGACY, { text: '{"titles":{"zz":"z"},"version":2}' }),
  { op: "titles", pairs: pairs(T("a"), ["zz"]) },
  FILE(LEGACY, { text: '{"titles":"zz"}' }),
  { op: "titles", pairs: pairs(T("a"), ["zz", "0"]) },
  FILE(LEGACY, { text: '{"titles":true}' }),
  { op: "titles", pairs: pairs(T("a"), ["zz"]) },
  FILE(LEGACY, { text: "[]" }),
  { op: "titles", pairs: pairs(T("a"), ["zz", "length"]) },
  FILE(LEGACY, { text: "nope" }),
  { op: "titles", pairs: pairs(T("a"), ["zz"]) },
  FILE(LEGACY, { rm: true }),
  // Rows only another writer stores.
  SQL(T("blob"), sessionRow("'x1'", "x", "X'4142'")),
  { op: "titles", pairs: pairs(T("blob"), ["x1"]) },
  { op: "titles", pairs: pairs(T("blob"), ["x2"]) },
  SQL(T("loose"), "DROP TABLE IF EXISTS sessions; CREATE TABLE sessions (id, cwd, title); INSERT INTO sessions VALUES (5, 'x', 'five'), ('6', 'x', 0), ('60', 'x', 0.0), ('7', 'x', 1.5), ('8', 'x', 'eight'), ('8', 'x', 'eight again'), (X'39', 'x', 'nine');"),
  { op: "titles", pairs: pairs(T("loose"), ["5", "6", "60", "8", "9"]) },
  { op: "titles", pairs: pairs(T("loose"), ["7"]) },
  SQL(T("intid"), "DROP TABLE IF EXISTS sessions; CREATE TABLE sessions (id INTEGER, cwd, title TEXT); INSERT INTO sessions VALUES (5, 'x', 'int five'), (1.5, 'x', 'real'), ('x', 'x', 'text x'), (9e999, 'x', 'inf id'), (-9e999, 'x', '-inf id'), (9007199254740993, 'x', 'past 2^53');"),
  { op: "titles", pairs: pairs(T("intid"), ["5", "05", "1.5", "x", "9e999", "-1e400", "Infinity", "9007199254740993"]) },
  SQL(T("nosessions"), "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999');", { fresh: true }),
  { op: "titles", pairs: pairs(T("nosessions"), ["a"]) },
  // The fan-out stops once nothing is missing, before a DB that would throw.
  wsFile([ws("wks_a", T("a")), ws("wks_ns", T("nosessions"))]),
  { op: "titles", pairs: pairs(undefined, ["a1"]) },
  { op: "titles", pairs: pairs(undefined, ["a1", "zz"]) },
  FILE(WSJSON, { rm: true }),
  { op: "dbfile", cwd: T("garbage"), text: "this is not a sqlite database, just text that is long enough" },
  { op: "titles", pairs: pairs(T("garbage"), ["a"]) },
];
const titles = [];
for (const s of TITLE_STEPS) {
  if (await world(s)) {
    titles.push(s);
    continue;
  }
  let got;
  try {
    const m = await getSessionTitlesByCwd(s.pairs.map((p) => ({ cwd: p.cwd === undefined ? undefined : unsym(p.cwd), id: p.id })));
    got = [...m.entries()].map(([k, v]) => [sym(k), v]);
  } catch (e) {
    got = { threw: msg(e) };
  }
  titles.push({ ...s, got });
}

// ------------------------------- active cwd -------------------------------

const A = (cust, wsId) => ({ op: "active", ...(cust === undefined ? {} : { cust }), ...(wsId === undefined ? {} : { ws: wsId }) });
const ACTIVE_STEPS = [
  A(),
  A(undefined, "wks_a"),
  A("cust_1"),
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: "wks_b" }),
  A(),
  A(undefined, "wks_a"),
  A(undefined, "wks_zz"),
  A(undefined, ""),
  A("cust_1", "wks_a"),
  custFile([{ id: "cust_1", name: "C", extra: true }]),
  A("cust_1", "wks_a"),
  A("cust_2", "wks_a"),
  A("", "wks_a"),
  custFile([{ id: "../x" }, { id: "/abs/" }, { id: "a/./b/../c" }, { id: ".." }, { id: `${EMOJI}` }]),
  A("../x"),
  A("/abs/"),
  A("a/./b/../c"),
  A(".."),
  A(EMOJI),
  custFile([null, { id: "cust_1" }]),
  A("cust_1", "wks_a"),
  custFile([{ id: "cust_1" }, null]),
  A("cust_1"),
  A("cust_9", "wks_a"),
  custFile([{ id: "cust_1" }], { version: 1.0 }),
  A("cust_1"),
  custFile([{ id: "cust_1" }], { version: "1" }),
  A("cust_1"),
  custFile([{ id: "cust_1" }], { publishes: {} }),
  A("cust_1"),
  FILE(CUSTJSON, { text: JSON.stringify({ version: 1, customizations: { 0: { id: "cust_1" } }, publishes: [] }) }),
  A("cust_1"),
  FILE(CUSTJSON, { hex: `efbbbf${utf8hex(JSON.stringify({ version: 1, customizations: [{ id: "cust_1" }], publishes: [] }))}` }),
  A("cust_1"),
  FILE(CUSTJSON, { text: "[]" }),
  A("cust_1"),
  FILE(CUSTJSON, { rm: true }),
  // Workspace shapes.
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)]),
  A(),
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: false }),
  A(),
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: 0 }),
  A(),
  wsFile([ws("wks_a", WS_A), ws(true, WS_B)], { activeId: true }),
  A(),
  wsFile([ws("wks_a", WS_A), ws({ k: 1 }, WS_B)], { activeId: { k: 1 } }),
  A(),
  wsFile([ws(0, WS_A), ws("wks_b", WS_B)]),
  A(),
  wsFile([ws(7, WS_A), ws("wks_b", WS_B)]),
  A(),
  A(undefined, "7"),
  wsFile([{ name: "no id", rootPath: WS_A }, ws("wks_b", WS_B)]),
  A(),
  A(undefined, "wks_b"),
  wsFile(["str", ws("wks_b", WS_B)]),
  A(),
  A(undefined, "wks_b"),
  wsFile([null]),
  A(),
  A(undefined, "wks_b"),
  wsFile([]),
  A(),
  wsFile([ws("wks_a", null), ws("wks_b", 5)], { activeId: "wks_b" }),
  A(),
  A(undefined, "wks_a"),
  wsFile([ws("wks_a", [WS_A]), ws("wks_b", false), ws("wks_c", "")]),
  A(),
  A(undefined, "wks_b"),
  A(undefined, "wks_c"),
  wsFile([ws("wks_a", undefined)]),
  A(),
  FILE(WSJSON, { text: JSON.stringify({ version: 1, activeId: "wks_a", workspaces: [ws("wks_a", WS_A)], extra: 1 }) }),
  A(),
  FILE(WSJSON, { text: JSON.stringify({ version: 1, workspaces: "wks_a" }) }),
  A(),
  FILE(WSJSON, { text: JSON.stringify({ workspaces: [ws("wks_a", WS_A)] }) }),
  A(),
  FILE(WSJSON, { hex: utf8hex('{"version":1,"workspaces":[{"id":"wks_a","rootPath":"/claudius-golden/a') + "ff" + utf8hex('"}]}') }),
  A(),
  FILE(WSJSON, { text: `{"version":1,"workspaces":[{"id":"wks_a","rootPath":"/claudius-golden/${esc("d800")}"}]}` }),
  A(),
  FILE(WSJSON, { text: "nope" }),
  A(),
  A(undefined, "wks_a"),
  // Lone surrogates are code units of their own; a cookie's U+FFFD is another character.
  wsFile([ws(ch(0xdc00), WS_A), ws(LONE, WS_L)], { activeId: LONE }),
  A(),
  A(undefined, ch(0xfffd)),
  wsFile([ws(ch(0xfffd), WS_A), ws(LONE, WS_L)], { activeId: LONE }),
  A(),
  A(undefined, ch(0xfffd)),
  custFile([{ id: LONE }, { id: ch(0xfffd) }]),
  A(ch(0xfffd)),
  custFile([{ id: LONE }]),
  A(ch(0xfffd), "wks_zz"),
  FILE(CUSTJSON, { rm: true }),
  // An empty cookie is no cookie, even where an entry has the id "".
  wsFile([ws("", WS_A), ws("wks_b", WS_B)], { activeId: "wks_b" }),
  A(undefined, ""),
  custFile([{ id: "" }, { id: "cust_1" }]),
  A("", "wks_b"),
  // Ids match exactly (case and all).
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: "wks_b" }),
  A(undefined, "WKS_A"),
  custFile([{ id: "cust_1" }]),
  A("CUST_1", "wks_a"),
  FILE(CUSTJSON, { rm: true }),
  FILE(WSJSON, { rm: true }),
];
const active = [];
for (const s of ACTIVE_STEPS) {
  if (await world(s)) {
    active.push(s);
    continue;
  }
  const parts = [];
  if (s.cust !== undefined) parts.push(CUC(s.cust));
  if (s.ws !== undefined) parts.push(WSC(s.ws));
  const req = new Request(URL_, { headers: parts.length ? { cookie: parts.join("; ") } : {} });
  let got;
  try {
    const r = await inRequest(req, () => resolveActiveCwd());
    got = {
      cwd: typeof r.cwd === "string" ? sym(r.cwd) : { nonString: JSON.stringify(r.cwd) ?? typeof r.cwd },
      customizationId: r.customizationId,
      ws: view(r.ws),
    };
  } catch (e) {
    got = { threw: msg(e) };
  }
  active.push({ ...s, got });
}

// ------------------------------- cookies -------------------------------

const COOKIE_HEADERS = [
  "",
  "a=1",
  "a=1; b=2",
  "a=1;b=2",
  "a=1;   b=2",
  "a=1 ;b=2",
  "a=1;\tb=2",
  "a",
  "a;b=2",
  "a=",
  "=a",
  "=",
  ";",
  ";;a=1;;",
  "a=1; a=2",
  "a=1; a=%E0%A4%A",
  "a=%E0%A4%A; a=1",
  "a=%",
  "a=%zz",
  "a=%41%42",
  "a=%e2%82%ac",
  "a=%ED%A0%80",
  "a=%F0%9F%98%80",
  "a=%C0%AF",
  "a=%F4%90%80%80",
  "a=%FF",
  "a=%E2%82",
  "a=%2",
  "a=%+1",
  "a=%-1",
  "a=b=c",
  'a="b"',
  "a=b c",
  "a=+b+",
  "a b=1",
  "a=1, b=2",
  " a=1 ",
  "a=1\t",
  "\ta=1",
  "A=1; a=2",
  "claudius.workspace=wks_a; claudius.customization=cust_1",
  "x=1; claudius.workspace",
  `claudius.workspace=${encodeURIComponent(`${EMOJI} ${NFC_E}`)}`,
  "a=%u0041",
  "a=1;b",
  "a=1;b ;c",
];
const cookies = COOKIE_HEADERS.map((header) => {
  const parsed = new RequestCookies(new Headers({ cookie: header }));
  return { header, got: [...parsed].map(([name, c]) => [name, c.value]) };
});

const fixture = {
  steps,
  db,
  clamp,
  titles,
  active,
  cookies,
};
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify(fixture));
process.exit(0);
