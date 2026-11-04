#!/usr/bin/env node
// Golden fixture for account pinning (S30), recorded from the TS sources:
//
//   node rust/scripts/session-account-golden.mjs   (node@22: session.ts needs
//                                                  better-sqlite3, which bun
//                                                  can't load; builds
//                                                  claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME
// (`$ROOT/home`) and CLAUDE_CONFIG_DIR (`$ROOT/config`) in a temp root and a
// resolve hook for the `@/` and extensionless imports, twice (two temp
// roots); both recordings must agree byte for byte. The hook maps
// session.ts's SDK import to a shim that calls the real `query()` with
// `pathToClaudeCodeExecutable` set to the fake CLI. Nothing outside the temp
// root is read or written, nothing goes to the network, and every token is
// fake. Every path under the root reads `$ROOT`.
//
// Records:
// - `route`: the real `GET` / `POST` of app/api/sessions/[id]/account/route.ts
//   on sessions the real `sessionManager.create({ cwd: "$ROOT/project",
//   resume: id })` started against the fake CLI, in groups that share the
//   process (and the project database) but start with no account store and
//   no profiles dir. Steps: `store` (accounts.json's text, `$DIR` for a
//   directory there, null for none), `state` (the session row's state
//   text), `block` (a file where that profile's config dir goes), `create`
//   (start the group's session), `req` (`method`, `id` (null: the group's
//   session), optional `body` text; `got` is the status, content type and
//   body text, or `threw` with the message). After a `create` or `req`:
//   `live` (the id answers `sessionManager.get`), `state` (the row's state
//   text, null without one), `ready` (the live session's last `ready`
//   event's `account`, or null) and `env` (the account keys of the
//   environment the last started CLI got, or null when the step started
//   none).
// - `rotate`: the real `new Session({ cwd }).start()` with the fake CLI
//   running `script` (`on_init` steps: rate-limit walls, other messages,
//   `$wait_file` gates the recorder opens after writing `gates`' store
//   text), on the store `store`: the order of the assistant texts and
//   `account_auto_rotated` events in the buffer (`seq`), the store text and
//   the session's pin afterwards.
// - `rateLimit`: `isRateLimitHitSdkMessage(message)` for each message, and
//   `USAGE_LIMIT_ERROR_PREFIXES`.
// - `listing`: `resolveSessionAccounts(pairs)` (its entries in order and
//   `accountsConfigured`) and `lookupSessionAccount` for each pair, over
//   project databases seeded with `sessions` rows (`[id, state]`; a string
//   instead of rows writes those bytes as the database file, and `{sql}`
//   runs that SQL on a new database file), a workspaces store and an
//   account store.
//
// Written to rust/crates/claudius-core/tests/fixtures/session_account_golden.json
// and replayed by crates/claudius-core/tests/session_account_golden.rs
// (rotate, rateLimit, listing) and crates/claudius-server/tests/session_account.rs
// (route, on the real binary).
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/session_account_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SESSION_ACCOUNT_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-account-golden-")));
    try {
      for (const d of ["home", "config", "project"]) mkdirSync(join(root, d));
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
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            NODE_OPTIONS: "--no-warnings",
            SESSION_ACCOUNT_GOLDEN_CHILD: root,
            SESSION_ACCOUNT_GOLDEN_FAKE: fake,
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
    writeFileSync(join(tmpdir(), "session-account-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "session-account-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const reqs = fixture.route.reduce((n, g) => n + g.steps.filter((s) => s.op === "req").length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.route.length} route groups (${reqs} requests), ` +
      `${fixture.rotate.length} rotate scenarios, ${fixture.rateLimit.messages.length} messages, ` +
      `${fixture.listing.length} listings (SDK ${fixture.sdkVersion}; stable)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.SESSION_ACCOUNT_GOLDEN_CHILD;
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.SESSION_ACCOUNT_GOLDEN_FAKE } });
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

const mod = (p) => import(pathToFileURL(join(repo, p)).href);
const route = await mod("app/api/sessions/[id]/account/route.ts");
const { sessionManager } = await mod("lib/server/session-manager.ts");
const { Session, isRateLimitHitSdkMessage } = await mod("lib/server/session.ts");
const { USAGE_LIMIT_ERROR_PREFIXES } = await mod("lib/shared/rate-limit-prefixes.ts");
const { resolveSessionAccounts, lookupSessionAccount } = await mod("lib/server/session-accounts.ts");
const { openDb } = await mod("lib/server/db.ts");
const { default: Database } = await import("better-sqlite3");
const { encodeProjectDir } = await mod("lib/server/auto-memory.ts");
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

// Non-ASCII without escapes in this file.
const cp = (...n) => String.fromCodePoint(...n);

const norm = (s) => s.split(ROOT).join("$ROOT");
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
const STORE_DIR = join(HOME, ".claude", ".claudius");
const ACCOUNTS_FILE = join(STORE_DIR, "accounts.json");
const PROFILES_DIR = join(STORE_DIR, "profiles");
const WORKSPACES_FILE = join(STORE_DIR, "workspaces.json");
const PROJECT = join(ROOT, "project");
mkdirSync(STORE_DIR, { recursive: true });

// The CLI's env and stdin, as the fake writes them.
const ENV_FILE = join(ROOT, "cli-env.json");
const LOG_FILE = join(ROOT, "cli-stdin.log");
process.env.FAKE_CLAUDE_ENV = ENV_FILE;
process.env.FAKE_CLAUDE_LOG = LOG_FILE;

function writeStore(text) {
  rmSync(ACCOUNTS_FILE, { recursive: true, force: true });
  if (text === "$DIR") mkdirSync(ACCOUNTS_FILE);
  else if (text !== null) writeFileSync(ACCOUNTS_FILE, text);
}

/** The session row's `state` text (null without a row or a database). */
async function stateOf(cwd, id) {
  try {
    const row = (await openDb(cwd, "readonly")).prepare("SELECT state FROM sessions WHERE id = ?").get(id);
    return row ? row.state : null;
  } catch {
    return null;
  }
}

async function seedState(cwd, id, state) {
  (await openDb(cwd))
    .prepare(
      "INSERT INTO sessions(id, cwd, state, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state",
    )
    .run(id, cwd, state, 1767225600000, 1767225600000, 1767225600000);
}

// ------------------------------- profiles -------------------------------

const C0 = "2026-01-01T00:00:00.000Z";
const PA = { id: "acc_alpha", label: "Alpha", kind: "api-key", secret: "sk-ant-api03-FAKE-s30r-alpha", createdAt: C0 };
const PB = {
  id: "acc_bravo",
  label: "Bravo",
  kind: "oauth-token",
  secret: "sk-ant-oat01-FAKE-s30r-bravo",
  createdAt: C0,
  accountUuid: "11111111-2222-4333-8444-555555555555",
  emailAddress: "bravo@example.com",
  organizationUuid: "66666666-7777-4888-9999-000000000000",
};
const PC = { id: "acc_charlie", label: "Charlie", kind: "oauth-token", secret: "sk-ant-oat01-FAKE-s30r-charlie", createdAt: C0 };
const PBR = {
  id: "acc_bedrock",
  label: "Bedrock",
  kind: "bedrock",
  secret: "FAKE-aws-secret-s30r",
  createdAt: C0,
  bedrock: { auth: "access-keys", region: "us-west-2", accessKeyId: "AKIAFAKES30R" },
};
const STORE = (profiles, active, extra = {}) =>
  JSON.stringify({ profiles, activeProfileId: active, autoRotateOnRateLimit: false, ...extra }, null, 2);
const ROT = (profiles, active, on = true) => STORE(profiles, active, { autoRotateOnRateLimit: on });

// ---------------------------------- route ----------------------------------

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CONFIG_DIR",
];

const id = (n) => `5e300000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GET = (o = {}) => ({ op: "req", method: "GET", id: null, ...o });
const POST = (o = {}) => ({ op: "req", method: "POST", id: null, ...o });
const CREATE = { op: "create" };

// [name, steps]; each group's session id is `id(i)`.
const ROUTE = [
  ["no store", [CREATE, GET(), POST(), GET()]],
  ["active api-key, move to the same", [{ op: "store", text: STORE([PA, PB], "acc_alpha") }, CREATE, GET(), POST(), GET()]],
  [
    "switched, then moved",
    [
      { op: "store", text: STORE([PA, PB], "acc_alpha") },
      CREATE,
      { op: "store", text: STORE([PA, PB], "acc_bravo") },
      // The drift isn't refreshed without `PATCH /api/accounts`.
      GET(),
      POST(),
      GET(),
    ],
  ],
  [
    "pinned to another at start",
    [
      { op: "store", text: STORE([PA, PB], "acc_alpha") },
      { op: "state", text: '{"accountProfileId":"acc_bravo","x":[1.0,1e21]}' },
      CREATE,
      GET(),
      POST({ body: "not json" }),
      GET(),
    ],
  ],
  [
    "store removed after start",
    [{ op: "store", text: STORE([PA], "acc_alpha") }, CREATE, { op: "store", text: null }, GET(), POST(), GET()],
  ],
  [
    "no active profile",
    [{ op: "store", text: STORE([PA, PB], "acc_alpha") }, CREATE, { op: "store", text: STORE([PA, PB], null) }, POST(), GET()],
  ],
  [
    "store malformed at the move",
    [{ op: "store", text: STORE([PA], "acc_alpha") }, CREATE, { op: "store", text: "{" }, POST(), GET()],
  ],
  [
    "store a directory at the move",
    [{ op: "store", text: STORE([PA], "acc_alpha") }, CREATE, { op: "store", text: "$DIR" }, POST(), GET()],
  ],
  ["store null at the move", [{ op: "store", text: STORE([PA], "acc_alpha") }, CREATE, { op: "store", text: "null" }, POST()]],
  [
    "the rebuild fails",
    [
      { op: "store", text: STORE([PA, PB], "acc_alpha") },
      CREATE,
      { op: "store", text: STORE([PA, PB], "acc_bravo") },
      { op: "block", profile: "acc_bravo" },
      POST(),
      GET(),
      POST(),
    ],
  ],
  [
    "pinned profile deleted",
    [
      { op: "store", text: STORE([PA, PB], "acc_alpha") },
      { op: "state", text: '{"accountProfileId":"acc_bravo"}' },
      CREATE,
      { op: "store", text: STORE([PA], "acc_alpha") },
      GET(),
      POST(),
      GET(),
    ],
  ],
  [
    "empty label",
    [{ op: "store", text: STORE([{ ...PA, id: "acc_nolabel", label: "" }, PB], "acc_bravo") }, CREATE, GET(), { op: "store", text: STORE([{ ...PA, id: "acc_nolabel", label: "" }, PB], "acc_nolabel") }, POST(), GET()],
  ],
  [
    "unicode label",
    [
      { op: "store", text: STORE([PA], "acc_alpha") },
      CREATE,
      { op: "store", text: STORE([PA, { ...PC, label: `Caf${cp(0xe9)} ${cp(0x1f600)} "q" \\ ${cp(0x2028)}` }], "acc_charlie") },
      POST({ body: '{"accountId":"acc_alpha"}' }),
      GET(),
    ],
  ],
  [
    "bedrock",
    [{ op: "store", text: STORE([PA], "acc_alpha") }, CREATE, { op: "store", text: STORE([PA, PBR], "acc_bedrock") }, POST(), GET()],
  ],
  [
    "not live",
    [
      { op: "store", text: STORE([PA, PB], "acc_bravo") },
      { op: "state", text: '{"accountProfileId":"acc_alpha"}' },
      GET(),
      POST(),
      GET({ id: "not-a-uuid" }),
      POST({ id: "not-a-uuid" }),
    ],
  ],
];

async function routeCall(method, sid, body) {
  const init = { method };
  if (method === "POST" && body !== undefined) {
    init.body = body;
    init.headers = { "content-type": "application/json" };
  }
  const req = new Request(`http://127.0.0.1/api/sessions/${encodeURIComponent(sid)}/account`, init);
  try {
    const res = await route[method](req, { params: Promise.resolve({ id: sid }) });
    return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  } catch (e) {
    return { threw: norm(e instanceof Error ? e.message : String(e)) };
  }
}

/** The account keys of the env the next CLI writes, once it has. */
async function cliEnv(started) {
  if (!started) return null;
  // The fake writes the file in place: wait for all of it.
  const parsed = () => {
    try {
      return JSON.parse(readText(ENV_FILE));
    } catch {
      return null;
    }
  };
  if (!(await waitFor(() => parsed() !== null, 10_000))) throw new Error("no CLI env");
  const env = parsed();
  const res = {};
  for (const k of ENV_KEYS) if (k in env) res[k] = norm(env[k]);
  return res;
}

const routeGroups = [];
for (const [i, [name, steps]] of ROUTE.entries()) {
  const sid = id(i + 1);
  writeStore(null);
  rmSync(PROFILES_DIR, { recursive: true, force: true });
  const recorded = [];
  for (const step of steps) {
    const rec = { ...step };
    let started = false;
    rmSync(ENV_FILE, { force: true });
    switch (step.op) {
      case "store":
        writeStore(step.text);
        break;
      case "state":
        await seedState(PROJECT, sid, step.text);
        break;
      case "block":
        mkdirSync(PROFILES_DIR, { recursive: true });
        rmSync(join(PROFILES_DIR, step.profile), { recursive: true, force: true });
        writeFileSync(join(PROFILES_DIR, step.profile), "not a dir");
        break;
      case "create":
        await sessionManager.create({ cwd: PROJECT, resume: sid });
        started = true;
        break;
      case "req": {
        const target = step.id ?? sid;
        const before = sessionManager.get(target);
        rec.got = await routeCall(step.method, target, step.body);
        const after = sessionManager.get(target);
        started = after !== undefined && after !== before;
        break;
      }
      default:
        throw new Error(step.op);
    }
    if (step.op === "create" || step.op === "req") {
      const live = sessionManager.get(sid);
      rec.live = live !== undefined;
      rec.state = await stateOf(PROJECT, sid);
      rec.ready = live ? (live.buffer.filter((e) => e.type === "ready").at(-1)?.account ?? null) : null;
      rec.env = await cliEnv(started);
    }
    recorded.push(rec);
  }
  if (sessionManager.get(sid)) await sessionManager.remove(sid);
  routeGroups.push({ name, id: sid, steps: recorded });
}
writeStore(null);
rmSync(PROFILES_DIR, { recursive: true, force: true });

// --------------------------------- rotate ---------------------------------

const WALL = `You've hit your session limit ${cp(0xb7)} resets 5pm`;
const wall = (text = WALL, o = {}) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, ...o });
const say = (text) => ({ $text: text });
const pause = { $delay_ms: 300 };
const DONE = "s30-done";

// [name, store text, on_init steps, gates ([file, store text])]
const ROTATE = [
  ["one wall", ROT([PA, PB], "acc_alpha"), [wall(), pause]],
  ["two walls rotate once", ROT([PA, PB], "acc_alpha"), [wall(), pause, wall(), pause]],
  ["off", ROT([PA, PB], "acc_alpha", false), [wall(), pause]],
  ["one profile", ROT([PA], "acc_alpha"), [wall(), pause]],
  ["three, wraps from the last", ROT([PA, PB, PC], "acc_charlie"), [wall(), pause]],
  ["three, from the middle", ROT([PA, PB, PC], "acc_bravo"), [wall(), pause]],
  ["no active profile", ROT([PA, PB], null), [wall(), pause, wall(), pause]],
  ["duplicate ids", ROT([PA, { ...PA, label: "Alpha twin" }], "acc_alpha"), [wall(), pause]],
  ["subagent wall", ROT([PA, PB], "acc_alpha"), [wall(WALL, { parent_tool_use_id: "toolu_s30" }), pause]],
  [
    "mixed blocks",
    ROT([PA, PB], "acc_alpha"),
    [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: WALL }, { type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] } }, pause],
  ],
  [
    "wall in the second block",
    ROT([PA, PB], "acc_alpha"),
    [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "text", text: WALL }] } }, pause],
  ],
  ["curly quote, padded, upper case", ROT([PA, PB], "acc_alpha"), [wall(`  \n YOU${cp(0x2019)}RE OUT OF EXTRA USAGE now`), pause]],
  ["org out of usage", ROT([PA, PB], "acc_alpha"), [wall(`Your org is out of usage ${cp(0xb7)} contact your admin.`), pause]],
  ["plain text first", ROT([PA, PB], "acc_alpha"), [say("hello"), pause, say(WALL), pause]],
  ["store malformed", "{", [wall(), pause]],
  ["store missing", null, [wall(), pause]],
  [
    "turned on after a miss",
    ROT([PA, PB], "acc_alpha", false),
    [wall(), pause, { $wait_file: "gate-1" }, wall(), pause, wall(), pause],
    [["gate-1", ROT([PA, PB], "acc_alpha")]],
  ],
  [
    "a second profile appears",
    ROT([PA], "acc_alpha"),
    [wall(), pause, { $wait_file: "gate-1" }, wall(), pause],
    [["gate-1", ROT([PA, PC], "acc_alpha")]],
  ],
  ["unicode labels", ROT([{ ...PA, label: `${cp(0x1f600)} A` }, { ...PB, label: `B ${cp(0xe9)}` }], "acc_alpha"), [wall(), pause]],
  ["bedrock next", ROT([PA, PBR], "acc_alpha"), [wall(), pause]],
];

const rotateCases = [];
for (const [i, [name, store, onInit, gates = []]] of ROTATE.entries()) {
  const cwd = join(ROOT, "rotate", String(i));
  mkdirSync(cwd, { recursive: true });
  writeStore(store);
  const script = { on_init: [...onInit, say(DONE)] };
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify(script);
  const s = new Session({ cwd });
  await s.start();
  const texts = () =>
    s.buffer
      .filter((e) => e.type === "sdk" && e.message?.type === "assistant")
      .map((e) => e.message.message?.content?.[0]?.text);
  for (const [file, text] of gates) {
    // Each gate opens once the walls before it were observed.
    if (!(await waitFor(() => texts().length >= onInit.slice(0, onInit.findIndex((st) => st.$wait_file === file)).filter((st) => st.type || st.$text).length, 10_000)))
      throw new Error(`${name}: ${file}`);
    await sleep(300);
    writeStore(text);
    writeFileSync(join(cwd, file), "");
  }
  if (!(await waitFor(() => texts().includes(DONE), 15_000))) throw new Error(`${name}: no ${DONE}`);
  await sleep(300);
  const seq = s.buffer
    .filter((e) => (e.type === "sdk" && e.message?.type === "assistant") || e.type === "account_auto_rotated")
    .map((e) => (e.type === "sdk" ? { text: e.message.message?.content?.[0]?.text ?? null } : e));
  rotateCases.push({
    name,
    store,
    script,
    gates,
    seq,
    storeAfter: readText(ACCOUNTS_FILE),
    pin: { id: s.accountProfileId, label: s.accountProfileLabel, drift: s.accountDriftFromActive },
  });
  await s.end();
  delete process.env.FAKE_CLAUDE_SCRIPT;
}
writeStore(null);
rmSync(PROFILES_DIR, { recursive: true, force: true });

// -------------------------------- rateLimit --------------------------------

const asst = (content, o = {}) => ({ type: "assistant", message: { content }, ...o });
const txt = (text) => [{ type: "text", text }];
const MESSAGES = [
  ...USAGE_LIMIT_ERROR_PREFIXES.map((p) => asst(txt(`${p} and more`))),
  ...USAGE_LIMIT_ERROR_PREFIXES.map((p) => asst(txt(p.toUpperCase()))),
  asst(txt(`You${cp(0x2018)}ve hit your limit`)),
  asst(txt(`${cp(0xfeff)}${cp(0xa0)}${cp(0x2028)}You've hit your limit`)),
  asst(txt(`${cp(0x85)}You've hit your limit`)),
  asst(txt(`${cp(0x200b)}You've hit your limit`)),
  asst(txt("You have hit your limit")),
  asst(txt("hit your limit")),
  asst(txt("")),
  asst(txt("You've hit you")),
  asst(txt("Your org is out of usage . add funds to continue")),
  asst(txt("Your group's usage limit is set to $0.")),
  asst(txt(`YOUR SEAT TYPE DOESN${cp(0x2019)}T INCLUDE USAGE`)),
  asst(txt(`Fable 5 requires usage credits ${cp(0x3a3)}`)),
  asst([{ type: "text", text: 5 }]),
  asst([{ type: "text" }]),
  asst([{ type: "text", text: null }]),
  asst([{ type: "text", text: ["You've hit your"] }]),
  asst([]),
  asst("You've hit your limit"),
  asst(null),
  asst({ 0: { type: "text", text: "You've hit your" }, length: 1 }),
  { type: "assistant" },
  { type: "assistant", message: null },
  { type: "assistant", message: "x" },
  asst([null]),
  asst(["You've hit your"]),
  asst([{ type: "TEXT", text: "You've hit your" }]),
  asst([{ text: "You've hit your" }]),
  asst([{ type: "text", text: "You've hit your" }, null]),
  asst([{ type: "text", text: "You've hit your" }, { type: "thinking", thinking: "x" }]),
  asst([{ type: "text", text: "ok" }, { type: "text", text: "You've hit your" }]),
  asst([{ type: "text", text: "You've hit your" }, { type: "text", text: "ok" }]),
  asst(txt("You've hit your"), { parent_tool_use_id: "toolu_1" }),
  asst(txt("You've hit your"), { parent_tool_use_id: null }),
  asst(txt("You've hit your"), { parent_tool_use_id: "" }),
  asst(txt("You've hit your"), { parent_tool_use_id: 0 }),
  asst(txt("You've hit your"), { parent_tool_use_id: false }),
  asst(txt("You've hit your"), { parent_tool_use_id: {} }),
  asst(txt("You've hit your"), { parent_tool_use_id: [] }),
  asst(txt("You've hit your"), { parent_tool_use_id: 1 }),
  { ...asst(txt("You've hit your")), type: "user" },
  { ...asst(txt("You've hit your")), type: "Assistant" },
  { message: { content: txt("You've hit your") } },
  { type: "result", subtype: "success", result: "You've hit your limit" },
  null,
  "You've hit your limit",
  5,
  [asst(txt("You've hit your"))],
  true,
];
const rateLimit = {
  prefixes: [...USAGE_LIMIT_ERROR_PREFIXES],
  messages: MESSAGES.map((message) => ({ message, hit: isRateLimitHitSdkMessage(message) })),
};

// --------------------------------- listing ---------------------------------

const ws = (rootPath) => ({ id: `wks_${String(rootPath)}`, name: "w", rootPath, icon: { kind: "letter", letter: "W", color: "#d97757" }, createdAt: 1, updatedAt: 1 });
const WS = (list) => `${JSON.stringify({ version: 1, workspaces: list }, null, 2)}\n`;
const many = (n, pinAt) =>
  Array.from({ length: n }, (_, k) => [`m-${String(k).padStart(4, "0")}`, pinAt(k)]);

// [name, { store, workspaces, dbs: { name: rows | bytes }, pairs: [[db name | "" | null, id]] }]
// A db name is a cwd `$ROOT/list/<scenario>/<name>`.
const LISTING = [
  [
    "pins of every type",
    {
      store: STORE([PA, PB], "acc_alpha"),
      dbs: {
        a: [
          ["s1", '{"accountProfileId":"acc_alpha"}'],
          ["s2", '{"accountProfileId":"acc_gone"}'],
          ["s3", "null"],
          ["s4", "{}"],
          ["s5", '{"accountProfileId":5}'],
          ["s6", '{"accountProfileId":""}'],
          ["s7", '{"accountProfileId":{"id":"acc_alpha","n":1.0}}'],
          ["s8", '{"accountProfileId":[1,"x"]}'],
          ["s9", '{"accountProfileId":true}'],
          ["s10", '{"accountProfileId":null}'],
          ["s11", `{"accountProfileId":"acc_${cp(0xe9)}${cp(0x1f600)}"}`],
          ["s12", '{"accountProfileId":"acc_bravo","accountProfileId":"acc_alpha"}'],
          ["s13", '{"accountProfileId":"acc_\\u0062ravo"}'],
          ["s14", '{"accountProfileId":1.5}'],
          ["s15", '{"x":{"accountProfileId":"acc_alpha"}}'],
          ["s16", '["acc_alpha"]'],
          ["s17", '"acc_alpha"'],
          ["s18", '{"accountProfileId":"acc_bravo"}'],
          ["", '{"accountProfileId":"acc_alpha"}'],
        ],
      },
      pairs: [
        ...Array.from({ length: 18 }, (_, k) => ["a", `s${k + 1}`]),
        ["a", "s99"],
        ["a", ""],
        ["a", "s1"],
      ],
    },
  ],
  [
    "a malformed state skips its chunk",
    {
      store: STORE([PA, PB], "acc_alpha"),
      dbs: {
        a: [
          ["s1", '{"accountProfileId":"acc_alpha"}'],
          ["s2", '{"accountProfileId":'],
        ],
        b: [["s1", '{"accountProfileId":"acc_bravo"}'], ["s3", "not json"]],
      },
      pairs: [
        ["a", "s1"],
        ["a", "s2"],
        ["b", "s1"],
      ],
    },
  ],
  [
    "a malformed state outside the ids",
    { store: STORE([PA], "acc_alpha"), dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}'], ["s2", "{"]] }, pairs: [["a", "s1"]] },
  ],
  [
    "chunks of 500",
    {
      store: STORE([PA, PB], "acc_alpha"),
      dbs: {
        a: many(1203, (k) =>
          k === 700 ? "{" : [0, 499, 500, 999, 1000, 1202].includes(k) ? `{"accountProfileId":"${k % 2 ? "acc_alpha" : "acc_bravo"}"}` : "{}",
        ),
      },
      pairs: many(1203, () => null).map(([sid]) => ["a", sid]),
    },
  ],
  [
    "no database, a garbage one, a missing cwd",
    {
      store: STORE([PA], "acc_alpha"),
      dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}']], g: "this is not a database" },
      pairs: [
        ["none", "s1"],
        ["g", "s1"],
        ["a", "s1"],
      ],
    },
  ],
  [
    "cwd-less pairs search the workspaces",
    {
      store: STORE([PA, PB, PC], "acc_alpha"),
      workspaces: WS([ws("$CWD:b"), ws(""), ws(5), ws(null), "plain", ws("$CWD:a"), ws("$CWD:none")]),
      dbs: {
        a: [["s1", '{"accountProfileId":"acc_alpha"}'], ["s2", '{"accountProfileId":"acc_bravo"}'], ["s3", '{"accountProfileId":"acc_charlie"}']],
        b: [["s2", '{"accountProfileId":"acc_charlie"}'], ["s4", '{"accountProfileId":"acc_gone"}']],
      },
      pairs: [
        [null, "s1"],
        ["", "s2"],
        [null, "s3"],
        [null, "s4"],
        [null, "s5"],
        ["a", "s2"],
        [null, ""],
      ],
    },
  ],
  [
    "cwd-less, every id found early",
    {
      store: STORE([PA], "acc_alpha"),
      workspaces: WS([ws("$CWD:a"), ws("$CWD:b")]),
      dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}']], b: [["s1", '{"accountProfileId":"acc_gone"}']] },
      pairs: [[null, "s1"]],
    },
  ],
  [
    "a null workspace entry",
    {
      store: STORE([PA], "acc_alpha"),
      workspaces: WS([ws("$CWD:a"), null]),
      dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}']] },
      pairs: [
        ["a", "s1"],
        [null, "s9"],
      ],
    },
  ],
  [
    "a null workspace entry, cwds only",
    {
      store: STORE([PA], "acc_alpha"),
      workspaces: WS([null]),
      dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}']] },
      pairs: [["a", "s1"]],
    },
  ],
  ["workspaces malformed", { store: STORE([PA], "acc_alpha"), workspaces: "{", dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}']] }, pairs: [[null, "s1"], ["a", "s1"]] }],
  ["store missing", { store: null, dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}']] }, pairs: [["a", "s1"]] }],
  ["store malformed", { store: "{", dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}']] }, pairs: [["a", "s1"]] }],
  ["store a directory", { store: "$DIR", dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}']] }, pairs: [["a", "s1"]] }],
  [
    "store with odd profiles",
    {
      store: JSON.stringify({
        profiles: [PA, { ...PA, label: "Alpha twin" }, { ...PB, label: 5 }, { ...PBR, bedrock: undefined }, null, { ...PC, label: "" }],
        activeProfileId: "acc_nope",
      }),
      dbs: {
        a: [
          ["s1", '{"accountProfileId":"acc_alpha"}'],
          ["s2", '{"accountProfileId":"acc_bravo"}'],
          ["s3", '{"accountProfileId":"acc_bedrock"}'],
          ["s4", '{"accountProfileId":"acc_charlie"}'],
        ],
      },
      pairs: [
        ["a", "s1"],
        ["a", "s2"],
        ["a", "s3"],
        ["a", "s4"],
      ],
    },
  ],
  ["no pairs", { store: STORE([PA, PB], "acc_alpha"), dbs: {}, pairs: [] }],
  ["only empty ids", { store: STORE([PA, PB], "acc_alpha"), dbs: {}, pairs: [["a", ""], [null, ""]] }],
  // Once every id is found the fan-out stops: the null entry is never read.
  [
    "cwd-less, found before a null entry",
    {
      store: STORE([PA], "acc_alpha"),
      workspaces: WS([ws("$CWD:a"), ws("$CWD:b"), null]),
      dbs: { a: [["s1", '{"accountProfileId":"acc_alpha"}']] },
      pairs: [[null, "s1"]],
    },
  ],
  // Foreign `sessions` tables (`sql`): no primary key, so an id can have two
  // rows (the first wins), and a numeric id column, which `IN` matches to
  // the text ids by affinity (the key is the number's text).
  [
    "a foreign sessions table",
    {
      store: STORE([PA, PB], "acc_alpha"),
      dbs: {
        a: {
          sql:
            "PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT, state TEXT); INSERT INTO sessions VALUES " +
            `('s1', '{"accountProfileId":"acc_alpha"}'), ('s1', '{"accountProfileId":"acc_bravo"}'), ('s2', '{"accountProfileId":"acc_bravo"}');`,
        },
        n: {
          sql:
            "PRAGMA journal_mode=WAL; CREATE TABLE sessions(id INTEGER, state TEXT); INSERT INTO sessions VALUES " +
            `(7, '{"accountProfileId":"acc_bravo"}'), (2.5, '{"accountProfileId":"acc_alpha"}');`,
        },
      },
      pairs: [
        ["a", "s1"],
        ["a", "s2"],
        ["n", "7"],
        ["n", "2.5"],
        ["n", "07"],
      ],
    },
  ],
  // The empty root is skipped, even with a database where its path goes
  // (`~/.claude/projects/.claudius.db`). Last: that database stays.
  [
    "an empty workspace root with a database",
    {
      store: STORE([PA, PB], "acc_alpha"),
      workspaces: WS([ws(""), ws("$CWD:a")]),
      dbs: { "": [["s1", '{"accountProfileId":"acc_bravo"}']], a: [["s1", '{"accountProfileId":"acc_alpha"}']] },
      pairs: [[null, "s1"]],
    },
  ],
];

const listing = [];
for (const [i, [name, sc]] of LISTING.entries()) {
  const base = join(ROOT, "list", String(i));
  const cwdOf = (n) => (n === null ? undefined : n === "" ? "" : join(base, n));
  writeStore(sc.store);
  if (sc.workspaces === undefined) rmSync(WORKSPACES_FILE, { force: true });
  else writeFileSync(WORKSPACES_FILE, sc.workspaces.replace(/\$CWD:([a-z]+)/g, (_, n) => cwdOf(n)));
  for (const [dbName, rows] of Object.entries(sc.dbs)) {
    const cwd = cwdOf(dbName);
    if (typeof rows === "string") {
      const file = join(HOME, ".claude", "projects", encodeProjectDir(cwd), ".claudius.db");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, rows);
      continue;
    }
    if (!Array.isArray(rows)) {
      const file = join(HOME, ".claude", "projects", encodeProjectDir(cwd), ".claudius.db");
      mkdirSync(dirname(file), { recursive: true });
      const raw = new Database(file);
      raw.exec(rows.sql);
      raw.close();
      continue;
    }
    const db = await openDb(cwd);
    const ins = db.prepare("INSERT INTO sessions(id, cwd, state, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (const [sid, state] of rows) ins.run(sid, cwd, state, 1767225600000, 1767225600000, 1767225600000);
    })();
  }
  const pairs = sc.pairs.map(([n, sid]) => ({ cwd: cwdOf(n), id: sid }));
  const { byKey, accountsConfigured } = await resolveSessionAccounts(pairs);
  listing.push({
    name,
    store: sc.store,
    workspaces: sc.workspaces ?? null,
    dbs: sc.dbs,
    pairs: sc.pairs,
    entries: [...byKey].map(([k, v]) => [norm(k), v]),
    accountsConfigured,
    lookups: pairs.map((p) => lookupSessionAccount(byKey, p.cwd, p.id) ?? null),
  });
}
writeStore(null);
rmSync(WORKSPACES_FILE, { force: true });

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(
  join(ROOT, "out.json"),
  JSON.stringify({ sdkVersion, envKeys: ENV_KEYS, route: routeGroups, rotate: rotateCases, rateLimit, listing }),
);
process.exit(0);
