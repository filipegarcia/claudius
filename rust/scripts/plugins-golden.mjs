#!/usr/bin/env node
// Golden fixture for the plugins module and routes (G04), recorded from the
// TS sources:
//
//   node rust/scripts/plugins-golden.mjs     (node@22: session.ts needs
//                                             better-sqlite3, which bun can't
//                                             load; builds claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the extensionless / `@/` imports, twice (two temp roots, both through
// realpath); both recordings must agree byte for byte. The hook also maps
// session.ts's SDK import to a shim that calls the real `query()` with one
// option added, `pathToClaudeCodeExecutable` (the fake CLI). The child runs
// with its cwd at `<root>/project` (the first trusted root; db.ts reads its
// migrations from `project/lib`), HOME at `<root>/home`, CLAUDE_CONFIG_DIR at
// `<root>/config` and umask 022. `<root>/home/.claude/.claudius/
// workspaces.json` registers `<root>/ws` (with `<root>/ws-extra` as an
// additional directory) and `<root>/sess`, where the live sessions run.
//
// Records:
//
// - `module`: the pure helpers over hand-built inputs, each input as JSON
//   text and each result as `JSON.stringify` text (`null` for `undefined`):
//   `parseInitSystemMessage(..).pluginErrors` (`pluginErrors`),
//   `pluginSubdirFromSource` (`subdirs`), `mergePluginMeta` (`meta`),
//   `parseUserConfig` (`userConfig`), `setPluginOption` (`setOption`),
//   `lintMarketplaceName` (`lint`), `redactSource` (`redact`),
//   `readExtraMarketplaces` (`extra`), `readPolicyMarketplaces` (`policy`),
//   `validateAddSource` (`validate`), marketplace-settings'
//   `addExtraMarketplace` / `removeExtraMarketplace` /
//   `removePolicyMarketplace` (`addExtra`, `removeExtra`, `removePolicy`),
//   `isForceReload` (`force`) and `pluginSettingsWriteBlockedMessage`
//   (`blocked`); then `listAvailable()` over scripted homes (`available`:
//   the file operations under `$HOME`, then the list or `threw`) and
//   `enrichInstalled(raw)` over scripted plugin dirs (`enrich`, paths as
//   `$ROOT`).
// - `groups`: the real route handlers (`app/api/plugins/route.ts` GET /
//   POST, `available/route.ts` GET, `reload/route.ts` POST), called with
//   `Request` objects, in order on one world per group. A step is a `setup`
//   (file operations: `write` text or `bytes`, `mkdir`, `rm`, `symlink`,
//   `chmod`), a `wait` (until the session's `count`-th `system/init` is in
//   its buffer) or a request (`method`, `url`, `body`; `$ROOT` stands for
//   the root, `$LIVE` / `$OTHER` for the live sessions' ids). Each request
//   records `got` (status, content type and body text, or `threw`: Next's
//   empty 500), `changes` (every watched path whose entry differs from
//   before the request: kind, mode, UTF-8 text or raw bytes, symlink target;
//   `null` when gone) and `wire` (the `reload_plugins` control requests the
//   sessions' CLIs got, ids as `$ID`, sorted). A group with `sessions` runs
//   real `new Session({id, cwd: <root>/sess}).start()`s against the fake
//   CLI with the group's `script` (`$ROOT` swapped in), registered in
//   `sessionManager`: `two` starts `$LIVE` and `$OTHER`; `"none"`
//   is a session that never started (no query); `exited` waits for its CLI
//   to exit after `initialize`. `final` is every watched path at the end.
//
// Written to rust/crates/claudius-core/tests/fixtures/plugins_golden.json
// and replayed by crates/claudius-core/tests/plugins_golden.rs (module) and
// crates/claudius-server/tests/plugins.rs (groups, against the real binary).
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/plugins_golden.json");

/** Restore write/read permission under `dir` so it can be removed. */
function unlock(dir) {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return;
    chmodSync(dir, 0o755);
    if (st.isDirectory()) for (const e of readdirSync(dir)) unlock(join(dir, e));
  } catch {
    // gone already
  }
}

// ------------------------------- recording -------------------------------

if (!process.env.PLUGINS_GOLDEN_ROOT) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plugins-golden-")));
    try {
      // Placeholders are swapped textually in URLs, JSON text and files.
      if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error(`root needs escaping: ${root}`);
      mkdirSync(join(root, "project/lib/server"), { recursive: true });
      symlinkSync(join(repo, "lib/server/db-migrations"), join(root, "project/lib/server/db-migrations"));
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
            PLUGINS_GOLDEN_ROOT: root,
            PLUGINS_GOLDEN_FAKE: fake,
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
    const dump = mkdtempSync(join(tmpdir(), "plugins-golden-diff-"));
    runs.forEach((r, i) => writeFileSync(join(dump, `run${i}.json`), `${JSON.stringify(JSON.parse(r), null, 1)}\n`));
    throw new Error(`the two recordings differ (both in ${dump})`);
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.request).length, 0);
  const cases = Object.values(fixture.module).reduce((n, v) => n + (Array.isArray(v) ? v.length : v.cases.length), 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${cases} module cases, ${fixture.groups.length} groups (${steps} requests, SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.PLUGINS_GOLDEN_ROOT;
const HOME = process.env.HOME;
process.umask(0o022);

const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.PLUGINS_GOLDEN_FAKE } });
}
`,
);

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SHIM = ${JSON.stringify(pathToFileURL(shim).href)};
export async function resolve(spec, ctx, next) {
  if (spec === ${JSON.stringify(SDK)} && ctx.parentURL && ctx.parentURL.endsWith("/lib/server/session.ts")) {
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

const plugins = await import(join(repo, "lib/server/plugins.ts"));
const market = await import(join(repo, "lib/shared/marketplace-settings.ts"));
const pmeta = await import(join(repo, "lib/shared/plugin-metadata.ts"));
const pconfig = await import(join(repo, "lib/shared/plugin-config.ts"));
const { lintMarketplaceName } = await import(join(repo, "lib/shared/plugin-ref-lint.ts"));
const { parseInitSystemMessage } = await import(join(repo, "lib/shared/parse-init.ts"));
const { isForceReload } = await import(join(repo, "lib/shared/reload-plugins.ts"));
const { pluginSettingsWriteBlockedMessage } = await import(join(repo, "lib/shared/settings-load-error.ts"));
const pluginsRoute = await import(join(repo, "app/api/plugins/route.ts"));
const availableRoute = await import(join(repo, "app/api/plugins/available/route.ts"));
const reloadRoute = await import(join(repo, "app/api/plugins/reload/route.ts"));
const { Session } = await import(join(repo, "lib/server/session.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

/** Characters by code point, so this file stays ASCII. */
const U = (...cps) => String.fromCodePoint(...cps);
const J = (v) => JSON.stringify(v);
/** A result as `JSON.stringify` text, `null` for `undefined`. */
const S = (v) => (v === undefined ? null : JSON.stringify(v));
const EMOJI = U(0x1f600);
const NBSP = U(0xa0);
const NEL = U(0x85);
const BOM = U(0xfeff);
const E_ACUTE = U(0xe9);
const CJK = U(0x4e2d);

// ------------------------------ pure helpers ------------------------------

/** Each input is JSON text; `run` gets it parsed. */
const cases = (inputs, run) =>
  inputs.map((input) => {
    const text = typeof input === "string" ? input : J(input);
    return { in: text, out: run(JSON.parse(text)) };
  });

const PLUGIN_ERRORS = [
  {},
  { plugin_errors: null },
  { plugin_errors: "x" },
  { plugin_errors: 5 },
  { plugin_errors: {} },
  { plugin_errors: { 0: { plugin: "a", type: "t", message: "m" } } },
  { plugin_errors: [] },
  { plugin_errors: [{ plugin: "a@m", type: "path-not-found", message: "not found" }] },
  { plugin_errors: [{ plugin: "a@m", type: "generic-error", message: "boom", path: "/x/y" }] },
  { plugin_errors: [{ plugin: "a", type: "t", message: "m", path: "" }] },
  { plugin_errors: [{ plugin: "a", type: "t", message: "m", path: 5 }] },
  { plugin_errors: [{ plugin: "a", type: "t", message: "m", path: null }] },
  { plugin_errors: [{ plugin: "", type: "t", message: "m" }] },
  { plugin_errors: [{ plugin: "a", type: "", message: "m" }] },
  { plugin_errors: [{ plugin: "a", type: "t", message: "" }] },
  { plugin_errors: [{ type: "t", message: "m" }] },
  { plugin_errors: [{ plugin: "a", message: "m" }] },
  { plugin_errors: [{ plugin: "a", type: "t" }] },
  { plugin_errors: [{ plugin: 1, type: "t", message: "m" }] },
  { plugin_errors: [{ plugin: "a", type: ["t"], message: "m" }] },
  { plugin_errors: [{ plugin: "a", type: "t", message: { m: 1 } }] },
  { plugin_errors: [{ plugin: "a", type: "t", message: true }] },
  { plugin_errors: [null, 0, "s", true, [], ["a", "t", "m"], { plugin: "ok", type: "t", message: "m", extra: 1, path: "p" }] },
  { plugin_errors: [{ message: "m", path: "p", type: "t", plugin: "order" }] },
  { plugin_errors: [{ plugin: " ", type: " ", message: " " }] },
  { plugin_errors: [{ plugin: "inline[0]", type: "manifest-validation-error", message: `bad ${EMOJI} ${E_ACUTE}`, path: `/p/${CJK}` }] },
  { plugin_errors: [{ plugin: "a", type: "t", message: "m" }, { plugin: "a", type: "t", message: "m" }] },
  '{"plugin_errors":[{"plugin":"a","type":"t","message":"m","path":1e400}]}',
  '{"plugin_errors":[{"plugin":"a","type":"t","message":"m","path":"q","path":"r"}]}',
];

const SUBDIRS = [
  {},
  { source: null },
  { source: "" },
  { source: "plugins/foo" },
  { source: "./plugins/foo" },
  { source: "././x" },
  { source: "./" },
  { source: "." },
  { source: ".." },
  { source: " ./x" },
  { source: "./ x " },
  { source: "  " },
  { source: "./\t" },
  { source: "/abs/x" },
  { source: "../up" },
  { source: ".//x" },
  { source: ".\\x" },
  { source: "./.x" },
  { source: `x${NBSP}` },
  { source: `${BOM}x` },
  { source: `x${NEL}` },
  { source: `./${EMOJI}` },
  { source: 5 },
  { source: true },
  { source: [] },
  { source: ["x"] },
  { source: {} },
  { source: { path: "p" } },
  { source: { path: "./p" } },
  { source: { path: "" } },
  { source: { path: " " } },
  { source: { path: 5 } },
  { source: { path: null } },
  { source: { source: "git-subdir", path: "plugins/x", url: "u" } },
  { source: { source: "github", repo: "a/b" } },
];

const META = [
  {},
  { entry: {} },
  { manifest: {} },
  { entry: { description: "d", displayName: "n" } },
  { entry: { description: "d", displayName: "n" }, manifest: { description: "md", displayName: "mn" } },
  { entry: { description: "", displayName: " " }, manifest: { description: "md", displayName: "mn" } },
  { entry: { description: 5, displayName: null }, manifest: { description: "md", displayName: ["x"] } },
  { entry: null, manifest: { displayName: "x" } },
  { entry: [], manifest: [] },
  { entry: "s", manifest: "t" },
  { entry: { description: NBSP }, manifest: { description: NEL } },
  { entry: { description: BOM, displayName: `\n${EMOJI}\n` }, manifest: { description: " m " } },
  { entry: { displayName: "e" }, manifest: { description: "d", displayName: "m", name: "x" } },
  { entry: { description: "\t" }, manifest: { description: "\u2028" } },
];

const USER_CONFIGS = [
  "{}",
  "null",
  "[]",
  '"s"',
  "5",
  '{"userConfig":null}',
  '{"userConfig":[]}',
  '{"userConfig":"x"}',
  '{"userConfig":{}}',
  J({
    userConfig: {
      flag: { type: "boolean", title: "Flag", description: "A flag", default: true, sensitive: false },
      count: { type: "number", default: 3 },
      int: { type: "integer", default: 1.5 },
      list: { type: "array", default: ["a", "b"] },
      mixed: { type: "array", default: ["a", 1] },
      text: { type: "string", default: "x" },
      odd: { type: "object" },
      none: {},
      pick: { type: "string", options: ["a", "b"], default: "a" },
      empty: { type: "number", options: [] },
      notEnum: { type: "boolean", options: ["a", 1] },
      strOpts: { options: "a,b" },
      secret: { type: "string", sensitive: true },
      sensStr: { sensitive: "true" },
      sensNum: { sensitive: 1 },
      titled: { title: 5, description: ["d"] },
      defObj: { default: { a: 1 } },
      defNull: { default: null },
      defFalse: { type: "boolean", default: false },
      defZero: { type: "number", default: 0 },
      defEmpty: { default: "" },
      typeUpper: { type: "Boolean" },
    },
  }),
  J({ userConfig: { s: "str", n: 5, z: null, a: [], t: true, ok: { type: "boolean" } } }),
  '{"userConfig":{"b":{},"2":{"type":"number"},"10":{},"a":{},"1":{}}}',
  '{"userConfig":{"__proto__":{"type":"boolean"},"constructor":{"default":"c"},"toString":{}}}',
  '{"userConfig":{"inf":{"type":"number","default":1e400},"ninf":{"default":-1e400},"n":{"default":1.0},"e":{"default":1e21},"z":{"default":-0},"f":{"default":0.1}}}',
  '{"userConfig":{"a":{"type":"boolean"},"a":{"type":"number","default":2}}}',
  '{"userConfig":{"o":{"options":["x",null]}}}',
  J({ userConfig: { [`${E_ACUTE}${EMOJI}`]: { title: `t ${CJK}`, default: `d ${EMOJI}`, options: [EMOJI, ""] } } }),
];

const SET_OPTIONS = [
  { pluginId: "p@m", name: "a", value: "v" },
  { pluginId: "p@m", name: "a" },
  { configs: { "p@m": { options: { a: 1, b: 2 }, mcpServers: { s: { x: 1 } } }, "q@m": { options: { z: true } } }, pluginId: "p@m", name: "a", value: "new" },
  { configs: { "p@m": { options: { a: 1, b: 2 }, mcpServers: { s: { x: 1 } } } }, pluginId: "p@m", name: "a" },
  { configs: { "p@m": { options: { a: 1 }, mcpServers: { s: {} } } }, pluginId: "p@m", name: "a" },
  { configs: { "p@m": { options: { a: 1 } } }, pluginId: "p@m", name: "a" },
  { configs: { "p@m": { options: { a: 1 } }, "q@m": { options: { b: 1 } } }, pluginId: "p@m", name: "a" },
  { configs: { "p@m": { options: { a: 1 } } }, pluginId: "p@m", name: "missing" },
  { configs: { "p@m": { other: 1 } }, pluginId: "p@m", name: "a" },
  { configs: { "p@m": { other: 1 } }, pluginId: "p@m", name: "a", value: false },
  { configs: [{ options: { a: 1 } }], pluginId: "0", name: "a", value: 1 },
  { configs: "str", pluginId: "p", name: "a", value: 1 },
  { configs: null, pluginId: "p", name: "a", value: 1 },
  { configs: 5, pluginId: "p", name: "a" },
  { configs: { p: "str" }, pluginId: "p", name: "a", value: 1 },
  { configs: { p: ["x"] }, pluginId: "p", name: "a", value: 1 },
  { configs: { p: null }, pluginId: "p", name: "a" },
  { configs: { p: { options: [1] } }, pluginId: "p", name: "a", value: 1 },
  { configs: { p: { options: "x", keep: 1 } }, pluginId: "p", name: "a" },
  { pluginId: "p", name: "a", value: null },
  { pluginId: "p", name: "a", value: 0 },
  { pluginId: "p", name: "a", value: "" },
  { pluginId: "p", name: "a", value: ["x", "y"] },
  { pluginId: "p", name: "a", value: { nested: [1.5, null] } },
  '{"pluginId":"p","name":"a","value":1e400}',
  '{"pluginId":"p","name":"a","value":1.0}',
  '{"configs":{"p":{"options":{"n":1e2}}},"pluginId":"p","name":"m","value":1e21}',
  { pluginId: "__proto__", name: "a", value: 1 },
  '{"configs":{"__proto__":{"options":{"x":1}}},"pluginId":"__proto__","name":"a","value":1}',
  '{"configs":{"__proto__":{"options":{"x":1}}},"pluginId":"__proto__","name":"x"}',
  '{"configs":{"q":{"options":{"y":1}}},"pluginId":"__proto__","name":"a","value":1}',
  { pluginId: "p", name: "__proto__", value: { a: 1 } },
  { pluginId: "p", name: "__proto__", value: 5 },
  { pluginId: "p", name: "__proto__", value: null },
  '{"configs":{"p":{"options":{"__proto__":1,"b":2}}},"pluginId":"p","name":"__proto__","value":3}',
  '{"configs":{"p":{"options":{"__proto__":1}}},"pluginId":"p","name":"__proto__"}',
  { pluginId: "p", name: "constructor", value: 1 },
  { pluginId: "toString", name: "valueOf", value: 1 },
  { configs: { p: { options: { b: 1, 2: 2 } } }, pluginId: "p", name: "1", value: 1 },
  { configs: { b: {}, 2: { options: { x: 1 } } }, pluginId: "10", name: "a", value: 1 },
  { pluginId: "", name: "", value: "" },
  { pluginId: `${EMOJI}@m`, name: E_ACUTE, value: CJK },
];

const LINTS = [
  { name: "" },
  { name: "   " },
  { name: "my-mkt" },
  { name: " my-mkt " },
  { name: "a.b_c-1" },
  { name: "9lives" },
  { name: ".hidden" },
  { name: "-dash" },
  { name: "_under" },
  { name: "a b" },
  { name: "a/b" },
  { name: "a@b" },
  { name: "a..b" },
  { name: "a...b" },
  { name: "a." },
  { name: E_ACUTE },
  { name: `a${E_ACUTE}` },
  { name: "constructor" },
  { name: "toString" },
  { name: "valueOf" },
  { name: "hasOwnProperty" },
  { name: "isPrototypeOf" },
  { name: "propertyIsEnumerable" },
  { name: "toLocaleString" },
  { name: "prototype" },
  { name: "__proto__" },
  { name: "Constructor" },
  { name: "npm" },
  { name: "NPM" },
  { name: "Inline" },
  { name: "skills-dir" },
  { name: "synced" },
  { name: "claude-plugin-test" },
  { name: "pip" },
  { name: "uv" },
  { name: "cargo" },
  { name: "github" },
  { name: "gh" },
  { name: "builtin" },
  { name: "npm2" },
  { name: "healthcare" },
  { name: "Claude-Plugins-Official" },
  { name: "claude-plugins-official", source: { source: "github", repo: "anthropics/claude-plugins" } },
  { name: "claude-plugins-official", source: { source: "github", repo: "ANTHROPICS/x" } },
  { name: "claude-plugins-official", source: { source: "github", repo: " anthropics/x " } },
  { name: "claude-plugins-official", source: { source: "github", repo: "anthropics/x/y" } },
  { name: "claude-plugins-official", source: { source: "github", repo: "anthropics/" } },
  { name: "claude-plugins-official", source: { source: "github", repo: "anthropics/a:b" } },
  { name: "claude-plugins-official", source: { source: "github", repo: "anthropics/a b" } },
  { name: "claude-plugins-official", source: { source: "github", repo: "anthropicsx/y" } },
  { name: "claude-plugins-official", source: { source: "github", repo: `anthropics/${E_ACUTE}` } },
  { name: "claude-plugins-official", source: { source: "github", repo: `${E_ACUTE}nthropics/x` } },
  { name: "claude-plugins-official", source: { source: "url", url: "https://github.com/anthropics/x" } },
  { name: "claude-plugins-official", source: { source: "github", repo: 5 } },
  { name: "claude-plugins-official", source: "anthropics/x" },
  { name: "claude-plugins-official", source: ["github"] },
  { name: "agent-skills", source: { source: "github", repo: "anthropics/skills" } },
  { name: "claude-plugin-directory" },
  { name: "anthropic-marketplace" },
  { name: `my-mkt${NBSP}` },
  { name: `${BOM}my-mkt` },
  { name: `my-mkt${NEL}` },
];

const SOURCES = [
  null,
  "legacy-string",
  "",
  5,
  true,
  [],
  ["github"],
  {},
  { source: 5 },
  { source: null },
  { source: "github", repo: "o/r" },
  { source: "github", repo: "o/r", ref: "v1" },
  { source: "github", repo: "o/r", ref: "" },
  { source: "github", ref: "v1" },
  { source: "github", repo: 5, ref: 6 },
  { source: "url", url: "https://x/m.json", headers: { Authorization: "Bearer s3cret", "X-Key": "k" } },
  { source: "url", url: "https://x", headers: { b: 1, 2: 2, a: 3, 1: 4 } },
  { source: "url", headers: ["a"] },
  { source: "url", url: 5, headers: null },
  { source: "url", url: "u", headersHelper: "get-token.sh" },
  { source: "url", url: "u", headersHelper: "" },
  { source: "url", url: "u", headersHelper: 5 },
  { source: "git", url: "git@x:o/r.git" },
  { source: "npm", package: "@s/p" },
  { source: "npm", package: "@s/p", version: "1.2" },
  { source: "npm", version: "1.2" },
  { source: "file", path: "/m.json" },
  { source: "directory", path: "/dir" },
  { source: "hostPattern", hostPattern: "*.corp" },
  { source: "pathPattern", pathPattern: "/opt/**" },
  { source: "settings", name: "inline-mkt", plugins: [] },
  { source: "skills-dir", path: "/x" },
  { source: "future-kind", url: "u" },
  { source: "", url: "u" },
  { source: "GitHub", repo: "o/r" },
  { source: "github", repo: `${EMOJI}/r`, ref: CJK },
];

const EXTRAS = [
  {},
  { raw: null },
  { raw: "s" },
  { raw: 5 },
  { raw: true },
  { raw: [] },
  { raw: ["a", 1, null, "b", {}, ["c"], ""] },
  { raw: {} },
  { raw: { m: { source: { source: "github", repo: "o/r" } } } },
  { raw: { m: "str", n: null, o: 5, p: [], q: {}, r: { source: "legacy" }, s: { source: null }, t: { source: ["x"] } } },
  { raw: { b: { source: { source: "url", url: "u" } }, 2: {}, 1: {}, a: {} } },
  '{"raw":{"__proto__":{"source":{"source":"github","repo":"o/r"}},"x":{}}}',
  '{"raw":{"b":{"source":{"source":"url","url":"u","headers":{"z":1,"10":2,"2":3}}},"2":{},"1":{},"a":{}}}',
  { raw: { [EMOJI]: { source: { source: "npm", package: CJK } } } },
];

const POLICIES = [
  {},
  { raw: true },
  { raw: false },
  { raw: null },
  { raw: "s" },
  { raw: 5 },
  { raw: [] },
  { raw: [{ source: "github", repo: "o/*" }, "str", null, 5, {}, [], { source: "hostPattern", hostPattern: "h" }] },
  { raw: { 0: { source: "github", repo: "o/r" } } },
];

const VALIDATES = [
  ...SOURCES.map((source) => ({ source })),
  {},
  { source: { source: "github", repo: "a/b/c" } },
  { source: { source: "github", repo: "a/*" } },
  { source: { source: "github", repo: "*/b" } },
  { source: { source: "github", repo: "a/b*" } },
  { source: { source: "github", repo: "a /b" } },
  { source: { source: "github", repo: "a/ b" } },
  { source: { source: "github", repo: "/b" } },
  { source: { source: "github", repo: "a/" } },
  { source: { source: "github", repo: "a" } },
  { source: { source: "github", repo: "a/b\n" } },
  { source: { source: "github", repo: `a${NBSP}/b` } },
  { source: { source: "github", repo: `a${NEL}/b` } },
  { source: { source: "github", repo: `a/b${BOM}` } },
  { source: { source: "github", repo: `${E_ACUTE}/${EMOJI}` } },
  { source: { source: "url", url: "http://x" } },
  { source: { source: "url", url: "https://" } },
  { source: { source: "url", url: "http:/x" } },
  { source: { source: "url", url: "ftp://x" } },
  { source: { source: "url", url: "HTTP://x" } },
  { source: { source: "url", url: " https://x" } },
  { source: { source: "url" } },
];

const GH = { source: "github", repo: "o/r" };
const ADD_EXTRAS = [
  { name: "m", source: GH },
  { name: "  ", source: GH },
  { name: "", source: GH },
  { name: " m ", source: GH },
  { name: "m", source: { source: "url", url: "https://x/m.json", headers: { a: "b" } } },
  { name: "m", source: { source: "npm", package: "p" } },
  { name: "m" },
  { name: "m", source: null },
  { name: "m", source: [] },
  { name: ".bad", source: GH },
  { name: "toString", source: GH },
  { name: "npm", source: GH },
  { name: "healthcare", source: GH },
  { name: "healthcare", source: { source: "github", repo: "anthropics/health" } },
  { raw: ["legacy"], name: "m", source: GH },
  { raw: [], name: "m", source: GH },
  { raw: ["legacy"], name: ".bad", source: GH },
  { raw: ["legacy"], name: "m", source: { source: "npm" } },
  { raw: { m: {} }, name: "m", source: GH },
  { raw: { m: {} }, name: " m", source: GH },
  { raw: { M: {} }, name: "m", source: GH },
  { raw: { a: { source: GH, extra: 1 }, 2: {}, b: 5 }, name: "c", source: GH },
  { raw: { a: {} }, name: "10", source: GH },
  { raw: "str", name: "m", source: GH },
  { raw: null, name: "m", source: GH },
  { raw: 5, name: "m", source: GH },
  '{"raw":{"__proto__":{}},"name":"m","source":{"source":"github","repo":"o/r"}}',
  '{"name":"m","source":{"source":"github","repo":"o/r","n":1.0,"big":1e400}}',
];

const REMOVE_EXTRAS = [
  { name: "m" },
  { raw: null, name: "m" },
  { raw: "m", name: "m" },
  { raw: 5, name: "m" },
  { raw: ["m"], name: "m" },
  { raw: ["m", "n", "m", 5, null], name: "m" },
  { raw: ["n"], name: "m" },
  { raw: [], name: "m" },
  { raw: [1], name: "1" },
  { raw: { m: {} }, name: "m" },
  { raw: { m: {}, n: {} }, name: "m" },
  { raw: { m: {} }, name: "x" },
  { raw: {}, name: "x" },
  { raw: { m: {} }, name: " m" },
  { raw: { 2: 1, b: 2, 1: 3 }, name: "b" },
  { raw: { 2: 1, b: 2, 1: 3 }, name: "2" },
  '{"raw":{"__proto__":{},"m":1},"name":"__proto__"}',
  '{"raw":{"m":1},"name":"__proto__"}',
  { raw: { m: 1 }, name: "toString" },
];

const REMOVE_POLICIES = [
  { index: 0 },
  { raw: true, index: 0 },
  { raw: "s", index: 0 },
  { raw: [], index: 0 },
  { raw: ["a"], index: 0 },
  { raw: ["a", "b", "c"], index: 1 },
  { raw: ["a", "b", "c"], index: 2 },
  { raw: ["a", "b", "c"], index: 3 },
  { raw: ["a", "b", "c"], index: -1 },
  { raw: ["a", "b", "c"], index: 1.5 },
  '{"raw":["a","b"],"index":-0}',
  '{"raw":["a","b"],"index":1e400}',
  '{"raw":["a","b"],"index":-1e400}',
  '{"raw":["a","b"],"index":1.0}',
  '{"raw":["a","b"],"index":1e-300}',
  { raw: [null, { source: "github", repo: "o/r" }], index: 0 },
  { raw: { 0: "a" }, index: 0 },
];

const FORCES = [null, "", "1", "true", "TRUE", "True", "0", "false", "yes", " 1", "1 ", "01", "on", "1.0"];
const BLOCKED = [
  ["/a/.claude/settings.json", "Unexpected end of JSON input"],
  ["", ""],
  [`/p/${EMOJI}/settings.json`, `Unexpected token '${CJK}'`],
];

const moduleCases = {
  pluginErrors: cases(PLUGIN_ERRORS, (v) => S(parseInitSystemMessage(v).pluginErrors)),
  subdirs: cases(SUBDIRS, (v) => S(pmeta.pluginSubdirFromSource(v.source))),
  meta: cases(META, (v) => S(pmeta.mergePluginMeta(v.entry, v.manifest))),
  userConfig: cases(USER_CONFIGS, (v) => S(pconfig.parseUserConfig(v))),
  setOption: cases(SET_OPTIONS, (v) => S(pconfig.setPluginOption(v.configs, v.pluginId, v.name, v.value))),
  lint: cases(LINTS, (v) => S(lintMarketplaceName(v.name, v.source)?.message)),
  redact: cases(
    [
      ...SOURCES.map((source) => ({ source })),
      // Header names in JS key order (array indices first), from raw text.
      '{"source":{"source":"url","url":"u","headers":{"b":1,"2":2,"a":3,"1":4}}}',
    ],
    (v) => S(market.redactSource(v.source)),
  ),
  extra: cases(EXTRAS, (v) => S(market.readExtraMarketplaces(v.raw))),
  policy: cases(POLICIES, (v) => S(market.readPolicyMarketplaces(v.raw))),
  validate: cases(VALIDATES, (v) => S(market.validateAddSource(v.source))),
  addExtra: cases(ADD_EXTRAS, (v) => S(market.addExtraMarketplace(v.raw, v.name, v.source))),
  removeExtra: cases(REMOVE_EXTRAS, (v) => S(market.removeExtraMarketplace(v.raw, v.name))),
  removePolicy: cases(REMOVE_POLICIES, (v) => S(market.removePolicyMarketplace(v.raw, v.index))),
  force: FORCES.map((value) => ({ in: value, out: isForceReload(value) })),
  blocked: BLOCKED.map(([path, reason]) => ({ in: [path, reason], out: pluginSettingsWriteBlockedMessage(path, reason) })),
};

// ---------------------------- file operations ----------------------------

const toAbs = (s) => s.replaceAll("$ROOT", ROOT);
const W = (path, text) => ({ op: "write", path, text });
const WB = (path, bytes) => ({ op: "write", path, bytes });
const RM = (path) => ({ op: "rm", path });
const MK = (path) => ({ op: "mkdir", path });
const LN = (path, target) => ({ op: "symlink", path, target });
const CH = (path, mode) => ({ op: "chmod", path, mode });

/** Apply `op`, its path relative to `base`. */
function apply(base, op) {
  const p = join(base, op.path);
  switch (op.op) {
    case "write":
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, op.bytes ? Buffer.from(op.bytes) : toAbs(op.text));
      break;
    case "mkdir":
      mkdirSync(p, { recursive: true });
      break;
    case "rm":
      unlock(p);
      rmSync(p, { recursive: true, force: true });
      break;
    case "symlink":
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(toAbs(op.target), p);
      break;
    case "chmod":
      chmodSync(p, op.mode);
      break;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

// ------------------------------ listAvailable ------------------------------

const MK_DIR = ".claude/plugins/marketplaces";
const COUNTS = ".claude/plugins/install-counts-cache.json";
const mkt = (name, manifest) =>
  W(`${MK_DIR}/${name}/.claude-plugin/marketplace.json`, typeof manifest === "string" ? manifest : J(manifest));
const pj = (path, manifest) => W(path, typeof manifest === "string" ? manifest : J(manifest));

const FULL = {
  name: "full",
  displayName: "Full",
  description: "Everything",
  author: { name: "A", email: "a@x", n: 1.0 },
  category: "dev",
  homepage: "https://x",
  source: "./plugins/full",
  extra: 1,
};
const AVAILABLE = [
  ["no .claude", []],
  ["no marketplaces dir", [MK(".claude/plugins")]],
  ["empty marketplaces dir", [MK(MK_DIR)]],
  ["marketplaces is a file", [W(".claude/plugins/marketplaces", "x")]],
  ["marketplaces unreadable", [MK(`${MK_DIR}/m`), CH(MK_DIR, 0o000)]],
  ["entries", [mkt("m1", { name: "m1", plugins: [FULL, { name: "bare" }, { name: "" }, { name: 5 }, null, "s", [], { displayName: "no name" }] })]],
  [
    "author and fields",
    [
      mkt("m", {
        plugins: [
          { name: "a1", author: "" },
          { name: "a2", author: null },
          { name: "a3", author: ["x", 1] },
          { name: "a4", author: 5 },
          { name: "a5", author: true },
          { name: "a6", author: {} },
          { name: "a7", category: "", homepage: "" },
          { name: "a8", category: 5, homepage: null },
          { name: "a9", displayName: " ", description: "" },
          { name: "a10", displayName: 5, description: ["d"] },
        ],
      }),
    ],
  ],
  [
    "odd manifests",
    [
      MK(`${MK_DIR}/no-manifest`),
      W(`${MK_DIR}/bad/.claude-plugin/marketplace.json`, "{"),
      W(`${MK_DIR}/null/.claude-plugin/marketplace.json`, "null"),
      W(`${MK_DIR}/arr/.claude-plugin/marketplace.json`, "[]"),
      W(`${MK_DIR}/str/.claude-plugin/marketplace.json`, '"x"'),
      W(`${MK_DIR}/obj/.claude-plugin/marketplace.json`, '{"plugins":{"0":{"name":"x"}}}'),
      W(`${MK_DIR}/none/.claude-plugin/marketplace.json`, "{}"),
      W(`${MK_DIR}/bom/.claude-plugin/marketplace.json`, `${BOM}{"plugins":[{"name":"bom"}]}`),
      W(`${MK_DIR}/empty/.claude-plugin/marketplace.json`, ""),
      MK(`${MK_DIR}/dir/.claude-plugin/marketplace.json`),
      W(`${MK_DIR}/file-entry`, "x"),
      mkt("ok", { plugins: [{ name: "ok" }] }),
      LN(`${MK_DIR}/link`, `$HOME/${MK_DIR}/ok`),
      WB(`${MK_DIR}/latin/.claude-plugin/marketplace.json`, [...Buffer.from('{"plugins":[{"name":"l'), 0xe9, 0xff, ...Buffer.from('","description":"d"}]}')]),
    ],
  ],
  [
    "sort by installs then name",
    [
      mkt("m", {
        plugins: ["b", "a", "B", "A", "_x", "10", "9", E_ACUTE, "Zed", "a b", `a${U(1)}`, "a", "c", "d", "e", "f", "g", "h", "i", "j"].map(
          (name, i) => ({ name, description: `#${i}` }),
        ),
      }),
      mkt("n", { plugins: [{ name: "a" }, { name: "c" }, { name: "x" }] }),
      W(
        COUNTS,
        '{"counts":[{"plugin":"c@m","unique_installs":5},{"plugin":"c@n","unique_installs":7},{"plugin":"d@m","unique_installs":5},' +
          '{"plugin":"e@m","unique_installs":"9"},{"plugin":"f@m","unique_installs":-1},{"plugin":"g@m","unique_installs":1e400},' +
          '{"plugin":"h@m","unique_installs":-1e400},{"plugin":"i@m","unique_installs":-0},{"plugin":"j@m","unique_installs":0.5},' +
          '{"plugin":"x@n","unique_installs":1e400},{"plugin":"d@m","unique_installs":6},{"plugin":5,"unique_installs":1},' +
          '{"plugin":"a@n","unique_installs":1.0},{"plugin":"B@m","unique_installs":1e21},null,"s",{"unique_installs":3},{"plugin":"A@m"}]}',
      ),
    ],
  ],
  ["counts malformed", [mkt("m", { plugins: [{ name: "b" }, { name: "a" }] }), W(COUNTS, "{")]],
  ["counts null", [mkt("m", { plugins: [{ name: "b" }, { name: "a" }] }), W(COUNTS, "null")]],
  ["counts not an array", [mkt("m", { plugins: [{ name: "b" }, { name: "a" }] }), W(COUNTS, '{"counts":{"0":{"plugin":"a@m","unique_installs":1}}}')]],
  ["counts array file", [mkt("m", { plugins: [{ name: "b" }, { name: "a" }] }), W(COUNTS, '[{"plugin":"a@m","unique_installs":1}]')]],
  ["counts is a dir", [mkt("m", { plugins: [{ name: "b" }, { name: "a" }] }), MK(COUNTS)]],
  [
    "manifest fallback",
    [
      mkt("m", {
        plugins: [
          { name: "p1", source: "./plugins/p1" },
          { name: "p2", source: { source: "git-subdir", path: "plugins/p2", url: "u" } },
          { name: "p3", source: "plugins/p3", description: "entry wins" },
          { name: "p4", source: "plugins/p4", description: "d", displayName: "n" },
          { name: "p5", source: "plugins/p5" },
          { name: "p6", source: "plugins/p6" },
          { name: "p7", source: "plugins/p7" },
          { name: "p8", source: "../escape" },
          { name: "p9", source: "/abs" },
          { name: "p10", source: "." },
          { name: "p11", source: "plugins/p11/" },
          { name: "p12", source: "./" },
          { name: "p13", source: { source: "github", repo: "o/r" } },
          { name: "p14", source: "plugins/link" },
          { name: "p15", source: "plugins/p15", displayName: "keep" },
          { name: "p16", source: "plugins/missing" },
          { name: "p17", source: "plugins/p17" },
          { name: "p18", source: "plugins/../plugins/p1" },
          { name: "p19", source: " plugins/p1 " },
        ],
      }),
      pj(`${MK_DIR}/m/plugins/p1/.claude-plugin/plugin.json`, { description: "p1 d", displayName: "P1" }),
      pj(`${MK_DIR}/m/plugins/p2/plugin.json`, { description: "p2 bare", displayName: "P2" }),
      pj(`${MK_DIR}/m/plugins/p3/.claude-plugin/plugin.json`, { description: "manifest", displayName: "P3" }),
      pj(`${MK_DIR}/m/plugins/p4/.claude-plugin/plugin.json`, { description: "never read", displayName: "never" }),
      W(`${MK_DIR}/m/plugins/p5/.claude-plugin/plugin.json`, "{"),
      pj(`${MK_DIR}/m/plugins/p5/plugin.json`, { description: "second" }),
      W(`${MK_DIR}/m/plugins/p6/.claude-plugin/plugin.json`, "null"),
      pj(`${MK_DIR}/m/plugins/p6/plugin.json`, { displayName: "after null" }),
      W(`${MK_DIR}/m/plugins/p7/.claude-plugin/plugin.json`, '["array"]'),
      pj(`${MK_DIR}/m/plugins/p7/plugin.json`, { description: "unreached" }),
      pj(".claude/plugins/marketplaces/escape/plugin.json", { description: "escaped" }),
      pj(`${MK_DIR}/m/plugin.json`, { description: "root manifest", displayName: "Root" }),
      pj(`${MK_DIR}/m/plugins/p11/plugin.json`, { description: "slash" }),
      pj("elsewhere/plugin.json", { description: "via link", displayName: "Linked" }),
      LN(`${MK_DIR}/m/plugins/link`, "$HOME/elsewhere"),
      pj(`${MK_DIR}/m/plugins/p15/.claude-plugin/plugin.json`, { description: "  ", displayName: "ignored" }),
      MK(`${MK_DIR}/m/plugins/p17/.claude-plugin/plugin.json`),
      pj(`${MK_DIR}/m/plugins/p17/plugin.json`, { description: "dir skipped", displayName: 5 }),
    ],
  ],
  [
    "unicode",
    [
      mkt(`m ${E_ACUTE}`, { plugins: [{ name: `${EMOJI} plug`, description: `d ${CJK}` }, { name: `${E_ACUTE}a` }, { name: "ea" }] }),
      W(COUNTS, J({ counts: [{ plugin: `${EMOJI} plug@m ${E_ACUTE}`, unique_installs: 3 }] })),
    ],
  ],
];

const available = [];
for (const [i, [name, ops]] of AVAILABLE.entries()) {
  const home = join(ROOT, "avail", String(i));
  mkdirSync(home, { recursive: true });
  for (const op of ops) apply(home, { ...op, target: op.target?.replaceAll("$HOME", home) });
  process.env.HOME = home;
  let got;
  try {
    got = { out: J(await plugins.listAvailable()) };
  } catch (e) {
    got = { threw: `${e.name}: ${e.message}`.replaceAll(home, "$HOME") };
  }
  process.env.HOME = HOME;
  unlock(home);
  available.push({ name, ops, ...got });
}
moduleCases.available = available;

// ------------------------------ enrichInstalled ------------------------------

const ENRICH_OPS = [
  pj("e/p1/.claude-plugin/plugin.json", {
    description: "P1 desc",
    displayName: "P1",
    userConfig: { flag: { type: "boolean", default: true }, list: { type: "array" } },
  }),
  pj("e/p2/plugin.json", { description: "bare", userConfig: {} }),
  W("e/p3/.claude-plugin/plugin.json", "{"),
  pj("e/p3/plugin.json", { displayName: "P3", userConfig: { s: { type: "string", sensitive: true } } }),
  W("e/p4/.claude-plugin/plugin.json", '["arr"]'),
  W("e/p5/.claude-plugin/plugin.json", '{"userConfig":{"inf":{"type":"number","default":1e400},"n":{"default":1.0}}}'),
  W("e/p6/.claude-plugin/plugin.json", `${BOM}{"description":"bom"}`),
  pj("e/p6/plugin.json", { description: "after bom" }),
  pj("e/target/plugin.json", { description: "linked" }),
  LN("e/p7", "$ROOT/e/target"),
  W("e/p8/.claude-plugin/plugin.json", "5"),
  W("e/p8/plugin.json", '"str"'),
];
const ENRICH = [
  [],
  [null, 0, "s", true, [], ["name"], {}, { name: "" }, { name: 5 }, { name: null }],
  [{ name: "a" }],
  [{ name: "a", path: "", source: "", version: "" }],
  [{ name: "a", path: 5, source: 6, version: 7.0 }],
  [{ name: "p1", path: "$ROOT/e/p1", source: "p1@m", version: "1.0.0", extra: true }],
  [{ name: "p1", path: "$ROOT/e/p1", description: "item wins", displayName: " " }],
  [{ name: "p1", path: "$ROOT/e/p1/" }],
  [{ name: "p1", path: "$ROOT/e/./p1" }],
  [{ name: "p1", path: "$ROOT/e//p1" }],
  [{ name: "p1", path: "e/p1" }],
  [{ name: "p1", path: "$ROOT/e/p1/.." }],
  [{ name: "p2", path: "$ROOT/e/p2" }],
  [{ name: "p3", path: "$ROOT/e/p3" }],
  [{ name: "p4", path: "$ROOT/e/p4" }],
  [{ name: "p5", path: "$ROOT/e/p5" }],
  [{ name: "p6", path: "$ROOT/e/p6" }],
  [{ name: "p7", path: "$ROOT/e/p7" }],
  [{ name: "p8", path: "$ROOT/e/p8" }],
  [{ name: "gone", path: "$ROOT/e/missing" }],
  [
    { name: "p2", path: "$ROOT/e/p2", version: "2" },
    { name: "p1", path: "$ROOT/e/p1" },
    { name: "p2", path: "$ROOT/e/p2" },
  ],
  [{ version: "1", path: "$ROOT/e/p1", name: "order", source: "s" }],
  [{ name: `${EMOJI}`, description: CJK }],
];
const enrichBase = join(ROOT, "enrich");
mkdirSync(enrichBase);
for (const op of ENRICH_OPS) apply(ROOT, op);
const enrich = [];
for (const raw of ENRICH) {
  const text = J(raw);
  const res = await plugins.enrichInstalled(JSON.parse(toAbs(text)));
  enrich.push({ in: text, out: J(res).replaceAll(ROOT, "$ROOT") });
}
moduleCases.enrich = { ops: ENRICH_OPS, cases: enrich };

// --------------------------------- worlds ---------------------------------

const LIVE = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const SESS = join(ROOT, "sess");
const rel = (s) => s.replaceAll(ROOT, "$ROOT").replaceAll(LIVE, "$LIVE").replaceAll(OTHER, "$OTHER");

/** The watched paths: everything the routes could touch, and decoys. */
const WATCH = ["home", "project", "ws", "ws-extra", "untrusted"];
const SKIP = new Set(["home/.claude/.claudius", "home/.claude/projects", "project/lib"]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function snapshot() {
  const snap = {};
  const visit = (r) => {
    if (SKIP.has(r)) return;
    const abs = join(ROOT, r);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      snap[r] = { kind: "symlink", target: rel(readlinkSync(abs)) };
    } else if (st.isDirectory()) {
      snap[r] = { kind: "dir", mode: st.mode & 0o777 };
      let names = [];
      try {
        names = readdirSync(abs).sort();
      } catch {
        // unreadable: recorded without its entries
      }
      for (const e of names) visit(`${r}/${e}`);
    } else {
      let buf = null;
      try {
        buf = readFileSync(abs);
      } catch {
        // unreadable: recorded without its content
      }
      let text = null;
      try {
        text = buf === null ? null : utf8.decode(buf);
      } catch {
        // not UTF-8: recorded as bytes
      }
      const entry = { kind: "file", mode: st.mode & 0o777 };
      if (text !== null) entry.text = rel(text);
      else if (buf !== null) entry.bytes = [...buf];
      snap[r] = entry;
    }
  };
  for (const w of WATCH) visit(w);
  return snap;
}

function changes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => [k, after[k] ?? null]);
}

const WORLD = {
  dirs: ["home/.claude/.claudius", "project", "ws", "ws-extra", "untrusted", "sess", "config"],
  files: [
    [
      "home/.claude/.claudius/workspaces.json",
      `${JSON.stringify(
        {
          version: 1,
          workspaces: [
            {
              id: "wks_golden00001",
              name: "ws",
              rootPath: "$ROOT/ws",
              icon: { kind: "letter", letter: "W", color: "#d97757" },
              createdAt: 1,
              updatedAt: 1,
              defaults: { additionalDirectories: ["$ROOT/ws-extra"] },
            },
            {
              id: "wks_golden00002",
              name: "sess",
              rootPath: "$ROOT/sess",
              icon: { kind: "letter", letter: "S", color: "#d97757" },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        null,
        2,
      )}\n`,
    ],
    // A decoy nothing reads: the CLI config dir's settings.
    ["config/settings.json", '{"enabledPlugins":{"decoy@m":true}}\n'],
  ],
};

function buildWorld() {
  for (const d of [...WATCH, "sess", "config"]) {
    const abs = join(ROOT, d);
    unlock(abs);
    if (d === "project") {
      // This process's cwd (and db.ts's migrations): emptied, never removed.
      for (const e of readdirSync(abs)) if (e !== "lib") rmSync(join(abs, e), { recursive: true, force: true });
    } else {
      rmSync(abs, { recursive: true, force: true });
    }
  }
  for (const d of WORLD.dirs) mkdirSync(join(ROOT, d), { recursive: true });
  for (const [p, text] of WORLD.files) {
    mkdirSync(dirname(join(ROOT, p)), { recursive: true });
    writeFileSync(join(ROOT, p), toAbs(text));
  }
}

// --------------------------------- sessions ---------------------------------

const readLines = (f) => {
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** The `reload_plugins` control requests in `log` from line `from`, ids as `$ID`. */
const reloadWire = (log, from) =>
  readLines(log)
    .slice(from)
    .filter((l) => {
      const m = JSON.parse(l);
      return m.type === "control_request" && m.request?.subtype === "reload_plugins";
    })
    .map((l) => l.replace(JSON.stringify(JSON.parse(l).request_id), '"$ID"'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, pred) {
  for (let i = 0; i < 1000; i++) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const inits = (s) => s.buffer.filter((e) => e.type === "sdk" && e.message?.type === "system" && e.message?.subtype === "init").length;

let logs = 0;
/** A real session in `<root>/sess` against the fake CLI with `script`. */
async function startSession(id, script, kind) {
  const s = new Session({ id, cwd: SESS });
  const log = join(ROOT, `cli-${logs++}.log`);
  if (kind !== "none") {
    process.env.FAKE_CLAUDE_LOG = log;
    // `$ROOT` in the script is this root (the fake only fills `$SESSION_ID`).
    if (script) process.env.FAKE_CLAUDE_SCRIPT = toAbs(typeof script === "string" ? script : J(script));
    else delete process.env.FAKE_CLAUDE_SCRIPT;
    await s.start();
    delete process.env.FAKE_CLAUDE_LOG;
    delete process.env.FAKE_CLAUDE_SCRIPT;
    await until("the init", () => inits(s) >= 1);
    if (kind === "exited") {
      await until("the exit", () => s.buffer.some((e) => JSON.stringify(e).includes("exited with code 3")));
    }
  }
  sessionManager.sessions.set(id, s);
  return { s, log, started: kind !== "none" };
}

// --------------------------------- requests ---------------------------------

async function call(req) {
  if (!/^[\x21-\x7e]+$/.test(req.url) || req.url.includes("#")) throw new Error(`url must be plain ASCII: ${req.url}`);
  const init = { method: req.method };
  if (req.body !== undefined) init.body = toAbs(req.body).replaceAll("$LIVE", LIVE).replaceAll("$OTHER", OTHER);
  const url = toAbs(req.url).replaceAll("$LIVE", LIVE).replaceAll("$OTHER", OTHER);
  const request = new Request(`http://localhost${url}`, init);
  const path = req.url.split("?")[0];
  const route = { "/api/plugins": pluginsRoute, "/api/plugins/available": availableRoute, "/api/plugins/reload": reloadRoute }[path];
  try {
    const res = await route[req.method](request);
    return { status: res.status, type: res.headers.get("content-type"), body: rel(await res.text()) };
  } catch (e) {
    // The temp file of an atomic write is named after the pid and a counter.
    const text = rel(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    return { threw: text.replace(/\.tmp-\d+-\d+/g, ".tmp-$PID-$SEQ") };
  }
}

async function runGroup(group) {
  buildWorld();
  const live = [];
  for (const [id, name] of [
    [LIVE, "$LIVE"],
    [OTHER, "$OTHER"],
  ].slice(0, group.sessions ? (group.session === "two" ? 2 : 1) : 0)) {
    live.push({ name, ...(await startSession(id, group.script, group.session)) });
  }
  const steps = [];
  for (const step of group.steps) {
    if (step.setup) {
      for (const op of step.setup) apply(ROOT, op);
      steps.push(step);
      continue;
    }
    if (step.wait) {
      const s = live.find((l) => l.name === step.wait.session).s;
      await until("an init", () => inits(s) >= step.wait.count);
      steps.push(step);
      continue;
    }
    const before = snapshot();
    const from = live.map((l) => readLines(l.log).length);
    const got = await call(step);
    const after = snapshot();
    steps.push({
      request: { method: step.method, url: step.url, ...(step.body !== undefined ? { body: step.body } : {}) },
      got,
      changes: changes(before, after),
      wire: live.flatMap((l, i) => reloadWire(l.log, from[i])).sort(),
    });
  }
  for (const l of live) if (l.started) await l.s.end();
  sessionManager.sessions.clear();
  return {
    name: group.name,
    session: group.session ?? null,
    script: group.script === undefined ? null : typeof group.script === "string" ? group.script : J(group.script),
    steps,
    final: snapshot(),
  };
}

// ---------------------------------- steps ----------------------------------

const USER = "home/.claude/settings.json";
const PROJ = "project/.claude/settings.json";
const LOCAL = "project/.claude/settings.local.json";
const WSP = "ws/.claude/settings.json";
const SETUP = (...ops) => ({ setup: ops });
const CLEAN = SETUP(RM(USER), RM("project/.claude"), RM("ws/.claude"));

const GET = (query) => ({ method: "GET", url: `/api/plugins${query ? `?${query}` : ""}` });
const POST = (body) => ({ method: "POST", url: "/api/plugins", body: typeof body === "string" ? body : J(body) });
const AVAIL = () => ({ method: "GET", url: "/api/plugins/available" });
const RELOAD = (query) => ({ method: "POST", url: `/api/plugins/reload${query ? `?${query}` : ""}` });
const WAIT = (session, count) => ({ wait: { session, count } });

const toggle = (scope, pluginId, enabled, extra = {}) => POST({ kind: "toggle", scope, pluginId, enabled, ...extra });
const mops = (scope, op, extra = {}) => POST({ kind: "marketplaces", scope, op, ...extra });
const pcfg = (scope, pluginId, name, extra = {}) => POST({ kind: "plugin-config", scope, pluginId, name, ...extra });

const RICH = J({
  model: "opus",
  enabledPlugins: { "b@m": true, "a@m": false, "2": 1.0, "10": "yes", "z@m": null },
  extraKnownMarketplaces: {
    gh: { source: { source: "github", repo: "o/r", ref: "main" } },
    secret: { source: { source: "url", url: "https://x/m.json", headers: { Authorization: "Bearer s3cret", "X-Team": "t" }, headersHelper: "./tok.sh" } },
    npm: { source: { source: "npm", package: "@s/p", version: "1" } },
    odd: { source: "legacy" },
    none: {},
    "1": { source: { source: "directory", path: "/d" } },
  },
  strictKnownMarketplaces: [{ source: "hostPattern", hostPattern: "*.corp" }, "str", null],
  blockedMarketplaces: [{ source: "github", repo: "evil/*" }, { source: "url", url: "u", headers: { k: "v" } }],
  pluginConfigs: { "b@m": { options: { n: 1e21, f: 0.1, big: 12345678901234567890 }, mcpServers: { s: { x: 1.5 } } } },
  after: [1.5, -0.0],
});

const LISTING_STEPS = [
  // ---- cwd resolution ----
  GET(),
  GET("cwd="),
  GET("cwd=%20%09"),
  GET("cwd=$ROOT/ws"),
  GET("cwd=$ROOT/ws-extra"),
  GET("cwd=$ROOT/ws/"),
  GET("cwd=$ROOT/ws/../project"),
  GET("cwd=$ROOT/untrusted"),
  GET("cwd=$ROOT/nowhere"),
  GET("cwd=ws"),
  GET("cwd=$ROOT/ws&cwd=$ROOT/untrusted"),
  GET("sessionId=nope"),
  GET("sessionId="),
  GET("sessionId=nope&cwd=$ROOT/untrusted"),

  // ---- shapes ----
  SETUP(W(USER, RICH)),
  GET(),
  SETUP(W(PROJ, '{"enabledPlugins":["x@m",true],"pluginConfigs":["a"],"blockedMarketplaces":true}'), W(LOCAL, '{"enabledPlugins":"str","pluginConfigs":5,"strictKnownMarketplaces":true}')),
  GET(),
  SETUP(W(WSP, '{"enabledPlugins":null,"pluginConfigs":null,"strictKnownMarketplaces":false,"blockedMarketplaces":"x"}')),
  GET("cwd=$ROOT/ws"),
  CLEAN,
  SETUP(W(USER, J({ additionalMarketplaces: { alias: { source: { source: "github", repo: "a/b" } } }, allowedMarketplaces: [{ source: "npm", package: "p" }] }))),
  GET(),
  SETUP(W(USER, J({ extraKnownMarketplaces: { canon: {} }, additionalMarketplaces: { alias: {} }, strictKnownMarketplaces: [], allowedMarketplaces: [{ source: "x" }] }))),
  GET(),
  SETUP(W(USER, J({ extraKnownMarketplaces: null, additionalMarketplaces: { alias: {} }, strictKnownMarketplaces: null, allowedMarketplaces: true }))),
  GET(),
  SETUP(W(USER, J({ extraKnownMarketplaces: ["legacy-a", 5, "legacy-b"] }))),
  GET(),
  SETUP(W(USER, J({ additionalMarketplaces: ["only-alias"] }))),
  GET(),
  SETUP(W(USER, '{"enabledPlugins":{"__proto__":true,"x":true},"extraKnownMarketplaces":{"__proto__":{"source":{"source":"github","repo":"p/q"}}}}')),
  GET(),
  SETUP(W(USER, J({ enabledPlugins: { [`${EMOJI}@m`]: true }, extraKnownMarketplaces: { [CJK]: { source: { source: "github", repo: `${E_ACUTE}/r` } } } }))),
  GET(),
  // Keys out of JS order in the file: listed (and rewritten) in JS order.
  SETUP(
    W(
      USER,
      '{"enabledPlugins":{"b@m":true,"2":true,"a@m":false,"1":true},' +
        '"extraKnownMarketplaces":{"z":{"source":{"source":"url","url":"https://x","headers":{"x":"1","3":"2","1":"3"}}},"10":{},"1":{}},' +
        '"pluginConfigs":{"z":{},"5":{"options":{"y":1,"0":2}}},"b":1,"0":2}',
    ),
  ),
  GET(),
  POST({ kind: "toggle", scope: "user", pluginId: "c@m", enabled: true }),

  // ---- files that don't load or aren't objects ----
  SETUP(W(USER, "")),
  GET(),
  SETUP(W(USER, "{")),
  GET(),
  SETUP(W(USER, `${BOM}{}`)),
  GET(),
  SETUP(W(USER, '{"a":1,}')),
  GET(),
  SETUP(W(USER, '{"token":"hello secret" x}')),
  GET(),
  SETUP(W(USER, "{}"), W(PROJ, "nope"), W(LOCAL, "[1,")),
  GET(),
  SETUP(W(PROJ, "{}"), W(LOCAL, "{}"), W(USER, "null")),
  GET(),
  SETUP(W(USER, '"abc"')),
  GET(),
  SETUP(W(USER, '""')),
  GET(),
  SETUP(W(USER, "5")),
  GET(),
  SETUP(W(USER, "1e400")),
  GET(),
  SETUP(W(USER, "true")),
  GET(),
  SETUP(W(USER, "[1,2]")),
  GET(),
  SETUP(W(USER, '{"enabledPlugins":1e400,"pluginConfigs":{"p":{"options":{"n":1e400}}}}')),
  GET(),
  SETUP(RM(USER), MK(USER)),
  GET(),
  SETUP(RM(USER), W(USER, "{}"), CH(USER, 0o000)),
  GET(),
  SETUP(CH(USER, 0o644), RM("project/.claude"), W("project/.claude", "file")),
  GET(),
  GET("cwd=$ROOT/ws"),
  SETUP(RM("project/.claude"), LN(PROJ, "$ROOT/ws/target.json"), W("ws/target.json", '{"enabledPlugins":{"via-link@m":true}}')),
  GET(),
  SETUP(RM("ws/target.json")),
  GET(),
];

const WRITE_STEPS = [
  // ---- body and validation ----
  POST(""),
  POST("{"),
  POST("not json"),
  POST("null"),
  POST("[]"),
  POST('"user"'),
  POST("5"),
  POST("{}"),
  POST({ scope: "global", kind: "toggle", pluginId: "a" }),
  POST({ scope: "USER", kind: "toggle", pluginId: "a" }),
  POST({ scope: ["user"], kind: "toggle", pluginId: "a" }),
  POST({ scope: "user" }),
  POST({ scope: "user", kind: "nope" }),
  POST({ scope: "user", kind: ["toggle"] }),
  toggle("user", "a@m", true, { cwd: "$ROOT/untrusted" }),
  POST({ scope: "user", kind: "nope", cwd: "$ROOT/untrusted" }),
  POST({ scope: "local", kind: "toggle", cwd: "$ROOT/ws-extra" }),
  toggle("project", "a@m", true, { cwd: "$ROOT/nowhere" }),
  POST({ scope: "user", kind: "toggle" }),
  toggle("user", "", true),
  toggle("user", 0, true),
  toggle("user", false, true),
  toggle("user", null, true),
  POST({ scope: "user", kind: "marketplaces" }),
  mops("user", "nope"),
  mops("user", "add-extra"),
  mops("user", "add-extra", { name: 5, source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "m" }),
  mops("user", "add-extra", { name: "m", source: 0 }),
  mops("user", "add-extra", { name: "m", source: "" }),
  mops("user", "add-extra", { name: "m", source: null }),
  mops("user", "remove-extra"),
  mops("user", "remove-extra", { name: null }),
  mops("user", "remove-policy"),
  mops("user", "remove-policy", { list: "strict" }),
  mops("user", "remove-policy", { list: "strict", index: "0" }),
  mops("user", "remove-policy", { list: "strict", index: null }),
  mops("user", "remove-policy", { list: "other", index: 0 }),
  mops("user", "remove-policy", { list: ["strict"], index: 0 }),
  pcfg("user", 5, "a"),
  pcfg("user", "p", null),
  POST({ scope: "user", kind: "plugin-config" }),
  { method: "GET", url: "/api/plugins" },

  // ---- toggle ----
  toggle("user", "a@m", true),
  toggle("user", "b@m", 1),
  toggle("user", "c@m", "x"),
  toggle("user", "a@m", false),
  toggle("user", "zz@m", 0),
  toggle("user", "b@m", ""),
  toggle("user", "c@m"),
  toggle("project", "p@m", true),
  toggle("local", "l@m", true, { cwd: " " }),
  toggle("project", "w@m", true, { cwd: "$ROOT/ws" }),
  toggle("project", "w@m", true, { cwd: 5 }),
  toggle("user", 5, true),
  toggle("user", 1.5, true),
  toggle("user", true, true),
  toggle("user", [1, [2, null]], true),
  toggle("user", {}, true),
  toggle("user", { toString: "x" }, true),
  toggle("user", [{ toString: 1 }], true),
  POST('{"scope":"user","kind":"toggle","pluginId":1e400,"enabled":1e400}'),
  POST('{"scope":"user","kind":"toggle","pluginId":-1e400,"enabled":-1e400}'),
  POST('{"scope":"user","kind":"toggle","pluginId":1e21,"enabled":[]}'),
  POST('{"scope":"user","kind":"toggle","pluginId":"10","enabled":{}}'),
  POST('{"scope":"user","kind":"toggle","pluginId":"2","enabled":true}'),
  toggle("user", "__proto__", true),
  toggle("user", "constructor", true),
  toggle("user", "toString", true),
  toggle("user", `${EMOJI}@${CJK}`, true),
  POST(`${BOM}{"scope":"user","kind":"toggle","pluginId":"bom@m","enabled":true}`),
  POST(`{"scope":"user","kind":"toggle","pluginId":"dup@m","enabled":true,"scope":"local","kind":"plugin-config"}`),
  toggle("local", "x@m", true, { cwd: "$ROOT/ws-extra" }),
  toggle("user", "y@m", true, { cwd: null }),
  toggle("user", "y@m", false, { cwd: ["$ROOT/untrusted"] }),
  { method: "GET", url: "/api/plugins" },
  SETUP(W(USER, '{"z":1,"enabledPlugins":{"__proto__":true,"k":1.0},"n":1e2,"after":true}\n')),
  toggle("user", "__proto__", false),
  toggle("user", "__proto__", true),
  toggle("user", "k", false),
  SETUP(W(USER, '{"enabledPlugins":{"only@m":true},"keep":[1.0,1e21]}')),
  toggle("user", "only@m", false),
  toggle("user", "missing@m", false),
  SETUP(W(USER, '{"enabledPlugins":["x","y"]}')),
  toggle("user", "z", true),
  SETUP(W(USER, '{"enabledPlugins":"str"}')),
  toggle("user", "z", true),
  SETUP(W(USER, '"ab"')),
  toggle("user", "z", true),
  SETUP(W(USER, "[1,2]")),
  toggle("user", "z", true),
  SETUP(W(USER, "7")),
  toggle("user", "z", false),
  SETUP(W(USER, "null")),
  toggle("user", "z", true),
  toggle("user", { toString: 1 }, true),
  SETUP(W(USER, "{")),
  toggle("user", "z", true),
  toggle("user", { toString: 1 }, true),
  SETUP(W(USER, "")),
  toggle("user", "z", false),
  SETUP(W(USER, '{"x":1}'), CH("home/.claude", 0o555)),
  toggle("user", "z", true),
  SETUP(CH("home/.claude", 0o755), W(USER, '{"x":1}'), CH(USER, 0o600)),
  toggle("user", "z", true),
  SETUP(RM(USER), W("ws/real.json", '{"real":true}'), LN(USER, "$ROOT/ws/real.json")),
  toggle("user", "via@link", true),
  SETUP(RM(USER), RM("project/.claude"), W("project/.claude", "file")),
  toggle("project", "z", true),
  SETUP(RM("project/.claude")),

  // ---- marketplaces: add ----
  CLEAN,
  mops("user", "add-extra", { name: "gh", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "mine", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "mine", source: { source: "github", repo: "o/other" } }),
  mops("user", "add-extra", { name: `${E_ACUTE}`, source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "uni", source: { source: "github", repo: `${CJK}/${EMOJI}`, ref: NBSP } }),
  mops("user", "add-extra", { name: " url ", source: { source: "url", url: "https://x/m.json", n: 1.0 } }),
  mops("user", "add-extra", { name: "10", source: { source: "url", url: "http://x" } }),
  mops("user", "add-extra", { name: "  ", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: ".x", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "constructor", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "prototype", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "NPM", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "healthcare", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "healthcare", source: { source: "github", repo: "Anthropics/health" } }),
  mops("user", "add-extra", { name: "m", source: { source: "github", repo: "o/*" } }),
  mops("user", "add-extra", { name: "m", source: { source: "url", url: "ftp://x" } }),
  mops("user", "add-extra", { name: "m", source: { source: "npm", package: "p" } }),
  mops("user", "add-extra", { name: "m", source: ["github"] }),
  mops("user", "add-extra", { name: "m", source: "github" }),
  POST('{"scope":"user","kind":"marketplaces","op":"add-extra","name":"m","source":1e400}'),
  POST('{"scope":"user","kind":"marketplaces","op":"add-extra","name":"inf","source":{"source":"github","repo":"o/r","x":1e400}}'),
  mops("project", "add-extra", { name: "p", source: { source: "github", repo: "o/r" } }),
  mops("local", "add-extra", { name: "l", source: { source: "github", repo: "o/r" }, cwd: "$ROOT/ws" }),
  { method: "GET", url: "/api/plugins" },
  SETUP(W(USER, '{"a":1,"additionalMarketplaces":{"old":{"source":{"source":"github","repo":"o/r"}}},"z":2}')),
  mops("user", "add-extra", { name: "old", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: "new", source: { source: "github", repo: "o/r" } }),
  SETUP(W(USER, '{"additionalMarketplaces":{"old":{}},"extraKnownMarketplaces":{"canon":{}}}')),
  mops("user", "add-extra", { name: "old", source: { source: "github", repo: "o/r" } }),
  SETUP(W(USER, '{"extraKnownMarketplaces":["legacy"]}')),
  mops("user", "add-extra", { name: "m", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: ".bad", source: { source: "github", repo: "o/r" } }),
  SETUP(W(USER, '{"extraKnownMarketplaces":"str"}')),
  mops("user", "add-extra", { name: "m", source: { source: "github", repo: "o/r" } }),
  SETUP(W(USER, '{"extraKnownMarketplaces":{"__proto__":{"x":1}}}')),
  mops("user", "add-extra", { name: "m", source: { source: "github", repo: "o/r" } }),
  SETUP(W(USER, '"ab"')),
  mops("user", "add-extra", { name: "m", source: { source: "github", repo: "o/r" } }),
  SETUP(W(USER, "[1]")),
  mops("user", "add-extra", { name: "m", source: { source: "github", repo: "o/r" } }),
  SETUP(W(USER, "null")),
  mops("user", "add-extra", { name: "m", source: { source: "github", repo: "o/r" } }),
  SETUP(W(USER, "false")),
  mops("user", "add-extra", { name: "m", source: { source: "github", repo: "o/r" } }),
  SETUP(W(USER, "{ bad")),
  mops("user", "add-extra", { name: "m", source: { source: "github", repo: "o/r" } }),
  mops("user", "add-extra", { name: ".bad", source: { source: "github", repo: "o/r" } }),

  // ---- marketplaces: remove ----
  SETUP(W(USER, '{"x":1,"extraKnownMarketplaces":{"a":{},"b":{}},"y":2}')),
  mops("user", "remove-extra", { name: "a" }),
  mops("user", "remove-extra", { name: "nope" }),
  mops("user", "remove-extra", { name: "b" }),
  mops("user", "remove-extra", { name: "b" }),
  SETUP(W(USER, '{"additionalMarketplaces":{"a":{},"b":{}},"extraKnownMarketplaces":null}')),
  mops("user", "remove-extra", { name: "a" }),
  SETUP(W(USER, '{"additionalMarketplaces":{"a":{},"b":{}}}')),
  mops("user", "remove-extra", { name: "a" }),
  SETUP(W(USER, '{"extraKnownMarketplaces":["a","b","a",5]}')),
  mops("user", "remove-extra", { name: "a" }),
  mops("user", "remove-extra", { name: "b" }),
  SETUP(W(USER, '{"extraKnownMarketplaces":"a","n":1.0}')),
  mops("user", "remove-extra", { name: "a" }),
  SETUP(W(USER, '{"extraKnownMarketplaces":{"__proto__":{},"m":1}}')),
  mops("user", "remove-extra", { name: "__proto__" }),
  mops("user", "remove-extra", { name: "toString" }),
  SETUP(W(USER, '"ab"')),
  mops("user", "remove-extra", { name: "a" }),
  SETUP(W(USER, "null")),
  mops("user", "remove-extra", { name: "a" }),
  SETUP(W(USER, "[")),
  mops("user", "remove-extra", { name: "a" }),
  SETUP(RM(USER)),
  mops("user", "remove-extra", { name: "a" }),

  // ---- marketplaces: policy ----
  SETUP(W(USER, '{"strictKnownMarketplaces":["a","b","c"],"blockedMarketplaces":[{"source":"github","repo":"x/*"},"y"],"allowedMarketplaces":["alias"]}')),
  mops("user", "remove-policy", { list: "strict", index: 1 }),
  mops("user", "remove-policy", { list: "strict", index: 1.5 }),
  mops("user", "remove-policy", { list: "strict", index: -1 }),
  POST('{"scope":"user","kind":"marketplaces","op":"remove-policy","list":"strict","index":-0}'),
  POST('{"scope":"user","kind":"marketplaces","op":"remove-policy","list":"strict","index":1e400}'),
  mops("user", "remove-policy", { list: "strict", index: 0 }),
  mops("user", "remove-policy", { list: "blocked", index: 0 }),
  mops("user", "remove-policy", { list: "blocked", index: 0 }),
  mops("user", "remove-policy", { list: "blocked", index: 0 }),
  SETUP(W(USER, '{"allowedMarketplaces":["a","b"]}')),
  mops("user", "remove-policy", { list: "strict", index: 0 }),
  SETUP(W(USER, '{"strictKnownMarketplaces":true,"blockedMarketplaces":false}')),
  mops("user", "remove-policy", { list: "strict", index: 0 }),
  mops("user", "remove-policy", { list: "blocked", index: 0 }),
  SETUP(W(USER, '"ab"')),
  mops("user", "remove-policy", { list: "blocked", index: 0 }),
  SETUP(W(USER, '"ab"')),
  mops("user", "remove-policy", { list: "strict", index: 0 }),
  SETUP(W(USER, "1e400")),
  mops("user", "remove-policy", { list: "blocked", index: 0 }),
  SETUP(W(USER, "null")),
  mops("user", "remove-policy", { list: "strict", index: 0 }),
  mops("user", "remove-policy", { list: "blocked", index: 0 }),
  SETUP(W(USER, "nul")),
  mops("user", "remove-policy", { list: "blocked", index: 0 }),

  // ---- plugin options ----
  CLEAN,
  pcfg("user", "p@m", "a", { value: "x" }),
  pcfg("user", "p@m", "b", { value: 1.0 }),
  pcfg("user", "p@m", "c", { value: [1, "x"] }),
  pcfg("user", "p@m", "d", { value: { nested: true } }),
  pcfg("user", "p@m", "e", { value: null }),
  pcfg("user", "q@m", "z", { value: false }),
  POST('{"scope":"user","kind":"plugin-config","pluginId":"p@m","name":"inf","value":1e400}'),
  pcfg("user", "p@m", "a"),
  pcfg("user", "p@m", "missing"),
  pcfg("user", "q@m", "z"),
  pcfg("user", "p@m", "__proto__", { value: { a: 1 } }),
  pcfg("user", "__proto__", "a", { value: 1 }),
  pcfg("user", "p@m", "constructor", { value: "c" }),
  pcfg("local", "l@m", "a", { value: 1, cwd: "$ROOT/ws" }),
  SETUP(W(USER, '{"pluginConfigs":{"p@m":{"options":{"a":1},"mcpServers":{"s":{"t":1.0}}}},"k":1}')),
  pcfg("user", "p@m", "a"),
  SETUP(W(USER, '{"pluginConfigs":{"p@m":{"options":{"a":1}}},"k":1}')),
  pcfg("user", "p@m", "a"),
  SETUP(W(USER, '{"pluginConfigs":"str","k":1}')),
  pcfg("user", "p@m", "a", { value: 1 }),
  SETUP(W(USER, '{"pluginConfigs":["x"]}')),
  pcfg("user", "0", "a"),
  SETUP(W(USER, '"ab"')),
  pcfg("user", "p", "a", { value: 1 }),
  SETUP(W(USER, "null")),
  pcfg("user", "p", "a", { value: 1 }),
  SETUP(W(USER, "{,}")),
  pcfg("user", "p", "a", { value: 1 }),
  SETUP(RM(USER)),
];

const AVAILABLE_STEPS = [
  AVAIL(),
  SETUP(MK("home/.claude/plugins/marketplaces")),
  AVAIL(),
  SETUP(W("home/.claude/plugins/marketplaces/m/.claude-plugin/marketplace.json", J({ plugins: [{ name: "b" }, { name: "a", description: "A" }] })), W("home/.claude/plugins/install-counts-cache.json", J({ counts: [{ plugin: "b@m", unique_installs: 2 }] }))),
  AVAIL(),
  { method: "GET", url: "/api/plugins/available?x=1" },
  SETUP(RM("home/.claude/plugins/marketplaces"), W("home/.claude/plugins/marketplaces", "x")),
  AVAIL(),
  SETUP(RM("home/.claude/plugins/marketplaces"), MK("home/.claude/plugins/marketplaces"), CH("home/.claude/plugins/marketplaces", 0o000)),
  AVAIL(),
  SETUP(CH("home/.claude/plugins/marketplaces", 0o755)),
];

/** A plugin dir under the root for the live replies (`installed` reads it). */
const PLUGIN_DIRS = SETUP(
  pj("ws/plugins/p1/.claude-plugin/plugin.json", { description: "P1 from manifest", displayName: "P1", userConfig: { level: { type: "number", default: 2 } } }),
  pj("ws/plugins/p2/plugin.json", { displayName: "P2" }),
);
const INIT_ERRORS = [
  { plugin: "broken@m", type: "manifest-validation-error", message: "bad manifest" },
  { plugin: "inline[0]", type: "path-not-found", message: "no dir", path: "/nowhere" },
  { plugin: "", type: "t", message: "dropped" },
  { plugin: "x@m", type: "hook-load-failed", message: "hooks", path: "" },
  "junk",
];
const INSTALLED = [
  { name: "p1", path: "$ROOT/ws/plugins/p1", source: "p1@m", version: "1.0.0" },
  { name: "p2", path: "$ROOT/ws/plugins/p2", description: "from the CLI" },
  { name: "who", source: "$SESSION_ID" },
  { name: "" },
  "junk",
];
/** The CLI's `reload_plugins` replies, in the order the steps ask for them. */
const REPLIES = [
  { plugins: INSTALLED, error_count: 2, commands: [], agents: [], mcpServers: [] },
  { plugins: INSTALLED, error_count: 0 },
  { held: true, cache_impact: { mcp_servers_added: ["a"], lsp_tool_change: "adds" }, n: 1.5, "2": true, big: 1e21 },
  { plugins: [], error_count: "0" },
  { plugins: [], error_count: 1 },
  "str",
  { error_count: 0 },
  [1, 2],
  5,
  { plugins: { p: 1 }, error_count: false },
  null,
  null,
  { $error: "reload failed: boom" },
  {
    $response: { plugins: [{ name: "after-init" }], error_count: 3 },
    $emit: [{ type: "system", subtype: "init", plugin_errors: [{ plugin: "new@m", type: "generic-error", message: "re-init" }] }],
  },
  { plugins: [], error_count: 1 },
  { $response: { plugins: [] }, $emit: [{ type: "system", subtype: "init" }] },
  { plugins: [{ name: "next-but-last" }], error_count: 1 },
  { $error: "" },
  { plugins: [{ name: "last" }], error_count: 1 },
];
const LIVE_SCRIPT = { init: { plugin_errors: INIT_ERRORS }, control: { reload_plugins: { $sequence: REPLIES } } };
const LIVE_STEPS = [
  PLUGIN_DIRS,
  GET("sessionId=$LIVE"),
  GET("sessionId=$OTHER"),
  GET("sessionId=$LIVE&cwd=$ROOT/ws"),
  RELOAD("sessionId=$LIVE"),
  GET("sessionId=$LIVE"),
  RELOAD("sessionId=$LIVE&force=1"),
  RELOAD("sessionId=$LIVE&force=true"),
  GET("sessionId=$LIVE"),
  RELOAD("sessionId=$LIVE&force=TRUE"),
  RELOAD("sessionId=$LIVE&force=0&force=1"),
  GET("sessionId=$LIVE"),
  RELOAD("sessionId=$LIVE&force="),
  GET("sessionId=$LIVE"),
  GET("sessionId=$LIVE"),
  GET("sessionId=$LIVE"),
  WAIT("$LIVE", 2),
  GET("sessionId=$LIVE"),
  RELOAD("sessionId=$LIVE&force=1&force=0"),
  WAIT("$LIVE", 3),
  GET("sessionId=$LIVE"),
  RELOAD("sessionId=$LIVE"),
  GET("sessionId=$LIVE&cwd=$ROOT/untrusted"),
  SETUP(W(USER, "null")),
  GET("sessionId=$LIVE"),
  SETUP(RM(USER)),
  RELOAD(),
  RELOAD("sessionId="),
  RELOAD("sessionId=nope"),
  RELOAD("sessionid=$LIVE"),
  RELOAD("force=1"),
  { method: "POST", url: "/api/plugins/reload?sessionId=$LIVE", body: "{" },
  GET("sessionId=$LIVE"),
  GET("sessionId=$OTHER"),
  RELOAD("sessionId=$OTHER&force=1"),
];

const NONE_STEPS = [GET("sessionId=$LIVE"), RELOAD("sessionId=$LIVE"), RELOAD("sessionId=$LIVE&force=1")];
const EXIT_SCRIPT = { init: { plugin_errors: [{ plugin: "e@m", type: "t", message: "before exit" }] }, on_init: [{ $stderr: "boom" }, { $exit: 3 }] };
const EXITED_STEPS = [GET("sessionId=$LIVE"), RELOAD("sessionId=$LIVE"), RELOAD("sessionId=$LIVE&force=true")];

const GROUPS = [
  { name: "listing", steps: LISTING_STEPS },
  { name: "writes", steps: WRITE_STEPS },
  { name: "available", steps: AVAILABLE_STEPS },
  { name: "live", sessions: true, session: "two", script: LIVE_SCRIPT, steps: LIVE_STEPS },
  { name: "no query", sessions: true, session: "none", steps: NONE_STEPS },
  { name: "exited", sessions: true, session: "exited", script: EXIT_SCRIPT, steps: EXITED_STEPS },
];

const groups = [];
for (const g of GROUPS) groups.push(await runGroup(g));

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT, "out.json"), JSON.stringify({ sdkVersion, module: moduleCases, world: WORLD, groups }));
process.exit(0);
