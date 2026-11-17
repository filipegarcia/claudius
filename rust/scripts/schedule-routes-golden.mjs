#!/usr/bin/env node
// Golden fixture for the schedule routes (G07b): `app/api/schedule/route.ts`
// (GET, POST), `[id]/route.ts` (GET, PATCH, DELETE), `[id]/run-now/route.ts`
// (POST) and `[id]/runs/route.ts` (GET), recorded from the real handlers on
// the real `scheduler.ts` and `scheduler-store.ts`:
//
//   node rust/scripts/schedule-routes-golden.mjs     (node@22; builds claudius-fake-claude)
//
// Re-runs itself twice under `--experimental-transform-types` (two temp
// roots, both through realpath; both recordings must agree byte for byte)
// with its cwd at `<root>/project` (so `process.cwd()` is the first trusted
// root), HOME at `<root>/home`, CLAUDE_CONFIG_DIR at `<root>/config` and
// TZ=America/New_York. `<root>/home/.claude/.claudius/workspaces.json`
// registers `ws1` (with `ws-extra` as an additional directory), `ws2`, `ws3`
// and `ws4`; `untrusted` exists but isn't registered, `missing` doesn't
// exist. A resolve hook maps the `@/` imports, scheduler.ts's SDK import to
// a shim that calls the real `query()` with `pathToClaudeCodeExecutable` set
// to the fake CLI, and its `./notification-bus` import to a no-op (the bus
// is G01).
//
// A load hook pins time and ids, as scheduler-golden.mjs does: in the route
// files, scheduler.ts, scheduler-store.ts and cron.ts every `Date.now()`
// reads a virtual clock, scheduler.ts's `setTimeout` / `clearTimeout` go to
// a virtual timer queue that never fires (no step moves the clock past a
// timer), and `randomUUID()` (the POST route's job id, scheduler.ts's run
// id) counts `00000000-0000-4000-8000-<n>`. scheduler.ts's `process.pid`
// reads PID (777001), so a run's recorded pid is the same in both
// recordings and the replay can map it to its server's; `process.uptime()`
// is stubbed so the interrupted-run recovery's `processStartedAt` is
// `<t0> - 60000`. Only runs stamped with a pid (999999, past any pid, and
// 1, alive and not ours) are seeded as `running`, plus unstamped ones from
// well before either process started, so the replay recovers the same ones. Each step runs at its own clock,
// `<t0> + 1000 * <step>` (boot is step 0), so every time a step writes is
// distinct and never a cron slot. Armed jobs use crons whose next slot is
// years away (`0 0 29 2 *`), so a timer is always the 24 h cap and a replay
// on the real clock never fires one.
//
// Each group starts from an empty world (the scheduler's timers, in-flight
// jobs, live runs and `booted` reset, and trusted-cwd's caches dropped),
// writes its `seed` files under the schedule root, then boots the scheduler
// as `instrumentation.ts` does (`boot`). Steps:
// - `req`: one request to the route its URL names (`[id]` is
//   `decodeURIComponent` of the segment, as Next decodes it), with `body`
//   text or `hex` bytes; `got` is the status, content type and body text,
//   or `threw` (what the handler threw: Next's empty 500).
// - `start` / `release`: a run-now whose turn holds at a gate in `cwd` until
//   `release` writes `<cwd>/release`; `release` records the request's `got`.
// - `write` / `rm` / `mkdir`: a file change under the schedule root.
// After each step (and boot), `snap`: the files under
// `~/.claude/claudius` and each world dir's CLI logs (`argv.json`,
// `stdin.log` with request ids as `$ID<n>`) as `{set, del}` against the
// group's previous snapshot, and the scheduler's timers `[key, due]` (key
// is the job id's JSON). `$ROOT` stands for the root and `$FAKE` for the
// fake CLI's path, in requests and in what's recorded.
//
// Written to rust/crates/claudius-core/tests/fixtures/schedule_routes_golden.json
// and replayed on the real binary by
// crates/claudius-server/tests/schedule_routes.rs.
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/schedule_routes_golden.json");
const TZ = "America/New_York";

// ------------------------------- recording -------------------------------

if (!process.env.SCHED_ROUTES_ROOT) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sched-routes-golden-")));
    try {
      // Placeholders are swapped textually in URLs, JSON text and files.
      if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error(`root needs escaping: ${root}`);
      mkdirSync(join(root, "project"));
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
            TZ,
            SCHED_ROUTES_ROOT: root,
            SCHED_ROUTES_FAKE: fake,
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
    const dir = mkdtempSync(join(tmpdir(), "sched-routes-golden-diff-"));
    writeFileSync(join(dir, "a.json"), runs[0]);
    writeFileSync(join(dir, "b.json"), runs[1]);
    throw new Error(`the two recordings differ (see ${dir})`);
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.groups.reduce((n, g) => n + g.steps.length, 0);
  const reqs = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.got).length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.groups.length} groups, ${steps} steps, ${reqs} requests (SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.SCHED_ROUTES_ROOT;
const FAKE = process.env.SCHED_ROUTES_FAKE;
const SCRIPT = process.env.FAKE_CLAUDE_SCRIPT;
const HOME = process.env.HOME;
const CLAUDIUS = join(HOME, ".claude", "claudius");
const SCHED = join(CLAUDIUS, "schedule");
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
  recordSchedulerEvent() {
    return Promise.resolve();
  },
};
`,
);

const NOW = "globalThis.__g.now()";
const UUID = "globalThis.__g.uuid()";
const REWRITES = {
  "/app/api/schedule/route.ts": [
    ["Date.now()", NOW, 1],
    ["randomUUID()", UUID, 1],
  ],
  "/app/api/schedule/[id]/route.ts": [["Date.now()", NOW, 1]],
  "/lib/server/scheduler.ts": [
    ["Date.now()", NOW, 6],
    ["process.uptime()", "globalThis.__g.uptime()", 1],
    ["process.pid", "globalThis.__g.PID", 2],
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

// ---- the virtual clock, timers, ids and settle tracking ------------------------

// scheduler.ts's `process.pid` under the stub: a value no real process has,
// so the replay can map it to its server's without matching a timestamp.
const PID = 777001;

const G = (globalThis.__g = {
  t: 0,
  procStart: 0,
  PID,
  seq: 0,
  n: 0,
  timers: new Set(),
  ops: 0,
  fires: 0,
  now: () => G.t,
  // `Date.now() - Math.round(uptime * 1000)` is then `procStart`.
  uptime: () => (G.t - G.procStart) / 1000,
  setTimeout(cb, delay) {
    let d = Number(delay);
    if (!(d >= 1 && d <= 2147483647)) d = 1;
    const h = { due: G.t + d, seq: G.seq++, cb, cleared: false };
    G.timers.add(h);
    return h;
  },
  clearTimeout(h) {
    if (h) {
      h.cleared = true;
      G.timers.delete(h);
    }
  },
  uuid() {
    G.n += 1;
    return `00000000-0000-4000-8000-${String(G.n).padStart(12, "0")}`;
  },
  track(p) {
    G.ops++;
    const done = () => {
      G.ops--;
    };
    p.then(done, done);
    return p;
  },
});

const imp = (rel) => import(pathToFileURL(realpathSync(join(repo, rel))).href);
const { scheduler } = await imp("lib/server/scheduler.ts");
const { __resetTrustedCwdCache } = await imp("lib/server/trusted-cwd.ts");
const routes = {
  list: await imp("app/api/schedule/route.ts"),
  job: await imp("app/api/schedule/[id]/route.ts"),
  runNow: await imp("app/api/schedule/[id]/run-now/route.ts"),
  runs: await imp("app/api/schedule/[id]/runs/route.ts"),
};
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8"),
).version;

// `arm` and `fire` are tracked on the instance (boot doesn't await its arms).
const proto = Object.getPrototypeOf(scheduler);
scheduler.arm = function (job) {
  return G.track(proto.arm.call(this, job));
};
scheduler.fire = function (job, reArm) {
  G.fires++;
  const p = proto.fire.call(this, job, reArm);
  const done = () => {
    G.fires--;
  };
  p.then(done, done);
  return p;
};

// ---- helpers ------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const keyText = (k) => (k === undefined ? "undefined" : JSON.stringify(k));
const BS = "\\";
const esc = (hex) => `${BS}u${hex}`;
const norm = (s) => s.split(FAKE).join("$FAKE").split(ROOT).join("$ROOT");
const denorm = (s) => s.split("$ROOT").join(ROOT);

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
      list.push([r, Buffer.from(text, "utf8").equals(buf) ? norm(text) : { hex: buf.toString("hex") }]);
    }
  }
  return list;
}

const CWDS = ["project", "ws1", "ws2", "ws3", "ws4", "ws-extra"];
function cliLogs() {
  const list = [];
  for (const name of CWDS) {
    const dir = join(ROOT, name);
    const entry = {};
    const argv = join(dir, "argv.json");
    if (existsSync(argv)) entry.argv = JSON.parse(norm(readFileSync(argv, "utf8")));
    const log = join(dir, "stdin.log");
    if (existsSync(log)) {
      const ids = new Map();
      entry.stdin = norm(readFileSync(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const m = JSON.parse(l);
          if (typeof m.request_id !== "string") return m;
          if (!ids.has(m.request_id)) ids.set(m.request_id, `$ID${ids.size}`);
          return { ...m, request_id: ids.get(m.request_id) };
        });
    }
    if (Object.keys(entry).length) list.push([name, entry]);
  }
  return list;
}

function marks(cwd) {
  const f = join(ROOT, cwd, "events.jsonl");
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l === '{"mark":"gate"}').length;
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

// ---- the world ------------------------------------------------------------------

const DIRS = ["home/.claude/.claudius", "config", "ws1", "ws2", "ws3", "ws4", "ws-extra", "untrusted"];
const ws = (n, extra = {}) => ({
  id: `wks_golden0000${n}`,
  name: `ws${n}`,
  rootPath: `$ROOT/ws${n}`,
  icon: { kind: "letter", letter: "W", color: "#d97757" },
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const WORLD_FILES = [
  [
    "home/.claude/.claudius/workspaces.json",
    `${JSON.stringify(
      {
        version: 1,
        workspaces: [ws(1, { defaults: { additionalDirectories: ["$ROOT/ws-extra"] } }), ws(2), ws(3), ws(4)],
      },
      null,
      2,
    )}\n`,
  ],
];

function buildWorld() {
  // The project dir is this process's cwd: emptied, never removed.
  for (const e of readdirSync(join(ROOT, "project"))) rmSync(join(ROOT, "project", e), { recursive: true, force: true });
  for (const d of [...DIRS, "home"]) rmSync(join(ROOT, d.split("/")[0]), { recursive: true, force: true });
  for (const d of DIRS) mkdirSync(join(ROOT, d), { recursive: true });
  for (const [rel, text] of WORLD_FILES) writeFileSync(join(ROOT, rel), denorm(text));
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
      match: "[plain]",
      steps: [asst("plain: $PROMPT", "p")],
      result: res({ total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20 } }),
    },
    { match: "", steps: [asst("other: $PROMPT", "o")], result: res() },
  ],
};

// ---- groups ---------------------------------------------------------------------------

const T0 = Date.parse("2026-10-27T13:02:00.000Z") + 123;
const FAR = "0 0 29 2 *";
const FAR2 = "15 3 29 2 *";
const NEAR = "*/5 * * * *";
const TAB = "\t";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BOM = "efbbbf";
const hexOf = (s) => Buffer.from(s, "utf8").toString("hex");

const text = (b) => (typeof b === "string" ? b : JSON.stringify(b));
const req = (method, url, body) => ({ op: "req", method, url, ...(body === undefined ? {} : { body: text(body) }) });
const get = (url) => req("GET", url);
const post = (body) => req("POST", "/api/schedule", body);
const patch = (id, body) => req("PATCH", `/api/schedule/${id}`, body);
const del = (id) => req("DELETE", `/api/schedule/${id}`);
const runNow = (id) => req("POST", `/api/schedule/${id}/run-now`);
const runs = (id, q = "") => get(`/api/schedule/${id}/runs${q}`);
const start = (id, cwd) => ({ op: "start", url: `/api/schedule/${id}/run-now`, cwd });
const release = (cwd) => ({ op: "release", cwd });
const write = (path, t) => ({ op: "write", path, text: t });
const rm = (path) => ({ op: "rm", path });
const mkdir = (path) => ({ op: "mkdir", path });

const job = (id, extra = {}) => ({
  id,
  name: `job ${id}`,
  cron: FAR,
  prompt: `[plain] ${id}`,
  cwd: "$ROOT/project",
  enabled: true,
  createdAt: 1000,
  updatedAt: 2000,
  ...extra,
});
const jobsText = (jobs) => `${JSON.stringify({ jobs }, null, 2)}\n`;
const runLines = (runs) => `${runs.map((r) => JSON.stringify(r)).join("\n")}\n`;
/** A run an earlier process left `running`; `pid` undefined leaves it unstamped. */
const running = (id, jobId, startedAt, pid) => ({
  id,
  jobId,
  startedAt,
  status: "running",
  ...(pid === undefined ? {} : { pid }),
  transcript: [],
});
const ok = (extra = {}) => ({ name: "n", cron: FAR, prompt: "p", ...extra });

const GROUPS = [
  {
    name: "create and read",
    seed: [],
    steps: [
      get("/api/schedule"),
      // The body: a bare `await req.json()`.
      post(""),
      post("{"),
      post("null"),
      post("[]"),
      post('"str"'),
      post("7"),
      post("{}"),
      // `!body?.name?.trim()`: nullish or blank is a 400; another type throws.
      post({ name: "" }),
      post({ name: " \t\n " }),
      post(`{"name":"${esc("00a0")}${esc("feff")}${esc("2028")}${esc("3000")}"}`),
      post({ name: null }),
      post({ name: 5 }),
      post({ name: true }),
      post({ name: {} }),
      post({ name: ["a"] }),
      post('{"name":1e400}'),
      // `!body?.cron`, before the prompt and the cron's validation.
      post({ name: "n" }),
      post({ name: "n", cron: "" }),
      post({ name: "n", cron: 0 }),
      post({ name: "n", cron: null }),
      post({ name: "n", cron: false }),
      post({ name: "n", cron: "x" }),
      post({ name: "n", cron: "x", prompt: "" }),
      post({ name: "n", cron: "x", prompt: "   " }),
      post({ name: "n", cron: "x", prompt: null }),
      post({ name: "n", cron: "x", prompt: 5 }),
      // `validateCron(body.cron)`: `input.trim()` throws for a non-string.
      post(ok({ cron: 5 })),
      post(ok({ cron: true })),
      post(ok({ cron: [] })),
      post(ok({ cron: {} })),
      post('{"name":"n","cron":1e400,"prompt":"p"}'),
      post(ok({ cron: "   " })),
      post(ok({ cron: "* * * *" })),
      post(ok({ cron: "* * * * * *" })),
      post(ok({ cron: "@yearly" })),
      post(ok({ cron: "61 * * * *" })),
      post(ok({ cron: "a b c d e" })),
      post(ok({ cron: "* * * * 8" })),
      post(ok({ cron: "*/0 * * * *" })),
      post(ok({ cron: "0 0 31 2 *" })),
      // The cwd: only a registered directory, checked after the cron.
      post(ok({ cron: "61 * * * *", cwd: "$ROOT/untrusted" })),
      post(ok({ cwd: "$ROOT/untrusted" })),
      post(ok({ cwd: "relative" })),
      post(ok({ cwd: "$ROOT/missing" })),
      post(ok({ cwd: "$ROOT/ws1/sub" })),
      // Created: trimmed name, raw prompt, the process cwd, armed.
      post({ name: " Daily ", cron: FAR, prompt: "  [plain] first  " }),
      post({ name: "ws1 off", cron: NEAR, prompt: "[plain] w1", cwd: "$ROOT/ws1", model: "claude-x", enabled: false }),
      post({ name: "slash", cron: `  ${FAR2}  `, prompt: "p", cwd: "$ROOT/ws2/", model: "", enabled: "false" }),
      post({ name: "dots", cron: "0 0 29 feb *", prompt: "p", cwd: "$ROOT/ws1/../ws-extra", model: 5, enabled: 0 }),
      post({
        name: "odd",
        cron: `0${TAB}0${TAB}29${TAB}2${TAB}*`,
        prompt: "p",
        cwd: 5,
        model: {},
        enabled: null,
        id: "hijack",
        createdAt: 1,
        updatedAt: 2,
        nextRunAt: 3,
        lastRunAt: 4,
        lastStatus: "success",
        extra: true,
      }),
      post('{"name":"inf","cron":"0 0 29 2 *","prompt":"p","model":1e400,"enabled":1e400,"cwd":1e400}'),
      post(ok({ name: "nulls", model: null, cwd: "" })),
      post(ok({ name: "falsy", model: false, cwd: "   " })),
      post(ok({ name: "dot", model: 0, cwd: "." })),
      post(ok({ name: "array model", model: [1, "a"], cwd: "$ROOT/ws4" })),
      post(ok({ name: "true model", model: true, enabled: true })),
      // Valid, but no slot to arm (an `L` weekday fails at iteration).
      post(ok({ name: "L", cron: "0 0 * * L" })),
      post(ok({ name: "range", cron: "1-2-3 * * * *", enabled: false })),
      post(
        `{"name":"${esc("00e9")}t${esc("00e9")} ${esc("d83d")}${esc("de00")}","cron":"0 0 29 2 *","prompt":"line${esc("2028")}sep ${esc("0085")}","model":"m${esc("00e9")}"}`,
      ),
      post(`{"name":"${esc("0085")}","cron":"0 0 29 2 *","prompt":"nel"}`),
      { op: "req", method: "POST", url: "/api/schedule", hex: BOM + hexOf(text(ok({ name: "bom" }))) },
      { op: "req", method: "POST", url: "/api/schedule", hex: BOM + BOM + hexOf(text(ok({ name: "two boms" }))) },
      // Both BOMs go before an overflowing number is read: a truthy model, stored as null.
      {
        op: "req",
        method: "POST",
        url: "/api/schedule",
        hex: BOM + BOM + hexOf('{"name":"two boms inf","cron":"0 0 29 2 *","prompt":"p","model":1e400}'),
      },
      // A lone surrogate in a field nothing reads.
      post(`{"name":"lone","cron":"0 0 29 2 *","prompt":"p","x":"${esc("d800")}"}`),
      post('{"name":"a","name":"dup","cron":"x","cron":"0 0 29 2 *","prompt":"p","prompt":"[plain] dup"}'),
      // CC 2.1.312 -- `effort`: a known level, an explicit clear, else a 400.
      post(ok({ name: "effort high", effort: "high" })),
      post(ok({ name: "effort max", effort: "max", model: "claude-x" })),
      post(ok({ name: "effort null", effort: null })),
      post(ok({ name: "effort empty", effort: "" })),
      post(ok({ name: "effort unknown", effort: "ultra" })),
      post(ok({ name: "effort case", effort: "HIGH" })),
      post(ok({ name: "effort pad", effort: " high" })),
      post(ok({ name: "effort auto", effort: "auto" })),
      post(ok({ name: "effort number", effort: 5 })),
      post(ok({ name: "effort bool", effort: true })),
      post(ok({ name: "effort array", effort: ["high"] })),
      post(ok({ name: "effort object", effort: { level: "high" } })),
      post(ok({ name: "effort proto", effort: "toString" })),
      post('{"name":"effort inf","cron":"0 0 29 2 *","prompt":"p","effort":1e400}'),
      post('{"name":"effort dup","cron":"0 0 29 2 *","prompt":"p","effort":"max","effort":"low"}'),
      // Checked after the cron, before the cwd.
      post(ok({ name: "effort after cron", cron: "61 * * * *", effort: "ultra" })),
      post(ok({ name: "effort before cwd", effort: "ultra", cwd: "$ROOT/untrusted" })),
      get("/api/schedule"),
      get(`/api/schedule/${ID(1)}`),
      get("/api/schedule/nope"),
      get("/api/schedule/%20"),
      get("/api/schedule/hijack"),
      get(`/api/schedule/${ID(1).toUpperCase()}`),
      // A created job runs in its cwd, and isn't re-armed.
      runNow(ID(1)),
      runs(ID(1)),
      get(`/api/schedule/${ID(1)}`),
      get("/api/schedule?x=1"),
    ],
  },
  {
    name: "patch and delete",
    seed: [
      [
        "jobs.json",
        jobsText([
          { 10: "ten", ...job("p-on", { model: "m", x: 1.5 }) },
          job("p-off", { cron: NEAR, enabled: false }),
          job("p-one", { enabled: 1 }),
          job("p-bad", { cron: "nope" }),
          job("p-del"),
          job("p-L", { cron: FAR2 }),
          job("p-keep", { enabled: false }),
          job("p-str", { enabled: "yes" }),
          job("p-skip", { lastRunAt: 3000, lastStatus: "skipped", lastSkipReason: "workspace_folder_missing", lastSkipAt: 4000 }),
          job("p-skip2", { lastSkipReason: "previous_run_in_progress", lastSkipAt: 4000, effort: "high" }),
          job("p-skip3", { enabled: false, lastSkipReason: "workspace_folder_missing", lastSkipAt: 4000 }),
          { id: "p-bare", cron: FAR, prompt: "[plain] bare", enabled: false },
          "junk",
          7,
        ]),
      ],
      ["jobs/p-del/runs.jsonl", '{"id":"old","jobId":"p-del","startedAt":1,"status":"success"}\n'],
      ["jobs/p-del/runs.archive.jsonl", '{"id":"older","jobId":"p-del","startedAt":0,"status":"success"}\n'],
      ["jobs/p-keep/runs.jsonl", '{"id":"k","jobId":"p-keep","startedAt":1,"status":"success"}\n'],
      ["jobs/p-keep/notes.txt", "keep me\n"],
    ],
    steps: [
      patch("p-on", ""),
      patch("p-on", "{"),
      // `body.cron` without `?.`: a `null` body throws.
      patch("p-on", "null"),
      patch("nope", {}),
      patch("nope", { cron: "61 * * * *" }),
      patch("nope", { cwd: "$ROOT/untrusted" }),
      // Other bodies carry no field: only `updatedAt`, and a re-arm.
      patch("p-on", "[]"),
      patch("p-on", '"str"'),
      patch("p-on", "5"),
      patch("p-on", { cron: "61 * * * *" }),
      patch("p-on", { cron: "" }),
      patch("p-on", { cron: "* * *" }),
      patch("p-on", { cron: "@daily" }),
      patch("p-on", { cron: `  ${FAR2}  ` }),
      patch("p-on", { cron: 5, name: 5, prompt: null, enabled: "false", model: 7, cwd: 9 }),
      patch("p-on", { name: "", prompt: "  new  " }),
      patch("p-on", { model: null }),
      patch("p-on", { model: "m2" }),
      patch("p-on", { model: "" }),
      patch("p-on", '{"model":1e400,"name":1e400,"enabled":1e400,"cron":1e400}'),
      patch("p-on", { cwd: "$ROOT/untrusted" }),
      patch("p-on", { cwd: "relative" }),
      patch("p-on", { cwd: "" }),
      patch("p-on", { cwd: "$ROOT/ws1/" }),
      patch("p-on", { cron: "bad", cwd: "$ROOT/untrusted" }),
      patch("p-on", { enabled: false }),
      patch("p-on", { enabled: true }),
      patch("p-on", { id: "hijack", createdAt: 1, nextRunAt: 2, lastRunAt: 3, lastStatus: "x", extra: 1 }),
      patch("p-on", '{"enabled":false,"enabled":true,"name":"dup","name":"dup2"}'),
      { op: "req", method: "PATCH", url: "/api/schedule/p-on", hex: BOM + hexOf('{"name":"bom"}') },
      patch("p-on", { model: "m3" }),
      // Infinity isn't null: the model stays.
      { op: "req", method: "PATCH", url: "/api/schedule/p-on", hex: BOM + BOM + hexOf('{"model":1e400}') },
      patch("p-off", { name: "still off" }),
      patch("p-one", {}),
      patch("p-str", { prompt: "[plain] str" }),
      // New keys land in patch order: `updatedAt` first.
      patch("p-bare", { cwd: "$ROOT/ws2", model: "m", name: "bare" }),
      // Only a boolean is read: a truthy number leaves it disabled.
      patch("p-keep", { enabled: 1 }),
      patch("p-keep", `{"prompt":"[plain] lone","x":"${esc("d800")}"}`),
      // CC 2.1.312 -- the job's effort, validated as POST's.
      patch("p-on", { effort: "low" }),
      patch("p-on", { effort: "max" }),
      patch("p-on", { effort: "ultra" }),
      patch("p-on", { effort: 5 }),
      patch("p-on", { effort: ["low"] }),
      patch("p-on", '{"effort":1e400}'),
      patch("p-on", { effort: "" }),
      patch("p-on", { effort: "xhigh" }),
      patch("p-on", { effort: null }),
      patch("p-on", { effort: null }),
      // The cron's 400 comes first; the effort's before the cwd's.
      patch("p-on", { cron: "bad", effort: "low" }),
      patch("p-on", { effort: "ultra", cwd: "$ROOT/untrusted" }),
      patch("p-bare", { effort: "high" }),
      // CC 2.1.302 -- a cwd or enabled patch clears the skip reason.
      patch("p-skip", { name: "still skipped" }),
      patch("p-skip", { effort: "low" }),
      patch("p-skip", { enabled: true }),
      patch("p-skip2", { cwd: "$ROOT/ws1" }),
      patch("p-skip3", { enabled: 1 }),
      patch("p-skip3", { cwd: "nope" }),
      patch("p-skip3", { enabled: false }),
      patch("p-bad", {}),
      patch("p-bad", { cron: FAR }),
      // A cron with no slot: the old timer goes, its `nextRunAt` stays.
      patch("p-L", { cron: "0 0 * * L" }),
      patch("p-off", { cron: FAR, enabled: true }),
      patch("junk", {}),
      get("/api/schedule/p-on"),
      del("nope"),
      del("junk"),
      del("p-del"),
      del("p-del"),
      get("/api/schedule/p-del"),
      patch("p-del", {}),
      del("p-keep"),
      del("p-one"),
      get("/api/schedule"),
    ],
  },
  {
    name: "run-now and runs",
    seed: [
      [
        "jobs.json",
        jobsText([
          job("r-plain", { prompt: "[plain] hello", cwd: "$ROOT/ws1" }),
          job("r-off", { prompt: "[plain] off", cwd: "$ROOT/ws-extra", enabled: false }),
          job("r-err", { prompt: "[error-subtype]", cwd: "$ROOT/ws4" }),
          job("r-nocwd", { prompt: "[plain] nowhere", cwd: "$ROOT/missing", enabled: false }),
          job("r-gate", { prompt: "[gate] G", cwd: "$ROOT/ws2", enabled: false }),
          job("r-gate2", { prompt: "[gate] H", cwd: "$ROOT/ws3" }),
          job("r-model", { prompt: "[plain] model", model: "claude-golden-1", enabled: false }),
          job("r-effort", { prompt: "[plain] effort", cwd: "$ROOT/ws4", effort: "xhigh", enabled: false }),
        ]),
      ],
      [
        "jobs/r-foreign/runs.jsonl",
        [
          '{"id":"f1","jobId":"r-foreign","status":"running","startedAt":1}',
          "",
          '{"id":"f2","status":"running","attached":true,"x":1}',
          "5",
          '"str"',
          "[1]",
          "not json",
          '{"id":"f3","status":"success"}',
          "   ",
          '{"status":"running"}',
          '{"id":5,"status":"running"}',
          '{"id":"f4","status":"RUNNING","n":1.0}',
          '{"id":"f5","status":"running","attached":false,"__proto__":{"a":1}}',
          '{"id":"f6","status":"skipped"}',
          "",
        ].join("\n"),
      ],
    ],
    steps: [
      runNow("nope"),
      runNow("r-plain"),
      runs("r-plain"),
      get("/api/schedule/r-plain"),
      // Disabled or not, a run-now runs.
      runNow("r-off"),
      runNow("r-err"),
      runNow("r-nocwd"),
      runNow("r-model"),
      runNow("r-effort"),
      runs("r-err"),
      // CC 2.1.302 -- the folder is gone: the fire doesn't start, and says so.
      runNow("r-nocwd"),
      runs("r-nocwd"),
      get("/api/schedule/r-nocwd"),
      // One run at a time: a second one while it's in flight is `skipped`.
      start("r-gate", "ws2"),
      runs("r-gate"),
      runNow("r-gate"),
      runs("r-gate"),
      patch("r-gate", { name: "renamed mid-run" }),
      release("ws2"),
      runs("r-gate"),
      get("/api/schedule/r-gate"),
      // Deleted mid-run: the run's end writes nothing back.
      start("r-gate2", "ws3"),
      del("r-gate2"),
      runs("r-gate2"),
      release("ws3"),
      runs("r-gate2"),
      get("/api/schedule/r-gate2"),
      // `Number(limit || "50") || 50`, then `slice(-limit)`, newest first.
      runs("r-foreign"),
      runs("r-foreign", "?limit=2"),
      runs("r-foreign", "?limit=0"),
      runs("r-foreign", "?limit=-1"),
      runs("r-foreign", "?limit=-3"),
      runs("r-foreign", "?limit=abc"),
      runs("r-foreign", "?limit="),
      runs("r-foreign", "?limit=1e1"),
      runs("r-foreign", "?limit=0x3"),
      runs("r-foreign", "?limit=0b11"),
      runs("r-foreign", "?limit=2.5"),
      runs("r-foreign", "?limit=Infinity"),
      runs("r-foreign", "?limit=-Infinity"),
      runs("r-foreign", "?limit=%202%20"),
      runs("r-foreign", "?limit=+1"),
      runs("r-foreign", "?limit=1&limit=3"),
      runs("r-foreign", "?limit=-0"),
      runs("r-foreign", "?limit=1_0"),
      runs("r-foreign", "?LIMIT=1"),
      runs("r-foreign", "?limit"),
      runs("r-foreign", "?limit=1%2E5e0"),
      runs("nope"),
      // `r.status` off a `null` line throws, if it's in the window.
      write("jobs/r-null/runs.jsonl", 'null\n{"id":"a","status":"running"}\n{"id":"b","status":"success"}\n'),
      runs("r-null"),
      runs("r-null", "?limit=2"),
      runs("r-null", "?limit=3"),
      runs("r-null", "?limit=-1"),
      mkdir("jobs/r-dir/runs.jsonl"),
      runs("r-dir"),
      del("r-plain"),
      runs("r-plain"),
    ],
  },
  {
    name: "a broken store",
    seed: [["jobs.json", jobsText([job("b1")])]],
    steps: [
      write("jobs.json", "{oops"),
      get("/api/schedule"),
      get("/api/schedule/b1"),
      post(ok()),
      patch("b1", {}),
      // DELETE disarms before the store throws.
      del("b1"),
      runNow("b1"),
      runs("b1"),
      write("jobs.json", jobsText([null, { id: "b2", enabled: true, cron: FAR }])),
      get("/api/schedule"),
      get("/api/schedule/b2"),
      patch("b2", {}),
      del("b2"),
      runNow("b2"),
      post(ok()),
      write("jobs.json", jobsText([{ id: "b3", enabled: true, cron: FAR }, null])),
      get("/api/schedule/b3"),
      patch("b3", {}),
      del("b3"),
      write("jobs.json", '{"jobs":5}'),
      get("/api/schedule"),
      post(ok({ name: "over five" })),
      write("jobs.json", '{"jobs":{"0":{"id":"q"}}}'),
      get("/api/schedule/q"),
      write("jobs.json", "null"),
      get("/api/schedule"),
      write("jobs.json", ""),
      get("/api/schedule"),
      rm("jobs.json"),
      mkdir("jobs.json"),
      get("/api/schedule"),
      post(ok()),
      rm("jobs.json"),
      write(
        "jobs.json",
        `{"jobs":[{"10":1,"id":"x","n":1.0,"e":1e2,"big":12345678901234567890,"neg":-0.0,"small":1e-7,"inf":1e400,"u":"${esc("00e9")}${esc("d83d")}${esc("de00")}","dup":1,"dup":2,"2":true,"__proto__":{"p":1},"enabled":false}],"extra":true}`,
      ),
      get("/api/schedule"),
      get("/api/schedule/x"),
      patch("x", {}),
      get("/api/schedule"),
    ],
  },
  {
    // CC 2.1.302 -- the runs an earlier Claudius left `running`, recovered
    // before the server listens.
    name: "boot recovery",
    seed: [
      [
        "jobs.json",
        jobsText([
          job("b-dead", { lastRunAt: 1_000_000, lastStatus: "running" }),
          job("b-alive", { lastRunAt: 1_000_000, lastStatus: "running", enabled: false }),
          job("b-old", { lastRunAt: 1_000_000, lastStatus: "running", enabled: false }),
          job("b-mismatch", { lastRunAt: 999, lastStatus: "running", enabled: false }),
          job("b-done", { lastRunAt: 1_000_000, lastStatus: "success", enabled: false }),
        ]),
      ],
      ["jobs/b-dead/runs.jsonl", runLines([running("d0", "b-dead", 1, 999999), running("d1", "b-dead", 1_000_000, 999999)])],
      ["jobs/b-alive/runs.jsonl", runLines([running("a1", "b-alive", 1_000_000, 1)])],
      ["jobs/b-old/runs.jsonl", runLines([running("o1", "b-old", 1_000_000)])],
      ["jobs/b-mismatch/runs.jsonl", runLines([running("m1", "b-mismatch", 1_000_000, 999999)])],
      ["jobs/b-done/runs.jsonl", runLines([running("x1", "b-done", 1_000_000, 999999)])],
    ],
    steps: [
      get("/api/schedule"),
      runs("b-dead"),
      runs("b-alive"),
      runs("b-old"),
      runs("b-mismatch"),
      runs("b-done"),
      // A run started now stamps this process and clears nothing else.
      runNow("b-dead"),
      runs("b-dead"),
      get("/api/schedule/b-dead"),
    ],
  },
  {
    name: "boot fails",
    seed: [["jobs.json", "{oops"]],
    steps: [
      get("/api/schedule"),
      write("jobs.json", jobsText([job("late")])),
      // Booted already: the job isn't armed until a route arms it.
      get("/api/schedule"),
      post(ok({ name: "after boot" })),
      patch("late", {}),
      get("/api/schedule"),
    ],
  },
];

// ---- the driver ----------------------------------------------------------------------

let parked;
let gates;
let pending;

async function settle() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    await sleep(3);
    const live = [...scheduler.liveRuns.values()].filter((b) => !b.done);
    const quiet =
      G.ops === 0 &&
      G.fires === parked.size &&
      [...parked].every(([cwd, n]) => marks(cwd) >= n) &&
      live.length === parked.size &&
      live.every((b) => b.events.length >= 2);
    if (quiet) {
      await sleep(3);
      if (G.ops === 0 && G.fires === parked.size) return;
    }
    if (Date.now() > deadline) throw new Error(`settle timed out: ops ${G.ops}, fires ${G.fires}, parked ${parked.size}`);
  }
}

/** The handler a URL reaches, and its `params`. */
function route(method, url) {
  const path = new URL(url, "http://localhost").pathname;
  const seg = path.split("/").slice(3);
  if (seg.length === 0) return [routes.list[method], {}];
  const params = { id: decodeURIComponent(seg[0]) };
  if (seg.length === 1) return [routes.job[method], params];
  if (seg[1] === "run-now") return [routes.runNow[method], params];
  if (seg[1] === "runs") return [routes.runs[method], params];
  throw new Error(`no route for ${url}`);
}

function call(method, url, body) {
  const [handler, params] = route(method, url);
  if (!handler) throw new Error(`no ${method} for ${url}`);
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = body;
  const request = new Request(`http://localhost${denorm(url)}`, init);
  return handler(request, { params: Promise.resolve(params) });
}

async function got(p) {
  try {
    const r = await p;
    return { status: r.status, type: r.headers.get("content-type"), body: norm(await r.text()) };
  } catch (e) {
    return { threw: norm(`${e?.name}: ${e?.message}`) };
  }
}

function bodyOf(step) {
  if (step.hex !== undefined) return Buffer.from(denorm(Buffer.from(step.hex, "hex").toString("utf8")), "utf8");
  return step.body === undefined ? undefined : denorm(step.body);
}

async function doStep(step) {
  switch (step.op) {
    case "req": {
      const r = await got(call(step.method, step.url, bodyOf(step)));
      await settle();
      return r;
    }
    case "start": {
      const n = (gates.get(step.cwd) ?? 0) + 1;
      gates.set(step.cwd, n);
      parked.set(step.cwd, n);
      pending.set(step.cwd, got(call("POST", step.url)));
      await settle();
      return undefined;
    }
    case "release": {
      const gate = join(ROOT, step.cwd, "release");
      writeFileSync(gate, "");
      parked.delete(step.cwd);
      const r = await pending.get(step.cwd);
      pending.delete(step.cwd);
      await settle();
      unlinkSync(gate);
      return r;
    }
    case "write": {
      const p = join(SCHED, step.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, step.text);
      return undefined;
    }
    case "rm":
      rmSync(join(SCHED, step.path), { recursive: true, force: true });
      return undefined;
    case "mkdir":
      mkdirSync(join(SCHED, step.path), { recursive: true });
      return undefined;
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

function resetScheduler() {
  for (const h of scheduler.timers.values()) G.clearTimeout(h);
  scheduler.timers = new Map();
  scheduler.inFlight = new Set();
  scheduler.liveRuns = new Map();
  G.timers.clear();
  G.seq = 0;
  G.n = 0;
  scheduler.bootPromise = null;
  __resetTrustedCwdCache();
}

function snapshot(prevFiles, prevCli) {
  return {
    files: diff(walk(CLAUDIUS), prevFiles),
    timers: [...scheduler.timers].map(([k, h]) => [norm(keyText(k)), h.due]).sort((a, b) => cmp(a[0], b[0])),
    cli: diff(cliLogs(), prevCli),
  };
}

writeFileSync(SCRIPT, JSON.stringify(SCRIPT_BODY));
const groups = [];
for (const g of GROUPS) {
  buildWorld();
  resetScheduler();
  parked = new Map();
  gates = new Map();
  pending = new Map();
  for (const [rel, t] of g.seed) {
    const p = join(SCHED, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, denorm(t));
  }
  const prevFiles = new Map();
  const prevCli = new Map();
  G.t = T0;
  G.procStart = T0 - 60_000;
  let boot;
  try {
    await scheduler.boot();
    boot = { clock: G.t, result: "ok" };
  } catch (e) {
    boot = { clock: G.t, result: { threw: norm(`${e?.name}: ${e?.message}`) } };
  }
  await settle();
  boot.snap = snapshot(prevFiles, prevCli);
  const steps = [];
  for (const [i, step] of g.steps.entries()) {
    G.t = T0 + 1000 * (i + 1);
    const r = await doStep(step);
    const rec = { ...step, clock: G.t };
    if (r !== undefined) rec.got = r;
    rec.snap = snapshot(prevFiles, prevCli);
    steps.push(rec);
  }
  if (G.fires !== 0 || G.ops !== 0 || parked.size !== 0 || pending.size !== 0) throw new Error(`${g.name}: left work in flight`);
  groups.push({ name: g.name, seed: g.seed, boot, steps });
}

writeFileSync(
  join(ROOT, "out.json"),
  JSON.stringify({
    sdkVersion,
    tz: TZ,
    t0: T0,
    pid: PID,
    procStart: T0 - 60_000,
    world: { dirs: DIRS, files: WORLD_FILES },
    script: SCRIPT_BODY,
    groups,
  }),
);
process.exit(0);
