#!/usr/bin/env node
// Golden fixture for the chat's right rail and goal banner (U09b): the
// helpers components/panels/BackgroundTasksPanel.tsx and its widgets call
// (components/panels/widgets/format.ts, lib/client/usage-windows.ts,
// lib/client/task-status.ts, lib/shared/session-loops.ts,
// lib/shared/stop-self-paced-loop.ts, lib/shared/advisor.ts,
// lib/client/rate-limit-cta.ts) and the rules the components keep inline
// (the panel's task / shell / loop lists and its counters, its fmtElapsed
// / taskElapsedSeconds / taskStatusLabel / compactArg / taskIcon,
// use-countdown's formatRemaining, PlanUsageCard's formatReset,
// ScheduledLoops' cadence, SessionCard's effort pill, useRateLimitWarning's
// clamp and ChatSurface's add-todos prompt).
//
//   node rust/scripts/panels-golden.mjs     (node@22)
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
// Written to rust/app/crates/claudius-panels/tests/fixtures/panels_golden.json
// and replayed by app/crates/claudius-panels/tests/panels_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "app/crates/claudius-panels/tests/fixtures/panels_golden.json");

if (!process.env.PANELS_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "panels-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ: "UTC", PANELS_GOLDEN_CHILD: root },
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

const ROOT_DIR = process.env.PANELS_GOLDEN_CHILD;

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

/** [`cut`] without its closing `end`. */
const upTo = (file, start, end) => cut(file, start, end).slice(0, -end.length);

const P = "components/panels/BackgroundTasksPanel.tsx";
const SC = "components/panels/widgets/SessionCard.tsx";
const SL = "components/panels/widgets/ScheduledLoops.tsx";
const PU = "components/panels/widgets/PlanUsageCard.tsx";
const CD = "lib/client/use-countdown.ts";
const RW = "lib/client/useRateLimitWarning.ts";
const CS = "components/chat/ChatSurface.tsx";
const lib = (p) => JSON.stringify(join(repo, p));
const extracted = [
  "// Cut out of the rail's sources by panels-golden.mjs.",
  `import { collectStoppableTaskIds, isActivityCountableTask, isBackgroundTaskLive, isSystemTask } from ${lib("lib/client/task-status.ts")};`,
  `import { isStaleWakeup } from ${lib("lib/shared/session-loops.ts")};`,
  `import { fmtElapsedSec } from ${lib("components/panels/widgets/format.ts")};`,
  `import { limitHasReset } from ${lib("lib/client/rate-limit-cta.ts")};`,
  `import { EFFORT_WAIT_NOTE } from ${lib("lib/shared/effort-wait-note.ts")};`,
  // The icons taskIcon returns, as their names.
  ...["Terminal", "Activity", "Bot"].map((n) => `const ${n} = ${JSON.stringify(n)};`),
  upTo(P, "const PROCESS_TASK_TYPES", "\nexport function BackgroundTasksPanel("),
  `export { fmtElapsed, taskElapsedSeconds, taskStatusLabel, taskStatusTitle, compactArg, taskIcon };`,
  `export function lists({ toolHistory, tasks, liveBackgroundTaskIds, backgroundBashes, scheduledLoops, pendingPermission, now, ready, pending, sessionId }) {`,
  `  liveBackgroundTaskIds = liveBackgroundTaskIds ? new Set(liveBackgroundTaskIds) : null;`,
  cut(P, "  const runningCount = toolHistory", "  const busy = !ready || pending || runningBg > 0;"),
  `  const ids = (l) => l.map((t) => t.taskId);`,
  `  return { runningCount, subagents: ids(subagents), systemTasks: ids(systemTasks), earlier: ids(earlierSubagents), recent: ids(recent), runningBashes: runningBashes.map((b) => b.toolUseId), runningProcessTasks: ids(runningProcessTasks), runningProcs, stoppable: [...stoppableTaskIds], loops: allLoops.map((l) => l.id), activeLoopCount, nonAmbientSubagents: nonAmbientSubagents.length, attention, runningBg, busy };`,
  `}`,
  cut(CD, "function formatRemaining", "\n}"),
  `export { formatRemaining };`,
  `export function countdown(resetsAtSec, nowMs) {`,
  cut(CD, "  if (!resetsAtSec) return { countdown: null", "hasReset: false };\n}"),
  `export const formatReset = (resetsAtSec) => {`,
  cut(PU, "  return new Date(resetsAtSec * 1000).toLocaleString(", "  });"),
  `};`,
  `export function cadence(loop, now) {`,
  `  const elapsed = Math.max(0, (now - loop.startedAt) / 1000);`,
  cut(SL, "        const cadence = (() => {", "        })();"),
  `  return cadence;`,
  `}`,
  cut(SC, "const EFFORT_LABEL", "\n};"),
  cut(SC, "const MODE_LABEL", "\n};"),
  `export function effortPill(effort, applied, waits) {`,
  cut(SC, "  const shown: EffortLevel = applied ?? effort;", '        : "";'),
  `  const title = ${cut(SC, "`Reasoning effort: ${EFFORT_LABEL[shown]}", ': ""\n      }`')};`,
  `  return { label: EFFORT_LABEL[shown] ?? null, shown, title };`,
  `}`,
  `export const modeLabel = (mode) => MODE_LABEL[mode] ?? mode;`,
  cut(RW, "function clamp(", "\n}"),
  `export function warningPct(raw) {`,
  cut(RW, "    if (raw == null) return DEFAULT_PCT;", "    return clamp(n);"),
  `}`,
  `export function addTodosPrompt(texts) {`,
  cut(CS, "      const cleaned = texts.map((t) => t.trim()).filter(Boolean);", '      ].join("\\n");'),
  `  return prompt;`,
  `}`,
].join("\n");
// `clamp` reads DEFAULT_PCT from the module scope.
const extractedPath = join(ROOT_DIR, "extracted.ts");
writeFileSync(extractedPath, "const DEFAULT_PCT = 50;\n" + extracted);
const X = await import(pathToFileURL(extractedPath).href);
const F = await import(join(repo, "components/panels/widgets/format.ts"));
const U = await import(join(repo, "lib/client/usage-windows.ts"));
const T = await import(join(repo, "lib/client/task-status.ts"));
const { isStaleWakeup } = await import(join(repo, "lib/shared/session-loops.ts"));
const { scheduledLoopCancelPrompt } = await import(join(repo, "lib/shared/stop-self-paced-loop.ts"));
const { badgeAdvisorLabel, prettyModelName } = await import(join(repo, "lib/shared/advisor.ts"));
const { limitHasReset } = await import(join(repo, "lib/client/rate-limit-cta.ts"));
const { messageSubagentDraft } = await import(join(repo, "lib/client/open-task.ts"));

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

const NUMS = [null, 0, -0.5, 0.0001, 0.0042, 0.00995, 0.01, 0.125, 0.4821, 0.9995, 1, 1.005, 12.345, 999, 999.5, 1000, 1234, 9999, 9999.9, 10000, 12345, 999999, 1000000, 1234567, 99999999];
record("fmtUsd", (n) => F.fmtUsd(n), one(NUMS));
record("fmtTokens", (n) => F.fmtTokens(n), one(NUMS));
const SECS = [0, 0.4, 1, 9.99, 59, 59.5, 59.99, 60, 61, 65.5, 119, 120, 599, 3599, 3600, 3601, 3660, 3720, 7199, 86399, 86400, 90061, -1, -61];
record("fmtElapsedSec", F.fmtElapsedSec, one(SECS));
record("fmtMs", (n) => F.fmtMs(n), one([null, 0, 1, 999, 1000, 1500, 61000, 3600000, 5400000]));
const PATHS = ["", "/", "/a", "/a/b", "/Users/demo/project", "/Users/demo/projects/claudius/rust/app", "/Users/demo/projects/claudius/rust/app/", "a/b/c/d/e/f/g/h/i/j/k/l/m/n", "/x/averyveryveryveryverylongdirectoryname", "/Users/d\u00e9mo/proj\u00e9cts/caf\u00e9/\u65e5\u672c\u8a9e\u306e\u30c7\u30a3\u30ec\u30af\u30c8\u30ea/src", "relative/path/with/several/parts/here"];
record("fmtPath", (p, n) => F.fmtPath(p, n ?? undefined), PATHS.flatMap((p) => [null, 32, 12, 4, 2, 1].map((n) => [p, n])));

record("fmtElapsed", X.fmtElapsed, one([0, 0.4, 0.5, 1.5, 2.5, 59.4, 59.5, 59.99, 60, 61.9, 125.7, 3599.9, 3600, 7322]));
const TASKS = [
  { taskId: "a", description: "d", status: "running" },
  { taskId: "a", description: "d", status: "running", startedAt: 1000 },
  { taskId: "a", description: "d", status: "pending", startedAt: 1000 },
  { taskId: "a", description: "d", status: "paused", startedAt: 1000 },
  { taskId: "a", description: "d", status: "running", startedAt: 9000 },
  { taskId: "a", description: "d", status: "running", startedAt: 1000, durationMs: 400 },
  { taskId: "a", description: "d", status: "completed", startedAt: 1000, durationMs: 2500 },
  { taskId: "a", description: "d", status: "completed", durationMs: 0 },
  { taskId: "a", description: "d", status: "stopped", reason: "worker_restart" },
  { taskId: "a", description: "d", status: "failed", reason: "other" },
];
record("taskElapsedSeconds", X.taskElapsedSeconds, TASKS.map((t) => [t, 6000]));
record("taskStatusLabel", X.taskStatusLabel, one(TASKS));
record("taskStatusTitle", X.taskStatusTitle, one(TASKS));
record("taskIcon", (t) => X.taskIcon(t ?? undefined), one([null, "local_bash", "local_monitor", "local_agent", "local_workflow", ""]));
record(
  "compactArg",
  X.compactArg,
  ["Edit", "MultiEdit", "Write", "Read", "Bash", "Grep"].flatMap((n) => ["/a/b/c.rs", "c.rs", "/a/b/", "", "a//b"].map((a) => [n, a])),
);

// The panel's lists over a few chats.
const tk = (taskId, status, extra = {}) => ({ taskId, description: `desc ${taskId}`, status, ...extra });
const bash = (toolUseId, extra = {}) => ({ toolUseId, command: `cmd ${toolUseId}`, startedAt: 1000, ...extra });
const loop = (id, kind, startedAt, extra = {}) => ({
  kind, id, toolUseId: `tu_${id}`, cron: kind === "cron" ? "*/5 * * * *" : null, humanSchedule: null,
  delaySeconds: kind === "wakeup" ? 300 : null, prompt: `p ${id}`, recurring: kind === "cron", durable: false, startedAt, ...extra,
});
const rec = (list, key) => Object.fromEntries(list.map((x) => [x[key], x]));
const CHATS = [
  { toolHistory: [], tasks: {}, liveBackgroundTaskIds: null, backgroundBashes: {}, scheduledLoops: {}, pendingPermission: false, now: 0, ready: true, pending: false, sessionId: "s1" },
  { toolHistory: [], tasks: {}, liveBackgroundTaskIds: null, backgroundBashes: {}, scheduledLoops: {}, pendingPermission: true, now: 0, ready: false, pending: false, sessionId: null },
  {
    toolHistory: [{ toolUseId: "t1", toolName: "Bash", startedAt: 0 }, { toolUseId: "t2", toolName: "Read", startedAt: 0, done: true }, { toolUseId: "t3", toolName: "thinking", startedAt: 0, kind: "thinking" }],
    tasks: rec([
      tk("a1", "running", { taskType: "local_agent", durationMs: 10 }),
      tk("a2", "pending", { taskType: "local_agent", durationMs: 50 }),
      tk("a3", "paused", { taskType: "local_workflow" }),
      tk("a4", "running", { taskType: "local_agent", ambient: true, durationMs: 30 }),
      tk("s1", "running", { skipTranscript: true, durationMs: 5 }),
      tk("s2", "completed", { skipTranscript: true, durationMs: 50 }),
      tk("m1", "running", { taskType: "local_monitor", toolUseId: "tm1" }),
      tk("m2", "running", { taskType: "local_monitor", ambient: true }),
      tk("b1", "running", { taskType: "local_bash", toolUseId: "tb1" }),
      tk("b2", "completed", { taskType: "local_bash", toolUseId: "tb2" }),
      tk("e1", "completed", { taskType: "local_agent" }),
      tk("e2", "killed", { taskType: "local_agent", toolUseId: "te2" }),
      tk("e3", "failed", { taskType: "local_agent", skipTranscript: true }),
      tk("r1", "completed"), tk("r2", "failed"), tk("r3", "stopped"), tk("r4", "killed"),
      tk("123", "running", { taskType: "local_agent" }),
    ], "taskId"),
    liveBackgroundTaskIds: null,
    backgroundBashes: rec([bash("tb1"), bash("tb2"), bash("tb3"), bash("tb4", { killed: true })], "toolUseId"),
    scheduledLoops: rec([
      loop("c1", "cron", 1000), loop("w1", "wakeup", 5000), loop("w2", "wakeup", 0, { cancelled: true }),
      loop("w3", "wakeup", -400000), loop("w4", "wakeup", -400000, { delaySeconds: null }), loop("c2", "cron", 3000, { cancelled: true }),
    ], "id"),
    pendingPermission: true,
    now: 0,
    ready: true,
    pending: true,
    sessionId: "s1",
  },
];
// The same chat behind a live-ids snapshot, and with a stale one.
CHATS.push({ ...CHATS[2], liveBackgroundTaskIds: ["a1", "m1", "s1", "b1"], pending: false });
CHATS.push({ ...CHATS[2], liveBackgroundTaskIds: [], pending: false, pendingPermission: false, toolHistory: [] });
CHATS.push({ ...CHATS[2], now: 500000, sessionId: "" });
record("lists", X.lists, one(CHATS));

record("isSystemTask", T.isSystemTask, one([{}, { skipTranscript: true }, { skipTranscript: false }, { skipTranscript: 1 }]));
record("isActivityCountableTask", T.isActivityCountableTask, one([{}, { ambient: true }, { ambient: false }, { ambient: 1 }]));
record(
  "isBackgroundTaskLive",
  (t, ids) => T.isBackgroundTaskLive(t, ids ? new Set(ids) : null),
  [[tk("a", "running"), null], [tk("a", "running"), []], [tk("a", "running"), ["a"]], [tk("a", "pending"), []], [tk("a", "completed"), []]],
);

const LOOPS = [
  loop("w", "wakeup", 0), loop("w", "wakeup", 0, { delaySeconds: null }), loop("w", "wakeup", 0, { cancelled: true }),
  loop("w", "wakeup", 0, { delaySeconds: 30 }), loop("w", "wakeup", 0, { delaySeconds: 0 }), loop("w", "wakeup", 0, { delaySeconds: 4000 }),
  loop("c", "cron", 0), loop("c", "cron", 0, { humanSchedule: "Every 5 minutes" }), loop("c", "cron", 0, { cron: null }),
  loop("c", "cron", 0, { cancelled: true, humanSchedule: "Hourly" }),
];
record("cadence", X.cadence, LOOPS.flatMap((l) => [0, 30000, 299000, 300000, 3600000].map((now) => [l, now])));
record("isStaleWakeup", isStaleWakeup, LOOPS.flatMap((l) => [0, 360000, 360001, 4060001].map((now) => [l, now])));
record("scheduledLoopCancelPrompt", scheduledLoopCancelPrompt, one([{ id: "abc123", kind: "cron" }, { id: "w1", kind: "wakeup" }, { id: "a`b", kind: "cron" }]));

const NOW = 1795683600000;
const plan = (rateLimits, extra = {}) => ({ subscriptionType: "max", rateLimitsAvailable: true, rateLimits, ...extra });
const iso = (ms) => new Date(ms).toISOString();
const PLANS = [
  null,
  { rateLimitsAvailable: false, rateLimits: { fiveHour: { utilization: 10, resetsAt: null } } },
  plan(null),
  plan({ fiveHour: { utilization: 12, resetsAt: iso(NOW + 3600e3) }, sevenDay: { utilization: 81, resetsAt: iso(NOW + 3 * 86400e3) } }),
  plan({ sevenDay: { utilization: 100.4, resetsAt: iso(NOW + 86400e3) }, fiveHour: { utilization: 49.5, resetsAt: iso(NOW - 1000) }, sevenDayOpus: null, sevenDaySonnet: { utilization: null, resetsAt: null } }),
  plan({ sevenDayOauthApps: { utilization: 3, resetsAt: "not a date" }, custom: { utilization: 7, resetsAt: null } }, { modelScoped: [{ displayName: "Fable", utilization: 66, resetsAt: iso(NOW + 7200e3) }, { displayName: "Gone", utilization: 9, resetsAt: iso(NOW - 1) }] }),
];
const EVENTS = [
  [],
  [{ status: "rejected", rateLimitType: "seven_day", utilization: 0.5, resetsAt: (NOW + 86400e3) / 1000 }],
  [{ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.83, resetsAt: (NOW + 600e3) / 1000 }, { status: "rejected", rateLimitType: "overage" }, { status: "allowed", rateLimitType: "seven_day_opus" }],
  [{ status: "rejected", rateLimitType: "seven_day", resetsAt: (NOW - 1000) / 1000 }, { rateLimitType: "bogus", utilization: 0.5 }, { utilization: 0.2 }],
  [{ status: "allowed", rateLimitType: "seven_day_overage_included", utilization: 0.995 }, { status: "allowed", rateLimitType: "seven_day_sonnet", utilization: 0 }],
];
record("collectUsageWindows", U.collectUsageWindows, PLANS.flatMap((p) => EVENTS.map((e) => [p, e, NOW])));
const WINDOWS = [
  { key: "fiveHour", label: "5-hour limit", pct: 0, rejected: false },
  { key: "sevenDay", label: "Weekly limit", pct: 49.5, rejected: false },
  { key: "sevenDay", label: "Weekly limit", pct: 50, rejected: false },
  { key: "sevenDayOpus", label: "Weekly Opus limit", pct: 99.6, rejected: false },
  { key: "overage", label: "Extra-usage limit", pct: 100, rejected: false },
  { key: "sevenDaySonnet", label: "Weekly Sonnet limit", pct: 112.7, rejected: false },
  { key: "sevenDayOverageIncluded", label: "Weekly limit (overage incl.)", pct: 3, rejected: true },
  { key: "sevenDayOauthApps", label: "Weekly limit (OAuth apps)", pct: -2, rejected: false },
  { key: "model:Fable", label: "Weekly Fable limit", pct: 75, rejected: false },
  { key: "custom", label: "custom", pct: 75, rejected: false },
];
record("shortUsageLabel", U.shortUsageLabel, one(WINDOWS));
record("displayUsagePct", U.displayUsagePct, one(WINDOWS));
record("usageTone", U.usageTone, WINDOWS.flatMap((w) => [0, 50, 75, 100].map((t) => [w, t])));
record("formatRemaining", X.formatRemaining, one([0, 9, 59, 60, 309, 3599, 3600, 7509, 86399, 86400, 3 * 86400 + 4 * 3600 + 300]));
record("limitHasReset", (r, n) => limitHasReset(r ?? undefined, n), [[null, NOW], [0, NOW], [-5, NOW], [NOW / 1000, NOW], [NOW / 1000 + 0.5, NOW], [NOW / 1000 + 1, NOW], [NOW / 1000 + 1, NOW + 999]]);
record("countdown", (r, n) => X.countdown(r ?? undefined, n), [[null, NOW], [0, NOW], [NOW / 1000 - 5, NOW], [NOW / 1000 + 70, NOW], [NOW / 1000 + 70.5, NOW], [NOW / 1000 + 7509, NOW], [NOW / 1000 + 3 * 86400, NOW]]);
record("formatReset", X.formatReset, one([NOW / 1000, NOW / 1000 + 86400 * 2 + 3600 * 13 + 60 * 5, 1795921200, 0]));

record(
  "effortPill",
  (e, a, w) => X.effortPill(e, a ?? null, w),
  ["auto", "low", "medium", "high", "xhigh", "max", "weird"].flatMap((e) => [null, "high", "max", "medium"].flatMap((a) => [false, true].map((w) => [e, a, w]))),
);
record("modeLabel", X.modeLabel, one(["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk", ""]));
record("badgeAdvisorLabel", badgeAdvisorLabel, one([null, "", "(active)", "claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-5", "claude-fable-5", "opus", "claude-haiku-4-5-20251001", "claude-some-very-long-custom-model-id", "claude-x-1234567", "abcdefghijklmnop", "abcdefghijklmnopq", 7]));
record("prettyModelName", prettyModelName, one(["claude-opus-4-5", "claude-sonnet-5-5", "sonnet", "claude-opus-4-5-20251101", "us.anthropic.claude-sonnet-4-5-v1:0", ""]));
record("warningPct", X.warningPct, one([null, "", "75", "75.9", " 80", "x", "150", "-3", "0", "100", "1e2"]));
record("addTodosPrompt", X.addTodosPrompt, one([["one"], [" a ", "", "b", "  "], ["first\nline", "caf\u00e9"]]));
record("messageSubagentDraft", messageSubagentDraft, one(["agent_1", ""]));

// ASCII only: every other code unit (all inside strings) as a \u escape.
const ascii = JSON.stringify({ sections }, null, 1).replace(
  /[\u007f-\uffff]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
writeFileSync(join(ROOT_DIR, "out.json"), ascii + "\n");
