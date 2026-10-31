#!/usr/bin/env node
// Golden fixture for the workspace store and its routes (D01):
// `lib/server/workspaces-store.ts` behind `app/api/workspaces/route.ts`
// (GET/POST), `reorder`, `[id]` (GET/PATCH/DELETE), `[id]/select` (the
// `claudius.workspace` cookie), `[id]/icon` (GET/POST) and `[id]/roots`
// (`listWorkspaceRoots` from lib/server/workspace-roots.ts).
//
//   node rust/scripts/workspaces-golden.mjs     (node@22)
//
// Re-runs itself twice under `--experimental-transform-types`, each time in
// a fresh temp root with HOME at <root>/home, CLAUDE_CONFIG_DIR at
// <root>/config and the cwd at <root>/project (relative paths resolve
// there), a resolve hook for the `@/` and extensionless imports, `Date`
// pinned to a clock that moves 1_000_003 ms per request, and
// `crypto.randomUUID` replaced by a seeded sequence. Both recordings must
// agree byte for byte. Each route handler runs inside Next's own
// `AppRouteRouteModule.handle`, so `cookies()` reads the request's Cookie
// header and the cookies a handler sets come back as `Set-Cookie` headers,
// exactly as `next start` serves them.
//
// Sections:
// * `steps`: requests and file-system setup, in order. `fs` steps write
//   the world (store files, icons, workspace dirs, settings files,
//   backups). A request records `got`: status, content type, every
//   `Set-Cookie`, `Cache-Control`, `Content-Length` and the body (text for
//   JSON, else hex or sha256), or `threw` (Next's empty 500). After it,
//   `store` is the workspaces.json text when the request changed it
//   (`null`: gone), `baks` the number of `workspaces.json.bak.*` files,
//   `bak` the one this request created, `icons` the icon dir when it
//   changed (name -> hex or sha256) and `claudius` the `.claudius` dir's
//   other names when they changed. `baks` steps dump every backup's text
//   in the store's own sort order. `clock` is the request's pinned time.
// * `base64`: `Buffer.from(s, "base64")` as hex.
// * `bufferFrom`: `Buffer.from(value, "base64")` for odd JSON values (hex,
//   or `threw`).
// * `letters`: `defaultLetterIcon(name, id)`.
// * `resolve`: `path.resolve(p)` from the recorder's cwd (`$UP` is the
//   temp root's parent).
// * `cookies`: the `claudius.workspace` value `cookies()` reads from a
//   Cookie header (`null`: none).
// * `uri`: `encodeURIComponent` / `decodeURIComponent` (`null`: URIError).
//
// The temp root is written "$ROOT". Generated workspace ids appear as
// recorded; the Rust replay maps them to its own ids by creation order.
// Strings stay ASCII here: non-ASCII text is built with String.fromCodePoint
// and lone surrogates with String.fromCharCode or a JSON escape.
//
// Written to rust/crates/claudius-core/tests/fixtures/workspaces_golden.json;
// replayed by crates/claudius-server/tests/workspaces.rs (against the real
// binary) and crates/claudius-core/tests/workspaces_golden.rs.
import { spawnSync } from "node:child_process";
import cryptoModule, { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, register, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/workspaces_golden.json");

if (!process.env.WS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workspaces-golden-")));
    try {
      for (const d of ["home", "config", "project"]) mkdirSync(join(root, d));
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
            WS_GOLDEN_CHILD: root,
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
    if (process.env.WS_GOLDEN_DIFF_DIR) runs.forEach((r, i) => writeFileSync(join(process.env.WS_GOLDEN_DIFF_DIR, `run${i}.json`), r));
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const reqs = fixture.steps.filter((s) => s.op === "req").length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.steps.length} steps (${reqs} requests), ` +
      `${fixture.base64.length} base64, ${fixture.bufferFrom.length} bufferFrom, ${fixture.letters.length} letters, ` +
      `${fixture.resolve.length} resolve, ${fixture.cookies.length} cookies, ${fixture.uri.length} uri (stable)`,
  );
  process.exit(0);
}

const ROOT = process.env.WS_GOLDEN_CHILD;

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
const RealDate = Date;
class PinnedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock);
    else super(...args);
  }
  static now() {
    return clock;
  }
}
globalThis.Date = PinnedDate;

let uuidN = 0;
cryptoModule.randomUUID = () => {
  const h = createHash("sha256").update(`workspaces-golden-${uuidN++}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
syncBuiltinESMExports();

const require = createRequire(join(repo, "package.json"));
const { AppRouteRouteModule } = require("next/dist/server/route-modules/app-route/module.js");
const { NextRequest } = require("next/server.js");
const store = await import(join(repo, "lib/server/workspaces-store.ts"));

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
const api = join(repo, "app/api/workspaces");
const ROUTES = {
  coll: routeModule(await import(join(api, "route.ts")), "/api/workspaces"),
  reorder: routeModule(await import(join(api, "reorder/route.ts")), "/api/workspaces/reorder"),
  one: routeModule(await import(join(api, "[id]/route.ts")), "/api/workspaces/[id]"),
  select: routeModule(await import(join(api, "[id]/select/route.ts")), "/api/workspaces/[id]/select"),
  icon: routeModule(await import(join(api, "[id]/icon/route.ts")), "/api/workspaces/[id]/icon"),
  roots: routeModule(await import(join(api, "[id]/roots/route.ts")), "/api/workspaces/[id]/roots"),
};
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
  const segs = path.split("/").slice(3);
  if (segs.length === 0) return [ROUTES.coll, undefined];
  if (segs.length === 1 && segs[0] === "reorder") return [ROUTES.reorder, undefined];
  const params = { id: decodeURIComponent(segs[0]) };
  if (segs.length === 1) return [ROUTES.one, params];
  return [ROUTES[segs[1]], params];
}

// ------------------------------- helpers -------------------------------

const cp = (...cps) => String.fromCodePoint(...cps);
const unit = (...units) => String.fromCharCode(...units);
/** A JSON `\uXXXX` escape, built so no tool turns it into the character. */
const esc = (hex) => "\\" + "u" + hex;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const real = (s) => s.replaceAll("$ROOT", ROOT);
const fake = (s) => s.replaceAll(ROOT, "$ROOT");
/** Raw bytes with every "$ROOT" (as bytes) replaced by the temp root. */
function realBytes(hex) {
  const buf = Buffer.from(hex, "hex");
  const needle = Buffer.from("$ROOT");
  const parts = [];
  let at = 0;
  for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, at)) {
    parts.push(buf.subarray(at, i), Buffer.from(ROOT));
    at = i + needle.length;
  }
  parts.push(buf.subarray(at));
  return Buffer.concat(parts);
}
const R = "$ROOT";
const CLAUDIUS = `${R}/home/.claude/.claudius`;
const STORE = `${CLAUDIUS}/workspaces.json`;
const ICONS = `${CLAUDIUS}/workspace-icons`;
const W = "/api/workspaces";
const enc = encodeURIComponent;

/** Generated ids, in creation order; `$GEN<n>` in a step is the n-th. */
const GEN = [];
// `$PCTGEN<n>` is the same id with its `_` percent-encoded.
const gen = (s) =>
  typeof s === "string"
    ? s
        .replace(/\$PCTGEN(\d+)/g, (_, n) => GEN[Number(n)].replace("_", "%5F"))
        .replace(/\$GEN(\d+)/g, (_, n) => GEN[Number(n)])
    : s;

// Request bodies too big to keep in the fixture are generated from a spec.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAGIC = { png: PNG, jpg: [0xff, 0xd8, 0xff], webp: [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")] };
function genBytes(spec) {
  const buf = Buffer.alloc(spec.size);
  Buffer.from(MAGIC[spec.magic] ?? []).copy(buf);
  return buf;
}
/** `{"data":"<base64>"}` or `{"data":[0,...]}` for a `gen` spec. */
function genBody(spec) {
  if (spec.kind === "array") return `{"data":[${new Array(spec.size).fill(0).join(",")}]}`;
  return JSON.stringify({ data: genBytes(spec).toString("base64") });
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

// Step constructors. `extra` may carry `cookie` (one header) or `cookies`
// (several Cookie headers, which Node joins with "; ").
const REQ = (method, path, extra = {}) => ({ op: "req", method, path, ...extra });
const G = (path, extra) => REQ("GET", path, extra);
const D = (path, extra) => REQ("DELETE", path, extra);
const J = (method, path, value, extra) => REQ(method, path, { body: JSON.stringify(value), ...extra });
const T = (method, path, text, extra) => REQ(method, path, { body: text, ...extra });
const X = (method, path, hex, extra) => REQ(method, path, { bodyHex: hex, ...extra });
const FS = {
  write: (path, text) => ({ op: "fs", act: "write", path, text }),
  hex: (path, hex) => ({ op: "fs", act: "write", path, hex }),
  json: (path, value, indent) => ({ op: "fs", act: "write", path, text: JSON.stringify(value, null, indent) }),
  mkdir: (path) => ({ op: "fs", act: "mkdir", path }),
  rm: (path) => ({ op: "fs", act: "rm", path }),
  link: (path, target) => ({ op: "fs", act: "symlink", path, target }),
  chmod: (path, mode) => ({ op: "fs", act: "chmod", path, mode }),
};
const BAKS = { op: "baks" };
const ws = (id, extra = {}) => ({
  id,
  name: `ws ${id.slice(-2)}`,
  rootPath: `${R}/p1`,
  icon: { kind: "letter", letter: "W", color: "#000001" },
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});
const f = (n) => `wks_f${String(n).padStart(11, "0")}`;
const seed = (workspaces, extra = {}, indent) => FS.json(STORE, { version: 1, ...extra, workspaces }, indent);

// ------------------------------- the world -------------------------------

const WORLD = [
  FS.mkdir(`${R}/p1`),
  FS.mkdir(`${R}/p2`),
  FS.mkdir(`${R}/p3`),
  FS.mkdir(`${R}/d1`),
  FS.mkdir(`${R}/d2`),
  FS.mkdir(`${R}/project/rel`),
  FS.write(`${R}/file.txt`, "not a dir"),
  FS.link(`${R}/link-dir`, `${R}/p1`),
  FS.link(`${R}/dangling`, `${R}/nowhere`),
  FS.mkdir(`${R}/${cp(0xe9)}t${cp(0xe9)} ${cp(0x1f600)}`),
];

// ------------------------------- steps -------------------------------

const ID0 = "wks_000000000000";
const longSeg = "x".repeat(300);
const nav = (n, len = 8) => Array.from({ length: n }, (_, i) => `n${String(i).padStart(len - 1, "0")}`);
const emoji = cp(0x1f600);
const astral64 = emoji.repeat(32); // 64 UTF-16 units
const PROTO_EXTS = [
  "constructor",
  "__proto__",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
];

const STEPS = [
  ...WORLD,
  // ---- A missing store: nothing is written by reads.
  G(W),
  G(`${W}/${ID0}`),
  G(`${W}/${ID0}/roots`),
  REQ("POST", `${W}/${ID0}/select`),
  D(`${W}/${ID0}`),
  J("PATCH", `${W}/${ID0}`, {}),
  J("PATCH", `${W}/${ID0}`, { navOrder: 5 }),
  J("PATCH", `${W}/${ID0}`, { rootPath: "relative" }),
  J("PATCH", `${W}/${ID0}`, { rootPath: `${R}/p1` }),
  G(`${W}/${ID0}/icon`),
  // An empty reorder on a missing store writes one.
  J("POST", `${W}/reorder`, { ids: [] }),
  FS.rm(STORE),
  J("POST", `${W}/reorder`, { ids: [ID0] }),

  // ---- POST /api/workspaces: validation, before anything is written.
  T("POST", W, ""),
  T("POST", W, "{"),
  T("POST", W, "null"),
  T("POST", W, "[]"),
  T("POST", W, '"name"'),
  T("POST", W, "5"),
  T("POST", W, "true"),
  J("POST", W, {}),
  J("POST", W, { name: null }),
  J("POST", W, { name: "" }),
  J("POST", W, { name: "   " }),
  J("POST", W, { name: `${cp(0xa0, 0xfeff, 0x2028, 0x3000)}\t\n` }),
  J("POST", W, { name: 5 }),
  J("POST", W, { name: true }),
  J("POST", W, { name: false }),
  J("POST", W, { name: [] }),
  J("POST", W, { name: {} }),
  J("POST", W, { name: "A" }),
  J("POST", W, { name: "A", rootPath: null }),
  J("POST", W, { name: "A", rootPath: "" }),
  J("POST", W, { name: "A", rootPath: " \t " }),
  J("POST", W, { name: "A", rootPath: 5 }),
  J("POST", W, { name: "A", rootPath: [] }),
  J("POST", W, { name: "A", rootPath: "relative/x" }),
  J("POST", W, { name: "A", rootPath: "~/x" }),
  J("POST", W, { name: "A", rootPath: `${R}/p1${unit(0)}` }),
  J("POST", W, { name: "A", rootPath: `${R}/nope` }),
  J("POST", W, { name: "A", rootPath: `${R}/file.txt` }),
  J("POST", W, { name: "A", rootPath: `${R}/file.txt/x` }),
  J("POST", W, { name: "A", rootPath: `${R}/dangling` }),
  J("POST", W, { name: "A", rootPath: `${R}/${longSeg}` }),
  J("POST", W, { name: 5, rootPath: `${R}/p1` }),
  J("POST", W, { name: "A", rootPath: { x: 1 } }),
  T("POST", W, '{"name":"A","rootPath":1e400}'),
  X("POST", W, Buffer.from('\uFEFF\uFEFF\uFEFF{"name":"A"}').toString("hex")),

  // ---- Creates (the first makes the store).
  J("POST", W, { name: "Alpha", rootPath: `${R}/p1` }),
  G(W),
  G(`${W}/$GEN0`),
  J("POST", W, { name: "  beta  ", rootPath: ` ${R}/p2/../p2/./ ` }),
  J("POST", W, { name: "gamma", rootPath: `${R}//p3//` }),
  J("POST", W, { name: "link", rootPath: `${R}/link-dir` }),
  J("POST", W, { name: `${cp(0xe9)}t${cp(0xe9)}`, rootPath: `${R}/${cp(0xe9)}t${cp(0xe9)} ${cp(0x1f600)}` }),
  BAKS,

  // ---- GET /api/workspaces/[id] and the active id.
  G(`${W}/missing`),
  G(`${W}/$PCTGEN1`),
  G(W, { cookie: "claudius.workspace=$GEN2" }),
  G(W, { cookie: "claudius.workspace=" }),
  G(W, { cookie: "claudius.workspace=wks_nope00000000" }),
  G(W, { cookie: "a=1;claudius.workspace=$GEN3" }),
  G(W, { cookie: "a=1;   claudius.workspace=$GEN3; b" }),
  G(W, { cookie: "claudius.workspace=$GEN3; claudius.workspace=$GEN4" }),
  G(W, { cookie: "claudius.workspace=$GEN3; claudius.workspace=%E0%A4%A" }),
  G(W, { cookie: "claudius.workspace=%24GEN" }),
  G(W, { cookies: ["claudius.workspace=$GEN1", "x=2"] }),
  G(W, { cookies: ["x=2", "claudius.workspace=$GEN4"] }),
  G(W, { cookie: "x=1,claudius.workspace=$GEN4" }),
  G(W, { cookie: "\tclaudius.workspace=$GEN4" }),

  // ---- select: the cookie, activeId and lastOpenedAt.
  REQ("POST", `${W}/wks_nope00000000/select`),
  REQ("POST", `${W}/$GEN1/select`),
  G(W),
  REQ("POST", `${W}/$GEN2/select`, { cookie: "claudius.customization=cust_1" }),
  REQ("POST", `${W}/$GEN2/select`, { cookie: "claudius.customization=cust_1; claudius.workspace=$GEN1; z=9" }),
  REQ("POST", `${W}/$GEN3/select`, { cookie: "claudius.workspace=$GEN1; claudius.customization=cust_1" }),
  REQ("POST", `${W}/$GEN3/select`, { cookie: "q=1; claudius.workspace=$GEN1" }),
  REQ("POST", `${W}/$GEN3/select`, { cookie: "claudius.customization" }),
  REQ("POST", `${W}/$GEN3/select`, { cookie: "claudius.customization=%E0" }),
  J("POST", `${W}/$GEN3/select`, { ignored: true }),
  G(W),
  G(W, { cookie: "claudius.workspace=$GEN0" }),

  // ---- PATCH.
  T("PATCH", `${W}/$GEN0`, ""),
  T("PATCH", `${W}/$GEN0`, "null"),
  T("PATCH", `${W}/$GEN0`, "[]"),
  T("PATCH", `${W}/$GEN0`, `"a${emoji}"`),
  T("PATCH", `${W}/$GEN0`, "5"),
  J("PATCH", `${W}/$GEN0`, { name: "Alpha 2" }),
  J("PATCH", `${W}/$GEN0`, { navOrder: [] }),
  J("PATCH", `${W}/$GEN0`, { navOrder: ["nav.chat", "nav.git"] }),
  J("PATCH", `${W}/$GEN0`, { navOrder: nav(64) }),
  J("PATCH", `${W}/$GEN0`, { navOrder: nav(65) }),
  J("PATCH", `${W}/$GEN0`, { navOrder: ["a", ""] }),
  J("PATCH", `${W}/$GEN0`, { navOrder: ["x".repeat(64)] }),
  J("PATCH", `${W}/$GEN0`, { navOrder: ["x".repeat(65)] }),
  J("PATCH", `${W}/$GEN0`, { navOrder: [astral64] }),
  J("PATCH", `${W}/$GEN0`, { navOrder: [astral64 + "x"] }),
  T("PATCH", `${W}/$GEN0`, `{"navOrder":["${esc("d800")}"]}`),
  J("PATCH", `${W}/$GEN0`, { navOrder: [1] }),
  J("PATCH", `${W}/$GEN0`, { navOrder: [null] }),
  J("PATCH", `${W}/$GEN0`, { navOrder: null }),
  J("PATCH", `${W}/$GEN0`, { navOrder: "nav.chat" }),
  J("PATCH", `${W}/$GEN0`, { navOrder: { 0: "a" } }),
  J("PATCH", `${W}/$GEN0`, { rootPath: "" }),
  J("PATCH", `${W}/$GEN0`, { rootPath: " /x" }),
  J("PATCH", `${W}/$GEN0`, { rootPath: `${R}/p2${unit(0)}` }),
  J("PATCH", `${W}/$GEN0`, { rootPath: `${R}/nope` }),
  J("PATCH", `${W}/$GEN0`, { rootPath: `${R}/file.txt` }),
  J("PATCH", `${W}/$GEN0`, { rootPath: `${R}/p2/../p2/` }),
  J("PATCH", `${W}/$GEN0`, { rootPath: 5, name: 7 }),
  J("PATCH", `${W}/$GEN0`, { rootPath: null }),
  J("PATCH", `${W}/$GEN0`, { rootPath: `${R}/p1`, navOrder: ["x".repeat(65)] }),
  J("PATCH", `${W}/$GEN0`, {
    id: "forged",
    updatedAt: 1,
    createdAt: 3,
    icon: { kind: "image", ext: "webp" },
    defaults: { model: "x" },
    kind: "customization",
    10: "ten",
    2: "two",
    zzz: [1.5, 1e21, -0],
  }),
  T("PATCH", `${W}/$GEN0`, '{"name":"d1","name":"d2","__proto__":{"p":1}}'),
  T("PATCH", `${W}/$GEN0`, `{"name":"${esc("dfff")}"}`),
  J("PATCH", `${W}/wks_nope00000000`, { name: "x" }),
  J("PATCH", `${W}/wks_nope00000000`, { navOrder: [""] }),
  J("PATCH", `${W}/wks_nope00000000`, { rootPath: `${R}/nope` }),
  G(`${W}/$GEN0`),

  // ---- reorder.
  T("POST", `${W}/reorder`, ""),
  T("POST", `${W}/reorder`, "null"),
  J("POST", `${W}/reorder`, {}),
  J("POST", `${W}/reorder`, { ids: "x" }),
  J("POST", `${W}/reorder`, { ids: {} }),
  J("POST", `${W}/reorder`, { ids: [] }),
  J("POST", `${W}/reorder`, { ids: ["$GEN0"] }),
  J("POST", `${W}/reorder`, { ids: [] }),
  BAKS,
];

// A full permutation and the odd unknown ids, once every create is in.
const REORDER = (n) => {
  const ids = Array.from({ length: n }, (_, i) => `$GEN${i}`);
  return [
    J("POST", `${W}/reorder`, { ids: [...ids].reverse() }),
    J("POST", `${W}/reorder`, { ids: [...ids.slice(1), ids[0]] }),
    J("POST", `${W}/reorder`, { ids: [ids[0], ids[0], ...ids.slice(2)] }),
    ...[5, null, {}, [1, [2, null]], true, 1e21, "", "wks_nope00000000"].map((odd) =>
      J("POST", `${W}/reorder`, { ids: [odd, ...ids.slice(1)] }),
    ),
    T("POST", `${W}/reorder`, `{"ids":["${esc("d800")}"${ids.slice(1).map((i) => `,"${i}"`).join("")}]}`),
    J("POST", `${W}/reorder`, { ids }),
    G(W),
  ];
};

const STEPS2 = [
  // ---- DELETE and the cookie it clears.
  D(`${W}/wks_nope00000000`, { cookie: "claudius.workspace=wks_nope00000000" }),
  J("POST", W, { name: "del5", rootPath: `${R}/p1` }),
  J("POST", W, { name: "del6", rootPath: `${R}/p2` }),
  J("POST", W, { name: "del7", rootPath: `${R}/p3` }),
  FS.mkdir(ICONS),
  FS.hex(`${ICONS}/$GEN5.png`, "89504e47"),
  FS.hex(`${ICONS}/$GEN5.jpg`, "ffd8ff"),
  FS.hex(`${ICONS}/$GEN5.b.png`, "00"),
  FS.hex(`${ICONS}/$GEN5.`, "01"),
  FS.hex(`${ICONS}/$GEN5x.png`, "02"),
  FS.hex(`${ICONS}/x$GEN5.png`, "03"),
  D(`${W}/$GEN5`, { cookie: "claudius.workspace=$GEN5; claudius.customization=c" }),
  G(`${W}/$GEN5`),
  REQ("POST", `${W}/$GEN6/select`),
  D(`${W}/$GEN6`, { cookie: "claudius.workspace=$GEN7" }),
  G(W),
  D(`${W}/$GEN7`, { cookie: "claudius.workspace=%E0; claudius.workspace=$GEN7" }),
  BAKS,
];

// Foreign and odd store files.
const STEPS3 = [
  FS.write(STORE, ""),
  G(W),
  J("POST", W, { name: "x", rootPath: `${R}/p1` }),
  FS.write(STORE, "null"),
  G(W),
  G(`${W}/${ID0}`),
  J("POST", `${W}/reorder`, { ids: [] }),
  ...["[]", "5", '"str"', "true", '{"version":"1","workspaces":[]}', '{"version":2,"workspaces":[],"keep":1}', '{"version":1}', '{"version":1,"workspaces":{}}'].flatMap((text) => [
    FS.write(STORE, text),
    G(W),
    G(`${W}/${ID0}`),
  ]),
  // A newer version is overwritten by a create (after a backup).
  FS.write(STORE, '{"version":2,"workspaces":[{"id":"wks_f00000000001"}],"other":true}'),
  J("POST", W, { name: "over", rootPath: `${R}/p1` }),
  BAKS,
  // version 1.0 and 1e0 are 1.
  FS.write(STORE, `{"version":1.0,"workspaces":[{"id":"${f(1)}","name":"one"}]}`),
  G(W),
  FS.write(STORE, `{"version":1e0,"activeId":"${f(1)}","workspaces":[{"id":"${f(1)}"}]}`),
  G(W),
  // Formatting, key order and number text of a foreign file survive only as values.
  FS.write(
    STORE,
    `{ "workspaces" : [ { "name" : "fmt", "id":"${f(2)}", "10": 1, "2": 2, "createdAt": 1.50, "n": 1e2, "big": 123456789012345678901 } ],\n    "version" : 1, "z": [], "1": "one" }`,
  ),
  G(W),
  REQ("POST", `${W}/${f(2)}/select`),
  BAKS,
  // A BOM and invalid UTF-8.
  FS.hex(STORE, Buffer.from(`\uFEFF{"version":1,"workspaces":[]}`).toString("hex")),
  G(W),
  FS.hex(
    STORE,
    Buffer.concat([Buffer.from(`{"version":1,"workspaces":[{"id":"${f(3)}","name":"x`), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from('y"}]}')]).toString("hex"),
  ),
  G(W),
  REQ("POST", `${W}/${f(3)}/select`),
  // Lone surrogates and escapes survive a rewrite.
  FS.write(
    STORE,
    `{"version":1,"workspaces":[{"id":"${f(4)}","name":"${esc("d83d")}x${esc("DE00")}${esc("d83d")}${esc("de00")}","icon":{"kind":"letter","letter":"${esc("d83d")}","color":"#000003"},"t":"${esc("0000")}${esc("001f")}${esc("007f")}${esc("2028")}${esc("2029")}${esc("FEFF")}/\\/","e":"${cp(0x10ffff)}${cp(0x10f000)}"}]}`,
  ),
  G(W),
  G(`${W}/${f(4)}`),
  REQ("POST", `${W}/${f(4)}/select`),
  J("PATCH", `${W}/${f(4)}`, { navOrder: [unit(0xd83d)] }),
  // Duplicate keys: the last value wins, at the first key's place.
  FS.write(STORE, `{"version":1,"workspaces":[{"id":"${f(5)}","name":"a","id":"${f(5)}","name":"b"}],"version":1}`),
  G(W),
  REQ("POST", `${W}/${f(5)}/select`),
  // Odd entries: primitives, arrays, objects without an id, numeric ids.
  seed([5, "s", [], {}, { id: 7 }, ws(f(6)), { id: f(6), name: "second" }]),
  G(W),
  G(`${W}/7`),
  G(`${W}/${f(6)}`),
  G(`${W}/s`),
  REQ("POST", `${W}/${f(6)}/select`),
  J("PATCH", `${W}/${f(6)}`, { name: "patched" }),
  J("POST", `${W}/reorder`, { ids: [5, "s", [], {}, 7, f(6), f(6)] }),
  J("POST", `${W}/reorder`, { ids: [1, 2, 3, 4, 5, 6, 7] }),
  D(`${W}/${f(6)}`),
  G(W),
  BAKS,
  // activeId forms.
  ...[f(7), 7, 0, "", false, null, {}, [], "missing", 1.0].flatMap((activeId) => [
    seed([ws(f(8)), { id: 7, name: "seven" }, ws(f(7))], { activeId }),
    G(W),
  ]),
  seed([ws(f(8)), ws(f(7))]),
  G(W),
  seed([{ name: "no id" }, ws(f(7))]),
  G(W),
  seed(["s", ws(f(7))]),
  G(W),
  // null entries: `w.id` throws where a search reaches them.
  seed([null, ws(f(9))]),
  G(W),
  G(W, { cookie: `claudius.workspace=${f(9)}` }),
  G(`${W}/${f(9)}`),
  REQ("POST", `${W}/${f(9)}/select`),
  J("PATCH", `${W}/${f(9)}`, { name: "x" }),
  D(`${W}/${f(9)}`),
  J("POST", `${W}/reorder`, { ids: [f(9)] }),
  J("POST", `${W}/reorder`, { ids: [null, f(9)] }),
  G(`${W}/${f(9)}/roots`),
  seed([ws(f(9)), null]),
  G(W),
  G(W, { cookie: `claudius.workspace=${f(9)}` }),
  G(W, { cookie: "claudius.workspace=wks_nope00000000" }),
  G(`${W}/${f(9)}`),
  G(`${W}/nope`),
  REQ("POST", `${W}/${f(9)}/select`),
  J("PATCH", `${W}/${f(9)}`, { name: "y" }),
  G(`${W}/${f(9)}/roots`),
  D(`${W}/${f(9)}`),
  seed([ws(f(9)), null], { activeId: "wks_nope00000000" }),
  G(W),
  seed([null], { activeId: f(9) }),
  G(W),
  // Delete: activeId moves to the next entry's id (or goes).
  seed([ws(f(10)), ws(f(11))], { activeId: f(10) }),
  D(`${W}/${f(10)}`),
  D(`${W}/${f(11)}`),
  seed([ws(f(10)), 5], { activeId: f(10) }),
  D(`${W}/${f(10)}`),
  seed([ws(f(10)), { id: 7 }], { activeId: f(10) }),
  D(`${W}/${f(10)}`),
  seed([ws(f(10)), ws(f(10), { name: "dup" }), ws(f(11))], { activeId: f(11) }),
  D(`${W}/${f(10)}`),
  // A cleared activeId leaves the keys after it in their order.
  FS.write(STORE, `{"version":1,"activeId":"${f(10)}","workspaces":[{"id":"${f(10)}"}],"zz":1}`),
  D(`${W}/${f(10)}`),
  // select keeps activeId's place and lastOpenedAt's place.
  FS.write(STORE, `{"activeId":"${f(12)}","workspaces":[{"lastOpenedAt":1,"id":"${f(12)}"},{"id":"${f(13)}"}],"version":1}`),
  REQ("POST", `${W}/${f(13)}/select`),
  REQ("POST", `${W}/${f(12)}/select`),
  // Unusual ids reach the cookie through encodeURIComponent.
  seed([ws(`a b;c,${cp(0xe9)}/${emoji}=%`), ws("-_.!~*'()"), ws(cp(0xe9))]),
  REQ("POST", `${W}/${enc(`a b;c,${cp(0xe9)}/${emoji}=%`)}/select`),
  REQ("POST", `${W}/${enc("-_.!~*'()")}/select`),
  G(W, { cookie: `claudius.workspace=${cp(0xe9)}` }),
  G(W, { cookie: "claudius.workspace=%C3%A9" }),
  G(W, { cookie: `claudius.workspace=${cp(0xc3, 0xa9)}` }),
  D(`${W}/${enc(cp(0xe9))}`, { cookie: "claudius.workspace=%C3%A9" }),
  // Pretty-printed with 4 spaces and a missing newline: rewritten as TS writes it.
  seed([ws(f(14))], {}, 4),
  REQ("POST", `${W}/${f(14)}/select`),
  BAKS,
];

// Icons.
const pngB64 = b64([...PNG, 0]);
const STEPS4 = [
  FS.rm(ICONS),
  seed([ws(f(20)), ws(f(21))]),
  G(`${W}/${f(20)}/icon`),
  T("POST", `${W}/${f(20)}/icon`, ""),
  T("POST", `${W}/${f(20)}/icon`, "{"),
  T("POST", `${W}/${f(20)}/icon`, "null"),
  T("POST", `${W}/${f(20)}/icon`, "[]"),
  T("POST", `${W}/${f(20)}/icon`, '"str"'),
  J("POST", `${W}/${f(20)}/icon`, {}),
  ...["", 0, false, null].map((data) => J("POST", `${W}/${f(20)}/icon`, { data })),
  ...[5, true, {}, { a: 1 }, { valueOf: "x" }, { valueOf: {} }, { valueOf: 0 }, { type: "Buffer", data: "x" }].map((data) =>
    J("POST", `${W}/${f(20)}/icon`, { data }),
  ),
  ...[{ valueOf: "" }, { length: "9" }, { length: null }, { length: -1 }, { length: 0 }, { length: 2.5, 0: 1, 1: 2, 2: 3 }, [1, 2, 3]].map(
    (data) => J("POST", `${W}/${f(20)}/icon`, { data }),
  ),
  ...["!!!", b64(Buffer.from("hello")), "data:image/png;base64," + pngB64, b64(PNG), b64([0xff, 0xd8, 0xff]), b64(MAGIC.webp)].map((data) =>
    J("POST", `${W}/${f(20)}/icon`, { data }),
  ),
  J("POST", `${W}/${f(20)}/icon`, { data: pngB64 }),
  G(`${W}/${f(20)}/icon`),
  J("POST", `${W}/${f(20)}/icon`, { data: b64([0xff, 0xd8, 0xff, 0x01]) }),
  G(`${W}/${f(20)}/icon`),
  J("POST", `${W}/${f(20)}/icon`, { data: b64([...MAGIC.webp, 7]) }),
  G(`${W}/${f(20)}/icon`),
  J("POST", `${W}/${f(20)}/icon`, { data: b64([0xd2, 0xc9, 0xc6, 0xc6, 1, 2, 3, 4, 0xd7, 0xc5, 0xc2, 0xd0, 9]) }),
  G(`${W}/${f(20)}/icon`),
  J("POST", `${W}/${f(20)}/icon`, { data: b64([...PNG, 1]).replace(/\+/g, "-").replace(/\//g, "_") + "\n" }),
  J("POST", `${W}/${f(20)}/icon`, { data: ` ${pngB64.slice(0, 4)}\n${pngB64.slice(4)} ` }),
  J("POST", `${W}/${f(20)}/icon`, { data: pngB64 + "==QUJD" }),
  J("POST", `${W}/${f(20)}/icon`, { data: [393, 80.5, "78", "0x47", true, null, [26], {}, " 10 "] }),
  J("POST", `${W}/${f(20)}/icon`, { data: { length: 9, 0: 137, 1: 80, 2: 78, 3: 71 } }),
  J("POST", `${W}/${f(20)}/icon`, { data: { length: 4.7, 0: 255, 1: 216, 2: 255, 3: 0 } }),
  J("POST", `${W}/${f(20)}/icon`, { data: { type: "Buffer", data: [255, 216, 255, 1] } }),
  J("POST", `${W}/${f(20)}/icon`, { data: { valueOf: null, length: 4, 0: 255, 1: 216, 2: 255 } }),
  J("POST", `${W}/${f(20)}/icon`, { data: { length: 3000000 } }),
  REQ("POST", `${W}/${f(21)}/icon`, { gen: { kind: "b64", magic: "png", size: 2 * 1024 * 1024 } }),
  G(`${W}/${f(21)}/icon`),
  REQ("POST", `${W}/${f(21)}/icon`, { gen: { kind: "b64", magic: "png", size: 2 * 1024 * 1024 + 1 } }),
  REQ("POST", `${W}/${f(21)}/icon`, { gen: { kind: "array", size: 2 * 1024 * 1024 + 1 } }),
  // No workspace needed; any id names the file.
  J("POST", `${W}/wks_nope00000000/icon`, { data: pngB64 }),
  G(`${W}/wks_nope00000000/icon`),
  J("POST", `${W}/${enc("a/../b")}/icon`, { data: pngB64 }),
  J("POST", `${W}/${enc("sub/x")}/icon`, { data: pngB64 }),
  J("POST", `${W}/${enc(".")}/icon`, { data: pngB64 }),
  // Next decodes `%2F` in the id, and `join` lets `..` climb out of the icon dir.
  J("POST", `${W}/${enc("../escape")}/icon`, { data: pngB64 }),
  // The extension a GET picks: the first matching name in byte order.
  FS.hex(`${ICONS}/${f(22)}.png`, "89504e470d0a1a0a00"),
  FS.hex(`${ICONS}/${f(22)}.jpg`, "ffd8ff00"),
  G(`${W}/${f(22)}/icon`),
  FS.hex(`${ICONS}/${f(23)}.`, "00"),
  G(`${W}/${f(23)}/icon`),
  FS.hex(`${ICONS}/${f(24)}.jpeg`, "0102"),
  G(`${W}/${f(24)}/icon`),
  FS.hex(`${ICONS}/${f(25)}.gif`, "0102"),
  G(`${W}/${f(25)}/icon`),
  FS.hex(`${ICONS}/${f(26)}.PNG`, "0102"),
  G(`${W}/${f(26)}/icon`),
  FS.hex(`${ICONS}/${f(27)}.png.bak`, "0102"),
  G(`${W}/${f(27)}/icon`),
  FS.mkdir(`${ICONS}/${f(28)}.png`),
  G(`${W}/${f(28)}/icon`),
  FS.link(`${ICONS}/${f(29)}.png`, `${R}/file.txt`),
  G(`${W}/${f(29)}/icon`),
  FS.link(`${ICONS}/${f(30)}.png`, `${R}/nowhere`),
  G(`${W}/${f(30)}/icon`),
  FS.hex(`${ICONS}/${f(31)}.webp`, ""),
  G(`${W}/${f(31)}/icon`),
  ...PROTO_EXTS.flatMap((ext, i) => [FS.hex(`${ICONS}/${f(40 + i)}.${ext}`, "00"), G(`${W}/${f(40 + i)}/icon`)]),
  // A POST replaces every file whose name starts with `<id>.`.
  FS.hex(`${ICONS}/${f(20)}.b.webp`, "00"),
  FS.hex(`${ICONS}/${f(20)}x.png`, "00"),
  FS.mkdir(`${ICONS}/${f(20)}.dir`),
  J("POST", `${W}/${f(20)}/icon`, { data: pngB64 }),
  // A delete removes them too.
  D(`${W}/${f(20)}`),
  // The icons dir as a file.
  FS.rm(ICONS),
  FS.write(ICONS, "file"),
  G(`${W}/${f(21)}/icon`),
  J("POST", `${W}/${f(21)}/icon`, { data: pngB64 }),
  D(`${W}/${f(21)}`),
  FS.rm(ICONS),
];

// Roots.
const STEPS5 = [
  seed([
    ws(f(50), { rootPath: `${R}/p1` }),
    ws(f(51), {
      rootPath: `${R}/p1/`,
      defaults: {
        additionalDirectories: [`${R}/d1`, `${R}/d1/`, "  ", 5, null, `${R}/d2`, "rel", ` ${R}/x `, `${R}/p1`, `${R}/d2/../d1`, "", `${R}/${emoji}`],
      },
    }),
    ws(f(52), { rootPath: "", defaults: { additionalDirectories: "ab/" } }),
    ws(f(53), { rootPath: "rel", defaults: null }),
    ws(f(54), { rootPath: "/" }),
    ws(f(55), { rootPath: 5 }),
    { id: f(56) },
    ws(f(57), { defaults: { additionalDirectories: 5 } }),
    ws(f(58), { defaults: { additionalDirectories: {} } }),
    ws(f(59), { defaults: { additionalDirectories: true } }),
    ws(f(60), { defaults: "x" }),
    ws(f(61), { defaults: { additionalDirectories: null } }),
    ws(f(62), { rootPath: `${R}/p2`, defaults: { additionalDirectories: [`${R}/d2`] } }),
    ws(f(63), { rootPath: `${R}/p3${unit(0)}` }),
    ws(f(64), { rootPath: `${R}/p3`, defaults: [] }),
  ]),
  ...[50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 63].map((n) => G(`${W}/${f(n)}/roots`)),
  G(`${W}/wks_nope00000000/roots`),
  // Project settings: `permissions.additionalDirectories`.
  FS.mkdir(`${R}/p2/.claude`),
  FS.json(`${R}/p2/.claude/settings.json`, {
    permissions: { additionalDirectories: [`${R}/d2`, `${R}/d1`, `${R}/p2`, "rel", 7, " ", `${R}/d1/`, `${R}/p3`] },
    other: true,
  }),
  G(`${W}/${f(62)}/roots`),
  ...[
    "{",
    "null",
    "[]",
    '["' + R + '/d1"]',
    "5",
    '"x"',
    "{}",
    '{"permissions":null}',
    '{"permissions":"x"}',
    '{"permissions":["' + R + '/d1"]}',
    '{"permissions":{"additionalDirectories":"' + R + '/d1"}}',
    '{"permissions":{"additionalDirectories":{"0":"' + R + '/d1"}}}',
    `{"permissions":{"additionalDirectories":["${R}/d1"],"additionalDirectories":["${R}/p3"]}}`,
    `{"permissions":{"additionalDirectories":["${esc("d800")}x"]}}`,
  ].flatMap((text) => [FS.write(`${R}/p2/.claude/settings.json`, text), G(`${W}/${f(62)}/roots`)]),
  FS.hex(`${R}/p2/.claude/settings.json`, Buffer.from(`\uFEFF{"permissions":{"additionalDirectories":["${R}/d1"]}}`).toString("hex")),
  G(`${W}/${f(62)}/roots`),
  FS.hex(
    `${R}/p2/.claude/settings.json`,
    Buffer.concat([Buffer.from(`{"permissions":{"additionalDirectories":["${R}/d`), Buffer.from([0xff]), Buffer.from('"]}}')]).toString("hex"),
  ),
  G(`${W}/${f(62)}/roots`),
  FS.rm(`${R}/p2/.claude/settings.json`),
  FS.mkdir(`${R}/p2/.claude/settings.json`),
  G(`${W}/${f(62)}/roots`),
  FS.rm(`${R}/p2/.claude/settings.json`),
  FS.write(`${R}/p3/.claude-not`, "x"),
  FS.mkdir(`${R}/p3/.claude`),
  FS.json(`${R}/p3/.claude/settings.json`, { permissions: { additionalDirectories: [`${R}/d1`] } }),
  G(`${W}/${f(63)}/roots`),
  G(`${W}/${f(64)}/roots`),
  FS.json(`${R}/project/rel/.claude/settings.json`, { permissions: { additionalDirectories: ["../d"] } }),
  FS.mkdir(`${R}/project/rel/.claude`),
  FS.json(`${R}/project/rel/.claude/settings.json`, { permissions: { additionalDirectories: ["../d"] } }),
  G(`${W}/${f(53)}/roots`),
];

// Store-level failures and the backup rotation.
const STEPS6 = [
  // An unreadable store.
  seed([ws(f(70))]),
  FS.chmod(STORE, 0o000),
  G(W),
  G(`${W}/${f(70)}`),
  J("POST", W, { name: "x", rootPath: `${R}/p1` }),
  J("POST", W, { name: "x", rootPath: `${R}/nope` }),
  FS.chmod(STORE, 0o644),
  // The store as a directory.
  FS.rm(STORE),
  FS.mkdir(STORE),
  G(W),
  J("POST", W, { name: "x", rootPath: `${R}/p1` }),
  FS.rm(STORE),
  // The store as a symlink: read through it, replaced by the rename.
  FS.json(`${R}/linked-store.json`, { version: 1, workspaces: [ws(f(71))] }),
  FS.link(STORE, `${R}/linked-store.json`),
  G(W),
  REQ("POST", `${W}/${f(71)}/select`),
  BAKS,
  FS.rm(STORE),
  FS.link(STORE, `${R}/nowhere.json`),
  G(W),
  J("POST", W, { name: "via dangling", rootPath: `${R}/p1` }),
  // Backups: rotation keeps the last 10 in sort order, foreign names included.
  ...[
    "workspaces.json.bak.",
    "workspaces.json.bak.0",
    "workspaces.json.bak.~",
    `workspaces.json.bak.${emoji}`,
    `workspaces.json.bak.${cp(0xff5e)}`,
    "workspaces.json.bak.Z",
    "workspaces.json.bak.2023",
    "workspaces.json.bak.9999",
    "workspaces.json.bakx",
    "workspaces.json.ba",
    "Workspaces.json.bak.x",
  ].map((name, i) => FS.write(`${CLAUDIUS}/${name}`, `seeded ${i}`)),
  FS.mkdir(`${CLAUDIUS}/workspaces.json.bak.1`),
  seed([ws(f(72))]),
  ...Array.from({ length: 4 }, () => REQ("POST", `${W}/${f(72)}/select`)),
  BAKS,
  ...Array.from({ length: 8 }, () => REQ("POST", `${W}/${f(72)}/select`)),
  BAKS,
  // The sort is by UTF-16 units: with nine names above the pair, the astral
  // one goes and U+FF5E stays (by UTF-8 bytes it would be the other way).
  ...[`9999${emoji}`, `9999${cp(0xff5e)}`, "Za", "Zb", "Zc", "Zd", "Ze"].map((s, i) =>
    FS.write(`${CLAUDIUS}/workspaces.json.bak.${s}`, `late ${i}`),
  ),
  REQ("POST", `${W}/${f(72)}/select`),
  BAKS,
  // The .claudius root as a file.
  FS.rm(CLAUDIUS),
  FS.write(CLAUDIUS, "file"),
  G(W),
  J("POST", W, { name: "x", rootPath: `${R}/p1` }),
  G(`${W}/${f(72)}/icon`),
  J("POST", `${W}/${f(72)}/icon`, { data: pngB64 }),
  FS.rm(CLAUDIUS),
  // Back to nothing: the first create makes the tree.
  J("POST", W, { name: "fresh", rootPath: `${R}/p1` }),
  G(W),
];

// Names, icons and defaults from the body, each create in a fresh store.
const CREATES = [
  J("POST", W, { name: `${emoji} rocket`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0xdf)}trasse`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0xfb01)}le`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0x149)}x`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0x1c6)}`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0x131)}stanbul`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0x3c2)}`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `e${cp(0x301)}cole`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0x4e2d, 0x6587)}`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0x85)}nel`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0x180e)}mvs`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0x587)}`, rootPath: `${R}/p1` }),
  J("POST", W, { name: `${cp(0x10428)}deseret`, rootPath: `${R}/p1` }),
  T("POST", W, `{"name":"${esc("d800")}lone","rootPath":"${R}/p1"}`),
  T("POST", W, `{"name":" ${esc("dc00")}${esc("d83d")}","rootPath":"${R}/p1"}`),
  T("POST", W, `{"name":"${esc("0001")}ctl ${esc("2028")}","rootPath":"${R}/p1"}`),
  // Icons and defaults from the body.
  J("POST", W, { name: "img", rootPath: `${R}/p1`, icon: { kind: "image", ext: "png" } }),
  J("POST", W, { name: "zero", rootPath: `${R}/p1`, icon: 0 }),
  J("POST", W, { name: "empty", rootPath: `${R}/p1`, icon: "" }),
  J("POST", W, { name: "false", rootPath: `${R}/p1`, icon: false }),
  J("POST", W, { name: "nullicon", rootPath: `${R}/p1`, icon: null }),
  J("POST", W, { name: "explicit", rootPath: `${R}/p1`, icon: { kind: "letter", letter: "Q", color: "#000002" } }),
  J("POST", W, { name: "defs", rootPath: `${R}/p1`, defaults: { model: "m", permissionMode: "plan", 2: 1, 1: 2, z: null } }),
  J("POST", W, { name: "sdefs", rootPath: `${R}/p1`, defaults: `a${emoji}` }),
  J("POST", W, { name: "adefs", rootPath: `${R}/p1`, defaults: [true, null] }),
  J("POST", W, { name: "ndefs", rootPath: `${R}/p1`, defaults: 5 }),
  J("POST", W, { name: "nulldefs", rootPath: `${R}/p1`, defaults: null }),
  T("POST", W, `{"name":"proto","rootPath":"${R}/p1","defaults":{"__proto__":{"x":1},"constructor":2}}`),
  T(
    "POST",
    W,
    `{"name":"nums","rootPath":"${R}/p1","defaults":{"maxTurns":1.0,"maxBudgetUsd":1e2,"a":1e21,"b":0.1,"c":-0,"d":1e400,"e":12345678901234567890,"f":5e-7}}`,
  ),
  T("POST", W, `{"name":"dup","name":"Dup2","rootPath":"${R}/p1","id":"forged","kind":"customization"}`),
  X("POST", W, Buffer.from(`\uFEFF\uFEFF{"name":"bom","rootPath":"${R}/p1"}`).toString("hex")),
  X(
    "POST",
    W,
    Buffer.concat([Buffer.from('{"name":"bad'), Buffer.from([0xff, 0xc3]), Buffer.from(`utf8","rootPath":"${R}/p1"}`)]).toString(
      "hex",
    ),
  ),
].flatMap((s) => [FS.rm(STORE), s]);

// ------------------------------- run the steps -------------------------------

const CLAUDIUS_REAL = real(CLAUDIUS);
const STORE_REAL = real(STORE);
const ICONS_REAL = real(ICONS);
function readMaybe(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
function bakNames() {
  try {
    return readdirSync(CLAUDIUS_REAL)
      .filter((n) => n.startsWith("workspaces.json.bak."))
      .sort();
  } catch {
    return [];
  }
}
/** A backup: its text (or `dir`), and its name unless it's a stamp the store wrote. */
const STAMPED = /^workspaces\.json\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
function bakEntry(name) {
  const p = join(CLAUDIUS_REAL, name);
  const entry = STAMPED.test(name) ? {} : { name };
  if (lstatSync(p).isDirectory()) entry.dir = true;
  else entry.text = fake(readFileSync(p, "utf8"));
  return entry;
}
function iconListing() {
  try {
    const out = {};
    for (const name of readdirSync(ICONS_REAL)) {
      const p = join(ICONS_REAL, name);
      const st = lstatSync(p);
      if (st.isDirectory()) out[name] = "dir";
      else if (st.isSymbolicLink()) out[name] = "link";
      else {
        const buf = readFileSync(p);
        out[name] = buf.length <= 32 ? buf.toString("hex") : `sha256:${sha(buf)}:${buf.length}`;
      }
    }
    return JSON.stringify(out);
  } catch {
    return "null";
  }
}
function claudiusListing() {
  try {
    return JSON.stringify(
      readdirSync(CLAUDIUS_REAL).filter((n) => !n.startsWith("workspaces.json.bak.") && n !== "workspace-icons"),
    );
  } catch {
    return "null";
  }
}

let last = { store: readMaybe(STORE_REAL), icons: iconListing(), claudius: claudiusListing(), baks: bakNames() };
const steps = [];
let tick = 0;
// A function in the list makes its steps when the run reaches it.
const queue = [...STEPS, () => REORDER(GEN.length), ...STEPS2, ...STEPS3, ...STEPS4, ...STEPS5, ...STEPS6, ...CREATES, G(W), BAKS];
while (queue.length) {
  const raw = queue.shift();
  if (typeof raw === "function") {
    queue.unshift(...raw());
    continue;
  }
  const s = { ...raw };
  for (const k of ["path", "text", "target", "body", "cookie"]) if (k in s) s[k] = gen(s[k]);
  if (s.cookies) s.cookies = s.cookies.map(gen);
  if (s.op === "fs") {
    const p = real(s.path);
    if (s.act === "write") {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s.hex !== undefined ? realBytes(s.hex) : real(s.text));
    } else if (s.act === "mkdir") mkdirSync(p, { recursive: true });
    else if (s.act === "rm") rmSync(p, { recursive: true, force: true });
    else if (s.act === "symlink") symlinkSync(real(s.target), p);
    else if (s.act === "chmod") chmodSync(p, s.mode);
    steps.push(s);
    last = { store: readMaybe(STORE_REAL), icons: iconListing(), claudius: claudiusListing(), baks: bakNames() };
    continue;
  }
  if (s.op === "baks") {
    steps.push({ op: "baks", got: bakNames().map(bakEntry) });
    continue;
  }
  tick += 1;
  clock = BASE + tick * 1_000_003;
  const [mod, params] = routeFor(s.path);
  const headers = {};
  const cookie = s.cookies ? s.cookies.join("; ") : s.cookie;
  if (cookie !== undefined) headers.cookie = real(cookie);
  let body;
  if (s.body !== undefined) body = real(s.body);
  else if (s.bodyHex !== undefined) body = realBytes(s.bodyHex);
  else if (s.gen) body = genBody(s.gen);
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest(`http://localhost${s.path}`, { method: s.method, headers, body });
  let got;
  try {
    const res = await mod.handle(req, context(params));
    const type = res.headers.get("content-type");
    got = { status: res.status, type };
    const cookies = res.headers.getSetCookie();
    if (cookies.length) got.cookies = cookies.map(fake);
    for (const [k, name] of [
      ["cache", "cache-control"],
      ["length", "content-length"],
    ]) {
      const v = res.headers.get(name);
      if (v !== null) got[k] = v;
    }
    const others = [...res.headers.keys()].filter((k) => !["content-type", "set-cookie", "cache-control", "content-length"].includes(k));
    if (others.length) got.headers = others;
    const buf = Buffer.from(await res.arrayBuffer());
    if (type === "application/json") got.body = fake(buf.toString("utf8"));
    else if (buf.length <= 64) got.hex = buf.toString("hex");
    else got.sha256 = `${sha(buf)}:${buf.length}`;
    if (s.method === "POST" && s.path === W && res.status === 201) GEN.push(JSON.parse(buf.toString("utf8")).id);
  } catch (e) {
    got = { threw: fake(e instanceof Error ? e.message : String(e)) };
  }
  const step = { ...s, clock, got };
  const now = { store: readMaybe(STORE_REAL), icons: iconListing(), claudius: claudiusListing(), baks: bakNames() };
  const same = (a, b) => (a === null ? b === null : b !== null && a.equals(b));
  if (!same(last.store, now.store)) step.store = now.store === null ? null : fake(now.store.toString("utf8"));
  step.baks = now.baks.length;
  const fresh = now.baks.filter((n) => !last.baks.includes(n));
  if (fresh.length) step.bak = fresh;
  if (now.icons !== last.icons) step.icons = JSON.parse(now.icons);
  if (now.claudius !== last.claudius) step.claudius = JSON.parse(now.claudius);
  last = now;
  steps.push(step);
}

// ------------------------------- helper sections -------------------------------

// A seeded PRNG for the fuzzed inputs.
let seedState = 0x9e3779b9;
function rand() {
  seedState = (seedState + 0x6d2b79f5) >>> 0;
  let t = seedState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const B64_ALPHABET = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_"];
const B64_NOISE = ["=", "=", " ", "\n", "\t", "\r", ".", "*", ":", ",", unit(0), cp(0xe9), cp(0x100), cp(0x1f600), unit(0xd800), unit(0xdc00), cp(0xff), "%"];
const base64Inputs = [
  "",
  "Q",
  "QQ",
  "QQ=",
  "QQ==",
  "QQ===",
  "QUI",
  "QUJD",
  "QUJDRA",
  "QUJDR",
  "QU JD",
  "QU\nJD",
  "QU*JD",
  "QU=JD",
  "QQ==QUJD",
  "-_-_",
  "+/+/",
  "QUJD====RA",
  "=QUJD",
  "Q=Q=",
  "QUJ=",
  "QUJ==",
  "Q===",
  `${cp(0xe9)}QUJD`,
  "data:image/png;base64,iVBORw0KGgo=",
  `QUJD${unit(0)}RA`,
  "QQ=x",
  "QQ= =",
  "QQ ==",
  "////",
  "AAAA",
  "A",
  "AB",
  "ABC",
  "ABCD=",
  "ABCDE=",
  "ABCDEF=",
  "AB=CD",
  `${unit(0xd83d)}QUJD`,
  `QU${emoji}JD`,
];
for (let i = 0; i < 400; i++) {
  const n = Math.floor(rand() * 24);
  let s = "";
  for (let j = 0; j < n; j++) s += rand() < 0.8 ? pick(B64_ALPHABET) : pick(B64_NOISE);
  base64Inputs.push(s);
}
const base64 = base64Inputs.map((s) => ({ s, hex: Buffer.from(s, "base64").toString("hex") }));

const bufferFromInputs = [
  "QUJD",
  5,
  0,
  true,
  false,
  null,
  [],
  [393, 80.5, "78", "0x47", true, null, [26], {}, " 10 "],
  [[1, 2], [], "1e2", "-1", -0.5, 255.9, 1e21, "abc", [[7]], "", " ", "0b11", "0o7", "1_0", "Infinity", "-Infinity", 256, -256, 1.5e3],
  {},
  { a: 1 },
  { length: 9, 0: 137, 1: 80 },
  { length: "9" },
  { length: null },
  { length: -1 },
  { length: 0 },
  { length: -0.5 },
  { length: 2.5, 0: 1, 1: 2, 2: 3 },
  { length: 3, "00": 1, "1": "2", "2": [3] },
  { type: "Buffer", data: [255, 216, 255, 1] },
  { type: "Buffer", data: "x" },
  { type: "Buffer", data: [1], length: 3 },
  { type: "buffer", data: [1] },
  { valueOf: "x" },
  { valueOf: "" },
  { valueOf: 0 },
  { valueOf: false },
  { valueOf: null, length: 2, 0: 5 },
  { valueOf: {} },
  { valueOf: [] },
  { valueOf: true },
  { length: 4, valueOf: false, 0: 255 },
  { length: 5000, 4999: 1 },
];
const bufferFrom = bufferFromInputs.map((value) => {
  try {
    const buf = Buffer.from(value, "base64");
    return { value, hex: buf.length <= 64 ? buf.toString("hex") : `sha256:${sha(buf)}:${buf.length}` };
  } catch (e) {
    return { value, threw: e.message };
  }
});

const LETTER_NAMES = [
  "Alpha",
  "alpha",
  "1abc",
  "_x",
  "  lead",
  `${cp(0xa0)}nbsp`,
  `${cp(0xfeff)}bom`,
  `${cp(0x85)}nel`,
  `${cp(0x180e)}mvs`,
  `${cp(0x200b)}zwsp`,
  `${cp(0x2028)}ls`,
  `${cp(0x3000)}ideo`,
  `${cp(0xe9)}t${cp(0xe9)}`,
  `${cp(0xdf)}`,
  `${cp(0xfb01)}`,
  `${cp(0xfb03)}`,
  `${cp(0x149)}`,
  `${cp(0x1c5)}`,
  `${cp(0x1c6)}`,
  `${cp(0x131)}`,
  `${cp(0x130)}`,
  `${cp(0x3c2)}`,
  `${cp(0x390)}`,
  `${cp(0x587)}`,
  `${cp(0x1e9e)}`,
  `${cp(0x1f50)}`,
  `${cp(0x1f80)}`,
  `${cp(0x1fb3)}`,
  `${cp(0x10428)}`,
  `${cp(0x1e922)}`,
  emoji,
  `${cp(0x1f1f5, 0x1f1f9)}`,
  `${cp(0x4e2d)}`,
  `${cp(0x3b1)}`,
  `${cp(0x24d0)}`,
  `${cp(0xff41)}`,
  `${cp(0x2c65)}`,
  `${cp(0xa7c0)}`,
  `${cp(0x1c80)}`,
  `${cp(0xab70)}`,
  unit(0xd800),
  unit(0xdc00, 0x41),
  "",
  "   ",
  "\t\n",
];
const LETTER_IDS = ["wks_abc", "wks_000000000000", "", "x", "wks_ffffffffffff", `${cp(0xe9)}${emoji}`, unit(0xd800), "a".repeat(100)];
const letters = [];
for (const name of LETTER_NAMES) for (const id of LETTER_IDS) letters.push({ name, id, icon: store.defaultLetterIcon(name, id) });

const RESOLVE_INPUTS = [
  "",
  ".",
  "..",
  "../..",
  "a",
  "a/b/../c",
  "./a/./b/",
  "/",
  "//",
  "///a//b//",
  "/..",
  "/../a",
  "/a/../..",
  "/a/./b/.",
  "/a/b/..",
  "/a/b/../",
  "/.a/..b/...",
  "/a/.../b",
  " /x ",
  "~",
  `a${unit(0)}b`,
  `/${cp(0xe9)}/${emoji}/..`,
  "\\a\\..\\b",
  "/a//",
  "rel/",
  "./",
  "../x",
];
// Outside the temp root (`../..`) the path is machine-specific: `$UP` is
// the root's parent.
const UP = dirname(ROOT);
const resolveCases = RESOLVE_INPUTS.map((p) => {
  const out = resolve(p);
  return { p, out: out.startsWith(ROOT) ? fake(out) : out.startsWith(UP) ? "$UP" + out.slice(UP.length) : out };
});

const COOKIE_HEADERS = [
  "",
  "claudius.workspace=a",
  "claudius.workspace=",
  "claudius.workspace",
  "claudius.workspace=a=b",
  "claudius.workspace= a ",
  "claudius.workspace=%61",
  "claudius.workspace=%",
  "claudius.workspace=%zz",
  "claudius.workspace=%E0%A4%A",
  "claudius.workspace=%C3%A9",
  "claudius.workspace=%ED%A0%80",
  "claudius.workspace=%F4%90%80%80",
  "claudius.workspace=%C0%AF",
  "claudius.workspace=%25",
  "claudius.workspace=a+b",
  "claudius.workspace=a; claudius.workspace=b",
  "claudius.workspace=a; claudius.workspace=%",
  "claudius.workspace=a;claudius.workspace=b",
  "claudius.workspace=a;  claudius.workspace=b",
  "x=1; claudius.workspace=b",
  "x=1 ; claudius.workspace=b",
  "x=1;\tclaudius.workspace=b",
  "claudius.workspace=a,claudius.workspace=b",
  ";;claudius.workspace=a;;",
  "Claudius.Workspace=a",
  "claudius.workspace =a",
  `claudius.workspace=${cp(0xe9)}`,
  `claudius.workspace=${cp(0xc3, 0xa9)}`,
  'claudius.workspace="a"',
  "=a; claudius.workspace=b",
  "claudius.workspace=%22a%22",
];
const cookies = COOKIE_HEADERS.map((header) => {
  const req = new NextRequest("http://localhost/", { headers: header ? { cookie: header } : {} });
  const v = req.cookies.get("claudius.workspace")?.value;
  return { header, value: v === undefined ? null : v };
});

const URI_INPUTS = [
  "",
  "abc",
  "a b",
  "-_.!~*'()",
  ";/?:@&=+$,#",
  "%",
  "%25",
  "%2",
  "%zz",
  "%41%42",
  "%c3%a9",
  "%C3%A9",
  "%E0%A4%A",
  "%ED%A0%80",
  "%ED%9F%BF",
  "%EE%80%80",
  "%F0%9F%98%80",
  "%F4%8F%BF%BF",
  "%F4%90%80%80",
  "%C0%80",
  "%C1%BF",
  "%E0%80%80",
  "%F0%80%80%80",
  "%80",
  "%BF",
  "%F8%88%80%80%80",
  "%FF",
  cp(0xe9),
  emoji,
  `${cp(0xe9)}%41`,
  "%%41",
  "%4",
  "%u0041",
  "a%2Fb",
  "\u007f",
  unit(0),
  "%00",
];
const uri = URI_INPUTS.map((s) => {
  let dec;
  try {
    dec = decodeURIComponent(s);
  } catch {
    dec = null;
  }
  return { s, enc: encodeURIComponent(s), dec };
});

const fixture = {
  now: BASE,
  step: 1_000_003,
  cwd: "$ROOT/project",
  steps,
  base64,
  bufferFrom,
  letters,
  resolve: resolveCases,
  cookies,
  uri,
};
writeFileSync(join(ROOT, "out.json"), JSON.stringify(fixture));
process.exit(0);
