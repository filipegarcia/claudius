#!/usr/bin/env node
// Golden fixture for D18a: the cost limits store and the LiteLLM price table.
// `lib/server/limits-store.ts` + `app/api/limits/route.ts` and
// `lib/server/litellm-pricing.ts` + `app/api/cost/refresh-prices/route.ts`,
// recorded from the real TS sources:
//
//   node rust/scripts/limits-pricing-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the `@/` and extensionless imports, twice (two temp roots, through
// realpath); both recordings must agree byte for byte. The child's cwd is
// `<root>/project` (the default trusted root), HOME `<root>/home` (whose
// `.claude/.claudius/workspaces.json` registers the fake roots under
// `/claudius-golden/`, never created), CLAUDE_CONFIG_DIR `<root>/config`,
// TZ=UTC, umask 022. `new Date()` and `Date.now()` read a pinned clock,
// 2001-02-03T12:00:00.000Z unless a section moves it. Every outbound `fetch`
// goes to a local raw-TCP fake at `http://127.0.0.1:<port>/<host><path>`, as
// the Rust server's `CLAUDIUS_DEV_FETCH_BASE` sends it. The fake answers each
// request with the next scripted response (`wire`: the exact bytes as UTF-8
// text, or `wireHex`; `close`: hang up) and logs it in `served` as
// `METHOD path`. Nothing reaches the network.
//
// Records:
// - `today`: `todayKey()` per `[tz, ms]` (TZ switched in-process).
// - `protoKeys`: `Object.getOwnPropertyNames(Object.prototype)`.
// - `bundle`: `JSON.stringify(await getPricingTable())` with no cache and the
//   refresh disabled (the bundled snapshot through `normalizeTable`).
// - `tables`: a cache file per case (`cache`: text, hex, a directory or
//   none; `mtimeNs` as stat read it back), then `getPricingStatus()` and
//   `getPricingTable()` after `__resetPricingMemo()`, refresh disabled. A
//   table is `{count, sha256, delta}` (`delta`: up to 30 `[index, key JSON,
//   entry JSON]` that differ from the bundle at that index).
// A string that holds a lone surrogate is written `{u: [code units]}` (a
// `\udXXX` escape is not valid JSON for a strict parser); that is `model` and
// the matched key in `lookups` and `modelPricing`. Elsewhere such a string
// only ever appears inside recorded JSON *text*, which escapes it itself.
//
// - `lookups`: `priceForModel(model, table)` as the key of the entry it
//   returned (`{inherited: typeof}` for an Object.prototype hit, null for
//   undefined) over the bundle (`t: -1`) or `customTables[t]` (JSON text).
// - `costs`: `costFromUsage(pricings[p], usages[u])` as `String(x)` (`-0`
//   for negative zero). In `pricings` / `usages`, NaN, +-Infinity and -0 are
//   the strings "NaN", "Infinity", "-Infinity" and "-0"; a null pricing is
//   undefined.
// - `background`: `getPricingTable()` steps with the refresh on. Each sets
//   things up (`env`, `rm`, `mkdir`, `write`, `mtime`, `reset`), makes
//   `calls` calls (the tables they returned are `got`), waits until the fake
//   has taken every scripted response and then 400 ms more, then
//   records what the fake `served` and the cache file (`cache`: null, "dir"
//   or `{sha256, bytes}`).
// - `limits`: the limits route (`GET` / `PUT` / `POST`) and file setups
//   (`path` under `home/.claude/.claudius`: `text`, `hex`, `mkdir`, `rm`).
//   Each request records `got` (status, content type and body text, or
//   `threw`: Next's empty 500) and `changes` under that dir. The day in
//   override keys is `day`; `$EPROJECT` is `encodeProjectDir(<root>/project)`.
// - `prices`: phases of the refresh-prices route, each from a fresh module
//   state and no cache (`env`: CLAUDIUS_DISABLE_PRICE_REFRESH, absent when
//   unset). Requests carry their `upstream` responses and record `got`,
//   `served` and the cache file (`cache`: null, "dir", `{text}` up to 4 KiB,
//   else `{sha256, bytes}`); setups write or remove the cache and set its
//   mtime (`mtimeNs` read back).
//
// Written to rust/crates/claudius-core/tests/fixtures/limits_pricing_golden.json;
// replayed by crates/claudius-core/tests/limits_pricing_golden.rs (today,
// protoKeys, bundle, tables, lookups, costs, background) and
// crates/claudius-server/tests/limits_prices.rs (limits, prices, against the
// real binary).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/limits_pricing_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.LP_GOLDEN_ROOT) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "limits-pricing-golden-")));
    try {
      mkdirSync(join(root, "project"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: join(root, "project"),
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            TZ: "UTC",
            LP_GOLDEN_ROOT: root,
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
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    if (process.env.LP_GOLDEN_DUMP) {
      runs.forEach((r, i) => writeFileSync(`${process.env.LP_GOLDEN_DUMP}.${i}.json`, r));
    }
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const requests = (steps) => steps.filter((s) => s.op === "request").length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.today.length} day keys, ${fixture.tables.length} tables, ` +
      `${fixture.lookups.length} lookups, ${fixture.costs.length} costs, ${fixture.background.length} background steps, ` +
      `${requests(fixture.limits.steps)} limits requests, ` +
      `${fixture.prices.reduce((n, p) => n + requests(p.steps), 0)} refresh-prices requests`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.LP_GOLDEN_ROOT;
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

// The pinned clock: `new Date()` and `Date.now()` both read it.
const BASE = Date.UTC(2001, 1, 3, 12, 0, 0);
const DAY = "2001-02-03";
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
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Characters by code point (the source stays ASCII). */
const ch = (...cps) => String.fromCodePoint(...cps);
const BS = "\\";
/** The JSON escape text for one UTF-16 unit, e.g. `esc("d800")`. */
const esc = (hex) => `${BS}u${hex}`;
/**
 * A string as the fixture can carry it: itself, or `{u: [code units]}` when
 * it holds a lone surrogate (JSON.stringify would write a `\udXXX` escape
 * that strict parsers, Rust's included, reject).
 */
function str16(s) {
  const u = [];
  let lone = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    u.push(c);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        u.push(next);
        i += 1;
      } else {
        lone = true;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      lone = true;
    }
  }
  return lone ? { u } : s;
}
/** [`str16`] of a recorded lookup result (a key, or an inherited marker). */
const key16 = (k) => (typeof k === "string" ? str16(k) : k);
const hexOf = (s) => Buffer.from(s, "utf8").toString("hex");

// ------------------------------- the fake upstream -------------------------------

let queue = [];
let served = [];
let unscripted = 0;
const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let done = false;
  sock.on("error", () => {});
  sock.on("data", (d) => {
    if (done) return;
    buf = Buffer.concat([buf, d]);
    const at = buf.indexOf("\r\n\r\n");
    if (at < 0) return;
    done = true;
    const [method, path] = buf.subarray(0, at).toString("latin1").split("\r\n")[0].split(" ");
    served.push(`${method} ${path}`);
    const r = queue.shift();
    if (!r) unscripted += 1;
    if (!r || r.close) {
      sock.destroy();
      return;
    }
    sock.end(r.wireHex !== undefined ? Buffer.from(r.wireHex, "hex") : Buffer.from(r.wire, "utf8"));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = new URL(String(url));
  return realFetch(`http://127.0.0.1:${PORT}/${u.host}${u.pathname}${u.search}`, init);
};

const REASON = { 200: "OK", 204: "No Content", 301: "Moved Permanently", 404: "Not Found", 500: "Internal Server Error" };
/** A scripted response: the exact bytes the fake sends. */
function res(status, body = "", opts = {}) {
  const bytes = Buffer.from(body, "utf8");
  const lines = [`HTTP/1.1 ${status} ${opts.reason ?? REASON[status]}`];
  for (const [k, v] of opts.headers ?? [["Content-Type", "application/json"]]) lines.push(`${k}: ${v}`);
  let payload = bytes;
  if (opts.chunked) {
    lines.push("Transfer-Encoding: chunked");
    const parts = [];
    for (let i = 0; i < bytes.length; i += opts.chunked) {
      const c = bytes.subarray(i, i + opts.chunked);
      parts.push(Buffer.from(`${c.length.toString(16)}\r\n`, "latin1"), c, Buffer.from("\r\n", "latin1"));
    }
    parts.push(Buffer.from("0\r\n\r\n", "latin1"));
    payload = Buffer.concat(parts);
  } else {
    lines.push(`Content-Length: ${bytes.length + (opts.cut ?? 0)}`);
  }
  lines.push("Connection: close");
  const all = Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), payload]);
  return Buffer.from(all.toString("utf8"), "utf8").equals(all) ? { wire: all.toString("utf8") } : { wireHex: all.toString("hex") };
}
const CLOSE = { close: true };

// ------------------------------- the TS modules -------------------------------

const mod = (p) => import(pathToFileURL(join(repo, p)).href);
const store = await mod("lib/server/limits-store.ts");
const pricing = await mod("lib/server/litellm-pricing.ts");
const { encodeProjectDir } = await mod("lib/server/auto-memory.ts");
const limitsRoute = await mod("app/api/limits/route.ts");
const pricesRoute = await mod("app/api/cost/refresh-prices/route.ts");
const override = await mod("lib/server/model-pricing-override.ts");

// The fake roots (never created) the limits steps use as trusted cwds.
const ROOTS = {
  a: "/claudius-golden/ws-a",
  b: "/claudius-golden/ws b",
  b2: "/claudius-golden/ws-b",
  c: "/claudius-golden/ws-c",
  u: `/claudius-golden/${ch(0xfc, 0x6e, 0xef, 0x1f600)}`,
  long: `/claudius-golden/${"x".repeat(300)}`,
};
const WORKSPACES = `${J(
  {
    version: 1,
    workspaces: Object.entries(ROOTS).map(([name, rootPath], i) => ({
      id: `wks_golden0000${i + 1}`,
      name,
      rootPath,
      icon: { kind: "letter", letter: "W", color: "#d97757" },
      createdAt: 1,
      updatedAt: 1,
      defaults: { additionalDirectories: [] },
    })),
  },
  null,
  2,
)}\n`;
mkdirSync(join(HOME, ".claude", ".claudius"), { recursive: true });
writeFileSync(join(HOME, ".claude", ".claudius", "workspaces.json"), WORKSPACES);

const EPROJECT = encodeProjectDir(join(ROOT, "project"));
/** Run-specific paths in a message, as placeholders. */
const scrub = (s) => s.split(EPROJECT).join("$EPROJECT").split(ROOT).join("$ROOT");
const threw = (e) => ({ threw: scrub(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) });

// ------------------------------- today -------------------------------

const ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/St_Johns",
  "America/Sao_Paulo",
  "Europe/London",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Australia/Lord_Howe",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
];
const INSTANTS = [
  0,
  -1,
  BASE,
  Date.UTC(2025, 11, 31, 23, 59, 59, 999),
  Date.UTC(2026, 0, 1),
  Date.UTC(2026, 2, 8, 9, 59, 59, 999),
  Date.UTC(2026, 2, 8, 10, 0, 0),
  Date.UTC(2026, 9, 31, 23, 30),
  Date.UTC(2026, 11, 31, 9, 59, 59, 999),
  Date.UTC(2026, 11, 31, 10, 0),
  Date.UTC(2026, 11, 31, 10, 30),
  Date.UTC(1969, 11, 31, 23, 59, 59, 999),
  Date.UTC(2100, 1, 28, 23, 0),
  Date.UTC(999, 5, 15, 12),
  Date.UTC(9999, 11, 30, 0),
];
const today = [];
for (const tz of ZONES) {
  process.env.TZ = tz;
  for (const ms of INSTANTS) {
    clock = ms;
    today.push({ tz, ms, key: store.todayKey() });
  }
}
process.env.TZ = "UTC";
clock = BASE;

// ------------------------------- pricing: tables -------------------------------

const CACHE = join(HOME, ".claude", ".claudius-litellm-prices.json");
const rmCache = () => rmSync(CACHE, { recursive: true, force: true });
/**
 * Set `p`'s mtime (seconds, as utimes takes them; Node reads a negative
 * number as "now", so those go as a Date); the ns stat reads back.
 */
function setMtime(p, sec) {
  const t = sec < 0 ? new RealDate(sec * 1000) : sec;
  utimesSync(p, t, t);
  return String(statSync(p, { bigint: true }).mtimeNs);
}

process.env.CLAUDIUS_DISABLE_PRICE_REFRESH = "1";
pricing.__resetPricingMemo();
rmCache();
const BUNDLE = await pricing.getPricingTable();
const BKEYS = Object.keys(BUNDLE);
function summary(t) {
  const keys = Object.keys(t);
  const delta = [];
  keys.forEach((k, i) => {
    if (delta.length < 30 && (BKEYS[i] !== k || J(t[k]) !== J(BUNDLE[k]))) delta.push([i, J(k), J(t[k])]);
  });
  return { count: keys.length, sha256: sha(J(t)), delta };
}

const ALL_FIELDS_REVERSED = [
  "cache_read_input_token_cost_above_200k_tokens",
  "cache_creation_input_token_cost_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "input_cost_per_token_above_200k_tokens",
  "cache_read_input_token_cost_above_100k_tokens",
  "cache_creation_input_token_cost_above_100k_tokens",
  "output_cost_per_token_above_100k_tokens",
  "input_cost_per_token_above_100k_tokens",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
  "output_cost_per_token",
  "input_cost_per_token",
];
const FRESH = BASE / 1000 - 3600;
const TABLE_CASES = [
  ["missing", null],
  ["empty file", { text: "" }],
  ["not JSON", { text: "nope" }],
  ["a BOM before the JSON", { text: `${ch(0xfeff)}{"claude-x":{"input_cost_per_token":1}}` }],
  ["null", { text: "null" }],
  ["a number", { text: "5" }],
  ["a string", { text: '"claude"' }],
  ["an empty object", { text: "{}" }],
  ["only underscore keys", { text: '{"_meta":{"input_cost_per_token":1},"_x":{"input_cost_per_token":2}}' }],
  [
    "a bundled model replaced in place, its extra fields dropped",
    { text: J({ "claude-opus-4-7": { output_cost_per_token: 5e-5, input_cost_per_token: 1e-5, max_tokens: 1, mode: "chat" } }) },
  ],
  [
    "new models go last, with no Claude filter on read",
    { text: '{"gpt-4o":{"input_cost_per_token":2.5e-6},"zzz-claude":{"input_cost_per_token":1,"output_cost_per_token":"2"}}' },
  ],
  [
    "entries that are skipped",
    {
      text:
        '{"a":null,"b":5,"c":"x","d":[1],"e":{},"f":{"input_cost_per_token":"1"},"g":{"input_cost_per_token":null},' +
        '"h":{"input_cost_per_token":true},"i":{"input_cost_per_token":[1]},"j":{"output_cost_per_token":1}}',
    },
  ],
  [
    "odd numbers",
    {
      text:
        '{"m1":{"input_cost_per_token":1e400,"output_cost_per_token":-1e400,"cache_read_input_token_cost":-0,' +
        '"cache_creation_input_token_cost":1E2,"input_cost_per_token_above_200k_tokens":5e-324,' +
        '"output_cost_per_token_above_100k_tokens":12345678901234567890,"cache_read_input_token_cost_above_100k_tokens":1e21,' +
        '"cache_creation_input_token_cost_above_100k_tokens":0.1}}',
    },
  ],
  ["fields in PRICE_FIELDS order", { text: J({ m2: Object.fromEntries(ALL_FIELDS_REVERSED.map((f, i) => [f, i + 1])) }) }],
  [
    "array-index keys first",
    { text: '{"b-model":{"input_cost_per_token":1},"10":{"input_cost_per_token":2},"2":{"input_cost_per_token":3},"claude-opus-4-7":{"input_cost_per_token":4},"02":{"input_cost_per_token":5}}' },
  ],
  ["an array", { text: '[{"input_cost_per_token":1},null,{"input_cost_per_token":2}]' }],
  [
    "duplicate keys",
    { text: '{"claude-x":{"input_cost_per_token":1},"claude-y":{"input_cost_per_token":2},"claude-x":{"input_cost_per_token":3,"input_cost_per_token":4}}' },
  ],
  ["__proto__", { text: '{"__proto__":{"input_cost_per_token":1},"claude-z":{"input_cost_per_token":2,"__proto__":3}}' }],
  [
    "unicode and lone surrogate keys",
    {
      text: `{"claude-${ch(0xe9)}":{"input_cost_per_token":1},"claude-${esc("d800")}":{"input_cost_per_token":2},"claude-${esc("d83d")}${esc("de00")}":{"input_cost_per_token":3},"${esc("dc00")}":{"input_cost_per_token":4}}`,
    },
  ],
  ["invalid UTF-8", { hex: `${hexOf('{"claude-')}fffe${hexOf('":{"input_cost_per_token":1}}')}` }],
  ["a directory", { dir: true }],
  ["an old mtime", { text: '{"claude-x":{"input_cost_per_token":1}}' }, -315619200.5],
  ["a sub-millisecond mtime", { text: '{"claude-x":{"input_cost_per_token":1}}' }, 1700000000.1234567],
  ["the epoch", { text: '{"claude-x":{"input_cost_per_token":1}}' }, 0],
];
const tables = [];
for (const [name, cache, sec = FRESH] of TABLE_CASES) {
  rmCache();
  let mtimeNs = null;
  if (cache?.dir) mkdirSync(CACHE);
  else if (cache) {
    writeFileSync(CACHE, cache.hex !== undefined ? Buffer.from(cache.hex, "hex") : cache.text);
    mtimeNs = setMtime(CACHE, sec);
  }
  pricing.__resetPricingMemo();
  const status = await pricing.getPricingStatus();
  const table = await pricing.getPricingTable();
  tables.push({ name, cache, mtimeNs, status: J(status), table: summary(table) });
}
rmCache();

// ------------------------------- pricing: lookups -------------------------------

const t = (o) => J(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { input_cost_per_token: v }])));
const CUSTOM = [
  // Haiku 4.5 listed first, as in the bundle.
  t({ "claude-haiku-4-5": 1, "claude-haiku-5-5": 2, "claude-sonnet-4-5": 3 }),
  t({ "x-haiku-y": 1, "claude-haiku-old": 2 }),
  t({ "x-haiku-y": 1, "y-haiku": 2, "sonnet-x": 3 }),
  t({ "claude-opus-4": 1, "claude-opus-4-1": 2, "claude-opus-4-10": 3 }),
  t({ "claude-ab": 1, "claude-cd": 2 }),
  t({ [`claude-${ch(0x130)}`]: 1, "claude-ab": 2 }),
  t({ "claude-ab": 1, [`claude-${ch(0x130)}`]: 2 }),
  t({ "CLAUDE-OPUS-X": 1, "Claude-Sonnet-Y": 2, "x-FABLE": 3 }),
  t({ "anthropic/claude-x": 1, "claude-x": 2 }),
  t({ "": 1, "claude-": 2, opus: 3 }),
  t({ opus: 1, "claude-opus-fable": 2, "fable-x": 3, "claude-fable": 4 }),
  t({ "7": 1, "claude-7": 2, "a/b": 3 }),
  // A lone surrogate in a key matches its half of an astral pair (UTF-16).
  t({ [`claude-${ch(0xd800)}`]: 1, "claude-x": 2 }),
];
const BUNDLE_MODELS = [
  undefined,
  "",
  " ",
  "claude-opus-4-7",
  "claude-opus-4-7-20260101",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4",
  "claude-opus-4-20250514",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-haiku-20240307",
  "claude-3-opus-20240229",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-haiku-5-5",
  "claude-haiku-5-5[1m]",
  "us.anthropic.claude-haiku-5-5-v1:0",
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5-5[1m]",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-fable-5-1-20991231",
  "claude-fable-9",
  "anthropic/claude-opus-4-7",
  "vertex_ai/claude-sonnet-5",
  "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "openrouter/anthropic/claude-3.5-sonnet",
  "a/b/claude-haiku-4-5",
  "claude-opus-4-7/",
  "/claude-opus-4-7",
  "claude-opus-4-7/constructor",
  "anthropic/constructor",
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
  "valueOf",
  "__defineGetter__",
  "toLocaleString",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__lookupSetter__",
  "prototype",
  "  claude-opus-4-7  ",
  "\tclaude-sonnet-4-5\n",
  `${ch(0xa0)}claude-haiku-4-5${ch(0x2028)}`,
  `${ch(0xfeff)}claude-opus-4-1`,
  `claude-opus-4-7${ch(0x85)}`,
  "CLAUDE-OPUS-4-7",
  "Claude-Sonnet-4-5",
  "OPUS",
  "Sonnet",
  "haiku",
  "fable",
  "my-opus-model",
  "sonnet-and-opus",
  "haiku-sonnet",
  "gpt-4o",
  "gemini-1.5-pro",
  "o1",
  "claude",
  "claude-",
  "claude-x",
  `claude-${ch(0x130)}`,
  `claude-opus-4-7${ch(0x1f600)}`,
  `${ch(0x212a)}claude-opus`,
  `CLAUDE-OP${ch(0xdc)}S`,
];
const CUSTOM_MODELS = [
  "claude-haiku-5-5",
  "us.anthropic.claude-haiku-5-5-v1:0",
  "claude-haiku-5-5[1m]",
  "claude-haiku-4-5-20251001",
  "haiku",
  "claude-opus-4-10-x",
  "claude-opus-4-1-x",
  "claude-ab-claude-cd",
  "claude-cd-claude-ab",
  `claude-${ch(0x130)}+claude-ab`,
  `claude-ab+claude-${ch(0x130)}`,
  "claude-opus-x-2",
  "an-opus",
  "the-sonnet",
  "big fable",
  "anthropic/claude-x",
  "vendor/claude-x",
  "claude-x",
  "claude-zzz",
  "opus",
  "OPUS",
  "fable",
  "7",
  "x/7",
  "a/b",
  "claude-7",
  "b/",
  "",
  " ",
  undefined,
  "constructor",
  "__proto__",
  `claude-${ch(0xd800)}`,
  `claude-${ch(0xd800, 0xdc00)}`,
  `claude-${ch(0xdc00)}`,
];
/** What `priceForModel` returned, as the key it came from. */
function keyOf(r, table) {
  if (r === undefined) return null;
  const k = Object.keys(table).find((key) => table[key] === r);
  return k !== undefined ? k : { inherited: typeof r };
}
const lookups = [];
for (const model of BUNDLE_MODELS) {
  lookups.push({
    t: -1,
    model: model === undefined ? null : str16(model),
    got: key16(keyOf(pricing.priceForModel(model, BUNDLE), BUNDLE)),
  });
}
CUSTOM.forEach((text, i) => {
  const table = JSON.parse(text);
  for (const model of CUSTOM_MODELS) {
    lookups.push({
      t: i,
      model: model === undefined ? null : str16(model),
      got: key16(keyOf(pricing.priceForModel(model, table), table)),
    });
  }
});

// ------------------------------- pricing: costs -------------------------------

const enc = (n) =>
  Number.isNaN(n) ? "NaN" : n === Infinity ? "Infinity" : n === -Infinity ? "-Infinity" : Object.is(n, -0) ? "-0" : n;
const encObj = (o) => (o == null ? null : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)])));
const show = (x) => (Object.is(x, -0) ? "-0" : String(x));
const PRICINGS = [
  undefined,
  {},
  {
    input_cost_per_token: 1e-7,
    output_cost_per_token: 5e-7,
    cache_read_input_token_cost: 1e-8,
    cache_creation_input_token_cost: 1.25e-7,
    input_cost_per_token_above_100k_tokens: 5e-7,
    output_cost_per_token_above_100k_tokens: 2.5e-6,
    cache_read_input_token_cost_above_100k_tokens: 5e-8,
    cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
  },
  {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    input_cost_per_token_above_200k_tokens: 6e-6,
    output_cost_per_token_above_200k_tokens: 22.5e-6,
  },
  BUNDLE["claude-opus-4-7"],
  BUNDLE["claude-sonnet-4-5"],
  BUNDLE["claude-3-5-haiku-20241022"],
  Object.fromEntries(ALL_FIELDS_REVERSED.map((f, i) => [f, (i + 1) * 1.1e-7])),
  { input_cost_per_token: Infinity, output_cost_per_token: 1e-6 },
  { input_cost_per_token: 1e-6, cache_creation_input_token_cost: 0, cache_read_input_token_cost: -0 },
  { cache_read_input_token_cost_above_200k_tokens: 1e-6, input_cost_per_token_above_100k_tokens: 2e-6 },
];
const USAGES = [
  { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  { input: 1000, output: 500, cacheRead: 2000, cacheCreation: 300 },
  { input: 1000, output: 500, cacheRead: 2000, cacheCreation: 300, cacheCreation1h: 100 },
  { input: 1000, output: 500, cacheRead: 2000, cacheCreation: 300, cacheCreation1h: 300 },
  { input: 1000, output: 500, cacheRead: 2000, cacheCreation: 300, cacheCreation1h: 1000 },
  { input: 1000, output: 500, cacheRead: 2000, cacheCreation: 300, cacheCreation1h: -5 },
  { input: 1000, output: 500, cacheRead: 2000, cacheCreation: 300, cacheCreation1h: NaN },
  { input: 1000, output: 500, cacheRead: 2000, cacheCreation: 0, cacheCreation1h: 10 },
  { input: 1000, output: 500, cacheRead: 2000, cacheCreation: -0, cacheCreation1h: 0 },
  { input: 100000, output: 1000, cacheRead: 0, cacheCreation: 0 },
  { input: 100001, output: 1000, cacheRead: 0, cacheCreation: 0 },
  { input: 200000, output: 1000, cacheRead: 0, cacheCreation: 0 },
  { input: 200001, output: 1000, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 },
  { input: 50000, output: 7, cacheRead: 50000, cacheCreation: 1, cacheCreation1h: 1 },
  { input: 150000, output: 7, cacheRead: 50000, cacheCreation: 1, cacheCreation1h: 1 },
  { input: 0.1, output: 0.2, cacheRead: 0.3, cacheCreation: 0.7, cacheCreation1h: 0.35 },
  { input: 1e15, output: 3e14, cacheRead: 7e15, cacheCreation: 9e14, cacheCreation1h: 1e14 },
  { input: NaN, output: 1, cacheRead: 1, cacheCreation: 1 },
  { input: Infinity, output: 1, cacheRead: 1, cacheCreation: 1 },
  { input: -0, output: -0, cacheRead: -0, cacheCreation: -0 },
  { input: -100, output: 5, cacheRead: 0, cacheCreation: 0 },
  { input: 123456, output: 7890, cacheRead: 98765, cacheCreation: 4321, cacheCreation1h: 1234 },
];
const costs = [];
PRICINGS.forEach((p, pi) => {
  USAGES.forEach((u, ui) => {
    costs.push({ p: pi, u: ui, got: show(pricing.costFromUsage(p, u)) });
  });
});

// ------------------------------- pricing: background -------------------------------

const cacheState = () => {
  try {
    if (lstatSync(CACHE).isDirectory()) return "dir";
    const b = readFileSync(CACHE);
    return { sha256: sha(b), bytes: b.length };
  } catch {
    return null;
  }
};
const T1 = J({
  "claude-opus-4-7": { input_cost_per_token: 7e-6, output_cost_per_token: 3.5e-5 },
  "claude-bg-1": { input_cost_per_token: 1e-6 },
  "gpt-x": { input_cost_per_token: 1 },
});
const T2 = J({ "claude-bg-2": { input_cost_per_token: 2e-6 }, "12": { input_cost_per_token: 1 } });
const T3 = J({ "claude-bg-3": { input_cost_per_token: 3e-6, cache_read_input_token_cost: 3e-7 } });
const STALE = BASE / 1000 - 25 * 3600;
const BG = [
  { name: "no cache: the bundle, then a refresh fills the cache and the memo", env: null, rm: true, reset: true, upstream: [res(200, T1)] },
  { name: "the memo, its cache fresh: no fetch" },
  { name: "the memo, its cache stale: a refresh that fails changes nothing", mtime: STALE, upstream: [res(404, "")] },
  { name: "no memo, a stale cache: the cache, then a refresh replaces the memo", reset: true, upstream: [res(200, T2)] },
  { name: "the refreshed memo, its cache fresh" },
  { name: "the memo, the cache gone: a refresh", rm: true, upstream: [res(200, T3)] },
  { name: "the memo from that refresh" },
  { name: "no memo, the cache not JSON: the bundle, and a refresh that gets garbage", reset: true, write: "not json", upstream: [res(200, "garbage")] },
  { name: "no memo, a cache 23 h old: no fetch", reset: true, write: T1, mtime: BASE / 1000 - 23 * 3600 },
  { name: "the refresh disabled: no fetch, ever", reset: true, rm: true, env: "1", calls: 2 },
  { name: "two calls back to back: one fetch", reset: true, rm: true, env: null, upstream: [res(200, T1)], calls: 2 },
  { name: "a directory at the cache path: the write fails, the memo stays", reset: true, rm: true, mkdir: true, upstream: [res(200, T3)] },
  { name: "the memo, the directory stale: another refresh that can't write", mtime: STALE, upstream: [res(200, T3)] },
];
const background = [];
for (const step of BG) {
  if (step.env === null) delete process.env.CLAUDIUS_DISABLE_PRICE_REFRESH;
  else if (step.env !== undefined) process.env.CLAUDIUS_DISABLE_PRICE_REFRESH = step.env;
  if (step.rm) rmCache();
  if (step.mkdir) mkdirSync(CACHE);
  if (step.write !== undefined) writeFileSync(CACHE, step.write);
  const rec = { ...step };
  if (step.mtime !== undefined) rec.mtimeNs = setMtime(CACHE, step.mtime);
  if (step.reset) pricing.__resetPricingMemo();
  queue = [...(step.upstream ?? [])];
  served = [];
  const got = [];
  for (let i = 0; i < (step.calls ?? 1); i++) got.push(summary(await pricing.getPricingTable()));
  // The refresh is fire-and-forget: on a loaded machine its request alone
  // can take longer than the settle time, so wait for every scripted
  // response to be taken first (at most 15 s).
  for (let t = 0; queue.length && t < 750; t++) await sleep(20);
  await sleep(400);
  if (queue.length || unscripted) throw new Error(`background "${step.name}": ${queue.length} responses unused, ${unscripted} unscripted`);
  background.push({ ...rec, got, served, cache: cacheState() });
}
rmCache();
pricing.__resetPricingMemo();
delete process.env.CLAUDIUS_DISABLE_PRICE_REFRESH;

// ------------------------------- the limits route -------------------------------

const LIMITS = join(HOME, ".claude", ".claudius", "limits");
const entry = (p) => {
  const st = lstatSync(p);
  if (st.isDirectory()) return { dir: true };
  const b = readFileSync(p);
  const text = b.toString("utf8");
  return Buffer.from(text, "utf8").equals(b) ? { text } : { hex: b.toString("hex") };
};
function snapLimits() {
  let st;
  try {
    st = lstatSync(LIMITS);
  } catch {
    return {};
  }
  if (!st.isDirectory()) return { ".": entry(LIMITS) };
  const snap = { ".": { dir: true } };
  for (const name of readdirSync(LIMITS).sort()) snap[name.split(EPROJECT).join("$EPROJECT")] = entry(join(LIMITS, name));
  return snap;
}
function changes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => J(before[k]) !== J(after[k])).map((k) => [k, after[k] ?? null]);
}

const q = (cwd) => `cwd=${encodeURIComponent(cwd)}`;
const [A, B, B2, C, U, LONG] = [ROOTS.a, ROOTS.b, ROOTS.b2, ROOTS.c, ROOTS.u, ROOTS.long].map(q);
const UNTRUSTED = q("/claudius-golden/untrusted");
const R = (method, query, body, extra = {}) => ({ op: "request", method, query, ...(body !== undefined ? { body } : {}), ...extra });
const RH = (method, query, hex) => ({ op: "request", method, query, bodyHex: hex });
const S = (path, what) => ({ op: "setup", path, ...what });
const fileOf = (root) => `limits/${encodeProjectDir(root)}.json`;
const STATE = (o) => J(o, null, 2);
const O = (sessionId, on) => R("POST", A, J({ action: "override", sessionId, on }));
const OR = (raw) => R("POST", A, `{"action":"override",${raw}}`);
const AUD = (query, event) => R("POST", query, J({ action: "audit", event }));
const OVB = (on) => R("POST", B2, J({ action: "override", sessionId: "s", on }));

const LIMIT_STEPS = [
  // The default cwd (process.cwd()) and the trust check.
  R("GET", ""),
  R("GET", "cwd="),
  R("GET", "cwd=%20%09"),
  R("GET", UNTRUSTED),
  R("GET", q(`${ROOTS.a}/`)),
  R("GET", q(`${ROOTS.a}/../ws-a`)),
  R("GET", `${A}&${UNTRUSTED}`),
  R("GET", `${UNTRUSTED}&${A}`),
  R("GET", "cwd=relative"),
  R("GET", `CWD=${encodeURIComponent(ROOTS.a)}`),
  R("PUT", UNTRUSTED, "{"),
  R("POST", UNTRUSTED, '{"action":"audit"}'),
  // Bodies that don't parse: 400, nothing written.
  R("PUT", A, ""),
  R("PUT", A, "{"),
  R("PUT", A, "nope"),
  R("PUT", A, '{"sessionUsd":1} x'),
  RH("PUT", A, hexOf(`${ch(0xfeff, 0xfeff, 0xfeff)}{"sessionUsd":3}`)),
  R("POST", A, ""),
  R("POST", A, "[1,"),
  // A null body throws before the store is touched.
  R("PUT", A, "null"),
  R("POST", A, "null"),
  // PUT: the non-negative numbers, in the handler's order.
  R("PUT", A, "[]"),
  R("GET", A),
  R("PUT", A, '"str"'),
  R("PUT", A, "5"),
  R("PUT", A, "true"),
  R("PUT", A, "{}"),
  R("PUT", A, J({ projectDailyUsd: 5, sessionUsd: 1.5, maxWebSearches: 50, maxSubagents: 10 })),
  R("GET", A),
  R("PUT", A, J({ maxSubagents: 1, maxWebSearches: 2, sessionUsd: 3, projectDailyUsd: 4, other: 5 })),
  R("PUT", A, '{"projectDailyUsd":0,"sessionUsd":-0,"maxWebSearches":-1,"maxSubagents":-0.5}'),
  R("PUT", A, '{"projectDailyUsd":1e400,"sessionUsd":-1e400,"maxWebSearches":1e21,"maxSubagents":5e-324}'),
  R("GET", A),
  R("PUT", A, J({ projectDailyUsd: "5", sessionUsd: null, maxWebSearches: true, maxSubagents: [1] })),
  R("PUT", A, J({ projectDailyUsd: { valueOf: 5 }, sessionUsd: {} })),
  R("PUT", A, '{"projectDailyUsd":1,"projectDailyUsd":2}'),
  R("PUT", A, '{"sessionUsd":12345678901234567890,"projectDailyUsd":0.1,"maxSubagents":1.0,"maxWebSearches":1E2}'),
  RH("PUT", A, hexOf(`${ch(0xfeff)}{"sessionUsd":1}`)),
  RH("PUT", A, hexOf(`${ch(0xfeff, 0xfeff)}{"sessionUsd":2}`)),
  R("PUT", A, ' \n {"sessionUsd" : 4 } \t'),
  R("PUT", A, `{"sessionUsd":"${esc("d800")}","maxSubagents":3}`),
  RH("PUT", A, `${hexOf('{"x":"')}fffe${hexOf('","sessionUsd":6}')}`),
  // POST: the action.
  R("POST", A, "[]"),
  R("POST", A, "{}"),
  R("POST", A, '"audit"'),
  R("POST", A, '{"action":"AUDIT"}'),
  R("POST", A, '{"action":["audit"]}'),
  R("POST", A, '{"action":"audit"}'),
  AUD(A, { ts: "2026-01-01T00:00:00.000Z", kind: "breach", scope: "session", target: "s1", capUsd: 1, spentUsd: 2 }),
  AUD(A, "str"),
  AUD(A, 5),
  AUD(A, null),
  AUD(A, [1, [2]]),
  R("POST", A, '{"action":"audit","event":{"b":1,"2":2,"a":3,"1":4}}'),
  R(
    "POST",
    A,
    `{"action":"audit","event":{"x":1e400,"y":-0,"z":"${esc("d83d")}","w":"${ch(0xe9, 0x1f600)}${esc("d83d")}${esc("de00")}","n":null,"d":{"deep":[1,{"e":2.50}]}}}`,
  ),
  R("POST", A, '{"action":"audit","event":{"toString":1},"extra":true}'),
  R("GET", A),
  // POST override: `on` by JS truthiness, the id through a template literal.
  O("abc", true),
  O("abc", false),
  O("abc", 1),
  O("abc", 0),
  O("abc", ""),
  O("abc", "x"),
  O("abc", []),
  O("abc", {}),
  OR('"sessionId":"abc"'),
  O("abc", null),
  OR('"sessionId":"abc","on":1e400'),
  OR('"sessionId":"abc","on":-0'),
  O(5, true),
  O(1.5, true),
  O(1e21, true),
  OR('"sessionId":1e400,"on":true'),
  OR('"sessionId":-1e400,"on":true'),
  O(null, true),
  OR('"on":true'),
  O(true, true),
  O([1, [2, 3]], true),
  O([null], true),
  O([], true),
  O({}, true),
  O({ a: 1 }, true),
  OR(`"sessionId":"${esc("d800")}x","on":true`),
  O(ch(0xfc, 0x1f600), true),
  O("", true),
  OR('"sessionId":{"toString":"x"},"on":true'),
  OR('"sessionId":[{"toString":1}],"on":true'),
  OR('"sessionId":[1e400,-1e400,null],"on":true'),
  OR('"sessionId":{"valueOf":1},"on":true'),
  R("GET", A),
  // The audit cap: the newest 200 events.
  S(fileOf(ROOTS.b), { text: STATE({ limits: {}, overrides: {}, audit: [...Array(200).keys()] }) }),
  AUD(B, 200),
  S(fileOf(ROOTS.b), { text: STATE({ limits: {}, overrides: {}, audit: [...Array(250).keys()] }) }),
  AUD(B, "last"),
  // Foreign files. `ws b` and `ws-b` encode to the same file.
  S(fileOf(ROOTS.b), { text: '{"extra":1,"audit":[1],"limits":{"sessionUsd":5},"overrides":{"k":true}}' }),
  R("GET", B2),
  OVB(true),
  S(fileOf(ROOTS.b), { text: '{"limits":null,"overrides":null,"audit":null}' }),
  R("GET", B2),
  R("PUT", B2, '{"sessionUsd":1}'),
  S(fileOf(ROOTS.b), { text: '{"limits":5,"overrides":"ab","audit":"x"}' }),
  R("GET", B2),
  OVB(true),
  S(fileOf(ROOTS.b), { text: '{"limits":"x","overrides":[true,false],"audit":{"0":1}}' }),
  OVB(false),
  S(fileOf(ROOTS.b), { text: '{"limits":1e400,"overrides":1e400,"audit":[1e400,-0,1.0,1e2,-1e400]}' }),
  R("GET", B2),
  OVB(true),
  R("PUT", B2, "{}"),
  S(fileOf(ROOTS.b), { text: '{"overrides":{"b":true,"2":true,"1":true,"__proto__":true}}' }),
  R("GET", B2),
  OVB(true),
  S(fileOf(ROOTS.b), { text: '{"limits":{"__proto__":{"x":1},"sessionUsd":1}}' }),
  R("GET", B2),
  AUD(B2, 1),
  S(fileOf(ROOTS.b), {
    text: `{"audit":["${esc("d800")}","${esc("dc00")}${esc("d800")}"],"overrides":{"${esc("dfff")}":true}}`,
  }),
  R("GET", B2),
  OVB(true),
  S(fileOf(ROOTS.b), { hex: `${hexOf('{"audit":["a')}fffe${hexOf('b"]}')}` }),
  R("GET", B2),
  S(fileOf(ROOTS.b), { text: `${ch(0xfeff)}{}` }),
  R("GET", B2),
  R("PUT", B2, "{}"),
  AUD(B2, 1),
  S(fileOf(ROOTS.b), { text: "null" }),
  R("GET", B2),
  R("PUT", B2, "{}"),
  S(fileOf(ROOTS.b), { text: "5" }),
  R("GET", B2),
  AUD(B2, 1),
  S(fileOf(ROOTS.b), { text: "[]" }),
  R("GET", B2),
  S(fileOf(ROOTS.b), { text: '"str"' }),
  R("GET", B2),
  S(fileOf(ROOTS.b), { text: '{"limits":{}} x' }),
  R("GET", B2),
  S(fileOf(ROOTS.b), { text: "" }),
  R("GET", B2),
  S(fileOf(ROOTS.b), { text: '{"limits":{"a":1,"a":2,"b":{"c":1,"c":[2]}},"overrides":{},"audit":[]}' }),
  R("GET", B2),
  S(fileOf(ROOTS.b), { text: '{"limits":{"n":[1.0,1e2,1E-7,0.1,123456789012345678901234567890,-0.0,1e21,1e-7]}}' }),
  R("GET", B2),
  // A directory where the file goes, then a file where the folder goes.
  S(fileOf(ROOTS.c), { mkdir: true }),
  R("GET", C),
  R("PUT", C, "{}"),
  AUD(C, 1),
  S(fileOf(ROOTS.c), { rm: true }),
  S("limits", { rm: true }),
  S("limits", { text: "not a folder" }),
  R("GET", C),
  R("PUT", C, "{}"),
  R("POST", C, '{"action":"x"}'),
  S("limits", { rm: true }),
  R("PUT", C, '{"sessionUsd":7}'),
  // A unicode root, a root whose file name is too long, the default cwd.
  R("PUT", U, '{"sessionUsd":1}'),
  R("GET", U),
  R("GET", LONG),
  R("PUT", LONG, "{}"),
  R("POST", LONG, '{"action":"x"}'),
  R("PUT", "", '{"sessionUsd":9}'),
  R("POST", "", J({ action: "override", sessionId: "p", on: true })),
  R("GET", ""),
  // Methods the route doesn't export.
  R("DELETE", A, undefined, { notExported: true }),
  R("PATCH", A, "{}", { notExported: true }),
];

const limitSteps = [];
for (const s of LIMIT_STEPS) {
  if (s.op === "setup") {
    const p = join(HOME, ".claude", ".claudius", s.path);
    if (s.rm) rmSync(p, { recursive: true, force: true });
    if (s.mkdir) mkdirSync(p, { recursive: true });
    if (s.text !== undefined || s.hex !== undefined) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s.hex !== undefined ? Buffer.from(s.hex, "hex") : s.text);
    }
    limitSteps.push(s);
    continue;
  }
  const before = snapLimits();
  let got;
  if (s.notExported) got = { status: 405 };
  else {
    const url = `http://localhost/api/limits${s.query ? `?${s.query}` : ""}`;
    const body = s.bodyHex !== undefined ? Buffer.from(s.bodyHex, "hex") : s.body;
    const init = s.method === "GET" ? undefined : { method: s.method, headers: { "content-type": "application/json" }, body };
    try {
      const r = await limitsRoute[s.method](new Request(url, init));
      got = { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
    } catch (e) {
      got = threw(e);
    }
  }
  limitSteps.push({ ...s, got, changes: changes(before, snapLimits()) });
}

// ------------------------------- the refresh-prices route -------------------------------

const bundledRaw = JSON.parse(readFileSync(join(repo, "lib/server/litellm-prices.json"), "utf8"));
const FULL = {
  sample_spec: { input_cost_per_token: 0, max_tokens: "LEGACY" },
  ...bundledRaw,
  "gpt-4o": { input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5, litellm_provider: "openai" },
  "gemini/gemini-1.5-pro": { input_cost_per_token: 1.25e-6 },
  "claude-new-model-9": { output_cost_per_token: 2e-6, input_cost_per_token: 1e-6, cache_read_input_token_cost: 1e-7 },
};
FULL["claude-opus-4-7"] = {
  ...FULL["claude-opus-4-7"],
  input_cost_per_token: 6e-6,
  max_tokens: 128000,
  litellm_provider: "anthropic",
  mode: "chat",
  supports_vision: true,
};
const FULL_TEXT = J(FULL, null, 4);
const S1 = '{"claude-s1":{"input_cost_per_token":1e-6,"output_cost_per_token":2e-6}}';
const S2 = '{"claude-s2":{"input_cost_per_token":3e-6},"other":{"input_cost_per_token":1}}';
const S3 =
  '{"claude-inf":{"input_cost_per_token":1e400,"output_cost_per_token":-1e400},' +
  '"claude-neg-zero":{"input_cost_per_token":-0,"cache_read_input_token_cost":1E2},' +
  '"CLAUDE-UPPER":{"input_cost_per_token":1e21,"output_cost_per_token":"2"},' +
  '"anthropic.claude-v2":{"input_cost_per_token":8e-6,"max_tokens":100000},' +
  '"x-Claude-y":{"input_cost_per_token":5e-324},' +
  '"claude":{"input_cost_per_token":0.1,"input_cost_per_token":0.2},' +
  `"claude-${esc("d800")}":{"input_cost_per_token":1},` +
  `"claude-${ch(0xe9, 0x1f600)}":{"input_cost_per_token":2},` +
  `"claude-${ch(0x130)}":{"input_cost_per_token":2.5},` +
  '"claude-nested":{"input_cost_per_token":3,"cache_creation_input_token_cost":{"a":1}},' +
  '"claude-arr":[1,2],"claude-null":null,"_claude-meta":{"input_cost_per_token":9},' +
  '"123":{"input_cost_per_token":4},"9claude":{"input_cost_per_token":5}}';
const P = (method, upstream = [], extra = {}) => ({ op: "request", method, upstream, ...extra });
const PS = (what) => ({ op: "setup", ...what });
const SOON = BASE / 1000 - 60;
const CX = '{"claude-x":{"input_cost_per_token":1}}';
const PHASES = [
  {
    name: "enabled",
    steps: [
      P("GET"),
      P("POST", [res(200, FULL_TEXT)]),
      PS({ mtime: BASE / 1000 - 7200 }),
      P("GET"),
      P("POST", [res(404, "Not Found", { headers: [["Content-Type", "text/plain"]] })]),
      P("POST", [res(500, '{"error":"boom"}')]),
      P("POST", [res(200, "not json")]),
      P("POST", [res(200, "null")]),
      P("POST", [res(200, "[]")]),
      P("POST", [res(200, '{"gpt-4o":{"input_cost_per_token":1}}')]),
      P("POST", [res(200, '{"claude-x":{"output_cost_per_token":1}}')]),
      P("POST", [res(200, '{"_claude-x":{"input_cost_per_token":1}}')]),
      P("POST", [res(204, "")]),
      P("POST", [CLOSE]),
      P("POST", [res(200, CX, { cut: 50 })]),
      P("POST", [res(200, `${ch(0xfeff)}${S1}`)]),
      P("POST", [res(200, `${ch(0xfeff, 0xfeff)}${S1}`)]),
      P("POST", [res(200, `${ch(0xfeff, 0xfeff, 0xfeff)}${S1}`)]),
      P("POST", [
        res(301, "", { headers: [["Location", "/raw.githubusercontent.com/BerriAI/litellm/main/moved.json"]] }),
        res(200, S2, { headers: [["Content-Type", "text/plain; charset=utf-8"]] }),
      ]),
      P("POST", [res(200, S3, { chunked: 7 })]),
      PS({ mtime: SOON }),
      P("GET"),
      PS({ text: "garbage", mtime: SOON }),
      P("GET"),
      PS({ text: "{}", mtime: SOON }),
      P("GET"),
      PS({ text: '{"gpt-4o":{"input_cost_per_token":1},"_x":{"input_cost_per_token":1}}', mtime: SOON }),
      P("GET"),
      PS({ text: `${ch(0xfeff)}${CX}`, mtime: SOON }),
      P("GET"),
      PS({ text: CX, mtime: 0 }),
      P("GET"),
      PS({ mtime: -315619200.5 }),
      P("GET"),
      PS({ mtime: 1700000000.1234567 }),
      P("GET"),
      PS({ rm: true, mkdir: true }),
      P("GET"),
      P("POST", [res(200, S1)]),
      P("POST", [res(404, "")]),
      PS({ rm: true }),
      P("PUT", [], { notExported: true }),
      P("DELETE", [], { notExported: true }),
    ],
  },
  {
    name: "disabled",
    env: "1",
    steps: [P("GET"), P("POST"), PS({ text: S1, mtime: SOON }), P("GET"), P("POST")],
  },
  {
    name: "only exactly 1 disables",
    env: "true",
    steps: [P("POST", [res(200, S1)]), P("POST", [res(500, "")]), PS({ mtime: SOON }), P("GET")],
  },
];
const cacheFull = () => {
  try {
    if (lstatSync(CACHE).isDirectory()) return "dir";
    const b = readFileSync(CACHE);
    return b.length <= 4096 ? { text: b.toString("utf8") } : { sha256: sha(b), bytes: b.length };
  } catch {
    return null;
  }
};
const prices = [];
for (const ph of PHASES) {
  if (ph.env === undefined) delete process.env.CLAUDIUS_DISABLE_PRICE_REFRESH;
  else process.env.CLAUDIUS_DISABLE_PRICE_REFRESH = ph.env;
  pricing.__resetPricingMemo();
  rmCache();
  const steps = [];
  for (const s of ph.steps) {
    if (s.op === "setup") {
      if (s.rm) rmCache();
      if (s.mkdir) mkdirSync(CACHE, { recursive: true });
      if (s.text !== undefined) writeFileSync(CACHE, s.text);
      const rec = { ...s };
      if (s.mtime !== undefined) rec.mtimeNs = setMtime(CACHE, s.mtime);
      steps.push(rec);
      continue;
    }
    queue = [...s.upstream];
    served = [];
    let got;
    if (s.notExported) got = { status: 405 };
    else {
      try {
        const r = await pricesRoute[s.method]();
        got = { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
      } catch (e) {
        got = threw(e);
      }
    }
    if (queue.length || unscripted) throw new Error(`prices ${ph.name}: ${queue.length} responses unused, ${unscripted} unscripted`);
    steps.push({ ...s, got, served, cache: cacheFull() });
  }
  prices.push({ ...ph, steps });
}

// ------------------------------- the modelPricing override -------------------------------

const MP_TOKENS = [
  { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 },
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6, cacheWrite1h: 400000 },
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6, cacheWrite1h: 1e6 },
  { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300, cacheWrite1h: -5 },
  { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300, cacheWrite1h: NaN },
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
];
const MP_BASE = 2.5;
const RATE = (o) => `{"rates":{"m":${J(o)}}}`;
const MP_CASES = [
  // The settings themselves.
  { s: "null", models: ["m"] },
  { s: "0", models: ["m"] },
  { s: '""', models: ["m"] },
  { s: "5", models: ["m"] },
  { s: "true", models: ["m"] },
  { s: "[]", models: ["m"] },
  { s: "{}", models: ["m"] },
  { s: '{"rates":null}', models: ["m"] },
  { s: '{"rates":{}}', models: ["m"] },
  { s: '{"rates":0}', models: ["m"] },
  // Exact key, then the first lower-cased substring.
  { s: '{"rates":{"opus":{"input":10},"claude-opus-4-8":{"input":9}}}', models: ["claude-opus-4-8", "claude-OPUS-4-8", "CLAUDE-OPUS-4-8", "opus", "claude-sonnet-5"] },
  { s: '{"rates":{"":{"input":1}}}', models: ["m", ""] },
  { s: '{"rates":{"opus":0}}', models: ["opus", "my-opus"] },
  { s: '{"rates":{"opus":false,"sonnet":{"input":4}}}', models: ["opus", "opus-sonnet"] },
  { s: '{"rates":{"b":{"input":1},"2":{"input":2},"1":{"input":3}}}', models: ["x1y", "2", "b", "1"] },
  // Object.prototype shows through, and an own falsy key shadows it.
  { s: '{"rates":{"x":{"input":1}}}', models: ["constructor", "toString", "__proto__", "hasOwnProperty", "prototype"] },
  { s: '{"rates":{"toString":{"input":5}}}', models: ["toString"] },
  { s: '{"rates":{"toString":0}}', models: ["toString"] },
  { s: '{"rates":{"constructor":null}}', models: ["constructor"] },
  // A non-object `rates`.
  // (A model id naming a String / Array prototype method -- `trim`, `map` --
  // is a listed difference, so it isn't recorded here.)
  { s: '{"rates":"abc"}', models: ["0", "2", "length", "a"] },
  { s: '{"rates":[{"input":3},null]}', models: ["0", "1", "length"] },
  { s: '{"rates":{"m":null}}', models: ["m"] },
  // The SDK `overrides` wins, and its one `cacheWrite` prices both lifetimes.
  { s: '{"overrides":{"m":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}}}', models: ["m"] },
  { s: '{"overrides":{"m":{"input":1,"output":1,"cacheRead":1,"cacheWrite":4}},"rates":{"m":{"input":99}}}', models: ["m"] },
  { s: '{"overrides":{},"rates":{"m":{"input":7}}}', models: ["m"] },
  { s: '{"overrides":null,"rates":{"m":{"input":7}}}', models: ["m"] },
  { s: '{"overrides":"ab","rates":{"m":{"input":7}}}', models: ["0", "1", "m"] },
  { s: '{"overrides":[{"input":2,"cacheWrite":4}],"rates":{"m":{"input":7}}}', models: ["0", "m"] },
  { s: '{"overrides":{"m":null}}', models: ["m"] },
  { s: '{"overrides":{"m":5}}', models: ["m"] },
  { s: '{"overrides":{"m":{"cacheWrite":4,"cacheWrite1h":99}}}', models: ["m"] },
  // The 1-hour cache-write slice (CC 2.1.300).
  { s: RATE({ cacheWrite5m: 3.75, cacheWrite1h: 6 }), models: ["m"] },
  { s: RATE({ cacheWrite5m: 3.75 }), models: ["m"] },
  { s: RATE({ cacheWrite1h: 6 }), models: ["m"] },
  { s: RATE({ cacheWrite5m: 3.75, cacheWrite1h: null }), models: ["m"] },
  // Rate field types.
  { s: RATE({ input: "3" }), models: ["m"] },
  { s: RATE({ input: true }), models: ["m"] },
  { s: RATE({ input: [5] }), models: ["m"] },
  { s: RATE({ input: [] }), models: ["m"] },
  { s: RATE({ input: {} }), models: ["m"] },
  { s: RATE({ input: null }), models: ["m"] },
  { s: '{"rates":{"m":{"input":1e400,"output":-1e400}}}', models: ["m"] },
  { s: '{"rates":{"m":{"input":-0,"cacheWrite5m":1E2}}}', models: ["m"] },
  { s: RATE({ input: { toString: 1 } }), models: ["m"] },
  { s: RATE({ input: 3, extra: 9 }), models: ["m"] },
  // The multiplier, its ceiling and the legacy key.
  { s: '{"multiplier":0.5}', models: ["m"] },
  { s: '{"multiplier":1e9}', models: ["m"] },
  { s: '{"multiplier":10}', models: ["m"] },
  { s: '{"multiplier":10.0001}', models: ["m"] },
  { s: '{"multiplier":0}', models: ["m"] },
  { s: '{"multiplier":-1}', models: ["m"] },
  { s: '{"multiplier":1e400}', models: ["m"] },
  { s: '{"multiplier":"2"}', models: ["m"] },
  { s: '{"multiplier":true}', models: ["m"] },
  { s: '{"multiplier":null,"discountMultiplier":0.25}', models: ["m"] },
  { s: '{"multiplier":0,"discountMultiplier":0.5}', models: ["m"] },
  { s: '{"discountMultiplier":2}', models: ["m"] },
  { s: '{"discountMultiplier":null}', models: ["m"] },
  { s: '{"multiplier":null}', models: ["m"] },
  { s: '{"multiplier":[2]}', models: ["m"] },
  { s: '{"multiplier":2,"rates":{"m":{"input":1,"output":1,"cacheRead":1,"cacheWrite5m":1}}}', models: ["m", "other"] },
  { s: '{"multiplier":1e400,"rates":{"m":{"input":1}}}', models: ["m"] },
  // Unicode and lone-surrogate keys.
  { s: `{"rates":{"claude-${esc("d800")}":{"input":2}}}`, models: [`claude-${ch(0xd800)}`, `claude-${ch(0xd800)}-x`, `claude-${ch(0xdc00)}`, `claude-${ch(0xd800, 0xdc00)}`] },
  { s: `{"rates":{"claude-${ch(0x130)}":{"input":2}}}`, models: [`claude-${ch(0x130)}`, `claude-${ch(0x130)}-x`, "claude-i"] },
  { s: '{"rates":{"OPUS":{"input":1}}}', models: ["my-opus", `${ch(0x212a)}-OPUS`, "OPUS"] },
  { s: `{"rates":{"${ch(0x1f600)}":{"input":1}}}`, models: [ch(0x1f600), `a${ch(0x1f600)}b`] },
];

/** Which entry of `rates` this is, by identity. */
function rateKey(rate, rates) {
  if (rate === undefined) return null;
  if (!rates || typeof rates !== "object") {
    const k = Object.keys(Object(rates)).find((key) => rates[key] === rate);
    return k !== undefined ? k : { inherited: typeof rate };
  }
  const k = Object.keys(rates).find((key) => rates[key] === rate);
  return k !== undefined ? k : { inherited: typeof rate };
}

const modelPricing = [];
for (const c of MP_CASES) {
  const p = JSON.parse(c.s);
  for (const model of c.models) {
    for (const t of c.t ?? [0, 1, 2, 3, 4, 5]) {
      const got = {};
      let rates;
      try {
        rates = override.effectiveOverrideRates(p);
        got.rates = rates === undefined ? null : J(rates);
      } catch (e) {
        got.rates = threw(e);
      }
      try {
        const mult = override.effectiveMultiplier(p);
        got.mult = { type: typeof mult, text: mult === undefined ? null : show(mult) };
      } catch (e) {
        got.mult = threw(e);
      }
      if (!("threw" in Object(got.rates))) {
        const rate = override.matchModelPricingRate(model, rates);
        got.match = key16(rateKey(rate, rates));
        got.truthy = Boolean(rate);
        if (rate) {
          try {
            got.cost = show(override.costFromOverrideRate(rate, MP_TOKENS[t]));
          } catch (e) {
            got.cost = threw(e);
          }
        }
      }
      try {
        got.apply = show(override.applyModelPricing(MP_BASE, model, MP_TOKENS[t], p));
      } catch (e) {
        got.apply = threw(e);
      }
      try {
        got.has = override.hasModelPricingOverride(p);
      } catch (e) {
        got.has = threw(e);
      }
      modelPricing.push({ s: c.s, model: str16(model), t, got });
    }
  }
}

const fixture = {
  day: DAY,
  now: BASE,
  workspaces: WORKSPACES,
  upstreamPath: "/raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  today,
  protoKeys: Object.getOwnPropertyNames(Object.prototype),
  bundle: { count: BKEYS.length, text: J(BUNDLE) },
  tables,
  customTables: CUSTOM,
  lookups,
  pricings: PRICINGS.map(encObj),
  usages: USAGES.map(encObj),
  costs,
  background,
  modelPricing: { base: MP_BASE, tokens: MP_TOKENS.map(encObj), cases: modelPricing },
  limits: { steps: limitSteps },
  prices,
};
writeFileSync(join(ROOT, "out.json"), J(fixture));
server.close();
process.exit(0);
