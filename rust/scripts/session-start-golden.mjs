#!/usr/bin/env node
// Golden fixture for the `start()` audit (S27), recorded from the TS sources:
//
//   node rust/scripts/session-start-golden.mjs   (node@22: session.ts needs
//                                                 better-sqlite3, which bun
//                                                 can't load; builds
//                                                 claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir and a resolve hook for the extensionless /
// `@/` imports, twice (two temp roots); both recordings must agree byte for
// byte. The hook maps session.ts's SDK import to a shim that calls the real
// `query()` with one option added, `pathToClaudeCodeExecutable` (the fake
// CLI, or the case's `bin`).
//
// Each case runs the real `new Session(options).start()` in its own project
// dir, with the case's user settings.json (`settings`: the file's text, or
// null for none), a session goal and `db_agents` rows seeded through the real
// DB helpers, and records:
// - `threw`: what `start()` rejected with, as the create route reports it
//   (`{ name, message }` of the error), or null;
// - `events`: every buffered event that isn't an `sdk` message, once the CLI
//   has read `initialize` (or, without a CLI, once start() returned or the
//   stream's error landed);
// - `replayed`: the resumed transcript's messages and their `at` (S27c: the
//   `dates` transcript stamps them in every form `Date.parse` reads, or not);
// - only for the cases that set them up (S27a): `queueAfter` (the session's
//   queue rows afterwards) and `sent` (the queued messages the session sent,
//   as it echoed them), `watching` (the JSONL watcher is up) and `resynced`
//   (the lines an external writer appended, as the watcher's resync
//   broadcast them, with their `at`);
// - `argv`: the CLI's arguments, `env`: what the CLI's environment adds to,
//   changes in or drops from the process env the session started with, and
//   `initialize`: the `initialize` control request line as written (its
//   request id as `$ID`), or null when no CLI ran;
// - `settingsAfter`: the user settings.json text once the CLI is up.
// Every path under the temp root reads `$ROOT`. `TZ` is pinned for the
// local-time `Date.parse` forms.
//
// Written to rust/crates/claudius-core/tests/fixtures/session_start_golden.json
// and replayed by crates/claudius-core/tests/session_start_golden.rs.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/session_start_golden.json");
// Offset-less date-times are local: `America/New_York` has DST.
const TZ = "America/New_York";

// ------------------------------- recording -------------------------------

if (!process.env.SESSION_START_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-start-golden-")));
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
            TZ,
            // Dropped from the CLI's env by the SDK.
            NODE_OPTIONS: "--no-warnings",
            SESSION_START_GOLDEN_CHILD: root,
            SESSION_START_GOLDEN_FAKE: fake,
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
    writeFileSync(join(tmpdir(), "session-start-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "session-start-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} starts (SDK ${fixture.sdkVersion}, TZ ${fixture.tz})`);
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.SESSION_START_GOLDEN_CHILD;
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  const bin = process.env.SESSION_START_BIN || process.env.SESSION_START_GOLDEN_FAKE;
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: bin } });
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
const { setSessionGoal } = await import(join(repo, "lib/server/sessions-db.ts"));
const { upsertDbAgent } = await import(join(repo, "lib/server/db-agents.ts"));
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const { enqueueTail, listQueue } = await import(join(repo, "lib/server/queued-messages-db.ts"));
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

// Non-ASCII without escapes in this file.
const cp = (n) => String.fromCodePoint(n);
const BOM = cp(0xfeff);
const NEL = cp(0x85);
const NBSP = cp(0xa0);

const norm = (s) => s.split(ROOT_DIR).join("$ROOT");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};

// ------------------------------- the world -------------------------------

const HOME = process.env.HOME;
const settingsFile = join(HOME, ".claude", "settings.json");
mkdirSync(dirname(settingsFile), { recursive: true });

// A registered root with a git worktree: a session in the worktree loads its
// project config from the root (`projectConfigRoot`).
const gitRoot = join(ROOT_DIR, "repo");
const gitWorktree = join(ROOT_DIR, "repo-wt");
mkdirSync(gitRoot);
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], {
    cwd: gitRoot,
    stdio: "pipe",
  });
git("init", "-q");
git("commit", "-q", "--allow-empty", "-m", "init");
git("worktree", "add", "-q", "-b", "wt", gitWorktree);
const WORKSPACES = {
  version: 1,
  workspaces: [
    {
      id: "wks_golden",
      name: "golden",
      rootPath: gitRoot,
      icon: { kind: "letter", letter: "G", color: "#d97757" },
      createdAt: 1767225600000,
      updatedAt: 1767225600000,
    },
  ],
};
mkdirSync(join(HOME, ".claude", ".claudius"), { recursive: true });
writeFileSync(join(HOME, ".claude", ".claudius", "workspaces.json"), `${JSON.stringify(WORKSPACES, null, 2)}\n`);

// A resumable transcript (the replay itself is S13's and S23's golden).
const RESUME_ID = "5f1c9a2e-7b3d-4c8e-9f0a-1b2c3d4e5f60";
const tline = (o) => JSON.stringify({ sessionId: RESUME_ID, ...o });
const TRANSCRIPT_LINES = [
  tline({
    type: "user",
    uuid: "u-1",
    parentUuid: null,
    timestamp: "2026-01-02T03:04:05.000Z",
    message: { role: "user", content: "hello" },
  }),
  tline({
    type: "assistant",
    uuid: "a-1",
    parentUuid: "u-1",
    timestamp: "2026-01-02T03:04:06.000Z",
    message: { role: "assistant", id: "msg_a1", type: "message", content: [{ type: "text", text: "hi INVALID" }] },
  }),
];
// A chain of user / assistant records, one per timestamp (S27c), with
// uuids `<prefix>-01`, `<prefix>-02`, ...; `undefined` writes no timestamp.
// Each `at` is `Date.parse(timestamp)` when that is a number, else the
// previous `at` + 1.
const DATE_STAMPS = [
  "2026-01-02T03:04:05.000Z",
  undefined,
  // Date-only: UTC midnight.
  "2026-01-02",
  "2026-01",
  // A date-time without a zone: local time.
  "2026-01-02T03:04:05",
  "2026-01-02T03:04",
  // New York's DST gap and fold.
  "2026-03-08T02:30:00",
  "2026-11-01T01:30:00",
  // Not a date, or not a string.
  "not a date",
  1767323045000,
  "",
  null,
  // V8's legacy fallback.
  "Jan 2 2026 03:04:05",
  "2026/01/02",
  "2026-01-01 00:00Z",
  "2026-1-01",
  " 2026-01-02",
  "Fri, 02 Jan 2026 03:04:05 GMT",
  "Thu Jan 01 2026 22:04:05 GMT-0500 (Eastern Standard Time)",
  "12/31/2025 11:59 PM",
  "2026-01-02 03:04:05.678 +05:30",
  // Other ES forms.
  "2026-01-02t03:04:05z",
  "2026-01-02T03:04:05+0530",
  "+002026-01-02T03:04:05.123456Z",
  // Out of range.
  "+275760-09-13T00:00:00.001Z",
  "Sat Sep 13 275760 00:00:00 GMT+0000",
];
const dateLines = (prefix, sessionId) =>
  DATE_STAMPS.map((timestamp, i) => {
    const uuid = `${prefix}-${String(i + 1).padStart(2, "0")}`;
    const parentUuid = i === 0 ? null : `${prefix}-${String(i).padStart(2, "0")}`;
    const message =
      i % 2 === 0
        ? { role: "user", content: `${prefix} ${i + 1}` }
        : { role: "assistant", id: `msg_${prefix}${i + 1}`, type: "message", content: [{ type: "text", text: `${prefix} ${i + 1}` }] };
    return JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      uuid,
      parentUuid,
      sessionId,
      ...(timestamp === undefined ? {} : { timestamp }),
      message,
    });
  });
const REPLAYED_UUIDS = new Set(["u-1", "a-1", ...dateLines("d", RESUME_ID).map((l) => JSON.parse(l).uuid)]);
// The transcript as bytes: "INVALID" is a byte that isn't UTF-8 (the SDK
// decodes the file lossily) or, in the readable one, plain text. `dates` is
// the timestamp chain.
const transcriptBytes = (kind) =>
  kind === "dates"
    ? Buffer.from(dateLines("d", RESUME_ID).map((l) => `${l}\n`).join(""))
    : Buffer.concat(
        TRANSCRIPT_LINES.map((l) => {
          const [a, b] = l.split("INVALID");
          if (b === undefined) return Buffer.from(`${l}\n`);
          return Buffer.concat([Buffer.from(a), kind === "invalid utf-8" ? Buffer.from([0xff]) : Buffer.from("there"), Buffer.from(`${b}\n`)]);
        }),
      );
// A queued row's `createdAtMs`, pinned.
const QUEUED_AT = 1767225600000;
// A goal's `setAt`, pinned so the recordings agree.
const GOAL_SET_AT = 1767225600000;

// -------------------------------- cases --------------------------------

const S = (o) => JSON.stringify(o);
const LONG_NAME = "x".repeat(300);

// [name, options, extras]; extras: settings (file text), goal, dbAgents
// ([name, definition]), cwd (a kind, see `cwdFor`), bin, resume
// ("readable" | "unreadable" | "invalid utf-8" | "dates"), and (S27a) id
// (the session id), queued ([uuid, text] rows seeded into the session's
// queue), projects (create the CLI's project dir first, so the JSONL watcher
// can start) and external (then append the `e-` timestamp chain to the
// session's transcript, as `claude --resume <id>` in a terminal would).
const CASES = [
  ["bare", {}],
  ["model", { model: "claude-sonnet-4-5" }],
  ["model empty", { model: "" }],
  ["fallback", { model: "claude-opus-4-5", fallbackModel: "claude-sonnet-4-5" }],
  ["fallback alone", { fallbackModel: "claude-haiku-4-5" }],
  ["fallback empty", { fallbackModel: "" }],
  ["fallback equals model", { model: "claude-opus-4-5", fallbackModel: "claude-opus-4-5" }],
  ["fallback equals empty model", { model: "", fallbackModel: "" }],
  ["agent", { agent: "reviewer" }],
  ["agent empty", { agent: "" }],
  ["budgets", { maxBudgetUsd: 2.5, taskBudgetTokens: 1000, maxTurns: 7 }],
  ["budgets zero", { maxBudgetUsd: 0, taskBudgetTokens: 0, maxTurns: 0 }],
  ["budgets negative", { maxBudgetUsd: -1, taskBudgetTokens: -5, maxTurns: -3 }],
  ["budgets fractional", { maxBudgetUsd: 0.000001, taskBudgetTokens: 1.5, maxTurns: 2.5 }],
  ["budgets huge", { maxBudgetUsd: 1e21, taskBudgetTokens: 1e21, maxTurns: 1e10 }],
  ["budgets integral floats", { maxBudgetUsd: 3, taskBudgetTokens: 2000, maxTurns: 1 }],
  ["sandbox", { sandboxEnabled: true }],
  [
    "sandbox full",
    {
      sandboxEnabled: true,
      sandboxFilesystemDisabled: true,
      sandboxNetworkAllowedDomains: ["a.example.com", "b.example.org"],
      sandboxNetworkStrictAllowlist: true,
    },
  ],
  ["sandbox strict only", { sandboxEnabled: true, sandboxNetworkStrictAllowlist: true, sandboxNetworkAllowedDomains: [] }],
  ["sandbox domains only", { sandboxEnabled: true, sandboxNetworkAllowedDomains: ["c.example.net"] }],
  [
    "sandbox off",
    { sandboxEnabled: false, sandboxFilesystemDisabled: true, sandboxNetworkStrictAllowlist: true, sandboxNetworkAllowedDomains: ["x"] },
  ],
  ["sandbox with settings", { sandboxEnabled: true }, { settings: S({ includeCoAuthoredBy: true, advisorModel: "opus" }) }],
  ["betas and ephemeral", { enable1mContext: true, persistSession: false }],
  ["betas off, persisted", { enable1mContext: false, persistSession: true }],
  ["additional dirs", { additionalDirectories: ["/x/a", "/x/b c", "-dash"] }],
  ["additional dirs empty", { additionalDirectories: [] }],
  ["system prompt append", { systemPromptAppend: "  house style  " }],
  ["system prompt append BOM only", { systemPromptAppend: `${BOM} ${BOM}` }],
  ["system prompt append NEL edged", { systemPromptAppend: `${NEL}rule${NEL}` }],
  ["system prompt append NBSP edged", { systemPromptAppend: `${NBSP}rule${NBSP}` }],
  ["system prompt append whitespace", { systemPromptAppend: " \n\t " }],
  ["plan instructions", { planModeInstructions: "  plan carefully  " }],
  ["plan instructions blank", { planModeInstructions: "  \n " }],
  ["plan instructions BOM only", { planModeInstructions: BOM }],
  ["plan instructions NEL only", { planModeInstructions: NEL }],
  ["plan instructions empty", { planModeInstructions: "" }],
  ["mode plan", { permissionMode: "plan" }],
  ["mode acceptEdits", { permissionMode: "acceptEdits" }],
  ["mode bypass", { permissionMode: "bypassPermissions" }],
  ["mode empty", { permissionMode: "" }],
  ["restricted", { restrictedMode: true }],
  ["restricted bypass", { restrictedMode: true, permissionMode: "bypassPermissions" }],
  ["restricted off", { restrictedMode: false, permissionMode: "bypassPermissions" }],
  ["goal", {}, { goal: "Ship the release notes" }],
  ["goal and append", { systemPromptAppend: "Be terse." }, { goal: "  Fix the flaky test  " }],
  [
    "forwarded settings",
    {},
    {
      settings: S({
        includeCoAuthoredBy: false,
        advisorModel: "opus",
        workflowSizeGuideline: "small",
        crossSessionInbound: "hold",
      }),
    },
  ],
  [
    "forwarded settings, wrong types",
    {},
    { settings: S({ includeCoAuthoredBy: "yes", advisorModel: 5, workflowSizeGuideline: 3, crossSessionInbound: true }) },
  ],
  ["workflow unrestricted", {}, { settings: S({ workflowSizeGuideline: "unrestricted" }) }],
  ["workflow medium", {}, { settings: S({ workflowSizeGuideline: "medium" }) }],
  ["workflow large", {}, { settings: S({ workflowSizeGuideline: "large" }) }],
  ["workflow unlimited", {}, { settings: S({ workflowSizeGuideline: "unlimited" }) }],
  ["workflow upper case", {}, { settings: S({ workflowSizeGuideline: "SMALL" }) }],
  ["inbound accept", {}, { settings: S({ crossSessionInbound: "accept" }) }],
  ["inbound refuse", {}, { settings: S({ crossSessionInbound: "refuse" }) }],
  ["inbound unknown", {}, { settings: S({ crossSessionInbound: "allow" }) }],
  ["inbound false", {}, { settings: S({ crossSessionInbound: false }) }],
  ["advisor empty", {}, { settings: S({ advisorModel: "" }) }],
  ["co-authored true", {}, { settings: S({ includeCoAuthoredBy: true }) }],
  ["suggestions off", {}, { settings: S({ promptSuggestionEnabled: false }) }],
  ["suggestions legacy off", {}, { settings: S({ promptSuggestions: false }) }],
  ["suggestions null falls back", {}, { settings: S({ promptSuggestionEnabled: null, promptSuggestions: false }) }],
  ["suggestions on beats legacy", {}, { settings: S({ promptSuggestionEnabled: true, promptSuggestions: false }) }],
  ["suggestions zero", {}, { settings: S({ promptSuggestionEnabled: 0 }) }],
  ["suggestions string false", {}, { settings: S({ promptSuggestionEnabled: "false" }) }],
  [
    "fable clears advisor",
    { model: "claude-fable-5" },
    { settings: '{\n  "a": 1,\n  "advisorModel": "opus",\n  "b": 2.0,\n  "10": "x",\n  "2": "y",\n  "c": 1e2\n}\n' },
  ],
  ["fable keeps empty advisor", { model: "claude-fable-5" }, { settings: S({ advisorModel: "", z: 1 }) }],
  ["fable without advisor", { model: "claude-fable-5" }, { settings: S({ includeCoAuthoredBy: true }) }],
  ["fable advisor non-string", { model: "claude-fable-5" }, { settings: S({ advisorModel: ["opus"] }) }],
  ["not fable keeps advisor", { model: "claude-opus-4-5" }, { settings: S({ advisorModel: "opus" }) }],
  ["malformed settings", { model: "claude-fable-5" }, { settings: '{"advisorModel": "opus",' }],
  ["settings array", {}, { settings: '["includeCoAuthoredBy"]' }],
  ["worktree cwd", {}, { cwd: "worktree" }],
  ["root cwd", {}, { cwd: "root" }],
  ["db agents", {}, { dbAgents: [["reviewer", { description: "Reviews diffs", prompt: "You review diffs." }]] }],
  ["cwd missing", {}, { cwd: "missing" }],
  ["cwd is a file", {}, { cwd: "file" }],
  ["cwd relative", {}, { cwd: "relative" }],
  ["cwd under a file", {}, { cwd: "enotdir" }],
  ["cwd name too long", {}, { cwd: "toolong" }],
  ["binary missing", {}, { bin: "/nonexistent/claude" }],
  ["resume", { resume: RESUME_ID }, { resume: "readable" }],
  ["resume unreadable", { resume: RESUME_ID }, { resume: "unreadable" }],
  ["resume invalid utf-8", { resume: RESUME_ID }, { resume: "invalid utf-8" }],
  // S27a: start()'s tail runs after a CLI that can't be launched.
  [
    "binary missing, watched",
    {},
    { id: "3a9e1f20-6c4b-4d7a-8e2f-5b1c0d9e8f7a", bin: "/nonexistent/claude", projects: true, external: true },
  ],
  [
    "binary missing, queued",
    {},
    {
      id: "8b2d4f61-0e3c-4a5b-9c7d-1e2f3a4b5c6d",
      bin: "/nonexistent/claude",
      queued: [
        ["9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a", "first"],
        ["1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "second"],
      ],
    },
  ],
  ["binary missing, auto mode", { permissionMode: "auto", model: "claude-haiku-4-5" }, { bin: "/nonexistent/claude" }],
  // S27c: the replay's `at` through `Date.parse`.
  ["resume dates", { resume: RESUME_ID }, { resume: "dates" }],
];

function cwdFor(i, kind) {
  const base = join(ROOT_DIR, "cases", String(i));
  switch (kind) {
    case undefined:
      mkdirSync(base, { recursive: true });
      return base;
    case "worktree":
      return gitWorktree;
    case "root":
      return gitRoot;
    case "missing":
      return base;
    case "file":
      mkdirSync(dirname(base), { recursive: true });
      writeFileSync(base, "not a dir");
      return base;
    case "relative":
      return "rel/dir";
    case "enotdir":
      mkdirSync(dirname(base), { recursive: true });
      writeFileSync(base, "not a dir");
      return join(base, "sub");
    case "toolong":
      mkdirSync(base, { recursive: true });
      return join(base, LONG_NAME);
    default:
      throw new Error(`cwd kind ${kind}`);
  }
}

async function waitFor(pred, ms) {
  for (let t = 0; t < ms; t += 10) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

const initializeLine = (log) =>
  (readText(log) ?? "")
    .split("\n")
    .find((l) => l.includes('"subtype":"initialize"'))
    ?.replace(/"request_id":"[^"]*"/, '"request_id":"$ID"') ?? null;

function envDelta(base, seen) {
  const added = {};
  for (const k of Object.keys(seen).sort()) if (base[k] !== seen[k]) added[k] = seen[k];
  const removed = Object.keys(base)
    .filter((k) => base[k] !== undefined && !(k in seen))
    .sort();
  return { added, removed };
}

const cases = [];
for (const [i, [name, options, extras = {}]] of CASES.entries()) {
  const id = extras.id ?? options.resume ?? `s27-case-${i}`;
  const cwd = cwdFor(i, extras.cwd);
  const dir = join(ROOT_DIR, "io", String(i));
  mkdirSync(dir, { recursive: true });
  const files = { argv: join(dir, "argv.json"), env: join(dir, "env.json"), log: join(dir, "stdin.log") };
  if (extras.settings == null) rmSync(settingsFile, { force: true });
  else writeFileSync(settingsFile, extras.settings);
  if (extras.goal) {
    await setSessionGoal(cwd, id, extras.goal);
    (await openDb(cwd)).prepare("UPDATE sessions SET goal_set_at = ? WHERE id = ?").run(GOAL_SET_AT, id);
  }
  for (const [n, def] of extras.dbAgents ?? []) await upsertDbAgent(cwd, n, def);
  for (const [uuid, text] of extras.queued ?? []) {
    await enqueueTail(cwd, { sessionId: id, uuid, text });
    (await openDb(cwd)).prepare("UPDATE queued_messages SET created_at_ms = ? WHERE uuid = ?").run(QUEUED_AT, uuid);
  }
  const projects = join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  if (extras.projects) {
    mkdirSync(projects, { recursive: true });
    // TS watches `projectRoot(cwd)`, under HOME; the CLI and the SDK's
    // reader use CLAUDE_CONFIG_DIR. Link the two, as an account profile's
    // `projects/` link does.
    const watched = join(HOME, ".claude", "projects", basename(projects));
    mkdirSync(dirname(watched), { recursive: true });
    symlinkSync(projects, watched);
  }
  const transcript = extras.resume ? transcriptBytes(extras.resume) : null;
  if (transcript) {
    mkdirSync(projects, { recursive: true });
    const file = join(projects, `${RESUME_ID}.jsonl`);
    writeFileSync(file, transcript);
    if (extras.resume === "unreadable") chmodSync(file, 0o000);
  }
  process.env.FAKE_CLAUDE_ARGV = files.argv;
  process.env.FAKE_CLAUDE_ENV = files.env;
  process.env.FAKE_CLAUDE_LOG = files.log;
  if (extras.bin) process.env.SESSION_START_BIN = extras.bin;
  else delete process.env.SESSION_START_BIN;
  // The SDK writes its version into `process.env` on every query().
  delete process.env.CLAUDE_AGENT_SDK_VERSION;
  const base = { ...process.env };

  const s = new Session({ id, cwd, ...options });
  let threw = null;
  try {
    await s.start();
  } catch (e) {
    // The create route's catch: `{ error: message, name }`.
    threw = e instanceof Error ? { name: e.name, message: e.message } : { name: "Error", message: String(e) };
  }
  // startJsonlWatcher() sets it synchronously, or leaves it null when the
  // directory is missing.
  const watching = s.jsonlWatcher !== null;
  const events = () => s.buffer.filter((e) => e.type !== "sdk");
  if (extras.bin) {
    await waitFor(() => events().some((e) => e.type === "error"), 10_000);
  } else if (threw === null && existsSync(cwd) && s.query) {
    if (!(await waitFor(() => initializeLine(files.log) !== null, 10_000))) throw new Error(`${name}: no initialize`);
  }
  // The advisor notice goes out on `setImmediate`, the settings write is
  // fire-and-forget.
  await sleep(100);
  const externalLines = extras.external ? dateLines("e", id) : [];
  const resyncedEvents = () => s.buffer.filter((e) => e.type === "sdk" && e.message?.uuid?.startsWith("e-"));
  if (extras.external) {
    const file = join(projects, `${id}.jsonl`);
    writeFileSync(file, externalLines.map((l) => `${l}\n`).join(""));
    // FSEvents may not be streaming yet when the first write lands (the
    // watch starts off the main thread): touch the file until the resync
    // has broadcast every line. A resync skips uuids already broadcast.
    for (let t = 0; resyncedEvents().length < externalLines.length; t += 1) {
      if (t >= 40) throw new Error(`${name}: no resync`);
      await sleep(500);
      if (resyncedEvents().length < externalLines.length) utimesSync(file, new Date(), new Date());
    }
  }
  const argv = readText(files.argv);
  const env = readText(files.env);
  // What a late subscriber gets of `ready`: the buffered one, plus the
  // re-emit while there's a query (both synchronous).
  const lateReady = [];
  s.subscribe((e) => {
    if (e.type === "ready") lateReady.push(e);
  })();
  cases.push({
    name,
    id,
    options,
    settings: extras.settings ?? null,
    goal: extras.goal ?? null,
    dbAgents: (extras.dbAgents ?? []).map(([n, def]) => ({ name: n, definition: def })),
    cwd: extras.cwd ?? null,
    bin: extras.bin ?? null,
    resume: extras.resume ?? null,
    transcriptHex: transcript === null ? null : transcript.toString("hex"),
    ...(extras.queued ? { queued: extras.queued } : {}),
    ...(extras.projects ? { projects: true } : {}),
    ...(extras.external ? { externalHex: Buffer.from(externalLines.map((l) => `${l}\n`).join("")).toString("hex") } : {}),
    threw,
    // The replayed transcript messages and their `at`.
    replayed: s.buffer.filter((e) => e.type === "sdk" && REPLAYED_UUIDS.has(e.message?.uuid)).map((e) => ({ at: e.at ?? null, message: e.message })),
    events: JSON.parse(norm(JSON.stringify(events()))),
    lateReady,
    argv: argv === null ? null : JSON.parse(norm(argv)),
    env: env === null ? null : JSON.parse(norm(JSON.stringify(envDelta(base, JSON.parse(env))))),
    initialize: (() => {
      const l = initializeLine(files.log);
      return l === null ? null : norm(l);
    })(),
    settingsAfter: readText(settingsFile),
    ...(extras.queued
      ? {
          queueAfter: (await listQueue(cwd, id)).map((r) => ({ uuid: r.uuid, text: r.text, createdAtMs: r.createdAtMs })),
          sent: s.buffer
            .filter((e) => e.type === "sdk" && extras.queued.some(([uuid]) => uuid === e.message?.uuid))
            .map((e) => e.message),
        }
      : {}),
    ...(extras.projects ? { watching } : {}),
    ...(extras.external ? { resynced: resyncedEvents().map((e) => ({ at: e.at ?? null, message: e.message })) } : {}),
  });
  await s.end();
}
rmSync(settingsFile, { force: true });

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(
  join(ROOT_DIR, "out.json"),
  JSON.stringify({ sdkVersion, tz: process.env.TZ, workspaces: JSON.parse(norm(JSON.stringify(WORKSPACES))), cases }),
);
process.exit(0);
