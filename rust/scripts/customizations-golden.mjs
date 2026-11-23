#!/usr/bin/env node
// Golden fixture for the customizations store and its routes (D13):
// `lib/server/customizations-store.ts` behind `app/api/customizations/route.ts`
// (GET; its POST is `bootstrapCustomization`, D14, and isn't recorded),
// `[id]/route.ts` (GET, which adds `srcDir`; PATCH; DELETE),
// `[id]/select/route.ts` (the `claudius.customization` cookie, which also
// clears `claudius.workspace`), `[id]/publishes/route.ts` (GET) and
// `[id]/diff/route.ts` (GET:
// `computeDiff` from lib/server/customization-publish.ts over the hash and
// walk helpers of lib/server/customization-hash.ts).
//
//   node rust/scripts/customizations-golden.mjs     (node@22)
//
// Re-runs itself twice under `--experimental-transform-types`, each time in
// a fresh temp root with HOME at <root>/home, CLAUDE_CONFIG_DIR at
// <root>/config, the cwd at <root>/project and CLAUDIUS_LIVE_SOURCE at
// " <root>/live\t" (getLiveSourceDir trims it), a resolve hook for the `@/`
// and extensionless imports, `Date` pinned to a clock that moves 1_000_003
// ms per request or call, and `crypto.randomUUID` replaced by a seeded
// sequence (sha256 of `customizations-golden-<n>`). Both recordings must
// agree byte for byte. Each route handler runs inside Next's own
// `AppRouteRouteModule.handle`, so `cookies()` reads the request's Cookie
// header and the cookies a handler sets come back as `Set-Cookie` headers.
//
// Sections:
// * `store`: the store's functions called directly, in order (`call`: the
//   TS function name and its JSON arguments; `result` is the JSON text of
//   what it resolved to, `threw` its error's message), with `fs` steps
//   that write the world. After each call, `index` is the index.json text
//   when the call changed it (`null`: gone) and `tree` the `.claudius`
//   listing when that changed. `computeDiff` runs against the live dir.
// * `steps`: requests and `fs` steps, in order. A request records `got`:
//   status, content type, every `Set-Cookie`, the names of any other
//   headers and the body text, or `threw` (Next's empty 500); then `index`
//   and `tree` as above.
// * `sha1`: `createHash("sha1")` of generated buffers (byte i is
//   `(i * 31 + seed) & 255`).
// * `live`: what getLiveSourceDir() returned.
//
// The temp root is written "$ROOT", `process.pid` in a temp name ".$PID.".
// Strings stay ASCII here: non-ASCII text is built with String.fromCodePoint
// and lone surrogates with String.fromCharCode or a JSON escape.
//
// Written to rust/crates/claudius-core/tests/fixtures/customizations_golden.json;
// replayed by crates/claudius-core/tests/customizations_golden.rs (`store`,
// `sha1`) and crates/claudius-server/tests/customizations.rs (`steps`,
// against the real binary).
import { spawnSync } from "node:child_process";
import cryptoModule, { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/customizations_golden.json");

/** chmod every directory under `dir` back to 0755 so it can be removed. */
function unlock(dir) {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return;
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) unlock(join(dir, name));
  } catch {
    // gone or not ours
  }
}

if (!process.env.CUST_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "customizations-golden-")));
    try {
      for (const d of ["home", "config", "project", "live"]) mkdirSync(join(root, d));
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
            CLAUDIUS_LIVE_SOURCE: ` ${join(root, "live")}\t`,
            TZ: "UTC",
            CUST_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      unlock(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    if (process.env.CUST_GOLDEN_DIFF_DIR) runs.forEach((r, i) => writeFileSync(join(process.env.CUST_GOLDEN_DIFF_DIR, `run${i}.json`), r));
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const reqs = fixture.steps.filter((s) => s.op === "req").length;
  const calls = fixture.store.filter((s) => s.op === "call").length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.store.length} store steps (${calls} calls), ` +
      `${fixture.steps.length} steps (${reqs} requests), ${fixture.sha1.length} sha1 (stable)`,
  );
  process.exit(0);
}

const ROOT = process.env.CUST_GOLDEN_CHILD;

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
  const h = createHash("sha256").update(`customizations-golden-${uuidN++}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
syncBuiltinESMExports();
// The DELETE route's `console.warn` when the rm fails.
console.warn = () => {};

const require = createRequire(join(repo, "package.json"));
const { AppRouteRouteModule } = require("next/dist/server/route-modules/app-route/module.js");
const { NextRequest } = require("next/server.js");
const store = await import(join(repo, "lib/server/customizations-store.ts"));
const publish = await import(join(repo, "lib/server/customization-publish.ts"));
const runtimeDir = await import(join(repo, "lib/server/runtime-dir.ts"));

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
const api = join(repo, "app/api/customizations");
const ROUTES = {
  coll: routeModule(await import(join(api, "route.ts")), "/api/customizations"),
  one: routeModule(await import(join(api, "[id]/route.ts")), "/api/customizations/[id]"),
  select: routeModule(await import(join(api, "[id]/select/route.ts")), "/api/customizations/[id]/select"),
  publishes: routeModule(await import(join(api, "[id]/publishes/route.ts")), "/api/customizations/[id]/publishes"),
  diff: routeModule(await import(join(api, "[id]/diff/route.ts")), "/api/customizations/[id]/diff"),
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
  const segs = path.split("?")[0].split("/").slice(3);
  if (segs.length === 0) return [ROUTES.coll, undefined];
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
const fake = (s) => s.replaceAll(ROOT, "$ROOT").replaceAll(`.${process.pid}.`, ".$PID.");
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
/** Generated file contents: byte i is `(i * 31 + seed) & 255`. */
function pattern(len, seed) {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = (i * 31 + seed) & 255;
  return buf;
}

const R = "$ROOT";
const CL = `${R}/home/.claude/.claudius`;
const CR = `${CL}/customizations`;
const IDX = `${CR}/index.json`;
const LIVE = `${R}/live`;
const C = "/api/customizations";
const enc = encodeURIComponent;

// Step constructors. `extra` may carry `cookie` (one Cookie header).
const REQ = (method, path, extra = {}) => ({ op: "req", method, path, ...extra });
const G = (path, extra) => REQ("GET", path, extra);
const D = (path, extra) => REQ("DELETE", path, extra);
const SEL = (id, extra) => REQ("POST", `${C}/${id}/select`, extra);
const J = (method, path, value, extra) => REQ(method, path, { body: JSON.stringify(value), ...extra });
const T = (method, path, text, extra) => REQ(method, path, { body: text, ...extra });
const X = (method, path, hex, extra) => REQ(method, path, { bodyHex: hex, ...extra });
const FS = {
  write: (path, text) => ({ op: "fs", act: "write", path, text }),
  hex: (path, hex) => ({ op: "fs", act: "write", path, hex }),
  // `gen`: `pattern(len, seed)`, too big to keep in the fixture.
  gen: (path, len, seed) => ({ op: "fs", act: "write", path, gen: [len, seed] }),
  json: (path, value, indent) => ({ op: "fs", act: "write", path, text: JSON.stringify(value, null, indent) }),
  mkdir: (path) => ({ op: "fs", act: "mkdir", path }),
  rm: (path) => ({ op: "fs", act: "rm", path }),
  link: (path, target) => ({ op: "fs", act: "symlink", path, target }),
  chmod: (path, mode) => ({ op: "fs", act: "chmod", path, mode }),
};
const CALL = (fn, ...args) => ({ op: "call", fn, args });

const cust = (id, extra = {}) => ({
  id,
  name: `n ${id.slice(-2)}`,
  createdAt: 1,
  updatedAt: 2,
  baseVersion: "0.3.299.0",
  ...extra,
});
const pub = (id, customizationId, extra = {}) => ({
  id,
  customizationId,
  publishedAt: 10,
  revertedAt: null,
  baseHash: "b0",
  files: [{ path: "a.txt", baseHash: null, customHash: "c0" }],
  snapshotDir: `${CR}/${customizationId}/.publishes/${id}/snapshot`,
  ...extra,
});
const seed = (customizations, publishes = [], extra = {}, indent = 2) =>
  FS.json(IDX, { version: 1, customizations, publishes, ...extra }, indent);
const id = (n) => `cust_${String(n).padStart(12, "0")}`;
const src = (n) => `${CR}/${id(n)}/src`;
const emoji = cp(0x1f600);

// ------------------------------- the live tree -------------------------------

const LIVE_WORLD = [
  FS.write(`${LIVE}/same.txt`, "same"),
  FS.write(`${LIVE}/changed.txt`, "old"),
  FS.write(`${LIVE}/sub/deep.txt`, "x"),
  FS.write(`${LIVE}/sub/changed2.txt`, "old2"),
  FS.link(`${LIVE}/link-to-file`, `${LIVE}/same.txt`),
  FS.link(`${LIVE}/dangling`, `${LIVE}/nowhere`),
  FS.mkdir(`${LIVE}/adir`),
  FS.write(`${LIVE}/afile`, "file"),
  FS.link(`${LIVE}/loop`, `${LIVE}/loop`),
  FS.gen(`${LIVE}/big-same.bin`, 200_000, 7),
  FS.gen(`${LIVE}/big-changed.bin`, 200_000, 8),
];

/** A full mirror: identical, changed, added, skipped and odd entries. */
const MIRROR = (n) => [
  FS.write(`${src(n)}/same.txt`, "same"),
  FS.write(`${src(n)}/changed.txt`, "new"),
  FS.write(`${src(n)}/added.txt`, "added"),
  FS.write(`${src(n)}/sub/deep.txt`, "x"),
  FS.write(`${src(n)}/sub/changed2.txt`, "new2"),
  FS.write(`${src(n)}/sub/node_modules`, "a file named node_modules"),
  FS.write(`${src(n)}/sub/.DS_Store`, "skipped"),
  FS.write(`${src(n)}/.DS_Store`, "skipped"),
  FS.write(`${src(n)}/.DS_Store.txt`, "kept"),
  FS.write(`${src(n)}/.DS_Store-dir/.DS_Store/y`, "a dir named .DS_Store is walked"),
  ...["node_modules", ".next", ".git", ".turbo", ".cache", "dist", "out", "playwright-report", "test-results", ".vercel"].map((d) =>
    FS.write(`${src(n)}/${d}/x.txt`, "skipped"),
  ),
  FS.write(`${src(n)}/sub/dist/x.txt`, "skipped at any depth"),
  ...[".next-e2e", "release", "dist-electron", ".claudius", "node_modules2"].map((d) => FS.write(`${src(n)}/${d}/x.txt`, "walked")),
  FS.link(`${src(n)}/lnk`, `${src(n)}/same.txt`),
  FS.link(`${src(n)}/lnkdir`, `${src(n)}/sub`),
  FS.write(`${src(n)}/link-to-file`, "same"),
  FS.write(`${src(n)}/dangling`, "base is a dangling link"),
  FS.write(`${src(n)}/empty`, ""),
  FS.gen(`${src(n)}/big-same.bin`, 200_000, 7),
  FS.gen(`${src(n)}/big-changed.bin`, 200_000, 9),
  FS.gen(`${src(n)}/big-added.bin`, 65_537, 3),
  // Display order: localeCompare over code-unit order.
  ...["Zeta.txt", "alpha.txt", "Beta.txt", "_under.txt", "10.txt", "9.txt", "a b.txt", "a%20b.txt", "~tilde", "-dash", "UPPER", "lower2"].map((f) =>
    FS.write(`${src(n)}/order/${f}`, f),
  ),
  FS.write(`${src(n)}/order/${cp(0xe9)}clair.txt`, "e-acute"),
  FS.write(`${src(n)}/order/${emoji}.txt`, "emoji"),
  FS.write(`${src(n)}/order/${cp(0x4e2d)}.txt`, "cjk"),
  FS.write(`${src(n)}/order/z${cp(0xe4)}.txt`, "a-umlaut"),
];

// ------------------------------- the store section -------------------------------

const CA = "cust_ca0000000001";
const CB = "cust_cb0000000002";
const STORE = [
  ...LIVE_WORLD,
  // ---- A missing store: reads answer empty, writes that find nothing don't write.
  CALL("listCustomizations"),
  CALL("getCustomization", "x"),
  CALL("listPublishes"),
  CALL("listPublishes", "x"),
  CALL("activePublishesOrdered"),
  CALL("deleteCustomizationRecord", "x"),
  CALL("stripCustomizationWorkspaceIds"),
  CALL("markPublishReverted", "pub_x"),
  CALL("updateCustomizationRecord", "x", { name: "a" }),
  CALL("setCustomizationDescription", "x", "d", "h"),
  CALL("setCustomizationDescriptionManual", "x", "d"),
  CALL("upsertCustomizationRecord", { id: CA, name: "upserted first", createdAt: 5, updatedAt: 6, workspaceId: "wks_1" }),
  CALL("computeDiff", "x"),
  // ---- Creates (ids from the seeded UUIDs; the store is made on the way).
  FS.rm(CR),
  CALL("createCustomizationRecord", { name: "First" }),
  CALL("createCustomizationRecord", { name: "  Padded\t" }),
  CALL("createCustomizationRecord", { name: "" }),
  CALL("createCustomizationRecord", { name: "   " }),
  CALL("createCustomizationRecord", { name: `${cp(0xa0, 0xfeff, 0x2028, 0x3000)}` }),
  CALL("createCustomizationRecord", { name: `${cp(0x85)}nel${cp(0x180e)}` }),
  CALL("createCustomizationRecord", { name: `${emoji} rocket` }),
  CALL("createCustomizationRecord", { name: `${unit(0xd800)}lone${unit(0xdc00)}` }),
  CALL("listCustomizations"),
  CALL("newPublishId"),
  CALL("newPublishId"),
  // ---- Publish records.
  seed([cust(CA), cust(CB, { workspaceId: "wks_old" })], []),
  CALL("recordPublish", pub("pub_p1", CA, { publishedAt: 30 })),
  CALL("recordPublish", pub("pub_p2", CA, { publishedAt: 10, revertedAt: 20, revertReason: "user" })),
  CALL("recordPublish", pub("pub_p3", CB, { publishedAt: 20 })),
  CALL("recordPublish", { id: "pub_p4", customizationId: CB, publishedAt: 15 }),
  CALL("listPublishes"),
  CALL("listPublishes", CA),
  CALL("listPublishes", ""),
  CALL("listPublishes", "nope"),
  CALL("activePublishesOrdered"),
  CALL("markPublishReverted", "pub_p1"),
  CALL("markPublishReverted", "pub_p1", "again"),
  CALL("markPublishReverted", "pub_p3", "stale_at_upgrade"),
  CALL("markPublishReverted", "pub_p4"),
  CALL("markPublishReverted", "pub_missing"),
  CALL("activePublishesOrdered"),
  // ---- activePublishesOrdered: `revertedAt == null` and `a.publishedAt - b.publishedAt`.
  seed(
    [cust(CA)],
    [
      pub("pub_s1", CA, { publishedAt: 30 }),
      pub("pub_s2", CA, { publishedAt: "15" }),
      pub("pub_s3", CA, { publishedAt: null }),
      { id: "pub_s4", customizationId: CA },
      pub("pub_s5", CA, { publishedAt: 5, revertedAt: 0 }),
      pub("pub_s6", CA, { publishedAt: 1, revertedAt: false }),
      pub("pub_s7", CA, { publishedAt: [2] }),
      pub("pub_s8", CA, { publishedAt: true }),
      pub("pub_s9", CA, { publishedAt: -1.5 }),
      pub("pub_s10", CA, { publishedAt: "x" }),
      5,
      "str",
      [],
      pub("pub_s11", CA, { publishedAt: 12 }),
    ],
  ),
  CALL("activePublishesOrdered"),
  CALL("listPublishes", CA),
  CALL("markPublishReverted", "pub_s5"),
  CALL("markPublishReverted", "pub_s4", "r"),
  seed([cust(CA)], [pub("pub_t1", CA, { publishedAt: { toString: 1 } }), pub("pub_t2", CA)]),
  CALL("activePublishesOrdered"),
  // A one-element sort never compares, so a lone active key never converts.
  seed([cust(CA)], [pub("pub_t1", CA, { publishedAt: { toString: 1 } }), pub("pub_t2", CA, { revertedAt: 1 })]),
  CALL("activePublishesOrdered"),
  seed([cust(CA)], [pub("pub_t1", CA), null]),
  CALL("activePublishesOrdered"),
  CALL("listPublishes"),
  CALL("listPublishes", CA),
  CALL("markPublishReverted", "pub_t1"),
  CALL("markPublishReverted", "pub_zz"),
  // ---- Updates: `{...c, ...patch, id, updatedAt}`.
  FS.write(
    IDX,
    `{"version":1,"customizations":[{"10":"ten","2":"two","name":"n","id":"${CA}","createdAt":1.50,"n":1e2,"big":123456789012345678901,"neg":-0},{"id":"${CB}","updatedAt":2}],"publishes":[],"zz":true}`,
  ),
  CALL("updateCustomizationRecord", CA, { name: "Renamed" }),
  CALL("updateCustomizationRecord", CA, { baseVersion: "0.4.0.1" }),
  CALL("updateCustomizationRecord", CA, {}),
  CALL("updateCustomizationRecord", CA, { name: "x", id: "forged", updatedAt: 1, extra: [1.5, 1e21], 7: "seven" }),
  CALL("updateCustomizationRecord", CB, "ab"),
  CALL("updateCustomizationRecord", CB, [9]),
  CALL("updateCustomizationRecord", CB, null),
  CALL("updateCustomizationRecord", "nope", { name: "x" }),
  // ---- Descriptions.
  CALL("setCustomizationDescription", CA, "Does things", "hash1"),
  CALL("setCustomizationDescription", CA, "", ""),
  CALL("setCustomizationDescriptionManual", CA, "  Manual text \n"),
  CALL("setCustomizationDescription", CB, `${emoji}`, "hash2"),
  CALL("setCustomizationDescriptionManual", CB, " \t "),
  CALL("setCustomizationDescriptionManual", CA, `${cp(0xfeff)}`),
  CALL("setCustomizationDescription", "nope", "d", "h"),
  CALL("setCustomizationDescriptionManual", "nope", "d"),
  // ---- Upsert and the workspaceId strip.
  seed([cust(CA, { workspaceId: "wks_a", descriptionGeneratedAt: 3 }), cust(CB)], []),
  CALL("upsertCustomizationRecord", { id: CA, name: "Up", workspaceId: "wks_new", description: "x" }),
  CALL("upsertCustomizationRecord", { id: "cust_new000000001", name: "N", workspaceId: 1 }),
  CALL("upsertCustomizationRecord", { name: "no id" }),
  CALL("upsertCustomizationRecord", { name: "no id again", 3: "three" }),
  CALL("upsertCustomizationRecord", "ab"),
  CALL("stripCustomizationWorkspaceIds"),
  CALL("stripCustomizationWorkspaceIds"),
  seed([cust(CA, { workspaceId: null }), cust(CB, { workspaceId: 0 }), { workspaceId: "x" }, [], {}], []),
  CALL("stripCustomizationWorkspaceIds"),
  // ---- Deletes.
  seed([cust(CA), cust(CB), cust(CA, { name: "dup" })], [pub("pub_d1", CA)]),
  CALL("deleteCustomizationRecord", CA),
  CALL("deleteCustomizationRecord", CA),
  CALL("deleteCustomizationRecord", CB),
  CALL("listCustomizations"),
  // ---- Odd entries: `c.id` on null throws, primitives are passed over.
  seed([5, "s", true, [], { id: 7 }, cust(CA), null, cust(CB)], []),
  CALL("listCustomizations"),
  CALL("getCustomization", CA),
  CALL("getCustomization", CB),
  CALL("getCustomization", "7"),
  CALL("updateCustomizationRecord", CA, { name: "a" }),
  CALL("updateCustomizationRecord", CB, { name: "b" }),
  CALL("deleteCustomizationRecord", CA),
  CALL("upsertCustomizationRecord", { id: CA, name: "u" }),
  CALL("upsertCustomizationRecord", { name: "no id" }),
  CALL("stripCustomizationWorkspaceIds"),
  CALL("setCustomizationDescription", CB, "d", "h"),
  ...[[5], ["s"], [true], [{}, null]].flatMap((entries) => [seed(entries, []), CALL("stripCustomizationWorkspaceIds")]),
  seed([{ name: "no id" }, cust(CA)], []),
  CALL("upsertCustomizationRecord", { name: "matched the id-less one", workspaceId: "w" }),
  // ---- Foreign index files.
  ...[
    "",
    "{",
    "null",
    "[]",
    "5",
    '"s"',
    "true",
    '{"version":2,"customizations":[{"id":"cust_f1"}],"publishes":[],"keep":1}',
    '{"version":"1","customizations":[{"id":"cust_f1"}],"publishes":[]}',
    '{"version":1}',
    '{"version":1,"customizations":[{"id":"cust_f1"}]}',
    '{"version":1,"customizations":{},"publishes":[]}',
    '{"version":1,"customizations":[{"id":"cust_f1"}],"publishes":{}}',
    '{"version":1.0,"customizations":[{"id":"cust_f1","name":"one"}],"publishes":[]}',
    '{"version":1e0,"customizations":[{"id":"cust_f1","id":"cust_f2"}],"publishes":[],"version":1}',
    `{"version":1,"customizations":[{"id":"cust_f1","name":"${esc("d83d")}x${esc("DE00")}${esc("d83d")}${esc("de00")}"}],"publishes":[]}`,
  ].flatMap((text) => [FS.write(IDX, text), CALL("listCustomizations"), CALL("getCustomization", "cust_f1"), CALL("updateCustomizationRecord", "cust_f1", { name: "w" })]),
  FS.write(IDX, '{"version":2,"customizations":[],"publishes":[],"keep":1}'),
  CALL("createCustomizationRecord", { name: "over a newer version" }),
  FS.hex(IDX, Buffer.from(`\uFEFF{"version":1,"customizations":[],"publishes":[]}`).toString("hex")),
  CALL("listCustomizations"),
  FS.hex(
    IDX,
    Buffer.concat([Buffer.from(`{"version":1,"customizations":[{"id":"cust_f1","name":"x`), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from('y"}],"publishes":[]}')]).toString("hex"),
  ),
  CALL("getCustomization", "cust_f1"),
  CALL("updateCustomizationRecord", "cust_f1", { name: "rewritten" }),
  // Pretty-printed with 4 spaces, no newline: rewritten as TS writes it.
  seed([cust(CA)], [], {}, 4),
  CALL("updateCustomizationRecord", CA, { name: "re" }),
  // ---- The file system in the way.
  FS.rm(IDX),
  FS.mkdir(IDX),
  CALL("listCustomizations"),
  CALL("createCustomizationRecord", { name: "x" }),
  FS.rm(IDX),
  FS.link(IDX, `${R}/nowhere.json`),
  CALL("listCustomizations"),
  CALL("createCustomizationRecord", { name: "via a dangling link" }),
  FS.rm(IDX),
  FS.json(`${R}/linked-index.json`, { version: 1, customizations: [cust(CA)], publishes: [] }),
  FS.link(IDX, `${R}/linked-index.json`),
  CALL("getCustomization", CA),
  CALL("updateCustomizationRecord", CA, { name: "through the link" }),
  FS.rm(IDX),
  FS.link(IDX, IDX),
  CALL("listCustomizations"),
  FS.rm(IDX),
  seed([cust(CA)], []),
  FS.chmod(IDX, 0o000),
  CALL("listCustomizations"),
  FS.chmod(IDX, 0o644),
  FS.chmod(CR, 0o555),
  CALL("getCustomization", CA),
  CALL("updateCustomizationRecord", CA, { name: "read-only dir" }),
  FS.chmod(CR, 0o755),
  FS.rm(CR),
  FS.chmod(CL, 0o555),
  CALL("listCustomizations"),
  CALL("createCustomizationRecord", { name: "no mkdir" }),
  FS.chmod(CL, 0o755),
  FS.rm(CL),
  FS.write(CL, "a file"),
  CALL("listCustomizations"),
  CALL("createCustomizationRecord", { name: "x" }),
  FS.rm(CL),
  FS.mkdir(CL),
  FS.write(CR, "a file"),
  CALL("listCustomizations"),
  CALL("deleteCustomizationRecord", CA),
  FS.rm(CR),
  // ---- computeDiff (live: $ROOT/live).
  ...MIRROR(1),
  CALL("computeDiff", id(1)),
  CALL("computeDiff", id(2)),
  FS.write(src(3), "src is a file"),
  CALL("computeDiff", id(3)),
  FS.write(`${src(4)}/a.txt`, "a"),
  FS.write(`${src(4)}/locked/b.txt`, "b"),
  FS.chmod(`${src(4)}/locked`, 0o000),
  CALL("computeDiff", id(4)),
  FS.chmod(`${src(4)}/locked`, 0o755),
  FS.write(`${src(5)}/a.txt`, "a"),
  FS.write(`${src(5)}/unreadable.txt`, "b"),
  FS.chmod(`${src(5)}/unreadable.txt`, 0o000),
  CALL("computeDiff", id(5)),
  FS.chmod(`${src(5)}/unreadable.txt`, 0o644),
  FS.write(`${src(6)}/adir`, "base is a directory"),
  CALL("computeDiff", id(6)),
  FS.write(`${src(7)}/afile/x.txt`, "base parent is a file"),
  CALL("computeDiff", id(7)),
  FS.write(`${src(8)}/loop`, "base is a symlink loop"),
  CALL("computeDiff", id(8)),
  FS.mkdir(`${CR}/${id(9)}`),
  FS.link(src(9), src(1)),
  CALL("computeDiff", id(9)),
  FS.mkdir(src(10)),
  CALL("computeDiff", id(10)),
  CALL("computeDiff", `sub/${id(1)}/..`),
  CALL("computeDiff", `${id(1)}/src/sub/..`),
  // Climbs out of the store: TS walks `.claudius/escape/src`.
  FS.write(`${CL}/escape/src/inside-escape.txt`, "outside the store"),
  CALL("computeDiff", "../escape"),
  FS.rm(`${CL}/escape`),
];

// ------------------------------- the route steps -------------------------------

const A = "cust_a00000000001";
const B = "cust_b00000000002";
const Q = "cust_q00000000003";
const STEPS = [
  FS.rm(CL),
  // ---- A missing store: nothing is written.
  G(C),
  G(`${C}/${A}`),
  J("PATCH", `${C}/${A}`, { name: "x" }),
  T("PATCH", `${C}/${A}`, ""),
  T("PATCH", `${C}/${A}`, "null"),
  D(`${C}/${A}`),
  SEL(A),
  SEL(A, { cookie: "claudius.customization=cust_old; claudius.workspace=wks_1" }),
  G(`${C}/${A}/publishes`),
  G(`${C}/${A}/diff`),
  G(`${C}?x=1`),

  // ---- A seeded store.
  seed(
    [
      cust(A, { description: "d", "10": 1, "2": 2, descriptionIsManual: true }),
      cust(B, { name: `B ${cp(0xe9)} ${emoji}`, n: 1e2, f: 1.0, e: 1e21, s: 5e-7 }),
      cust(Q),
    ],
    [pub("pub_1", A, { revertedAt: 5 }), pub("pub_2", B), pub("pub_3", B, { publishedAt: 1 }), pub("pub_4", "cust_other")],
    { extra: { kept: [true, null] } },
  ),
  G(C),
  G(`${C}/${A}`),
  G(`${C}/${B}`),
  G(`${C}/missing`),
  G(`${C}/${A.toUpperCase()}`),
  G(`${C}/${A}%20`),
  G(`${C}/${A}/publishes`),
  G(`${C}/${B}/publishes`),
  G(`${C}/${Q}/publishes`),
  G(`${C}/missing/publishes`),

  // ---- PATCH: 404 first, then the body.
  T("PATCH", `${C}/missing`, "{"),
  T("PATCH", `${C}/${A}`, ""),
  T("PATCH", `${C}/${A}`, "{"),
  T("PATCH", `${C}/${A}`, '{"name":"x",}'),
  T("PATCH", `${C}/${A}`, "null"),
  T("PATCH", `${C}/${A}`, "[]"),
  T("PATCH", `${C}/${A}`, "5"),
  T("PATCH", `${C}/${A}`, '"name"'),
  T("PATCH", `${C}/${A}`, "true"),
  T("PATCH", `${C}/${A}`, "1e400"),
  J("PATCH", `${C}/${A}`, {}),
  J("PATCH", `${C}/${A}`, { name: null }),
  J("PATCH", `${C}/${A}`, { name: 5 }),
  J("PATCH", `${C}/${A}`, { name: ["x"] }),
  J("PATCH", `${C}/${A}`, { name: { a: 1 } }),
  T("PATCH", `${C}/${A}`, '{"name":1e400}'),
  J("PATCH", `${C}/${A}`, { other: "x" }),
  J("PATCH", `${C}/${A}`, { name: "" }),
  J("PATCH", `${C}/${A}`, { name: "  \t\n" }),
  J("PATCH", `${C}/${A}`, { name: `${cp(0xa0, 0xfeff, 0x2028, 0x2029, 0x3000, 0x1680)}` }),
  J("PATCH", `${C}/${A}`, { name: `${cp(0x85, 0x180e, 0x200b)}` }),
  J("PATCH", `${C}/${A}`, { name: " Renamed " }),
  G(`${C}/${A}`),
  J("PATCH", `${C}/${A}`, { name: "Again", id: "forged", createdAt: 9, updatedAt: 9, description: "nope" }),
  T("PATCH", `${C}/${A}`, '{"name":"d1","name":"d2"}'),
  T("PATCH", `${C}/${A}`, `{"name":"${esc("d800")}lone ${esc("dfff")}"}`),
  T("PATCH", `${C}/${A}`, `{"name":"${esc("0000")}ctl${esc("001f")} ${esc("2028")}"}`),
  J("PATCH", `${C}/${B}`, { name: `${emoji} ${cp(0x4e2d, 0x6587)}` }),
  X("PATCH", `${C}/${B}`, Buffer.from('\uFEFF{"name":"one bom"}').toString("hex")),
  X("PATCH", `${C}/${B}`, Buffer.from('\uFEFF\uFEFF{"name":"two boms"}').toString("hex")),
  X("PATCH", `${C}/${B}`, Buffer.from('\uFEFF\uFEFF\uFEFF{"name":"three boms"}').toString("hex")),
  X("PATCH", `${C}/${B}`, Buffer.concat([Buffer.from('{"name":"bad'), Buffer.from([0xff, 0xc3]), Buffer.from('utf8"}')]).toString("hex")),
  G(C),

  // ---- select: the cookie and the workspace cookie it clears.
  SEL("missing"),
  SEL("missing", { cookie: "claudius.customization=cust_old" }),
  SEL("missing", { cookie: "a=1; claudius.workspace=wks_1" }),
  SEL(A),
  SEL(A, { cookie: "claudius.workspace=wks_1" }),
  SEL(A, { cookie: "claudius.customization=cust_old; claudius.workspace=wks_1" }),
  SEL(A, { cookie: "claudius.workspace=wks_1; z=9; claudius.customization=cust_old" }),
  SEL(A, { cookie: "x=1" }),
  SEL(A, { cookie: "claudius.customization" }),
  SEL(A, { cookie: "claudius.workspace=%E0; q=2" }),
  J("POST", `${C}/${B}/select`, { ignored: true }),
  G(C, { cookie: `claudius.customization=${A}` }),

  // ---- DELETE: active publishes block it.
  D(`${C}/missing`),
  D(`${C}/${B}`),
  seed([cust(A), cust(B)], [pub("pub_1", A), pub("pub_2", A, { revertedAt: undefined })]),
  D(`${C}/${A}`),
  seed([cust(A), cust(B)], [pub("pub_1", A, { revertedAt: 0 }), pub("pub_2", A, { revertedAt: false }), pub("pub_3", A, { revertedAt: "" })]),
  FS.write(`${CR}/${A}/src/a.txt`, "a"),
  FS.write(`${CR}/${A}/src/deep/b.txt`, "b"),
  FS.write(`${CR}/${A}/base-manifest.json`, "{}"),
  FS.write(`${CR}/${A}/.publishes/pub_1/snapshot/a.txt`, "snap"),
  FS.write(`${CR}/${A}/.publishes/pub_1/manifest.json`, "{}"),
  FS.write(`${CL}/outside/keep.txt`, "keep"),
  FS.link(`${CR}/${A}/src/out-link`, `${CL}/outside`),
  FS.write(`${CR}/${A}x/keep.txt`, "a sibling with the id as a prefix"),
  D(`${C}/${A}`, { cookie: `claudius.customization=${A}` }),
  G(`${C}/${A}`),
  D(`${C}/${A}`),
  // The customization dir missing, a file, a symlink.
  seed([cust(A), cust(B), cust(Q)], []),
  D(`${C}/${A}`),
  FS.write(`${CR}/${B}`, "a file"),
  D(`${C}/${B}`),
  FS.link(`${CR}/${Q}`, `${CL}/outside`),
  D(`${C}/${Q}`),
  // Odd entries and duplicates.
  seed([cust(A), { id: 5 }, cust(A, { name: "dup" }), "s"], [pub("pub_9", A, { revertedAt: 1 }), 5, "x"]),
  D(`${C}/${A}`),
  seed([cust(A)], [pub("pub_1", "cust_other"), null]),
  D(`${C}/${A}`),
  seed([cust(A), null], []),
  FS.write(`${CR}/${A}/src/a.txt`, "a"),
  D(`${C}/${A}`),
  seed([null, cust(A)], []),
  D(`${C}/${A}`),
  // A read-only customizations dir: the rm fails (warned), then the write throws.
  seed([cust(A)], []),
  FS.mkdir(`${CR}/${A}`),
  FS.chmod(CR, 0o555),
  D(`${C}/${A}`),
  FS.chmod(CR, 0o755),

  // ---- Ids that need encoding, and ids that climb out of the store.
  // GET's `srcDir` is `join(root, id, "src")`, so these also pin how the id
  // is normalized into it; `cust_srcdir` already carries a `srcDir` key,
  // which keeps its place (object spread) with the computed value.
  seed(
    [
      cust("cust a/b;c,=%"),
      cust(`cust_${cp(0xe9)}`),
      cust("-_.!~*'()"),
      cust("../escape"),
      cust("x/.."),
      cust("cust_srcdir", { srcDir: "stale", 7: 7, z: 1 }),
    ],
    [],
  ),
  G(`${C}/${enc("cust a/b;c,=%")}`),
  G(`${C}/${enc(`cust_${cp(0xe9)}`)}`),
  G(`${C}/${enc("-_.!~*'()")}`),
  G(`${C}/${enc("x/..")}`),
  G(`${C}/cust_srcdir`),
  SEL(enc("cust a/b;c,=%")),
  SEL(enc(`cust_${cp(0xe9)}`)),
  SEL(enc("-_.!~*'()")),
  G(`${C}/${enc(`cust_${cp(0xe9)}`)}/publishes`),
  FS.write(`${CL}/escape/src/inside-escape.txt`, "outside the store"),
  G(`${C}/${enc("../escape")}`),
  G(`${C}/${enc("../escape")}/diff`),
  D(`${C}/${enc("../escape")}`),
  D(`${C}/${enc("x/..")}`),
  // TS removed the whole store just now; both sides start over.
  FS.rm(`${CL}/escape`),
  FS.rm(CR),

  // ---- diff.
  seed([cust(id(1)), cust(id(2)), cust(id(3)), cust(id(4)), cust(id(5)), cust(id(6)), cust(id(7)), cust(id(8)), cust(id(9)), cust(id(10))], []),
  ...MIRROR(1),
  G(`${C}/${id(1)}/diff`),
  G(`${C}/${id(2)}/diff`),
  G(`${C}/missing/diff`),
  FS.write(src(3), "src is a file"),
  G(`${C}/${id(3)}/diff`),
  FS.write(`${src(4)}/a.txt`, "a"),
  FS.write(`${src(4)}/locked/b.txt`, "b"),
  FS.chmod(`${src(4)}/locked`, 0o000),
  G(`${C}/${id(4)}/diff`),
  FS.chmod(`${src(4)}/locked`, 0o755),
  FS.write(`${src(5)}/a.txt`, "a"),
  FS.write(`${src(5)}/unreadable.txt`, "b"),
  FS.chmod(`${src(5)}/unreadable.txt`, 0o000),
  G(`${C}/${id(5)}/diff`),
  FS.chmod(`${src(5)}/unreadable.txt`, 0o644),
  FS.write(`${src(6)}/adir`, "base is a directory"),
  G(`${C}/${id(6)}/diff`),
  FS.write(`${src(7)}/afile/x.txt`, "base parent is a file"),
  G(`${C}/${id(7)}/diff`),
  FS.write(`${src(8)}/loop`, "base is a symlink loop"),
  G(`${C}/${id(8)}/diff`),
  FS.mkdir(`${CR}/${id(9)}`),
  FS.link(src(9), src(1)),
  G(`${C}/${id(9)}/diff`),
  FS.mkdir(src(10)),
  G(`${C}/${id(10)}/diff`),

  // ---- Foreign index files.
  ...[
    "",
    "{",
    "null",
    "[]",
    "5",
    '"s"',
    '{"version":2,"customizations":[{"id":"cust_f1"}],"publishes":[]}',
    '{"version":1,"customizations":[{"id":"cust_f1"}]}',
    '{"version":1.0,"customizations":[{"id":"cust_f1","name":"one"}],"publishes":[{"id":"p","customizationId":"cust_f1"}]}',
    `{"version":1,"customizations":[{"id":"cust_f1","name":"${esc("d83d")}x"}],"publishes":[]}`,
  ].flatMap((text) => [
    FS.write(IDX, text),
    G(C),
    G(`${C}/cust_f1`),
    J("PATCH", `${C}/cust_f1`, { name: "p" }),
    SEL("cust_f1"),
    G(`${C}/cust_f1/publishes`),
    G(`${C}/cust_f1/diff`),
  ]),
  D(`${C}/cust_f1`),
  FS.write(IDX, "null"),
  D(`${C}/cust_f1`),
  FS.hex(IDX, Buffer.from(`\uFEFF{"version":1,"customizations":[],"publishes":[]}`).toString("hex")),
  G(C),
  FS.rm(IDX),
  FS.mkdir(IDX),
  G(C),
  SEL("cust_f1"),
  FS.rm(IDX),
  seed([cust("cust_f1")], []),
  FS.chmod(IDX, 0o000),
  G(C),
  G(`${C}/cust_f1/diff`),
  FS.chmod(IDX, 0o644),
  FS.chmod(CR, 0o555),
  J("PATCH", `${C}/cust_f1`, { name: "read-only" }),
  FS.chmod(CR, 0o755),
  FS.rm(IDX),
  FS.json(`${R}/linked-index.json`, { version: 1, customizations: [cust("cust_f1")], publishes: [] }),
  FS.link(IDX, `${R}/linked-index.json`),
  J("PATCH", `${C}/cust_f1`, { name: "through the link" }),
  FS.rm(CL),
  FS.write(CL, "a file"),
  G(C),
  G(`${C}/cust_f1`),
  FS.rm(CL),
  G(C),
];

// ------------------------------- run -------------------------------

const CL_REAL = real(CL);
const IDX_REAL = real(IDX);
function readMaybe(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
/**
 * `.claudius` as nested names: an object (a dir), "d!" (an unreadable dir),
 * "l>target", "f!" (an unreadable file), "index" (index.json as a file),
 * or the file's hex / sha256.
 */
function tree(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return `l>${fake(readlinkSync(path))}`;
  // index.json's text is recorded on its own (`index`).
  if (path === IDX_REAL && st.isFile()) return "index";
  if (!st.isDirectory()) {
    let buf;
    try {
      buf = readFileSync(path);
    } catch {
      return "f!";
    }
    return buf.length <= 32 ? buf.toString("hex") : `sha256:${sha(buf)}:${buf.length}`;
  }
  let names;
  try {
    names = readdirSync(path).sort();
  } catch {
    return "d!";
  }
  const out = {};
  for (const n of names) out[fake(n)] = tree(join(path, n));
  return out;
}
const snapshot = () => ({ index: readMaybe(IDX_REAL), tree: JSON.stringify(tree(CL_REAL)) });
const same = (a, b) => (a === null ? b === null : b !== null && a.equals(b));
function changes(before, now, step) {
  if (!same(before.index, now.index)) step.index = now.index === null ? null : fake(now.index.toString("utf8"));
  if (before.tree !== now.tree) step.tree = JSON.parse(now.tree);
}

function applyFs(s) {
  const p = real(s.path);
  if (s.act === "write") {
    mkdirSync(dirname(p), { recursive: true });
    if (s.gen) writeFileSync(p, pattern(s.gen[0], s.gen[1]));
    else writeFileSync(p, s.hex !== undefined ? realBytes(s.hex) : real(s.text));
  } else if (s.act === "mkdir") mkdirSync(p, { recursive: true });
  else if (s.act === "rm") rmSync(p, { recursive: true, force: true });
  else if (s.act === "symlink") {
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(real(s.target), p);
  } else if (s.act === "chmod") chmodSync(p, s.mode);
}

const FNS = { ...store, computeDiff: publish.computeDiff };
const recordedStore = [];
let tick = 0;
let last = snapshot();
for (const raw of STORE) {
  const s = { ...raw };
  if (s.op === "fs") {
    applyFs(s);
    recordedStore.push(s);
    last = snapshot();
    continue;
  }
  tick += 1;
  clock = BASE + tick * 1_000_003;
  const args = JSON.parse(real(JSON.stringify(s.args)));
  const step = { op: "call", fn: s.fn, args: s.args, clock };
  try {
    const result = await FNS[s.fn](...args);
    if (result === undefined) step.void = true;
    else step.result = fake(JSON.stringify(result));
  } catch (e) {
    step.threw = fake(e instanceof Error ? e.message : String(e));
  }
  const now = snapshot();
  changes(last, now, step);
  last = now;
  recordedStore.push(step);
}

const recordedSteps = [];
last = snapshot();
for (const raw of STEPS) {
  const s = { ...raw };
  if (s.op === "fs") {
    applyFs(s);
    recordedSteps.push(s);
    last = snapshot();
    continue;
  }
  tick += 1;
  clock = BASE + tick * 1_000_003;
  const [mod, params] = routeFor(s.path);
  const headers = {};
  if (s.cookie !== undefined) headers.cookie = real(s.cookie);
  let body;
  if (s.body !== undefined) body = real(s.body);
  else if (s.bodyHex !== undefined) body = realBytes(s.bodyHex);
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest(`http://localhost${s.path}`, { method: s.method, headers, body });
  let got;
  try {
    const res = await mod.handle(req, context(params));
    const type = res.headers.get("content-type");
    got = { status: res.status, type };
    const cookies = res.headers.getSetCookie();
    if (cookies.length) got.cookies = cookies.map(fake);
    const others = [...res.headers.keys()].filter((k) => !["content-type", "set-cookie"].includes(k));
    if (others.length) got.headers = others;
    got.body = fake(Buffer.from(await res.arrayBuffer()).toString("utf8"));
  } catch (e) {
    got = { threw: fake(e instanceof Error ? e.message : String(e)) };
  }
  const step = { ...s, clock, got };
  const now = snapshot();
  changes(last, now, step);
  last = now;
  recordedSteps.push(step);
}

const SHA1_LENGTHS = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65_535, 65_536, 65_537, 200_000];
const sha1 = SHA1_LENGTHS.map((len, i) => ({ len, seed: i, hex: createHash("sha1").update(pattern(len, i)).digest("hex") }));

writeFileSync(
  join(ROOT, "out.json"),
  JSON.stringify({ live: fake(runtimeDir.getLiveSourceDir()), store: recordedStore, steps: recordedSteps, sha1 }),
);
