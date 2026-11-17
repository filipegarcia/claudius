#!/usr/bin/env node
// Golden fixture for the dead-session restart (R03 / CC 2.1.311), recorded
// from the TS sources:
//
//   node rust/scripts/dead-session-golden.mjs   (node@22: session.ts needs
//                                                better-sqlite3, which bun
//                                                can't load; builds
//                                                claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir and a resolve hook for the extensionless /
// `@/` imports, twice (two temp roots); both recordings must agree byte for
// byte. The hook maps session.ts's SDK import to a shim that calls the real
// `query()` with `pathToClaudeCodeExecutable` added (the fake CLI, or a
// missing path for the dies-on-boot cases).
//
// One timeline per scenario on the real `sessionManager` (the singleton) and
// the real route handlers for `POST /input`, `queue/[uuid]/send-now`,
// `queue/send-all` and `GET /stream`, with `Date.now()` behind an offset the
// steps advance (the restart budget's cooldown). Steps:
//
//   {create}            sessionManager.create({id, cwd}) -> ok / threw
//   {post: [route, body, uuid?]}   a real route handler -> {status, body}
//   {restart: {passive}}           sessionManager.restartIfDead -> the result
//   {sendQueuedNow: "head"}        Session.sendQueuedNow on the bound session
//   {noteSuccess}       noteThinkingRecoverySuccess (a successful turn)
//   {advance: ms}       move the clock the budget reads
//   {settings: text}    write $HOME/.claude/settings.json ("$RM" removes it)
//   {bin: "missing"}    point the next CLI at a path that doesn't exist
//   {kill}              SIGKILL the live CLI (a crash between turns)
//   {stream}            open the stream route and keep reading it
//   {end}               Session.end() on the bound session
//   {waitDead}          wait until the bound session reads dead
//   {probe}             nothing; just the snapshot below
//
// After every step: `bound` (the id is in the manager's map), `instance` (a
// per-object counter, so a rebuild shows), `isDead`, `cameUpLive`, `done`,
// `turnStatus`, `hasArmedLoops`, `queue` (the rows' uuid + text), and
// `streamClosed` once a stream was opened. Queue uuids read `$Q<n>` in the
// order they were enqueued, every other uuid `$UUID`, temp paths `$ROOT`.
// `dead` also records `MAX_DEAD_RESTARTS` / `DEAD_RESTART_COOLDOWN_MS` and
// every `deadSessionResponse` mapping.
//
// Written to rust/crates/claudius-core/tests/fixtures/dead_session_golden.json
// and replayed by crates/claudius-server/tests/dead_session.rs (the real
// router in process, so the probes can read the manager).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/dead_session_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.DEAD_SESSION_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dead-session-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          // db.ts reads its migrations from `process.cwd()/lib/server/db-migrations`.
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            DEAD_SESSION_GOLDEN_CHILD: root,
            DEAD_SESSION_GOLDEN_FAKE: fake,
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
    writeFileSync(join(tmpdir(), "dead-session-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "dead-session-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.scenarios.reduce((n, s) => n + s.steps.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.scenarios.length} scenarios (${steps} steps), ${fixture.responses.length} dead-session responses (SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.DEAD_SESSION_GOLDEN_CHILD;
const FAKE = process.env.DEAD_SESSION_GOLDEN_FAKE;
const MISSING = "/nonexistent/claude";
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.DEAD_SESSION_GOLDEN_BIN } });
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

process.env.DEAD_SESSION_GOLDEN_BIN = FAKE;

const mgrMod = await import(join(repo, "lib/server/session-manager.ts"));
const { sessionManager, deadSessionResponse, MAX_DEAD_RESTARTS, DEAD_RESTART_COOLDOWN_MS } = mgrMod;
const { POST: INPUT } = await import(join(repo, "app/api/sessions/[id]/input/route.ts"));
const { POST: SEND_NOW } = await import(join(repo, "app/api/sessions/[id]/queue/[uuid]/send-now/route.ts"));
const { POST: SEND_ALL } = await import(join(repo, "app/api/sessions/[id]/queue/send-all/route.ts"));
const { GET: STREAM } = await import(join(repo, "app/api/sessions/[id]/stream/route.ts"));
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

// The clock the restart budget reads, behind an offset the steps advance.
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow.call(Date) + clockOffset;

const HOME = process.env.HOME;
const settingsFile = join(HOME, ".claude", "settings.json");
mkdirSync(dirname(settingsFile), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Instance identity across rebuilds: a counter per Session object.
const instances = new WeakMap();
let nextInstance = 0;
function instanceOf(s) {
  if (!s) return null;
  if (!instances.has(s)) instances.set(s, ++nextInstance);
  return instances.get(s);
}

async function waitFor(pred, ms) {
  for (let t = 0; t < ms; t += 10) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

// Next logs an unhandled rejection and carries on; so does the recorder.
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(e instanceof Error ? e.message : String(e)));

// ------------------------------- scenarios -------------------------------

const post = (route, body, uuid) => ({ post: [route, body ?? null, uuid ?? null] });
const INPUT_HELLO = '{"text":"hello"}';
// The fake CLI exits with that code when a prompt starts with `exit:`.
const INPUT_CRASH = '{"text":"exit:3"}';
const QUEUE = (text) => `{"text":${JSON.stringify(text)},"forceQueue":true}`;

const SCENARIOS = [
  [
    "a crash between turns, then a send restarts it",
    [
      { create: true },
      post("input", INPUT_HELLO),
      { stream: true },
      post("input", INPUT_CRASH),
      { waitDead: true },
      { probe: true },
      post("input", '{"text":"again"}'),
      { probe: true },
      post("input", '{"text":"and again"}'),
    ],
  ],
  [
    "a passive caller restarts a session whose CLI came up",
    [
      { create: true },
      post("input", INPUT_HELLO),
      post("input", INPUT_CRASH),
      { waitDead: true },
      { restart: { passive: true } },
      { probe: true },
      { restart: { passive: true } },
      { restart: { passive: false } },
    ],
  ],
  [
    "a CLI that dies on boot stays bound and dead",
    [
      { bin: "missing" },
      { create: true },
      { waitDead: true },
      { probe: true },
      { restart: { passive: true } },
      { probe: true },
      { stream: true },
      { probe: true },
      { restart: { passive: false } },
      { waitDead: true },
      { probe: true },
    ],
  ],
  [
    "the budget: three restarts, then max_attempts; the cooldown refills it",
    [
      { bin: "missing" },
      { create: true },
      { waitDead: true },
      { restart: { passive: false } },
      { waitDead: true },
      { restart: { passive: false } },
      { waitDead: true },
      { restart: { passive: false } },
      { waitDead: true },
      { restart: { passive: false } },
      post("input", '{"text":"x"}'),
      { advance: 1000 },
      { restart: { passive: false } },
      { advance: DEAD_RESTART_COOLDOWN_MS },
      { restart: { passive: false } },
      { waitDead: true },
      { restart: { passive: false } },
      { noteSuccess: true },
      { restart: { passive: false } },
      { waitDead: true },
      { probe: true },
    ],
  ],
  [
    "a failed rebuild keeps the dead session bound",
    [
      { create: true },
      post("input", INPUT_CRASH),
      { waitDead: true },
      { settings: "null" },
      { restart: { passive: false } },
      { probe: true },
      post("input", '{"text":"again"}'),
      { settings: "$RM" },
      post("input", '{"text":"now"}'),
      { probe: true },
    ],
  ],
  [
    "the queue survives send-now and send-all on a dead session",
    [
      { create: true },
      post("input", QUEUE("q one")),
      post("input", QUEUE("q two")),
      { kill: true },
      { waitDead: true },
      { probe: true },
      // A rebuild that throws: the rows must still be there afterwards.
      { settings: "null" },
      post("send-now", null, "$Q1"),
      post("send-all", null),
      { probe: true },
      // And `sendQueuedNow` itself leaves the row queued once `done` is set.
      { sendQueuedNow: "$Q1" },
      { probe: true },
      { settings: "$RM" },
    ],
  ],
  [
    "send-now and send-all restart a dead session",
    [
      { create: true },
      post("input", INPUT_HELLO),
      { kill: true },
      { waitDead: true },
      post("send-now", null, "00000000-0000-4000-8000-000000000001"),
      { probe: true },
      { kill: true },
      { waitDead: true },
      post("send-all", null),
      { probe: true },
    ],
  ],
  [
    "input validates before any restart",
    [
      { create: true },
      post("input", INPUT_CRASH),
      { waitDead: true },
      post("input", null),
      post("input", ""),
      post("input", "{"),
      post("input", "null"),
      post("input", "0"),
      post("input", "false"),
      post("input", '""'),
      post("input", '"hi"'),
      post("input", "{}"),
      post("input", '{"text":""}'),
      post("input", '{"text":5}'),
      post("input", '{"images":[]}'),
      post("input", '{"text":"ok","inlinePastes":["a","",5,null,"b"]}'),
      { probe: true },
    ],
  ],
  [
    "an unknown id",
    [
      post("input", INPUT_HELLO),
      post("input", "{"),
      post("send-now", null, "00000000-0000-4000-8000-000000000000"),
      post("send-all", null),
      { restart: { passive: false } },
      { restart: { passive: true } },
    ],
  ],
  [
    "end() is not a death, but one before it still is",
    [
      { create: true },
      post("input", INPUT_HELLO),
      { end: true },
      { probe: true },
      { restart: { passive: false } },
      { probe: true },
    ],
  ],
  [
    "a crash before end() keeps it dead",
    [
      { create: true },
      post("input", INPUT_CRASH),
      { waitDead: true },
      { end: true },
      { probe: true },
      { restart: { passive: false } },
      { probe: true },
    ],
  ],
  [
    "an armed wake-up stops keeping a dead session alive",
    [
      { create: true },
      post("input", '{"text":"arm"}'),
      { probe: true },
      post("input", INPUT_CRASH),
      { waitDead: true },
      { probe: true },
    ],
  ],
];

// The wake-up the last scenario arms (the reaper's keep-alive reads it).
const WAKEUP_SCRIPT = {
  turns: [
    {
      match: "arm",
      result: "armed",
      steps: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_wake",
                name: "ScheduleWakeup",
                input: { delaySeconds: 3600, reason: "watch", prompt: "/loop watch", noop: true },
              },
            ],
          },
        },
      ],
    },
  ],
};

const scenarios = [];
for (const [ci, [name, steps]] of SCENARIOS.entries()) {
  const id = `dead-${ci}`;
  const cwd = join(ROOT_DIR, "proj", String(ci));
  mkdirSync(cwd, { recursive: true });
  process.env.DEAD_SESSION_GOLDEN_BIN = FAKE;
  process.env.FAKE_CLAUDE_LOG = join(cwd, "stdin.log");
  const pidFile = join(cwd, "cli.pid");
  process.env.FAKE_CLAUDE_PID = pidFile;
  if (name.includes("wake-up")) process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify(WAKEUP_SCRIPT);
  else delete process.env.FAKE_CLAUDE_SCRIPT;
  clockOffset = 0;
  rmSync(settingsFile, { force: true });
  // Queue uuids in enqueue order, so the fixture can name them `$Q<n>`.
  const queued = [];
  let streamClosed = null;
  let reader = null;

  const norm = (v) => {
    if (typeof v === "string") {
      let s = v.split(ROOT_DIR).join("$ROOT");
      const q = queued.indexOf(s);
      if (q >= 0) return `$Q${q + 1}`;
      if (UUID_RE.test(s)) s = "$UUID";
      return s;
    }
    if (Array.isArray(v)) return v.map((x) => norm(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
    }
    return v;
  };
  // A body with uuids / paths in it, re-printed through `norm`.
  const normBody = (text) => {
    try {
      return JSON.stringify(norm(JSON.parse(text)));
    } catch {
      return norm(text);
    }
  };

  async function probe() {
    const s = sessionManager.get(id);
    const snap = s ? await s.getQueueSnapshot() : [];
    return {
      bound: !!s,
      instance: instanceOf(s),
      isDead: s ? s.isDead() : null,
      cameUpLive: s ? s.cameUpLive() : null,
      done: s ? s.done : null,
      turnStatus: s ? s.getStatus() : null,
      hasArmedLoops: s ? s.hasArmedLoops() : null,
      queue: snap.map((r) => ({ uuid: norm(r.uuid), text: r.text })),
      ...(streamClosed === null ? {} : { streamClosed }),
    };
  }

  async function call(route, body, uuid) {
    const url = `http://x/api/sessions/${id}`;
    const req = new Request(url, { method: "POST", ...(body === null ? {} : { body }) });
    const handlers = {
      input: () => INPUT(req, { params: Promise.resolve({ id }) }),
      "send-now": () => SEND_NOW(req, { params: Promise.resolve({ id, uuid }) }),
      "send-all": () => SEND_ALL(req, { params: Promise.resolve({ id }) }),
    };
    try {
      const res = await handlers[route]();
      const text = await res.text();
      // An enqueued message's uuid becomes `$Q<n>` from here on.
      const parsed = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();
      if (parsed?.queued === true && typeof parsed.uuid === "string") queued.push(parsed.uuid);
      return { status: res.status, body: normBody(text) };
    } catch (e) {
      return { threw: e instanceof Error ? e.message : String(e) };
    }
  }

  const recorded = [];
  for (const step of steps) {
    let got = {};
    if (step.create) {
      try {
        const s = await sessionManager.create({ id, cwd });
        got = { created: instanceOf(s) };
      } catch (e) {
        got = { threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      }
    } else if (step.post) {
      const [route, body, uuid] = step.post;
      const real = uuid && uuid.startsWith("$Q") ? queued[Number(uuid.slice(2)) - 1] : uuid;
      got = await call(route, body, real ?? uuid ?? undefined);
    } else if (step.restart) {
      const r = await sessionManager.restartIfDead(id, { passive: step.restart.passive });
      got = r.ok
        ? { ok: true, restarted: r.restarted, instance: instanceOf(r.session) }
        : { ok: false, reason: r.reason, error: r.error === undefined ? null : norm(r.error) };
    } else if (step.sendQueuedNow) {
      const s = sessionManager.get(id);
      const uuid = queued[Number(step.sendQueuedNow.slice(2)) - 1];
      got = { dispatched: s ? await s.sendQueuedNow(uuid) : null };
    } else if (step.noteSuccess) {
      sessionManager.noteThinkingRecoverySuccess(id);
    } else if (step.advance) {
      clockOffset += step.advance;
    } else if (step.settings) {
      if (step.settings === "$RM") rmSync(settingsFile, { force: true });
      else writeFileSync(settingsFile, step.settings === "null" ? "null" : step.settings);
    } else if (step.bin) {
      process.env.DEAD_SESSION_GOLDEN_BIN = step.bin === "missing" ? MISSING : FAKE;
    } else if (step.stream) {
      const res = await STREAM(new Request(`http://x/api/sessions/${id}/stream`), {
        params: Promise.resolve({ id }),
      });
      got = { status: res.status };
      if (res.body) {
        streamClosed = false;
        reader = res.body.getReader();
        void (async () => {
          try {
            for (;;) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch {
            // a closed controller ends the read
          }
          streamClosed = true;
        })();
      }
    } else if (step.kill) {
      // A crash between turns: the CLI goes without the session ending it.
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      try {
        process.kill(pid, "SIGKILL");
        got = { killed: true };
      } catch {
        got = { killed: false };
      }
    } else if (step.end) {
      const s = sessionManager.get(id);
      if (s) await s.end();
    } else if (step.waitDead) {
      got = { dead: await waitFor(() => !!sessionManager.get(id)?.isDead(), 15_000) };
    }
    // Let the turn, the crash and the rebuild's own round trips settle.
    await sleep(step.waitDead ? 150 : 400);
    recorded.push({ ...step, got: { ...got, ...(await probe()) } });
  }
  if (reader) await reader.cancel().catch(() => {});
  const s = sessionManager.get(id);
  if (s) await sessionManager.remove(id);
  scenarios.push({ name, id, steps: recorded });
}
delete process.env.FAKE_CLAUDE_SCRIPT;
rmSync(settingsFile, { force: true });

// `deadSessionResponse` for every reason, including an error-less `failed`.
const RESPONSES = [
  { reason: "gone" },
  { reason: "max_attempts" },
  { reason: "failed", error: "boom" },
  { reason: "failed", error: "" },
  { reason: "failed" },
  { reason: "skipped" },
];
const responses = RESPONSES.map((res) => ({ res, ...deadSessionResponse(res) }));

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(
  join(ROOT_DIR, "out.json"),
  JSON.stringify({
    sdkVersion,
    maxDeadRestarts: MAX_DEAD_RESTARTS,
    cooldownMs: DEAD_RESTART_COOLDOWN_MS,
    scenarios,
    responses,
    rejections,
  }),
);
process.exit(0);
