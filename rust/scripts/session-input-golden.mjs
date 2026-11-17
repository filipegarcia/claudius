#!/usr/bin/env node
// Golden fixture for the `sendInput()` / `subscribe()` / session-manager
// audit (S29), recorded from the TS sources:
//
//   node rust/scripts/session-input-golden.mjs   (node@22: session.ts needs
//                                                 better-sqlite3, which bun
//                                                 can't load; builds
//                                                 claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp dir and a resolve hook for the extensionless /
// `@/` imports, twice (two temp roots); both recordings must agree byte for
// byte. The hook maps session.ts's SDK import to a shim that calls the real
// `query()` with `pathToClaudeCodeExecutable` added: the fake CLI, or for
// `gated` scenarios a wrapper that waits for a gate file before it runs the
// fake (so a session can be caught started but before its CLI is up).
//
// One timeline per scenario on the real `sessionManager` (the singleton) and
// the real route handlers for `POST /input`, `POST queue/send-all` and
// `GET /api/sessions`, with the scenario's user settings.json and fake-CLI
// script (`FAKE_CLAUDE_SCRIPT`). Steps:
//
//   {create: opts}      sessionManager.create({id, cwd, ...opts})
//   {post: body, hold?} POST /input with that raw body text; `hold`: the turn
//                       it starts waits on a gate, so don't wait for it
//   {sendAll: true}     POST queue/send-all
//   {sub: opts}         Session.subscribe(fn, opts): what it delivered
//                       before returning (`sync`) and within 500 ms after
//                       (`async`), then unsubscribe
//   {open: name}        create the gate file `name` in the cwd
//   {date: key}         set `lastSeenLocalDate` (the date-change baseline)
//   {goal: text}        Session.setGoal(text)
//   {memory: updates}   Session.notifyMemoryUpdate(updates); `$CWD` in a
//                       path reads the session cwd
//   {bash: command}     Session.runBashCommand({command})
//   {touch: [f, text]}  rewrite a file in the cwd (a formatter's rewrite)
//   {rename: title}     Session.rename(title)
//   {list: query}       GET /api/sessions?<query>
//   {waitDead: true}    wait until the session reads dead
//   {settings: text}    rewrite the user settings.json ("$RM" removes it)
//
// (`wedged` scenarios: a throw in sendInput leaves the session `running`.)
//
// After every step, until the session is quiet (no event for 300 ms, and
// not `running` unless a gate holds its turn): `res` (the route's status and
// body), `wrote` (the `user` lines the CLI read since the last step, as
// written), `events` (what a subscriber registered right after create saw,
// without the CLI's own assistant / result / system messages and the
// background round trips' events, `NOISE`), `queue` (the session's
// `queued_messages` rows) and, once a scenario sent images, `assets` /
// `uses` (the rows) and `files` (the store's files). `tagged` holds the
// suggested / goal message rows.
//
// Normalized: temp paths read `$ROOT` (`$CWD` the session cwd), minted v4
// uuids `$UUID`, `msg_` ids `$MSG`, clock stamps (1.5e12 to 2.5e12) `$NOW`,
// today's `localDateKey` `$TODAY_KEY` and `toDateString()` `$TODAY`.
//
// Written to rust/crates/claudius-core/tests/fixtures/session_input_golden.json
// and replayed by crates/claudius-server/tests/session_input_golden.rs (the
// real router in process, so the steps can reach the sessions).
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/session_input_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.SESSION_INPUT_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  // `SESSION_INPUT_GOLDEN_ONCE=1`: one recording, no comparison (iterating).
  const runs = (process.env.SESSION_INPUT_GOLDEN_ONCE ? [0] : [0, 1]).map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-input-golden-")));
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
            TZ: "America/New_York",
            SESSION_INPUT_GOLDEN_CHILD: root,
            SESSION_INPUT_GOLDEN_FAKE: fake,
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
  if (runs.length > 1 && runs[0] !== runs[1]) {
    writeFileSync(join(tmpdir(), "session-input-golden-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "session-input-golden-run1.json"), runs[1]);
    throw new Error("the two recordings differ (both written to the temp dir)");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.scenarios.reduce((n, s) => n + s.steps.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.scenarios.length} scenarios (${steps} steps; SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.SESSION_INPUT_GOLDEN_CHILD;
const FAKE = process.env.SESSION_INPUT_GOLDEN_FAKE;
const GATED = join(ROOT_DIR, "gated-claude.sh");
writeFileSync(
  GATED,
  '#!/bin/sh\nwhile [ ! -e "$SESSION_INPUT_GATE" ]; do sleep 0.02; done\nexec "$SESSION_INPUT_GOLDEN_FAKE" "$@"\n',
);
chmodSync(GATED, 0o755);
const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shim = join(ROOT_DIR, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.SESSION_INPUT_GOLDEN_BIN } });
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

process.env.SESSION_INPUT_GOLDEN_BIN = FAKE;

const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const { Session, localDateKey } = await import(join(repo, "lib/server/session.ts"));
const { POST: INPUT } = await import(join(repo, "app/api/sessions/[id]/input/route.ts"));
const { POST: SEND_ALL } = await import(join(repo, "app/api/sessions/[id]/queue/send-all/route.ts"));
const { GET: LIST } = await import(join(repo, "app/api/sessions/route.ts"));
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

const HOME = process.env.HOME;
const settingsFile = join(HOME, ".claude", "settings.json");
mkdirSync(dirname(settingsFile), { recursive: true });
const STATE_DIR = join(HOME, ".claude", ".claudius");
mkdirSync(STATE_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Non-ASCII without escapes in this file.
const cp = (n) => String.fromCodePoint(n);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
const MSG_RE = /msg_[0-9a-f]{32}/g;
// A clock stamp inside a JSON text (a route body): 13 digits, 1.5e12 to 2.5e12.
const STAMP_RE = /(?<![0-9.])(?:1[5-9]|2[0-4])[0-9]{11}(?![0-9.])/g;
const TODAY_KEY = localDateKey(new Date());
const TODAY = new Date().toDateString();

function normText(s, cwd) {
  let t = s.split(ROOT_DIR).join("$ROOT");
  if (cwd) t = t.split(cwd.split(ROOT_DIR).join("$ROOT")).join("$CWD");
  return t
    .replace(UUID_RE, "$UUID")
    .replace(MSG_RE, "$MSG")
    .replace(STAMP_RE, "$NOW")
    .split(TODAY_KEY)
    .join("$TODAY_KEY")
    .split(TODAY)
    .join("$TODAY");
}
function norm(v, cwd) {
  if (typeof v === "string") return normText(v, cwd);
  if (typeof v === "number" && v > 1.5e12 && v < 2.5e12) return "$NOW";
  if (Array.isArray(v)) return v.map((x) => norm(x, cwd));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, cwd)]));
  return v;
}
const json = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// Event types whose arrival rides a background round trip (or the clock).
const NOISE = new Set([
  "plan_usage",
  "plan_usage_unavailable",
  "effort_applied",
  "mcp_needs_auth_notice",
  "mcp_disconnected_notice",
  "feedback_survey",
  "usage_snapshot",
]);
function keep(e) {
  if (NOISE.has(e.type)) return false;
  if (e.type !== "sdk") return true;
  const m = e.message ?? {};
  if (m.type === "user") return true;
  return m.type === "system" && m.subtype === "slash_invoked";
}

// --------------------------------- images ---------------------------------

// A 1x1 PNG, a 3x2 PNG header (image-size reads only the IHDR), a 1x1 GIF.
const PNG_1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_3x2 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0, 0, 0, 0, 0]),
]).toString("base64");
const GIF_1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const img = (data, mediaType, ordinal) => ({ data, mediaType, ...(ordinal === undefined ? {} : { ordinal }) });
const B = (o) => JSON.stringify(o);

// ------------------------------- the scripts -------------------------------

const turn = (match, steps, result) => ({ match, steps, ...(result === undefined ? {} : { result }) });
const text = (t) => ({ $text: t });
const asst = (content) => ({ type: "assistant", message: { role: "assistant", content } });
const tu = (id, name, input) => ({ type: "tool_use", id, name, input });
const sys = (subtype, rest = {}) => ({ type: "system", subtype, ...rest });
const hold = (gate) => [text("working"), { $wait_file: gate }];
const TODOS = [
  { content: "Write the notes", status: "in_progress", activeForm: "Writing the notes" },
  { content: "Ship them", status: "pending", activeForm: "Shipping them" },
];

// --------------------------------- scenarios ---------------------------------

const BASE_SETTINGS = { feedbackSurveyRate: 0, spinnerTipsEnabled: false };
const ID = (n) => `s29-${n}`;

const SCENARIOS = [
  {
    name: "plain sends, provenance and validation",
    steps: [
      { create: {} },
      { sub: {} },
      { post: B({ text: "hello" }) },
      { post: B({ text: "with uuid", uuid: "u-explicit-1" }) },
      { post: B({ text: "empty uuid", uuid: "" }) },
      { post: B({ text: "null uuid", uuid: null }) },
      { post: B({ text: "pastes", inlinePastes: ["pas", "", 5, null, "tes"] }) },
      { post: B({ text: "pastes not an array", inlinePastes: "pastes" }) },
      { post: B({ text: "from a suggestion", fromSuggestion: true, uuid: "u-sugg-1" }) },
      { post: B({ text: "from a goal", fromGoal: 1, uuid: "u-goal-1" }) },
      { post: B({ text: "falsy flags", fromSuggestion: 0, fromGoal: "", slash: 0, forceQueue: null }) },
      { post: B({ text: "forced into the queue", forceQueue: true, uuid: "u-q-1" }) },
      { post: B({ text: "forced again", forceQueue: "yes", uuid: "u-q-2", fromGoal: true }) },
      { sub: {} },
      { sendAll: true },
      { sub: { tail: 1 } },
      { post: B({ text: 5 }) },
      { post: B({ text: "" }) },
      { post: B({ images: [] }) },
      { post: B({ images: "x" }) },
      { post: B({ images: {} }) },
      { post: B([{ text: "array body" }]) },
      { post: "{" },
      { post: B({ text: "after the refusals" }) },
      { sub: { tail: 2 } },
    ],
  },
  {
    name: "images",
    steps: [
      { create: {} },
      {
        post: B({
          text: "look [Image #1] and [Image #2], again [Image #1], unknown [Image #9]",
          uuid: "u-img-1",
          images: [img(PNG_1, "image/png", 1), img(PNG_3x2, "image/png", 2), img(GIF_1, "image/gif")],
        }),
      },
      {
        post: B({
          text: "[Image #03] lead, [Image #1] frac, [Image #4] dup, [Image #12345678901234567890] huge",
          uuid: "u-img-2",
          images: [
            img(GIF_1, "image/gif", 3),
            img(PNG_1, "image/png", 1.5),
            img(PNG_1, "image/png", 4),
            img(GIF_1, "image/gif", 4),
            img(PNG_3x2, "image/png", -1),
            img(PNG_1, "image/png", 12345678901234567890),
            img(GIF_1, "image/gif", "2"),
          ],
        }),
      },
      { post: B({ images: [img(PNG_1, "image/png")], uuid: "u-img-3" }) },
      {
        post: B({
          text: "odd payloads",
          uuid: "u-img-4",
          images: [
            img("not base64 !!", "application/pdf"),
            img(` ${PNG_1.slice(0, 20)}\n${PNG_1.slice(20)}`, "image/png"),
            img(PNG_1.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), "image/png"),
            { mediaType: "image/png", data: GIF_1, ordinal: 7, name: "extra key" },
          ],
        }),
      },
      {
        post: B({
          text: "malformed elements [Image #2]",
          uuid: "u-img-5",
          images: [img(PNG_1, 5), img(5, "image/png"), "str", img(GIF_1, "image/gif", 2), [], { data: PNG_1 }],
        }),
      },
      {
        // `Buffer.from` on what isn't a string: an array or array-like is bytes.
        post: B({
          text: "byte data",
          uuid: "u-img-6",
          images: [
            { data: [137, 80, "78", true, null, [71], 300, -1, 1.5, " 13 ", "0x1a", "x", [[1, 2]], {}], mediaType: "image/png" },
            { data: { type: "Buffer", data: [1, 2, 3] }, mediaType: "application/pdf" },
            { data: { length: 2, 0: 5 }, mediaType: "image/gif" },
            { data: { length: "2" }, mediaType: "image/webp" },
            { data: { length: 0 }, mediaType: "image/jpeg" },
            { data: { length: -1, 0: 1 }, mediaType: "image/heic" },
            { data: { length: 2.7, 1: 9 }, mediaType: "image/avif" },
            { data: { length: null }, mediaType: "image/svg+xml" },
            { data: {}, mediaType: "image/png" },
            { data: { type: "Buffer", data: "AAAA" }, mediaType: "image/png" },
            { data: true, mediaType: "image/png" },
            { data: null, mediaType: "image/png" },
            { data: PNG_1, mediaType: "IMAGE/PNG", ordinal: 8 },
          ],
        }),
      },
      { post: B({ text: "queued images", forceQueue: true, uuid: "u-img-q", images: [{ ordinal: 1, mediaType: "image/gif", data: GIF_1 }] }) },
      // `images_json` is `JSON.stringify` of whatever has a positive
      // `length` (integer keys first), read back only when it's an array.
      { post: B({ text: "queued a string", forceQueue: true, uuid: "u-img-qs", images: "ab" }) },
      { post: '{"text":"queued an object","forceQueue":true,"uuid":"u-img-qo","images":{"length":"2","b":1,"1":"x","0":[1]}}' },
      { post: B({ text: "queued an empty list", forceQueue: true, uuid: "u-img-qe", images: [] }) },
      { post: B({ text: "queued a false length", forceQueue: true, uuid: "u-img-qf", images: { length: false } }) },
      { post: B({ text: "queued a number", forceQueue: true, uuid: "u-img-qn", images: 5 }) },
      { sub: {} },
      { sendAll: true },
    ],
  },
  {
    name: "images that throw",
    // A throw in sendInput leaves `turnInFlight` set: the session reads
    // `running` from then on, so don't wait for it to settle.
    wedged: true,
    steps: [
      { create: {} },
      { post: B({ text: "a null element", uuid: "u-null-1", images: [img(PNG_1, "image/png", 1), null] }) },
      { sub: {} },
      { post: B({ text: "after the throw" }) },
      { list: "" },
    ],
  },
  {
    name: "images that aren't a list",
    // A throw in sendInput leaves `turnInFlight` set: the session reads
    // `running` from then on, so don't wait for it to settle.
    wedged: true,
    steps: [
      { create: {} },
      { post: B({ text: "a string", images: "ab", uuid: "u-str-1" }) },
      { post: B({ text: "a number", images: 5 }) },
      { list: "" },
    ],
  },
  {
    name: "queued images that throw",
    // sendQueuedNow pops the row, then sendInput throws: send-all answers
    // the empty 500 and leaves the rows behind it queued.
    wedged: true,
    steps: [
      { create: {} },
      { post: B({ text: "queued with a null element", forceQueue: true, uuid: "u-qnull-1", images: [img(GIF_1, "image/gif", 1), null] }) },
      { post: B({ text: "queued behind it", forceQueue: true, uuid: "u-qnull-2" }) },
      { sendAll: true },
      { sub: {} },
      { list: "" },
    ],
  },
  {
    name: "slash commands",
    steps: [
      { create: {} },
      { post: B({ text: "/compact keep the API notes", slash: true, uuid: "u-slash-1" }) },
      { post: B({ text: `${cp(0xfeff)}/cmd${cp(0x85)}arg${cp(0xa0)} more `, slash: true, uuid: "u-slash-2" }) },
      { post: B({ text: `/init${cp(0x3000)}x\ty`, slash: 1, uuid: "u-slash-3" }) },
      { post: B({ text: "  ", slash: true, uuid: "u-slash-4" }) },
      { post: B({ text: "", slash: true, images: [img(PNG_1, "image/png", 1)], uuid: "u-slash-5" }) },
      { post: B({ text: "/queued", slash: true, forceQueue: true, uuid: "u-slash-q" }) },
      { post: B({ text: "plain queued", forceQueue: true, uuid: "u-slash-q2" }) },
      { sendAll: true },
      { sub: {} },
    ],
  },
  {
    name: "reminders",
    script: {
      turns: [
        turn("todo now", [asst([tu("toolu_todo", "TodoWrite", { todos: TODOS })])], "listed"),
        turn("read it", [asst([tu("toolu_read", "Read", { file_path: "$CWD/memory/notes.md" })])], "read"),
        turn("write it", [
          { $fs: ["write", "lint.txt", "first\n"] },
          {
            $control: {
              subtype: "hook_callback",
              callback_id: "$HOOK:PostToolUse",
              input: {
                session_id: "x",
                hook_event_name: "PostToolUse",
                tool_name: "Write",
                tool_input: { file_path: "$CWD/lint.txt" },
                tool_response: {},
                tool_use_id: "toolu_write",
              },
            },
          },
        ], "wrote"),
      ],
    },
    steps: [
      { create: {} },
      { post: B({ text: "first turn" }) },
      { date: "2020-01-01" },
      { post: B({ text: "after midnight", uuid: "u-date" }) },
      { post: B({ text: "same day" }) },
      { goal: "Ship the release notes" },
      { post: B({ text: "with a goal", uuid: "u-goal-r" }) },
      { post: B({ text: "goal already announced" }) },
      { post: B({ text: "read it" }) },
      { memory: [{ op: "updated", path: "$CWD/memory/notes.md" }, { op: "created", path: "$CWD/memory/new.md" }, { op: "deleted", path: "" }] },
      { post: B({ text: "after the memory edit", uuid: "u-mem" }) },
      { bash: "echo hi" },
      { bash: "echo err >&2; false" },
      { post: B({ text: "after bash", uuid: "u-bash" }) },
      { post: B({ text: "write it" }) },
      { touch: ["lint.txt", "first\nformatted\n"] },
      { post: B({ text: "after the formatter", uuid: "u-lint" }) },
      { post: B({ text: "todo now" }) },
      { sub: {} },
      // The 15th send after the TodoWrite carries the stale-todo nudge.
      ...Array.from({ length: 15 }, (_, i) => ({ post: B({ text: `t${i + 1}`, uuid: `u-t${i + 1}` }) })),
      { sub: {} },
    ],
  },
  {
    name: "a send while running, in wait mode",
    script: {
      turns: [
        turn("hold one", hold("gate-1"), "held one done"),
        turn("hold two", hold("gate-2"), "held two done"),
      ],
    },
    steps: [
      { create: {} },
      { post: B({ text: "hold one", uuid: "u-hold-1" }), hold: true },
      { sub: {} },
      { post: B({ text: "queued while running", uuid: "u-wq-1" }) },
      { post: B({ text: "queued with an image [Image #1]", uuid: "u-wq-2", images: [img(GIF_1, "image/gif", 1)] }) },
      { list: "" },
      { sub: { tabId: "tab-a" } },
      { open: "gate-1" },
      { sub: {} },
      { post: B({ text: "hold two", uuid: "u-hold-2" }), hold: true },
      { post: B({ text: "queued again", uuid: "u-wq-3" }) },
      { sendAll: true, hold: true },
      { open: "gate-2" },
    ],
  },
  {
    name: "a send while running, in asap mode",
    settings: { ...BASE_SETTINGS, queueDispatchMode: "asap" },
    script: { turns: [turn("hold asap", hold("gate-a"), "held done")] },
    steps: [
      { create: {} },
      { post: B({ text: "hold asap", uuid: "u-asap-1" }), hold: true },
      { post: B({ text: "mid-turn follow-up", uuid: "u-asap-2" }), hold: true },
      { post: B({ text: "a forced queue still queues", forceQueue: true, uuid: "u-asap-q" }), hold: true },
      { open: "gate-a" },
    ],
  },
  {
    name: "subscribe: a pending prompt, tasks and todos",
    script: {
      turns: [
        turn("work", [
          asst([tu("toolu_todo", "TodoWrite", { todos: TODOS })]),
          sys("task_started", { task_id: "task-1", tool_use_id: "toolu_task1", description: "Survey the repo", task_type: "local_agent" }),
          sys("task_progress", { task_id: "task-1", tool_use_id: "toolu_task1", description: "Reading", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 } }),
          // Apart in time: `task_snapshot` lists the rows by `updated_at`.
          { $delay_ms: 40 },
          sys("task_started", { task_id: "task-2", tool_use_id: "toolu_task2", description: "In the background", task_type: "local_bash", is_backgrounded: true }),
          { $delay_ms: 40 },
          sys("task_notification", { task_id: "task-1", tool_use_id: "toolu_task1", status: "completed", summary: "Surveyed" }),
        ], "worked"),
      ],
    },
    steps: [
      { create: { model: "claude-sonnet-4-5" } },
      { post: B({ text: "work", uuid: "u-work" }) },
      { sub: {} },
      { sub: { tail: 1 } },
      { rename: "  Renamed session  " },
      { sub: {} },
      { post: B({ text: "tool:ls -la", uuid: "u-tool" }) },
      { sub: { tabId: "tab-a" } },
      { sub: { tabId: "tab-b" } },
      { list: "" },
    ],
  },
  {
    name: "subscribe before the CLI is up",
    bin: "gated",
    steps: [
      { create: {} },
      { sub: {} },
      { post: B({ text: "early", uuid: "u-early" }), hold: true },
      { sub: {} },
      { open: "$GATE" },
      { sub: {} },
    ],
  },
  {
    name: "the idle reaper keeps a session with a pending prompt or a tab",
    multi: true,
    reap: true,
    steps: [
      { create: {} },
      { create: { $id: 1 } },
      { post: B({ text: "tool:pwd", uuid: "u-tool-r" }), $id: 1 },
      { create: { $id: 2 } },
      { attach: true, $id: 2 },
      { reapWait: true },
      { list: "" },
    ],
  },
  {
    name: "the session list",
    multi: true,
    accounts: true,
    steps: [
      { create: { model: "claude-opus-4-5" } },
      { create: { $id: 1, $cwd: 0 } },
      { rename: "Second", $id: 1 },
      { create: { $id: 2, $cwd: 1 } },
      { post: B({ text: "hold list", uuid: "u-hold-l" }), hold: true, $id: 2 },
      { create: { $id: 3, $cwd: 1 } },
      { post: B({ text: "tool:pwd", uuid: "u-tool-l" }), $id: 3 },
      { list: "" },
      { list: "workspaceId=wks_s29" },
      { list: "workspaceId=wks_missing" },
      { list: "customizationId=cust_x" },
      { list: "customizationId=&workspaceId=wks_s29" },
      { list: "workspaceId=wks_missing&workspaceId=wks_s29" },
      { list: "workspaceId=wks%5Fs29&customizationId" },
      { post: B({ text: "exit:3" }) },
      { waitDead: true },
      { settings: "null" },
      { post: B({ text: "restart fails" }) },
      { settings: "$BASE" },
      { list: "" },
      { open: "gate-l", $id: 2 },
      { list: "" },
    ],
  },
  {
    name: "a uuid that isn't a string",
    steps: [
      { create: {} },
      { post: B({ text: "a number uuid", uuid: 5 }) },
      { post: B({ text: "an object uuid", uuid: { a: 1 }, fromSuggestion: true }) },
      { post: B({ text: "a true uuid", uuid: true, images: [img(GIF_1, "image/gif")] }) },
      { post: B({ text: "a queued number uuid", uuid: 7, forceQueue: true }) },
      { sendAll: true },
    ],
  },
  {
    name: "text that isn't a string",
    wedged: true,
    steps: [
      { create: {} },
      { post: B({ text: 5, images: [img(PNG_1, "image/png")], uuid: "u-num-text" }) },
      { post: B({ text: ["a"], images: [img(PNG_1, "image/png")], uuid: "u-arr-text", forceQueue: true }) },
      { list: "" },
    ],
  },
];

const SCRIPT_LIST = { turns: [turn("hold list", hold("gate-l"), "held")] };
// The reaper's window there (its floor).
const REAP_MS = 5000;

// ------------------------------- the world -------------------------------

// A registered workspace for the list filter: the list scenario's first cwd.
const LIST_CWD = (k) => join(ROOT_DIR, "list", String(k));
mkdirSync(LIST_CWD(0), { recursive: true });
mkdirSync(LIST_CWD(1), { recursive: true });
const WORKSPACES = {
  version: 1,
  workspaces: [
    {
      id: "wks_s29",
      name: "s29",
      rootPath: LIST_CWD(0),
      icon: { kind: "letter", letter: "S", color: "#d97757" },
      createdAt: 1767225600000,
      updatedAt: 1767225600000,
    },
  ],
};
writeFileSync(join(STATE_DIR, "workspaces.json"), `${JSON.stringify(WORKSPACES, null, 2)}\n`);
const ACCOUNTS = JSON.stringify(
  {
    profiles: [{ id: "acc_alpha", label: "Alpha", kind: "api-key", secret: "sk-ant-api03-FAKE-s29-alpha", createdAt: "2026-01-01T00:00:00.000Z" }],
    activeProfileId: "acc_alpha",
    autoRotateOnRateLimit: false,
  },
  null,
  2,
);

async function waitFor(pred, ms) {
  for (let t = 0; t < ms; t += 10) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

// Next logs an unhandled rejection and carries on; so does the recorder.
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));

async function rows(cwd, sql) {
  try {
    return (await openDb(cwd, "readonly")).prepare(sql).all();
  } catch {
    return [];
  }
}
function storeFiles(cwd) {
  const dir = join(HOME, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "assets");
  const outFiles = [];
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else outFiles.push({ path: relative(dir, p), size: statSync(p).size });
    }
  };
  walk(dir);
  return outFiles;
}

async function call(handler, url, body, params) {
  const req = new Request(url, { method: body === undefined ? "GET" : "POST", ...(body === undefined || body === null ? {} : { body }) });
  try {
    const res = await handler(req, { params: Promise.resolve(params) });
    const t = await res.text();
    return { status: res.status, body: t };
  } catch (e) {
    // Next answers a thrown route handler with an empty 500.
    return { status: 500, body: "", threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

// What one subscriber saw: delivered during `subscribe()` vs after it.
async function subscribeOnce(s, opts) {
  const got = [];
  const unsub = s.subscribe((e) => got.push(json(e)), opts);
  const sync = got.length;
  await sleep(500);
  const all = got.slice();
  unsub();
  // The replayed buffer without the background round trips' events (their
  // place in it is a race); what subscribe itself sends stays as is.
  const done = all.findIndex((e) => e.type === "replay_done");
  const replay = (e, i) => !(i < done && NOISE.has(e.type));
  return { sync: all.slice(0, sync).filter(replay), async: all.slice(sync) };
}

// --------------------------------- unstarted ---------------------------------

const unstartedCwd = join(ROOT_DIR, "unstarted");
mkdirSync(unstartedCwd, { recursive: true });
writeFileSync(settingsFile, `${JSON.stringify(BASE_SETTINGS, null, 2)}\n`);
const unstartedSession = new Session({ id: "s29-unstarted", cwd: unstartedCwd });
const unstarted = norm(await subscribeOnce(unstartedSession, {}), unstartedCwd);

// --------------------------------- scenarios ---------------------------------

const scenarios = [];
for (const [ci, sc] of SCENARIOS.entries()) {
  const isList = !!sc.accounts;
  const multi = !!sc.multi;
  const settings = sc.settings ?? BASE_SETTINGS;
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  if (isList) writeFileSync(join(STATE_DIR, "accounts.json"), ACCOUNTS);
  const script = isList ? SCRIPT_LIST : sc.script ?? { turns: [] };
  const cwds = isList ? [LIST_CWD(0), LIST_CWD(1)] : [join(ROOT_DIR, "proj", String(ci))];
  for (const c of cwds) mkdirSync(c, { recursive: true });
  const idOf = (step) => (multi ? `${ID(ci)}-${step.$id ?? step.create?.$id ?? 0}` : ID(ci));
  const cwdOf = (k) => cwds[k ?? 0];
  // `$CWD` in the script and the memory paths: the first cwd.
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify(script).split("$CWD").join(cwds[0]);
  const gate = join(cwds[0], "cli-gate");
  if (sc.reap) process.env.CLAUDIUS_SESSION_IDLE_REAP_MS = String(REAP_MS);
  const attached = [];
  process.env.SESSION_INPUT_GATE = gate;
  process.env.SESSION_INPUT_GOLDEN_BIN = sc.bin === "gated" ? GATED : FAKE;
  const logs = new Map(); // id -> {file, seen}
  const watched = new Map(); // id -> events[]
  const cwdById = new Map();
  let lastEventAt = Date.now();
  const held = new Set(); // sessions whose turn waits on a gate
  let images = false;

  const newWrote = (id) => {
    const l = logs.get(id);
    if (!l) return [];
    let lines = [];
    try {
      lines = readFileSync(l.file, "utf8").split("\n").filter((x) => x.length > 0);
    } catch {
      return [];
    }
    const users = lines.filter((x) => {
      try {
        return JSON.parse(x).type === "user";
      } catch {
        return false;
      }
    });
    const fresh = users.slice(l.seen);
    l.seen = users.length;
    return fresh.map((x) => normText(x, cwdById.get(id)));
  };

  async function quiet(id) {
    for (let t = 0; t < 20_000; t += 10) {
      const s = sessionManager.get(id);
      const running = s && !s.done && s.getStatus() === "running" && !held.has(id) && !sc.wedged;
      if (!running && Date.now() - lastEventAt >= 300) return;
      await sleep(10);
    }
    throw new Error(`${sc.name}: never went quiet`);
  }

  const recorded = [];
  for (const step of sc.steps) {
    const id = idOf(step);
    let got = {};
    if (step.create) {
      const opts = Object.fromEntries(Object.entries(step.create).filter(([k]) => !k.startsWith("$")));
      const cwd = cwdOf(step.create.$cwd);
      const log = join(cwd, `stdin-${id}.log`);
      process.env.FAKE_CLAUDE_LOG = log;
      try {
        const s = await sessionManager.create({ id, cwd, ...opts });
        logs.set(id, { file: log, seen: 0 });
        cwdById.set(id, cwd);
        const evs = [];
        watched.set(id, evs);
        // A watcher counts as a tab, so the reaper's scenario goes without.
        if (!sc.reap) {
          s.subscribers.add((e) => {
            lastEventAt = Date.now();
            evs.push(json(e));
          });
        }
        if (sc.bin !== "gated") {
          if (!(await waitFor(() => s.buffer.some((e) => e.type === "sdk" && e.message?.subtype === "init"), 10_000))) {
            throw new Error(`${sc.name}: no init`);
          }
          // The init's own round trips (effort, MCP status) settle first.
          await sleep(400);
        }
        evs.length = 0;
        got = { created: true };
      } catch (e) {
        got = { threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      }
    } else if (step.post !== undefined) {
      if (step.hold) held.add(id);
      got = { res: await call(INPUT, `http://x/api/sessions/${id}/input`, step.post, { id }) };
      if (step.post.includes("images")) images = true;
    } else if (step.sendAll) {
      got = { res: await call(SEND_ALL, `http://x/api/sessions/${id}/queue/send-all`, null, { id }) };
    } else if (step.sub) {
      const s = sessionManager.get(id);
      got = { sub: await subscribeOnce(s, step.sub) };
    } else if (step.open) {
      writeFileSync(step.open === "$GATE" ? gate : join(cwdById.get(id) ?? cwdOf(0), step.open), "");
      held.delete(id);
      if (step.open === "$GATE") {
        const s = sessionManager.get(id);
        await waitFor(() => s.buffer.some((e) => e.type === "sdk" && e.message?.subtype === "init"), 10_000);
      }
    } else if (step.date) {
      sessionManager.get(id).lastSeenLocalDate = step.date;
    } else if (step.goal) {
      await sessionManager.get(id).setGoal(step.goal);
    } else if (step.memory) {
      const cwd = cwdOf(0);
      sessionManager.get(id).notifyMemoryUpdate(step.memory.map((u) => ({ ...u, path: u.path.split("$CWD").join(cwd) })));
    } else if (step.bash) {
      const r = await sessionManager.get(id).runBashCommand({ command: step.bash, uuid: `u-bash-${recorded.length}` });
      got = { bash: { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode } };
    } else if (step.touch) {
      writeFileSync(join(cwdOf(0), step.touch[0]), step.touch[1]);
    } else if (step.rename) {
      await sessionManager.get(id).rename(step.rename);
    } else if (step.list !== undefined) {
      got = { list: await call(LIST, `http://x/api/sessions${step.list ? `?${step.list}` : ""}`, undefined, {}) };
    } else if (step.attach) {
      attached.push(sessionManager.get(id).subscribe(() => {}, {}));
    } else if (step.reapWait) {
      await sleep(REAP_MS + 1000);
    } else if (step.waitDead) {
      got = { dead: await waitFor(() => !!sessionManager.get(id)?.isDead(), 15_000) };
    } else if (step.settings) {
      if (step.settings === "$RM") rmSync(settingsFile, { force: true });
      else writeFileSync(settingsFile, step.settings === "$BASE" ? `${JSON.stringify(settings, null, 2)}\n` : step.settings);
    }
    await quiet(id);
    if (images) await sleep(200);
    const cwd = cwdById.get(id) ?? cwdOf(0);
    const evs = watched.get(id) ?? [];
    const events = evs.splice(0).filter(keep);
    const queue = await rows(
      cwd,
      `SELECT uuid, position, text, images_json, slash, from_suggestion, from_goal FROM queued_messages WHERE session_id = '${id}' ORDER BY position`,
    );
    const tagged = [
      ...(await rows(cwd, `SELECT 'suggested' AS kind, message_uuid, suggestion_text AS text FROM suggested_messages WHERE session_id = '${id}'`)),
      ...(await rows(cwd, `SELECT 'goal' AS kind, message_uuid, goal_text AS text FROM goal_messages WHERE session_id = '${id}'`)),
    ];
    const rec = {
      ...step,
      got: norm(
        {
          ...got,
          wrote: newWrote(id),
          events,
          queue,
          ...(tagged.length ? { tagged } : {}),
          ...(images
            ? {
                assets: await rows(cwd, "SELECT hash, media_type, size_bytes, width, height FROM assets ORDER BY hash"),
                uses: await rows(cwd, "SELECT asset_hash, session_id, message_uuid, ordinal FROM asset_uses ORDER BY asset_hash, message_uuid, ordinal"),
                files: storeFiles(cwd),
              }
            : {}),
        },
        cwd,
      ),
    };
    recorded.push(rec);
  }
  for (const unsub of attached) unsub();
  delete process.env.CLAUDIUS_SESSION_IDLE_REAP_MS;
  for (const id of [...logs.keys()]) {
    if (sessionManager.get(id)) await sessionManager.remove(id);
  }
  if (isList) rmSync(join(STATE_DIR, "accounts.json"), { force: true });
  scenarios.push({
    name: sc.name,
    id: idOf({}),
    settings,
    script,
    ...(sc.bin ? { bin: sc.bin } : {}),
    ...(multi ? { multi: true } : {}),
    ...(sc.wedged ? { wedged: true } : {}),
    ...(sc.reap ? { reap: true } : {}),
    ...(isList ? { accounts: ACCOUNTS } : {}),
    steps: recorded,
  });
}
delete process.env.FAKE_CLAUDE_SCRIPT;
rmSync(settingsFile, { force: true });

// ------------------------------ the reap window ------------------------------

// `reapMs()` as `setTimeout` takes it: the armed timer's `_idleTimeout` (node
// fires a delay past 2^31 - 1 ms after 1 ms).
const REAP_RAWS = [
  null,
  "",
  " ",
  "abc",
  "4999",
  "5000",
  " 6000 ",
  "\t7000\n",
  `${cp(0xa0)}6000`,
  `${cp(0xfeff)}6000`,
  `${cp(0x85)}6000`,
  "0x1388",
  "0X1388",
  "0b1001110001000",
  "0o11610",
  "-0x1388",
  "1e4",
  "1E4",
  ".5e4",
  "5000.",
  "5000.5",
  "+6000",
  "-1",
  "12_000",
  "6,000",
  "Infinity",
  "-Infinity",
  "infinity",
  "NaN",
  "2147483647",
  "2147483648",
  "3000000000",
  "1e400",
  "00006000",
];
const reapWindows = [];
for (const raw of REAP_RAWS) {
  if (raw === null) delete process.env.CLAUDIUS_SESSION_IDLE_REAP_MS;
  else process.env.CLAUDIUS_SESSION_IDLE_REAP_MS = raw;
  sessionManager.scheduleReap("s29-reap-probe");
  reapWindows.push({ raw, ms: sessionManager.reapTimers.get("s29-reap-probe")._idleTimeout });
  sessionManager.cancelReap("s29-reap-probe");
}
delete process.env.CLAUDIUS_SESSION_IDLE_REAP_MS;

// ---------------------- the last recorded permission mode ----------------------

const { lastRecordedPermissionMode } = await import(join(repo, "lib/server/session-resume.ts"));
const { projectRoot } = await import(join(repo, "lib/server/db.ts"));
const pmCwd = join(ROOT_DIR, "pm");
mkdirSync(pmCwd, { recursive: true });
mkdirSync(projectRoot(pmCwd), { recursive: true });
const L = (o) => JSON.stringify(o);
const u8 = (...parts) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p) : Buffer.from(p))));
const PM_CASES = [
  ["plain", L({ type: "user", permissionMode: "plan" }) + "\n"],
  ["the last one wins", [L({ type: "user", permissionMode: "plan" }), L({ type: "permission-mode", permissionMode: "acceptEdits" }), ""].join("\n")],
  ["a sidechain doesn't count", [L({ type: "user", permissionMode: "plan" }), L({ type: "user", permissionMode: "default", isSidechain: true }), ""].join("\n")],
  ["a truthy non-boolean isSidechain counts", [L({ type: "user", permissionMode: "plan" }), L({ type: "user", permissionMode: "auto", isSidechain: "true" }), ""].join("\n")],
  ["other types don't count", [L({ type: "user", permissionMode: "plan" }), L({ type: "assistant", permissionMode: "default" }), L({ permissionMode: "default" }), ""].join("\n")],
  ["a non-string mode doesn't count", [L({ type: "user", permissionMode: "plan" }), L({ type: "user", permissionMode: 1 }), L({ type: "user", permissionMode: null }), ""].join("\n")],
  ["any string counts", [L({ type: "user", permissionMode: "plan" }), L({ type: "user", permissionMode: "" }), ""].join("\n")],
  ["a duplicate key: the last one", '{"type":"user","permissionMode":"plan","permissionMode":"bypassPermissions"}\n'],
  ["a torn last line", L({ type: "user", permissionMode: "plan" }) + '\n{"type":"user","permissionMode":"defa'],
  ["no trailing newline", L({ type: "user", permissionMode: "plan" })],
  ["CRLF", [L({ type: "user", permissionMode: "default" }), L({ type: "user", permissionMode: "plan" }), ""].join("\r\n")],
  ["invalid UTF-8 before it", u8([0xff, 0xfe, 0x0a], L({ type: "user", permissionMode: "plan" }), "\n")],
  ["invalid UTF-8 inside it", u8('{"type":"user","note":"', [0xc3, 0x28], '","permissionMode":"plan"}\n')],
  ["a split character", u8('{"type":"user","note":"', [0xe2, 0x82], '","permissionMode":"plan"}\n')],
  ["a lone surrogate escape", '{"type":"user","note":"\\ud800","permissionMode":"plan"}\n'],
  ["a line separator inside", L({ type: "user", note: `a${cp(0x2028)}b${cp(0x2029)}c`, permissionMode: "plan" }) + "\n"],
  ["a BOM", `${cp(0xfeff)}${L({ type: "user", permissionMode: "plan" })}\n`],
  ["the key not as a key", L({ type: "user", text: '"permissionMode"' }) + "\n"],
  ["spaced JSON", '{ "type" : "user" , "permissionMode" : "plan" }\n'],
  ["empty", ""],
];
const permissionModes = [];
for (const [i, [label, content]] of PM_CASES.entries()) {
  const id = `pm-${i}`;
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  writeFileSync(join(projectRoot(pmCwd), `${id}.jsonl`), bytes);
  permissionModes.push({ label, id, base64: bytes.toString("base64"), mode: await lastRecordedPermissionMode(id, pmCwd) });
}
for (const id of ["pm-missing", "../pm-0", "pm.0", "pm 0", "", `pm${cp(0xe9)}`]) {
  permissionModes.push({ label: "a refused or missing id", id, mode: await lastRecordedPermissionMode(id, pmCwd) });
}

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(
  join(ROOT_DIR, "out.json"),
  JSON.stringify({
    sdkVersion,
    tz: process.env.TZ,
    workspaces: norm(WORKSPACES),
    unstarted,
    scenarios,
    reapWindows,
    permissionModes: { cwd: norm(pmCwd), cases: permissionModes },
    rejections: norm(rejections),
  }),
);
process.exit(0);
