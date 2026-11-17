#!/usr/bin/env node
// Golden fixture for the customization lifecycle routes (D14):
// `app/api/customizations/route.ts` (POST, the bootstrap),
// `[id]/{deactivate,sync,description,build-app,publish,auto-fix}/route.ts`
// and `[id]/publishes/[pubId]/revert/route.ts`, over
// `lib/server/customization-{bootstrap,manifest,sync,description,build,
// publish,revert}.ts`, `customize-settings.ts` and
// `customizations-startup.ts`.
//
//   node rust/scripts/customization-actions-golden.mjs   (node@22)
//
// Re-runs itself twice under `--experimental-transform-types`, each time in
// a fresh temp root with HOME at <root>/home, CLAUDE_CONFIG_DIR at
// <root>/config, the cwd at the repo (where `db.ts` looks for its
// migrations; the live source never comes from it), CLAUDIUS_LIVE_SOURCE at
// " <root>/live\t" and PATH at <root>/fakebin:<root>/sysbin, so the `git`
// the diff runs and the `node` a launcher lookup finds are the fakes this
// script writes (the same ones the Rust test writes). `Date` is pinned to a
// clock that moves 1_000_003 ms per request, `crypto.randomUUID` is a
// seeded sequence, and the agent SDK is shimmed to launch
// `claudius-fake-claude` (built here) instead of a real CLI. Both
// recordings must agree byte for byte.
//
// Sections:
// * `steps`: requests, `fs` steps and `wait` steps (poll the build state),
//   in order. A request records `got` (status, content type, body text, or
//   `threw` for Next's empty 500), then `index` (index.json's text when the
//   request changed it), `tree` (the `.claudius` listing when it changed),
//   `live` (the live tree when it changed) and, for a description POST,
//   `cli` (the fake CLI's argv, its `initialize` system prompt and the
//   prompt text it was sent).
// * `startup`: `runCustomizationsUpgradeCheck` / `reconcileCustomizationWorkspaces`
//   called directly, with the console lines they wrote and the same
//   `index` / `tree` / `live` changes.
// * `prompt`: DEFAULT_AUTO_FIX_PROMPT, the template the auto-fix route
//   substitutes.
// * `fakes`: the `git` and `node` stand-ins, so the Rust test writes the
//   very same ones.
// * `version`: CLAUDIUS_VERSION, which the replay maps to the Rust one (the
//   SDK version the two sides carry can differ mid-port).
//
// A path may contain `$PUB`: the id of the newest publish a 201 reported.
// The temp root is written "$ROOT", `process.pid` in a temp name ".$PID.",
// `process.execPath` "$NODE", the fake CLI "$CLI" and electron-builder's
// per-arch output dir "$MAC". Strings stay ASCII: non-ASCII text is built
// with String.fromCodePoint.
//
// Written to rust/crates/claudius-server/tests/fixtures/customization_actions_golden.json;
// replayed by crates/claudius-server/tests/customization_actions.rs (the
// requests, against the real binary) and
// crates/claudius-core/tests/customizations_startup_golden.rs (`startup`).
import { execFileSync, spawnSync } from "node:child_process";
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
const out = join(rustDir, "crates/claudius-server/tests/fixtures/customization_actions_golden.json");

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

// ------------------------------- the fakes -------------------------------
// Written into <root>/fakebin by both this recorder and the Rust test, and
// into the live tree as the scripts the real node runs here. The sh and the
// JS halves must print the same bytes.

const FAKE_GIT = `#!/bin/sh
# git diff --no-index --no-color -- <a> <b>
a="$5"
b="$6"
case "$a$b" in
  *gitfail*) printf 'fatal: fake git refuses\\n' >&2; exit 128 ;;
  *nodiff*) exit 0 ;;
esac
printf -- '--- %s\\n+++ %s\\n@@ -1 +1 @@\\n-old\\n+new\\n' "$a" "$b"
exit 1
`;

/** The revert script's output, as sh. */
const FAKE_REVERT_SH = `
  id="--last"
  while [ $# -gt 0 ]; do
    if [ "$1" = "--id" ]; then id="$2"; fi
    shift
  done
  printf 'r:%s\\n' "$id" >> "$HOME/.claude/.claudius/revert.log"
  printf 'reverted %s\\n' "$id"
  case "$id" in
    *fail*) printf 'boom\\n' >&2; exit 3 ;;
  esac
  printf 'ok\\n' >&2
  exit 0
`;

/** The build script's output, as sh (its cwd is the live source). */
const FAKE_BUILD_SH = `
  src=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--overlay-src" ]; then src="$2"; fi
    shift
  done
  case "$src" in
    *hang*) n=0; while [ ! -f ./go ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done ;;
  esac
  printf 'overlay %s\\r\\nbuilding\\n\\nline three\\n' "$src"
  case "$src" in
    *bad*) printf 'oops\\n' >&2; exit 7 ;;
    *noapp*) exit 0 ;;
  esac
  mkdir -p ./release/mac/Claudius.app ./release/mac-arm64/Claudius.app
  exit 0
`;

const FAKE_NODE = `#!/bin/sh
# Stands in for the node a launcher lookup finds: runs the fake scripts.
case "$1" in
  *claudius-revert)${FAKE_REVERT_SH} ;;
  *build-app-local.mjs)${FAKE_BUILD_SH} ;;
esac
printf 'fake node: %s\\n' "$1" >&2
exit 9
`;

/** The same two scripts for the real node (`process.execPath`) to run. */
const REVERT_MJS = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const a = process.argv.slice(2);
const i = a.indexOf("--id");
const id = i >= 0 ? a[i + 1] : "--last";
appendFileSync(join(process.env.HOME, ".claude/.claudius/revert.log"), \`r:\${id}\\n\`);
process.stdout.write(\`reverted \${id}\\n\`);
if (id.includes("fail")) {
  process.stderr.write("boom\\n");
  process.exit(3);
}
process.stderr.write("ok\\n");
`;

const BUILD_MJS = `#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
const a = process.argv.slice(2);
const src = a[a.indexOf("--overlay-src") + 1] ?? "";
if (src.includes("hang")) {
  const t = new Int32Array(new SharedArrayBuffer(4));
  for (let n = 0; n < 300 && !existsSync("./go"); n++) Atomics.wait(t, 0, 0, 100);
}
process.stdout.write(\`overlay \${src}\\r\\nbuilding\\n\\nline three\\n\`);
if (src.includes("bad")) {
  process.stderr.write("oops\\n");
  process.exit(7);
}
if (!src.includes("noapp")) {
  mkdirSync("./release/mac/Claudius.app", { recursive: true });
  mkdirSync("./release/mac-arm64/Claudius.app", { recursive: true });
}
`;

if (!process.env.CUSTACT_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const cli = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "custact-golden-")));
    try {
      for (const d of ["home", "config", "project", "live", "fakebin", "sysbin"]) {
        mkdirSync(join(root, d));
      }
      writeFileSync(join(root, "fakebin/git"), FAKE_GIT, { mode: 0o755 });
      writeFileSync(join(root, "fakebin/node"), FAKE_NODE, { mode: 0o755 });
      for (const tool of ["sh", "mkdir", "sleep", "rm", "test"]) {
        for (const dir of ["/bin", "/usr/bin"]) {
          try {
            lstatSync(join(dir, tool));
            symlinkSync(join(dir, tool), join(root, "sysbin", tool));
            break;
          } catch {
            // next dir
          }
        }
      }
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          // `lib/server/db.ts` reads its migrations from `process.cwd()`.
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: `${join(root, "fakebin")}:${join(root, "sysbin")}`,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            CLAUDIUS_LIVE_SOURCE: ` ${join(root, "live")}\t`,
            TZ: "UTC",
            CUSTACT_GOLDEN_CHILD: root,
            CUSTACT_GOLDEN_CLI: cli,
            FAKE_CLAUDE_SCRIPT: join(root, "cli-script.json"),
            FAKE_CLAUDE_ARGV: join(root, "cli-argv.json"),
            FAKE_CLAUDE_LOG: join(root, "cli-stdin.log"),
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
    const dir = process.env.CUSTACT_GOLDEN_DIFF_DIR;
    if (dir) runs.forEach((r, i) => writeFileSync(join(dir, `run${i}.json`), r));
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const reqs = fixture.steps.filter((s) => s.op === "req").length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.steps.length} steps (${reqs} requests), ` +
      `${fixture.startup.length} startup steps (stable)`,
  );
  process.exit(0);
}

const ROOT = process.env.CUSTACT_GOLDEN_CHILD;
const CLI = process.env.CUSTACT_GOLDEN_CLI;

const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "custact-golden-shim-")));
const shim = join(shimDir, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.CUSTACT_GOLDEN_CLI } });
}
`,
);

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SHIM = ${JSON.stringify(pathToFileURL(shim).href)};
export async function resolve(spec, ctx, next) {
  if (spec === ${JSON.stringify(SDK)} && ctx.parentURL && ctx.parentURL.endsWith("/lib/server/customization-description.ts")) {
    return { url: SHIM, shortCircuit: true };
  }
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
  const h = createHash("sha256").update(`customization-actions-golden-${uuidN++}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
syncBuiltinESMExports();

const logs = [];
for (const name of ["log", "warn", "error"]) {
  console[name] = (...args) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : String(a?.message ?? a))).join(" "));
  };
}

const require = createRequire(join(repo, "package.json"));
const { AppRouteRouteModule } = require("next/dist/server/route-modules/app-route/module.js");
const { NextRequest } = require("next/server.js");
const startup = await import(join(repo, "lib/server/customizations-startup.ts"));
const build = await import(join(repo, "lib/server/customization-build.ts"));
const settings = await import(join(repo, "lib/server/customize-settings.ts"));
const runtimeDir = await import(join(repo, "lib/server/runtime-dir.ts"));
const version = await import(join(repo, "lib/shared/version.ts"));

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
const P = "/api/customizations/[id]";
const ROUTES = {
  coll: routeModule(await import(join(api, "route.ts")), "/api/customizations"),
  sync: routeModule(await import(join(api, "[id]/sync/route.ts")), `${P}/sync`),
  description: routeModule(await import(join(api, "[id]/description/route.ts")), `${P}/description`),
  "build-app": routeModule(await import(join(api, "[id]/build-app/route.ts")), `${P}/build-app`),
  publish: routeModule(await import(join(api, "[id]/publish/route.ts")), `${P}/publish`),
  "auto-fix": routeModule(await import(join(api, "[id]/auto-fix/route.ts")), `${P}/auto-fix`),
  deactivate: routeModule(await import(join(api, "[id]/deactivate/route.ts")), `${P}/deactivate`),
  revert: routeModule(
    await import(join(api, "[id]/publishes/[pubId]/revert/route.ts")),
    `${P}/publishes/[pubId]/revert`,
  ),
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
  const params = { id: decodeURIComponent(segs[0]) };
  if (segs[1] === "publishes") {
    return [ROUTES.revert, { ...params, pubId: decodeURIComponent(segs[2]) }];
  }
  return [ROUTES[segs[1]], params];
}

// ------------------------------- helpers -------------------------------

const cp = (...cps) => String.fromCodePoint(...cps);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
/** Raw bytes with the temp root replaced by "$ROOT". */
function fakeBytes(buf) {
  const needle = Buffer.from(ROOT);
  const parts = [];
  let at = 0;
  for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, at)) {
    parts.push(buf.subarray(at, i), Buffer.from("$ROOT"));
    at = i + needle.length;
  }
  parts.push(buf.subarray(at));
  return Buffer.concat(parts);
}
const MAC = process.arch === "arm64" ? "mac-arm64" : "mac";
const real = (s) => s.replaceAll("$ROOT", ROOT);
const fake = (s) =>
  s
    .replaceAll(ROOT, "$ROOT")
    .replaceAll(`.${process.pid}.`, ".$PID.")
    .replaceAll(CLI, "$CLI")
    .replaceAll(process.execPath, "$NODE")
    .replaceAll(`/release/${MAC}/`, "/release/$MAC/");

const R = "$ROOT";
const CL = `${R}/home/.claude/.claudius`;
const CR = `${CL}/customizations`;
const IDX = `${CR}/index.json`;
const LIVE = `${R}/live`;
const C = "/api/customizations";

const REQ = (method, path, extra = {}) => ({ op: "req", method, path, ...extra });
const G = (path, extra) => REQ("GET", path, extra);
const POST = (path, extra) => REQ("POST", path, extra);
const J = (method, path, value, extra) => REQ(method, path, { body: JSON.stringify(value), ...extra });
const FS = {
  write: (path, text) => ({ op: "fs", act: "write", path, text }),
  json: (path, value) => ({ op: "fs", act: "write", path, text: JSON.stringify(value, null, 2) }),
  mkdir: (path) => ({ op: "fs", act: "mkdir", path }),
  rm: (path) => ({ op: "fs", act: "rm", path }),
  link: (path, target) => ({ op: "fs", act: "symlink", path, target }),
  chmod: (path, mode) => ({ op: "fs", act: "chmod", path, mode }),
};
/** Poll the build state of `id` until it settles (or 30 s pass). */
const WAIT = (id) => ({ op: "wait", id });
const CALL = (fn) => ({ op: "call", fn });

const cust = (id, extra = {}) => ({
  id,
  name: `n ${id.slice(-2)}`,
  createdAt: 1,
  updatedAt: 2,
  baseVersion: "0.0.1",
  ...extra,
});
const pub = (id, customizationId, extra = {}) => ({
  id,
  customizationId,
  publishedAt: 10,
  revertedAt: null,
  baseHash: "b0",
  files: [],
  snapshotDir: `${CR}/${customizationId}/.publishes/${id}/snapshot`,
  ...extra,
});
const seed = (customizations, publishes = []) => FS.json(IDX, { version: 1, customizations, publishes });
const manifest = (files, createdAt = 5) => ({ version: 1, createdAt, files });
const SRC = (id) => `${CR}/${id}/src`;
const MANIFEST = (id) => `${CR}/${id}/base-manifest.json`;

const h = (s) => createHash("sha1").update(s).digest("hex");
/**
 * A transcript file under the SDK's project dir for `cwd`: the dir name is
 * the cwd with every non-alphanumeric unit replaced by `-`, so it holds the
 * temp root and can't be written with a `$ROOT` placeholder. Both sides
 * build the path from `sdk` and `name` instead.
 */
const SDKFILE = (cwd, name, text) => ({ op: "fs", act: "write", sdk: cwd, name, text });
const DB = (cwd, sql) => ({ op: "db", cwd, sql });
const CLI_SCRIPT = `${R}/cli-script.json`;
const CLI_ARGV = `${R}/cli-argv.json`;
const CLI_LOG = `${R}/cli-stdin.log`;
/** The fs steps that arm the fake CLI with `script` for the next request. */
const ARM = (script) => [FS.rm(CLI_ARGV), FS.rm(CLI_LOG), FS.json(CLI_SCRIPT, script)];

// ------------------------------- the world -------------------------------

const LIVE_WORLD = [
  FS.mkdir(CL),
  FS.write(`${LIVE}/a.txt`, "a"),
  FS.write(`${LIVE}/b.txt`, "b"),
  FS.write(`${LIVE}/conf.txt`, "theirs"),
  FS.write(`${LIVE}/up.txt`, "new"),
  FS.write(`${LIVE}/fresh.txt`, "f"),
  FS.write(`${LIVE}/nodiff.txt`, "live"),
  FS.write(`${LIVE}/sub/c.txt`, "c"),
  FS.write(`${LIVE}/electron-builder.yml`, "mac: {}\n"),
  FS.write(`${LIVE}/scripts/build-app-local.mjs`, BUILD_MJS),
  FS.write(`${LIVE}/bin/claudius-revert`, REVERT_MJS),
];

const D1 = "cust_d100000001";
const S1 = "cust_s100000002";
const B1 = "cust_b100000003";
const P1 = "cust_p100000004";
const MIRROR_D1 = [
  FS.write(`${SRC(D1)}/a.txt`, "a2"),
  FS.write(`${SRC(D1)}/new.txt`, "n"),
  FS.write(`${SRC(D1)}/conf.txt`, "mine"),
  FS.write(`${SRC(D1)}/nodiff.txt`, "mirror"),
  FS.write(`${SRC(D1)}/up.txt`, "old"),
  FS.write(`${SRC(D1)}/gone.txt`, "g"),
  FS.write(`${SRC(D1)}/sub/c.txt`, "c"),
  FS.json(
    MANIFEST(D1),
    manifest({
      "a.txt": h("a"),
      "b.txt": h("b"),
      "conf.txt": h("base"),
      "nodiff.txt": h("nodiff-base"),
      "up.txt": h("old"),
      "gone.txt": h("g"),
      "sub/c.txt": h("c"),
    }),
  ),
];

/** A transcript line for a user message. */
const user = (content, extra = {}) => ({
  type: "user",
  message: { role: "user", content },
  timestamp: "2023-11-14T22:13:20.000Z",
  ...extra,
});
/**
 * The SDK rebuilds the branch that ends at the last entry by following
 * `parentUuid`, so every line needs its own `uuid` and the chain must be
 * linked or only the tail survives.
 */
const lineUuid = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const chain = (lines, from = 0) =>
  lines.map((l, n) =>
    JSON.stringify({
      ...l,
      uuid: lineUuid(from + n),
      parentUuid: n === 0 ? null : lineUuid(from + n - 1),
    }),
  );
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const TRANSCRIPT_A = [
  user("  Make the sidebar narrower.  "),
  user(`before<system-reminder>nag</system-reminder>after`),
  user([
    { type: "text", text: "  first  " },
    { type: "tool_result", text: "dropped" },
    { type: "text", text: `<bash-input>ls</bash-input>\n<bash-stdout>a</bash-stdout>\n<bash-stderr></bash-stderr>` },
    { type: "text", text: "second" },
  ]),
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "no" }] } },
  user({ nope: 1 }),
  user("", { message: { role: "system", content: "sys" } }),
].map((l) => ({ ...l, sessionId: UUID_A }));
const TRANSCRIPT_B = [user(`${cp(0x1f600)} emoji intent`)].map((l) => ({ ...l, sessionId: UUID_B }));

// ------------------------------- the steps -------------------------------

const STEPS = [
  ...LIVE_WORLD,
  // ---- Every route on a missing record.
  seed([], []),
  G(`${C}/nope/sync`),
  POST(`${C}/nope/sync`),
  G(`${C}/nope/description`),
  POST(`${C}/nope/description`),
  J("PATCH", `${C}/nope/description`, { description: "x" }),
  G(`${C}/nope/build-app`),
  POST(`${C}/nope/build-app`),
  POST(`${C}/nope/publish`),
  POST(`${C}/nope/auto-fix`),
  POST(`${C}/nope/deactivate`),
  POST(`${C}/nope/publishes/pub_x/revert`),

  // ---- The bootstrap. The store is cleared between the calls: a
  // customization's id is random, and one mirror at a time keeps the
  // recorded tree comparable with this server's.
  POST(C),
  FS.rm(CR),
  J("POST", C, { name: "  Mine  " }),
  FS.rm(CR),
  J("POST", C, { name: null }),
  FS.rm(CR),
  J("POST", C, { name: 5 }),
  FS.rm(CR),
  REQ("POST", C, { body: "not json" }),
  FS.rm(CR),
  REQ("POST", C, { body: "" }),
  FS.rm(CR),
  J("POST", C, { name: `${cp(0x1f600)} rocket` }),
  FS.rm(CR),
  // An unreadable live subdir: the record and the mirror are rolled back.
  FS.chmod(`${LIVE}/sub`, 0o000),
  J("POST", C, { name: "rollback" }),
  FS.chmod(`${LIVE}/sub`, 0o755),
  FS.rm(CR),
  // node_modules: hardlinked files, symlinks recreated verbatim.
  FS.write(`${LIVE}/node_modules/pkg/index.js`, "mod"),
  FS.link(`${LIVE}/node_modules/.bin/x`, "../pkg/index.js"),
  J("POST", C, { name: "with deps" }),
  FS.rm(`${LIVE}/node_modules`),
  FS.rm(CR),

  // ---- sync: the whole verdict matrix, then applying the safe half.
  seed([cust(D1), cust(S1, { baseVersion: undefined }), cust(B1), cust(P1)], []),
  ...MIRROR_D1,
  G(`${C}/${D1}/sync`),
  // No manifest yet: ensureManifest writes one from the mirror as it is.
  FS.write(`${SRC(S1)}/only.txt`, "o"),
  G(`${C}/${S1}/sync`),
  G(`${C}/${S1}/sync`),
  // Applying: upstream-only copied, new-upstream added, deleted-upstream
  // removed, conflicts skipped; the manifest is re-based and baseVersion
  // advances.
  POST(`${C}/${D1}/sync`),
  G(`${C}/${D1}/sync`),
  // A manifest another writer left: `files` an array, a hash that isn't a
  // string, a `__proto__` key, and a version that isn't 1 (rebuilt).
  FS.json(MANIFEST(S1), manifest({ "only.txt": 5, __proto__: "x", missing: "zz" })),
  G(`${C}/${S1}/sync`),
  FS.json(MANIFEST(S1), manifest(["x", "y"])),
  G(`${C}/${S1}/sync`),
  FS.json(MANIFEST(S1), { version: 2, files: {} }),
  G(`${C}/${S1}/sync`),
  FS.write(MANIFEST(S1), "null"),
  G(`${C}/${S1}/sync`),
  FS.write(MANIFEST(S1), "{nope"),
  G(`${C}/${S1}/sync`),
  FS.rm(MANIFEST(S1)),
  // An unreadable mirror file: the hash throws.
  FS.chmod(`${SRC(S1)}/only.txt`, 0o000),
  G(`${C}/${S1}/sync`),
  POST(`${C}/${S1}/sync`),
  FS.chmod(`${SRC(S1)}/only.txt`, 0o644),

  // ---- auto-fix.
  POST(`${C}/${S1}/auto-fix`),
  POST(`${C}/${D1}/auto-fix`),
  FS.json(`${CL}/customize-settings.json`, { autoFixPrompt: "fix {{conflict_count}}:\n{{conflict_paths}}\n" }),
  POST(`${C}/${D1}/auto-fix`),
  // GetSubstitution in the replacement text is not re-expanded.
  FS.json(`${CL}/customize-settings.json`, { autoFixPrompt: "$$ $& $` $' {{conflict_count}} {{conflict_paths}}" }),
  POST(`${C}/${D1}/auto-fix`),
  FS.json(`${CL}/customize-settings.json`, { autoFixPrompt: "   " }),
  POST(`${C}/${D1}/auto-fix`),
  FS.json(`${CL}/customize-settings.json`, { autoFixPrompt: 5 }),
  POST(`${C}/${D1}/auto-fix`),
  FS.write(`${CL}/customize-settings.json`, "null"),
  POST(`${C}/${D1}/auto-fix`),
  FS.write(`${CL}/customize-settings.json`, "{nope"),
  POST(`${C}/${D1}/auto-fix`),
  FS.rm(`${CL}/customize-settings.json`),

  // ---- description: the record's fields, then the generated text.
  G(`${C}/${D1}/description`),
  REQ("PATCH", `${C}/${D1}/description`, { body: "{nope" }),
  J("PATCH", `${C}/${D1}/description`, { description: 5 }),
  J("PATCH", `${C}/${D1}/description`, {}),
  REQ("PATCH", `${C}/${D1}/description`, { body: "null" }),
  J("PATCH", `${C}/${D1}/description`, { description: `  ${cp(0x2014)} typed  ` }),
  G(`${C}/${D1}/description`),
  J("PATCH", `${C}/${D1}/description`, { description: "" }),
  G(`${C}/${D1}/description`),
  // No user-authored changes.
  POST(`${C}/${S1}/description`),
  // The real query: the diff of the user verdicts plus the chat intent.
  ...ARM({ turns: [{ result: "```md\n  A tidy change.  \n```" }] }),
  DB(
    SRC(D1),
    `INSERT INTO sessions (id, cwd, title, created_at, updated_at, last_seen_at) VALUES
       ('${UUID_A}', '${SRC(D1)}', 'Sidebar', 1, 20, 20),
       ('${UUID_B}', '${SRC(D1)}', NULL, 1, 10, 10),
       ('not-a-uuid', '${SRC(D1)}', 'skipped', 1, 30, 30)`,
  ),
  SDKFILE(SRC(D1), `${UUID_A}.jsonl`, chain(TRANSCRIPT_A).join("\n") + "\n"),
  SDKFILE(SRC(D1), `${UUID_B}.jsonl`, chain(TRANSCRIPT_B, 6).join("\n") + "\n"),
  POST(`${C}/${D1}/description`),
  G(`${C}/${D1}/description`),
  // The description goes stale when a user-edited file changes.
  FS.write(`${SRC(D1)}/conf.txt`, "mine2"),
  G(`${C}/${D1}/description`),
  // An empty answer, a non-success result, and a CLI that dies.
  ...ARM({ turns: [{ result: "   " }] }),
  POST(`${C}/${D1}/description`),
  ...ARM({
    turns: [
      {
        steps: [
          {
            type: "result",
            subtype: "error_max_turns",
            is_error: true,
            // SDK 0.3.312 reads `errors.map()` on an error result.
            errors: ["too many turns"],
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
            session_id: "$SESSION_ID",
            uuid: "$UUID",
          },
        ],
        result: false,
      },
    ],
  }),
  POST(`${C}/${D1}/description`),
  ...ARM({ turns: [{ steps: [{ $stderr: "nope" }, { $exit: 1 }] }] }),
  POST(`${C}/${D1}/description`),
  // A manifest hash that isn't a string: `createHash().update` throws.
  FS.json(MANIFEST(D1), manifest({ "a.txt": 5 })),
  ...ARM({ turns: [{ result: "x" }] }),
  POST(`${C}/${D1}/description`),
  ...MIRROR_D1,

  // ---- publish and revert.
  POST(`${C}/${P1}/publish`),
  FS.write(`${SRC(P1)}/a.txt`, "published"),
  FS.write(`${SRC(P1)}/added.txt`, "brand new"),
  POST(`${C}/${P1}/publish`),
  POST(`${C}/${P1}/publishes/$PUB/revert`),
  POST(`${C}/${P1}/publishes/$PUB/revert`),
  POST(`${C}/${P1}/publishes/pub_missing/revert`),
  POST(`${C}/${P1}/deactivate`),
  // Several actives, newest first; one revert fails (exit 3).
  seed(
    [cust(P1)],
    [
      pub("pub_old", P1, { publishedAt: 10 }),
      pub("pub_fail", P1, { publishedAt: 30 }),
      pub("pub_str", P1, { publishedAt: "20" }),
      pub("pub_done", P1, { publishedAt: 40, revertedAt: 41 }),
    ],
  ),
  POST(`${C}/${P1}/deactivate`),
  // An id that isn't a string reaches the script as `String(id)`.
  seed([cust(P1)], [pub(7, P1, { publishedAt: 10 })]),
  POST(`${C}/${P1}/deactivate`),
  // A `publishedAt` with no primitive: the sort's subtraction throws.
  seed([cust(P1)], [pub("pub_a", P1, { publishedAt: { toString: 1 } }), pub("pub_b", P1)]),
  POST(`${C}/${P1}/deactivate`),

  // ---- build-app.
  seed([cust(B1)], []),
  FS.write(`${SRC(B1)}/a.txt`, "built"),
  G(`${C}/${B1}/build-app`),
  // No build script in the live tree: unavailable.
  FS.rm(`${LIVE}/scripts/build-app-local.mjs`),
  G(`${C}/${B1}/build-app`),
  POST(`${C}/${B1}/build-app`),
  FS.write(`${LIVE}/scripts/build-app-local.mjs`, BUILD_MJS),
  // A build that fails, with no .app in the tree.
  FS.rm(`${LIVE}/release`),
  seed([cust(B1, { id: `${B1}bad` })], []),
  FS.write(`${CR}/${B1}bad/src/a.txt`, "built"),
  POST(`${C}/${B1}bad/build-app`),
  WAIT(`${B1}bad`),
  G(`${C}/${B1}bad/build-app`),
  // A build that waits for a gate: the second POST sees the same state.
  seed([cust(`${B1}hang`)], []),
  FS.write(`${CR}/${B1}hang/src/a.txt`, "built"),
  POST(`${C}/${B1}hang/build-app`),
  POST(`${C}/${B1}hang/build-app`),
  FS.write(`${LIVE}/go`, ""),
  WAIT(`${B1}hang`),
  G(`${C}/${B1}hang/build-app`),
  FS.rm(`${LIVE}/go`),
];

// ------------------------------- startup -------------------------------

const STARTUP = [
  // Its own world (the Rust side replays this section on the library
  // functions, not through the server): the steps section's leftovers go,
  // and the live tree is written again.
  FS.rm(CL),
  FS.rm(LIVE),
  ...LIVE_WORLD,
  // Nothing active: the check is a no-op.
  seed([cust(P1)], [pub("pub_r1", P1, { revertedAt: 1 })]),
  CALL("runCustomizationsUpgradeCheck"),
  // A stale baseHash: the publish is auto-reverted and marked.
  seed([cust(P1)], [pub("pub_r2", P1, { baseHash: "stale" }), pub("pub_r3", P1, { baseHash: "also" })]),
  CALL("runCustomizationsUpgradeCheck"),
  // A matching baseHash: nothing to do.
  { op: "seedhash" },
  CALL("runCustomizationsUpgradeCheck"),
  // The workspace reconcile.
  FS.json(`${CL}/workspaces.json`, {
    version: 1,
    activeId: "wks_c",
    workspaces: [
      { id: "wks_a", name: "a", rootPath: `${R}/live` },
      { id: "wks_c", name: "c", rootPath: `${CR}/${P1}/src`, kind: "customization" },
    ],
  }),
  seed([cust(P1, { workspaceId: "wks_c" }), cust(D1)], []),
  CALL("reconcileCustomizationWorkspaces"),
  CALL("reconcileCustomizationWorkspaces"),
  // An unreadable index: the reconcile warns and gives up.
  FS.chmod(IDX, 0o000),
  CALL("reconcileCustomizationWorkspaces"),
  FS.chmod(IDX, 0o644),
  CALL("isRunningInsideCustomizationMirror"),
];

// ------------------------------- run -------------------------------

const hash = await import(join(repo, "lib/server/customization-hash.ts"));
const db = await import(join(repo, "lib/server/db.ts"));

const CL_REAL = real(CL);
const IDX_REAL = real(IDX);
const LIVE_REAL = real(LIVE);

function readMaybe(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * A tree as nested names: an object (a dir), "d!" (an unreadable dir),
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
  if (path === IDX_REAL && st.isFile()) return "index";
  if (!st.isDirectory()) {
    let buf;
    try {
      buf = readFileSync(path);
    } catch {
      return "f!";
    }
    const masked = fakeBytes(buf);
    return masked.length <= 2000 ? masked.toString("utf8") : `sha256:${sha(masked)}:${masked.length}`;
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
const snapshot = () => ({
  index: readMaybe(IDX_REAL),
  tree: JSON.stringify(tree(CL_REAL)),
  live: JSON.stringify(tree(LIVE_REAL)),
});
const same = (a, b) => (a === null ? b === null : b !== null && a.equals(b));
function changes(before, now, step) {
  if (!same(before.index, now.index)) step.index = now.index === null ? null : fake(now.index.toString("utf8"));
  if (before.tree !== now.tree) step.tree = JSON.parse(now.tree);
  if (before.live !== now.live) step.live = JSON.parse(now.live);
}

function sdkPath(s) {
  const dir = real(s.sdk).replace(/[^a-zA-Z0-9]/g, "-");
  return join(real(`${R}/config`), "projects", dir, s.name);
}

function applyFs(s) {
  const p = s.sdk !== undefined ? sdkPath(s) : real(s.path);
  if (s.act === "write") {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, real(s.text));
  } else if (s.act === "mkdir") mkdirSync(p, { recursive: true });
  else if (s.act === "rm") rmSync(p, { recursive: true, force: true });
  else if (s.act === "symlink") {
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(real(s.target), p);
  } else if (s.act === "chmod") chmodSync(p, s.mode);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const maskIds = (s) => fake(s).replace(UUID_RE, "$UUID");
/** The fake CLI's argv, its `initialize` system prompt and its prompt. */
function readCli() {
  let argv = null;
  try {
    argv = JSON.parse(readFileSync(real(CLI_ARGV), "utf8")).map((a) => maskIds(String(a)));
  } catch {
    argv = null;
  }
  let system = null;
  let prompt = null;
  try {
    for (const line of readFileSync(real(CLI_LOG), "utf8").split("\n")) {
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type === "control_request" && m.request?.subtype === "initialize") {
        system = (m.request.systemPrompt ?? null) && m.request.systemPrompt.map(maskIds);
      }
      if (m.type === "user" && prompt === null) {
        const c = m.message?.content;
        prompt = maskIds(typeof c === "string" ? c : JSON.stringify(c ?? null));
      }
    }
  } catch {
    // no log: the query never launched
  }
  return { argv, system, prompt };
}

/** The newest publish id a 201 reported, for a `$PUB` in a path. */
let lastPub = "pub_none";

async function runRequest(s, tick) {
  const path = s.path.replaceAll("$PUB", lastPub);
  const [mod, params] = routeFor(path);
  const headers = {};
  let body;
  if (s.body !== undefined) {
    body = real(s.body);
    headers["content-type"] = "application/json";
  }
  const req = new NextRequest(`http://localhost${path}`, { method: s.method, headers, body });
  let got;
  try {
    const res = await mod.handle(req, context(params));
    got = { status: res.status, type: res.headers.get("content-type") };
    const others = [...res.headers.keys()].filter((k) => !["content-type", "set-cookie"].includes(k));
    if (others.length) got.headers = others;
    got.body = fake(Buffer.from(await res.arrayBuffer()).toString("utf8"));
    if (res.status === 201) {
      try {
        const parsed = JSON.parse(got.body);
        if (typeof parsed.id === "string" && parsed.id.startsWith("pub_")) lastPub = parsed.id;
      } catch {
        // not a publish
      }
    }
  } catch (e) {
    got = { threw: fake(e instanceof Error ? e.message : String(e)) };
  }
  // `s.path` keeps its `$PUB`: the replay has its own publish id.
  const step = { ...s, clock: BASE + tick * 1_000_003, got };
  if (path.endsWith("/description") && s.method === "POST") step.cli = readCli();
  return step;
}

/** Wait for a build to settle (the state the next GET records). */
async function waitForBuild(id) {
  for (let i = 0; i < 600; i++) {
    const st = build.getBuildState(id);
    if (!st || st.status !== "building") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`build ${id} never settled`);
}

const recorded = { steps: [], startup: [] };
let tick = 0;
let last = snapshot();
for (const section of ["steps", "startup"]) {
  const list = section === "steps" ? STEPS : STARTUP;
  for (const raw of list) {
    const s = { ...raw };
    if (s.op === "fs") {
      applyFs(s);
      recorded[section].push(s);
      last = snapshot();
      continue;
    }
    if (s.op === "db") {
      const handle = await db.openDb(real(s.cwd), "readwrite");
      handle.exec(real(s.sql));
      recorded[section].push(s);
      last = snapshot();
      continue;
    }
    if (s.op === "wait") {
      await waitForBuild(s.id);
      recorded[section].push(s);
      last = snapshot();
      continue;
    }
    if (s.op === "seedhash") {
      const text = JSON.stringify(
        {
          version: 1,
          customizations: [cust(P1)],
          publishes: [pub("pub_fresh", P1, { baseHash: await hash.hashTree(LIVE_REAL) })],
        },
        null,
        2,
      );
      const step = { op: "fs", act: "write", path: IDX, text };
      applyFs(step);
      recorded[section].push(step);
      last = snapshot();
      continue;
    }
    tick += 1;
    clock = BASE + tick * 1_000_003;
    logs.length = 0;
    let step;
    if (s.op === "req") {
      step = await runRequest(s, tick);
    } else {
      step = { op: "call", fn: s.fn, clock };
      try {
        if (s.fn === "isRunningInsideCustomizationMirror") {
          step.result = JSON.stringify(startup.isRunningInsideCustomizationMirror());
        } else {
          await startup[s.fn]();
        }
      } catch (e) {
        step.threw = fake(e instanceof Error ? e.message : String(e));
      }
      if (logs.length) step.logs = logs.map(fake);
    }
    const now = snapshot();
    changes(last, now, step);
    last = now;
    recorded[section].push(step);
  }
}

rmSync(shimDir, { recursive: true, force: true });
writeFileSync(
  join(ROOT, "out.json"),
  JSON.stringify({
    live: fake(runtimeDir.getLiveSourceDir()),
    prompt: settings.DEFAULT_AUTO_FIX_PROMPT,
    version: version.CLAUDIUS_VERSION,
    // The Rust test writes its `fakebin` from these, so there is one copy.
    fakes: { git: FAKE_GIT, node: FAKE_NODE },
    steps: recorded.steps,
    startup: recorded.startup,
  }),
);
