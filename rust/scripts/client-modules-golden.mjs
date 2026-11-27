#!/usr/bin/env node
// Golden fixture for the pure modules the chat client's reducer calls
// (U01b): lib/client/task-status.ts, idle-reconcile.ts, prompt-queue.ts,
// system-entries.ts, stream-recovery.ts, boot-guard.ts, the two
// sdk-message-filters.ts predicates, and from lib/shared parse-init,
// parse-tasklist-result, effort-wait-note, stop-self-paced-loop,
// workflow-meta, system-informational, hook-events, fast-mode, the advisor
// sentinel, cost-pricing's costFromTokens, session-loops'
// readCronNextFireAt, plus use-session.ts's CONVERSATION_RESET_TRIGGER_LABEL.
//
//   node rust/scripts/client-modules-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME in a temp
// dir, `TZ` pinned and a resolve hook for the `@/` and extensionless
// imports, twice; both recordings must agree byte for byte. use-session.ts
// is imported as it is, except that a load hook appends one `export { ... }`
// line for CONVERSATION_RESET_TRIGGER_LABEL (a private const). The recorder
// also checks that use-session.ts still imports every name it records, so a
// helper the hook stops calling (or starts calling) shows up here.
//
// Every case is `{ name, args, out | throws, same? }`, as in
// client-helpers-golden.mjs:
// - `args` went through `JSON.stringify` / `JSON.parse` before the call. A
//   `{"$repeat": [s, n]}` in them is `s.repeat(n)`, and a
//   `{"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}` that number.
// - `out` is the result in the client's snapshot JSON: `undefined` keys left
//   out, a `Record` the UI iterates as `[key, value]` pairs (own-key order),
//   a number JSON can't hold as `{"$num": ...}`, an `undefined` result as
//   `{"$undefined": true}`, a function as `{"$function": name}`.
// - `throws` is the exception as `"<name>: <message>"`.
// - `same` is whether the helper handed back its input (`result === prev`).
//
// The boot guard's cases are scenarios over a fake `Storage` that logs each
// call and can be made to throw: every op's result, the calls it made and
// the storage left at the end.
//
// Written to rust/crates/claudius-client/tests/fixtures/client_modules_golden.json
// and replayed by crates/claudius-client/tests/client_modules_golden.rs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-client/tests/fixtures/client_modules_golden.json");
const TZ = "America/New_York";
const NOW = 1763300000000;

if (!process.env.CLIENT_MODULES_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "client-modules-golden-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: { PATH: process.env.PATH, HOME: root, TZ, CLIENT_MODULES_GOLDEN_CHILD: root },
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
  const counts = Object.entries(fixture.sections).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : 1}`);
  const total = Object.values(fixture.sections).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${total} cases (stable)\n  ${counts.join(", ")}`);
  process.exit(0);
}

const ROOT_DIR = process.env.CLIENT_MODULES_GOLDEN_CHILD;
const useSessionPath = join(repo, "lib/client/use-session.ts");
const PRIVATE_CONST = "CONVERSATION_RESET_TRIGGER_LABEL";
const src = readFileSync(useSessionPath, "utf8");
{
  const decl = `\nconst ${PRIVATE_CONST}: Record<string, string> = {`;
  const at = src.indexOf(decl);
  if (at < 0 || src.indexOf(decl, at + 1) >= 0) {
    throw new Error(`use-session.ts no longer declares \`${PRIVATE_CONST}\` exactly once: update the recorder`);
  }
}

// What the hook imports from each module this fixture covers. A name the
// hook no longer imports (or a module it drops) fails the recording.
const HOOK_IMPORTS = {
  "./task-status": [
    "dropProvisionalForToolUse",
    "findToolUseBlock",
    "isBackgroundedToolUse",
    "reconcileTasksOnToolResult",
    "seedTaskStatus",
    "setTaskModelForToolUse",
    "shouldRecoverOrphanTask",
    "upsertProvisionalTask",
  ],
  "./idle-reconcile": ["applyThinkingTokensEstimate", "clearStreaming", "sweepToolHistoryDone"],
  "./prompt-queue": ["dropPrompt", "enqueuePrompt", "mergeServerPrompts"],
  "./system-entries": ["appendCoalescedSystemEntry"],
  "./stream-recovery": ["STREAM_BADGE_AFTER_MS", "shouldRebuildTranscript", "streamRecoveryDelayMs"],
  "@/lib/client/boot-guard": [
    "BOOT_FORCE_KEY",
    "clearBootAttemptFor",
    "consumeForcedResume",
    "markBootAttempt",
    "scopeSkippedBoot",
    "shouldSkipResume",
  ],
  "@/lib/client/api-retry": ["ApiRetryState"],
  "./sdk-message-filters": ["isSuppressedSystemEvent"],
  "@/lib/shared/parse-init": ["parseInitSystemMessage"],
  "@/lib/shared/parse-tasklist-result": ["parseTaskListResult"],
  "@/lib/shared/effort-wait-note": ["NO_EFFORT_WAIT", "effortApplied", "effortPicked", "effortRequestStarted"],
  "@/lib/shared/stop-self-paced-loop": ["isScheduleWakeupStop", "markWakeupsStopped"],
  "@/lib/shared/workflow-meta": ["parseWorkflowMeta"],
  "@/lib/shared/system-informational": ["classifyInformationalLevel"],
  "@/lib/shared/hook-events": ["hookEventGetsDurablePill"],
  "@/lib/shared/fast-mode": [
    "OPUS48_FAST_DEPRECATION_KEY",
    "isFastModeCreditsRejectedNotice",
    "notificationColor",
    "opus48FastDeprecationText",
  ],
  "@/lib/shared/advisor": ["ADVISOR_ACTIVE_SENTINEL", "prettyModelName"],
  "@/lib/shared/cost-pricing": ["costFromTokens"],
  "@/lib/shared/session-loops": ["readCronNextFireAt", "readEndedLoopWakeup"],
};
{
  const imports = new Map();
  for (const m of src.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";/gms)) {
    const names = m[1]
      .split(",")
      .map((n) => n.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    imports.set(m[2], [...(imports.get(m[2]) ?? []), ...names]);
  }
  for (const [mod, names] of Object.entries(HOOK_IMPORTS)) {
    let got = (imports.get(mod) ?? []).filter((n) => !/^(?:SkippedBoot|EffortWaitState)$/.test(n)).sort();
    // U01a ported the rest of what the hook takes from the filters.
    if (mod === "./sdk-message-filters") got = got.filter((n) => names.includes(n));
    if (JSON.stringify(got) !== JSON.stringify([...names].sort())) {
      throw new Error(`use-session.ts imports ${JSON.stringify(got)} from ${mod}, not ${JSON.stringify(names)}: update the recorder`);
    }
  }
}

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const USE_SESSION = ${JSON.stringify(pathToFileURL(realpathSync(useSessionPath)).href)};
const EXPORTS = ${JSON.stringify(`\nexport { ${PRIVATE_CONST} };\n`)};
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
  const r = await next(url, ctx);
  if (url !== USE_SESSION) return r;
  return { ...r, source: String(r.source) + EXPORTS };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

// --------------------------- determinism stubs ---------------------------

let uuidCount = 0;
Date.now = () => NOW;
Object.defineProperty(globalThis.crypto, "randomUUID", {
  configurable: true,
  writable: true,
  value: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, "0")}`,
});

const lib = (p) => import(join(repo, p));
const us = await import(useSessionPath);
if (typeof us[PRIVATE_CONST] !== "object") throw new Error(`the load hook didn't export ${PRIVATE_CONST}: update the recorder`);
const ts = await lib("lib/client/task-status.ts");
const ir = await lib("lib/client/idle-reconcile.ts");
const pq = await lib("lib/client/prompt-queue.ts");
const se = await lib("lib/client/system-entries.ts");
const sr = await lib("lib/client/stream-recovery.ts");
const bg = await lib("lib/client/boot-guard.ts");
const filters = await lib("lib/client/sdk-message-filters.ts");
const pi = await lib("lib/shared/parse-init.ts");
const ptl = await lib("lib/shared/parse-tasklist-result.ts");
const ew = await lib("lib/shared/effort-wait-note.ts");
const ssl = await lib("lib/shared/stop-self-paced-loop.ts");
const wm = await lib("lib/shared/workflow-meta.ts");
const si = await lib("lib/shared/system-informational.ts");
const he = await lib("lib/shared/hook-events.ts");
const fm = await lib("lib/shared/fast-mode.ts");
const adv = await lib("lib/shared/advisor.ts");
const cp = await lib("lib/shared/cost-pricing.ts");
const sl = await lib("lib/shared/session-loops.ts");

// ------------------------------- encoding --------------------------------

const def = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

function enc(v) {
  if (v === undefined) return { $undefined: true };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $num: "NaN" };
    if (Object.is(v, -0)) return { $num: "-0" };
    if (!Number.isFinite(v)) return { $num: String(v) };
    return v;
  }
  if (typeof v === "function") return { $function: v.name };
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Set) return [...v].map(enc);
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : enc(x)));
  const o = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) def(o, k, enc(x));
  return o;
}

/** A `Record` as `[key, value]` pairs, in own-key order. */
const pairs = (rec) => Object.entries(rec).map(([k, v]) => [k, enc(v)]);

const NUMS = { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 };
function expand(v) {
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object") {
    if (Object.keys(v).length === 1 && Array.isArray(v.$repeat)) return v.$repeat[0].repeat(v.$repeat[1]);
    if (Object.keys(v).length === 1 && typeof v.$num === "string") return NUMS[v.$num];
    const o = {};
    for (const [k, x] of Object.entries(v)) def(o, k, expand(x));
    return o;
  }
  return v;
}
const num = (x) => enc(x);

const sections = {};
/**
 * Record `fn(...args)` for each case. `args` is what the fixture stores
 * (round-tripped through JSON, `$repeat` / `$num` still folded); `prep`
 * turns the parsed args into the call's; `show` encodes the result (default
 * `enc`); with `same`, also whether the first argument came back.
 */
function section(name, fn, cases, { prep = (a) => a, show = enc, same = false } = {}) {
  if (sections[name]) throw new Error(`section ${name} twice`);
  const names = new Set();
  sections[name] = cases.map(([label, args]) => {
    if (names.has(label)) throw new Error(`${name}: case ${label} twice`);
    names.add(label);
    const stored = JSON.parse(JSON.stringify(args));
    const callArgs = prep(expand(stored));
    uuidCount = 0;
    try {
      const r = fn(...callArgs);
      return {
        name: label,
        args: stored,
        out: show(r, callArgs),
        ...(same ? { same: r === callArgs[0] } : {}),
      };
    } catch (e) {
      return { name: label, args: stored, throws: `${e?.name}: ${e?.message}` };
    }
  });
}

// ------------------------------- inputs ----------------------------------

const U = (...cps) => String.fromCodePoint(...cps);
const LONE_HI = String.fromCharCode(0xd83d);
const LONE_LO = String.fromCharCode(0xde00);
const FEFF = U(0xfeff);
const NEL = U(0x85);
const NBSP = U(0xa0);
const LS = U(0x2028);
const IDEO = U(0x3000);
const LONG_S = U(0x17f);
const KELVIN = U(0x212a);
const EMOJI = U(0x1f600);
const E_ACUTE = U(0xe9);

const text = (t) => ({ kind: "text", text: t });
const toolUse = (id, name = "Bash", input = {}, extra = {}) => ({ kind: "tool_use", id, name, input, ...extra });
const msg = (uuid, blocks, extra = {}) => ({ uuid, role: "assistant", blocks, ...extra });
const userMsg = (uuid, blocks, extra = {}) => ({ uuid, role: "user", blocks, ...extra });
const task = (taskId, extra = {}) => ({ taskId, description: `task ${taskId}`, status: "running", ...extra });

// ---- task-status.ts

const recordOut = (r) => pairs(r);

section(
  "setTaskModelForToolUse",
  ts.setTaskModelForToolUse,
  [
    ["empty", [{}, "t1", "opus"]],
    ["stamps", [{ a: task("a", { toolUseId: "t1" }) }, "t1", "claude-opus-5-5"]],
    ["keeps a model", [{ a: task("a", { toolUseId: "t1", model: "haiku" }) }, "t1", "opus"]],
    ["empty model is none", [{ a: task("a", { toolUseId: "t1", model: "" }) }, "t1", "opus"]],
    ["other tool use", [{ a: task("a", { toolUseId: "t2" }) }, "t1", "opus"]],
    ["no tool use id", [{ a: task("a") }, "t1", "opus"]],
    [
      "every match, order kept",
      [
        {
          b: task("b", { toolUseId: "t1" }),
          10: task("10", { toolUseId: "t1" }),
          a: task("a", { toolUseId: "t2" }),
          2: task("2", { toolUseId: "t1", model: "m" }),
        },
        "t1",
        "sonnet",
      ],
    ],
    ["empty model stamped", [{ a: task("a", { toolUseId: "t1" }) }, "t1", ""]],
  ],
  { show: recordOut, same: true },
);

const LIST_A = [
  userMsg("u1", [text("go")]),
  msg("a1", [text("x"), toolUse("t1", "Task", { prompt: "p" }), toolUse("t2", "Bash", {}, { result: { content: "ok" } })]),
];
const LIST_B = [msg("b1", [toolUse("t3", "Workflow", { script: "s" })]), msg("b2", [toolUse("t1", "Read", {})])];
section("findToolUseBlock", ts.findToolUseBlock, [
  ["no lists", ["t1"]],
  ["empty list", ["t1", []]],
  ["first list", ["t2", LIST_A]],
  ["second list", ["t3", LIST_A, LIST_B]],
  ["first of duplicates", ["t1", LIST_B, LIST_A]],
  ["missing", ["t9", LIST_A, LIST_B]],
  ["text is not a tool use", ["x", LIST_A]],
  ["empty id", ["", LIST_A]],
]);

section("shouldRecoverOrphanTask", ts.shouldRecoverOrphanTask, [
  ["no tool use id", [{ status: "completed" }, LIST_A]],
  ["null tool use id", [{ toolUseId: null, status: "completed" }, []]],
  ["empty tool use id", [{ toolUseId: "", status: "completed" }, []]],
  ["running", [{ toolUseId: "t9", status: "running" }, []]],
  ["completed, orphaned", [{ toolUseId: "t9", status: "completed" }, LIST_A]],
  ["completed, linked", [{ toolUseId: "t1", status: "completed" }, LIST_A]],
  ["no status, orphaned", [{ toolUseId: "t9" }, LIST_A]],
  ["odd status", [{ toolUseId: "t9", status: "RUNNING" }, LIST_A]],
  ["pending, orphaned", [{ toolUseId: "t9", status: "pending" }, []]],
]);

section("isBackgroundedToolUse", ts.isBackgroundedToolUse, [
  ["null", [null]],
  ["plain", [toolUse("t1", "Task", { prompt: "p" })]],
  ["run_in_background", [toolUse("t1", "Task", { run_in_background: true })]],
  ["run_in_background string", [toolUse("t1", "Task", { run_in_background: "true" })]],
  ["run_in_background 1", [toolUse("t1", "Task", { run_in_background: 1 })]],
  ["run_in_background false", [toolUse("t1", "Workflow", { run_in_background: false })]],
  ["Workflow", [toolUse("t1", "Workflow", {})]],
  ["workflow lowercase", [toolUse("t1", "workflow", {})]],
  ["input null", [toolUse("t1", "Task", null)]],
  ["input string", [toolUse("t1", "Workflow", "run_in_background")]],
  ["input array", [toolUse("t1", "Task", [true])]],
  ["input number", [toolUse("t1", "Task", 5)]],
]);

const TASKS = {
  a: task("a", { toolUseId: "t1" }),
  b: task("b", { toolUseId: "t1", status: "pending" }),
  c: task("c", { toolUseId: "t1", status: "paused" }),
  d: task("d", { toolUseId: "t1", status: "completed" }),
  e: task("e", { toolUseId: "t1", status: "killed" }),
  f: task("f", { toolUseId: "t1", isBackgrounded: true }),
  g: task("g", { toolUseId: "t2" }),
  h: task("h", { toolUseId: "t1", status: "stopped" }),
  i: task("i", { toolUseId: "t1", status: "weird" }),
  j: task("j", { toolUseId: "t1", isBackgrounded: false }),
};
section(
  "reconcileTasksOnToolResult",
  ts.reconcileTasksOnToolResult,
  [
    ["backgrounded", [TASKS, "t1", false, true]],
    ["completed", [TASKS, "t1", false, false]],
    ["failed", [TASKS, "t1", true, false]],
    ["is_error undefined", [TASKS, "t1", undefined, false]],
    ["other tool use", [TASKS, "t2", true, false]],
    ["no match", [TASKS, "t9", false, false]],
    ["empty", [{}, "t1", false, false]],
  ],
  { show: recordOut, same: true },
);

section("seedTaskStatus", ts.seedTaskStatus, [
  ["null", [null]],
  ["no result", [toolUse("t1", "Task", {})]],
  ["result", [toolUse("t1", "Task", {}, { result: { content: "done" } })]],
  ["error result", [toolUse("t1", "Task", {}, { result: { content: "boom", isError: true } })]],
  ["isError false", [toolUse("t1", "Task", {}, { result: { content: "", isError: false } })]],
  ["backgrounded result", [toolUse("t1", "Task", { run_in_background: true }, { result: { content: "started" } })]],
  ["Workflow result", [toolUse("t1", "Workflow", {}, { result: { content: "started", isError: true } })]],
  ["input null, result", [toolUse("t1", "Task", null, { result: { content: "x" } })]],
  ["input null, no result", [toolUse("t1", "Task", null)]],
]);

const PROV = (toolUseId, extra = {}) => ({
  taskId: "ignored",
  toolUseId,
  description: "Workflow running in background",
  taskType: "local_workflow",
  workflowName: "wf",
  status: "running",
  startedAt: NOW,
  ...extra,
});
section(
  "upsertProvisionalTask",
  ts.upsertProvisionalTask,
  [
    ["empty", [{}, PROV("t1")]],
    ["appended last", [{ a: task("a"), 5: task("5") }, PROV("t1")]],
    ["index key", [{ a: task("a"), 10: task("10") }, PROV("7")]],
    ["real task owns it", [{ x: task("x", { toolUseId: "t1" }) }, PROV("t1")]],
    ["real task, provisional false", [{ x: task("x", { toolUseId: "t1", provisional: false }) }, PROV("t1")]],
    ["provisional already", [{ t1: { ...PROV("t1"), taskId: "t1", provisional: true } }, PROV("t1", { description: "new" })]],
    ["other row at the key", [{ a: task("a"), t1: task("t1", { toolUseId: "t9" }), z: task("z") }, PROV("t1")]],
    ["other provisional owns it", [{ p: task("p", { toolUseId: "t1", provisional: true }) }, PROV("t1")]],
    ["no workflow name", [{}, PROV("t1", { workflowName: undefined, description: "Workflow x" })]],
    ["empty tool use id", [{}, PROV("")]],
    ["proto key", [{}, PROV("__proto__")]],
    ["constructor key", [{ a: task("a") }, PROV("constructor")]],
  ],
  { show: recordOut, same: true },
);

section(
  "dropProvisionalForToolUse",
  ts.dropProvisionalForToolUse,
  [
    ["undefined", [{ t1: { ...PROV("t1"), provisional: true } }]],
    ["empty id", [{ "": { ...PROV(""), provisional: true } }, ""]],
    ["missing", [{ a: task("a") }, "t1"]],
    ["not provisional", [{ t1: task("t1", { toolUseId: "t1" }) }, "t1"]],
    ["provisional", [{ a: task("a"), t1: { ...PROV("t1"), taskId: "t1", provisional: true }, z: task("z") }, "t1"]],
    ["provisional without startedAt", [{ t1: { ...PROV("t1", { startedAt: undefined }), provisional: true } }, "t1"]],
    ["index keys", [{ 3: task("3"), 1: { ...PROV("1"), provisional: true }, b: task("b") }, "1"]],
    ["constructor", [{ a: task("a") }, "constructor"]],
  ],
  {
    show: (r) => ({ tasks: pairs(r.tasks), ...(r.carriedStartedAt === undefined ? {} : { carriedStartedAt: num(r.carriedStartedAt) }) }),
    same: false,
  },
);
// `same` there is whether `.tasks` came back.
for (const c of sections.dropProvisionalForToolUse) {
  const prev = expand(c.args)[0];
  const r = ts.dropProvisionalForToolUse(prev, expand(c.args)[1]);
  c.same = r.tasks === prev;
}

// ---- idle-reconcile.ts

// As the hook builds them: a thinking row has no parentToolUseId, a tool
// row always has one (`null` on the main thread).
const th = (id, extra = {}) => ({ toolUseId: id, toolName: "thinking", startedAt: 1, kind: "thinking", ...extra });
const tool = (id, extra = {}) => ({ toolUseId: id, toolName: "Bash", startedAt: 1, parentToolUseId: null, ...extra });
section(
  "applyThinkingTokensEstimate",
  ir.applyThinkingTokensEstimate,
  [
    ["empty", [[], 10]],
    ["no thinking", [[tool("a")], 10]],
    ["one open", [[tool("a"), th("b")], 42]],
    ["done skipped", [[th("a"), th("b", { done: true })], 7]],
    ["latest open", [[th("a"), th("b"), tool("c")], 7]],
    ["matching stamp", [[th("a", { userMessageUuid: "u1" }), th("b", { userMessageUuid: "u2" })], 9, "u1"]],
    ["latest matching stamp", [[th("a", { userMessageUuid: "u1" }), th("b", { userMessageUuid: "u1" }), th("c")], 9, "u1"]],
    ["no matching stamp", [[th("a", { userMessageUuid: "u1" }), th("b")], 9, "u3"]],
    ["empty uuid", [[th("a", { userMessageUuid: "u1" }), th("b")], 9, ""]],
    ["stamp kept on match", [[th("a", { userMessageUuid: "u1", estimatedThinkingTokens: 3 })], 4, "u1"]],
    ["done match falls back", [[th("a", { userMessageUuid: "u1", done: true }), th("b")], 5, "u1"]],
    ["tool kind", [[tool("a", { kind: "tool" })], 5]],
    ["zero", [[th("a")], 0]],
    ["fraction", [[th("a")], 1.5]],
    ["negative zero", [[th("a")], { $num: "-0" }]],
    ["done false is open", [[th("a", { done: false })], 2]],
  ],
  { same: true },
);

section(
  "sweepToolHistoryDone",
  ir.sweepToolHistoryDone,
  [
    ["empty", [[], NOW]],
    ["all done", [[tool("a", { done: true }), th("b", { done: true, endedAt: 5 })], NOW]],
    ["mixed", [[tool("a", { done: true, endedAt: 2 }), tool("b"), th("c", { endedAt: 9 }), tool("d", { done: false })], NOW]],
    ["now NaN", [[tool("a")], { $num: "NaN" }]],
    ["ended at zero kept", [[tool("a", { endedAt: 0 })], NOW]],
    ["subagent rows", [[tool("a", { parentToolUseId: "p1", primaryArg: "ls" }), th("b"), tool("c", { parentToolUseId: "p1", done: true, isError: true, notRun: true })], NOW]],
  ],
  { same: true },
);

section(
  "clearStreaming",
  ir.clearStreaming,
  [
    ["empty", [[]]],
    ["none streaming", [[msg("a", [text("x")]), msg("b", [], { streaming: false })]]],
    ["streaming", [[msg("a", [text("x")], { streaming: true }), userMsg("u", [text("y")]), msg("b", [], { streaming: true, pending: true })]]],
  ],
  { same: true },
);

// ---- prompt-queue.ts

const P = (id, extra = {}) => ({ type: "permission_request", requestId: id, toolName: "Bash", ...extra });
section(
  "enqueuePrompt",
  pq.enqueuePrompt,
  [
    ["empty", [[], P("r1")]],
    ["appended", [[P("r1"), P("r2")], P("r3")]],
    ["replaced in place", [[P("r1"), P("r2"), P("r3")], P("r2", { toolName: "Edit" })]],
    ["first of duplicates", [[P("r1"), P("r1", { toolName: "x" })], P("r1", { toolName: "y" })]],
    ["empty id", [[P("")], P("", { toolName: "z" })]],
  ],
  { same: true },
);
section(
  "dropPrompt",
  pq.dropPrompt,
  [
    ["empty", [[], "r1"]],
    ["missing", [[P("r1"), P("r2")], "r9"]],
    ["dropped", [[P("r1"), P("r2"), P("r3")], "r2"]],
    ["every copy", [[P("r1"), P("r2"), P("r1")], "r1"]],
  ],
  { same: true },
);
section(
  "mergeServerPrompts",
  pq.mergeServerPrompts,
  [
    ["nothing", [[P("r1")], [], []]],
    ["appended in order", [[P("r1")], [P("r3"), P("r2")], []]],
    ["local kept", [[P("r1", { toolName: "local" })], [P("r1", { toolName: "server" }), P("r2")], []]],
    ["gone skipped", [[], [P("r1"), P("r2")], ["r1"]]],
    ["server duplicates once", [[], [P("r1"), P("r1", { toolName: "later" })], []]],
    ["all present", [[P("r1"), P("r2")], [P("r2"), P("r1")], ["r9"]]],
  ],
  { prep: ([l, s, g]) => [l, s, new Set(g)], same: true },
);

// ---- system-entries.ts

const SE = (uuid, after, kind, label, extra = {}) => ({ uuid, afterMessageUuid: after, kind, label, ...extra });
section(
  "appendCoalescedSystemEntry",
  se.appendCoalescedSystemEntry,
  [
    ["empty", [[], SE("e1", "", "init", "Session ready")]],
    ["coalesced", [[SE("e1", "a", "init", "Session ready")], SE("e2", "a", "init", "Session ready")]],
    ["counted", [[SE("e1", "a", "status", "Status: requesting", { count: 3 })], SE("e2", "a", "status", "Status: requesting")]],
    ["other anchor", [[SE("e1", "a", "init", "Session ready")], SE("e2", "b", "init", "Session ready")]],
    ["other label", [[SE("e1", "a", "status", "Status: requesting")], SE("e2", "a", "status", "Status: compacting")]],
    ["other kind", [[SE("e1", "a", "status", "x")], SE("e2", "a", "init", "x")]],
    ["first match", [[SE("e0", "a", "info", "y"), SE("e1", "a", "init", "x"), SE("e2", "a", "init", "x", { count: 5 })], SE("e3", "a", "init", "x", { count: 9 })]],
    ["incoming detail kept on append", [[], SE("e1", "a", "init", "x", { detail: "d", ts: "2026-01-01" })]],
  ],
  { same: true },
);

// ---- stream-recovery.ts

const ATTEMPTS = [0, 1, 2, 3, 4, 5, 6, 7, 100, -1, { $num: "-0" }, 0.5, 1.9, 4.99, 5.5, -0.5, { $num: "NaN" }, { $num: "Infinity" }, { $num: "-Infinity" }, 1e300, 2 ** 53, 1e-300];
section(
  "streamRecoveryDelayMs",
  sr.streamRecoveryDelayMs,
  ATTEMPTS.map((a) => [JSON.stringify(a), [a]]),
);
const DOWNS = [0, -5, 1, 4000, 14999, 15000, 15000.5, 15001, 1e9, { $num: "-0" }, { $num: "NaN" }, { $num: "Infinity" }, { $num: "-Infinity" }];
section(
  "shouldRebuildTranscript",
  sr.shouldRebuildTranscript,
  DOWNS.map((d) => [JSON.stringify(d), [d]]),
);
sections.streamConstants = {
  STREAM_BADGE_AFTER_MS: sr.STREAM_BADGE_AFTER_MS,
  STREAM_RECOVERY_MAX_DELAY_MS: sr.STREAM_RECOVERY_MAX_DELAY_MS,
  STREAM_REBUILD_AFTER_MS: sr.STREAM_REBUILD_AFTER_MS,
};

// ---- boot-guard.ts

function fakeStorage(initial, throwsOn) {
  const data = new Map(initial);
  const log = [];
  const call = (op, args, f) => {
    log.push([op, ...args]);
    if (throwsOn.includes(op)) throw new DOMException(`${op} denied`, "SecurityError");
    return f();
  };
  return {
    data,
    log,
    getItem: (k) => call("getItem", [k], () => (data.has(k) ? data.get(k) : null)),
    setItem: (k, v) => call("setItem", [k, String(v)], () => void data.set(k, String(v))),
    removeItem: (k) => call("removeItem", [k], () => void data.delete(k)),
  };
}
const MK = bg.BOOT_MARKER_KEY;
const FK = bg.BOOT_FORCE_KEY;
const TTL = bg.BOOT_MARKER_TTL_MS;
const marker = (o) => JSON.stringify(o);
const L1 = 1763299990000.25;
const L2 = 1763299995000.5;
// Each scenario: [name, initial storage pairs, methods that throw, ops].
// An op is [fn, ...args] with every argument explicit (`load` included).
const BOOT = [
  ["no marker", [], [], [["shouldSkipResume", "s1", NOW, false, L2]]],
  [
    "mark then reload",
    [],
    [],
    [
      ["markBootAttempt", "s1", NOW, L1],
      ["shouldSkipResume", "s1", NOW + 1000, false, L1],
      ["shouldSkipResume", "s1", NOW + 1000, false, L2],
      ["shouldSkipResume", "s2", NOW + 1000, false, L2],
      ["shouldSkipResume", "s1", NOW + 1000, true, L2],
      ["shouldSkipResume", "s1", NOW + TTL - 1, false, L2],
      ["shouldSkipResume", "s1", NOW + TTL, false, L2],
      ["shouldSkipResume", "s1", NOW + TTL + 1, false, L2],
      ["shouldSkipResume", "s1", NOW - 5000, false, L2],
      ["shouldSkipResume", "s1", { $num: "NaN" }, false, L2],
      ["shouldSkipResume", "s1", NOW, false, { $num: "NaN" }],
    ],
  ],
  [
    "clear for",
    [[MK, marker({ id: "s1", at: NOW, load: L1 })]],
    [],
    [
      ["clearBootAttemptFor", "s2"],
      ["clearBootAttemptFor", "s1"],
      ["clearBootAttemptFor", "s1"],
      ["shouldSkipResume", "s1", NOW, false, L2],
    ],
  ],
  [
    "forced resume",
    [[FK, "s1"], ["other", "kept"]],
    [],
    [
      ["consumeForcedResume", "s2"],
      ["consumeForcedResume", "s1"],
      ["consumeForcedResume", "s1"],
    ],
  ],
  ["forced resume, empty id", [[FK, ""]], [], [["consumeForcedResume", ""]]],
  ["get throws", [[MK, marker({ id: "s1", at: NOW })], [FK, "s1"]], ["getItem"], [["shouldSkipResume", "s1", NOW, false, L2], ["consumeForcedResume", "s1"], ["clearBootAttemptFor", "s1"]]],
  ["set throws", [], ["setItem"], [["markBootAttempt", "s1", NOW, L1], ["shouldSkipResume", "s1", NOW, false, L2]]],
  ["remove throws", [[MK, marker({ id: "s1", at: NOW })], [FK, "s1"]], ["removeItem"], [["clearBootAttemptFor", "s1"], ["consumeForcedResume", "s1"], ["shouldSkipResume", "s1", NOW, false, L2]]],
  ["mark overwrites", [[MK, marker({ id: "s0", at: 1 })], ["a", "b"]], [], [["markBootAttempt", "s1", NOW, L1], ["shouldSkipResume", "s1", NOW, false, L2]]],
  ["mark NaN time", [], [], [["markBootAttempt", "s1", { $num: "NaN" }, L1], ["shouldSkipResume", "s1", NOW, false, L2]]],
  ["mark negative zero", [], [], [["markBootAttempt", "s1", { $num: "-0" }, { $num: "-0" }], ["shouldSkipResume", "s1", 1, false, 0]]],
  ["mark lone surrogate id", [], [], [["markBootAttempt", `s${LONE_HI}`, NOW, L1], ["shouldSkipResume", `s${LONE_HI}`, NOW, false, L2], ["clearBootAttemptFor", `s${LONE_HI}`]]],
  ["mark astral id", [], [], [["markBootAttempt", `s${EMOJI}`, NOW, 1e21], ["shouldSkipResume", `s${EMOJI}`, NOW, false, 1e-7]]],
  ...[
    ["empty", ""],
    ["null", "null"],
    ["number", "5"],
    ["array", "[]"],
    ["string", '"s1"'],
    ["bad json", "{bad"],
    ["id number", marker({ id: 1, at: NOW })],
    ["no at", marker({ id: "s1" })],
    ["at string", marker({ id: "s1", at: String(NOW) })],
    ["at null", '{"id":"s1","at":null}'],
    ["load string", marker({ id: "s1", at: NOW, load: String(L2) })],
    ["load matches", marker({ id: "s1", at: NOW, load: L2 })],
    ["future at", marker({ id: "s1", at: NOW + 10 * TTL })],
    ["at huge negative", '{"id":"s1","at":-1e308}'],
    ["at past f64", '{"id":"s1","at":1e400}'],
    ["duplicate id key", '{"id":"s2","at":1763300000000,"id":"s1"}'],
    ["proto key", '{"__proto__":{"id":"s1","at":1763300000000}}'],
    ["nested", '{"marker":{"id":"s1","at":1763300000000}}'],
    ["whitespace", ` \n${marker({ id: "s1", at: NOW })}\t`],
    ["extra fields", marker({ id: "s1", at: NOW, load: L1, x: [1, 2] })],
  ].map(([label, raw]) => [
    `foreign marker: ${label}`,
    [[MK, raw]],
    [],
    [["shouldSkipResume", "s1", NOW, false, L2], ["clearBootAttemptFor", "s1"]],
  ]),
];
sections.bootGuard = BOOT.map(([name, initial, throwsOn, ops]) => {
  const stored = JSON.parse(JSON.stringify({ initial, throwsOn, ops }));
  const st = fakeStorage(expand(stored.initial), stored.throwsOn);
  const results = expand(stored.ops).map(([fn, ...args]) => {
    st.log.length = 0;
    let r;
    try {
      r = { out: enc(bg[fn](args[0], st, ...args.slice(1))) };
    } catch (e) {
      r = { throws: `${e?.name}: ${e?.message}` };
    }
    return { ...r, calls: st.log.map((c) => [...c]) };
  });
  return { name, ...stored, results, storage: [...st.data] };
});
sections.bootConstants = { BOOT_MARKER_KEY: MK, BOOT_FORCE_KEY: FK, BOOT_MARKER_TTL_MS: TTL };

section("scopeSkippedBoot", bg.scopeSkippedBoot, [
  ["no state", [null, "s1"]],
  ["no bound id", [{ id: "s1", freshId: "f1" }, null]],
  ["empty bound id", [{ id: "s1", freshId: "f1" }, ""]],
  ["skipped one bound", [{ id: "s1", freshId: "f1" }, "s1"]],
  ["fresh pending", [{ id: "s1", freshId: null }, "x"]],
  ["fresh pending, skipped bound", [{ id: "s1", freshId: null }, "s1"]],
  ["fresh bound", [{ id: "s1", freshId: "f1" }, "f1"]],
  ["another bound", [{ id: "s1", freshId: "f1" }, "s2"]],
  ["empty fresh id", [{ id: "s1", freshId: "" }, "s2"]],
  ["empty fresh id bound", [{ id: "s1", freshId: "" }, ""]],
]);

// ---- sdk-message-filters.ts

section(
  "isSuppressedSystemEvent",
  filters.isSuppressedSystemEvent,
  [
    ["undefined", []],
    ["null", [null]],
    ["empty", [""]],
    ...["stop_hook_summary", "hook_progress", "hook_callback", "mcp_status", "thinking_tokens"].map((s) => [s, [s]]),
    ["init", ["init"]],
    ["upper", ["STOP_HOOK_SUMMARY"]],
    ["padded", [" mcp_status"]],
    ["zero", [0]],
    ["false", [false]],
    ["array", [["mcp_status"]]],
    ["object", [{}]],
    ["space", [" "]],
  ],
);

const COMPACT = "This session is being continued from a previous conversation that ran out of context.";
const REM = (b) => `<system-reminder>${b}</system-reminder>`;
section("isRealUserDisplayMessage", filters.isRealUserDisplayMessage, [
  ["assistant", [msg("a", [text("hi")])]],
  ["plain", [userMsg("u", [text("hi")])]],
  ["empty", [userMsg("u", [text("")])]],
  ["no blocks", [userMsg("u", [])]],
  ["tool use only", [userMsg("u", [toolUse("t1")])]],
  ["joined text", [userMsg("u", [text("<system-"), text(`reminder>x</system-reminder>`)])]],
  ["reminder only", [userMsg("u", [text(`${REM("a")}\n${REM("b")}`)])]],
  ["reminder then prompt", [userMsg("u", [text(`${REM("a")} ask`)])]],
  ["goal then prompt", [userMsg("u", [text("<session-goal>g</session-goal>\n\nask")])]],
  ["goal only", [userMsg("u", [text("<session-goal>g</session-goal>  ")])]],
  ["task notification", [userMsg("u", [text("<task-notification>\n<task-id>1</task-id>")])]],
  ["task notification feff", [userMsg("u", [text(`${FEFF}<task-notification>`)])]],
  ["task notification nel", [userMsg("u", [text(`${NEL}<task-notification>`)])]],
  ["task notification tag feff", [userMsg("u", [text(`<task-notification${FEFF}x`)])]],
  ["task notification tag nel", [userMsg("u", [text(`<task-notification${NEL}x`)])]],
  ["compact summary", [userMsg("u", [text(COMPACT)])]],
  ["compact summary nel", [userMsg("u", [text(`${NEL}${COMPACT}`)])]],
  ["compact summary feff", [userMsg("u", [text(`${FEFF}${NBSP}${COMPACT}`)])]],
  ["command name", [userMsg("u", [text("<command-name>/x</command-name>")])]],
  ["command name upper", [userMsg("u", [text("<COMMAND-NAME>/x")])]],
  ["command name feff", [userMsg("u", [text(`${FEFF}<command-name>`)])]],
  ["command name nel", [userMsg("u", [text(`${NEL}<command-name>`)])]],
  ["command message long s", [userMsg("u", [text(`<command-me${LONG_S}${LONG_S}age>`)])]],
  ["stdout tag feff", [userMsg("u", [text(`<local-command-stdout${FEFF}`)])]],
  ["stderr tag nel", [userMsg("u", [text(`<local-command-stderr${NEL}`)])]],
  ["caveat", [userMsg("u", [text("  <local-command-caveat>Caveat")])]],
  ["thinking ignored", [userMsg("u", [{ kind: "thinking", text: "hidden" }, text("ok")])]],
  ["lone halves join", [userMsg("u", [text(`a${LONE_HI}`), text(`${LONE_LO}b`)])]],
  ["kelvin", [userMsg("u", [text(`<${KELVIN}>`)])]],
  ["accented", [userMsg("u", [text(E_ACUTE)])]],
  ["ideographic space prompt", [userMsg("u", [text(`${IDEO}${LS}`)])]],
]);

// ---- parse-init.ts

const INIT = {
  type: "system",
  subtype: "init",
  cwd: "/w",
  session_id: "s",
  tools: ["Bash", "Read", "advisor"],
  mcp_servers: [],
  model: "claude-opus-5-5",
  permissionMode: "default",
  slash_commands: ["compact", "context"],
  apiKeySource: "none",
  claude_code_version: "2.1.312",
  output_style: "default",
  agents: ["general-purpose"],
  skills: ["pdf"],
  plugins: [],
  fast_mode_state: "cooldown",
  fast_mode_disabled_reason: "network_error",
  effort: "xhigh",
  plugin_errors: [{ plugin: "p@m", type: "path-not-found", message: "gone", path: "/x" }],
};
section("parseInitSystemMessage", pi.parseInitSystemMessage, [
  ["undefined", []],
  ["null", [null]],
  ["empty", [{}]],
  ["string", ["init"]],
  ["number", [5]],
  ["array", [[1, 2]]],
  ["full", [INIT]],
  ["no advisor", [{ ...INIT, tools: ["Bash"] }]],
  ["odd arrays", [{ tools: ["a", 1, null, "advisor", ["x"]], slash_commands: "compact", agents: { 0: "a" }, skills: [true, "s", ""] }]],
  ["empty strings", [{ cwd: "", model: "", permissionMode: "", claude_code_version: "", fast_mode_disabled_reason: "" }]],
  ["odd strings", [{ cwd: 5, model: ["m"], permissionMode: "bananas", claude_code_version: { v: 1 }, fast_mode_disabled_reason: "future_reason" }]],
  ...["off", "cooldown", "on", "ON", "", 1, null, true].map((s) => [`fast_mode_state ${JSON.stringify(s)}`, [{ fast_mode_state: s }]]),
  ...["low", "medium", "high", "xhigh", "max", "auto", "HIGH", "", null, 5, false, ["low"]].map((e) => [`effort ${JSON.stringify(e)}`, [{ effort: e }]]),
  ["effort absent", [{ tools: [] }]],
  [
    "plugin errors",
    [
      {
        plugin_errors: [
          { plugin: "a@m", type: "generic-error", message: "boom" },
          { plugin: "b@m", type: "t", message: "m", path: "" },
          { plugin: "", type: "t", message: "m" },
          { plugin: "c", type: "", message: "m" },
          { plugin: "d", type: "t", message: "" },
          { plugin: "e", type: "t" },
          { plugin: 1, type: "t", message: "m" },
          { plugin: "f", type: "t", message: "m", path: 5, extra: true },
          null,
          "row",
          ["inline[0]", "t", "m"],
          { message: "m", type: "t", plugin: "g", path: "/p" },
        ],
      },
    ],
  ],
  ["plugin errors not array", [{ plugin_errors: { plugin: "a", type: "t", message: "m" } }]],
  ["plugin errors null", [{ plugin_errors: null }]],
  ["unicode", [{ cwd: `/w/${EMOJI}${LONE_HI}`, tools: [`${E_ACUTE}`, "advisor "], model: `${NBSP}` }]],
]);

// ---- parse-tasklist-result.ts

section("parseTaskListResult", ptl.parseTaskListResult, [
  ["undefined", []],
  ["null", [null]],
  ["empty", [""]],
  ["blank", ["  \n\t "]],
  ["blank feff", [`${FEFF}${NBSP}`]],
  ["blank nel", [NEL]],
  ["two lines", ["#1 [completed] Add shared advisor constants module\n#2 [in_progress] Plumb advisorModel through use-session.ts"]],
  ["crlf", ["#1 [pending] a\r\n#2 [completed] b\r\n"]],
  ["no match", ["No tasks found"]],
  ["mixed", ["Tasks:\n#a1 [pending]   spaced   subject  \nnoise\n#x-y [done] ok"]],
  ["missing subject", ["#1 [pending]"]],
  ["missing subject spaces", ["#1 [pending]    "]],
  ["empty status", ["#1 [] subject"]],
  ["spaced status", ["#1 [ in progress ] subject"]],
  ["no space after id", ["#1[pending] subject"]],
  ["no space after status", ["#1 [pending]subject"]],
  ["empty id", ["# [pending] subject"]],
  ["bracket in id", ["#a[b] [pending] subject"]],
  ["bracket in subject", ["#1 [pending] a ] b [c]"]],
  ["nbsp separators", [`#1${NBSP}[pending]${IDEO}subject`]],
  ["feff separators", [`#1${FEFF}[pending]${FEFF}subject${FEFF}`]],
  ["nel separator", [`#1${NEL}[pending] subject`]],
  ["nel in subject", [`#1 [pending] a${NEL}b`]],
  ["line separator in subject", [`#1 [pending] a${LS}b`]],
  ["cr in subject", ["#1 [pending] a\rb"]],
  ["cr in status", ["#1 [pen\rding] a"]],
  ["indented", ["   #1 [pending] a"]],
  ["unicode", [`#${EMOJI} [${E_ACUTE}] ${LONE_HI}x${LONE_LO}`]],
  ["long whitespace", [{ $repeat: ["#1 [p]" + " ".repeat(50), 200] }]],
]);

// ---- effort-wait-note.ts

const W = (inForce, waits, appliedSeen) => ({ inForce, waits, appliedSeen });
section("effortPicked", ew.effortPicked, [
  ["off turn", [W(null, false, false), { pending: false, picked: "high", shownBefore: "low" }]],
  ["off turn, waiting", [W("low", true, true), { pending: false, picked: "high", shownBefore: "low" }]],
  ["no effort param", [W(null, false, false), { pending: true, picked: "high", shownBefore: "low", noEffortParam: true }]],
  ["mid turn change", [W(null, false, false), { pending: true, picked: "high", shownBefore: "low" }]],
  ["mid turn same", [W(null, false, false), { pending: true, picked: "low", shownBefore: "low" }]],
  ["back to in force", [W("low", true, true), { pending: true, picked: "low", shownBefore: "high" }]],
  ["another change", [W("low", true, true), { pending: true, picked: "max", shownBefore: "high" }]],
  ["auto", [W(null, false, false), { pending: true, picked: "auto", shownBefore: "medium" }]],
  ["noEffortParam false", [W(null, false, false), { pending: true, picked: "max", shownBefore: "low", noEffortParam: false }]],
]);
section("effortApplied", ew.effortApplied, [
  ["nothing waiting", [W(null, false, false), "high"]],
  ["nothing waiting, null", [W(null, false, false), null]],
  ["null", [W("low", true, false), null]],
  ["same as in force", [W("low", true, false), "low"]],
  ["different", [W("low", true, false), "high"]],
  ["undefined", [W("low", true, false)]],
  ["number", [W("low", false, false), 5]],
  ["upper", [W("low", true, false), "LOW"]],
  ["already seen", [W("medium", true, true), "high"]],
]);
section("effortRequestStarted", ew.effortRequestStarted, [
  ["nothing waiting", [W(null, false, false)]],
  ["nothing waiting, seen", [W(null, true, true)]],
  ["applied", [W("low", true, true)]],
  ["not applied yet", [W("low", true, false)]],
]);
sections.NO_EFFORT_WAIT = enc(ew.NO_EFFORT_WAIT);

// ---- stop-self-paced-loop.ts / session-loops.ts

section("isScheduleWakeupStop", ssl.isScheduleWakeupStop, [
  ["undefined", []],
  ["null", [null]],
  ["stop", [{ stop: true }]],
  ["stop with delay", [{ stop: true, delaySeconds: 60 }]],
  ["stop string", [{ stop: "true" }]],
  ["stop 1", [{ stop: 1 }]],
  ["stop false", [{ stop: false }]],
  ["no stop", [{ delaySeconds: 60, prompt: "p" }]],
  ["array", [[true]]],
  ["string", ["stop"]],
  ["true", [true]],
]);
const LOOP = (id, kind, extra = {}) => ({
  kind,
  id,
  toolUseId: `tu-${id}`,
  cron: kind === "cron" ? "*/5 * * * *" : null,
  humanSchedule: kind === "cron" ? "Every 5 minutes" : null,
  delaySeconds: kind === "wakeup" ? 60 : null,
  prompt: "p",
  recurring: kind === "cron",
  durable: false,
  startedAt: NOW,
  ...extra,
});
section(
  "markWakeupsStopped",
  ssl.markWakeupsStopped,
  [
    ["empty", [{}]],
    ["cron only", [{ c1: LOOP("c1", "cron") }]],
    ["live wakeup", [{ c1: LOOP("c1", "cron"), w1: LOOP("w1", "wakeup", { noop: true, noopStreak: 2 }) }]],
    ["cancelled already", [{ w1: LOOP("w1", "wakeup", { cancelled: true }) }]],
    ["cancelled false", [{ w1: LOOP("w1", "wakeup", { cancelled: false }) }, NOW]],
    ["armed after the stop", [{ w1: LOOP("w1", "wakeup", { startedAt: NOW + 1 }) }, NOW]],
    ["armed at the stop", [{ w1: LOOP("w1", "wakeup") }, NOW]],
    ["stop null", [{ w1: LOOP("w1", "wakeup", { startedAt: NOW + 1 }) }, null]],
    ["mixed order", [{ b: LOOP("b", "wakeup", { startedAt: 1 }), 3: LOOP("3", "wakeup", { startedAt: NOW + 5 }), a: LOOP("a", "cron"), 1: LOOP("1", "wakeup", { startedAt: 2 }) }, NOW]],
    ["NaN startedAt", [{ w1: LOOP("w1", "wakeup", { startedAt: { $num: "NaN" } }) }, NOW]],
  ],
  { show: recordOut, same: true },
);
section("readCronNextFireAt", sl.readCronNextFireAt, [
  ["undefined", []],
  ["null", [null]],
  ["empty", [{}]],
  ["number", [{ nextFireAt: NOW + 60000 }]],
  ["fraction", [{ nextFireAt: 1.5 }]],
  ["zero", [{ nextFireAt: 0 }]],
  ["negative", [{ nextFireAt: -1 }]],
  ["string", [{ nextFireAt: String(NOW) }]],
  ["bool", [{ nextFireAt: true }]],
  ["huge", [{ nextFireAt: 1e308 }]],
  ["array", [[NOW]]],
  ["bare number", [NOW]],
  ["bare string", ["nextFireAt"]],
]);
// R14c: CronDelete's `endedLoopWakeup` (SDK 0.3.321).
section("readEndedLoopWakeup", sl.readEndedLoopWakeup, [
  ["undefined", []],
  ["null", [null]],
  ["empty", [{}]],
  ["true", [{ endedLoopWakeup: true }]],
  ["false", [{ endedLoopWakeup: false }]],
  ["one", [{ endedLoopWakeup: 1 }]],
  ["string", [{ endedLoopWakeup: "true" }]],
  ["nested", [{ result: { endedLoopWakeup: true } }]],
  ["array", [[true]]],
  ["bare true", [true]],
  ["bare string", ["endedLoopWakeup"]],
]);

// ---- workflow-meta.ts

const SCRIPT = [
  "export const meta = {",
  "  name: 'deploy-check',",
  "  description: \"Check the deploy, then report\",",
  "  phases: [",
  "    { title: 'Build', detail: 'compile everything' },",
  "    { title: `Test`, detail: \"run the suite\" },",
  "    { title: 'Ship' },",
  "  ],",
  "};",
  "",
  "export default async function run(ctx) { return { a: '}' }; }",
].join("\n");
section("parseWorkflowMeta", wm.parseWorkflowMeta, [
  ["undefined", []],
  ["null", [null]],
  ["empty", [""]],
  ["number", [5]],
  ["object", [{ name: "x" }]],
  ["no meta", ["export default function run() {}"]],
  ["full", [SCRIPT]],
  ["streaming", ["export const meta = {\n  name: 'deploy',\n  description: 'half a descr"]],
  ["streaming phases", ["export const meta = { name: \"n\", phases: [ { title: 'A' }, { title: 'B', detail: 'x"]],
  ["apostrophes", ["export const meta = { name: \"it's\", description: 'don\\'t \\\"stop\\\"' }"]],
  ["escapes", ["export const meta = { name: 'a\\nb\\tc\\\\d\\qe', description: `x\\`y` }"]],
  ["backslash at end", ["export const meta = { name: 'a\\"]],
  ["tight", ["export const meta={name:'t',description:'d',phases:[{title:'p'}]}"]],
  ["spaced keys", ["export const meta = {\n  name   :   'spaced' ,\n  description\t:\n'tabbed'\n}"]],
  ["export spacing", ["export\n\tconst\n meta\n=\n{ name: 'x' }"]],
  ["no space after export", ["exportconst meta = { name: 'x' }"]],
  ["two metas", ["export const meta = { name: 'first' }\nexport const meta = { name: 'second' }"]],
  ["second meta only", ["const meta = { name: 'no' }; export const meta = { name: 'yes' }"]],
  ["name inside phases first", ["export const meta = { phases: [{ title: 'T', name: 'inner' }], name: 'outer' }"]],
  ["key suffix", ["export const meta = { xname: 'no', fullname: 'no', name: 'yes' }"]],
  ["key in string", ["export const meta = { description: 'name: \"fake\"', name: 'real' }"]],
  ["bracket boundary", ["export const meta = { tags: [name: 'odd'] }"]],
  ["not a string", ["export const meta = { name: someVar, description: 42 }"]],
  ["empty title skipped", ["export const meta = { phases: [{ title: '' }, { title: 'x', detail: '' }, { detail: 'only' }] }"]],
  ["phases not objects", ["export const meta = { phases: ['a', 1, { title: 'ok' }, ['n']] }"]],
  ["phase braces in strings", ["export const meta = { phases: [{ title: 'a { b' }, { title: '} c', detail: '[d]' }] }"]],
  ["brace in array string", ["export const meta = { phases: [\"x{y\", { title: 'after' }] }"]],
  ["phases unbalanced", ["export const meta = { name: 'n', phases: [{ title: 'a' }, { title: 'b' "]],
  ["phases object unbalanced", ["export const meta = { phases: [{ title: 'a', detail: 'b' "]],
  ["phases not array", ["export const meta = { phases: { title: 'x' } }"]],
  ["phases key in name", ["export const meta = { name: 'phases: [{title: \"x\"}]' }"]],
  ["phases spaced", ["export const meta = {\nphases :\n [\n{ title : 'x' } ] }"]],
  ["phases after bracket", ["export const meta = { a: [phases: [{ title: 'odd' }]] }"]],
  ["unicode spaces", [`export${NBSP}const${FEFF}meta${IDEO}=${LS}{${NBSP}name:${FEFF}'u'${IDEO},description:${NEL}'nel' }`]],
  ["nel as separator", [`export${NEL}const meta = { name: 'x' }`]],
  ["nel before key", [`export const meta = {${NEL}name: 'x', description: 'y' }`]],
  ["astral", [`export const meta = { name: '${EMOJI}\\${EMOJI}${E_ACUTE}', phases: [{ title: '${EMOJI}' }] }`]],
  ["lone surrogates", [`export const meta = { name: '${LONE_HI}x${LONE_LO}', description: '\\${LONE_HI}' }`]],
  ["quote inside other quote", ["export const meta = { name: \"a'b`c\", description: '\"' }"]],
  ["no colon", ["export const meta = { name 'nocolon', description: 'd', phases [{ title: 'p' }] }"]],
  ["escaped quote before brace", ["export const meta = { name: 'a\\'}', x: 1 }\nconst y = { description: 'outside' }"]],
  ["phases twice", ["export const meta = { phases: 1, y: { phases: [{ title: 'n' }] } }"]],
  ["inner unbalanced", ["export const meta = { phases: [{ title: 'a', {title: 'b'} ] }"]],
  ["huge", [{ $repeat: ["export const meta = { name: 'n', phases: [{ title: 't' }] };\n", 300] }]],
]);

// ---- system-informational.ts / hook-events.ts / fast-mode.ts / advisor.ts

section("classifyInformationalLevel", si.classifyInformationalLevel, [
  ["undefined", []],
  ...["info", "notice", "suggestion", "warning", "INFO", "Notice", "", "error", " info"].map((l) => [l, [l]]),
  ["number", [5]],
  ["null", [null]],
]);
section("hookEventGetsDurablePill", he.hookEventGetsDurablePill, [
  ...["SessionStart", "Setup", "SubagentStart", "SessionEnd", "PreToolUse", "Stop", "sessionstart", "", "SessionStart "].flatMap((e) => [
    [`${e} ok`, [e, false]],
    [`${e} failed`, [e, true]],
  ]),
]);
section("isFastModeCreditsRejectedNotice", fm.isFastModeCreditsRejectedNotice, [
  ["undefined", []],
  ["null", [null]],
  ["string", [fm.FAST_MODE_CREDITS_REJECTED_KEY]],
  ["number", [5]],
  ["true", [true]],
  ["array", [[]]],
  ["empty", [{}]],
  ["notice", [{ type: "system", subtype: "notification", key: "fast-mode-overage-rejected", text: "out of credits", priority: "high" }]],
  ["other key", [{ type: "system", subtype: "notification", key: "other" }]],
  ["other subtype", [{ type: "system", subtype: "init", key: "fast-mode-overage-rejected" }]],
  ["other type", [{ type: "result", subtype: "notification", key: "fast-mode-overage-rejected" }]],
  ["key upper", [{ type: "system", subtype: "notification", key: "FAST-MODE-OVERAGE-REJECTED" }]],
  ["sdk event", [{ type: "sdk", message: { type: "system", subtype: "notification", key: "fast-mode-overage-rejected" } }]],
]);
sections.ADVISOR_ACTIVE_SENTINEL = adv.ADVISOR_ACTIVE_SENTINEL;

// R14c: the Opus 4.8 fast-mode deprecation (CC 2.1.316), the
// `canonicalModelId` it reads, and `prettyModelName`. The hook passes `notificationColor` the SDK
// message, always an object.
sections.OPUS48_FAST_DEPRECATION_KEY = fm.OPUS48_FAST_DEPRECATION_KEY;
const DEPRECATION = fm.OPUS48_FAST_DEPRECATION_KEY;
section("notificationColor", fm.notificationColor, [
  ["empty", [{}]],
  ["warning", [{ color: "warning" }]],
  ["error", [{ color: "error" }]],
  ["info", [{ color: "info" }]],
  ["upper", [{ color: "WARNING" }]],
  ["number", [{ color: 5 }]],
  ["deprecation", [{ key: DEPRECATION, priority: "immediate" }]],
  ["deprecation error", [{ key: DEPRECATION, color: "error" }]],
  ["deprecation info", [{ key: DEPRECATION, color: "info" }]],
  ["deprecation upper", [{ key: DEPRECATION.toUpperCase() }]],
  ["other key", [{ key: "other", color: "success" }]],
  ["string", ["warning"]],
  ["array", [["warning"]]],
]);
const REMOVAL = Date.parse("2026-11-30");
const IDS = [
  "claude-opus-4-8",
  "claude-opus-4.8",
  "claude-opus-4-8[1m]",
  "claude-opus-4-8-20251101",
  "us.anthropic.claude-opus-4-8-v1:0",
  "CLAUDE-OPUS-4-8",
  "claude-opus-4-80",
  "claude-opus-48",
  "claude-opus-4-7",
  "claude-sonnet-4-8",
  "claude-opus-4",
  "xclaude-opus-4-8",
  "claude-opus-4-8.5",
  "claude-opus-5-5",
  "claude-fable-5-2",
  "claude-mythos-5",
  "claude-opus-",
  "opus",
  "",
  null,
  undefined,
  5,
  "\u0130claude-opus-4-8",
];
section(
  "canonicalModelId",
  adv.canonicalModelId,
  IDS.map((id, i) => [`${i} ${String(id)}`, id === undefined ? [] : [id]]),
);
// The hook passes `prettyModelName` a lower-cased id (a string); a
// non-string comes back as itself, which the typed port doesn't take.
section(
  "prettyModelName",
  adv.prettyModelName,
  IDS.flatMap((id, i) =>
    typeof id === "number" ? [] : [[`${i} ${String(id)}`, id === undefined ? [] : [id]]],
  ),
);
section("opus48FastDeprecationText", fm.opus48FastDeprecationText, [
  ...IDS.map((id, i) => [`${i} ${String(id)}`, [id ?? null]]),
  ["now before", ["claude-opus-4-8", REMOVAL - 1]],
  ["now at", ["claude-opus-4-8", REMOVAL]],
  ["now after", ["claude-opus-4-8", REMOVAL + 1]],
  ["now null", ["claude-opus-4-8", null]],
  ["now 0", ["claude-opus-4-8", 0]],
]);

// ---- cost-pricing.ts

const MODELS = [
  undefined,
  "",
  "claude-opus-5-5",
  "claude-opus-5-50",
  "claude-opus-5",
  "claude-opus-4-8",
  "opus",
  "CLAUDE-OPUS-5-5",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
  `HAI${KELVIN}U`,
  "claude-fable-5-1",
  "fable-5.1",
  "claude-fable-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "gpt-5",
  `${LONG_S}onnet-5`,
  `claude-opus${EMOJI}`,
  "claude-haiku-opus",
  `claude-ha${U(0x130)}ku-5`,
  `CLAUDE-${U(0x39f)}PUS`,
];
const TOKENS = [
  ["million each", { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }],
  ["turn", { input: 1234, output: 567, cacheRead: 89012, cacheWrite5m: 3456, cacheWrite1h: 0 }],
  ["fractions", { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite5m: 0.7, cacheWrite1h: 0.9 }],
];
const EDGE_TOKENS = [
  ["zeros", { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }],
  ["negative zeros", { input: { $num: "-0" }, output: { $num: "-0" }, cacheRead: { $num: "-0" }, cacheWrite5m: { $num: "-0" }, cacheWrite1h: { $num: "-0" } }],
  ["overflow", { input: 1e308, output: 1e308, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }],
  ["NaN", { input: { $num: "NaN" }, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }],
  ["infinities", { input: { $num: "Infinity" }, output: { $num: "-Infinity" }, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }],
  ["negative", { input: -1000, output: 5, cacheRead: -3, cacheWrite5m: 0, cacheWrite1h: 7 }],
];
section("costFromTokens", cp.costFromTokens, [
  ...MODELS.flatMap((m) => TOKENS.map(([tl, t]) => [`${JSON.stringify(m ?? null)} ${tl}`, m === undefined ? [undefined, t] : [m, t]])),
  ...EDGE_TOKENS.map(([tl, t]) => [`sonnet ${tl}`, ["claude-sonnet-4-6", t]]),
]);

// ---- use-session.ts CONVERSATION_RESET_TRIGGER_LABEL

const RESET = us[PRIVATE_CONST];
sections.CONVERSATION_RESET_TRIGGER_LABEL = pairs(RESET);
// The reducer's read: `CONVERSATION_RESET_TRIGGER_LABEL[r.trigger ?? ""] ?? "reason unspecified"`.
section(
  "conversationResetDetail",
  (trigger) => RESET[trigger ?? ""] ?? "reason unspecified",
  [
    ["undefined", []],
    ["null", [null]],
    ...["clear", "plan_mode_exit", "fresh_session", "onboarding", "", "CLEAR", "unknown", "constructor", "toString", "__proto__", "hasOwnProperty"].map((t) => [t, [t]]),
  ],
);

writeFileSync(
  join(ROOT_DIR, "out.json"),
  `${JSON.stringify({ node: process.version, tz: process.env.TZ, now: NOW, sections }, null, 1)}\n`,
);
