#!/usr/bin/env node
// Golden fixture for D18b: the Cost page's read side.
// `lib/server/cost-aggregate.ts` (+ `app/api/cost/route.ts`),
// `lib/server/cost-overview.ts` (+ `app/api/cost/overview/route.ts`) and
// `app/api/cost/loops/route.ts`, recorded from the real TS sources:
//
//   node rust/scripts/cost-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the `@/` and extensionless imports, in two modes, each twice (two temp
// roots, through realpath, padded to ROOT_LEN characters so file sizes that
// hold the root agree); each mode's two recordings must agree byte for byte.
// The child's cwd is the repo (`openDb` reads its migrations from it), HOME
// `<root>/home`, CLAUDE_CONFIG_DIR `<root>/config`, TZ=UTC,
// CLAUDIUS_DISABLE_PRICE_REFRESH=1 (no network), umask 022. `new Date()` and
// `Date.now()` read a pinned clock. Before anything else the price cache
// `home/.claude/.claudius-litellm-prices.json` gets `PRICES` (the bundle
// overlaid with the `claude-golden-*` models every case prices with).
//
// Recorded text has the root written `$ROOT` and `encodeProjectDir(root)`
// written `$EROOT`.
//
// - `core` (mode core, clock 2001-02-03T12:00:00.000Z unless a `clock` op
//   moves it):
//   - `dayKeys`: `dayKey(ms)` per `[tz, ms]` (TZ switched in-process).
//   - `rowUsd`: `rowUsd(rows[r], getPricingTable(), pricings[p])` as
//     `String(x)` (or `{threw}`), and `hasModelPricingOverride(pricings[p])`.
//     In `rows`, NaN / +-Infinity / -0 are the strings "NaN", "Infinity",
//     "-Infinity", "-0". A pricing is its JSON text, or null for undefined.
//   - `steps`: setup ops and calls, in order. Ops: `write` (path relative
//     to the root; `text` or `hex`; `mtime` in seconds), `mkdir`, `rm`,
//     `chmod` (`mode`), `symlink` (`target`, relative to the link's dir),
//     `sql` (`openDb(cwd).exec(sql)`), `rawdb` (better-sqlite3 on `path`, WAL,
//     `exec(sql)`), `clock` (`ms`), `tz`. Calls: `aggregate` (`cwd`) and
//     `overview`, each with `got` (`{json}`: `JSON.stringify` of the result,
//     or `{threw}`: the message) and `changes`: what changed under
//     `home/.claude` (every directory as "d", "d?" when it can't be read,
//     each `.claudius-cost-cache.json` as its text, symlinks skipped) as
//     `[path, now | null]`.
// - `routes` (mode routes, clock 2001-12-15T00:00:00.000Z, after every
//   transcript's 30-day window): `steps` with the same ops plus `request`
//   (`method`, `path` with its query): `got` is `{status, type, body}`, or
//   `{threw}` for Next's empty 500; `notExported` methods are recorded as
//   405, what the Rust router answers without a Next behind it.
//
// Written to rust/crates/claudius-core/tests/fixtures/cost_golden.json;
// replayed by crates/claudius-core/tests/cost_golden.rs (core) and
// crates/claudius-server/tests/cost_routes.rs (routes, on the real binary).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/cost_golden.json");
const ROOT_LEN = 96;

// ------------------------------- recording -------------------------------

if (!process.env.COST_GOLDEN_MODE) {
  const record = (mode) => {
    const runs = [0, 1].map(() => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "cost-golden-")));
      try {
        if (base.length > ROOT_LEN - 3) throw new Error(`tmpdir too long: ${base}`);
        const root = join(base, "r".repeat(ROOT_LEN - base.length - 1));
        for (const d of ["", "home", "config"]) mkdirSync(join(root, d), { recursive: true });
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
              TZ: "UTC",
              CLAUDIUS_DISABLE_PRICE_REFRESH: "1",
              COST_GOLDEN_MODE: mode,
              COST_GOLDEN_ROOT: root,
            },
          },
        );
        if (r.status !== 0) {
          process.stdout.write(r.stdout);
          process.stderr.write(r.stderr);
          process.exit(r.status ?? 1);
        }
        return readFileSync(join(root, "out.json"), "utf8");
      } finally {
        chmodTree(base);
        rmSync(base, { recursive: true, force: true });
      }
    });
    if (runs[0] !== runs[1]) {
      if (process.env.COST_GOLDEN_DUMP) {
        runs.forEach((r, i) => writeFileSync(`${process.env.COST_GOLDEN_DUMP}.${mode}.${i}.json`, r));
      }
      throw new Error(`the two ${mode} recordings differ`);
    }
    return JSON.parse(runs[0]);
  };
  const fixture = { rootLen: ROOT_LEN, core: record("core"), routes: record("routes") };
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const calls = (steps) => steps.filter((s) => s.got).length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.core.dayKeys.length} day keys, ` +
      `${fixture.core.rowUsd.cases.length} rowUsd cases, ${calls(fixture.core.steps)} core calls, ` +
      `${calls(fixture.routes.steps)} route requests`,
  );
  process.exit(0);
}

/** Make every directory under `p` writable again (a step may chmod one). */
function chmodTree(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  chmodSync(p, 0o755);
  for (const n of readdirSync(p)) chmodTree(join(p, n));
}

// --------------------------------- child ---------------------------------

const MODE = process.env.COST_GOLDEN_MODE;
const ROOT = process.env.COST_GOLDEN_ROOT;
const HOME = process.env.HOME;
process.umask(0o022);

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

const DAY = 86_400_000;
const BASE = MODE === "core" ? Date.UTC(2001, 1, 3, 12, 0, 0) : Date.UTC(2001, 11, 15, 0, 0, 0);
let clock = BASE;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock);
    else super(...args);
  }
  static now() {
    return clock;
  }
};

const J = JSON.stringify;
const BS = "\\";
/** The JSON escape text for one UTF-16 unit, e.g. `esc("d800")`. */
const esc = (hex) => `${BS}u${hex}`;

const mod = (p) => import(pathToFileURL(join(repo, p)).href);
const agg = await mod("lib/server/cost-aggregate.ts");
const ov = await mod("lib/server/cost-overview.ts");
const { getPricingTable } = await mod("lib/server/litellm-pricing.ts");
const { hasModelPricingOverride } = await mod("lib/server/model-pricing-override.ts");
const { openDb } = await mod("lib/server/db.ts");
const { encodeProjectDir } = await mod("lib/server/auto-memory.ts");
const costRoute = await mod("app/api/cost/route.ts");
const loopsRoute = await mod("app/api/cost/loops/route.ts");
const overviewRoute = await mod("app/api/cost/overview/route.ts");
const Database = createRequire(join(repo, "package.json"))("better-sqlite3");

const EROOT = encodeProjectDir(ROOT);
const norm = (s) => s.split(ROOT).join("$ROOT").split(EROOT).join("$EROOT");
const unnorm = (s) => s.split("$EROOT").join(EROOT).split("$ROOT").join(ROOT);
const abs = (rel) => join(ROOT, unnorm(rel));

// ------------------------------- the price cache -------------------------------

const PRICES = {
  "claude-golden-tiered": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_creation_input_token_cost: 3.75e-6,
    cache_read_input_token_cost: 3e-7,
    input_cost_per_token_above_200k_tokens: 6e-6,
    output_cost_per_token_above_200k_tokens: 2.25e-5,
    cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
    cache_read_input_token_cost_above_200k_tokens: 6e-7,
  },
  "claude-golden-100k": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_creation_input_token_cost: 1.25e-6,
    cache_read_input_token_cost: 1e-7,
    input_cost_per_token_above_100k_tokens: 2e-6,
    output_cost_per_token_above_100k_tokens: 7.5e-6,
  },
  "claude-golden-flat": { input_cost_per_token: 7e-7, output_cost_per_token: 3.3e-6 },
  "claude-golden-route": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
};
const PRICE_CACHE = "home/.claude/.claudius-litellm-prices.json";

// ------------------------------- ops -------------------------------

const CACHE = ".claudius-cost-cache.json";
function snap() {
  const outSnap = {};
  const walk = (p, rel, depth) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names;
      try {
        names = readdirSync(p);
      } catch {
        outSnap[rel] = "d?";
        return;
      }
      outSnap[rel] = "d";
      if (depth < 14) for (const n of names) walk(join(p, n), `${rel}/${n}`, depth + 1);
    } else if (rel.endsWith(`/${CACHE}`)) {
      outSnap[norm(rel)] = norm(readFileSync(p, "utf8"));
    }
  };
  walk(join(HOME, ".claude"), "home/.claude", 0);
  const normed = {};
  for (const [k, v] of Object.entries(outSnap)) normed[norm(k)] = v;
  return normed;
}
function changes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => J(before[k]) !== J(after[k])).map((k) => [k, after[k] ?? null]);
}

async function apply(op) {
  const p = op.path === undefined ? undefined : abs(op.path);
  switch (op.op) {
    case "write":
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, op.hex !== undefined ? Buffer.from(op.hex, "hex") : unnorm(op.text));
      if (op.mtime !== undefined) utimesSync(p, op.mtime, op.mtime);
      return;
    case "mkdir":
      mkdirSync(p, { recursive: true });
      return;
    case "rm":
      rmSync(p, { recursive: true, force: true });
      return;
    case "chmod":
      chmodSync(p, op.mode);
      return;
    case "symlink":
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(op.target, p);
      return;
    case "sql":
      (await openDb(op.cwd)).exec(op.sql);
      return;
    case "rawdb": {
      mkdirSync(dirname(p), { recursive: true });
      const db = new Database(p);
      db.pragma("journal_mode = WAL");
      db.exec(op.sql);
      db.close();
      return;
    }
    case "clock":
      clock = op.ms;
      return;
    case "tz":
      process.env.TZ = op.tz;
      return;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

async function call(op) {
  try {
    if (op.op === "aggregate") return { json: norm(J(await agg.aggregate(op.cwd))) };
    if (op.op === "overview") return { json: norm(J(await ov.aggregateOverview())) };
    const url = `http://localhost${op.path}`;
    if (op.notExported) return { status: 405 };
    const route = op.path.startsWith("/api/cost/loops")
      ? loopsRoute
      : op.path.startsWith("/api/cost/overview")
        ? overviewRoute
        : costRoute;
    const r = await route[op.method](new Request(url, { method: op.method }));
    return { status: r.status, type: r.headers.get("content-type"), body: norm(await r.text()) };
  } catch (e) {
    return { threw: norm(String(e?.message ?? e)) };
  }
}

const CALLS = new Set(["aggregate", "overview", "request"]);
async function run(steps) {
  const recorded = [];
  let before = snap();
  for (const s of steps) {
    if (!CALLS.has(s.op)) {
      await apply(s);
      recorded.push(s);
      continue;
    }
    const got = await call(s);
    const after = snap();
    recorded.push({ ...s, got, changes: changes(before, after) });
    before = after;
  }
  return recorded;
}

// ------------------------------- transcript builders -------------------------------

const iso = (days, hours = 12) => new RealDate(BASE + days * DAY + (hours - 12) * 3_600_000).toISOString();
/** An assistant record. */
function A(o) {
  const rec = { type: "assistant" };
  if (o.ts !== undefined) rec.timestamp = o.ts;
  if (o.req !== undefined) rec.requestId = o.req;
  if (o.cost !== undefined) rec.costUSD = o.cost;
  if (o.cwd !== undefined) rec.cwd = o.cwd;
  const message = {};
  if (o.id !== undefined) message.id = o.id;
  if (o.model !== undefined) message.model = o.model;
  if (o.usage !== undefined) message.usage = o.usage;
  rec.message = message;
  return J(rec);
}
const U = (i, o = 0, cr = 0, cw = 0) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
});
const lines = (...ls) => `${ls.join("\n")}\n`;
const MT = (days) => Math.floor((BASE + days * DAY) / 1000);
const W = (path, text, mtimeDays = 0) => ({ op: "write", path, text, mtime: MT(mtimeDays) });
const P = (dir) => `home/.claude/projects/${dir}`;

const TIERED = "claude-golden-tiered";
const C100K = "claude-golden-100k";
const FLAT = "claude-golden-flat";

const profile = (id, label) => ({ id, label, kind: "oauth-token", secret: "s", createdAt: "2001-01-01T00:00:00.000Z" });
const ws = (id, name, rootPath) => ({
  id,
  ...(name === undefined ? {} : { name }),
  rootPath,
  icon: { kind: "letter", letter: "W", color: "#d97757" },
  createdAt: 1,
  updatedAt: 1,
  defaults: { additionalDirectories: [] },
});
const workspaces = (list) => ({ op: "write", path: "home/.claude/.claudius/workspaces.json", text: `${J({ version: 1, workspaces: list }, null, 2)}\n` });
const accounts = (profiles) => ({ op: "write", path: "home/.claude/.claudius/accounts.json", text: J({ profiles, activeProfileId: profiles[0]?.id ?? null }) });
const settings = (text) => ({ op: "write", path: "home/.claude/settings.json", text });
const sessionRows = (cwd, rows) => ({
  op: "sql",
  cwd,
  sql: rows
    .map(
      ([id, title, state]) =>
        `INSERT INTO sessions (id, cwd, title, created_at, updated_at, last_seen_at, state) VALUES (${sq(id)}, ${sq(cwd)}, ${title === null ? "NULL" : sq(title)}, 1, 1, 1, ${state === null ? "'{}'" : sq(state)});`,
    )
    .join("\n"),
});
const sq = (s) => `'${s.split("'").join("''")}'`;
const pin = (id) => J({ accountProfileId: id });

// ------------------------------- core -------------------------------

async function core() {
  await apply({ op: "write", path: PRICE_CACHE, text: J(PRICES), mtime: MT(0) });
  const table = await getPricingTable();

  // dayKey
  const TZS = ["UTC", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe", "Pacific/Kiritimati", "America/St_Johns"];
  const MS = [
    0, -1, 1, 1.5, -0.5, 999999999999, BASE, Date.UTC(2026, 2, 8, 6, 59, 59, 999), Date.UTC(2026, 2, 8, 7, 0, 0),
    Date.UTC(2026, 10, 1, 5, 59, 59, 999), Date.UTC(2026, 10, 1, 6, 0, 0), Date.UTC(2026, 9, 4, 15, 30),
    Date.UTC(1999, 11, 31, 23, 59, 59, 999), Date.UTC(9999, 11, 31, 23, 59, 59, 999), 253402300800000,
    -62198755200000, -62167219200001, 8.64e15, -8.64e15, 8.64e15 + 1, Date.UTC(20000, 5, 15), Date.UTC(-5000, 0, 1),
    Date.UTC(1900, 0, 1), Date.UTC(1883, 10, 18, 17),
  ];
  const dayKeys = [];
  for (const tz of TZS) {
    process.env.TZ = tz;
    for (const ms of MS) dayKeys.push([tz, ms, agg.dayKey(ms)]);
  }
  process.env.TZ = "UTC";

  // rowUsd
  const NUM = (v) => (Number.isNaN(v) ? "NaN" : v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : Object.is(v, -0) ? "-0" : v);
  const R = (m, i, o, cr, cw, cw1h, u = null, geo = null) => ({ k: null, m, d: "2001-02-03", i, o, cr, cw, cw1h, u, geo });
  const ROWS = [
    R(TIERED, 1000, 500, 2000, 3000, 0),
    R(TIERED, 100000, 10, 50000, 50000, 0),
    R(TIERED, 100001, 10, 50000, 50000, 0),
    R(TIERED, 150000, 1000, 0, 50001, 20000),
    R(TIERED, 0, 0, 0, 10000, 4000),
    R(TIERED, 0, 0, 0, 10000, 25000),
    R(TIERED, 0, 0, 0, 10000, -5),
    R(TIERED, 10, 10, 10, 10, 0, 0.123),
    R(TIERED, 10, 10, 10, 10, 0, 0),
    R(TIERED, 1000, 1000, 0, 0, 0, null, "us"),
    R(TIERED, 1000, 1000, 0, 0, 0, null, "US"),
    R(TIERED, 1000, 1000, 0, 0, 0, null, "eu"),
    R(TIERED, 1000, 1000, 0, 0, 0, 2, "us"),
    R(C100K, 60000, 100, 40000, 0, 0),
    R(C100K, 60000, 100, 40001, 0, 0),
    R(C100K, 60000, 100, 30000, 10001, 10001),
    R(FLAT, 1000, 1000, 5000, 5000, 2000),
    R("claude-golden-tiered-20990101", 1000, 1000, 0, 0, 0),
    R("gpt-4o", 1000, 1000, 0, 0, 0),
    R("", 1000, 1000, 0, 0, 0),
    R("(unknown)", 1000, 1000, 0, 0, 0),
    R("constructor", 1000, 1000, 0, 0, 0),
    R(TIERED, NaN, 1, 1, 1, 0),
    R(TIERED, Infinity, 1, 1, 1, 0),
    R(TIERED, 1, 1, 1, Infinity, Infinity),
    R(TIERED, 1, 1, 1, NaN, 0),
    R(TIERED, 0.1, 0.2, 0.3, 0.4, 0.1),
    R(TIERED, 123456789, 987654321, 0, 0, 0),
  ];
  const PRICINGS = [
    null,
    "null",
    "{}",
    '{"multiplier":0.8}',
    '{"discountMultiplier":0.5}',
    '{"multiplier":20}',
    '{"multiplier":-1,"discountMultiplier":0.5}',
    '{"multiplier":"0.5"}',
    '{"multiplier":1e400}',
    '{"rates":{"claude-golden-tiered":{"input":2,"output":8,"cacheRead":0.2,"cacheWrite5m":2.5,"cacheWrite1h":4}}}',
    '{"rates":{"golden":{"input":1,"cacheWrite5m":3}},"multiplier":0.9}',
    '{"overrides":{"golden-tiered":{"input":1,"output":2,"cacheRead":0.1,"cacheWrite":1.25}},"multiplier":0.9}',
    '{"overrides":{},"rates":{"tiered":{"input":"3","output":[4],"cacheRead":null}}}',
    '{"rates":{"golden":0}}',
    '{"overrides":{"claude-golden-tiered":null}}',
    '{"rates":{"x":{"input":{"toString":1}}}}',
    '{"rates":{"":{"output":1}}}',
    "5",
    '"abc"',
  ];
  const rowCases = [];
  const hasOverride = [];
  for (let p = 0; p < PRICINGS.length; p++) {
    const pricing = PRICINGS[p] === null ? undefined : JSON.parse(PRICINGS[p]);
    try {
      hasOverride.push(hasModelPricingOverride(pricing));
    } catch (e) {
      hasOverride.push({ threw: e.message });
    }
    for (let r = 0; r < ROWS.length; r++) {
      let got;
      try {
        const x = agg.rowUsd(ROWS[r], table, pricing);
        got = Object.is(x, -0) ? "-0" : String(x);
      } catch (e) {
        got = { threw: e.message };
      }
      rowCases.push([r, p, got]);
    }
  }
  const rowUsd = {
    rows: ROWS.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? NUM(v) : v]))),
    pricings: PRICINGS,
    hasOverride,
    cases: rowCases,
  };

  // ---- the world ----
  const WS_A = "/claudius-golden/ws-a";
  const A_DIR = P("-claudius-golden-ws-a");
  const WS_Q = "/claudius-golden/ws-q";
  const Q_DIR = P("-claudius-golden-ws-q");
  const WS_T = "/claudius-golden/ws-t";
  const T_DIR = P("-claudius-golden-ws-t");
  const WS_E2 = "/claudius-golden/ws-e2";
  const E2_DIR = P("-claudius-golden-ws-e2");
  const H_ROOT = "$ROOT/home/proj-h";
  const H_DIR = P("$EROOT-home-proj-h");

  const s1 = lines(
    A({ id: "m1", req: "r1", model: TIERED, ts: iso(0), usage: U(1000, 500, 2000, 3000) }),
    A({ id: "m1", req: "r1", model: TIERED, ts: iso(0), usage: U(1000, 500, 2000, 3000) }),
    A({ id: "m2", req: "r2", model: TIERED, ts: iso(-1), usage: { input_tokens: 10, output_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 4000 } } }),
    A({ id: "m3", req: "r3", model: C100K, ts: iso(-6), usage: U(60000, 100, 40001, 0) }),
    A({ id: "m4", req: "r4", model: TIERED, ts: iso(-7), cost: 0.25, usage: U(1, 1, 1, 1) }),
    A({ id: "m5", req: "r5", model: TIERED, ts: iso(-29), usage: U(150000, 10, 50001, 0) }),
    A({ id: "m6", req: "r6", model: TIERED, ts: iso(-30), usage: { ...U(1000, 100), inference_geo: "us" } }),
    J({ type: "user", timestamp: iso(0), message: { role: "user", content: "hi" } }),
    A({ id: "m7", req: "r7", model: "<synthetic>", ts: iso(0), usage: U(5, 5) }),
    '{"type":"assistant",',
    ` ${A({ id: "m70", req: "r70", model: TIERED, ts: iso(0), usage: U(5, 5) })}`,
    A({ id: "m71", req: "r71", model: TIERED, ts: "not a date", usage: U(5, 5) }),
    A({ id: "m72", req: "r72", model: TIERED, ts: iso(0) }),
    A({ id: "m73", req: "r73", model: TIERED, ts: iso(0), usage: 0 }),
    A({ id: "m8", req: "r8", model: FLAT, ts: iso(-2), usage: "x" }),
    A({ model: FLAT, ts: iso(-2), usage: U(100, 100) }),
    A({ model: FLAT, ts: iso(-2), usage: U(100, 100) }),
    `${A({ id: "m9", req: "r9", model: FLAT, ts: iso(-3), usage: U(300) })}\r`,
    A({ id: "m10", req: "r10", ts: iso(-3), usage: U(300, 300) }),
    A({ id: "m11", req: "r11", model: FLAT, ts: iso(-4), usage: { input_tokens: "1500", output_tokens: true, cache_read_input_tokens: [7], cache_creation_input_tokens: {} } }),
    A({ id: "m12", req: "r12", model: TIERED, ts: "2001-02-03T23:30:00-05:00", usage: U(10) }),
    A({ id: "m13", req: "r13", model: `claude-x${esc("d800")}`, ts: iso(-1), usage: U(10) }).split(BS + BS + "u").join(BS + "u"),
    A({ id: "m1", req: "r1-b", model: TIERED, ts: iso(0), usage: U(1, 2, 3, 4) }),
    A({ id: "", req: "r14", model: FLAT, ts: iso(0), usage: U(1) }),
    A({ id: "m15", req: "", model: FLAT, ts: iso(0), usage: U(1) }),
    A({ id: 15, req: "r15", model: FLAT, ts: iso(0), cost: 1e400, usage: U(1) }).replace('"costUSD":null', '"costUSD":1e400'),
    A({ id: "m16", req: "r16", model: FLAT, ts: iso(0), usage: { ...U(1), cache_creation: "abc", inference_geo: 5 } }),
    A({ id: "m17", req: "r17", model: TIERED, ts: iso(0), usage: { cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 } } }),
    A({ id: "m18", req: "r18", model: TIERED, ts: iso(0), usage: { cache_creation_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: { toString: 1 } } } }),
  );
  const agentA = lines(
    A({ id: "sa1", req: "rs1", model: TIERED, ts: iso(-1), usage: U(400, 40) }),
    A({ id: "m1", req: "r1", model: TIERED, ts: iso(0), usage: U(1000, 500, 2000, 3000) }),
  );
  const s2 = lines(
    A({ id: "m1", req: "r1", model: TIERED, ts: iso(0), usage: U(1000, 500, 2000, 3000) }),
    A({ id: "n1", req: "q1", model: TIERED, ts: iso(0, 18), usage: U(2000, 200) }),
    A({ id: "m2", req: "r2", model: TIERED, ts: iso(-1), usage: { input_tokens: 10, output_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 4000 } } }),
  );
  const s6 = lines(
    ...["x-model", "x-model", "5", "5", "constructor", "constructor", "constructor", FLAT, "__proto__", "__proto__", "__proto__"].map((m, i) =>
      A({ id: `h${i}`, req: `rh${i}`, model: m, ts: iso(-5), usage: U(10 * (i + 1)) }),
    ),
  );
  const s7 = lines(
    A({ id: "z1", req: "rz1", model: "zeta", ts: iso(-8), usage: U(1) }),
    A({ id: "z2", req: "rz2", model: "alpha", ts: iso(-8), usage: U(1) }),
  );
  const s8 = lines(A({ id: "k1", req: "rk1", model: "constructor", ts: iso(-9), usage: U(1) }));

  const steps = [
    workspaces([ws("wks_a", "Alpha", WS_A), ws("wks_b", "Beta", "/claudius-golden/ws-b"), ws("wks_h", undefined, H_ROOT), ws("wks_t", "Tee", WS_T)]),
    accounts([profile("acct_1", "Work"), profile("acct_2", "Personal"), profile("acct_1", "Work again")]),
    W(`${A_DIR}/s1.jsonl`, s1, -1),
    W(`${A_DIR}/s1/subagents/agent-a.jsonl`, agentA, -1),
    W(`${A_DIR}/s1/subagents/workflows/wf_1/agent-b.jsonl`, lines(A({ id: "sb1", req: "rsb1", model: FLAT, ts: iso(-2), usage: U(70, 7) })), -1),
    W(`${A_DIR}/s1/subagents/deep/1/2/3/agent-c.jsonl`, lines(A({ id: "sc1", req: "rsc1", model: FLAT, ts: iso(-2), usage: U(80, 8) })), -1),
    W(`${A_DIR}/s1/subagents/deep/1/2/3/4/agent-d.jsonl`, lines(A({ id: "sd1", req: "rsd1", model: FLAT, ts: iso(-2), usage: U(90, 9) })), -1),
    W(`${A_DIR}/s1/subagents/notes.txt`, lines(A({ id: "st1", req: "rst1", model: FLAT, ts: iso(-2), usage: U(90, 9) })), -1),
    W(`${A_DIR}/s2.jsonl`, s2, -1),
    W(`${A_DIR}/s3.jsonl`, lines(A({ id: "m3", req: "r3", model: C100K, ts: iso(-6), usage: U(60000, 100, 40001, 0) }), A({ id: "m4", req: "r4", model: TIERED, ts: iso(-7), cost: 0.25, usage: U(1, 1, 1, 1) })), -1),
    W(`${A_DIR}/s4.jsonl`, "", -1),
    W(`${A_DIR}/bad id!.jsonl`, lines(A({ id: "b1", req: "rb1", model: TIERED, ts: iso(-3), usage: U(500, 50) })), -1),
    W(`${A_DIR}/bad id!/subagents/agent-x.jsonl`, lines(A({ id: "bx", req: "rbx", model: TIERED, ts: iso(-3), usage: U(500, 50) })), -1),
    W(`${A_DIR}/s5.jsonl`, lines(A({ id: "l1", req: "rl1", model: FLAT, ts: iso(-4), usage: U(250, 25) })), -1),
    { op: "symlink", path: `${A_DIR}/link.jsonl`, target: "s5.jsonl" },
    W(`${A_DIR}/s6.jsonl`, s6, -1),
    W(`${A_DIR}/s7.jsonl`, s7, -1),
    W(`${A_DIR}/s8.jsonl`, s8, -1),
    W(`${A_DIR}/notes.json`, "{}", -1),
    sessionRows(WS_A, [
      ["s1", "First title", pin("acct_1")],
      ["s2", "   ", pin("acct_gone")],
      ["s6", "Six", null],
      ["s7", null, pin("acct_2")],
      ["bad id!", "Bad", pin("")],
    ]),
    { op: "aggregate", cwd: WS_A },
    { op: "aggregate", cwd: WS_A },
    // A stale cache entry whose mtime and size still match is used as is.
    { op: "patchCache", dir: A_DIR, file: "s7.jsonl", set: { u: 0.5 }, extra: true },
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/s4.jsonl`, "", 1),
    { op: "aggregate", cwd: WS_A },
    { op: "rm", path: `${A_DIR}/s5.jsonl` },
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/${CACHE}`, '{"version":2,"files":{}}'),
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/${CACHE}`, '{"version":3,"files":[1,2]}'),
    { op: "aggregate", cwd: WS_A },
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/${CACHE}`, '{"version":3,"files":5}'),
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/${CACHE}`, '{"version":3,"files":"ab"}'),
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/${CACHE}`, '{"version":3,"files":true}'),
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/${CACHE}`, '{"version":3,"files":1e400}'),
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/${CACHE}`, "null"),
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/${CACHE}`, '{"files":{},"version":3,"x":[1e400,1.0]}'),
    { op: "aggregate", cwd: WS_A },
    W(`${A_DIR}/${CACHE}`, '{"version":3,"files":0}'),
    { op: "aggregate", cwd: WS_A },
    // The modelPricing override.
    settings('{"modelPricing":{"multiplier":0.5}}'),
    { op: "aggregate", cwd: WS_A },
    settings('{"modelPricing":{"overrides":{"claude-golden-tiered":{"input":1,"output":2,"cacheRead":0.5,"cacheWrite":1.5}}}}'),
    { op: "aggregate", cwd: WS_A },
    settings('{"modelPricing":{"rates":{"golden":{"input":2,"cacheWrite5m":3,"cacheWrite1h":6}},"discountMultiplier":0.9}}'),
    { op: "aggregate", cwd: WS_A },
    settings('{"modelPricing":{"overrides":{"x":null}}}'),
    { op: "aggregate", cwd: WS_A },
    settings('{"modelPricing":{"multiplier":1e400}}'),
    { op: "aggregate", cwd: WS_A },
    settings('{"modelPricing":null}'),
    { op: "aggregate", cwd: WS_A },
    settings("null"),
    { op: "aggregate", cwd: WS_A },
    settings("{"),
    { op: "aggregate", cwd: WS_A },
    { op: "rm", path: "home/.claude/settings.json" },
    // Odd numbers and throws.
    W(`${Q_DIR}/q1.jsonl`, lines(
      A({ id: "q1", req: "rq1", model: TIERED, ts: iso(0), usage: U(1, 1, 1, 1) }).replace('"input_tokens":1', '"input_tokens":1e400'),
      A({ id: "q2", req: "rq2", model: FLAT, ts: iso(0), usage: { input_tokens: {}, output_tokens: [1, 2] } }),
      A({ id: "q3", req: "rq3", model: TIERED, ts: iso(-1), usage: U(1, 1, 1, 1) }).replace('"cache_creation_input_tokens":1', '"cache_creation_input_tokens":-1e400'),
    ), -1),
    { op: "aggregate", cwd: WS_Q },
    W(`${Q_DIR}/q2.jsonl`, lines(A({ id: "q4", req: "rq4", model: 5, ts: iso(0), usage: U(1) })), -1),
    { op: "aggregate", cwd: WS_Q },
    W(`${Q_DIR}/q2.jsonl`, lines(A({ id: "q4", req: "rq4", model: { a: 1 }, ts: iso(0), usage: U(1) })), -1),
    { op: "aggregate", cwd: WS_Q },
    W(`${Q_DIR}/q2.jsonl`, lines(A({ id: "q5", req: "rq5", model: TIERED, ts: iso(0), usage: { input_tokens: { toString: 1 } } })), -1),
    { op: "aggregate", cwd: WS_Q },
    { op: "rm", path: `${Q_DIR}/q2.jsonl` },
    { op: "chmod", path: Q_DIR, mode: 0o000 },
    { op: "aggregate", cwd: WS_Q },
    { op: "chmod", path: Q_DIR, mode: 0o755 },
    { op: "aggregate", cwd: WS_Q },
    { op: "aggregate", cwd: "/claudius-golden/missing" },
    W(P("-claudius-golden-file"), "not a dir"),
    { op: "aggregate", cwd: "/claudius-golden/file" },
    W(`${E2_DIR}/${CACHE}`, '{"version":3,"files":"ab"}'),
    { op: "aggregate", cwd: WS_E2 },
    W(`${E2_DIR}/${CACHE}`, '{"version":3,"files":7}'),
    { op: "aggregate", cwd: WS_E2 },
    W(`${E2_DIR}/${CACHE}`, '{"version":3,"files":["x"]}'),
    { op: "aggregate", cwd: WS_E2 },
    // The today / week / month windows.
    { op: "clock", ms: BASE + DAY },
    { op: "aggregate", cwd: WS_A },
    { op: "clock", ms: BASE + 6 * DAY + 11 * 3_600_000 },
    { op: "aggregate", cwd: WS_A },
    { op: "clock", ms: BASE + 40 * DAY },
    { op: "aggregate", cwd: WS_A },
    { op: "clock", ms: BASE },
    // Local day keys.
    { op: "tz", tz: "America/New_York" },
    W(`${T_DIR}/t1.jsonl`, lines(
      A({ id: "t1", req: "rt1", model: TIERED, ts: "2001-02-04T04:59:59.999Z", usage: U(100) }),
      A({ id: "t2", req: "rt2", model: TIERED, ts: "2001-02-04T05:00:00.000Z", usage: U(200) }),
      A({ id: "t3", req: "rt3", model: TIERED, ts: "2001-01-28T05:00:00.000Z", usage: U(300) }),
      A({ id: "t4", req: "rt4", model: TIERED, ts: "2001-01-28T04:00:00.000Z", usage: U(400) }),
    ), -1),
    { op: "aggregate", cwd: WS_T },
    { op: "tz", tz: "UTC" },
    { op: "aggregate", cwd: WS_T },
    { op: "rm", path: `${T_DIR}/${CACHE}` },
    { op: "aggregate", cwd: WS_T },

    // ---- the overview ----
    W(`${H_DIR}/h1.jsonl`, lines(A({ id: "hh1", req: "rhh1", model: TIERED, ts: iso(-2), usage: U(3000, 300) })), -1),
    W(P("-claudius-golden-elsewhere/e1.jsonl"), lines(
      J({ type: "summary", summary: "x" }),
      J({ type: "user", cwd: "", message: {} }),
      J({ type: "user", cwd: "/claudius-golden/elsewhere", message: {} }),
      A({ id: "m1", req: "r1", model: TIERED, ts: iso(-40), usage: U(1000, 500, 2000, 3000) }),
      A({ id: "e1", req: "re1", model: TIERED, ts: iso(-40), usage: U(5000, 50) }),
    ), -1),
    W(P("-claudius-golden-elsewhere/e2.jsonl"), lines(A({ id: "e2", req: "re2", model: C100K, ts: iso(-3), usage: U(7000, 70) })), -1),
    W(P("-claudius-golden-elsewhere/e3.jsonl"), lines(A({ id: "e3", req: "re3", model: FLAT, ts: iso(-3), usage: U(9000, 90) })), -1),
    W(P("-claudius-golden-elsewhere/e4.jsonl"), lines(A({ id: "e4", req: "re4", model: FLAT, ts: iso(-3), usage: U(11000, 90) })), -1),
    sessionRows("/claudius-golden/elsewhere", [
      ["e1", null, pin("acct_2")],
      ["e2", null, pin("acct_removed_0123456789")],
      ["e3", null, pin("_unpinned")],
    ]),
    W(P("renamed-dir/r1.jsonl"), lines(A({ id: "rr1", req: "rrr1", cwd: "/claudius-golden/orig", model: TIERED, ts: iso(-2), usage: U(800) })), -1),
    W(P("no-cwd/n1.jsonl"), lines(J({ type: "user", cwd: 5 }), J({ type: "user", cwd: null }), A({ id: "nn1", req: "rnn1", model: TIERED, ts: iso(-2), usage: U(600) })), -1),
    W(P("123/x.jsonl"), lines(A({ id: "x123", req: "rx123", model: TIERED, ts: iso(-2), usage: U(600) })), -1),
    W(P("free/z.jsonl"), lines(A({ id: "zz", req: "rzz", model: "gpt-free", ts: iso(-2), usage: U(600) })), -1),
    W(P("__proto__/p.jsonl"), lines(A({ id: "pp", req: "rpp", model: FLAT, ts: iso(-2), usage: U(600) })), -1),
    { op: "symlink", path: P("linked"), target: "-claudius-golden-elsewhere" },
    W(P("stray.txt"), "x"),
    { op: "symlink", path: "home/.claude/.claudius/profiles/acct_1/projects", target: "../../../projects" },
    W("home/.claude/.claudius/profiles/acct_2/projects/-claudius-golden-ws-a/p1.jsonl", lines(A({ id: "pa1", req: "rpa1", model: TIERED, ts: iso(-1), usage: U(1200) })), -1),
    W("home/.claude/.claudius/profiles/acct_2/projects/-claudius-golden-only/o1.jsonl", lines(
      J({ cwd: "/claudius-golden/only" }),
      A({ id: "po1", req: "rpo1", model: TIERED, ts: iso(-1), usage: U(1300) }),
    ), -1),
    W("home/.claude/.claudius/profiles/acct_3", "a file"),
    { op: "mkdir", path: "home/.claude/.claudius/profiles/acct_4" },
    { op: "overview" },
    // The cwd a dir was first found under is remembered.
    W(P("-claudius-golden-elsewhere/e1.jsonl"), lines(J({ type: "user", cwd: "/claudius-golden/moved" }), A({ id: "e1", req: "re1", model: TIERED, ts: iso(-40), usage: U(5000, 50) })), 2),
    { op: "overview" },
    settings('{"modelPricing":{"multiplier":0.25}}'),
    { op: "overview" },
    settings('{"modelPricing":{"overrides":{"x":null}}}'),
    { op: "overview" },
    { op: "rm", path: "home/.claude/settings.json" },
    workspaces([ws("wks_a", "Alpha", WS_A), null]),
    { op: "overview" },
    workspaces([ws("wks_a", "Alpha", WS_A), { id: "wks_n", rootPath: 5 }]),
    { op: "overview" },
    workspaces([{ id: 7, name: { n: 1 }, rootPath: WS_A }, "junk", { id: "wks_e", rootPath: "" }, ws("wks_h", null, H_ROOT), ws("wks_dup", "Dup", WS_A)]),
    { op: "overview" },
    { op: "chmod", path: "home/.claude/.claudius/profiles/acct_2/projects/-claudius-golden-only", mode: 0o000 },
    { op: "overview" },
    { op: "chmod", path: "home/.claude/.claudius/profiles/acct_2/projects/-claudius-golden-only", mode: 0o755 },
    { op: "rm", path: "home/.claude/.claudius/accounts.json" },
    { op: "overview" },
    { op: "aggregate", cwd: WS_A },
  ];
  return { now: BASE, prices: J(PRICES), dayKeys, rowUsd, steps: await runCore(steps) };
}

/** [`run`], with `patchCache` turned into the `write` of the patched cache. */
async function runCore(steps) {
  const expanded = [];
  for (const s of steps) {
    if (s.op !== "patchCache") {
      expanded.push(s);
      continue;
    }
    expanded.push({ lazy: s });
  }
  const recorded = [];
  let before = snap();
  for (const e of expanded) {
    let s = e;
    if (e.lazy) {
      const p = join(abs(e.lazy.dir), CACHE);
      const cache = JSON.parse(readFileSync(p, "utf8"));
      const key = join(abs(e.lazy.dir), e.lazy.file);
      for (const row of cache.files[key].rows) Object.assign(row, e.lazy.set);
      if (e.lazy.extra) {
        cache.files[key].foreign = [1, "x"];
        cache.extra = true;
      }
      s = { op: "write", path: `${e.lazy.dir}/${CACHE}`, text: norm(J(cache)) };
    }
    if (!CALLS.has(s.op)) {
      await apply(s);
      recorded.push(s);
      continue;
    }
    const got = await call(s);
    const after = snap();
    recorded.push({ ...s, got, changes: changes(before, after) });
    before = after;
  }
  return recorded;
}

// ------------------------------- routes -------------------------------

async function routes() {
  const RA = "/claudius-golden/route-a";
  const RB = "/claudius-golden/route-b";
  const RC = "/claudius-golden/route-c";
  const RA_DIR = P("-claudius-golden-route-a");
  const RB_DIR = P("-claudius-golden-route-b");
  const q = (cwd) => `cwd=${encodeURIComponent(cwd)}`;
  const G = (path, extra = {}) => ({ op: "request", method: "GET", path, ...extra });
  const jan = (d, h = 12) => new RealDate(Date.UTC(2001, 0, d, h)).toISOString();
  const steps = [
    { op: "write", path: PRICE_CACHE, text: J(PRICES), mtime: MT(0) },
    workspaces([ws("wks_ra", "Route A", RA), ws("wks_rb", "Route B", RB), ws("wks_rc", "Route C", RC)]),
    accounts([profile("acct_r", "Routed")]),
    W(`${RA_DIR}/r1.jsonl`, lines(
      A({ id: "a1", req: "ra1", model: TIERED, ts: jan(5), usage: U(1000, 100, 5000, 2000) }),
      A({ id: "a2", req: "ra2", model: TIERED, ts: jan(6), usage: { input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 } } }),
      A({ id: "a3", req: "ra3", model: "claude-golden-route", ts: jan(6), usage: U(1000000) }),
    ), -300),
    W(`${RA_DIR}/r1/subagents/agent-1.jsonl`, lines(A({ id: "a4", req: "ra4", model: FLAT, ts: jan(7), usage: U(400, 40) })), -300),
    W(`${RA_DIR}/r2.jsonl`, lines(A({ id: "a1", req: "ra1", model: TIERED, ts: jan(5), usage: U(1000, 100, 5000, 2000) }), A({ id: "a5", req: "ra5", model: C100K, ts: jan(9), cost: 0.75, usage: U(1) })), -300),
    sessionRows(RA, [
      ["r1", "Route one", pin("acct_r")],
      ["r2", null, pin("acct_x")],
    ]),
    {
      op: "sql",
      cwd: RA,
      sql: [
        "INSERT INTO loop_ticks (session_id, session_title, tool_use_id, prompt, fired_at, tokens, noop, created_at) VALUES ('r1', 'Loop one', 't1', 'check the build', 1000, 500, 0, 1);",
        "INSERT INTO loop_ticks (session_id, session_title, tool_use_id, prompt, fired_at, tokens, noop, created_at) VALUES ('r1', 'Loop one', 't2', 'check again', 2000, NULL, 0, 1);",
        "INSERT INTO loop_ticks (session_id, session_title, tool_use_id, prompt, fired_at, tokens, noop, created_at) VALUES ('r1', NULL, 't3', 'third', 1500, 251, 1, 1);",
        "INSERT INTO loop_ticks (session_id, session_title, tool_use_id, prompt, fired_at, tokens, noop, created_at) VALUES ('r2', NULL, 't4', 'p2', 3000, 7, 0, 1);",
        "INSERT INTO loop_ticks (session_id, session_title, tool_use_id, prompt, fired_at, tokens, noop, created_at) VALUES ('r3', X'ff00', 't5', X'6869', 'later', 1.5, 0, 1);",
        "INSERT INTO loop_ticks (session_id, session_title, tool_use_id, prompt, fired_at, tokens, noop, created_at) VALUES ('r3', 'T', 't6', 'p3', 4000, 'abc', 0, 1);",
        "INSERT INTO loop_ticks (session_id, session_title, tool_use_id, prompt, fired_at, tokens, noop, created_at) VALUES (X'7334', 7, 't7', 'blob id', 500, 3, 0, 1);",
      ].join("\n"),
    },
    { op: "rawdb", path: `${P("-claudius-golden-route-c")}/.claudius.db`, sql: "CREATE TABLE foo (x);" },
    G("/api/cost"),
    G("/api/cost?cwd="),
    G(`/api/cost?${q("/claudius-golden/untrusted")}`),
    G(`/api/cost?${q(RA)}`),
    G(`/api/cost?${q(RA)}`),
    G(`/api/cost?${q(`${RA}/`)}`),
    G(`/api/cost?${q(RB)}`),
    G(`/api/cost/loops?${q(RA)}`),
    G(`/api/cost/loops?${q("/claudius-golden/untrusted")}`),
    G(`/api/cost/loops?${q(RB)}`),
    G(`/api/cost/loops?${q(RC)}`),
    G("/api/cost/overview"),
    W(`${RB_DIR}/b1.jsonl`, lines(A({ id: "b1", req: "rb1", model: 5, ts: jan(3), usage: U(1) })), -300),
    G(`/api/cost?${q(RB)}`),
    G("/api/cost/overview"),
    { op: "rm", path: `${RB_DIR}/b1.jsonl` },
    settings('{"modelPricing":{"overrides":{"x":null}}}'),
    G(`/api/cost?${q(RA)}`),
    G("/api/cost/overview"),
    settings('{"modelPricing":{"multiplier":0.5}}'),
    G(`/api/cost?${q(RA)}`),
    G("/api/cost/overview"),
    { op: "rm", path: "home/.claude/settings.json" },
    { op: "chmod", path: RB_DIR, mode: 0o000 },
    G(`/api/cost?${q(RB)}`),
    G("/api/cost/overview"),
    { op: "chmod", path: RB_DIR, mode: 0o755 },
    G("/api/cost/overview"),
    { op: "request", method: "POST", path: `/api/cost?${q(RA)}`, notExported: true },
    { op: "request", method: "DELETE", path: `/api/cost/loops?${q(RA)}`, notExported: true },
    { op: "request", method: "PUT", path: "/api/cost/overview", notExported: true },
  ];
  return { now: BASE, steps: await run(steps) };
}

const result = MODE === "core" ? await core() : await routes();
writeFileSync(join(ROOT, "out.json"), J(result));
process.exit(0);
