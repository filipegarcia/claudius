#!/usr/bin/env node
// Golden fixture for the sessionless model routes (G06):
// `GET /api/models` (`app/api/models/route.ts`) with
// `lib/server/model-picker-curation.ts` and the user settings it reads, and
// `GET /api/models/probe` (`app/api/models/probe/route.ts`).
//
//   node rust/scripts/models-golden.mjs     (node@22; builds claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR at a temp dir and a resolve hook for the `@/` imports.
// The hook also maps the SDK import of the probe route to a shim that calls
// the real `query()` with one option added, `pathToClaudeCodeExecutable`
// (`$MODELS_GOLDEN_BIN`): the route passes none, so the SDK would look for its
// own binary. Everything else runs as is.
//
// The "binary" is `wrapper` (below, also in the fixture so the replay writes
// the same file): a shell script that picks the fake CLI's script by the
// `--model=` it was given (`scripts/<model>.json`, else `scripts/default.json`)
// and logs that model's argv, env and stdin under `wire/`.
//
// Records:
// - `curation`: `applyModelPickerCuration(models, picker)` over model lists
//   and pickers, as `JSON.stringify` text or the thrown message.
// - `fallback`: the real `GET /api/models` with no live session, one user
//   settings.json per request (text, raw bytes, a directory, unreadable, a
//   symlink, ...).
// - `sessions`: the same handler with live sessions: `sessionManager` holds
//   one stub per session (`{id, query}`) whose `query` is a real SDK query
//   against the fake CLI (streaming input that never yields), in insertion
//   order, each with its own scripted `initialize` reply. Each request is
//   followed by `GET /api/sessions/:id/model` for every session
//   (`perSession`), which shares the curation.
// - `probe`: the real `GET /api/models/probe`, one script per candidate
//   model: the body, and per candidate the CLI's argv, the env the SDK added
//   or removed (`env`), and its stdin (request ids numbered), normalized.
// Each `got` is the status, content type and body text, or `threw` (Next's
// empty 500).
//
// Written to rust/crates/claudius-core/tests/fixtures/models_golden.json;
// replayed by crates/claudius-core/tests/models_golden.rs (`curation`) and
// crates/claudius-server/tests/models.rs (the routes, on the real binary).
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/models_golden.json");

if (!process.env.MODELS_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "models-golden-")));
  const result = join(root, "fixture.json");
  try {
    for (const d of ["home", "config", "project", "wrap"]) mkdirSync(join(root, d));
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      {
        cwd: join(root, "project"),
        stdio: "inherit",
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: join(root, "config"),
          MODELS_GOLDEN_CHILD: "1",
          MODELS_GOLDEN_ROOT: root,
          MODELS_GOLDEN_OUT: result,
          MODELS_WRAP_DIR: join(root, "wrap"),
          MODELS_WRAP_FAKE: join(rustDir, "target/debug/claudius-fake-claude"),
        },
      },
    );
    if (r.status !== 0) process.exit(r.status ?? 1);
    const fixture = JSON.parse(readFileSync(result, "utf8"));
    writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
    console.log(
      `wrote ${out}: ${fixture.curation.length} curations, ${fixture.fallback.length} fallback requests, ` +
        `${fixture.sessions.length} session scenarios, ${fixture.probe.length} probe requests (SDK ${fixture.sdkVersion})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

// ---- child -------------------------------------------------------------------

const ROOT = process.env.MODELS_GOLDEN_ROOT;
// The env before any SDK call: `query()` writes its version into
// `process.env` itself, and the CLI's env is compared against this one.
const START_ENV = { ...process.env };
const WRAP = process.env.MODELS_WRAP_DIR;
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.MODELS_GOLDEN_BIN } });
}
`,
);
const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SHIM = ${JSON.stringify(pathToFileURL(shim).href)};
export async function resolve(spec, ctx, next) {
  if (spec === ${JSON.stringify(SDK)} && ctx.parentURL && ctx.parentURL.endsWith("/app/api/models/probe/route.ts")) {
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

const { applyModelPickerCuration } = await import(join(repo, "lib/server/model-picker-curation.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const modelsRoute = await import(join(repo, "app/api/models/route.ts"));
const probeRoute = await import(join(repo, "app/api/models/probe/route.ts"));
const sessionModelRoute = await import(join(repo, "app/api/sessions/[id]/model/route.ts"));
const { query } = await import(SDK);
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;
// The session route logs each 503's error; the fixture has them.
console.error = () => {};

const WRAPPER =
  [
    "#!/bin/sh",
    "# The claude binary of the models golden: the fake CLI, with its script",
    "# picked by --model= and that model's argv, env and stdin logged.",
    'model=""',
    'for a in "$@"; do',
    '  case "$a" in',
    '    --model=*) model="${a#--model=}" ;;',
    "  esac",
    "done",
    'd="$MODELS_WRAP_DIR"',
    's="$d/scripts/$model.json"',
    '[ -n "$model" ] && [ -f "$s" ] || s="$d/scripts/default.json"',
    'w="$d/wire/$model"',
    'FAKE_CLAUDE_SCRIPT="$s" FAKE_CLAUDE_ARGV="$w.argv.json" FAKE_CLAUDE_ENV="$w.env.json" FAKE_CLAUDE_LOG="$w.stdin.log"',
    "export FAKE_CLAUDE_SCRIPT FAKE_CLAUDE_ARGV FAKE_CLAUDE_ENV FAKE_CLAUDE_LOG",
    'exec "$MODELS_WRAP_FAKE" "$@"',
  ].join("\n") + "\n";
const wrapper = join(WRAP, "claude");
writeFileSync(wrapper, WRAPPER);
chmodSync(wrapper, 0o755);
/** What /bin/sh itself may add to the env it execs with (and macOS adds
 *  `__CF_USER_TEXT_ENCODING`, left out below). */
const SHELL_ADDED = ["OLDPWD", "PWD", "SHLVL", "_"];

/** `scripts/<model>.json` for each entry, plus `default.json`; a fresh `wire/`. */
function writeScripts(scripts) {
  rmSync(join(WRAP, "scripts"), { recursive: true, force: true });
  rmSync(join(WRAP, "wire"), { recursive: true, force: true });
  mkdirSync(join(WRAP, "scripts"));
  mkdirSync(join(WRAP, "wire"));
  writeFileSync(join(WRAP, "scripts", "default.json"), "{}");
  for (const [model, script] of Object.entries(scripts)) {
    writeFileSync(join(WRAP, "scripts", `${model}.json`), typeof script === "string" ? script : JSON.stringify(script));
  }
}

const norm = (value) => {
  if (typeof value === "string") return value.split(ROOT).join("$TMP");
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v)]));
  return value;
};
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

/** A route's response, or `threw` for Next's empty 500. */
async function call(fn) {
  try {
    const res = await fn();
    return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}

// ---- user settings.json --------------------------------------------------------

const claudeDir = join(process.env.HOME, ".claude");
const settingsPath = join(claudeDir, "settings.json");
/** Lay out `~/.claude/settings.json` as `spec` says (see the Rust replay). */
function applySettings(spec) {
  if (spec.kind === "nodir") {
    rmSync(claudeDir, { recursive: true, force: true });
    return;
  }
  mkdirSync(claudeDir, { recursive: true });
  for (const f of ["settings.json", "real.json"]) rmSync(join(claudeDir, f), { recursive: true, force: true });
  switch (spec.kind) {
    case "missing":
      return;
    case "text":
      writeFileSync(settingsPath, spec.text);
      return;
    case "bytes":
      writeFileSync(settingsPath, Buffer.from(spec.bytes));
      return;
    case "dir":
      mkdirSync(settingsPath);
      return;
    case "unreadable":
      writeFileSync(settingsPath, spec.text);
      chmodSync(settingsPath, 0);
      return;
    case "symlink":
      writeFileSync(join(claudeDir, "real.json"), spec.text);
      symlinkSync("real.json", settingsPath);
      return;
    case "dangling":
      symlinkSync("real.json", settingsPath);
      return;
    default:
      throw new Error(`unknown settings kind ${spec.kind}`);
  }
}
const T = (text) => ({ kind: "text", text });
const MP = (modelPicker) => T(JSON.stringify({ modelPicker }));
const E = (...entries) => MP({ entries });
const ascii = (s) => [...Buffer.from(s, "latin1")];

// ---- curation ----------------------------------------------------------------

const PICKERS = [
  undefined,
  null,
  {},
  [],
  [{ id: "x" }],
  "entries",
  5,
  0,
  true,
  false,
  { entries: null },
  { entries: [] },
  { entries: {} },
  { entries: "abc" },
  { entries: "" },
  { entries: 0 },
  { entries: 7 },
  { entries: false },
  { entries: true },
  { entries: { length: 1, 0: { id: "x" } } },
  { entries: [{ id: "my-model" }] },
  { entries: [{ id: "my-model", label: "  My Model  " }] },
  { entries: [{ id: "a", label: "" }, { id: "b", label: "   " }, { id: "c", label: null }, { id: "d" }] },
  { entries: [{ id: "a", label: 5 }] },
  { entries: [{ id: "a", label: true }] },
  { entries: [{ id: "a", label: false }] },
  { entries: [{ id: "a", label: 0 }] },
  { entries: [{ id: "a", label: {} }] },
  { entries: [{ id: "a", label: [] }] },
  { entries: [{ id: "a", label: "\u00a0Lbl\ufeff" }, { id: "b", label: "\u0085Nel\u0085" }, { id: "c", label: "\u200bZw" }] },
  { entries: [{ id: "a", label: "\u2028\u3000\u1680x\u205f\t\n" }, { id: "b", label: "\ud83d\ude80 Rocket \u00e9t\u00e9" }] },
  { entries: [{ id: "" }, { id: "   " }, { id: "\u00a0" }, { id: "\ufeff" }, { id: "\u2028\u3000" }, { id: "kept" }] },
  { entries: [{ id: "\u0085" }, { id: "\u200b" }, { id: "\u180e" }, { id: " padded " }] },
  { entries: [{ id: 0 }, { id: false }, { id: null }, { id: "ok" }] },
  { entries: [{ id: 5 }] },
  { entries: [{ id: true }] },
  { entries: [{ id: {} }] },
  { entries: [{ id: [] }] },
  { entries: [{ id: ["x"] }] },
  { entries: [{ id: "ok" }, { id: 5 }] },
  { entries: [null] },
  { entries: [{ id: "first" }, null] },
  { entries: [5, "str", true, false, 0, [], {}, [{ id: "inner" }], { id: "kept" }] },
  { entries: [{ id: "a" }, { id: "a", label: "A again" }] },
  { entries: [{ id: "sonnet" }, { id: "Sonnet" }, { id: "default" }, { id: "new" }] },
  { entries: [{ id: "x" }, { id: "a" }] },
  { entries: [{ id: "5" }, { id: "null" }, { id: "undefined" }] },
  { mode: "replace", entries: [{ id: "r1" }, { id: "r2", label: "R2" }] },
  { mode: "replace", entries: [] },
  { mode: "replace", entries: [{ id: "" }, { id: " " }] },
  { mode: "replace", entries: [{ id: "sonnet" }, { id: "sonnet" }] },
  { mode: "replace", entries: [null] },
  { mode: "replace", entries: [{ id: "r", label: 5 }] },
  { mode: "replace" },
  { mode: "Replace", entries: [{ id: "r" }] },
  { mode: "append", entries: [{ id: "r" }] },
  { mode: " replace", entries: [{ id: "r" }] },
  { mode: 5, entries: [{ id: "r" }] },
  { mode: null, entries: [{ id: "r" }] },
  { mode: ["replace"], entries: [{ id: "r" }] },
  { mode: { replace: true }, entries: [{ id: "r" }] },
  { entries: [{ id: "x", label: "X", extra: { nested: [1, 2] } }], extra: true },
  { entries: Array.from({ length: 40 }, (_, i) => ({ id: `bulk-${i}`, ...(i % 3 ? { label: `Bulk ${i}` } : {}) })) },
];
const MODEL_LISTS = [
  [],
  [
    { value: "default", displayName: "Default (recommended)", description: "d" },
    { value: "sonnet", displayName: "Sonnet", description: "s" },
  ],
  [{ value: "a" }, { value: "b", displayName: "B" }],
  [null, { value: "a" }],
  [5, "a", { value: 5 }, { value: null }, {}, [], { value: "x" }],
  [{ value: "x", resolvedModel: "claude-x-1", extra: { nested: [1, 2.5] }, supportsEffort: true }],
];
const curation = [];
for (const models of MODEL_LISTS) {
  for (const picker of PICKERS) {
    let got;
    try {
      got = { ok: JSON.stringify(applyModelPickerCuration(structuredClone(models), structuredClone(picker))) };
    } catch (e) {
      got = { threw: e.message, type: e.constructor.name };
    }
    curation.push({ models, ...(picker === undefined ? {} : { picker }), got });
  }
}

// ---- GET /api/models without a session ------------------------------------------

const deep = (n) => "[".repeat(n) + "]".repeat(n);
const FALLBACK = [
  ["no .claude dir", { kind: "nodir" }],
  ["no settings.json", { kind: "missing" }],
  ["empty object", T("{}")],
  ["empty file", T("")],
  ["whitespace only", T(" \n\t")],
  ["malformed", T("{")],
  ["trailing garbage", T('{"modelPicker":{"entries":[{"id":"x"}]}} x')],
  ["a BOM before valid JSON", T('\ufeff{"modelPicker":{"entries":[{"id":"bom-model"}]}}')],
  ["padded valid JSON", T(' \n {"modelPicker" : {"entries" : [ {"id" : "padded"} ]}} \n')],
  ["the file is null", T("null")],
  ["the file is a number", T("5")],
  ["the file is a string", T('"modelPicker"')],
  ["the file is true", T("true")],
  ["the file is an array", T('[{"modelPicker":{"entries":[{"id":"x"}]}}]')],
  ["a directory", { kind: "dir" }],
  ["unreadable", { kind: "unreadable", text: JSON.stringify({ modelPicker: { entries: [{ id: "hidden" }] } }) }],
  ["a symlink", { kind: "symlink", text: JSON.stringify({ modelPicker: { entries: [{ id: "linked", label: "Linked" }] } }) }],
  ["a dangling symlink", { kind: "dangling" }],
  [
    "non-UTF-8 bytes in a label",
    { kind: "bytes", bytes: [...ascii('{"modelPicker":{"entries":[{"id":"bytes","label":"a'), 0xff, 0xfe, 0xc3, ...ascii('b"}]}}')] },
  ],
  ["non-UTF-8 bytes outside a string", { kind: "bytes", bytes: [...ascii('{"modelPicker":'), 0xff, ...ascii("}")] }],
  ["a lone surrogate escape in an id", T('{"modelPicker":{"entries":[{"id":"\\ud800x"}]}}')],
  ["an escaped pair in a label", T('{"modelPicker":{"entries":[{"id":"esc","label":"\\ud83d\\ude00 \\u00e9"}]}}')],
  ["1e400 as an id", T('{"modelPicker":{"entries":[{"id":1e400}]}}')],
  ["-1e400 as a label", T('{"modelPicker":{"entries":[{"id":"neg","label":-1e400}]}}')],
  ["1e400 elsewhere", T('{"x":1e400,"modelPicker":{"entries":[{"id":"inf-sibling"}]}}')],
  ["1e400 as the mode", T('{"modelPicker":{"mode":1e400,"entries":[{"id":"m"}]}}')],
  ["1e400 as entries", T('{"modelPicker":{"entries":1e400}}')],
  ["1e400 as an entry", T('{"modelPicker":{"entries":[1e400,{"id":"z"}]}}')],
  ["1e400 as the picker", T('{"modelPicker":1e400}')],
  ["1e400 in a string", T('{"modelPicker":{"entries":[{"id":"1e400","label":"1e400"}]}}')],
  ["duplicate keys", T('{"modelPicker":{"entries":[{"id":"first"}]},"modelPicker":{"entries":[{"id":"second","id":"third"}]}}')],
  ["__proto__ keys", T('{"modelPicker":{"entries":[{"__proto__":{"id":"proto"}},{"id":"own","__proto__":5}]}}')],
  ["a __proto__ picker", T('{"modelPicker":{"__proto__":{"entries":[{"id":"p"}]}}}')],
  ["nesting past 128 elsewhere", T(`{"deep":${deep(200)},"modelPicker":{"entries":[{"id":"deep"}]}}`)],
  ["modelPicker null", MP(null)],
  ["modelPicker {}", MP({})],
  ["modelPicker []", MP([])],
  ["modelPicker [1]", MP([1])],
  ["modelPicker a string", MP("replace")],
  ["modelPicker 5", MP(5)],
  ["modelPicker true", MP(true)],
  ["modelPicker false", MP(false)],
  ["entries null", MP({ entries: null })],
  ["entries []", E()],
  ["entries {}", MP({ entries: {} })],
  ["entries a string", MP({ entries: "abc" })],
  ["entries an empty string", MP({ entries: "" })],
  ["entries 0", MP({ entries: 0 })],
  ["entries false", MP({ entries: false })],
  ["entries an array-like", MP({ entries: { length: 1, 0: { id: "x" } } })],
  ["one entry", E({ id: "my-model" })],
  ["a padded label", E({ id: "my-model", label: "  My Model  " })],
  ["empty labels", E({ id: "a", label: "" }, { id: "b", label: "   " }, { id: "c", label: null }, { id: "d" })],
  ["a number label", E({ id: "a", label: 5 })],
  ["an object label", E({ id: "a", label: {} })],
  ["a false label", E({ id: "a", label: false })],
  ["JS whitespace labels", E({ id: "a", label: "\u00a0Lbl\ufeff" }, { id: "b", label: "\u0085Nel\u0085" }, { id: "c", label: "\u200bZw" })],
  ["unicode labels", E({ id: "a", label: "\ud83d\ude80 Rocket" }, { id: "\u00e9t\u00e9", label: "\u65e5\u672c\u8a9e" })],
  ["blank ids", E({ id: "" }, { id: "   " }, { id: "\u00a0" }, { id: "\ufeff" }, { id: "\u2028\u3000" }, { id: "kept" })],
  ["ids JS trim keeps", E({ id: "\u0085" }, { id: "\u200b" }, { id: "\u180e" }, { id: " padded " })],
  ["falsy ids", E({ id: 0 }, { id: false }, { id: null }, { id: "ok" })],
  ["a number id", E({ id: 5 })],
  ["a true id", E({ id: true })],
  ["an array id", E({ id: [] })],
  ["a null entry", E(null)],
  ["a null entry after a good one", E({ id: "first" }, null)],
  ["entries without ids", E(5, "str", true, false, 0, [], {}, [{ id: "inner" }], { id: "kept" })],
  ["duplicate ids", E({ id: "a" }, { id: "a", label: "A again" })],
  ["ids the fallback has", E({ id: "sonnet" }, { id: "Sonnet" }, { id: "default" }, { id: "fable" }, { id: "new" })],
  ["replace", MP({ mode: "replace", entries: [{ id: "r1" }, { id: "r2", label: "R2" }] })],
  ["replace with no entries", MP({ mode: "replace", entries: [] })],
  ["replace with blank ids", MP({ mode: "replace", entries: [{ id: "" }, { id: " " }] })],
  ["replace with fallback ids", MP({ mode: "replace", entries: [{ id: "sonnet" }, { id: "sonnet" }] })],
  ["replace with a null entry", MP({ mode: "replace", entries: [null] })],
  ["replace with a number label", MP({ mode: "replace", entries: [{ id: "r", label: 5 }] })],
  ["Replace", MP({ mode: "Replace", entries: [{ id: "r" }] })],
  ["append", MP({ mode: "append", entries: [{ id: "r" }] })],
  ["mode 5", MP({ mode: 5, entries: [{ id: "r" }] })],
  ["mode [replace]", MP({ mode: ["replace"], entries: [{ id: "r" }] })],
  ["extra keys", T('{"modelPicker":{"extra":1,"entries":[{"label":"L","id":"x","more":[1,2.50,1e2]}]},"model":"opus"}')],
  ["40 entries", MP({ entries: Array.from({ length: 40 }, (_, i) => ({ id: `bulk-${i}`, ...(i % 3 ? { label: `Bulk ${i}` } : {}) })) })],
];
const fallback = [];
for (const [name, settings] of FALLBACK) {
  applySettings(settings);
  fallback.push({ name, settings, got: await call(() => modelsRoute.GET()) });
}
applySettings({ kind: "missing" });

// ---- GET /api/models with live sessions -----------------------------------------

const RICH = [
  { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 with 1M context", resolvedModel: "claude-opus-5-5" },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Sonnet 5.5 \u00b7 Best for everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh"],
    supportsAdaptiveThinking: true,
    supportsFastMode: false,
    supportsAutoMode: true,
  },
  { value: "haiku", displayName: "Haiku", description: "\ud83d\ude80 fast", extra: { "10": 1, "2": 2, b: [1, 2.5, -0, 1e21], a: null } },
];
// Raw text, so the fake CLI re-emits number forms JSON.stringify never writes.
const RAW =
  '{"initialize":{"models":[{"value":"raw","displayName":"Raw \\u00e9 \\ud83d\\ude00","n":[1.0,1e2,100.50,-0.0,1E-7,12345678901234567890,0.1],' +
  '"10":"ten","2":"two","value":"raw-last","nested":{"b":1,"a":[true,false,null]}}]}}';
const okModels = (value) => ({ initialize: { models: [{ value, displayName: value.toUpperCase(), description: "ok" }] } });
const initError = { control: { initialize: { $error: "initialize refused" } } };
const SESSIONS = [
  {
    name: "one session",
    sessions: [{ model: "sess-rich", script: { initialize: { models: RICH } } }],
    gets: [
      { kind: "missing" },
      E({ id: "my-model", label: " Mine " }, { id: "sonnet" }, { id: "fable" }),
      MP({ mode: "replace", entries: [{ id: "only" }] }),
      E(null),
      E({ id: 5 }),
      MP([]),
      T("{"),
    ],
  },
  {
    name: "sessions without a usable list",
    sessions: [
      { model: "sess-empty", script: { initialize: { models: [] } } },
      { model: "sess-null", script: { initialize: { models: null } } },
      { model: "sess-object", script: { initialize: { models: { value: "x" } } } },
      { model: "sess-string", script: { initialize: { models: "abc" } } },
      { model: "sess-init-error", script: initError },
      { model: "sess-ok", script: okModels("ok-model") },
      { model: "sess-later", script: okModels("later-model") },
      // After a usable one, so only the session-scoped list sees them.
      { model: "sess-no-models", script: { control: { initialize: { $response: { commands: [], agents: [] } } } } },
      { model: "sess-astral", script: { initialize: { models: "\u00e9\ud83d\ude00" } } },
      { model: "sess-bad-name", script: { initialize: { models: [{ value: "fable", displayName: 5 }] } } },
    ],
    gets: [{ kind: "missing" }, E({ id: "ok-model" }, { id: "extra" }), MP({ mode: "replace", entries: [{ id: "r" }] })],
  },
  {
    name: "a list with a null row",
    sessions: [
      { model: "sess-null-row", script: { initialize: { models: [null, { value: "a" }, 5, "s"] } } },
      { model: "sess-good", script: okModels("good") },
    ],
    gets: [{ kind: "missing" }, E({ id: "a" }, { id: "b" }), MP({ mode: "replace", entries: [{ id: "r" }] }), E({ id: "x", label: [] })],
  },
  {
    name: "no session answers",
    sessions: [
      { model: "sess-init-error", script: initError },
      { model: "sess-empty", script: { initialize: { models: [] } } },
    ],
    gets: [{ kind: "missing" }, E({ id: "fallback-extra" }), MP({ entries: {} })],
  },
  {
    name: "a CLI that exited after initialize",
    sessions: [
      {
        model: "sess-gone",
        script: { initialize: { models: [{ value: "gone-model", displayName: "Gone" }] }, on_init: [{ $exit: 0 }] },
      },
    ],
    gets: [{ kind: "missing" }, E({ id: "gone-model" }, { id: "after" })],
  },
  {
    name: "number forms and key order",
    sessions: [{ model: "sess-raw", script: RAW }],
    gets: [{ kind: "missing" }, E({ id: "raw-last" }, { id: "raw" })],
  },
];
const idle = (signal) =>
  (async function* () {
    await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
  })();
const sessionsOut = [];
process.env.MODELS_GOLDEN_BIN = wrapper;
for (const sc of SESSIONS) {
  writeScripts(Object.fromEntries(sc.sessions.map((s) => [s.model, s.script])));
  const stubs = [];
  for (const s of sc.sessions) {
    const ctrl = new AbortController();
    const q = query({
      prompt: idle(ctrl.signal),
      options: { pathToClaudeCodeExecutable: wrapper, model: s.model, abortController: ctrl, cwd: join(ROOT, "project") },
    });
    // Wait for its initialize to settle, as a started Session's would have
    // by the time anyone asks it.
    await q.initializationResult().catch(() => undefined);
    sessionManager.sessions.set(s.model, { id: s.model, cwd: join(ROOT, "project"), query: q });
    stubs.push({ ctrl, q });
  }
  if (sc.name.startsWith("a CLI that exited")) {
    // Let the exit land before asking.
    await new Promise((r) => setTimeout(r, 500));
  }
  const gets = [];
  for (const settings of sc.gets) {
    applySettings(settings);
    const got = await call(() => modelsRoute.GET());
    // The session-scoped list shares the curation.
    const perSession = [];
    for (const s of sc.sessions) {
      const req = new Request(`http://localhost/api/sessions/${s.model}/model`);
      perSession.push({
        model: s.model,
        got: await call(() => sessionModelRoute.GET(req, { params: Promise.resolve({ id: s.model }) })),
      });
    }
    gets.push({ settings, got, perSession });
  }
  for (const { ctrl } of stubs) ctrl.abort();
  sessionManager.sessions.clear();
  applySettings({ kind: "missing" });
  sessionsOut.push({ name: sc.name, sessions: sc.sessions, gets });
  await new Promise((r) => setTimeout(r, 200));
}

// ---- GET /api/models/probe ------------------------------------------------------

const CANDIDATES = probeRoute.PROBE_CANDIDATES.map((c) => c.value);
const text = (t) => [{ type: "text", text: t }];
const asst = (t, extra = {}) => ({ type: "assistant", message: { role: "assistant", content: text(t) }, parent_tool_use_id: null, ...extra });
const turn = (steps, result) => ({ turns: [{ steps, ...(result !== undefined ? { result } : {}) }] });
const res = (fields) => turn([], fields);
/** One script per candidate, in candidate order. */
const per = (...scripts) => Object.fromEntries(scripts.map((s, i) => [CANDIDATES[i], s]).filter(([, s]) => s));
const PROBES = [
  { name: "every model answers", scripts: {} },
  {
    name: "verdicts",
    scripts: per(
      turn([asst("x", { error: "model_not_found" })]),
      res({ is_error: true, error: "entitlement_required" }),
      res({ is_error: true, api_error_status: 404 }),
      res({ is_error: true }),
      res({ is_error: true, subtype: null, errors: [] }),
      res({ subtype: "error_max_turns" }),
      res({ subtype: "" }),
      turn([asst("y", { error: "" })]),
      turn([{ type: "system", subtype: "status", status: null }, { type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: null }, asst("z")]),
      turn([asst("e", { error: { code: 1, why: ["a"] } })]),
      res({ is_error: true, error: null, api_error_status: 529 }),
      res({ is_error: true, error: 42 }),
    ),
  },
  {
    name: "odd result fields",
    scripts: per(
      res({ is_error: "yes", api_error_status: "abc" }),
      res({ is_error: 1, api_error_status: 0 }),
      res({ is_error: true, api_error_status: 1.5 }),
      res({ is_error: true, api_error_status: [4, 0, 4] }),
      res({ is_error: true, api_error_status: {} }),
      res({ is_error: true, api_error_status: true }),
      res({ is_error: true, api_error_status: 1e21 }),
      res({ is_error: 0, subtype: 5 }),
      res({ is_error: false, subtype: null }),
      res({ is_error: null, subtype: "error_during_execution" }),
      res({ is_error: true, error: "" }),
      res({ is_error: true, error: false }),
    ),
  },
  {
    name: "more odd fields",
    scripts: per(
      res({ is_error: [] }),
      res({ subtype: "Success" }),
      res({ is_error: true, error: "\u00e9t\u00e9 \ud83d\ude00" }),
      res({ is_error: true, api_error_status: 12345678901234567890 }),
      res({ is_error: true, api_error_status: "" }),
      res({ is_error: true, api_error_status: -1 }),
      res({ is_error: true, api_error_status: 1e-7 }),
      res({ is_error: true, api_error_status: [null, "x", [1, [2]]] }),
      turn([asst("n", { error: null })]),
      turn([asst("z", { error: 0 })]),
      turn([asst("t", { error: true })]),
      turn([asst("a", { error: ["x"] })]),
    ),
  },
  {
    name: "error results",
    scripts: per(
      res({ is_error: true, subtype: "error_during_execution", errors: ["  boom  ", "", "two"] }),
      res({ is_error: true, subtype: "error_max_turns", errors: ["x"], api_error_status: 400 }),
      res({ is_error: true, subtype: "error_during_execution", errors: [], error: "rate_limit" }),
      // No `errors` array: the SDK's reader throws on it (`e.errors.map`).
      res({ is_error: true, subtype: "error_during_execution" }),
      // Single-turn mode writes the prompt without waiting for initialize.
      { control: { initialize: { $no_reply: true } } },
    ),
  },
  {
    name: "process failures",
    scripts: per(
      turn([{ $exit: 0 }]),
      turn([{ $stderr: "fatal: no access" }, { $exit: 2 }]),
      turn([{ $kill: "SIGKILL" }]),
      turn([{ $kill: "SIGTERM" }]),
      initError,
      turn([{ $stdout_bytes: ascii("not json\n") }, asst("after a bad line")]),
      turn([asst("first"), { $exit: 1 }]),
      turn([{ $exit: 1 }]),
      turn([{ $stderr: "line one" }, { $stderr: "line two" }, { $exit: 3 }]),
      turn([{ type: "system", subtype: "status", status: null }, { $exit: 0 }]),
      { control: { initialize: { $no_reply: true, $emit: [{ $exit: 4 }] } } },
      { control: { initialize: { $error: "" } } },
    ),
  },
  {
    name: "two probes time out",
    scripts: per(
      null,
      null,
      null,
      // Asleep mid-turn, so only a kill ends it (not stdin closing).
      turn([{ $delay_ms: 60000 }]),
      null,
      null,
      null,
      null,
      { control: { initialize: { $no_reply: true } }, turns: [{ steps: [], result: false }] },
    ),
  },
  { name: "no CLI at the path", scripts: {}, bin: "/nonexistent/claudius-models-golden/claude" },
];
function wireOf(model, parentEnv) {
  const base = join(WRAP, "wire", model);
  const cliEnv = readJson(`${base}.env.json`);
  let env = null;
  if (cliEnv) {
    const added = {};
    for (const k of Object.keys(cliEnv).sort()) {
      if (k.startsWith("FAKE_CLAUDE_") || k.startsWith("MODELS_GOLDEN_") || k.startsWith("__CF") || SHELL_ADDED.includes(k)) {
        continue;
      }
      if (parentEnv[k] !== cliEnv[k]) added[k] = cliEnv[k];
    }
    const removed = Object.keys(parentEnv)
      .filter((k) => !(k in cliEnv))
      .sort();
    env = { added, removed };
  }
  let stdin = null;
  try {
    const ids = new Map();
    stdin = readFileSync(`${base}.stdin.log`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((m) => {
        if (typeof m.request_id === "string") {
          if (!ids.has(m.request_id)) ids.set(m.request_id, `$ID${ids.size}`);
          return { ...m, request_id: ids.get(m.request_id) };
        }
        if (m.type === "control_response" && typeof m.response?.request_id === "string") {
          return { ...m, response: { ...m.response, request_id: "$CLI_ID" } };
        }
        return m;
      });
  } catch {
    stdin = null;
  }
  return norm({ argv: readJson(`${base}.argv.json`), env, stdin });
}
const probe = [];
for (const p of PROBES) {
  writeScripts(p.scripts);
  process.env.MODELS_GOLDEN_BIN = p.bin ?? wrapper;
  const t0 = Date.now();
  const got = await call(() => probeRoute.GET());
  const ms = Date.now() - t0;
  // Let every aborted CLI finish writing its logs.
  await new Promise((r) => setTimeout(r, 500));
  const wire = p.bin ? null : Object.fromEntries(CANDIDATES.map((m) => [m, wireOf(m, START_ENV)]));
  probe.push({ name: p.name, scripts: p.scripts, ...(p.bin ? { bin: p.bin } : {}), slow: ms >= 15_000, got: norm(got), wire });
}

writeFileSync(
  process.env.MODELS_GOLDEN_OUT,
  JSON.stringify({
    sdkVersion,
    node: process.version,
    wrapper: WRAPPER,
    shellAdded: SHELL_ADDED,
    candidates: probeRoute.PROBE_CANDIDATES,
    curation,
    fallback,
    sessions: sessionsOut,
    probe,
  }),
);
process.exit(0);
