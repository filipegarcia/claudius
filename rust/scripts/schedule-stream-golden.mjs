#!/usr/bin/env node
// Golden fixture for the live schedule routes (G07c), recorded from the real
// handlers: `app/api/schedule/[id]/runs/[runId]/stream/route.ts` (GET) on the
// real `scheduler.ts` / `scheduler-store.ts`, and
// `app/api/schedule/session-loops/route.ts` (GET) and `cancel/route.ts`
// (POST) on real `Session`s from the real `session-manager.ts`:
//
//   node rust/scripts/schedule-stream-golden.mjs     (node@22; builds claudius-fake-claude)
//
// Re-runs itself twice under `--experimental-transform-types` (two temp
// roots, both through realpath; both recordings must agree byte for byte)
// with its cwd at the repo (db.ts finds its migrations there), HOME at
// `<root>/home`, CLAUDE_CONFIG_DIR
// at `<root>/config` and TZ=America/New_York. A resolve hook maps the `@/`
// imports, scheduler.ts's and session.ts's SDK import to a shim that calls
// the real `query()` with `pathToClaudeCodeExecutable` set to the fake CLI,
// and their `./notification-bus` import to a no-op (the bus is G01 / S31).
// The CLIs share one script (`<root>/script.json`), log their argv and stdin
// in their cwd, and mark their gates in `events.jsonl` there.
//
// `pure`: the real `isStaleWakeup` (lib/shared/session-loops.ts) and
// `scheduledLoopCancelPrompt` (lib/shared/stop-self-paced-loop.ts).
//
// `stream`: one group of steps on a virtual clock, as
// schedule-routes-golden.mjs runs it. A load hook sends every `Date.now()`
// in scheduler.ts, scheduler-store.ts and cron.ts to the clock, scheduler.ts's
// `setTimeout` / `clearTimeout` and the stream route's `setInterval` /
// `clearInterval` to a virtual timer queue, and `randomUUID()` in
// scheduler.ts to counted ids (`00000000-0000-4000-8000-<n>`). Steps:
// - `start`: the run-now route for a job whose turn holds at a gate in its
//   cwd (`[gate]`), until the gate is reached;
// - `release`: write `<cwd>/release` and wait for the run-now answer;
// - `open`: the stream route for a run (`run` is a counted id or a raw URL
//   segment), read in the background; `close`: abort its request;
// - `tick`: move the clock `ms` forward, firing each due timer in turn (a
//   release never falls on a stream's 1 s check, which real time would
//   race);
// - `runs`: the runs route, recorded as `[status, attached]` per run.
// Each stream records its status, headers and chunks (`[text, ms since it
// opened]`, `end` when it closes); after each step, `after` holds each open
// stream's text so far and whether it ended.
//
// `loops`: one group on real sessions, on the real clock. `create` makes a
// session (`sessionManager.create`, fresh or resuming a recorded transcript
// with fixed timestamps), `input` sends it a prompt (`sendInput`) and waits
// for the turn, `rename` renames it, `reap` removes it
// (`sessionManager.remove`), `get` / `cancel` call the routes. After a route
// call every session is waited on until idle. Each step records the answer
// (status, content type, body text; or `threw`) and the user messages each
// session's CLI got since the step before (`wire`). Session ids are `$S<n>`
// (creation order), `uuid` values `$UUID`, and a `startedAt` the recording
// itself produced (a live loop, armed at `Date.now()`) is `"$LIVE"`.
// Transcript times are 2026-01-01 (past) or 2099-01-01 (future), so which
// wake-ups are stale doesn't depend on when this runs.
//
// `$ROOT` stands for the root and `$FAKE` for the fake CLI's path.
//
// Written to rust/crates/claudius-server/tests/fixtures/schedule_stream_golden.json
// and replayed by crates/claudius-server/tests/schedule_stream.rs.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/schedule_stream_golden.json");
const TZ = "America/New_York";

// ------------------------------- recording -------------------------------

if (!process.env.SCHED_STREAM_ROOT) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sched-stream-golden-")));
    try {
      if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error(`root needs escaping: ${root}`);
      mkdirSync(join(root, "project"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          // db.ts reads its migrations from `<cwd>/lib/server/db-migrations`.
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            TZ,
            SCHED_STREAM_ROOT: root,
            SCHED_STREAM_FAKE: fake,
            FAKE_CLAUDE_SCRIPT: join(root, "script.json"),
            FAKE_CLAUDE_ARGV: "argv.json",
            FAKE_CLAUDE_LOG: "stdin.log",
            FAKE_CLAUDE_EVENTS: "events.jsonl",
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
    const dir = mkdtempSync(join(tmpdir(), "sched-stream-golden-diff-"));
    writeFileSync(join(dir, "a.json"), runs[0]);
    writeFileSync(join(dir, "b.json"), runs[1]);
    throw new Error(`the two recordings differ (see ${dir})`);
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const reqs = fixture.loops.steps.filter((s) => s.got).length;
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.pure.stale.length} stale + ${fixture.pure.prompts.length} prompt cases, ` +
      `${fixture.stream.steps.length} stream steps (${Object.keys(fixture.stream.streams).length} streams), ` +
      `${fixture.loops.steps.length} loop steps (${reqs} requests) (SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.SCHED_STREAM_ROOT;
const FAKE = process.env.SCHED_STREAM_FAKE;
const SCRIPT = process.env.FAKE_CLAUDE_SCRIPT;
const HOME = process.env.HOME;
const SCHED = join(HOME, ".claude", "claudius", "schedule");
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);

const sdkShim = join(ROOT, "sdk-shim.mjs");
writeFileSync(
  sdkShim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: ${JSON.stringify(FAKE)} } });
}
`,
);
const busShim = join(ROOT, "bus-shim.mjs");
writeFileSync(
  busShim,
  `export const notificationBus = new Proxy({}, { get: () => () => Promise.resolve() });
`,
);

const NOW = "globalThis.__g.now()";
const UUID = "globalThis.__g.uuid()";
const REWRITES = {
  "/app/api/schedule/[id]/runs/[runId]/stream/route.ts": [
    ["setInterval(", "globalThis.__g.setInterval(", 2],
    ["clearInterval(", "globalThis.__g.clearTimeout(", 3],
  ],
  "/lib/server/scheduler.ts": [
    ["Date.now()", NOW, 6],
    // A run's pid would otherwise differ between the two recordings.
    ["process.pid", "777001", 2],
    ["setTimeout(", "globalThis.__g.setTimeout(", 2],
    ["clearTimeout(", "globalThis.__g.clearTimeout(", 1],
    ["randomUUID()", UUID, 1],
  ],
  "/lib/server/scheduler-store.ts": [["Date.now()", NOW, 1]],
  "/lib/shared/cron.ts": [["Date.now()", NOW, 1]],
};
const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SDK_SHIM = ${JSON.stringify(pathToFileURL(sdkShim).href)};
const BUS_SHIM = ${JSON.stringify(pathToFileURL(busShim).href)};
const REWRITES = ${JSON.stringify(REWRITES)};
export async function resolve(spec, ctx, next) {
  const parent = ctx.parentURL ?? "";
  const fromScheduler = parent.endsWith("/lib/server/scheduler.ts");
  const fromSession = parent.endsWith("/lib/server/session.ts");
  if ((fromScheduler || fromSession) && spec === ${JSON.stringify(SDK)}) return { url: SDK_SHIM, shortCircuit: true };
  if ((fromScheduler || fromSession) && spec === "./notification-bus") return { url: BUS_SHIM, shortCircuit: true };
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
  const r = await next(url, ctx);
  const key = Object.keys(REWRITES).find((k) => decodeURIComponent(url).endsWith(k));
  if (!key) return r;
  let src = typeof r.source === "string" ? r.source : Buffer.from(r.source).toString("utf8");
  for (const [from, to, n] of REWRITES[key]) {
    const got = src.split(from).length - 1;
    if (got !== n) throw new Error(key + ": expected " + n + " of " + from + ", found " + got);
    src = src.split(from).join(to);
  }
  return { ...r, source: src };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

// ---- the virtual clock, timers and ids --------------------------------------------

const G = (globalThis.__g = {
  t: 0,
  seq: 0,
  n: 0,
  timers: new Set(),
  now: () => G.t,
  add(cb, delay, period) {
    let d = Number(delay);
    if (!(d >= 1 && d <= 2147483647)) d = 1;
    const h = { due: G.t + d, seq: G.seq++, cb, period: period ? d : 0 };
    G.timers.add(h);
    return h;
  },
  setTimeout: (cb, delay) => G.add(cb, delay, false),
  setInterval: (cb, delay) => G.add(cb, delay, true),
  clearTimeout(h) {
    if (h) G.timers.delete(h);
  },
  uuid() {
    G.n += 1;
    return `00000000-0000-4000-8000-${String(G.n).padStart(12, "0")}`;
  },
});

const imp = (rel) => import(pathToFileURL(realpathSync(join(repo, rel))).href);
const { scheduler } = await imp("lib/server/scheduler.ts");
const { sessionManager } = await imp("lib/server/session-manager.ts");
const { isStaleWakeup } = await imp("lib/shared/session-loops.ts");
const { scheduledLoopCancelPrompt } = await imp("lib/shared/stop-self-paced-loop.ts");
const routes = {
  stream: await imp("app/api/schedule/[id]/runs/[runId]/stream/route.ts"),
  runNow: await imp("app/api/schedule/[id]/run-now/route.ts"),
  runs: await imp("app/api/schedule/[id]/runs/route.ts"),
  loops: await imp("app/api/schedule/session-loops/route.ts"),
  cancel: await imp("app/api/schedule/session-loops/cancel/route.ts"),
};
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8"),
).version;

// ---- helpers ------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const turn = () => new Promise((r) => setImmediate(r));
async function settle(n = 20) {
  for (let i = 0; i < n; i++) await turn();
}
const norm = (s) => s.split(FAKE).join("$FAKE").split(ROOT).join("$ROOT");
const denorm = (s) => s.split("$ROOT").join(ROOT);
// Non-ASCII without escapes in this file: a code point, and a JSON `\uXXXX`
// escape as text.
const cp = (...n) => String.fromCodePoint(...n);
const ju = (hex) => `${"\\"}u${hex}`;
const hexOf = (s) => Buffer.from(s, "utf8").toString("hex");

async function waitFor(what, f, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!f()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function marks(cwd) {
  const f = join(ROOT, cwd, "events.jsonl");
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l === '{"mark":"gate"}').length;
}

async function got(p) {
  try {
    const r = await p;
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  } catch (e) {
    return { threw: `${e?.name}: ${e?.message}` };
  }
}

// ---- the fake CLI's script --------------------------------------------------------

const msg = (role, content, extra = {}) => ({
  type: role,
  message: { role, content, ...(role === "assistant" ? { id: `msg_${extra.n ?? 0}`, model: "fake" } : {}) },
  parent_tool_use_id: null,
  session_id: "fake-session",
  uuid: extra.uuid ?? "$UUID",
  ...(extra.toolUseResult === undefined ? {} : { tool_use_result: extra.toolUseResult }),
});
const tu = (id, name, input) => ({ type: "tool_use", id, name, input });
const tr = (id, content, extra = {}) => ({ type: "tool_result", tool_use_id: id, content, ...extra });
const text = (t) => ({ type: "text", text: t });
const res = (over = {}) => ({ session_id: "fake-session", uuid: "result-uuid", ...over });

const ODD_ID = `toolu_q\`x\`${cp(0xe9)}`;
const FAR_FIRE = 4102444800000; // 2100-01-01
const SCRIPT_BODY = {
  init: { session_id: "fake-session", uuid: "init-uuid" },
  turns: [
    // Scheduled runs (the stream).
    {
      match: "[gate]",
      repeat: true,
      steps: [
        { $mark: "gate" },
        { $wait_file: "release" },
        msg("assistant", [text("released: $PROMPT")], { n: 1, uuid: "asst-gate" }),
      ],
      result: res({ total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 } }),
    },
    // Live loops (session-loops).
    {
      match: "[arm-cron]",
      steps: [
        msg("assistant", [tu("toolu_live_c1", "CronCreate", { cron: "*/5 * * * *", prompt: "check CI", recurring: true })], { n: 2 }),
        msg("assistant", [tu("toolu_live_c9", "CronCreate", { cron: "0 * * * *", prompt: "never answered" })], { n: 3 }),
        msg(
          "user",
          [
            tr(
              "toolu_live_c1",
              "Scheduled recurring job abc123 (Every 5 minutes). Session-only (not written to disk, dies when Claude exits).",
            ),
          ],
          { toolUseResult: { id: "abc123", nextFireAt: FAR_FIRE } },
        ),
      ],
    },
    {
      // Since 68548d17 (SDK 0.3.301) `nextFireAt` comes from the CronCreate
      // result only, so this CronList refresh leaves the loop's value alone.
      match: "[list]",
      steps: [
        msg("assistant", [tu("toolu_live_l1", "CronList", {})], { n: 4 }),
        msg("user", [tr("toolu_live_l1", [text("abc123 */5 * * * *")])], {
          // The same `nextFireAt` the CronCreate reported: the current TS
          // reads one only off a CronCreate (CC 2.1.301 dropped the CronList
          // refresh, which is R04's port), so this step pins that a listing
          // leaves the loop alone either way.
          toolUseResult: { jobs: [{ id: "abc123", nextFireAt: FAR_FIRE }, { id: "zzz", nextFireAt: 5 }] },
        }),
      ],
    },
    {
      match: "[arm-wake]",
      steps: [
        msg(
          "assistant",
          [tu("toolu_live_w1", "ScheduleWakeup", { delaySeconds: 1200, prompt: "/loop tick", reason: "wait for CI", noop: true })],
          { n: 5 },
        ),
      ],
    },
    {
      match: "[arm-stale]",
      steps: [msg("assistant", [tu("toolu_live_w2", "ScheduleWakeup", { delaySeconds: -120, prompt: "/loop late" })], { n: 6 })],
    },
    // What the agent does with the cancel prompts.
    ...[
      ["abc123", "abc123"],
      ["pc2", "pc2"],
      ["toolu_q`x`", ODD_ID],
    ].map(([needle, id], i) => ({
      match: `with id \`${needle}`,
      steps: [
        msg("assistant", [tu(`toolu_del_${i}`, "CronDelete", { id })], { n: 10 + i }),
        msg("user", [tr(`toolu_del_${i}`, `Cancelled job ${id}.`)]),
      ],
    })),
    // CC 2.1.311 -- a session whose CLI ends on its own, loop and all.
    {
      match: "[arm-die]",
      steps: [
        msg("assistant", [tu("toolu_die_c1", "CronCreate", { cron: "*/5 * * * *", prompt: "check", recurring: true })], { n: 30 }),
        msg("user", [tr("toolu_die_c1", "Scheduled recurring job die1 (Every 5 minutes).")], {
          toolUseResult: { id: "die1" },
        }),
        { $exit: 0 },
      ],
      result: false,
    },
    {
      match: "Please stop the self-paced loop",
      repeat: true,
      steps: [msg("assistant", [tu("$UUID", "ScheduleWakeup", { stop: true })], { n: 20 })],
    },
  ],
};
writeFileSync(SCRIPT, JSON.stringify(SCRIPT_BODY));

// ---- the world ------------------------------------------------------------------------

const DIRS = ["home/.claude/.claudius", "config", "jobs2", "ws1", "ws2", "ws3", "ws4", "ws5", "ws6"];
const ws = (n) => ({
  id: `wks_golden0000${n}`,
  name: `ws${n}`,
  rootPath: `$ROOT/ws${n}`,
  icon: { kind: "letter", letter: "W", color: "#d97757" },
  createdAt: 1,
  updatedAt: 1,
});
const WORLD_FILES = [
  [
    "home/.claude/.claudius/workspaces.json",
    `${JSON.stringify({ version: 1, workspaces: [1, 2, 3, 4, 5, 6].map(ws) }, null, 2)}\n`,
  ],
];
for (const d of DIRS) mkdirSync(join(ROOT, d), { recursive: true });
for (const [rel, t] of WORLD_FILES) writeFileSync(join(ROOT, rel), denorm(t));

// ================================ pure ================================

const T_PAST = Date.UTC(2026, 0, 1);
const STALE_CASES = [];
for (const [kind, startedAt, delaySeconds] of [
  ["wakeup", 1000, 0],
  ["wakeup", 1000, 1],
  ["wakeup", 1000, 0.1],
  ["wakeup", 1000, 0.0015],
  ["wakeup", 1000, -0],
  ["wakeup", 1000, -60],
  ["wakeup", 1000, -61],
  ["wakeup", 0, 60],
  ["wakeup", -5000, 1],
  ["wakeup", T_PAST, 600],
  ["wakeup", T_PAST, 1e10],
  ["wakeup", T_PAST, 1e300],
  ["wakeup", T_PAST, null],
  ["wakeup", 9007199254740991, 1],
  ["cron", 1000, 0],
  ["cron", 1000, null],
  ["cron", T_PAST, -1e10],
]) {
  const fire = startedAt + (delaySeconds ?? 0) * 1000;
  for (const now of [fire + 59999, fire + 60000, fire + 60000.5, fire + 60001, fire - 1, 0, T_PAST + 1e12]) {
    STALE_CASES.push({ kind, startedAt, delaySeconds, now, stale: isStaleWakeup({ kind, startedAt, delaySeconds }, now) });
  }
}
const PROMPT_CASES = [
  ["cron", "abc123"],
  ["cron", ""],
  ["cron", ODD_ID],
  ["cron", "line\nbreak $& $1 ${x}"],
  ["cron", `astral ${cp(0x1f389)} ${cp(0x4e2d)}`],
  ["wakeup", "toolu_w"],
  ["wakeup", ""],
].map(([kind, id]) => ({ kind, id, prompt: scheduledLoopCancelPrompt({ kind, id }) }));

// ================================ stream ================================

const T0 = Date.parse("2026-10-27T13:02:00.000Z") + 123;
const FAR = "0 0 29 2 *";
const job = (id, prompt, cwd) => ({
  id,
  name: `job ${id}`,
  cron: FAR,
  prompt,
  cwd: `$ROOT/${cwd}`,
  enabled: false,
  createdAt: 1000,
  updatedAt: 2000,
});
const JOBS = [job("g1", "[gate] one", "project"), job("g2", "[gate] two", "jobs2")];
mkdirSync(SCHED, { recursive: true });
writeFileSync(join(SCHED, "jobs.json"), denorm(`${JSON.stringify({ jobs: JOBS }, null, 2)}\n`));

const R = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STREAM_STEPS = [
  // Unknown: `run_not_live`, then the marker at the first check.
  { op: "open", name: "U", job: "g1", run: "nope" },
  { op: "tick", ms: 999 },
  { op: "tick", ms: 1 },
  // A live run: joiners get its events so far, then what follows.
  { op: "start", job: "g1", cwd: "project" },
  { op: "runs", job: "g1" },
  { op: "open", name: "A", job: "g1", run: R(1) },
  { op: "runs", job: "g1" },
  { op: "tick", ms: 500 },
  { op: "open", name: "B", job: "g1", run: R(1) },
  { op: "tick", ms: 600 },
  { op: "close", name: "B" },
  { op: "runs", job: "g1" },
  { op: "close", name: "A" },
  { op: "runs", job: "g1" },
  // The heartbeat, then the run's end and the marker at the next check.
  { op: "open", name: "C", job: "g1", run: R(1) },
  { op: "tick", ms: 15000 },
  { op: "tick", ms: 500 },
  { op: "release", job: "g1", cwd: "project" },
  { op: "runs", job: "g1" },
  { op: "tick", ms: 500 },
  // Ended, still buffered (5 s): a replay, then the marker.
  { op: "tick", ms: 500 },
  { op: "open", name: "D", job: "g1", run: R(1) },
  { op: "tick", ms: 1000 },
  // Gone: `run_not_live`.
  { op: "tick", ms: 4000 },
  { op: "open", name: "E", job: "g1", run: R(1) },
  { op: "tick", ms: 1000 },
  // Two runs at once: each stream sees its own; `:id` isn't read.
  { op: "start", job: "g1", cwd: "project" },
  { op: "start", job: "g2", cwd: "jobs2" },
  { op: "open", name: "F", job: "g1", run: R(2) },
  { op: "open", name: "G", job: "other", run: R(3) },
  { op: "runs", job: "g1" },
  { op: "runs", job: "g2" },
  { op: "tick", ms: 300 },
  { op: "release", job: "g2", cwd: "jobs2" },
  { op: "tick", ms: 400 },
  { op: "release", job: "g1", cwd: "project" },
  { op: "tick", ms: 300 },
  // Odd ids, decoded from the path, in the marker.
  { op: "open", name: "H", job: "g1", run: "caf%C3%A9%20x" },
  { op: "open", name: "I", job: "g1", run: "a%22b%5Cc%3Adone" },
  { op: "tick", ms: 1000 },
  { op: "tick", ms: 5000 },
];

async function advance(ms) {
  const target = G.t + ms;
  for (;;) {
    let next = null;
    for (const h of G.timers) {
      if (h.due <= target && (!next || h.due < next.due || (h.due === next.due && h.seq < next.seq))) next = h;
    }
    if (!next) break;
    G.t = next.due;
    if (next.period) {
      next.due += next.period;
      next.seq = G.seq++;
    } else {
      G.timers.delete(next);
    }
    next.cb();
    await settle();
  }
  G.t = target;
  await settle();
}

const streams = {};
const opened = [];
const pendingRuns = new Map();
const stepsOut = [];

function call(handler, url, params, init = {}) {
  const request = new Request(`http://localhost${url}`, { headers: { "content-type": "application/json" }, ...init });
  return handler(request, { params: Promise.resolve(params) });
}

async function streamStep(step) {
  switch (step.op) {
    case "open": {
      const ac = new AbortController();
      const url = `/api/schedule/${step.job}/runs/${step.run}/stream`;
      const res = await call(routes.stream.GET, url, { id: step.job, runId: decodeURIComponent(step.run) }, { signal: ac.signal });
      const s = {
        url,
        status: res.status,
        headers: [...res.headers].sort(),
        chunks: [],
        ac,
        at: G.t,
        ended: false,
      };
      streams[step.name] = s;
      opened.push(step.name);
      const decoder = new TextDecoder();
      (async () => {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            s.ended = true;
            s.chunks.push(["end", G.t - s.at]);
            return;
          }
          s.chunks.push([norm(decoder.decode(value)), G.t - s.at]);
        }
      })();
      await settle();
      return undefined;
    }
    case "close":
      streams[step.name].ac.abort();
      await settle();
      return undefined;
    case "tick":
      await advance(step.ms);
      return undefined;
    case "start": {
      const n = marks(step.cwd) + 1;
      const before = scheduler.liveRuns.size;
      pendingRuns.set(step.job, got(call(routes.runNow.POST, `/api/schedule/${step.job}/run-now`, { id: step.job }, { method: "POST" })));
      await waitFor(`the gate in ${step.cwd}`, () => marks(step.cwd) >= n);
      await waitFor("the run's first events", () => {
        const live = [...scheduler.liveRuns.values()].filter((b) => !b.done);
        return scheduler.liveRuns.size > before && live.every((b) => b.events.length >= 2);
      });
      await settle();
      return undefined;
    }
    case "release": {
      const gate = join(ROOT, step.cwd, "release");
      writeFileSync(gate, "");
      const r = await pendingRuns.get(step.job);
      pendingRuns.delete(step.job);
      unlinkSync(gate);
      await settle();
      if (r.status !== 202) throw new Error(`run-now: ${JSON.stringify(r)}`);
      return { status: r.status, body: r.body };
    }
    case "runs": {
      const r = await got(call(routes.runs.GET, `/api/schedule/${step.job}/runs`, { id: step.job }));
      return { status: r.status, runs: JSON.parse(r.body).runs.map((x) => [x.id, x.status, x.attached ?? null]) };
    }
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

G.t = T0;
for (const [i, step] of STREAM_STEPS.entries()) {
  const r = await streamStep(step);
  const rec = { ...step, clock: G.t - T0 };
  if (r !== undefined) rec.got = r;
  rec.after = Object.fromEntries(
    opened.map((name) => [name, { text: streams[name].chunks.filter((c) => c[0] !== "end").map((c) => c[0]).join(""), ended: streams[name].ended }]),
  );
  stepsOut.push(rec);
  if (i === STREAM_STEPS.length - 1 && opened.some((n) => !streams[n].ended)) throw new Error("a stream is still open");
}
if (pendingRuns.size) throw new Error("a run is still in flight");
const streamFixture = {
  t0: T0,
  jobs: JOBS,
  steps: stepsOut,
  streams: Object.fromEntries(
    Object.entries(streams).map(([name, s]) => [name, { url: s.url, status: s.status, headers: s.headers, chunks: s.chunks }]),
  ),
};

// ================================ loops ================================

const T_FUT = Date.UTC(2099, 0, 1);
const iso = (ms) => new Date(ms).toISOString();
const R3 = "3a3a3a3a-0000-4000-8000-000000000003";
const R4 = "4b4b4b4b-0000-4000-8000-000000000004";
const R5 = "5c5c5c5c-0000-4000-8000-000000000005";

function transcript(id, cwd, entries) {
  let parent = null;
  const lines = entries.map(([kind, uuid, at, content, extra = {}]) => {
    const role = kind === "assistant" ? "assistant" : "user";
    const line = {
      type: kind,
      uuid,
      parentUuid: parent,
      sessionId: id,
      cwd,
      timestamp: iso(at),
      message: role === "assistant" ? { role, id: `msg_${uuid}`, type: "message", model: "fake", content } : { role, content },
      ...extra,
    };
    parent = uuid;
    return line;
  });
  return lines;
}

const TRANSCRIPTS = [
  [
    R3,
    "ws3",
    [
      ["user", "u0", T_PAST, "loop it"],
      [
        "assistant",
        "a1",
        T_PAST + 1000,
        [
          tu("toolu_p1", "CronCreate", { cron: "0 9 * * *", prompt: "standup", recurring: true }),
          tu("toolu_p2", "CronCreate", { cron: "*/10 * * * *", prompt: "poll" }),
          tu("toolu_p3", "CronCreate", { cron: "0 0 * * *", prompt: "fails" }),
          tu(ODD_ID, "CronCreate", { cron: "0 12 * * *", prompt: "odd id" }),
        ],
      ],
      [
        "user",
        "r1",
        T_PAST + 2000,
        [
          tr("toolu_p2", "Scheduled recurring job pc2 (Every 10 minutes). Session-only (not written to disk)."),
          tr("toolu_p1", "Scheduled job pc1 (At 09:00)."),
          tr("toolu_p3", "boom", { is_error: true }),
          tr(ODD_ID, "Done."),
        ],
      ],
      ["assistant", "a2", T_PAST + 3000, [tu("toolu_w1", "ScheduleWakeup", { delaySeconds: 60, prompt: "/loop a" })]],
      ["assistant", "a3", T_PAST + 4000, [tu("toolu_s1", "ScheduleWakeup", { stop: true })]],
      [
        "assistant",
        "a4",
        T_PAST + 5000,
        [tu("toolu_w2", "ScheduleWakeup", { delaySeconds: "60", prompt: "/loop b", reason: "string delay" })],
      ],
    ],
  ],
  [
    R4,
    "ws4",
    [
      ["user", "u0", T_FUT, "weekly"],
      ["assistant", "a1", T_FUT + 1000, [tu("toolu_f1", "CronCreate", { cron: "30 8 * * 1", prompt: "weekly" })]],
      ["user", "r1", T_FUT + 2000, [tr("toolu_f1", [text("Scheduled recurring job fw1 (At 08:30 on Monday).")])]],
      [
        "assistant",
        "a2",
        T_FUT + 3000,
        [tu("toolu_fw", "ScheduleWakeup", { delaySeconds: 0.5, prompt: `soon ${cp(0x1f389)}`, noop: true })],
      ],
    ],
  ],
  [
    R5,
    "ws5",
    [
      ["user", "u0", T_PAST, "tie"],
      ["assistant", "a1", T_PAST + 1000, [tu("toolu_t1", "CronCreate", { cron: "5 5 * * *", prompt: "tie" })]],
      ["user", "r1", T_PAST + 1500, [tr("toolu_t1", "Scheduled recurring job tie5 (At 05:05).")]],
      ["assistant", "a2", T_PAST + 6000, [tu("toolu_w5", "ScheduleWakeup", { delaySeconds: 60, prompt: "/loop c" })]],
    ],
  ],
];
const transcriptFiles = TRANSCRIPTS.map(([id, cwd, entries]) => {
  const lines = transcript(id, `$ROOT/${cwd}`, entries);
  if (id === R4) lines.push({ type: "custom-title", customTitle: "Nightly sweep", sessionId: id });
  return { id, cwd, text: lines.map((l) => `${JSON.stringify(l)}\n`).join("") };
});
const projectDir = (cwd) => join(process.env.CLAUDE_CONFIG_DIR, "projects", join(ROOT, cwd).replace(/[^a-zA-Z0-9]/g, "-"));
for (const f of transcriptFiles) {
  mkdirSync(projectDir(f.cwd), { recursive: true });
  writeFileSync(join(projectDir(f.cwd), `${f.id}.jsonl`), denorm(f.text));
}

const cancel = (body) => ({ op: "cancel", body: typeof body === "string" ? body : JSON.stringify(body) });
const cancelHex = (hex) => ({ op: "cancel", hex });
const get = { op: "get" };
const LOOP_STEPS = [
  get,
  { op: "create", cwd: "ws1" },
  get,
  { op: "input", session: "$S1", text: "[arm-cron]" },
  get,
  { op: "input", session: "$S1", text: "[list]" },
  get,
  { op: "create", cwd: "ws2" },
  { op: "input", session: "$S2", text: "[arm-wake]" },
  get,
  { op: "create", cwd: "ws3", resume: R3 },
  { op: "create", cwd: "ws4", resume: R4 },
  { op: "create", cwd: "ws5", resume: R5 },
  get,
  { op: "rename", session: "$S1", title: ` Caf${cp(0xe9)} ${cp(0x1f389)} ` },
  get,
  { op: "input", session: "$S2", text: "[arm-stale]" },
  get,
  // The body: `try { await req.json() } catch { 400 }`.
  cancel(""),
  cancel("{"),
  cancelHex("ff"),
  // `?.trim()` on each id, both before the check.
  cancel("null"),
  cancel("[]"),
  cancel('"str"'),
  cancel("5"),
  cancel({}),
  cancel({ sessionId: "$S1" }),
  cancel({ loopId: "abc123" }),
  cancel({ sessionId: "", loopId: "abc123" }),
  cancel({ sessionId: " \t\n", loopId: "abc123" }),
  cancel({ sessionId: null, loopId: null }),
  cancel({ sessionId: "$S1", loopId: cp(0xa0, 0xfeff) }),
  cancel({ sessionId: 5, loopId: "abc123" }),
  cancel({ sessionId: "", loopId: 5 }),
  cancel({ sessionId: "$S1", loopId: true }),
  cancel({ sessionId: {}, loopId: "abc123" }),
  cancel({ sessionId: "$S1", loopId: ["abc123"] }),
  cancel({ sessionId: 5, loopId: [] }),
  cancel('{"sessionId":1e400,"loopId":"abc123"}'),
  cancel('{"sessionId":"$S1","loopId":-1e400}'),
  // Then the session and the loop.
  cancel({ sessionId: "nope", loopId: "abc123" }),
  cancel({ sessionId: "$S1", loopId: "ABC123" }),
  cancel({ sessionId: "$S1", loopId: "toolu_live_c9" }),
  cancel({ sessionId: "$S1", loopId: "toolu_live_c1" }),
  cancel({ sessionId: "$S3", loopId: "toolu_p3" }),
  cancel(`{"sessionId":"$S1","loopId":"abc${ju("d800")}"}`),
  // A live cron: the agent is asked to delete it; once it has, it's done.
  cancel({ sessionId: "$S1", loopId: "abc123" }),
  get,
  cancel({ sessionId: ` $S1${cp(0x2028)}`, loopId: `${cp(0x3000)}abc123 ` }),
  // A stale wake-up still counts.
  cancel({ sessionId: "$S2", loopId: "toolu_live_w2" }),
  cancel({ sessionId: "$S2", loopId: "toolu_live_w1" }),
  get,
  // Recorded ids: backticks and all; a cancelled stale wake-up.
  cancel({ sessionId: "$S3", loopId: ODD_ID }),
  get,
  cancel({ sessionId: "$S3", loopId: "toolu_w1" }),
  cancelHex(`efbbbf${hexOf(JSON.stringify({ sessionId: "$S3", loopId: "pc2" }))}`),
  get,
  // A wake-up armed after the stop (2099) outlives it.
  cancel({ sessionId: "$S4", loopId: "toolu_fw" }),
  get,
  cancel({ sessionId: "$S5", loopId: "toolu_w5" }),
  cancel({ sessionId: "$S5", loopId: "tie5", extra: true }),
  get,
  { op: "reap", session: "$S4" },
  get,
  cancel({ sessionId: "$S4", loopId: "fw1" }),
  { op: "reap", session: "$S2" },
  get,
  // CC 2.1.311 -- the CLI ended on its own: its loops no longer run, so a
  // cancel is 410 before the loop is even looked up, and no prompt is sent.
  { op: "create", cwd: "ws6" },
  { op: "input", session: "$S6", text: "[arm-die]" },
  get,
  cancel({ sessionId: "$S6", loopId: "die1" }),
  cancel({ sessionId: "$S6", loopId: "nope" }),
  get,
];

const ids = []; // session ids, by `$S<n>`
const live = new Map(); // id -> { cwd, lines }
const placeholders = (s) => {
  let t = norm(s);
  ids.forEach((id, i) => {
    t = t.split(id).join(`$S${i + 1}`);
  });
  return t;
};
const unplace = (s) => {
  let t = denorm(s);
  // Longest first: `$S1` is a prefix of `$S10`.
  for (let i = ids.length; i >= 1; i--) t = t.split(`$S${i}`).join(ids[i - 1]);
  return t;
};

const RECORD_START = Date.now();
function normalizeLoops(bodyText) {
  const v = JSON.parse(bodyText);
  if (Array.isArray(v?.loops)) {
    for (const l of v.loops) {
      if (typeof l.startedAt === "number" && l.startedAt >= RECORD_START && l.startedAt <= Date.now()) l.startedAt = "$LIVE";
    }
  }
  return JSON.stringify(v);
}

function wireLines(cwd) {
  const f = join(ROOT, cwd, "stdin.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((l) => JSON.parse(l).type === "user")
    .map((l) => placeholders(l).replace(/"uuid":"[0-9a-f-]{36}"/g, '"uuid":"$UUID"'));
}

async function idle() {
  for (const s of sessionManager.list()) {
    await waitFor(`${s.id} idle`, () => s.getStatus() === "idle");
  }
  await sleep(20);
  await settle();
}

async function loopStep(step) {
  switch (step.op) {
    case "create": {
      const s = await sessionManager.create({ cwd: join(ROOT, step.cwd), ...(step.resume ? { resume: step.resume } : {}) });
      ids.push(s.id);
      live.set(s.id, { cwd: step.cwd, seen: 0 });
      await idle();
      return { session: `$S${ids.length}` };
    }
    case "input": {
      const s = sessionManager.get(unplace(step.session));
      s.sendInput(step.text);
      await idle();
      return undefined;
    }
    case "rename": {
      const s = sessionManager.get(unplace(step.session));
      const r = await s.rename(step.title);
      await idle();
      return { result: r };
    }
    case "reap": {
      const id = unplace(step.session);
      await sessionManager.remove(id);
      await settle();
      return undefined;
    }
    case "get": {
      const r = await got(routes.loops.GET(new Request("http://localhost/api/schedule/session-loops")));
      await idle();
      return { ...r, body: placeholders(normalizeLoops(r.body)) };
    }
    case "cancel": {
      const bytes =
        step.hex !== undefined
          ? Buffer.from(unplace(Buffer.from(step.hex, "hex").toString("latin1")), "latin1")
          : Buffer.from(unplace(step.body), "utf8");
      const r = await got(
        routes.cancel.POST(
          new Request("http://localhost/api/schedule/session-loops/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: bytes,
          }),
        ),
      );
      await idle();
      return r.threw === undefined ? { ...r, body: placeholders(r.body) } : { threw: placeholders(r.threw) };
    }
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

const loopSteps = [];
for (const step of LOOP_STEPS) {
  const r = await loopStep(step);
  const rec = { ...step };
  if (r !== undefined) {
    if (step.op === "create") rec.session = r.session;
    else rec.got = r;
  }
  // The user messages each session's CLI got during the step.
  const wire = {};
  ids.forEach((id, i) => {
    const l = live.get(id);
    const lines = wireLines(l.cwd);
    if (lines.length > l.seen) wire[`$S${i + 1}`] = lines.slice(l.seen);
    l.seen = lines.length;
  });
  if (Object.keys(wire).length) rec.wire = wire;
  loopSteps.push(rec);
}
for (const s of sessionManager.list()) await sessionManager.remove(s.id);

writeFileSync(
  join(ROOT, "out.json"),
  JSON.stringify({
    sdkVersion,
    tz: TZ,
    world: { dirs: DIRS, files: WORLD_FILES },
    script: SCRIPT_BODY,
    pure: { stale: STALE_CASES, prompts: PROMPT_CASES },
    stream: streamFixture,
    loops: { transcripts: transcriptFiles, steps: loopSteps },
  }),
);
process.exit(0);
