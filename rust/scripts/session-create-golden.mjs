#!/usr/bin/env node
// Golden fixture for the create route's body types (S27d), recorded from the
// TS sources:
//
//   node rust/scripts/session-create-golden.mjs   (node@22: session.ts needs
//                                                  better-sqlite3, which bun
//                                                  can't load; builds
//                                                  claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir and a resolve hook for the extensionless /
// `@/` imports, twice (two temp roots); both recordings must agree byte for
// byte. The hook maps session.ts's SDK import to a shim that calls the real
// `query()` with `pathToClaudeCodeExecutable` set to the fake CLI. The child
// runs in `$ROOT/proc` (a `lib` symlink to the repo, for db.ts's migrations
// dir), so `process.cwd()` -- the route's last-resort cwd and the trusted
// roots' first entry -- is a temp dir and not the repo; it reads `$PROC`.
//
// Each case POSTs its body to the real `app/api/sessions/route.ts` and
// records what an odd-typed option did:
// - `status` and `response` (the route's JSON, cwd/id as `$ROOT`/`$PROC`/`$ID`);
// - `flags`: the CLI arguments the body decides, in argv order (every other
//   argument is the SDK's own and moves with its version, which this fixture
//   must not pin: see FLAGS);
// - `initConfig`: the `initialize` control request's `systemPrompt`,
//   `appendSystemPrompt` and `planModeInstructions` (the SDK sends the
//   prompt options there, not in argv), or null when no CLI ran;
// - `restrictedEnv`: the CLI's `CLAUDE_CODE_RESTRICTED`, or null;
// - `ready`: the buffered `ready` and `error` events (`ready` carries `agent`
//   and `fallbackModel` raw). The rest of the buffer depends on how far the
//   CLI got before the route returned, which is not what this fixture is
//   about;
// - `rejections`: promise rejections nothing handled (Next only logs them).
// A body whose option throws when `start()` reads it (`.trim()` on a
// non-string `planModeInstructions`, `.includes` on a non-string `model`
// while an advisor is armed) is a 500 whose `name` is the error's: that's
// `status` + `response`. A case's `settings` is the user settings.json text
// it starts with (null: no file), `settingsAfter` the text it leaves.
//
// Every case dir is a registered workspace, so an explicit `cwd` of `"$CASE"`
// (this case's dir) is trusted. The fake CLI writes its argv, environment and
// control log next to its cwd (`FAKE_CLAUDE_*` are relative paths).
//
// Written to rust/crates/claudius-server/tests/fixtures/session_create_golden.json
// and replayed on the real binary by crates/claudius-server/tests/session_create.rs.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
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
const out = join(rustDir, "crates/claudius-server/tests/fixtures/session_create_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SESSION_CREATE_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-create-golden-")));
    try {
      const home = join(root, "home");
      const proc = join(root, "proc");
      mkdirSync(home);
      mkdirSync(proc);
      // db.ts reads its migrations from `process.cwd()/lib/server/db-migrations`.
      symlinkSync(join(repo, "lib"), join(proc, "lib"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: proc,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            SESSION_CREATE_GOLDEN_CHILD: root,
            SESSION_CREATE_GOLDEN_FAKE: fake,
            FAKE_CLAUDE_SCRIPT: "{}",
            FAKE_CLAUDE_ARGV: "argv.json",
            FAKE_CLAUDE_ENV: "env.json",
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
    writeFileSync(join(tmpdir(), "session-create-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "session-create-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} cases (SDK ${fixture.sdkVersion})`);
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.SESSION_CREATE_GOLDEN_CHILD;
const PROC_DIR = process.cwd();
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.SESSION_CREATE_GOLDEN_FAKE } });
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

const route = await import(join(repo, "app/api/sessions/route.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

const rejections = [];
process.on("unhandledRejection", (e) => {
  rejections.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.split(PROC_DIR).join("$PROC").split(ROOT_DIR).join("$ROOT");
const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
/** Waits until `f`'s text stops changing (the advisor clear writes it off
 * the create, so the next case must not race it). */
async function settleFile(f, quietMs = 400, maxMs = 5000) {
  let last = readText(f);
  let since = Date.now();
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(20);
    const now = readText(f);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
}

async function waitFor(pred, ms) {
  for (let t = 0; t < ms; t += 10) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

// The CLI arguments a create body decides. Every other argument the SDK
// builds is fixed for this host (or the SDK's own), and pinning those would
// make this fixture a second copy of the SDK-version golden.
const FLAGS = [
  "--model",
  "--agent",
  "--betas",
  "--max-turns",
  "--max-budget-usd",
  "--task-budget",
  "--fallback-model",
  "--permission-mode",
  "--disallowedTools",
  "--no-session-persistence",
  "--add-dir",
  "--project-config-root",
  "--resume",
  "--resume-session-at",
  "--session-id",
  "--settings",
];
// The one flag above the SDK passes as two arguments (`--settings <json>`).
const TWO_ARG = ["--settings"];
function flagsOf(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (TWO_ARG.includes(a)) out.push(a, argv[++i]);
    else if (FLAGS.includes(a) || FLAGS.some((f) => a.startsWith(`${f}=`))) out.push(a);
  }
  return out;
}

/** The `initialize` control request's prompt options. */
function initConfigOf(log) {
  const lines = (readText(log) ?? "").split("\n").filter((l) => l.trim());
  for (const line of lines) {
    let m;
    try {
      // The CLI may be mid-write: an incomplete last line isn't it.
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "control_request" && m.request?.subtype === "initialize") {
      const r = m.request;
      return {
        systemPrompt: r.systemPrompt ?? null,
        appendSystemPrompt: r.appendSystemPrompt ?? null,
        planModeInstructions: r.planModeInstructions ?? null,
      };
    }
  }
  return null;
}

const HOME = process.env.HOME;
const settingsFile = join(HOME, ".claude", "settings.json");

// ------------------------------- the cases -------------------------------

// `cwd: "$CASE"` is this case's own dir (a registered workspace).
const CASES = [
  { name: "typed options", body: { cwd: "$CASE", model: "claude-opus-4-5", maxTurns: 3, maxBudgetUsd: 1.5, taskBudgetTokens: 2048, agent: "builder" } },
  { name: "string numbers are dropped", body: { cwd: "$CASE", maxTurns: "5", maxBudgetUsd: "1.5", taskBudgetTokens: "2048" } },
  { name: "bool and null numbers are dropped", body: { cwd: "$CASE", maxTurns: true, maxBudgetUsd: null, taskBudgetTokens: [8] } },
  { name: "huge and negative numbers", body: { cwd: "$CASE", maxTurns: 1e21, maxBudgetUsd: -1, taskBudgetTokens: 0.5 } },
  { name: "number model", body: { cwd: "$CASE", model: 5 } },
  { name: "falsy number model", body: { cwd: "$CASE", model: 0 } },
  { name: "array model", body: { cwd: "$CASE", model: ["claude-opus-4-5", null, 5] } },
  { name: "object model", body: { cwd: "$CASE", model: { a: 1 } } },
  { name: "number agent and fallback", body: { cwd: "$CASE", agent: 7, fallbackModel: 7 } },
  { name: "fallback equal to the model", body: { cwd: "$CASE", model: "m", fallbackModel: "m" } },
  { name: "fallback equal as text", body: { cwd: "$CASE", model: 5, fallbackModel: "5" } },
  { name: "number plan instructions", body: { cwd: "$CASE", planModeInstructions: 5 } },
  { name: "blank plan instructions", body: { cwd: "$CASE", planModeInstructions: " \t\n" } },
  { name: "number prompt append", body: { cwd: "$CASE", systemPromptAppend: 5 } },
  { name: "padded prompt append", body: { cwd: "$CASE", systemPromptAppend: "  house style  " } },
  { name: "string additional directories", body: { cwd: "$CASE", additionalDirectories: "a\uD83D\uDE00b" } },
  { name: "number additional directories", body: { cwd: "$CASE", additionalDirectories: 5 } },
  { name: "object additional directories", body: { cwd: "$CASE", additionalDirectories: { a: "/tmp" } } },
  { name: "empty additional directories", body: { cwd: "$CASE", additionalDirectories: [] } },
  { name: "truthy sandbox strings", body: { cwd: "$CASE", sandboxEnabled: "yes", sandboxFilesystemDisabled: "x", sandboxNetworkAllowedDomains: "abc", sandboxNetworkStrictAllowlist: 0 } },
  { name: "sandbox with a strict empty list", body: { cwd: "$CASE", sandboxEnabled: 1, sandboxNetworkAllowedDomains: [], sandboxNetworkStrictAllowlist: "y" } },
  { name: "falsy sandbox", body: { cwd: "$CASE", sandboxEnabled: 0, sandboxFilesystemDisabled: true, sandboxNetworkStrictAllowlist: true } },
  { name: "persist session zero", body: { cwd: "$CASE", persistSession: 0, enable1mContext: "x" } },
  { name: "persist session false", body: { cwd: "$CASE", persistSession: false, enable1mContext: 0 } },
  { name: "restricted mode one", body: { cwd: "$CASE", restrictedMode: 1, permissionMode: "bypassPermissions" } },
  { name: "number permission mode", body: { cwd: "$CASE", permissionMode: 5, restrictedMode: "" } },
  { name: "number resume session at", body: { cwd: "$CASE", resumeSessionAt: 5 } },
  { name: "number cwd", body: { cwd: 5 } },
  { name: "blank cwd", body: { cwd: " " } },
  { name: "empty cwd", body: { cwd: "" } },
  { name: "object cwd", body: { cwd: { path: "/tmp" } } },
  { name: "unknown cwd", body: { cwd: "/nope/nowhere" } },
  // An object whose own `toString` isn't callable has no primitive form, so
  // every `${model}` throws instead of printing `[object Object]`.
  { name: "model without a primitive", body: { cwd: "$CASE", model: { toString: 1 } } },
  // `this.advisorModel && this.model?.includes("fable")` in `start()`.
  { name: "number model with an advisor", settings: '{\n  "advisorModel": "opus"\n}\n', body: { cwd: "$CASE", model: 5 } },
  { name: "array model with an advisor", settings: '{\n  "advisorModel": "opus"\n}\n', body: { cwd: "$CASE", model: ["fable"] } },
  { name: "other model keeps the advisor", settings: '{\n  "advisorModel": "opus"\n}\n', body: { cwd: "$CASE", model: "claude-opus-4-5" } },
];

// Every case dir is a registered workspace (so its `cwd` is trusted).
const dirs = CASES.map((_, i) => join(ROOT_DIR, "cases", String(i)));
for (const d of dirs) mkdirSync(d, { recursive: true });
const state = join(HOME, ".claude", ".claudius");
mkdirSync(state, { recursive: true });
writeFileSync(
  join(state, "workspaces.json"),
  `${JSON.stringify(
    {
      version: 1,
      workspaces: dirs.map((rootPath, i) => ({
        id: `wks_case${i}`,
        name: `case ${i}`,
        rootPath,
        icon: { kind: "letter", letter: "C", color: "#d97757" },
        createdAt: 1767225600000,
        updatedAt: 1767225600000,
      })),
    },
    null,
    2,
  )}\n`,
);

mkdirSync(dirname(settingsFile), { recursive: true });

const cases = [];
for (const [i, c] of CASES.entries()) {
  if (c.settings == null) rmSync(settingsFile, { force: true });
  else writeFileSync(settingsFile, c.settings);
  const body = { ...c.body };
  if (body.cwd === "$CASE") body.cwd = dirs[i];
  // The CLI's files sit next to its cwd, which is the session's cwd: clear
  // the ones a case that falls back to `process.cwd()` would otherwise find.
  for (const d of [...dirs, PROC_DIR]) {
    for (const f of ["argv.json", "env.json", "control.log"]) rmSync(join(d, f), { force: true });
  }
  const rejectedFrom = rejections.length;
  const res = await route.POST(
    new Request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  const parsed = JSON.parse(text);
  const id = typeof parsed.id === "string" ? parsed.id : null;
  const session = id ? sessionManager.get(id) : null;
  const cwd = session ? session.cwd : null;
  const argvFile = cwd ? join(cwd, "argv.json") : null;
  // This session's own argv, not a previous case's leftovers.
  const mine = () => (readText(argvFile) ?? "").includes(id);
  if (argvFile) await waitFor(mine, 10_000);
  const argv = argvFile && mine() ? JSON.parse(readText(argvFile)) : null;
  if (cwd) await waitFor(() => initConfigOf(join(cwd, "control.log")) !== null, 10_000);
  const events = [];
  if (session) {
    const unsubscribe = session.subscribe((e) => events.push(e));
    unsubscribe();
  }
  const env = cwd ? JSON.parse(readText(join(cwd, "env.json")) ?? "null") : null;
  await settleFile(settingsFile);
  let response = norm(text);
  if (id) response = response.split(id).join("$ID");
  cases.push({
    name: c.name,
    body: c.body,
    status: res.status,
    response: JSON.parse(response),
    flags: argv ? JSON.parse(norm(JSON.stringify(flagsOf(argv))).split(id ?? "$ID").join("$ID")) : null,
    initConfig: cwd ? initConfigOf(join(cwd, "control.log")) : null,
    restrictedEnv: env ? env.CLAUDE_CODE_RESTRICTED ?? null : null,
    ready: JSON.parse(
      norm(JSON.stringify(events.filter((e) => e.type === "ready" || e.type === "error")))
        .split(id ?? "$ID")
        .join("$ID"),
    ),
    rejections: rejections.slice(rejectedFrom),
    settings: c.settings ?? null,
    settingsAfter: readText(settingsFile),
  });
  if (id) await sessionManager.remove(id);
}
rmSync(settingsFile, { force: true });
if (!existsSync(ROOT_DIR)) throw new Error("temp root vanished");

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ sdkVersion, cases }));
process.exit(0);
