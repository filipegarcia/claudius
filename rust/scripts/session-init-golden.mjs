#!/usr/bin/env node
// Golden fixture for the live-init hooks (S28a, S28b), recorded from the TS
// sources:
//
//   node rust/scripts/session-init-golden.mjs   (node@22: session.ts needs
//                                                better-sqlite3, which bun
//                                                can't load; builds
//                                                claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir and a resolve hook for the extensionless /
// `@/` imports, twice (two temp roots); both recordings must agree byte for
// byte. The hook maps session.ts's SDK import to a shim that calls the real
// `query()` with `pathToClaudeCodeExecutable` set to the fake CLI.
//
// Every case runs in its own project dir, which holds the fake CLI's script
// (`FAKE_CLAUDE_SCRIPT=fake-script.json`, relative to the CLI's cwd) and its
// control log (`FAKE_CLAUDE_CONTROL_LOG=control.log`), with the case's user
// settings.json text (`settings`, or null for none). Two kinds:
// - `broadcast` (S28a): `sessionManager.create({cwd})`, then, once the CLI
//   has read `initialize` and the start-up traffic is over, a live
//   subscriber and the real dev-broadcast route (`POST`) once per step. Each
//   step records the route's answer (`status`, `body`: cwd and id as `$ROOT`
//   and `$ID`), the events the subscriber saw (`events`: an `sdk` event
//   without its `at`, every other event whole) once nothing new arrived for
//   400 ms, the broadcast event first and the rest sorted by their JSON text
//   (each lands as the CLI's reply to its request does, so their order is a
//   race), the control requests the session sent meanwhile (`wire`: each
//   `request`, in the order written) and the promise rejections nothing
//   handled (`rejections`: `name: message`; Next only logs them).
// - `consume` (S28b): `new Session({cwd})` with a subscriber from the
//   start, then `start()`; the CLI's own `system/init` names the model, its
//   `on_init` steps follow the init, and its `apply_flag_settings` reply is
//   delayed. Records the order (`order`) of the `sdk` system messages
//   (`sdk:<subtype>`) and the advisor notice (its type), the notice itself
//   (`notice`), and every control request written (`wire`).
// Both record `settingsAfter`, the user settings.json text at the end.
// Every path under the temp root reads `$ROOT`.
//
// Written to rust/crates/claudius-server/tests/fixtures/session_init_golden.json
// and replayed on the real binary by crates/claudius-server/tests/session_init.rs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/session_init_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SESSION_INIT_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-init-golden-")));
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
            SESSION_INIT_GOLDEN_CHILD: root,
            SESSION_INIT_GOLDEN_FAKE: fake,
            FAKE_CLAUDE_SCRIPT: "fake-script.json",
            FAKE_CLAUDE_CONTROL_LOG: "control.log",
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
    writeFileSync(join(tmpdir(), "session-init-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "session-init-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} cases (SDK ${fixture.sdkVersion})`);
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.SESSION_INIT_GOLDEN_CHILD;
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.SESSION_INIT_GOLDEN_FAKE } });
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

const { Session } = await import(join(repo, "lib/server/session.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const devBroadcast = await import(join(repo, "app/api/sessions/[id]/dev-broadcast/route.ts"));
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

// `void this.enforceAdvisorModelCompatibility(...)` can reject (a model
// without `.includes`); Next logs it, the recorder keeps it.
const rejections = [];
process.on("unhandledRejection", (e) => {
  rejections.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
});

const norm = (s) => s.split(ROOT_DIR).join("$ROOT");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
async function waitFor(pred, ms) {
  for (let t = 0; t < ms; t += 10) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

const HOME = process.env.HOME;
const settingsFile = join(HOME, ".claude", "settings.json");
mkdirSync(dirname(settingsFile), { recursive: true });

/** The control requests written so far (`request` only). The CLI may be
 * mid-write: an incomplete last line isn't one yet. */
const wire = (log) =>
  (readText(log) ?? "")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    })
    .filter((m) => m.type === "control_request")
    .map((m) => m.request);

/** Waits until `count()` and the control log stop changing for `quietMs`. */
async function settle(count, log, quietMs = 400, maxMs = 6000) {
  let last = `${count()}/${readText(log)?.length ?? 0}`;
  let stableSince = Date.now();
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(20);
    const now = `${count()}/${readText(log)?.length ?? 0}`;
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
  }
}

/** The first event, then the rest in JSON-text order. */
const firstThenSorted = ([first, ...rest]) => {
  const text = (e) => JSON.stringify(e);
  rest.sort((a, b) => (text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0));
  return first === undefined ? [] : [first, ...rest];
};

/** An event as recorded: an `sdk` event without its `at`. */
const pick = (e) => (e.type === "sdk" ? { type: "sdk", message: e.message } : e);

// ------------------------------- the cases -------------------------------

const init = (extra = {}) => ({ type: "sdk", message: { type: "system", subtype: "init", ...extra } });
// The CLI's own init made into another system message, so a session's first
// live init is the one the dev route sends.
const HELD = { init: { subtype: "init_held" } };
const STATUS = {
  mcpServers: [
    { name: "linear", status: "needs-auth" },
    { name: "pg", status: "failed" },
    { name: "ok", status: "connected" },
    { status: "needs-auth" },
    { name: 5, status: "failed" },
  ],
};
const S = (o) => JSON.stringify(o);

const CASES = [
  // S28a: the start-up notices, the effort refresh, once per session for the notices.
  {
    name: "notices and effort",
    kind: "broadcast",
    script: { ...HELD, control: { mcp_status: STATUS, get_settings: { applied: { effort: "high" } } } },
    steps: [
      init({ model: "claude-opus-4-5", session_id: "x" }),
      init({ model: "claude-opus-4-5" }),
      { type: "sdk", message: { type: "system", subtype: "status" } },
      { type: "sdk", message: { type: "assistant", subtype: "init" } },
      { type: "sdk", message: { subtype: "init" } },
      { type: "model_changed", model: "claude-haiku-4-5" },
    ],
  },
  {
    name: "notices on a later init",
    kind: "broadcast",
    script: { ...HELD, control: { mcp_status: STATUS } },
    steps: [{ type: "sdk", message: { type: "system", subtype: "status" } }, init(), init()],
  },
  {
    name: "status without servers",
    kind: "broadcast",
    script: { ...HELD, control: { mcp_status: { mcpServers: "none" } } },
    steps: [init({ model: "claude-opus-4-5" })],
  },
  // S28a: the advisor check against the init's model.
  {
    name: "fable init clears the advisor",
    kind: "broadcast",
    settings: '{\n  "x": 1,\n  "advisorModel": "opus",\n  "y": [1.0, 1e2]\n}\n',
    script: HELD,
    steps: [init({ model: "claude-fable-5" }), init({ model: "claude-fable-5" })],
  },
  {
    name: "fable init, no advisor",
    kind: "broadcast",
    settings: S({ x: 1 }),
    script: HELD,
    steps: [init({ model: "claude-fable-5" })],
  },
  {
    name: "fable init, empty advisor",
    kind: "broadcast",
    settings: S({ advisorModel: "" }),
    script: HELD,
    steps: [init({ model: "claude-fable-5" })],
  },
  {
    name: "other init keeps the advisor",
    kind: "broadcast",
    settings: S({ advisorModel: "opus" }),
    script: HELD,
    steps: [init({ model: "claude-opus-4-5" }), init(), init({ model: "" })],
  },
  {
    name: "array model with fable",
    kind: "broadcast",
    settings: S({ advisorModel: "opus" }),
    script: HELD,
    steps: [init({ model: ["claude-fable-5"] }), init({ model: ["fable"] })],
  },
  {
    name: "number model",
    kind: "broadcast",
    settings: S({ advisorModel: "opus" }),
    script: HELD,
    steps: [init({ model: 5 }), init({ model: 0 }), init({ model: { fable: true } }), init({ model: "x-fable" })],
  },
  // S28b: the CLI's own init; the advisor clear doesn't hold the stream up.
  {
    name: "delayed advisor reply",
    kind: "consume",
    settings: S({ advisorModel: "opus" }),
    script: {
      init: { model: "claude-fable-5" },
      on_init: [
        { type: "system", subtype: "probe_one" },
        { type: "system", subtype: "probe_two" },
      ],
      control: { apply_flag_settings: { $response: {}, $delay_ms: 1500 } },
    },
  },
];

async function runBroadcast(c, cwd, control) {
  const s = await sessionManager.create({ cwd });
  if (!(await waitFor(() => wire(control).some((r) => r.subtype === "initialize"), 10_000))) {
    throw new Error(`${c.name}: no initialize`);
  }
  const seen = [];
  await settle(() => seen.length, control);
  const unsubscribe = s.subscribe((e) => seen.push(e));
  // Drop what subscribe() replays and re-emits.
  seen.length = 0;
  const steps = [];
  let offset = wire(control).length;
  for (const event of c.steps) {
    const from = seen.length;
    const rejectedFrom = rejections.length;
    const res = await devBroadcast.POST(
      new Request(`http://localhost/api/sessions/${s.id}/dev-broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event }),
      }),
      { params: Promise.resolve({ id: s.id }) },
    );
    const body = JSON.parse(norm(await res.text()).split(s.id).join("$ID"));
    await settle(() => seen.length, control);
    const all = wire(control);
    steps.push({
      event,
      status: res.status,
      body,
      events: firstThenSorted(JSON.parse(norm(JSON.stringify(seen.slice(from).map(pick))))),
      wire: JSON.parse(norm(JSON.stringify(all.slice(offset)))),
      rejections: rejections.slice(rejectedFrom),
    });
    offset = all.length;
  }
  unsubscribe();
  await sessionManager.remove(s.id);
  return { steps };
}

async function runConsume(c, cwd, control) {
  const s = new Session({ cwd });
  const seen = [];
  const unsubscribe = s.subscribe((e) => seen.push(e));
  await s.start();
  const notice = () => seen.find((e) => e.type === "advisor_disabled_on_model_change");
  if (!(await waitFor(() => notice() !== undefined, 10_000))) throw new Error(`${c.name}: no notice`);
  await settle(() => seen.length, control);
  const order = seen
    .filter((e) => (e.type === "sdk" && e.message?.type === "system") || e.type === "advisor_disabled_on_model_change")
    .map((e) => (e.type === "sdk" ? `sdk:${e.message.subtype}` : e.type));
  unsubscribe();
  const res = { order, notice: notice(), wire: JSON.parse(norm(JSON.stringify(wire(control)))) };
  await s.end();
  return res;
}

const cases = [];
for (const [i, c] of CASES.entries()) {
  const cwd = join(ROOT_DIR, "cases", String(i));
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "fake-script.json"), JSON.stringify(c.script));
  const control = join(cwd, "control.log");
  if (c.settings == null) rmSync(settingsFile, { force: true });
  else writeFileSync(settingsFile, c.settings);
  const got = c.kind === "broadcast" ? await runBroadcast(c, cwd, control) : await runConsume(c, cwd, control);
  cases.push({
    name: c.name,
    kind: c.kind,
    settings: c.settings ?? null,
    script: c.script,
    ...got,
    settingsAfter: readText(settingsFile),
  });
}
rmSync(settingsFile, { force: true });
if (!existsSync(ROOT_DIR)) throw new Error("temp root vanished");

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ sdkVersion, cases }));
process.exit(0);
