#!/usr/bin/env node
// Golden fixture for the scheduler (G07a): `lib/server/scheduler-store.ts`
// and `lib/server/scheduler.ts`, recorded from the TS sources.
//
//   node rust/scripts/scheduler-golden.mjs     (node@22; builds claudius-fake-claude)
//
// Re-runs itself twice under `--experimental-transform-types` (two temp
// roots; both recordings must agree byte for byte) with HOME in the temp
// root, TZ=America/New_York and a resolve hook for the `@/` imports. The
// hook maps scheduler.ts's SDK import to a shim that calls the real
// `query()` with one option added, `pathToClaudeCodeExecutable` (the fake
// CLI), and its `./notification-bus` import to a recorder (the bus is G01).
//
// A load hook stubs the clock. In scheduler.ts, scheduler-store.ts and
// cron.ts every `Date.now()` reads a virtual clock, and scheduler.ts's
// `setTimeout` / `clearTimeout` go to a virtual timer queue (with Node's
// clamp: a delay below 1 ms or past 2^31-1 is 1 ms). Run ids come from a
// per-job counter (`<String(job.id)>#<n>`) instead of `randomUUID()`. The
// timer's `getJob(...).then(fire)` chain is tracked, as are `arm` and `fire`
// (patched on the instance), so the driver knows when the scheduler has
// settled. Each rewrite checks how many anchors it replaced.
//
// scheduler.ts's `process.pid` reads PID (777001), so a run's recorded pid
// is the same in both recordings and the replay can map it to its own
// process's; `process.uptime()` is stubbed so the interrupted-run recovery's
// `processStartedAt` is the scenario's `procStart` exactly. `process.kill`
// is NOT stubbed: the recovery's liveness probe runs against real pids, 1
// (alive, and not ours: EPERM) and 999999 (past any pid), so the replay
// probes the same ones.
//
// Each scenario starts from an empty `~/.claude`, a fresh `Scheduler`
// (`new scheduler.constructor()`) and the virtual clock at its `base`. Runs
// go through the real SDK `query()` against the fake CLI in the job's cwd;
// the CLI writes `argv.json`, `stdin.log` and `events.jsonl` there (relative
// `FAKE_CLAUDE_*` paths) and runs the turn of `script` its prompt matches. A
// `[gate]` prompt holds its turn until a `release` file appears in the cwd,
// so a run can stay in flight while the clock moves. Steps: store calls,
// scheduler calls, clock advances (each due timer fires at its own instant,
// then the scheduler settles), gate releases and live-run subscriptions.
// Each step records its result (or what it threw) and, when anything
// changed, a snapshot: every file under `~/.claude`, the timers (key, due,
// fired), the in-flight jobs, the live runs, the bus calls (sorted), what
// each subscriber got, and each cwd's CLI logs (files and logs as `{set,
// del}` against the scenario's previous snapshot). The temp root is `$TMP`,
// the fake CLI's path `$FAKE`, and `{"$undefined": true}` is JS `undefined`
// in a step's input.
//
// Written to rust/crates/claudius-core/tests/fixtures/scheduler_golden.json
// and replayed by crates/claudius-core/tests/scheduler_golden.rs on tokio's
// paused clock.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/scheduler_golden.json");
const TZ = "America/New_York";

// ------------------------------- recording -------------------------------

if (!process.env.SCHED_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sched-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TZ,
            SCHED_GOLDEN_CHILD: root,
            SCHED_GOLDEN_FAKE: fake,
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
    const dir = mkdtempSync(join(tmpdir(), "sched-golden-diff-"));
    writeFileSync(join(dir, "a.json"), runs[0]);
    writeFileSync(join(dir, "b.json"), runs[1]);
    throw new Error(`the two recordings differ (see ${dir})`);
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.scenarios.reduce((n, s) => n + s.steps.length, 0);
  const snaps = fixture.scenarios.reduce((n, s) => n + s.steps.filter((st) => st.snap).length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.scenarios.length} scenarios, ${steps} steps, ${snaps} snapshots (SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.SCHED_GOLDEN_CHILD;
const HOME = process.env.HOME;
const FAKE = process.env.SCHED_GOLDEN_FAKE;
const SCRIPT = process.env.FAKE_CLAUDE_SCRIPT;
const CLAUDE = join(HOME, ".claude");
const SCHED = join(CLAUDE, "claudius", "schedule");
const CWDS = join(ROOT, "cwd");
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
  `export const notificationBus = {
  recordSchedulerEvent(cwd, runId, jobId, event) {
    globalThis.__sched.bus.push({ cwd, runId, jobId, event });
    return Promise.resolve();
  },
};
`,
);

const NOW = "globalThis.__sched.now()";
const REWRITES = {
  "/lib/server/scheduler.ts": [
    ["Date.now()", NOW, 6],
    ["process.uptime()", "globalThis.__sched.uptime()", 1],
    ["process.pid", "globalThis.__sched.PID", 2],
    ["setTimeout(", "globalThis.__sched.setTimeout(", 2],
    ["clearTimeout(", "globalThis.__sched.clearTimeout(", 1],
    ["randomUUID()", "globalThis.__sched.uuid(job.id)", 1],
    ["void getJob(job.id)", "void globalThis.__sched.track(getJob(job.id))", 1],
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
  const fromScheduler = !!ctx.parentURL && ctx.parentURL.endsWith("/lib/server/scheduler.ts");
  if (fromScheduler && spec === ${JSON.stringify(SDK)}) return { url: SDK_SHIM, shortCircuit: true };
  if (fromScheduler && spec === "./notification-bus") return { url: BUS_SHIM, shortCircuit: true };
  const s = spec.startsWith("@/") ? new URL(spec.slice(2), ROOT).href : spec;
  if ((s.startsWith(".") || s.startsWith("file:")) && ctx.parentURL) {
    const p = fileURLToPath(new URL(s, ctx.parentURL));
    if (!existsSync(p)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(p + ext)) return next(pathToFileURL(p + ext).href, ctx);
      }
    }
  }
  return next(s, ctx);
}
export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  const key = Object.keys(REWRITES).find((k) => url.endsWith(k));
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

// ---- the virtual clock, timers and settle tracking ----------------------------

// scheduler.ts's `process.pid` under the stub: a value no real process has,
// so the replay can map it to its own pid without matching a timestamp.
const PID = 777001;

const S = (globalThis.__sched = {
  t: 0,
  procStart: 0,
  PID,
  seq: 0,
  timers: new Set(),
  ops: 0,
  fires: 0,
  bus: [],
  ids: new Map(),
  now: () => S.t,
  // `Date.now() - Math.round(uptime * 1000)` is then `procStart`.
  uptime: () => (S.t - S.procStart) / 1000,
  setTimeout(cb, delay) {
    let d = Number(delay);
    if (!(d >= 1 && d <= 2147483647)) d = 1;
    const h = { due: S.t + d, seq: S.seq++, cb, fired: false, cleared: false };
    S.timers.add(h);
    return h;
  },
  clearTimeout(h) {
    if (h) {
      h.cleared = true;
      S.timers.delete(h);
    }
  },
  uuid(id) {
    const k = String(id);
    const n = (S.ids.get(k) ?? 0) + 1;
    S.ids.set(k, n);
    return `${k}#${n}`;
  },
  track(p) {
    S.ops++;
    const done = () => {
      S.ops--;
    };
    p.then(done, done);
    return p;
  },
});

const store = await import(pathToFileURL(realpathSync(join(repo, "lib/server/scheduler-store.ts"))).href);
const { scheduler } = await import(pathToFileURL(realpathSync(join(repo, "lib/server/scheduler.ts"))).href);
const Scheduler = scheduler.constructor;
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8"),
).version;

function instrument(s) {
  const proto = Object.getPrototypeOf(s);
  s.arm = function (job) {
    return S.track(proto.arm.call(this, job));
  };
  s.fire = function (job, reArm) {
    S.fires++;
    const p = proto.fire.call(this, job, reArm);
    const done = () => {
      S.fires--;
    };
    p.then(done, done);
    return p;
  };
  return s;
}

// ---- helpers ------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const keyText = (k) => (k === undefined ? "undefined" : JSON.stringify(k));
const BS = "\\";
const esc = (hex) => `${BS}u${hex}`;

function norm(v) {
  if (typeof v === "string") return v.split(FAKE).join("$FAKE").split(ROOT).join("$TMP");
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  return v;
}
function denorm(v) {
  if (typeof v === "string") return v.split("$TMP").join(ROOT);
  if (Array.isArray(v)) return v.map(denorm);
  if (v && typeof v === "object") {
    if (v.$undefined === true) return undefined;
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = denorm(x);
    return o;
  }
  return v;
}
const errRec = (e) => ({
  name: e?.name ?? typeof e,
  message: norm(String(e?.message ?? e)),
  ...(e?.code ? { code: e.code } : {}),
});

function walk(dir, rel = "") {
  if (!existsSync(dir)) return [];
  const list = [];
  for (const name of readdirSync(dir).sort(cmp)) {
    const p = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(p).isDirectory()) {
      list.push([`${r}/`, null]);
      list.push(...walk(p, r));
    } else {
      const buf = readFileSync(p);
      const text = buf.toString("utf8");
      list.push([r, Buffer.from(text, "utf8").equals(buf) ? text : { hex: buf.toString("hex") }]);
    }
  }
  return list;
}

function cliLogs() {
  const list = [];
  for (const name of readdirSync(CWDS).sort(cmp)) {
    const dir = join(CWDS, name);
    const entry = { cwd: name };
    const argv = join(dir, "argv.json");
    if (existsSync(argv)) entry.argv = JSON.parse(readFileSync(argv, "utf8"));
    const log = join(dir, "stdin.log");
    if (existsSync(log)) {
      const ids = new Map();
      entry.stdin = readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const m = JSON.parse(l);
          if (typeof m.request_id !== "string") return m;
          if (!ids.has(m.request_id)) ids.set(m.request_id, `$ID${ids.size}`);
          return { ...m, request_id: ids.get(m.request_id) };
        });
    }
    list.push(entry);
  }
  return list;
}

function marks(cwd) {
  const f = join(CWDS, cwd, "events.jsonl");
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l === '{"mark":"gate"}').length;
}

// ---- the fake CLI's script ------------------------------------------------------

const asst = (text, n) => ({
  type: "assistant",
  message: {
    id: `msg_${n}`,
    role: "assistant",
    model: "fake",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  parent_tool_use_id: null,
  session_id: "fake-session",
  uuid: `asst-${n}`,
});
const res = (over = {}) => ({ session_id: "fake-session", uuid: "result-uuid", ...over });
const resultMsg = (over) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
  session_id: "fake-session",
  ...over,
});
const SCRIPT_BODY = {
  init: { session_id: "fake-session", uuid: "init-uuid" },
  turns: [
    {
      match: "[gate]",
      steps: [{ $mark: "gate" }, { $wait_file: "release" }, asst("released: $PROMPT", "g")],
      result: res({ total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 } }),
    },
    {
      match: "[error-subtype]",
      steps: [asst("trying", "e")],
      result: res({
        subtype: "error_max_turns",
        is_error: true,
        errors: ["max turns reached"],
        total_cost_usd: 0.5,
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    },
    {
      match: "[two-results]",
      steps: [
        asst("one", "t1"),
        resultMsg({ result: "one", total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 2 }, uuid: "result-1" }),
        asst("two", "t2"),
      ],
      result: res({
        subtype: "error_during_execution",
        is_error: true,
        errors: ["  boom  ", ""],
        total_cost_usd: 0.2,
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    },
    {
      match: "[zero-cost]",
      steps: [asst("free", "z")],
      result: res({ total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }),
    },
    { match: "[null-cost]", steps: [asst("nulls", "n")], result: res({ total_cost_usd: null, usage: null }) },
    { match: "[subtype-number]", steps: [asst("odd", "s")], result: res({ subtype: 7 }) },
    { match: "[exit]", steps: [asst("crashing", "x"), { $stderr: "boom" }, { $exit: 3 }], result: false },
    {
      match: "[error-result-exit]",
      steps: [
        asst("failing", "f"),
        resultMsg({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["bad thing", "  second  "],
          uuid: "result-f",
        }),
        { $exit: 1 },
      ],
      result: false,
    },
    {
      match: "[error-success-exit]",
      steps: [
        asst("half", "h"),
        resultMsg({ is_error: true, result: "the result text", uuid: "result-h" }),
        { $stderr: "late" },
        { $exit: 2 },
      ],
      result: false,
    },
    { match: "[no-result]", steps: [asst("partial", "nr"), { $exit: 0 }], result: false },
    {
      match: "[result-then-exit]",
      steps: [
        asst("done", "rx"),
        resultMsg({ total_cost_usd: 0.05, usage: { input_tokens: 2, output_tokens: 3 }, uuid: "result-rx" }),
        { $exit: 0 },
      ],
      result: false,
    },
    { match: "[alt]", steps: [asst("alternate: $PROMPT", "alt")], result: res() },
    {
      match: "[plain]",
      steps: [asst("plain: $PROMPT", "p")],
      result: res({ total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20 } }),
    },
    { match: "", steps: [asst("other: $PROMPT", "o")], result: res() },
  ],
};

// ---- scenarios ---------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-27T13:02:00Z");
const U = { $undefined: true };
const cwdOf = (name) => `$TMP/cwd/${name}`;
const job = (id, cron, prompt, extra = {}) => ({
  id,
  name: `job ${id}`,
  cron,
  prompt,
  cwd: cwdOf(id),
  enabled: true,
  createdAt: T0 - HOUR,
  updatedAt: T0 - HOUR,
  ...extra,
});
// `U` (an omitted key) is dropped, as `JSON.stringify` drops an `undefined` property.
const jobsText = (jobs) => `${JSON.stringify({ jobs }, (_k, v) => (v?.$undefined === true ? undefined : v), 2)}\n`;
const seed = (jobs) => ({ op: "writeFile", path: "jobs.json", text: jobsText(jobs) });
const run = (id, jobId, extra = {}) => ({ id, jobId, startedAt: T0, status: "running", ...extra });
const at = (iso) => Date.parse(iso);

const nonAscii = String.fromCodePoint(0xe9, 0x1f600, 0x2028);
/** A job left mid-run by an earlier process: its latest run is the one seeded. */
const RECOVER = (lastStatus = "running") => ({
  cwd: cwdOf("rec"),
  lastRunAt: T0 - 20 * MIN,
  lastStatus,
  enabled: false,
});
const stamped = (id, jobId, pid, startedAt = T0 - 20 * MIN) => ({
  id,
  jobId,
  startedAt,
  status: "running",
  pid,
  transcript: [],
});
const unstamped = (id, jobId, startedAt) => ({ id, jobId, startedAt, status: "running" });
/** A runs.jsonl with these lines; `1e400` as a pid is written as the literal. */
const runLines = (jobId, runs) => ({
  op: "writeFile",
  path: `jobs/${jobId}/runs.jsonl`,
  text: `${runs.map((r) => JSON.stringify(r).split('"1e400"').join("1e400")).join("\n")}\n`,
});
const SCENARIOS = [
  {
    name: "store basics",
    base: T0,
    cwds: [],
    steps: [
      { op: "listJobs" },
      { op: "getJob", id: "a" },
      { op: "listRuns", id: "a" },
      { op: "saveJob", job: job("a", "*/5 * * * *", "[plain] a") },
      { op: "saveJob", job: job("b", "0 9 * * 1-5", "[plain] b", { model: "claude-x" }) },
      { op: "listJobs" },
      { op: "getJob", id: "b" },
      { op: "saveJob", job: { ...job("a", "*/5 * * * *", "[plain] a"), name: "A two" } },
      { op: "patchJob", id: "a", patch: { name: "renamed", lastStatus: "success" } },
      { op: "patchJob", id: "a", patch: { model: "m1", extra: { nested: [1, 2.5, "x"] } } },
      { op: "patchJob", id: "a", patch: { id: "zzz", model: U, enabled: false } },
      { op: "patchJob", id: "nope", patch: { name: "x" } },
      { op: "deleteJob", id: "nope" },
      { op: "deleteJob", id: "b" },
      { op: "appendRun", run: run("r1", "a", { note: `n ${nonAscii}`, costUsd: 1.5 }) },
      { op: "appendRun", run: run("r2", "a") },
      { op: "appendRun", run: run("r3", "a", { transcript: [] }) },
      { op: "listRuns", id: "a" },
      { op: "listRuns", id: "a", limit: 2 },
      { op: "listRuns", id: "a", limit: 0 },
      { op: "listRuns", id: "a", limit: -1 },
      { op: "listRuns", id: "a", limit: 2.5 },
      { op: "listRuns", id: "a", limit: "Infinity" },
      { op: "listRuns", id: "a", limit: "-Infinity" },
      { op: "listRuns", id: "a", limit: "NaN" },
      { op: "updateRun", run: run("r2", "a", { status: "success", endedAt: T0 + 5 }) },
      { op: "updateRun", run: run("r9", "a", { status: "success" }) },
      { op: "updateRun", run: run("r1", "zz") },
      { op: "listRuns", id: "a" },
      { op: "deleteJob", id: "a" },
      { op: "listRuns", id: "a" },
      { op: "listJobs" },
    ],
  },
  {
    name: "store foreign data",
    base: T0,
    cwds: [],
    steps: [
      {
        op: "writeFile",
        path: "jobs.json",
        text: `{"jobs":[{"10":1,"id":"x","n":1.0,"e":1e2,"big":12345678901234567890,"neg":-0.0,"small":1e-7,"u":"${esc("00e9")}${esc("d83d")}${esc("de00")}${esc("2028")}","raw":"${nonAscii}","dup":1,"dup":2,"inf":1e400,"esc":"a${BS}"b${BS}${BS}c${BS}/d${esc("0001")}","2":true,"__proto__":{"p":1}}],"extra":true}`,
      },
      { op: "listJobs" },
      { op: "patchJob", id: "x", patch: { k: 1 } },
      { op: "writeFile", path: "jobs.json", text: "null" },
      { op: "listJobs" },
      { op: "saveJob", job: job("n", "* * * * *", "p") },
      { op: "writeFile", path: "jobs.json", text: "[]" },
      { op: "listJobs" },
      { op: "writeFile", path: "jobs.json", text: '{"jobs":5}' },
      { op: "listJobs" },
      { op: "writeFile", path: "jobs.json", text: '"str"' },
      { op: "listJobs" },
      { op: "writeFile", path: "jobs.json", text: "true" },
      { op: "listJobs" },
      { op: "writeFile", path: "jobs.json", text: '{"jobs":{"0":{"id":"q"}}}' },
      { op: "getJob", id: "q" },
      { op: "writeFile", path: "jobs.json", text: '{"jobs": [' },
      { op: "listJobs" },
      { op: "patchJob", id: "x", patch: { k: 2 } },
      { op: "writeFile", path: "jobs.json", hex: `efbbbf${Buffer.from('{"jobs":[]}').toString("hex")}` },
      { op: "listJobs" },
      { op: "writeFile", path: "jobs.json", text: "" },
      { op: "listJobs" },
      { op: "writeFile", path: "jobs.json", text: '{"jobs":[null,{"id":"y"}]}' },
      { op: "listJobs" },
      { op: "getJob", id: "y" },
      { op: "writeFile", path: "jobs.json", text: '{"jobs":[{"id":"y"},null]}' },
      { op: "getJob", id: "y" },
      { op: "getJob", id: "z" },
      { op: "patchJob", id: "y", patch: { k: 3 } },
      { op: "deleteJob", id: "y" },
      { op: "saveJob", job: job("s", "* * * * *", "p") },
      { op: "writeFile", path: "jobs.json", text: '{"jobs":[5,"s",true,[],{"id":"y","enabled":true}]}' },
      { op: "getJob", id: "y" },
      { op: "patchJob", id: "y", patch: { k: 4 } },
      { op: "deleteJob", id: "y" },
      { op: "writeFile", path: "jobs.json", text: '{"jobs":[{"id":"d","n":1},{"id":"d","n":2},{"id":5}]}' },
      { op: "getJob", id: "d" },
      { op: "patchJob", id: "d", patch: { n: 3 } },
      { op: "getJob", id: "5" },
      { op: "deleteJob", id: "d" },
      {
        op: "writeFile",
        path: "jobs.json",
        hex: `${Buffer.from('{"jobs":[{"id":"w","name":"a').toString("hex")}ff62c3${Buffer.from('"}]}').toString("hex")}`,
      },
      { op: "listJobs" },
      { op: "patchJob", id: "w", patch: { k: 5 } },
      { op: "writeFile", path: "jobs.json", text: `{"jobs":[{"id":"s","name":"${esc("d800")}x"}]}` },
      { op: "listJobs", diff: "lone surrogate" },
      { op: "patchJob", id: "s", patch: { k: 6 }, diff: "lone surrogate" },
      { op: "rm", path: "jobs.json" },
      { op: "mkdir", path: "jobs.json" },
      { op: "listJobs" },
      { op: "saveJob", job: job("t", "* * * * *", "p") },
      { op: "deleteJob", id: "t" },
      { op: "rm", path: "jobs.json" },
      {
        op: "writeFile",
        path: "jobs/r/runs.jsonl",
        text: '\n\n{"id":"r1","v":1}\r\n   \nnot json\nnull\n5\n"str"\n{"id":"r1","v":2}\n{"id":"r2","n":1.0}',
      },
      { op: "listRuns", id: "r" },
      { op: "updateRun", run: run("r1", "r", { status: "x" }) },
      { op: "listRuns", id: "r", limit: 3 },
      { op: "writeFile", path: "jobs/e/runs.jsonl", text: "" },
      { op: "listRuns", id: "e" },
      { op: "updateRun", run: run("r1", "e") },
      { op: "mkdir", path: "jobs/dd/runs.jsonl" },
      { op: "listRuns", id: "dd" },
      { op: "updateRun", run: run("r1", "dd") },
      { op: "appendRun", run: run("r1", "dd") },
      { op: "appendRun", run: run("p1", "a/b") },
      { op: "appendRun", run: run("p2", "") },
      { op: "appendRun", run: run("p3", ".") },
      { op: "appendRun", run: run("p4", "..") },
      { op: "appendRun", run: run("p5", "/abs") },
      { op: "appendRun", run: run("p6", "x/../../y") },
      { op: "listRuns", id: "a/b" },
      { op: "listRuns", id: "" },
      { op: "listRuns", id: ".." },
      { op: "listRuns", id: "/abs" },
      { op: "appendRun", run: run("p7", "../../escape"), diff: "escape" },
      { op: "listRuns", id: "../../escape", diff: "escape" },
      { op: "updateRun", run: run("p7", "../../escape", { status: "x" }), diff: "escape" },
      { op: "appendMany", jobId: "rot", count: 201 },
      { op: "appendRun", run: run("last", "rot") },
      { op: "listRuns", id: "rot", limit: 3 },
      {
        op: "writeFile",
        path: "jobs/rb/runs.jsonl",
        text: `${Array.from({ length: 199 }, (_, i) => `{"id":"b${i}"}`).join("\n")}\n\n\n`,
      },
      { op: "appendRun", run: run("b199", "rb") },
      { op: "appendRun", run: run("b200", "rb") },
      { op: "writeFile", path: "jobs.json", text: jobsText([job("rb", "* * * * *", "p")]) },
      { op: "writeFile", path: "jobs/rb/other.txt", text: "keep" },
      { op: "deleteJob", id: "rb" },
    ],
  },
  {
    name: "boot arms the enabled jobs",
    base: T0,
    cwds: ["a", "b", "c", "f", "g"],
    steps: [
      seed([
        job("a", "*/30 * * * *", "[plain] A"),
        job("b", "*/30 * * * *", "[plain] B", { enabled: false }),
        { 10: "ten", extra: { x: 1.5 }, ...job("c", "0 * * * *", "[plain] C", { enabled: 1 }) },
        job("d", "nope", "[plain] D"),
        job("f", "*/30 * * * *", "[plain] F", { lastRunAt: T0 - 2 * MIN, lastStatus: "success" }),
        job("g", "@hourly", "[plain] G", { model: "claude-golden-1" }),
        "junk",
        7,
      ]),
      { op: "boot" },
      { op: "boot" },
      { op: "advanceTo", at: at("2026-10-27T13:30:00Z") },
      { op: "advanceTo", at: at("2026-10-27T14:00:00Z") },
      { op: "listRuns", id: "a" },
      { op: "getJob", id: "c" },
    ],
  },
  {
    name: "boot errors",
    base: T0,
    cwds: ["a", "b"],
    steps: [
      { op: "writeFile", path: "jobs.json", text: "{oops" },
      { op: "boot" },
      seed([job("a", "*/5 * * * *", "[plain] A")]),
      { op: "boot" },
      { op: "newScheduler" },
      seed([job("a", "*/5 * * * *", "[plain] A"), null, job("b", "*/5 * * * *", "[plain] B")]),
      { op: "boot" },
    ],
  },
  {
    name: "what a run records",
    base: T0,
    cwds: ["plain", "errsub", "two", "zero", "nullcost", "subnum", "exit", "errexit", "errok", "model", "model-empty", "model-num", "off"],
    steps: [
      seed([
        job("plain", "*/5 * * * *", "[plain] hello"),
        job("errsub", "*/5 * * * *", "[error-subtype]"),
        job("two", "*/5 * * * *", "[two-results]"),
        job("zero", "*/5 * * * *", "[zero-cost]"),
        job("nullcost", "*/5 * * * *", "[null-cost]"),
        job("subnum", "*/5 * * * *", "[subtype-number]"),
        job("exit", "*/5 * * * *", "[exit]"),
        job("errexit", "*/5 * * * *", "[error-result-exit]"),
        job("errok", "*/5 * * * *", "[error-success-exit]"),
        job("model", "*/5 * * * *", "[plain] with a model", { model: "claude-golden-1" }),
        job("model-empty", "*/5 * * * *", "[plain] empty model", { model: "" }),
        job("model-num", "*/5 * * * *", "[plain] numeric model", { model: 5 }),
        job("nocwd", "*/5 * * * *", "[plain] nowhere", { cwd: "$TMP/cwd/missing" }),
        job("off", "*/5 * * * *", "[plain] disabled", { enabled: false }),
      ]),
      { op: "runNow", id: "plain" },
      { op: "runNow", id: "errsub" },
      { op: "runNow", id: "two" },
      { op: "runNow", id: "zero" },
      { op: "runNow", id: "nullcost" },
      { op: "runNow", id: "subnum" },
      { op: "runNow", id: "exit" },
      { op: "runNow", id: "errexit" },
      { op: "runNow", id: "errok" },
      { op: "runNow", id: "model" },
      { op: "runNow", id: "model-empty" },
      { op: "runNow", id: "model-num" },
      { op: "runNow", id: "nocwd" },
      { op: "runNow", id: "off" },
      { op: "runNow", id: "missing" },
      { op: "runNow", id: "plain" },
      { op: "listRuns", id: "plain" },
    ],
  },
  {
    name: "overlap and the live bus",
    base: T0,
    cwds: ["p"],
    steps: [
      seed([job("p", "*/5 * * * *", "[gate] P")]),
      { op: "boot" },
      { op: "advanceTo", at: at("2026-10-27T13:05:00Z"), park: ["p"] },
      { op: "subscribe", run: "p#1", as: "s1" },
      { op: "isRunLive", run: "p#1" },
      { op: "isRunAttached", run: "p#1" },
      { op: "runNow", id: "p" },
      { op: "armStored", id: "p" },
      { op: "advanceTo", at: at("2026-10-27T13:10:00Z") },
      { op: "unsubscribe", as: "s1" },
      { op: "isRunAttached", run: "p#1" },
      { op: "subscribe", run: "p#1", as: "s2" },
      { op: "release", cwd: "p" },
      { op: "isRunLive", run: "p#1" },
      { op: "isRunAttached", run: "p#1" },
      { op: "subscribe", run: "p#1", as: "s3" },
      { op: "advanceTo", at: at("2026-10-27T13:10:04Z") },
      { op: "isRunLive", run: "p#1" },
      { op: "advanceTo", at: at("2026-10-27T13:10:06Z") },
      { op: "subscribe", run: "p#1", as: "s4" },
      { op: "subscribe", run: "nope", as: "s5" },
      { op: "isRunLive", run: "p#1" },
      { op: "advanceTo", at: at("2026-10-27T13:15:00Z"), park: ["p"] },
      { op: "release", cwd: "p" },
      { op: "listRuns", id: "p" },
    ],
  },
  {
    name: "edits while a run is in flight",
    base: T0,
    cwds: ["q", "r", "s", "t"],
    steps: [
      seed([
        job("q", "*/5 * * * *", "[gate] Q"),
        job("r", "*/5 * * * *", "[gate] R"),
        job("s", "*/5 * * * *", "[gate] S"),
        job("t", "*/5 * * * *", "[gate] T"),
      ]),
      { op: "boot" },
      { op: "advanceTo", at: at("2026-10-27T13:05:00Z"), park: ["q", "r", "s", "t"] },
      { op: "deleteJob", id: "q" },
      { op: "schedDeleteJob", id: "q" },
      { op: "patchJob", id: "r", patch: { enabled: false, updatedAt: T0 + 4 * MIN } },
      { op: "disarm", id: "r" },
      { op: "patchJob", id: "s", patch: { cron: "*/10 * * * *" } },
      { op: "armStored", id: "s" },
      { op: "patchJob", id: "t", patch: { enabled: false } },
      { op: "release", cwd: "t" },
      { op: "release", cwd: "q" },
      { op: "release", cwd: "r" },
      { op: "advanceTo", at: at("2026-10-27T13:10:00Z") },
      { op: "release", cwd: "s" },
      { op: "patchJob", id: "r", patch: { enabled: true } },
      { op: "armStored", id: "r" },
    ],
  },
  {
    name: "missed runs are not caught up",
    base: T0,
    cwds: ["l", "m", "n", "o"],
    steps: [
      seed([
        job("l", "*/5 * * * *", "[gate] L"),
        job("m", "*/5 * * * *", "[plain] M", { lastRunAt: T0 - 30 * HOUR, nextRunAt: T0 - 29 * HOUR }),
        job("n", "*/5 * * * *", "[plain] N", { lastRunAt: T0 + HOUR }),
        job("o", "0 9 * * *", "[plain] O", { lastRunAt: T0 - 2 * MIN }),
      ]),
      { op: "boot" },
      { op: "advanceTo", at: at("2026-10-27T13:05:00Z"), park: ["l"] },
      { op: "advanceTo", at: at("2026-10-27T13:17:00Z") },
      { op: "release", cwd: "l" },
      { op: "advanceTo", at: at("2026-10-27T13:19:00Z") },
    ],
  },
  {
    name: "the 24h timer cap",
    base: T0,
    cwds: ["y"],
    steps: [
      seed([job("y", "0 0 1 1 *", "[plain] Y")]),
      { op: "boot" },
      { op: "advanceTo", at: T0 + 50 * HOUR },
      { op: "advanceTo", at: at("2027-01-01T05:00:00Z") },
      { op: "advanceTo", at: at("2027-01-01T05:00:01Z") },
    ],
  },
  {
    name: "daylight saving ends",
    base: at("2026-11-01T04:10:00Z"),
    cwds: ["u", "v"],
    steps: [
      seed([job("u", "30 1 * * *", "[plain] U"), job("v", "0 * * * *", "[plain] V")]),
      { op: "boot" },
      { op: "advanceTo", at: at("2026-11-01T07:30:00Z") },
    ],
  },
  {
    // Booted at 1:00 EST, after the 1:30 EDT run: stepping from `lastRunAt`
    // skips the repeated 1:30; a `lastRunAt` that isn't a number doesn't.
    name: "booted in the repeated hour",
    base: at("2026-11-01T06:00:00Z"),
    cwds: ["u2", "u3"],
    steps: [
      seed([
        job("u2", "30 1 * * *", "[plain] U2", { lastRunAt: at("2026-11-01T05:30:00Z") }),
        job("u3", "30 1 * * *", "[plain] U3", { lastRunAt: "2026-11-01T05:30:00Z" }),
      ]),
      { op: "boot" },
      { op: "advanceTo", at: at("2026-11-01T06:31:00Z") },
    ],
  },
  {
    name: "cron shapes",
    base: T0,
    cwds: ["w1", "w2", "w3", "w4", "w5"],
    steps: [
      seed([
        job("w1", U, "[plain] W1"),
        job("w2", null, "[plain] W2"),
        job("w3", 5, "[plain] W3"),
        job("w4", "", "[plain] W4"),
        job("w5", "  ", "[plain] W5"),
      ]),
      { op: "boot" },
      { op: "advanceTo", at: at("2026-10-27T13:04:00Z") },
    ],
  },
  {
    name: "foreign job ids",
    base: T0,
    cwds: ["five", "noid", "nullid", "ok"],
    steps: [
      {
        op: "writeFile",
        path: "jobs.json",
        text: jobsText([
          job(5, "*/5 * * * *", "[plain] five", { cwd: cwdOf("five") }),
          job(U, "*/5 * * * *", "[plain] noid", { cwd: cwdOf("noid") }),
          job(null, "*/5 * * * *", "[plain] nullid", { cwd: cwdOf("nullid") }),
          job("ok", "*/5 * * * *", "[plain] ok"),
        ]),
      },
      { op: "boot" },
      { op: "advanceTo", at: at("2026-10-27T13:05:00Z") },
      { op: "advanceTo", at: at("2026-10-27T13:10:00Z") },
      { op: "runNow", id: "5" },
      { op: "writeFile", path: "jobs.json", text: '{"jobs":[0,{"id":"z0"}]}' },
      { op: "runNow", id: U },
    ],
  },
  {
    name: "stale timers and arm edges",
    base: T0,
    cwds: ["x", "y2", "z"],
    steps: [
      seed([
        job("x", "*/5 * * * *", "[plain] X"),
        job("y2", "*/5 * * * *", "[plain] Y"),
        job("z", "*/5 * * * *", "[plain] Z"),
      ]),
      { op: "boot" },
      { op: "patchJob", id: "x", patch: { enabled: false } },
      { op: "deleteJob", id: "y2" },
      { op: "patchJob", id: "z", patch: { prompt: "[alt] Z" } },
      { op: "advanceTo", at: at("2026-10-27T13:05:00Z") },
      { op: "arm", job: job("ghost", "*/5 * * * *", "[plain] ghost") },
      { op: "arm", job: job("x", "*/5 * * * *", "[plain] X", { enabled: false }) },
      { op: "armStored", id: "z" },
      { op: "armStored", id: "z" },
      { op: "disarm", id: "unknown" },
      { op: "armStored", id: "y2" },
      { op: "arm", job: job("x", "*/5 * * * *", "[plain] X") },
      { op: "arm", job: 5 },
      { op: "schedDeleteJob", id: "z" },
      { op: "advanceTo", at: at("2026-10-27T13:20:00Z") },
    ],
  },
  {
    // CC 2.1.302: a fire whose folder is gone doesn't start, says so on the
    // job, and tells the inbox once per new reason.
    name: "a missing folder",
    base: T0,
    cwds: ["there"],
    steps: [
      seed([
        job("gone", "*/5 * * * *", "[plain] gone"),
        // A path that exists but isn't a directory, and one that is no path.
        job("file", "*/5 * * * *", "[plain] file", { cwd: "$TMP/script.json" }),
        job("numcwd", "*/5 * * * *", "[plain] num", { cwd: 5 }),
        job("nocwd", "*/5 * * * *", "[plain] none", { cwd: U }),
        job("blank", "*/5 * * * *", "[plain] blank", { cwd: "" }),
        job("there", "*/5 * * * *", "[plain] there"),
      ]),
      { op: "boot" },
      { op: "runNow", id: "gone" },
      { op: "getJob", id: "gone" },
      // The same reason again: the job is stamped, the inbox isn't told.
      { op: "runNow", id: "gone" },
      { op: "runNow", id: "file" },
      { op: "runNow", id: "numcwd" },
      { op: "runNow", id: "nocwd" },
      { op: "runNow", id: "blank" },
      // A different stored reason: told again.
      { op: "patchJob", id: "gone", patch: { lastSkipReason: "other" } },
      { op: "runNow", id: "gone" },
      { op: "patchJob", id: "gone", patch: { lastSkipReason: U } },
      { op: "runNow", id: "gone" },
      // The timers fire: each skip re-arms, and `there` runs.
      { op: "advanceTo", at: at("2026-10-27T13:05:00Z") },
      { op: "listRuns", id: "gone", limit: 3 },
      { op: "getJob", id: "there" },
      // A run that starts clears the reason.
      { op: "mkdirCwd", cwd: "gone" },
      { op: "runNow", id: "gone" },
      { op: "getJob", id: "gone" },
      { op: "rmCwd", cwd: "gone" },
      { op: "runNow", id: "gone" },
      { op: "getJob", id: "gone" },
      { op: "listRuns", id: "gone", limit: 4 },
    ],
  },
  {
    // CC 2.1.302: the runs an earlier Claudius left `running`.
    name: "boot recovery",
    base: T0,
    procStart: T0 - 10 * MIN,
    cwds: ["rec"],
    steps: [
      seed([
        job("dead", "*/5 * * * *", "[plain] dead", RECOVER()),
        job("alive", "*/5 * * * *", "[plain] alive", RECOVER()),
        job("own", "*/5 * * * *", "[plain] own", RECOVER()),
        job("old", "*/5 * * * *", "[plain] old", { lastRunAt: T0 - 10 * MIN - 1, lastStatus: "running", enabled: false }),
        job("new", "*/5 * * * *", "[plain] new", { lastRunAt: T0 - 10 * MIN + 1, lastStatus: "running", enabled: false }),
        job("edge", "*/5 * * * *", "[plain] edge", { lastRunAt: T0 - 10 * MIN, lastStatus: "running", enabled: false }),
        job("strstart", "*/5 * * * *", "[plain] str", { lastRunAt: "0", lastStatus: "running", enabled: false }),
        job("nullstart", "*/5 * * * *", "[plain] null", { lastRunAt: null, lastStatus: "running", enabled: false }),
        job("objstart", "*/5 * * * *", "[plain] obj", { lastStatus: "running", enabled: false }),
        job("mismatch", "*/5 * * * *", "[plain] mism", { lastRunAt: T0 - MIN, lastStatus: "running", enabled: false }),
        job("notrunning", "*/5 * * * *", "[plain] nr", RECOVER("success")),
        job("pids", "*/5 * * * *", "[plain] pids", { enabled: false }),
        job("many", "*/5 * * * *", "[plain] many", { lastRunAt: T0 - 20 * MIN, lastStatus: "running", enabled: false }),
        job(5, "*/5 * * * *", "[plain] five", { cwd: cwdOf("rec"), enabled: false }),
        job("dirruns", "*/5 * * * *", "[plain] dir", { enabled: false }),
        job("norunsfile", "*/5 * * * *", "[plain] norf", { lastStatus: "running", enabled: false }),
        job("odd", "*/5 * * * *", "[plain] odd", { enabled: false }),
      ]),
      runLines("dead", [stamped("d1", "dead", 999999)]),
      runLines("alive", [stamped("a1", "alive", 1)]),
      runLines("own", [stamped("o1", "own", PID)]),
      runLines("old", [unstamped("u1", "old", T0 - 10 * MIN - 1)]),
      runLines("new", [unstamped("u2", "new", T0 - 10 * MIN + 1)]),
      runLines("edge", [unstamped("u3", "edge", T0 - 10 * MIN)]),
      runLines("strstart", [unstamped("u4", "strstart", "0")]),
      runLines("nullstart", [unstamped("u5", "nullstart", null)]),
      runLines("objstart", [unstamped("u6", "objstart", {})]),
      runLines("mismatch", [stamped("m1", "mismatch", 999999)]),
      runLines("notrunning", [stamped("n1", "notrunning", 999999)]),
      runLines("pids", [
        stamped("p-inf", "pids", "1e400"),
        stamped("p-frac", "pids", 1.5),
        stamped("p-zero", "pids", 0),
        stamped("p-neg", "pids", -1),
        { ...unstamped("p-str", "pids", T0 - 20 * MIN), pid: "1" },
        { ...unstamped("p-null", "pids", T0 - 20 * MIN), pid: null },
      ]),
      // Only the newest 50 runs are looked at.
      {
        op: "writeFile",
        path: "jobs/many/runs.jsonl",
        text: `${JSON.stringify(stamped("far", "many", 999999, T0 - 20 * MIN))}\n${Array.from(
          { length: 55 },
          (_, i) => JSON.stringify({ id: `k${i}`, jobId: "many", startedAt: i, status: "success" }),
        ).join("\n")}\n`,
      },
      // Lines a recovery pass walks past, and one it would rewrite.
      {
        op: "writeFile",
        path: "jobs/odd/runs.jsonl",
        text: `5\n"str"\n[1]\nnot json\n\n{"status":"running"}\n${JSON.stringify({
          jobId: "odd",
          startedAt: T0 - 20 * MIN,
          status: "running",
          extra: 1,
        })}\n`,
      },
      { op: "mkdir", path: "jobs/dirruns/runs.jsonl" },
      { op: "boot" },
      { op: "boot" },
      { op: "listJobs" },
      { op: "listRuns", id: "dead" },
      { op: "listRuns", id: "alive" },
      { op: "listRuns", id: "own" },
      { op: "listRuns", id: "pids" },
      { op: "listRuns", id: "odd" },
      { op: "listRuns", id: "many", limit: 2 },
      { op: "advanceTo", at: at("2026-10-27T13:05:00Z") },
    ],
  },
  {
    // The run this process is still running is nobody's to recover.
    name: "boot during a run",
    base: T0,
    procStart: T0 - 10 * MIN,
    cwds: ["g"],
    steps: [
      seed([job("g", "*/5 * * * *", "[gate] G", { lastRunAt: T0 - 20 * MIN, lastStatus: "running" })]),
      // Its startedAt is the one the live run will have, so the job's
      // `lastRunAt` points at it once the live run has started.
      runLines("g", [stamped("old", "g", 999999, T0)]),
      { op: "startRun", id: "g", cwd: "g" },
      { op: "boot" },
      { op: "listRuns", id: "g" },
      { op: "getJob", id: "g" },
      { op: "release", cwd: "g" },
      { op: "listRuns", id: "g" },
      { op: "getJob", id: "g" },
    ],
  },
  {
    // A `null` run line in the window: `run.status` throws outside the try.
    name: "boot recovery throws",
    base: T0,
    cwds: ["rec2"],
    steps: [
      seed([job("n1", "*/5 * * * *", "[plain] n1", { cwd: cwdOf("rec2") })]),
      runLines("n1", [null]),
      { op: "boot" },
      // The kept rejection: every later boot throws the same way.
      { op: "boot" },
      { op: "listRuns", id: "n1" },
    ],
  },
  {
    // CC 2.1.302: a stream that ends with no result didn't finish.
    name: "a stream without a result",
    base: T0,
    cwds: ["nr", "rx"],
    steps: [
      seed([
        job("nr", "*/5 * * * *", "[no-result]"),
        job("rx", "*/5 * * * *", "[result-then-exit]"),
      ]),
      { op: "runNow", id: "nr" },
      { op: "runNow", id: "rx" },
      { op: "listRuns", id: "nr" },
      { op: "listRuns", id: "rx" },
    ],
  },
  {
    // CC 2.1.312: the job's effort level reaches the CLI.
    name: "a job with effort",
    base: T0,
    cwds: ["e1", "e2", "e3", "e4"],
    steps: [
      seed([
        job("e1", "*/5 * * * *", "[plain] e1", { effort: "high" }),
        job("e2", "*/5 * * * *", "[plain] e2", { effort: "" }),
        job("e3", "*/5 * * * *", "[plain] e3", { effort: 5 }),
        job("e4", "*/5 * * * *", "[plain] e4", { effort: "bogus", model: "claude-golden-1" }),
      ]),
      { op: "runNow", id: "e1" },
      { op: "runNow", id: "e2" },
      { op: "runNow", id: "e3" },
      { op: "runNow", id: "e4" },
      { op: "listRuns", id: "e1" },
    ],
  },
];

// ---- the driver ----------------------------------------------------------------------

const NONE = Symbol("none");
let sched;
let parked;
let gates;
let subs;
let unsubs;
/** cwd -> the `startRun` promise whose turn is parked there. */
let pending;

async function settle() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    await sleep(3);
    const live = [...sched.liveRuns.values()].filter((b) => !b.done);
    const quiet =
      S.ops === 0 &&
      S.fires === parked.size &&
      [...parked].every(([cwd, n]) => marks(cwd) >= n) &&
      live.length === parked.size &&
      live.every((b) => b.events.length >= 2);
    if (quiet) {
      await sleep(3);
      if (S.ops === 0 && S.fires === parked.size) return;
    }
    if (Date.now() > deadline) throw new Error(`settle timed out: ops ${S.ops}, fires ${S.fires}, parked ${parked.size}`);
  }
}

function park(cwd) {
  const n = (gates.get(cwd) ?? 0) + 1;
  gates.set(cwd, n);
  parked.set(cwd, n);
}

async function advanceTo(target) {
  for (;;) {
    const due = [...S.timers].sort((a, b) => a.due - b.due || a.seq - b.seq);
    if (!due.length || due[0].due > target) break;
    const t = due[0].due;
    S.t = t;
    for (const h of due.filter((x) => x.due === t)) {
      if (h.cleared || h.fired) continue;
      h.fired = true;
      S.timers.delete(h);
      h.cb();
    }
    await settle();
  }
  S.t = target;
}

async function call(fn) {
  try {
    const v = await fn();
    return { ok: v === undefined ? "$undefined" : norm(v) };
  } catch (e) {
    return { throws: errRec(e) };
  }
}

async function doStep(step) {
  switch (step.op) {
    case "writeFile": {
      const p = join(SCHED, step.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, step.hex !== undefined ? Buffer.from(step.hex, "hex") : denorm(step.text));
      return NONE;
    }
    case "mkdir":
      mkdirSync(join(SCHED, step.path), { recursive: true });
      return NONE;
    case "rm":
      rmSync(join(SCHED, step.path), { recursive: true, force: true });
      return NONE;
    case "listJobs":
      return call(() => store.listJobs());
    case "getJob":
      return call(() => store.getJob(denorm(step.id)));
    case "saveJob":
      return call(() => store.saveJob(denorm(step.job)));
    case "patchJob":
      return call(() => store.patchJob(denorm(step.id), denorm(step.patch)));
    case "deleteJob":
      return call(() => store.deleteJob(denorm(step.id)));
    case "appendRun":
      return call(() => store.appendRun(denorm(step.run)));
    case "appendMany":
      return call(async () => {
        for (let i = 0; i < step.count; i++) {
          await store.appendRun({ id: `m${i}`, jobId: step.jobId, startedAt: i, status: "success" });
        }
      });
    case "updateRun":
      return call(() => store.updateRun(denorm(step.run)));
    case "listRuns":
      return call(() => (step.limit === undefined ? store.listRuns(step.id) : store.listRuns(step.id, Number(step.limit))));
    case "boot":
      return call(() => sched.boot());
    case "arm":
      return call(() => sched.arm(denorm(step.job)));
    case "armStored":
      return call(async () => sched.arm(await store.getJob(step.id)));
    case "disarm":
      return call(() => sched.disarm(step.id));
    case "schedDeleteJob":
      return call(() => sched.deleteJob(step.id));
    case "runNow":
      return call(() => sched.runNow(denorm(step.id)));
    case "startRun": {
      park(step.cwd);
      pending.set(step.cwd, call(() => sched.runNow(denorm(step.id))));
      return NONE;
    }
    case "mkdirCwd":
      mkdirSync(join(CWDS, step.cwd), { recursive: true });
      return NONE;
    case "rmCwd":
      rmSync(join(CWDS, step.cwd), { recursive: true, force: true });
      return NONE;
    case "advanceTo":
      for (const cwd of step.park ?? []) park(cwd);
      await advanceTo(step.at);
      return NONE;
    case "release": {
      const gate = join(CWDS, step.cwd, "release");
      writeFileSync(gate, "");
      parked.delete(step.cwd);
      await settle();
      unlinkSync(gate);
      if (!pending.has(step.cwd)) return NONE;
      const r = await pending.get(step.cwd);
      pending.delete(step.cwd);
      return r;
    }
    case "subscribe": {
      const list = (subs[step.as] = []);
      unsubs[step.as] = sched.subscribeRun(step.run, (ev) => list.push(ev));
      return NONE;
    }
    case "unsubscribe":
      unsubs[step.as]();
      return NONE;
    case "isRunLive":
      return { ok: sched.isRunLive(step.run) };
    case "isRunAttached":
      return { ok: sched.isRunAttached(step.run) };
    case "newScheduler":
      sched = instrument(new Scheduler());
      return NONE;
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

function snapshot() {
  return norm({
    files: walk(CLAUDE),
    timers: [...sched.timers].map(([k, h]) => [keyText(k), h.due, h.fired]).sort((a, b) => cmp(a[0], b[0])),
    inFlight: [...sched.inFlight].map(keyText).sort(cmp),
    live: [...sched.liveRuns]
      .map(([id, b]) => [id, b.events.length, b.done, b.subscribers.size])
      .sort((a, b) => cmp(a[0], b[0])),
    bus: S.bus,
    subs,
    cli: cliLogs(),
  });
}

/** `[key, value]` entries as `{set, del}` against `prev` (a key -> JSON text map, updated). */
function diff(entries, prev) {
  const set = [];
  const seen = new Set();
  for (const [k, v] of entries) {
    seen.add(k);
    const t = JSON.stringify(v);
    if (prev.get(k) !== t) set.push([k, v]);
    prev.set(k, t);
  }
  const del = [...prev.keys()].filter((k) => !seen.has(k)).sort(cmp);
  for (const k of del) prev.delete(k);
  return { set, del };
}

writeFileSync(SCRIPT, JSON.stringify(SCRIPT_BODY));
const scenarios = [];
for (const sc of SCENARIOS) {
  rmSync(CLAUDE, { recursive: true, force: true });
  rmSync(CWDS, { recursive: true, force: true });
  mkdirSync(CWDS, { recursive: true });
  for (const c of sc.cwds) mkdirSync(join(CWDS, c));
  S.t = sc.base;
  S.procStart = sc.procStart ?? sc.base - 5 * MIN;
  S.seq = 0;
  S.timers.clear();
  S.bus = [];
  S.ids = new Map();
  sched = instrument(new Scheduler());
  parked = new Map();
  gates = new Map();
  pending = new Map();
  subs = {};
  unsubs = {};
  let last = null;
  const prevFiles = new Map();
  const prevCli = new Map();
  const steps = [];
  for (const step of sc.steps) {
    const rec = { ...step };
    const r = await doStep(step);
    await settle();
    if (r !== NONE) rec.result = r;
    const snap = snapshot();
    snap.bus = snap.bus.map((b) => JSON.stringify(b)).sort(cmp).map((t) => JSON.parse(t));
    const text = JSON.stringify(snap);
    if (text !== last) {
      // Files and CLI logs as a diff against the previous snapshot.
      rec.snap = { ...snap, files: diff(snap.files, prevFiles), cli: diff(snap.cli.map((c) => [c.cwd, c]), prevCli) };
      last = text;
    }
    steps.push(rec);
  }
  if (S.fires !== 0 || S.ops !== 0 || parked.size !== 0 || pending.size !== 0)
    throw new Error(`${sc.name}: left work in flight`);
  scenarios.push({ name: sc.name, base: sc.base, procStart: S.procStart, cwds: sc.cwds, steps });
}

writeFileSync(
  join(ROOT, "out.json"),
  JSON.stringify({ sdkVersion, tz: TZ, pid: PID, script: SCRIPT_BODY, scenarios }),
);
process.exit(0);
