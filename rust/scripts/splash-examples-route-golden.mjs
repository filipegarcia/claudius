#!/usr/bin/env node
// Golden fixture for the splash route (D26b): `GET/PUT/DELETE
// /api/splash-examples` (`app/api/splash-examples/route.ts`) on the real
// `splash-examples-db.ts` (on the real DB layer, `db.ts`), the real
// `splash-fallback-name.ts` (on the real accounts store and global config)
// and the real `resolveActiveCwd` (active-customization.ts +
// active-workspace.ts, read through Next's real `cookies()`):
//
//   node rust/scripts/splash-examples-route-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself twice under `--experimental-transform-types` (two temp
// roots; both recordings must agree byte for byte) with the repo as its cwd
// (db.ts reads its migrations from there at load), HOME and
// CLAUDE_CONFIG_DIR in the temp root and a resolve hook for the `@/` and
// extensionless imports. Once everything is loaded it moves to
// `<root>/project`, which becomes `process.cwd()`, the route's fallback cwd.
//
// A request goes through what Next's server layer does around a route
// module, with Next's own code where it has it: the request runs inside
// Next's request scope (`createRequestStoreForAPI` under `workAsyncStorage` /
// `workUnitAsyncStorage`, so `cookies()` parses the Cookie header as Next
// does); the method table is `autoImplementMethods` (HEAD runs GET, OPTIONS
// answers 204 with `Allow`, POST/PATCH 405) and a method outside
// `HTTP_METHODS` is a 400; every answer carries the `vary` header
// `setVaryHeader` adds (built from Next's header constants); a handler that
// throws is Next's empty 500 (`threw` keeps the message, for reading only);
// a HEAD answer has no body.
//
// `phases`: each starts from an empty world (every DB handle closed,
// `$HOME/.claude` and `$HOME/.claude.json` removed, the global config's 30 s
// cache cleared; a replay starts a new server), then runs its `steps` in
// order:
// - `req`: `method`, optional `query`, `cookie`, and a body as `body` text or
//   `hex` bytes; `got` is the status, the headers (names lowercased, sorted)
//   and the body text;
// - `concurrent`: requests started together; their answers, in order;
// - world steps: `file` (a file under $HOME: `text`, `hex` bytes, a `dir`,
//   or `rm`), `sql` (SQL on a cwd's DB: through `openDb`, so migrated, or
//   `fresh`: a bare file, `journal: "delete"` leaves it out of WAL),
//   `dbfile` (a text file or a directory at a cwd's DB path);
// - dumps: `rows` (every `ui_state` row of a cwd's DB through a separate
//   read-only handle: key, typeof(value), hex(value); or `nodb` / an
//   `error`), `exists` (the cwd's project dir and DB file) and `rowsOneOf`
//   (after concurrent writes, which land in any order in TS too: each listed
//   key holds one of its candidate hex values, checked here before it is
//   written down).
// The global config (`$HOME/.claude.json`) is written once per phase, before
// its first request, since its 30 s cache would hide a later change.
// Paths are written with `$HOME` (the temp home) and `$PROC` (the fallback
// cwd) in place of the temp root.
//
// Written to rust/crates/claudius-server/tests/fixtures/splash_examples_route_golden.json
// and replayed on the real binary by crates/claudius-server/tests/splash_examples_route.rs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/splash_examples_route_golden.json");

if (!process.env.SPLASH_ROUTE_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "splash-route-golden-")));
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
            SPLASH_ROUTE_GOLDEN_CHILD: root,
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
    if (process.env.SPLASH_ROUTE_GOLDEN_DUMP) {
      runs.forEach((r, i) => writeFileSync(join(process.env.SPLASH_ROUTE_GOLDEN_DUMP, `run${i}.json`), r));
    }
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.phases.flatMap((p) => p.steps);
  const requests = steps.reduce((n, s) => n + (s.op === "req" ? 1 : s.op === "concurrent" ? s.steps.length : 0), 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.phases.length} phases, ${steps.length} steps (${requests} requests) (stable)`,
  );
  process.exit(0);
}

const ROOT_DIR = process.env.SPLASH_ROUTE_GOLDEN_CHILD;
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
const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js");
const { isHTTPMethod } = require("next/dist/server/web/http.js");
const H = require("next/dist/client/components/app-router-headers.js");
const VARY = `${H.RSC_HEADER}, ${H.NEXT_ROUTER_STATE_TREE_HEADER}, ${H.NEXT_ROUTER_PREFETCH_HEADER}, ${H.NEXT_ROUTER_SEGMENT_PREFETCH_HEADER}`;

const { default: Database } = await import("better-sqlite3");
const { openDb, closeAll } = await import(join(repo, "lib/server/db.ts"));
const { __resetClaudeGlobalConfigCache } = await import(join(repo, "lib/server/claude-global-config.ts"));
const route = await import(join(repo, "app/api/splash-examples/route.ts"));
const METHODS = autoImplementMethods(route);
process.chdir(PROC);
if (process.cwd() !== PROC) throw new Error(`cwd ${process.cwd()} is not ${PROC}`);

// ------------------------------- helpers -------------------------------

const ch = (...codes) => String.fromCharCode(...codes);
const cp = (...codes) => String.fromCodePoint(...codes);
const EMOJI = cp(0x1f600);
const NFC_E = ch(0xe9);
const NFD_E = `e${ch(0x301)}`;
const CJK = ch(0x4f1a, 0x8a71);
const NBSP = ch(0xa0);
const NEL = ch(0x85);
const BOM = ch(0xfeff);
const ZWSP = ch(0x200b);
const LS = ch(0x2028);
/** The raw escape text `\uXXXX` (kept out of this file's source as is). */
const esc = (hex) => `${"\\"}u${hex}`;
const r = (s, n) => s.repeat(n);

/** `$PROC` / `$HOME` in place of the temp paths, everywhere in a string. */
const sym = (s) => s.split(PROC).join("$PROC").split(HOME).join("$HOME");
const unsym = (s) => s.split("$PROC").join(PROC).split("$HOME").join(HOME);
const encodeProjectDir = (abs) => abs.replace(/[^A-Za-z0-9]/g, "-");
const dbPathOf = (cwd) => join(HOME, ".claude", "projects", encodeProjectDir(unsym(cwd)), ".claudius.db");
const msg = (e) => (e instanceof Error ? e.message : String(e));
const utf8hex = (s) => Buffer.from(s, "utf8").toString("hex");
const byName = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

const ROWS_SQL = "SELECT key, typeof(value), hex(value) FROM ui_state ORDER BY key, rowid";
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
  const work = { route: "/api/splash-examples", forceStatic: false, dynamicShouldError: false };
  return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(store, fn));
}
const URL_ = "http://localhost/api/splash-examples";
function request(s) {
  const headers = {};
  if (s.cookie !== undefined) headers.cookie = s.cookie;
  const init = { method: s.method, headers };
  if (s.hex !== undefined || s.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = s.hex !== undefined ? Buffer.from(s.hex, "hex") : s.body;
  }
  return new Request(URL_ + (s.query ?? ""), init);
}
async function call(s) {
  const req = request(s);
  const handler = isHTTPMethod(s.method) ? METHODS[s.method] : () => new Response(null, { status: 400 });
  let res;
  try {
    res = await inRequest(req, () => handler(req, { params: Promise.resolve({}) }));
  } catch (e) {
    return { status: 500, headers: [["vary", VARY]], body: "", threw: sym(msg(e)) };
  }
  const headers = [["vary", VARY], ...res.headers].sort(byName);
  const body = s.method === "HEAD" ? "" : sym(await res.text());
  return { status: res.status, headers, body };
}

// ------------------------------- world -------------------------------

const WS_A = "/claudius-golden/splash-a";
const WS_B = "/claudius-golden/splash-b";
const WS_C = "/claudius-golden/splash-conc";
const WS_F = "/claudius-golden/splash-fresh";
const WS_G = "/claudius-golden/splash-fresh-2";
const CUST_ROOT = "$HOME/.claude/.claudius/customizations";
const WSJSON = ".claude/.claudius/workspaces.json";
const CUSTJSON = ".claude/.claudius/customizations/index.json";
const ACCOUNTS = ".claude/.claudius/accounts.json";
const GLOBAL = ".claude.json";

const ws = (id, rootPath, extra = {}) => ({
  id,
  name: `ws ${id}`,
  ...(rootPath === undefined ? {} : { rootPath }),
  icon: { kind: "letter", letter: "W", color: "#5588dd" },
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});
const FILE = (path, content) => ({ op: "file", path, ...content });
const wsFile = (workspaces, extra = {}) => FILE(WSJSON, { text: JSON.stringify({ version: 1, ...extra, workspaces }, null, 2) });
const custFile = (customizations) =>
  FILE(CUSTJSON, { text: JSON.stringify({ version: 1, customizations, publishes: [] }) });
let seq = 0;
const profile = (label) => {
  seq += 1;
  return {
    id: `acc_${String(seq).padStart(16, "0")}`,
    label,
    kind: "oauth-token",
    secret: `sk-ant-oat01-${seq}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
};
const accountsFile = (profiles, active) =>
  FILE(ACCOUNTS, {
    text: JSON.stringify(
      { profiles, activeProfileId: active === undefined ? (profiles[0]?.id ?? null) : active, autoRotateOnRateLimit: false },
      null,
      2,
    ),
  });
const globalFile = (displayName) =>
  FILE(GLOBAL, {
    text: JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: "u-1", emailAddress: "a@example.com", displayName } }),
  });
const SQL = (cwd, sql, extra = {}) => ({ op: "sql", cwd, sql, ...extra });
const DBFILE = (cwd, content) => ({ op: "dbfile", cwd, ...content });
const ROWS = (cwd) => ({ op: "rows", cwd });
const EXISTS = (cwd) => ({ op: "exists", cwd });
const R = (method, extra = {}) => {
  const s = { op: "req", method };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) s[k] = v;
  return s;
};
const G = (cookie, query) => R("GET", { cookie, query });
const P = (body, cookie) => R("PUT", { body, cookie });
const PX = (hex, cookie) => R("PUT", { hex, cookie });
const J = (v, cookie) => P(JSON.stringify(v), cookie);
const D = (cookie, body) => R("DELETE", { cookie, body });
const WSC = (id) => `claudius.workspace=${encodeURIComponent(id)}`;
const CUC = (id) => `claudius.customization=${encodeURIComponent(id)}`;
const jsonHex = (v) => utf8hex(JSON.stringify(v));

const two = [profile("Work Max"), profile("Personal Pro")];

// ------------------------------- phases -------------------------------

const MAIN = [
  globalFile("Filipe Garcia"),
  // No workspace: the fallback cwd, no DB yet. A read only makes the project dir.
  EXISTS("$PROC"),
  G(),
  EXISTS("$PROC"),
  ROWS("$PROC"),
  // Next's method table around the module; the query string is ignored.
  R("HEAD"),
  R("OPTIONS"),
  R("POST", { body: "{}" }),
  R("PATCH", { body: '{"examples":["p"]}' }),
  R("PROPFIND"),
  G(undefined, "?cwd=%2Fclaudius-golden%2Fsplash-a"),
  // Bodies: malformed is a 400 before anything is read.
  R("PUT"),
  P(""),
  P("{"),
  P("nul"),
  P("{} x"),
  P('{"examples":undefined}'),
  P('{"examples":["a"],}'),
  P("'x'"),
  PX(`efbbbfefbbbfefbbbf${utf8hex('{"examples":["bom3"]}')}`),
  // Any other value: `null` throws on `body.examples` (after the reads), the rest patch nothing.
  P("[]"),
  P('"examples"'),
  P("7"),
  P("true"),
  P("false"),
  P("1e400"),
  P("{}"),
  P('{"other":1}'),
  EXISTS("$PROC"),
  P("null"),
  EXISTS("$PROC"),
  // examples: only an array passes.
  J({ examples: "a" }),
  J({ examples: null }),
  J({ examples: {} }),
  J({ examples: { length: 1, 0: "a" } }),
  J({ examples: 5 }),
  J({ examples: true }),
  J({ examples: false }),
  P('{"examples":1e400}'),
  P('{"examples":-1e400}'),
  EXISTS("$PROC"),
  // An empty list is a choice: customized, no chips.
  J({ examples: [] }),
  EXISTS("$PROC"),
  ROWS("$PROC"),
  G(),
  // Non-strings dropped, trimmed, blanks dropped, no dedupe.
  J({ examples: ["  Fix the build  ", "", "   ", 1, null, true, {}, ["x"], 2.5, "Add tests", "x", "x", " x "] }),
  ROWS("$PROC"),
  G(),
  // At most 12, counted after blanks are dropped.
  J({ examples: Array.from({ length: 15 }, (_, i) => `s${i + 1}`) }),
  ROWS("$PROC"),
  J({ examples: [...Array(12).fill("  "), "a", "b", 7, "c"] }),
  ROWS("$PROC"),
  // 240 UTF-16 units each, cut after the trim; a cut can leave half a pair.
  J({ examples: [r("a", 240), r("b", 241), ` ${r("c", 240)} `, r("d", 239) + EMOJI, r(EMOJI, 130)] }),
  ROWS("$PROC"),
  G(),
  // Lone surrogates in the body are kept and written back as escapes.
  P(`{"examples":["${esc("d83d")}", "x${esc("dc00")}y", "${esc("d83d")}${esc("de00")}", " ${esc("dbff")} ", "${esc("0041")}${esc("00e9")}"]}`),
  ROWS("$PROC"),
  G(),
  // Unicode and odd characters.
  J({ examples: [EMOJI, NFC_E, NFD_E, CJK, LS, ch(0), ch(0x1f), 'q"uote', "back\\slash", "/sl/ash", "<script>", `${CJK} ${EMOJI}`] }),
  ROWS("$PROC"),
  G(),
  // JS whitespace: NBSP, BOM, LS are trimmed; NEL and ZWSP are not.
  J({ examples: [`${NBSP}x${NBSP}`, `${NEL}n${NEL}`, `${BOM}z${BOM}`, `${ZWSP}w${ZWSP}`, `${LS}l${LS}`, "\t\n v \r\n"] }),
  ROWS("$PROC"),
  // displayName: a string or null.
  J({ displayName: 5 }),
  J({ displayName: true }),
  J({ displayName: false }),
  J({ displayName: [] }),
  J({ displayName: ["Bob"] }),
  J({ displayName: {} }),
  J({ displayName: 0 }),
  P('{"displayName":1e400}'),
  P('{"displayName":-1e400}'),
  ROWS("$PROC"),
  J({ displayName: "  Bob  Smith " }),
  ROWS("$PROC"),
  G(),
  J({ displayName: r("n", 61) }),
  ROWS("$PROC"),
  J({ displayName: r("m", 59) + EMOJI }),
  ROWS("$PROC"),
  G(),
  P(`{"displayName":" ${esc("d800")}x "}`),
  ROWS("$PROC"),
  G(),
  J({ displayName: "" }),
  ROWS("$PROC"),
  G(),
  J({ displayName: "Ann" }),
  J({ displayName: " \t " }),
  ROWS("$PROC"),
  J({ displayName: "Ann" }),
  J({ displayName: null }),
  ROWS("$PROC"),
  J({ displayName: null }),
  J({ displayName: `${NEL}Ann${NBSP}` }),
  G(),
  // Both fields; examples are checked and saved before the name is checked.
  J({ examples: ["both"], displayName: "Both" }),
  ROWS("$PROC"),
  J({ examples: ["first"], displayName: 5 }),
  ROWS("$PROC"),
  J({ examples: "bad", displayName: "Never" }),
  ROWS("$PROC"),
  J({ displayName: "Zed", examples: ["order"] }),
  ROWS("$PROC"),
  G(),
  // Body forms.
  P('{"examples":["d1"],"examples":["d2"]}'),
  P('{"__proto__":{"examples":["proto"]},"displayName":"Proto"}'),
  G(),
  PX(`efbbbf${utf8hex('{"examples":["bom1"]}')}`),
  PX(`efbbbfefbbbf${utf8hex('{"examples":["bom2"]}')}`),
  PX(`${utf8hex('{"examples":["a')}ff${utf8hex('b", "c')}c3${utf8hex('"],"displayName":"x')}c0af${utf8hex('y"}')}`),
  ROWS("$PROC"),
  P(' \n {"examples" : [ "ws" ] , "displayName" : "  W  " } \n'),
  P(`{"examples":["${esc("00e9")}${esc("0041")}", "${esc("2028")}x"]}`),
  ROWS("$PROC"),
  // Where the Rust port is known to differ (its replay lists them): V8 parses nesting past
  // serde_json's 127 levels.
  P(`{"examples":["deep",${r("[", 150)}${r("]", 150)}]}`),
  ROWS("$PROC"),
  J({ examples: ["after"] }),
  ROWS("$PROC"),
  // DELETE: both rows go, whatever the body.
  D(),
  ROWS("$PROC"),
  G(),
  D(),
  J({ examples: ["again"], displayName: "Kept" }),
  D(undefined, "not json"),
  ROWS("$PROC"),
  G(),
  // The fallback name: the global display name, unless there are 2+ accounts.
  accountsFile([profile("Solo Label")]),
  G(),
  accountsFile(two, two[1].id),
  G(),
  J({}),
  D(),
  accountsFile(two, null),
  G(),
  accountsFile(two, "acc_missing"),
  G(),
  FILE(ACCOUNTS, { text: '{"profiles": [' }),
  G(),
  FILE(ACCOUNTS, { rm: true }),

  // Workspaces: the cookie's workspace, else the stored hint.
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: "wks_b" }),
  EXISTS(WS_B),
  G(),
  EXISTS(WS_B),
  J({ examples: ["in B"], displayName: "Bee" }),
  ROWS(WS_B),
  G(),
  G(WSC("wks_a")),
  J({ examples: ["in A"] }, WSC("wks_a")),
  ROWS(WS_A),
  G(WSC("wks_a")),
  G(),
  D(WSC("wks_a")),
  ROWS(WS_A),
  ROWS(WS_B),
  G(WSC("nope")),
  G("claudius.workspace="),
  G(`${WSC("wks_b")}; ${WSC("wks_a")}`),
  G("claudius.workspace=%77ks_a"),
  G(`${WSC("wks_a")}; claudius.workspace=%E0%A4%A`),
  G("Claudius.Workspace=wks_a"),
  // A `null` body throws after the cwd and the chips were read (the project dir is made) ...
  wsFile([ws("wks_f", WS_F)]),
  EXISTS(WS_F),
  P("null"),
  EXISTS(WS_F),
  // ... a malformed one before anything is read; a bad field after the reads.
  wsFile([ws("wks_g", WS_G)]),
  P("{"),
  EXISTS(WS_G),
  J({ examples: "x" }),
  EXISTS(WS_G),
  J({ displayName: 1 }),
  EXISTS(WS_G),
  // rootPath "" is a cwd too (projects/.claudius.db).
  wsFile([ws("wks_e", "")]),
  J({ examples: ["empty root"], displayName: "Empty" }),
  ROWS(""),
  G(),
  // A rootPath that isn't a string: reads give nothing saved, writes are a 500.
  wsFile([ws("wks_n", 5)]),
  G(),
  P("{}"),
  J({ examples: [] }),
  J({ displayName: null }),
  J({ displayName: "n" }),
  J({ displayName: 5 }),
  J({ examples: "x" }),
  D(),
  wsFile([ws("wks_m", undefined)]),
  G(),
  J({ examples: ["m"] }),
  D(),
  wsFile([ws("wks_o", { p: WS_A })]),
  G(),
  D(),

  // Customizations: the customization cookie wins over the workspace one.
  wsFile([ws("wks_a", WS_A), ws("wks_b", WS_B)], { activeId: "wks_b" }),
  custFile([{ id: "cust_1", name: "C" }, { id: "../../esc" }]),
  G(CUC("cust_1")),
  J({ examples: ["cust"], displayName: "Cust" }, CUC("cust_1")),
  ROWS(`${CUST_ROOT}/cust_1/src`),
  G(CUC("cust_1")),
  G(`${CUC("cust_1")}; ${WSC("wks_a")}`),
  G(`${WSC("wks_a")}; ${CUC("cust_1")}`),
  G(`${CUC("cust_9")}; ${WSC("wks_a")}`),
  G(CUC("cust_9")),
  D(CUC("cust_1")),
  ROWS(`${CUST_ROOT}/cust_1/src`),
  // The id goes through path.join: `..` climbs.
  J({ examples: ["esc"] }, CUC("../../esc")),
  ROWS("$HOME/.claude/esc/src"),
  FILE(CUSTJSON, { rm: true }),
  G(CUC("cust_1")),

  // A DB from a newer schema without the table: reads give nothing saved, writes throw.
  wsFile([ws("wks_x", "/claudius-golden/splash-newer")]),
  SQL(
    "/claudius-golden/splash-newer",
    "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999');",
    { fresh: true },
  ),
  G(),
  P("{}"),
  J({ examples: ["n"] }),
  J({ displayName: null }),
  J({ displayName: "n" }),
  D(),
  ROWS("/claudius-golden/splash-newer"),
  // A file that isn't a database; a directory where the DB goes.
  wsFile([ws("wks_x", "/claudius-golden/splash-garbage")]),
  DBFILE("/claudius-golden/splash-garbage", { text: "this is not a sqlite database, just text that is long enough" }),
  G(),
  J({ examples: ["g"] }),
  D(),
  wsFile([ws("wks_x", "/claudius-golden/splash-dir")]),
  DBFILE("/claudius-golden/splash-dir", { dir: true }),
  G(),
  J({ displayName: "d" }),
  // A DB outside WAL mode: the read-only open fails on it, so the chips read as the defaults
  // until a write switches it.
  wsFile([ws("wks_x", "/claudius-golden/splash-rollback")]),
  SQL(
    "/claudius-golden/splash-rollback",
    `CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ui_state VALUES ('splash_examples', '["r1"]'), ('splash_display_name', '"Rolly"');`,
    { fresh: true, journal: "delete" },
  ),
  G(),
  J({ displayName: "Wal" }),
  G(),
  ROWS("/claudius-golden/splash-rollback"),
  // A foreign table without a unique key: the first row reads, the upsert fails, DELETE works.
  wsFile([ws("wks_x", "/claudius-golden/splash-nopk")]),
  SQL(
    "/claudius-golden/splash-nopk",
    `CREATE TABLE ui_state (key TEXT, value TEXT); INSERT INTO ui_state VALUES ('splash_examples', '["first"]'), ('splash_examples', '["second"]'), ('splash_display_name', '"One"');`,
    { fresh: true },
  ),
  G(),
  J({ examples: ["k"] }),
  J({ displayName: "k" }),
  J({ displayName: null }),
  G(),
  D(),
  ROWS("/claudius-golden/splash-nopk"),
  G(),

  // Concurrent requests: no lock in TS. Each PUT answers its own list; the row is one of them.
  wsFile([ws("wks_c", WS_C)]),
  J({ displayName: "Conc" }),
  {
    op: "concurrent",
    steps: Array.from({ length: 6 }, (_, i) => J({ examples: [` c${i} `, "c"] })),
  },
  {
    op: "rowsOneOf",
    cwd: WS_C,
    keys: {
      splash_display_name: [jsonHex("Conc").toUpperCase()],
      splash_examples: Array.from({ length: 6 }, (_, i) => jsonHex([`c${i}`, "c"]).toUpperCase()),
    },
  },
  J({ examples: ["settled"] }),
  { op: "concurrent", steps: [G(), G(), R("HEAD"), G(), R("OPTIONS")] },
  G(),
];

const NO_GLOBAL = [
  // No ~/.claude.json: the single account's label, else nothing.
  G(),
  accountsFile([profile("Solo Label")]),
  G(),
  accountsFile([profile("   ")]),
  G(),
  accountsFile([profile(`  ${EMOJI}${EMOJI} two`)]),
  G(),
  accountsFile([profile("First One"), profile("Second Two")]),
  G(),
  J({ displayName: "Mine", examples: ["x"] }),
  D(),
  FILE(ACCOUNTS, { rm: true }),
  P("{}"),
];

const BLANK_GLOBAL = [
  // A blank display name still wins over the single account, and gives nothing.
  globalFile("   "),
  accountsFile([profile("Solo Label")]),
  G(),
  J({ displayName: "Own" }),
  D(),
];

const PHASES = [
  ["main", MAIN],
  ["no global config", NO_GLOBAL],
  ["a blank global display name", BLANK_GLOBAL],
];

const phases = [];
for (const [name, STEPS] of PHASES) {
  closeAll();
  rmSync(join(HOME, ".claude"), { recursive: true, force: true });
  rmSync(join(HOME, GLOBAL), { recursive: true, force: true });
  __resetClaudeGlobalConfigCache();
  const steps = [];
  for (const s of STEPS) {
    if (await world(s)) {
      steps.push(s);
      continue;
    }
    if (s.op === "rows") steps.push({ ...s, got: rows(s.cwd) });
    else if (s.op === "exists") steps.push({ ...s, got: exists(s.cwd) });
    else if (s.op === "rowsOneOf") {
      // Concurrent writers land in any order: each key holds one of its candidates.
      const got = rows(s.cwd);
      const keys = Object.keys(s.keys).sort();
      const ok =
        Array.isArray(got) &&
        JSON.stringify(got.map((row) => row[0])) === JSON.stringify(keys) &&
        got.every((row) => row[1] === "text" && s.keys[row[0]].includes(row[2]));
      if (!ok) throw new Error(`rowsOneOf ${s.cwd}: ${JSON.stringify(got)}`);
      steps.push(s);
    } else if (s.op === "concurrent") {
      steps.push({ ...s, got: await Promise.all(s.steps.map(call)) });
    } else if (s.op === "req") {
      steps.push({ ...s, got: await call(s) });
    } else throw new Error(`unknown op ${s.op}`);
  }
  phases.push({ name, steps });
}

writeFileSync(
  join(ROOT_DIR, "out.json"),
  JSON.stringify({ vary: VARY, allow: (await METHODS.OPTIONS()).headers.get("allow"), phases }),
);
process.exit(0);
