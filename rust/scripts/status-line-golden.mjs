#!/usr/bin/env node
// Golden fixture for the status line's pure helpers (U09a): the functions
// components/chat/StatusLine.tsx, ModeSelector.tsx and
// components/panels/widgets/ModelPicker.tsx call (lib/shared/
// turn-status-label.ts, permission-modes.ts, model-deprecations.ts,
// fast-mode.ts, advisor.ts, model-id.ts, effort-flags.ts; lib/client/
// use-elapsed.ts, worktree.ts, format-message-time.ts) and the rules the
// components keep inline (StatusLine's status / label / tooltip, context
// and cost formatting; ModeSelector's PERMISSION_MODE_META and menu order).
//
//   node rust/scripts/status-line-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir, TZ=UTC and a resolve hook for the `@/` and extensionless imports,
// twice; both recordings must agree byte for byte. The components are JSX,
// which the type stripper can't load, so their inline rules are cut out of
// the real source text (each marker must occur exactly once) into a .ts
// module in the temp dir and imported from there.
//
// Every section is a list of `{ args, out }`: `args` went through
// `JSON.stringify` / `JSON.parse` before the call, `out` is the result with
// `undefined` as `null`; the file is ASCII, every other code unit written as
// a `\u` escape.
//
// Written to rust/app/crates/claudius-status/tests/fixtures/status_line_golden.json
// and replayed by app/crates/claudius-status/tests/status_line_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-status/tests/fixtures/status_line_golden.json");

if (!process.env.STATUS_LINE_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "status-line-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ: "UTC", STATUS_LINE_GOLDEN_CHILD: root },
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
  writeFileSync(out, runs[0]);
  const fixture = JSON.parse(runs[0]);
  const counts = Object.entries(fixture.sections).map(([k, v]) => `${k} ${v.length}`);
  const total = Object.values(fixture.sections).reduce((n, v) => n + v.length, 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${total} cases (stable)\n  ${counts.join(", ")}`);
  process.exit(0);
}

const ROOT_DIR = process.env.STATUS_LINE_GOLDEN_CHILD;

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

// ------------------------------- the inline rules, cut out of the JSX

/** The text of `file` from `start` (which must occur exactly once) through `end`. */
function cut(file, start, end) {
  const src = readFileSync(join(repo, file), "utf8");
  const at = src.indexOf(start);
  if (at < 0 || src.indexOf(start, at + 1) >= 0) {
    throw new Error(`${file} no longer holds \`${start}\` exactly once: update the recorder`);
  }
  const stop = src.indexOf(end, at + start.length);
  if (stop < 0) throw new Error(`${file}: \`${start}\` has no closing \`${end}\``);
  return src.slice(at, stop + end.length);
}

/** The text strictly between `start` (exactly once) and the next `end`. */
function inner(file, start, end) {
  const s = cut(file, start, end);
  return s.slice(start.length, s.length - end.length);
}

const SL = "components/chat/StatusLine.tsx";
const MS = "components/chat/ModeSelector.tsx";
const extracted = [
  "// Cut out of components/chat/*.tsx by status-line-golden.mjs.",
  `import { workingStatusLabel } from ${JSON.stringify(join(repo, "lib/shared/turn-status-label.ts"))};`,
  `import { formatElapsed } from ${JSON.stringify(join(repo, "lib/client/use-elapsed.ts"))};`,
  `import { PERMISSION_MODE_ORDER } from ${JSON.stringify(join(repo, "lib/shared/permission-modes.ts"))};`,
  // The icons PERMISSION_MODE_META names, as their names.
  ...["Shield", "ShieldAlert", "ShieldCheck", "ShieldOff", "ListChecks", "Wand2"].map(
    (n) => `const ${n} = ${JSON.stringify(n)};`,
  ),
  `const ORDER = PERMISSION_MODE_ORDER;`,
  cut(MS, "export const PERMISSION_MODE_META", "\n};"),
  `export function visibleOrder(mode, disabledModes) {`,
  cut(MS, "  const visibleOrder = ", "    : ORDER;"),
  `  return visibleOrder;`,
  `}`,
  `export function statusParts({ ready, pending, backgroundTasks = 0, turnElapsedSec, toolActive, resumingThought, contextPercent, totalCostUsd, outputTokens }) {`,
  cut(SL, "  const bgRunning = ", '    : "idle";'),
  cut(SL, "  const statusLabel =", "status.slice(1);"),
  cut(SL, "  const ctx = typeof contextPercent", '"ok";'),
  `  const labelTitle = (${inner(SL, 'className="whitespace-nowrap"\n        title={', "\n      >\n        {statusLabel}")
    .trimEnd()
    .replace(/\}$/, "")});`,
  `  const costShown = ${inner(SL, "        {(typeof totalCostUsd", " ? (\n")
    .replace(/^/, "(typeof totalCostUsd")};`,
  `  const costText = costShown ? (${cut(SL, '{typeof totalCostUsd === "number" && totalCostUsd > 0\n', '"\u2014"}').slice(1, -1)}) : null;`,
  `  const tokensText = typeof outputTokens === "number" && outputTokens > 0 ? \`\${${inner(SL, "                {outputTokens >= 1000", "} tok")
    .replace(/^/, "outputTokens >= 1000")}} tok\` : null;`,
  `  const ctxTitle = ctx != null ? (${inner(SL, "            title={\n              ctxLevel", "\n            }\n          >\n            {ctxLevel")
    .replace(/^/, "ctxLevel")}) : null;`,
  `  return { status, statusLabel, labelTitle: labelTitle ?? null, ctx, ctxLevel, ctxTitle, costText, tokensText };`,
  `}`,
].join("\n");
const extractedPath = join(ROOT_DIR, "extracted.ts");
writeFileSync(extractedPath, extracted);
const { PERMISSION_MODE_META, visibleOrder, statusParts } = await import(pathToFileURL(extractedPath).href);
const { workingStatusLabel } = await import(join(repo, "lib/shared/turn-status-label.ts"));
const { formatElapsed } = await import(join(repo, "lib/client/use-elapsed.ts"));
const { worktreeBadge, worktreeBadgeLabel } = await import(join(repo, "lib/client/worktree.ts"));
const { modelDeprecationDate } = await import(join(repo, "lib/shared/model-deprecations.ts"));
const { prettyModelName } = await import(join(repo, "lib/shared/advisor.ts"));
const { fastModeDisabledReasonLabel, fastModeLabel } = await import(join(repo, "lib/shared/fast-mode.ts"));
const { PERMISSION_MODE_ORDER, nextPermissionMode } = await import(join(repo, "lib/shared/permission-modes.ts"));
const { findModelEntry } = await import(join(repo, "lib/shared/model-id.ts"));
const { capEffortLevels } = await import(join(repo, "lib/shared/effort-flags.ts"));
const { formatClockTime } = await import(join(repo, "lib/client/format-message-time.ts"));

// ------------------------------------------------------------------- cases

const sections = {};
function record(name, fn, argsList) {
  sections[name] = argsList.map((a) => {
    const args = JSON.parse(JSON.stringify(a));
    const r = fn(...args);
    return { args, out: r === undefined ? null : r };
  });
}
const one = (xs) => xs.map((x) => [x]);

const OPTS = [{}, { toolActive: true }, { resumingThought: true }, { toolActive: true, resumingThought: true }];
record(
  "workingStatusLabel",
  (sec, opts) => workingStatusLabel(sec ?? undefined, opts),
  [null, 0, 1, 44, 45, 46, 600].flatMap((s) => OPTS.map((o) => [s, o])),
);
record("formatElapsed", formatElapsed, one([0, 1, 9, 44, 45, 59, 60, 61, 83, 599, 3599, 3600, 3601, 3661, 7322, 86399, 86400]));

const PATHS = [null, "", "/", "/proj", "/proj/", "/proj//", "/proj/.worktrees/feature-x", "/proj/.worktrees/feature-x/", "/tmp/wt-1", "/projx", "/proj/a/b/c", "relative/dir", "wt"];
const ROOTS = [null, "", "/", "/proj", "/proj/"];
record(
  "worktreeBadge",
  (cwd, root) => worktreeBadge(cwd ?? undefined, root ?? undefined),
  PATHS.flatMap((p) => ROOTS.map((r) => [p, r])),
);
record(
  "worktreeBadgeLabel",
  worktreeBadgeLabel,
  [["/proj/x", "/proj"], ["/proj/x/", "/proj/"], ["/other/y", "/proj"], ["/", "/proj"], ["", ""], ["a/b", ""], ["/proj", "/proj"]],
);

const MODELS = [
  null,
  "",
  "claude-opus-4-0",
  "claude-opus-4-20250514",
  "claude-sonnet-4-0",
  "claude-3-opus-20240229",
  "claude-3-5-haiku-latest",
  "claude-2.1",
  "claude-instant-1.2",
  "claude-opus-4-8",
  "claude-opus-4.8",
  "opus",
  "sonnet[1m]",
  "claude-opus-5-5[1m]",
  "us.anthropic.claude-sonnet-5-5-20260101-v1:0",
  "claude-fable-5-2",
  "Claude-Opus-4-7",
  "claude-haiku-4-5-20251001",
  "fake-model",
  "claude-opus-4-80",
];
record("modelDeprecationDate", (m) => modelDeprecationDate(m ?? undefined), one(MODELS));
record("prettyModelName", (m) => prettyModelName(m ?? undefined), one(MODELS));
record("fastModeLabel", (m) => fastModeLabel(m ?? undefined), one(MODELS));
record(
  "fastModeDisabledReasonLabel",
  (r) => fastModeDisabledReasonLabel(r ?? undefined),
  one([null, "", "free", "preference", "extra_usage_disabled", "network_error", "unknown", "not_first_party", "disabled_by_env", "model_not_allowed", "sdk_opt_in_required", "pending", "brand_new_reason", "FREE"]),
);

const DISABLED = [null, [], ["auto"], ["auto", "plan"], ["default"], ["bypassPermissions", "dontAsk"]];
const MODES = [...PERMISSION_MODE_ORDER, "weird"];
record(
  "nextPermissionMode",
  (m, d) => nextPermissionMode(m, d ?? undefined),
  MODES.flatMap((m) => DISABLED.map((d) => [m, d])),
);
record(
  "visibleOrder",
  (m, d) => visibleOrder(m, d ?? undefined),
  MODES.flatMap((m) => DISABLED.map((d) => [m, d])),
);
record(
  "permissionModeMeta",
  () => PERMISSION_MODE_ORDER.map((m) => ({ mode: m, ...PERMISSION_MODE_META[m] })),
  [[]],
);

const BASE = { ready: true, pending: false };
record(
  "statusParts",
  (p) => statusParts(p),
  one([
    { ready: false, pending: false },
    { ready: false, pending: true },
    BASE,
    { ...BASE, pending: true },
    { ...BASE, pending: true, turnElapsedSec: 12 },
    { ...BASE, pending: true, turnElapsedSec: 45 },
    { ...BASE, pending: true, turnElapsedSec: 125 },
    { ...BASE, pending: true, turnElapsedSec: 3725 },
    { ...BASE, pending: true, turnElapsedSec: 50, toolActive: true },
    { ...BASE, pending: true, turnElapsedSec: 50, resumingThought: true },
    { ...BASE, backgroundTasks: 1 },
    { ...BASE, backgroundTasks: 3 },
    { ...BASE, backgroundTasks: 0 },
    { ...BASE, backgroundTasks: -1 },
    { ...BASE, pending: true, backgroundTasks: 2 },
    { ready: false, backgroundTasks: 2 },
    ...[0, 0.4, 0.5, 12.5, 74.4, 74.5, 75, 89.49, 89.5, 90, 100, 130, -0.4, -2.5].map((contextPercent) => ({ ...BASE, contextPercent })),
    ...[0, 0.0001, 0.00004, 0.0099, 0.00995, 0.01, 0.0625, 0.1234, 1.5, 12.3456, 1234.5678, -1].map((totalCostUsd) => ({
      ...BASE,
      totalCostUsd,
    })),
    ...[0, 1, 999, 1000, 1049, 1050, 1051, 12345, 999949, 999950, 1e6, -5].map((outputTokens) => ({ ...BASE, outputTokens })),
    { ...BASE, totalCostUsd: 0.5, outputTokens: 2500 },
    { ...BASE, totalCostUsd: 0, outputTokens: 0 },
  ]),
);

const ROWS = [
  { value: "default", resolvedModel: "claude-opus-5-5" },
  { value: "opus", resolvedModel: "claude-opus-5-5" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
  { value: "sonnet[1m]", resolvedModel: "claude-sonnet-5-5" },
  { value: "haiku" },
];
const ONLY_DEFAULT = [{ value: "default", resolvedModel: "claude-opus-5-5" }, { value: "haiku" }];
record(
  "findModelEntry",
  (models, cur) => {
    const m = findModelEntry(models, cur ?? undefined);
    return m ? m.value : null;
  },
  [
    ...[null, "", "opus", "opus[1m]", "OPUS[1M]", " opus[1m] ", "sonnet[1m]", "claude-opus-5-5[1m]", "claude-sonnet-5-5[1m]", "claude-opus-5-5", "haiku[1m]", "nope[1m]", "[1m]"].map((c) => [ROWS, c]),
    [ONLY_DEFAULT, "claude-opus-5-5[1m]"],
    [null, "opus"],
    [[], "opus"],
  ],
);
const LEVELS = [["low", "medium", "high"], ["low", "medium", "high", "xhigh", "max"], ["high", "max"], []];
record(
  "capEffortLevels",
  (levels, cap) => capEffortLevels(levels, cap ?? undefined),
  LEVELS.flatMap((l) => [null, "", "low", "medium", "high", "xhigh", "max", "bogus"].map((c) => [l, c])),
);
record(
  "formatClockTime",
  (at) => formatClockTime(at ?? undefined),
  one([null, 0, 1795683600000, 1795683600000 + 13 * 3600e3 + 5 * 60e3, 1795683600000 + 12 * 3600e3, 1795683600000 + 23 * 3600e3 + 59 * 60e3 + 59e3, 1795683600000 + 9 * 3600e3 + 7 * 60e3]),
);
record(
  "toFixed",
  (x, d) => x.toFixed(d),
  [[0.0625, 3], [0.125, 2], [1.005, 2], [0.00995, 4], [0.00005, 4], [1.0495, 1], [999.95, 1], [2.5, 0], [0, 4], [1e21, 2], [123.456, 3]],
);

// ASCII only: every other code unit (all inside strings) as a \u escape.
const ascii = JSON.stringify({ sections }, null, 1).replace(
  /[\u007f-\uffff]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
writeFileSync(join(ROOT_DIR, "out.json"), ascii + "\n");
