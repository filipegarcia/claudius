#!/usr/bin/env node
// Golden fixture for rewind (S13), recorded from the TS sources:
//
//   node rust/scripts/rewind-golden.mjs     (node@22: session.ts needs
//                                            better-sqlite3, which bun can't
//                                            load; builds claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir and a resolve hook for the extensionless /
// `@/` imports, twice (two temp roots); both recordings must agree byte for
// byte. The hook also maps session.ts's SDK import to a shim that calls the
// real `query()` with one option added, `pathToClaudeCodeExecutable` (the
// fake CLI). Records:
//
// - `controls`: the real `Session.prototype.rewindFiles` on a bare session
//   object whose `query` is a real SDK `query()` against the fake CLI, one
//   CLI per case, with the case's `script` (a `control.rewind_files` literal:
//   what the CLI answers; a string `script` is passed as written). Each call's
//   `args`, its `outcome` (`{ok, data}`, or `{ok: false, error}`) and the
//   `rewind_files` control requests the SDK wrote (`wire`: the raw stdin
//   lines, the request id written `$ID`). `query: "none"` has no query;
//   `"ended"` aborts it, as `Session.end()` does, and waits for the CLI to go.
// - `route`: the real `POST /api/sessions/:id/rewind` handler
//   (`sessionManager.get` stubbed to return such a bare session), in order on
//   one session per group. Each case: the request body (`request`, and its
//   bytes as `requestHex`; both null for a request without a body), the
//   response's `status` and `body` as sent, and the `wire`. Groups:
//   validation on the fake's canned reply, CLI replies scripted per group, a
//   session without a query, one whose CLI exited, and `userMessageId`s with
//   lone-surrogate escapes (the SDK writes each back as `\udXXX`; the fake
//   reads it as U+FFFD and answers, I17).
// - `resume`: the real `new Session({cwd, resume, resumeSessionAt}).start()`
//   over a recorded transcript (`transcript`, JSONL lines): the uuids of the
//   transcript messages in the replay buffer, in order, and the CLI's
//   `--resume*` / `--session-id` arguments.
//
// Written to rust/crates/claudius-core/tests/fixtures/rewind_golden.json and
// replayed by crates/claudius-core/tests/rewind_golden.rs (controls, resume)
// and crates/claudius-server/tests/rewind.rs (route).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/rewind_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.REWIND_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rewind-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: home,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            REWIND_GOLDEN_CHILD: root,
            REWIND_GOLDEN_FAKE: fake,
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
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const calls = fixture.controls.reduce((n, c) => n + c.calls.length, 0);
  const routes = fixture.route.reduce((n, g) => n + g.cases.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.controls.length} control cases (${calls} calls), ${routes} route cases, ${fixture.resume.length} resumes (SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.REWIND_GOLDEN_CHILD;
const FAKE = process.env.REWIND_GOLDEN_FAKE;
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.REWIND_GOLDEN_FAKE } });
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
const { POST } = await import(join(repo, "app/api/sessions/[id]/rewind/route.ts"));
const { query } = await import(SDK);
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

// Non-ASCII without escapes in this file: a code point, and a JSON `\uXXXX`
// escape as text.
const cp = (n) => String.fromCodePoint(n);
const ju = (hex) => `${"\\"}u${hex}`;

// ------------------------------- the bare session -------------------------------

let dirs = 0;
/** A real SDK query against the fake CLI, as a bare session's `query`. */
async function openQuery(script) {
  const dir = join(ROOT_DIR, `q${dirs++}`);
  const cwd = join(dir, "proj");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "home"));
  const log = join(dir, "stdin.log");
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* prompt() {
    await done;
  }
  const ctrl = new AbortController();
  const q = query({
    prompt: prompt(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: FAKE,
      abortController: ctrl,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: join(dir, "home"),
        FAKE_CLAUDE_LOG: log,
        ...(script ? { FAKE_CLAUDE_SCRIPT: typeof script === "string" ? script : JSON.stringify(script) } : {}),
      },
    },
  });
  const drained = (async () => {
    try {
      for await (const m of q) void m;
    } catch {
      // the abort (or the CLI's exit) ends the stream with an error
    }
  })();
  await q.initializationResult();
  const close = async () => {
    finish();
    ctrl.abort();
    await drained;
  };
  return { q, log, close, drained };
}

function bareSession(id) {
  const host = Object.create(Session.prototype);
  host.id = id;
  host.query = null;
  return host;
}

const readLines = (f) => {
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** The `rewind_files` control requests written since line `from`, ids as `$ID`. */
function wireSince(log, from) {
  return readLines(log)
    .slice(from)
    .filter((l) => {
      const m = JSON.parse(l);
      return m.type === "control_request" && m.request?.subtype === "rewind_files";
    })
    .map((l) => l.replace(JSON.stringify(JSON.parse(l).request_id), '"$ID"'));
}

function outcomeOf(r) {
  if (!r.ok) return { ok: false, error: r.error };
  return r.data === undefined ? { ok: true, data: null, dataUndefined: true } : { ok: true, data: r.data };
}

// --------------------------------- controls ---------------------------------

const ctl = (response) => ({ control: { rewind_files: response } });
const LONG = "msg-".repeat(2500);
const UNICODE = `s${cp(0xeb)}rv${cp(0xe9)}r ${cp(0x1f600)} ${cp(0x4e2d)}`;

const CONTROLS = [
  [
    "default",
    null,
    [
      ["u1"],
      ["u1", { dryRun: true }],
      ["u1", { dryRun: false }],
      ["u1", {}],
      ["", { dryRun: true }],
      [UNICODE, { dryRun: false }],
      ['a\nb"c\\d', { dryRun: true }],
      [LONG],
    ],
  ],
  ["cannot rewind", ctl({ canRewind: false, error: "No file checkpoint found for this message." }), [["u1", { dryRun: true }]]],
  [
    "files changed",
    ctl({ canRewind: true, filesChanged: ["src/a.ts", "b.md"], insertions: 3, deletions: 1, skippedLinks: 2 }),
    [["u1"], ["u1", { dryRun: true }]],
  ],
  ["empty object", ctl({}), [["u1"]]],
  ["null reply", ctl(null), [["u1", { dryRun: true }]]],
  ["string reply", ctl("str"), [["u1"]]],
  ["array reply", ctl([1, "a", null]), [["u1"]]],
  ["error", ctl({ $error: "checkpoint store corrupt" }), [["u1", { dryRun: true }], ["u2"]]],
  [
    "number text",
    '{"control":{"rewind_files":{"canRewind":true,"filesChanged":["a"],"insertions":1.0,"deletions":1e2,"10":"x","2":-0.0,"f":0.1,"big":1e21}}}',
    [["u1"]],
  ],
  ["no query", "none", [["u1"], ["u1", { dryRun: true }]]],
  ["ended", "ended", [["u1"], ["u1", { dryRun: true }]]],
];

const controls = [];
for (const [name, script, calls] of CONTROLS) {
  const host = bareSession(`golden-${controls.length}`);
  let q = null;
  if (script !== "none") {
    q = await openQuery(script === "ended" ? null : script);
    host.query = q.q;
    if (script === "ended") await q.close();
  }
  const results = [];
  for (const args of calls) {
    const from = q ? readLines(q.log).length : 0;
    const r = await host.rewindFiles(...args);
    results.push({ args, outcome: outcomeOf(r), wire: q ? wireSince(q.log, from) : [] });
  }
  if (q && script !== "ended") await q.close();
  controls.push({
    name,
    script: script === "none" || script === "ended" ? null : script,
    query: script === "none" ? "none" : script === "ended" ? "ended" : "live",
    calls: results,
  });
}

// ----------------------------------- route -----------------------------------

const BOM = cp(0xfeff);
const DEEP = `${"[".repeat(130)}${"]".repeat(130)}`;
// A string is sent as UTF-8; `{hex}` as those bytes; `null` sends no body.
const ROUTE_BODIES = [
  // Bodies `JSON.parse` refuses: the handler's catch answers 503 with V8's message.
  null,
  "",
  " \r\n",
  "{",
  "not json",
  '{"userMessageId":"u1"',
  '{"userMessageId":"u1"} x',
  "{'userMessageId':'u1'}",
  '{"userMessageId":u1}',
  "[1,]",
  BOM,
  `${BOM}${BOM}${BOM}{"userMessageId":"u1"}`,
  { hex: "c080" },
  { hex: "7b22757365724d6573736167654964223a2275f0" },
  // No usable `userMessageId`: 400.
  "null",
  "[]",
  "5",
  "0",
  "true",
  "false",
  '""',
  '"u1"',
  "{}",
  '{"dryRun":true}',
  '{"userMessageId":""}',
  '{"userMessageId":null}',
  '{"userMessageId":5}',
  '{"userMessageId":0}',
  '{"userMessageId":true}',
  '{"userMessageId":false}',
  '{"userMessageId":[]}',
  '{"userMessageId":["u1"]}',
  '{"userMessageId":{}}',
  '{"UserMessageId":"u1"}',
  '{"user_message_id":"u1"}',
  '{"__proto__":{"userMessageId":"u1"}}',
  '[{"userMessageId":"u1"}]',
  '{"userMessageId":"u1","userMessageId":""}',
  // Rewinds: the CLI's answer as `{result}`; only `dryRun: true` is a dry run.
  '{"userMessageId":"u1"}',
  '{"userMessageId":"u1","dryRun":true}',
  '{"userMessageId":"u1","dryRun":false}',
  '{"userMessageId":"u1","dryRun":null}',
  '{"userMessageId":"u1","dryRun":"true"}',
  '{"userMessageId":"u1","dryRun":1}',
  '{"userMessageId":"u1","dryRun":[]}',
  '{"userMessageId":"u1","dryRun":{}}',
  '{"userMessageId":"u1","dryRun":true,"dryRun":false}',
  '{"userMessageId":"u1","dryRun":false,"dryRun":true}',
  '{"userMessageId":"","userMessageId":"u2","dryRun":true}',
  '{"userMessageId":"u1","dryRun":1e400}',
  '{"dryRun":true,"extra":[1.0,1e2],"userMessageId":"u1"}',
  '{"userMessageId":" "}',
  '{"userMessageId":"0"}',
  '{"userMessageId":"false"}',
  '{"userMessageId":"5b0e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b11","dryRun":true}',
  `{"userMessageId":"s${ju("00eb")}rv ${ju("d83d")}${ju("de00")}"}`,
  JSON.stringify({ userMessageId: UNICODE, dryRun: true }),
  `{"userMessageId":"a${ju("0001")}b${ju("001f")}c${ju("007f")}d${ju("2028")}e\\n\\t\\"\\\\/"}`,
  JSON.stringify({ userMessageId: LONG }),
  `${BOM}{"userMessageId":"u1","dryRun":true}`,
  `${BOM}${BOM}{"userMessageId":"u1"}`,
  ' \t\n{"userMessageId":"u1"}\r\n',
  { hex: "7b22757365724d6573736167654964223a2275ff31227d" },
  // Nesting serde_json refuses (128 levels) and V8 parses.
  `{"userMessageId":"u1","deep":${DEEP}}`,
];
// Scripted CLI answers to `rewind_files`, one session each.
const ROUTE_SCRIPTED = [
  ["cannot rewind", ctl({ canRewind: false, error: "No file checkpoint found for this message." })],
  ["files changed", ctl({ canRewind: true, filesChanged: ["src/a.ts", "b.md"], insertions: 3, deletions: 1, skippedLinks: 2 })],
  ["error", ctl({ $error: "checkpoint store corrupt" })],
  ["empty object", ctl({})],
  ["null reply", ctl(null)],
  ["string reply", ctl("str")],
  ["array reply", ctl([1, "a", null])],
  [
    "number text",
    '{"control":{"rewind_files":{"canRewind":true,"filesChanged":["a"],"insertions":1.0,"deletions":1e2,"10":"x","2":-0.0,"f":0.1,"big":1e21}}}',
  ],
];
const SCRIPTED_BODIES = ['{"userMessageId":"u1","dryRun":true}', '{"userMessageId":"u2"}', "{}"];
// The CLI exits once it has answered `initialize`.
const EXIT_SCRIPT = { on_init: [{ $stderr: "boom" }, { $exit: 3 }] };
// Lone-surrogate escapes, on the fake's canned reply. `JSON.parse` keeps each
// as a lone surrogate and the SDK writes it back as the escape (lower-case
// hex). The last five put none on the wire.
const LONE_SURROGATE_BODIES = [
  `{"userMessageId":"${ju("d800")}"}`,
  `{"userMessageId":"${ju("dc00")}","dryRun":true}`,
  `{"userMessageId":"a${ju("d800")}b${ju("dfff")}c"}`,
  // A pair, then half of one; a pair's halves the wrong way round.
  `{"userMessageId":"${ju("d83d")}${ju("de00")}${ju("d83d")}"}`,
  `{"userMessageId":"${ju("de00")}${ju("d83d")}","dryRun":false}`,
  `{"userMessageId":"${ju("d800")}${ju("d800")}"}`,
  // Upper-case hex; an escaped backslash before one and before `ud800` text.
  `{"userMessageId":"${ju("DBFF")}x"}`,
  `{"userMessageId":"\\\\${ju("d800")}\\\\ud800"}`,
  // A pair written as escapes (U+10000); one in a key that isn't read, in
  // `dryRun`, under a repeated key; the surrogate's own three bytes
  // (`ED A0 80`), which decode to three U+FFFD.
  `{"userMessageId":"${ju("d800")}${ju("dc00")}"}`,
  `{"${ju("d800")}":1,"userMessageId":"u1"}`,
  `{"userMessageId":"u1","dryRun":"${ju("d800")}"}`,
  `{"userMessageId":"${ju("d800")}","userMessageId":"u2"}`,
  { hex: "7b22757365724d6573736167654964223a22eda080227d" },
];

async function routeCall(host, log, id, body) {
  const from = log ? readLines(log).length : 0;
  const bytes =
    body === null ? null : typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body.hex, "hex");
  let got;
  try {
    const res = await POST(new Request("http://x/api", { method: "POST", ...(bytes ? { body: bytes } : {}) }), {
      params: Promise.resolve({ id }),
    });
    got = { status: res.status, body: await res.text() };
  } catch (e) {
    got = { threw: e instanceof Error ? e.message : String(e) };
  }
  return {
    id: id === host.id ? "live" : id,
    request: typeof body === "string" ? body : null,
    requestHex: bytes === null ? null : bytes.toString("hex"),
    ...got,
    wire: log ? wireSince(log, from) : [],
  };
}

async function routeGroup(name, script, bodies) {
  const host = bareSession(`golden-route-${name.replace(/ /g, "-")}`);
  let q = null;
  if (script !== "none") {
    q = await openQuery(script);
    host.query = q.q;
    if (script === EXIT_SCRIPT) await q.drained;
  }
  sessionManager.get = (id) => (id === host.id ? host : undefined);
  const cases = [];
  if (name === "validation") {
    cases.push(await routeCall(host, null, "missing", '{"userMessageId":"u1"}'));
    cases.push(await routeCall(host, null, "missing", "{"));
  }
  for (const body of bodies) cases.push(await routeCall(host, q?.log, host.id, body));
  if (q) await q.close();
  return {
    name,
    script: script === "none" ? null : script,
    query: script === "none" ? "none" : script === EXIT_SCRIPT ? "exited" : "live",
    cases,
  };
}

const route = [await routeGroup("validation", null, ROUTE_BODIES)];
for (const [name, script] of ROUTE_SCRIPTED) route.push(await routeGroup(name, script, SCRIPTED_BODIES));
route.push(await routeGroup("no query", "none", ['{"userMessageId":"u1","dryRun":true}', "{}", "{", "null"]));
route.push(await routeGroup("exited", EXIT_SCRIPT, ['{"userMessageId":"u1","dryRun":true}', '{"userMessageId":"u1"}', "{}", "{"]));
route.push(await routeGroup("lone surrogates", null, LONE_SURROGATE_BODIES));

// ----------------------------------- resume -----------------------------------

const RESUME_ID = "7d4c1f0e-3b2a-4e5f-8a9b-0c1d2e3f4a5b";
const line = (o) => JSON.stringify({ sessionId: RESUME_ID, ...o });
let clock = Date.UTC(2026, 0, 2, 3, 4, 5);
const ts = () => new Date((clock += 1000)).toISOString();
const user = (uuid, parentUuid, content) =>
  line({ type: "user", uuid, parentUuid, timestamp: ts(), message: { role: "user", content } });
const assistant = (uuid, parentUuid, text) =>
  line({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: ts(),
    message: { role: "assistant", id: `msg_${uuid}`, type: "message", content: [{ type: "text", text }] },
  });
const transcript = [
  user("u-1", null, "first question"),
  assistant("a-1", "u-1", "first answer"),
  user("u-2", "a-1", "second question"),
  assistant("a-2", "u-2", "second answer"),
  line({
    type: "system",
    subtype: "informational",
    uuid: "s-1",
    parentUuid: "a-2",
    timestamp: ts(),
    content: "a system note",
    level: "info",
  }),
  user("u-3", "s-1", "third question"),
  assistant("a-3", "u-3", "third answer"),
  line({
    type: "assistant",
    uuid: "side-1",
    parentUuid: "a-1",
    isSidechain: true,
    timestamp: ts(),
    message: { role: "assistant", id: "msg_side", type: "message", content: [{ type: "text", text: "aside" }] },
  }),
];
const RESUMES = [
  ["plain resume", undefined],
  ["empty", ""],
  ["first", "u-1"],
  ["an assistant", "a-1"],
  ["a system message", "s-1"],
  ["the last", "a-3"],
  ["unknown", "nope"],
  ["case differs", "A-1"],
  ["a sidechain", "side-1"],
];
const resumeCwd = join(ROOT_DIR, "resume-proj");
mkdirSync(resumeCwd);
const projects = join(process.env.CLAUDE_CONFIG_DIR, "projects", resumeCwd.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(projects, { recursive: true });
writeFileSync(join(projects, `${RESUME_ID}.jsonl`), transcript.map((l) => `${l}\n`).join(""));
const wanted = new Set(transcript.map((l) => JSON.parse(l).uuid));

async function waitFor(file) {
  for (let i = 0; i < 500 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
  return readFileSync(file, "utf8");
}

const resume = [];
for (const [name, at] of RESUMES) {
  const argvFile = join(ROOT_DIR, `argv-${resume.length}.json`);
  process.env.FAKE_CLAUDE_ARGV = argvFile;
  const s = new Session({ cwd: resumeCwd, resume: RESUME_ID, ...(at === undefined ? {} : { resumeSessionAt: at }) });
  await s.start();
  const replayed = s.buffer
    .filter((e) => e.type === "sdk" && wanted.has(e.message?.uuid))
    .map((e) => e.message.uuid);
  const argv = JSON.parse(await waitFor(argvFile)).filter((a) => /^--(resume|session-id)/.test(a));
  await s.end();
  resume.push({ name, resumeSessionAt: at ?? null, replayed, argv });
}

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(
  join(ROOT_DIR, "out.json"),
  JSON.stringify({ sdkVersion, controls, route, resumeId: RESUME_ID, transcript, resume }),
);
process.exit(0);
