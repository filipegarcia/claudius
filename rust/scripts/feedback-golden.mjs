#!/usr/bin/env node
// Golden fixture for the feedback survey's submit (G10): `POST/GET
// /api/feedback` (app/api/feedback/route.ts), lib/server/feedback-store.ts
// and lib/shared/feedback-refusal.ts, recorded from the real TS sources:
//
//   node rust/scripts/feedback-golden.mjs   (node@22: better-sqlite3, which
//                                            bun can't load; builds
//                                            claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd (db.ts reads the migrations from there), HOME and CLAUDE_CONFIG_DIR in
// a temp root and a resolve hook for the `@/` and extensionless imports,
// twice (two temp roots); both recordings must agree byte for byte. Records:
//
// - `refusals`: `feedbackRefusalReason(v)` and `interpretFeedbackResponse(v)`
//   over JSON values (`null` stands for `undefined` too: both functions treat
//   them alike). `reason` is the string or `null`; `interpret` the result.
// - `groups`: the real route handlers, in order, one group per world. Each
//   group's sessions (`sessions`, their ids) are bare
//   `Object.create(Session.prototype)` objects with `id`, the group's `cwd`
//   and a `query`: a real SDK `query()` against the fake CLI with the
//   group's `script` (`query: "live"`), one whose CLI exited after
//   `initialize` (`"exited"`), or none (`"none"`). `sessionManager.get` is
//   stubbed to them, and the cwd's database is opened first, as a started
//   session that a client subscribed to has it: read-write
//   (`Session.start()`) and read-only (`subscribe()`). Steps:
//   * `post`: the request body as text (`body`) and bytes (`bodyHex`; both
//     null for no body), the answer (`got`: status, content type and body
//     text, or `threw`, Next's empty 500), the `submit_feedback` control
//     requests the SDK wrote (`wire`, the request id as `$ID`), and the row
//     the POST added to the file on disk (`inserted`: its id and
//     `created_at`, or null). The request runs at its own `clock`
//     (`Date.now`) and `crypto.randomUUID` is a counter
//     (`00000000-0000-4000-a000-<n>`).
//   * `get`: the query string (`query`, null for none) and the answer.
//   * `sql`: hand-written SQL through the cwd's cached handle.
//   * `rows`: every `feedback` row in the file on disk (a fresh read-only
//     connection), by rowid, as `[typeof, value]` pairs (INTEGER as text,
//     BLOB as hex).
// - `store`: `insertFeedback` (`record`; `ok` or `threw`) and `listFeedback`
//   (`limit`; `items` as JSON text, or `threw`) called directly, on cwds no
//   session opened, with `sql`, `rows` (null without a file), `rmdb` (remove
//   the `.claudius.db` and its -wal and -shm; cached handles stay open) and
//   `dbdir` (a folder in its place) in between. `state`: what is at the
//   database path after the step (`none`, `file` or `dir`).
//
// Written to rust/crates/claudius-core/tests/fixtures/feedback_golden.json and
// replayed by crates/claudius-core/tests/feedback_golden.rs (`refusals`,
// `store`) and crates/claudius-server/tests/feedback.rs (`groups`, on the
// real binary).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, register, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/feedback_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.FEEDBACK_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "feedback-golden-")));
    try {
      mkdirSync(join(root, "home"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            FEEDBACK_GOLDEN_CHILD: root,
            FEEDBACK_GOLDEN_FAKE: fake,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stdout);
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
  const steps = fixture.groups.reduce((n, g) => n + g.steps.length, 0);
  const requests = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.op === "post" || s.op === "get").length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.refusals.length} refusal values, ${fixture.groups.length} groups (${steps} steps, ${requests} requests), ${fixture.store.length} store steps, SDK ${fixture.sdkVersion} (stable)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.FEEDBACK_GOLDEN_CHILD;
const FAKE = process.env.FEEDBACK_GOLDEN_FAKE;

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
export async function resolve(spec, ctx, next) {
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

// `randomUUID` (the route's row id) is a counter while a request runs.
const require = createRequire(import.meta.url);
const crypto = require("node:crypto");
const realRandomUUID = crypto.randomUUID;
let uuids = 0;
let pinned = false;
crypto.randomUUID = (...args) =>
  pinned ? `00000000-0000-4000-a000-${String(++uuids).padStart(12, "0")}` : realRandomUUID(...args);
syncBuiltinESMExports();
const realNow = Date.now;

const SDK = "@anthropic-ai/claude-agent-sdk";
const { query } = await import(SDK);
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve(SDK))), "package.json"), "utf8")).version;
const { Session } = await import(join(repo, "lib/server/session.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const { default: Database } = await import("better-sqlite3");
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const { feedbackRefusalReason, interpretFeedbackResponse } = await import(join(repo, "lib/shared/feedback-refusal.ts"));
const { insertFeedback, listFeedback } = await import(join(repo, "lib/server/feedback-store.ts"));
const route = await import(join(repo, "app/api/feedback/route.ts"));

// Non-ASCII without escapes in this file: a code point, and a JSON `\uXXXX`
// escape as text.
const cp = (n) => String.fromCodePoint(n);
const ju = (hex) => `${"\\"}u${hex}`;
const ESC = cp(0x1b);
const BEL = cp(7);
const BOM = cp(0xfeff);
const J = JSON.stringify;

// ------------------------------- refusals -------------------------------

const REASONS = [
  "Your organization does not accept feedback.",
  `${ESC}[31mYour organization${ESC}[0m does not accept feedback.`,
  `${ESC}[1;31;4mbold${ESC}[m ${ESC}[?25l${ESC}[2J${ESC}[ q`,
  `${ESC}]8;;https://example.com${BEL}a link${ESC}]8;;${BEL} done`,
  `${ESC}]0;title${ESC}\\after`,
  `${ESC}]unterminated ${ESC}x tail`,
  `${ESC}]open to the end`,
  `${ESC}[ unfinished csi`,
  `${ESC}M${ESC}7${ESC}c${ESC}_${ESC}\\${ESC}^${ESC}@${ESC}Z${ESC}[`,
  `${ESC}(B${ESC}a${ESC}${ESC}[0mx`,
  `${cp(0x9b)}31m c1 csi`,
  `a${cp(0)}b${cp(1)}${cp(2)}c${cp(7)}${cp(8)}d`,
  "tab\tnewline\nreturn\rform\fvt\u000b end",
  `del${cp(0x7f)}nel${cp(0x85)}c1${cp(0x9f)}x${cp(0xa0)}nbsp`,
  `line${cp(0x2028)}para${cp(0x2029)}ideo${cp(0x3000)}bom${BOM}zw${cp(0x200b)}mvs${cp(0x180e)}end`,
  `  padded  `,
  "",
  "   ",
  `${cp(0)}`,
  `${ESC}[0m`,
  "Report issues at https://github.com/anthropics/claude-code/issues",
  "Not accepted. Report issues at https://x/y",
  "Not accepted. report BUGS at https://x ",
  "Not accepted.\nReport bugs at\thttps://x\n",
  `Not accepted.${cp(0xa0)}Report issues at${cp(0x2028)}https://x`,
  "Report issues at",
  "Not accepted. Report issues at ",
  "Report issues at a b",
  "Report issues at a Report bugs at b",
  "xReport bugs at y",
  "Report  bugs  at  y",
  "Report issue at y",
  "Report issues on y",
  `${cp(0xff32)}eport bugs at y`,
  `Report i${cp(0x17f)}${cp(0x17f)}ues at y`,
  `Report ${cp(0x131)}ssues at y`,
  `REPORT ISSUES AT ${cp(0x1f600)}`,
  "a".repeat(199),
  "a".repeat(200),
  "a".repeat(201),
  "a".repeat(250),
  cp(0x1f600).repeat(200),
  cp(0x1f600).repeat(201),
  `${"b".repeat(198)}${cp(0x1f600)}${cp(0x1f601)}tail`,
  `e${cp(0x301)}`.repeat(120),
  `${"c".repeat(230)} Report issues at https://x`,
  `${ESC}[31m${"d".repeat(205)}${ESC}[0m`,
  `caf${cp(0xe9)} ${cp(0x4e2d)}${cp(0x6587)} "q" \\ </b>`,
];
const OTHER = [
  null,
  0,
  5,
  -1.5,
  true,
  false,
  [],
  ["x"],
  {},
  { message: "From a message field." },
  { message: `${ESC}[33mwarn${ESC}[0m Report bugs at https://z` },
  { message: 5 },
  { message: null },
  { message: { message: "nested" } },
  { message: "   " },
  { error: "not a message" },
  { message: "m", error: "e" },
];
const RESPONSES = [
  null,
  0,
  1,
  "",
  "x",
  true,
  false,
  [],
  [1],
  [{ feedback_id: "fb" }],
  {},
  { feedback_id: "fb" },
  { feedback_id: "" },
  { feedback_id: 5 },
  { feedback_id: true },
  { feedback_id: null },
  { feedback_id: ["fb"] },
  { feedback_id: null, unavailable_reason: "Your organization does not accept feedback." },
  { unavailable_reason: "" },
  { unavailable_reason: "   " },
  { unavailable_reason: 5 },
  { unavailable_reason: 0 },
  { unavailable_reason: false },
  { unavailable_reason: [] },
  { unavailable_reason: {} },
  { unavailable_reason: { message: "m" } },
  { unavailable_reason: { message: "" } },
  { unavailable_reason: null, failure_reason: "http_error" },
  { failure_reason: "http_error" },
  { failure_reason: "" },
  { failure_reason: 0 },
  { failure_reason: false },
  { failure_reason: null },
  { failure_reason: {} },
  { feedback_id: "fb", unavailable_reason: "r" },
  { feedback_id: "", unavailable_reason: "r", failure_reason: "f" },
  { failure_reason: "f", unavailable_reason: "r" },
  { feedback_id: null, unavailable_reason: `${ESC}[1mOff${ESC}[0m. Report issues at https://x`, failure_reason: "f" },
  { FEEDBACK_ID: "fb", Unavailable_Reason: "r" },
];
const refusals = [...REASONS, ...OTHER, ...RESPONSES].map((v) => {
  const reason = feedbackRefusalReason(v);
  return { v, reason: reason ?? null, interpret: interpretFeedbackResponse(v) };
});

// ------------------------------- bare sessions -------------------------------

let qdirs = 0;
/** A real SDK query against the fake CLI, as a bare session's `query`. */
async function openQuery(script) {
  const dir = join(ROOT_DIR, `q${qdirs++}`);
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
        ...(script ? { FAKE_CLAUDE_SCRIPT: J(script) } : {}),
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

const readLines = (f) => {
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** The `submit_feedback` control requests written since line `from`, ids as `$ID`. */
function wireSince(log, from) {
  return readLines(log)
    .slice(from)
    .filter((l) => {
      const m = JSON.parse(l);
      return m.type === "control_request" && m.request?.subtype === "submit_feedback";
    })
    .map((l) => l.replace(J(JSON.parse(l).request_id), '"$ID"'));
}

// ------------------------------- the database -------------------------------

// The project dir name of a short ASCII cwd (`encodeProjectDir`).
const dirName = (abs) => abs.replace(/[^a-zA-Z0-9]/g, "-");
const dbFile = (cwd) => join(process.env.HOME, ".claude", "projects", dirName(cwd), ".claudius.db");
const COLS = ["id", "session_id", "cwd", "rating", "comment", "surface", "forwarded", "attach_transcript", "created_at"];
const ROWS_SQL = `SELECT ${COLS.map(
  (c) => `typeof(${c}), CASE typeof(${c}) WHEN 'integer' THEN CAST(${c} AS TEXT) WHEN 'blob' THEN hex(${c}) ELSE ${c} END`,
).join(", ")} FROM feedback ORDER BY rowid`;

/**
 * `sql`'s rows in the file on disk, through a fresh read-only connection:
 * what the replay sees too (not the rows a cached handle wrote to an
 * unlinked file). Null when the file or the statement fails.
 */
function onDisk(cwd, sql) {
  let db;
  try {
    db = new Database(dbFile(cwd), { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    return db.prepare(sql).raw().all();
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function dumpRows(cwd) {
  const rows = onDisk(cwd, ROWS_SQL);
  if (!rows) throw new Error(`no rows to dump in ${cwd}`);
  return JSON.parse(J(rows));
}

/** `[JSON id, created_at]` of every row on disk. */
const rowKeys = (cwd) => (onDisk(cwd, "SELECT id, created_at FROM feedback") ?? []).map(([id, at]) => [J(id), at]);

// ------------------------------- route steps -------------------------------

const BASE = 1_700_000_000_000; // before any real clock the replay runs at
let tick = 0;

async function call(fn, clock) {
  Date.now = () => clock;
  pinned = true;
  try {
    const res = await fn();
    return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  } finally {
    Date.now = realNow;
    pinned = false;
  }
}

async function runStep(g, hosts, s) {
  if (s.op === "sql") {
    (await openDb(g.cwd)).exec(s.sql);
    return s;
  }
  if (s.op === "rows") return { ...s, got: dumpRows(g.cwd) };
  tick += 1;
  const clock = BASE + tick * 1000;
  if (s.op === "get") {
    const url = `http://localhost/api/feedback${s.query === null ? "" : `?${s.query}`}`;
    return { ...s, clock, got: await call(() => route.GET(new Request(url)), clock) };
  }
  const bytes =
    s.body === null ? null : typeof s.body === "string" ? Buffer.from(s.body, "utf8") : Buffer.from(s.body.hex, "hex");
  const logs = [...hosts.values()].filter((h) => h.q).map((h) => [h.q.log, readLines(h.q.log).length]);
  const before = new Set(rowKeys(g.cwd).map(([id]) => id));
  const got = await call(
    () =>
      route.POST(
        new Request("http://localhost/api/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          ...(bytes ? { body: bytes } : {}),
        }),
      ),
    clock,
  );
  const added = rowKeys(g.cwd).filter(([id]) => !before.has(id));
  if (added.length > 1) throw new Error(`step ${tick}: ${added.length} rows added`);
  return {
    op: "post",
    body: typeof s.body === "string" ? s.body : null,
    bodyHex: bytes === null ? null : bytes.toString("hex"),
    clock,
    got,
    wire: logs.flatMap(([log, from]) => wireSince(log, from)),
    inserted: added.length ? { id: JSON.parse(added[0][0]), createdAt: added[0][1] } : null,
  };
}

// The CLI exits once it has answered `initialize`.
const EXIT_SCRIPT = { on_init: [{ $stderr: "boom" }, { $exit: 3 }] };

async function runGroup(g) {
  const hosts = new Map();
  for (const id of g.sessions) {
    const host = Object.create(Session.prototype);
    host.id = id;
    host.cwd = g.cwd;
    host.query = null;
    let q = null;
    if (g.query !== "none") {
      q = await openQuery(g.script);
      host.query = q.q;
      if (g.query === "exited") await q.drained;
    }
    hosts.set(id, { host, q });
  }
  sessionManager.get = (id) => hosts.get(id)?.host;
  // A started session has its cwd's database open (`Session.start()`'s
  // `upsertSession`), and read-only too once a client subscribed
  // (`subscribe()`'s `sendTaskSnapshot`).
  await openDb(g.cwd);
  await openDb(g.cwd, "readonly");
  const steps = [];
  for (const s of g.steps) steps.push(await runStep(g, hosts, s));
  for (const { q } of hosts.values()) if (q && g.query === "live") await q.close();
  return { name: g.name, query: g.query, script: g.script, cwd: g.cwd, sessions: g.sessions, steps };
}

// ------------------------------- the groups -------------------------------

const sid = (n) => `fb000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const S1 = sid(1);
const S2 = sid(2);
const NOT_LIVE = sid(99);
const cwdOf = (name) => `/claudius-golden/feedback-${name}`;
/** A body: a string as written, anything else as its JSON text. */
const P = (v) => ({ op: "post", body: typeof v === "string" ? v : J(v) });
const HEX = (hex) => ({ op: "post", body: { hex } });
const hexOf = (s) => Buffer.from(s, "utf8").toString("hex");
const G = (q) => ({ op: "get", query: q });
const ROWS = { op: "rows" };
const SQL = (sql) => ({ op: "sql", sql });
const DEEP = `${"[".repeat(130)}${"]".repeat(130)}`;
const UNICODE = `caf${cp(0xe9)} ${cp(0x4e2d)}${cp(0x6587)} ${cp(0x1f600)} e${cp(0x301)} ${cp(0x2028)}mid${cp(0x2029)} </script> "q" \\ end`;
const CONTROL = `a${cp(0)}b${cp(1)}c${cp(0x1f)}d${cp(0x7f)}e${cp(0x85)}f${ESC}[31mred`;
const TRIMMED = ` \t\n\r${cp(0xa0)}${cp(0x1680)}${cp(0x2000)}${cp(0x200a)}${cp(0x2028)}${cp(0x2029)}${cp(0x202f)}${cp(0x205f)}${cp(0x3000)}${BOM} `;

const VALIDATION = [
  // GET: a live session's id or 404.
  G(null),
  G(""),
  G("sessionId="),
  G(`sessionId=${NOT_LIVE}`),
  G(`sessionid=${S1}`),
  G(`sessionId=${S1.toUpperCase()}`),
  G(`sessionId=%20${S1}`),
  G(`sessionId=${S1}`),
  // POST: neither a comment nor a rating is 400, before the session lookup.
  { op: "post", body: null },
  P(""),
  P("{"),
  P("null"),
  P("[]"),
  P("5"),
  P('"x"'),
  P("true"),
  P("{}"),
  P({ comment: "" }),
  P({ comment: "   " }),
  P({ comment: TRIMMED }),
  P({ comment: 5 }),
  P({ comment: null }),
  P({ comment: ["x"] }),
  P({ comment: { x: 1 } }),
  P({ comment: true }),
  P({ rating: "UP" }),
  P({ rating: "up " }),
  P({ rating: "meh" }),
  P({ rating: 1 }),
  P({ rating: true }),
  P({ rating: ["up"] }),
  P({ rating: null }),
  P({ Comment: "x", Rating: "up", sessionId: S1 }),
  P(`{"comment":"x","sessionId":"${S1}"} trailing`),
  P(`{"comment":"x","sessionId":"${S1}"`),
  P(`[{"comment":"x","sessionId":"${S1}"}]`),
  P('"comment"'),
  P(`{'comment':'x'}`),
  HEX("c080"),
  HEX(hexOf(`{"comment":"x","sessionId":"${S1}"}`).slice(0, -2)),
  // A comment or rating but no live session: 409, nothing stored.
  P({ comment: "x" }),
  P({ rating: "up" }),
  P({ rating: "down" }),
  P({ comment: "x", sessionId: "" }),
  P({ comment: "x", sessionId: 5 }),
  P({ comment: "x", sessionId: null }),
  P({ comment: "x", sessionId: true }),
  P({ comment: "x", sessionId: [S1] }),
  P({ comment: "x", sessionId: { id: S1 } }),
  P({ comment: "x", sessionId: NOT_LIVE }),
  P({ comment: "x", sessionId: S1.toUpperCase() }),
  P({ comment: "x", sessionId: ` ${S1}` }),
  P({ comment: "x", sessionId: `${S1}\n` }),
  P({ comment: "x", sessionid: S1 }),
  P({ comment: "x", session_id: S1 }),
  P({ comment: cp(0x85), sessionId: NOT_LIVE }),
  P({ comment: cp(0x200b) }),
  P({ comment: cp(0x180e), rating: "UP" }),
  P(`{"comment":"x","sessionId":"${ju("d800")}"}`),
  P(`{"comment":"${ju("d83d")}"}`),
  P(`{"rating":"up","sessionId":"${NOT_LIVE}","deep":${DEEP}}`),
  // Stored and forwarded (the fake's canned `{}` reply: sent).
  P({ comment: "  works great  ", sessionId: S1 }),
  P({ rating: "up", sessionId: S1 }),
  P({ rating: "down", sessionId: S1, comment: TRIMMED }),
  P({ rating: "down", comment: "slow", sessionId: S1, surface: "survey", attachTranscript: true }),
  P({ rating: "up", comment: "x", sessionId: S1, surface: "" }),
  P({ comment: "surface number", sessionId: S1, surface: 5 }),
  P({ comment: "surface null", sessionId: S1, surface: null }),
  P({ comment: "surface spaced", sessionId: S1, surface: "  s  " }),
  P({ comment: "attach string", sessionId: S1, attachTranscript: "true" }),
  P({ comment: "attach one", sessionId: S1, attachTranscript: 1 }),
  P({ comment: "attach false", sessionId: S1, attachTranscript: false }),
  P({ rating: "meh", comment: "bad rating", sessionId: S1 }),
  P({ rating: "down", comment: 5, sessionId: S1 }),
  P({ comment: UNICODE, sessionId: S1, surface: UNICODE }),
  P({ comment: CONTROL, sessionId: S1 }),
  P({ comment: `${cp(0x85)}nel kept${cp(0x85)}`, sessionId: S1 }),
  P({ comment: "x".repeat(5000), sessionId: S1 }),
  P(`${BOM}{"comment":"bom","sessionId":"${S1}"}`),
  P(`${BOM}${BOM}{"comment":"two boms","sessionId":"${S1}"}`),
  P(`${BOM}${BOM}${BOM}{"comment":"three boms","sessionId":"${S1}"}`),
  P(` \r\n {"comment":"spaced","sessionId":"${S1}"} \n`),
  P(`{"comment":"first","comment":"second","sessionId":"${NOT_LIVE}","sessionId":"${S1}"}`),
  P(`{"comment":"inf","rating":1e400,"sessionId":"${S1}","attachTranscript":1e400,"surface":-1e400}`),
  P(`{"__proto__":{"comment":"proto"},"rating":"up","sessionId":"${S1}"}`),
  P(`{"comment":"escaped ${ju("0041")}${ju("00e9")}${ju("d83d")}${ju("de00")}","sessionId":"${S1}"}`),
  HEX(`${hexOf('{"comment":"bad ')}ff${hexOf(` byte","sessionId":"${S1}"}`)}`),
  P({ comment: "from two", sessionId: S2, rating: "up" }),
  ROWS,
  // GET: `limit` is `Number(limit)`, 100 unless finite and > 0, at most 500.
  G(`sessionId=${S1}`),
  G(`sessionId=${S2}&limit=2`),
  G(`sessionId=${S1}&limit=0`),
  G(`sessionId=${S1}&limit=-1`),
  G(`sessionId=${S1}&limit=abc`),
  G(`sessionId=${S1}&limit=`),
  G(`sessionId=${S1}&limit`),
  G(`sessionId=${S1}&limit=Infinity`),
  G(`sessionId=${S1}&limit=-Infinity`),
  G(`sessionId=${S1}&limit=1e3`),
  G(`sessionId=${S1}&limit=0x3`),
  G(`sessionId=${S1}&limit=%201%20`),
  G(`sessionId=${S1}&limit=+2`),
  G(`sessionId=${S1}&limit=%2B2`),
  G(`sessionId=${S1}&limit=2.0`),
  G(`sessionId=${S1}&limit=3.`),
  G(`sessionId=${S1}&limit=1_0`),
  G(`limit=1&sessionId=${S1}&limit=3`),
  G(`sessionId=${S1}&limit=1.5`),
  G(`sessionId=${S1}&limit=0.5`),
  G(`sessionId=${S1}&limit=1e-7`),
  G(`sessionId=${S1}&limit=5e-324`),
  G(`sessionId=${S2}&sessionId=${NOT_LIVE}`),
  G(`sessionId=${NOT_LIVE}&sessionId=${S1}`),
  G(`sessionId=${S1}&limit=1&extra=%ZZ&sessionId=x`),
];

const REPLIES = [
  { feedback_id: "fb_123" },
  { feedback_id: null, unavailable_reason: "Your organization does not accept feedback." },
  {
    feedback_id: null,
    unavailable_reason: `${ESC}[1;31mFeedback is disabled${ESC}[0m for this org.\nReport issues at https://github.com/anthropics/claude-code/issues`,
  },
  { unavailable_reason: "x".repeat(300) },
  { unavailable_reason: `  ${cp(0)}\t ${ESC}[0m ` },
  { failure_reason: "http_error" },
  { unavailable_reason: { message: "From a message field." } },
  { unavailable_reason: 5 },
  { feedback_id: "" },
  { feedback_id: 5, failure_reason: 0 },
  null,
  "str",
  [1, 2],
  {},
  { $error: "feedback disabled" },
  { feedback_id: "fb_2", unavailable_reason: "ignored" },
  {
    unavailable_reason: `${ESC}]8;;https://example.com${BEL}a link${ESC}]8;;${BEL} and text. Report bugs at https://example.com/bugs`,
  },
  { unavailable_reason: cp(0x1f600).repeat(205) },
  { unavailable_reason: `tabs\tand${cp(0xa0)}nbsp${cp(0x2028)}lines${cp(0x85)}nel "q" \\` },
  { unavailable_reason: "" },
  { unavailable_reason: false },
  { unavailable_reason: null, failure_reason: null },
  { feedback_id: null, unavailable_reason: null, failure_reason: "quota" },
];

const FOREIGN = `INSERT INTO feedback(id, session_id, cwd, rating, comment, surface, forwarded, attach_transcript, created_at) VALUES
  ('f-text-flags', 'other-session', '/elsewhere', 'sideways', NULL, NULL, 'yes', '1', 5),
  (X'00ff', NULL, NULL, NULL, X'6869', 'survey', 1.0, 2, 1.5),
  (42, 7, NULL, 'up', 'c', 3.5, 1, 1, 9e999),
  ('f-neg', NULL, NULL, 'down', '', '', 0, 0, -9e999),
  ('f-text-time', NULL, NULL, NULL, 'late', NULL, 0, 1, 'soon'),
  ('f-big', NULL, NULL, NULL, 'big', NULL, 1, 0, 9007199254740993),
  ('f-real-flag', NULL, NULL, NULL, 'real', NULL, 1.5, X'01', 0),
  ('f-utf8', NULL, NULL, CAST(X'75c3' AS TEXT), CAST(X'c328ff' AS TEXT), NULL, 0, 0, -1);`;

const BULK = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 520)
INSERT INTO feedback(id, session_id, cwd, rating, comment, surface, forwarded, attach_transcript, created_at)
SELECT printf('b%03d', i), NULL, NULL, NULL, NULL, NULL, i % 2, 0, i FROM n;`;

const GROUPS = [
  { name: "validation", query: "live", script: null, sessions: [S1, S2], steps: VALIDATION },
  {
    name: "replies",
    query: "live",
    script: { control: { submit_feedback: { $sequence: REPLIES } } },
    sessions: [S1, S2],
    steps: [
      ...REPLIES.map((_, i) => P({ comment: `reply ${i + 1}`, sessionId: S1, rating: i % 2 ? "down" : "up" })),
      P({ comment: "the other CLI", sessionId: S2 }),
      ROWS,
      G(`sessionId=${S1}&limit=50`),
    ],
  },
  {
    name: "database",
    query: "live",
    script: null,
    sessions: [S1],
    steps: [
      G(`sessionId=${S1}`),
      P({ comment: "first row", sessionId: S1, rating: "up" }),
      G(`sessionId=${S1}`),
      ROWS,
      // Rows only another writer could store.
      SQL(FOREIGN),
      ROWS,
      G(`sessionId=${S1}`),
      G(`sessionId=${S1}&limit=3`),
      P({ comment: "after foreign", sessionId: S1, attachTranscript: true }),
      G(`sessionId=${S1}&limit=5`),
      // No table: the write is swallowed, the read throws.
      SQL("DROP TABLE feedback;"),
      P({ comment: "no table", sessionId: S1 }),
      G(`sessionId=${S1}`),
      // A table without column types: every number stays the REAL it was bound as.
      SQL(
        "CREATE TABLE feedback (id, session_id, cwd, rating, comment, surface, forwarded, attach_transcript, created_at);",
      ),
      P({ comment: "typeless", sessionId: S1, rating: "down", attachTranscript: true }),
      P({ comment: "typeless two", sessionId: S1 }),
      ROWS,
      G(`sessionId=${S1}`),
      // A table from before migration 015 (no attach_transcript).
      SQL(
        "DROP TABLE feedback; CREATE TABLE feedback (id TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, rating TEXT, comment TEXT, surface TEXT, forwarded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);",
      ),
      P({ comment: "pre-015 table", sessionId: S1 }),
      G(`sessionId=${S1}`),
    ],
  },
  {
    name: "bulk",
    query: "live",
    script: null,
    sessions: [S1],
    steps: [
      SQL(BULK),
      G(`sessionId=${S1}`),
      G(`sessionId=${S1}&limit=1e9`),
      G(`sessionId=${S1}&limit=500.5`),
      G(`sessionId=${S1}&limit=499.5`),
      P({ comment: "newest", sessionId: S1 }),
      G(`sessionId=${S1}&limit=2`),
    ],
  },
  {
    name: "exited",
    query: "exited",
    script: EXIT_SCRIPT,
    sessions: [S1],
    steps: [
      P({ comment: "cli gone", sessionId: S1, rating: "down", attachTranscript: true }),
      P({ rating: "up", sessionId: S1 }),
      G(`sessionId=${S1}`),
      ROWS,
    ],
  },
  {
    name: "no query",
    query: "none",
    script: null,
    sessions: [S1],
    steps: [P({ comment: "never started", sessionId: S1 }), G(`sessionId=${S1}`), ROWS],
  },
].map((g) => ({ ...g, cwd: cwdOf(g.name.replace(/ /g, "-")) }));

const groups = [];
for (const g of GROUPS) groups.push(await runGroup(g));

// --------------------------------- store ---------------------------------

const dbState = (cwd) => {
  try {
    return statSync(dbFile(cwd)).isDirectory() ? "dir" : "file";
  } catch {
    return "none";
  }
};
const ST = {
  none: "/claudius-golden/store-none",
  dir: "/claudius-golden/store-dir",
  a: "/claudius-golden/store-a",
  ghost: "/claudius-golden/store-ghost",
};
const rec = (id, o = {}) => ({
  id,
  sessionId: "s-1",
  rating: null,
  comment: "",
  surface: "claudius",
  forwarded: false,
  attachTranscript: false,
  createdAt: 1,
  ...o,
});
const STORE = [
  // No database: the list's read-only open fails, and creates nothing.
  { op: "list", cwd: ST.none, limit: 100 },
  // A folder where the file goes: the insert's open fails, swallowed.
  { op: "dbdir", cwd: ST.dir },
  { op: "insert", cwd: ST.dir, record: rec("d1") },
  { op: "list", cwd: ST.dir, limit: 100 },
  // The first insert creates and migrates the database.
  { op: "insert", cwd: ST.a, record: rec("a1") },
  {
    op: "insert",
    cwd: ST.a,
    record: rec("a2", {
      sessionId: null,
      rating: "up",
      comment: "c2",
      surface: null,
      forwarded: true,
      attachTranscript: true,
      createdAt: 3,
    }),
  },
  { op: "insert", cwd: ST.a, record: rec("a3", { rating: "down", comment: UNICODE, surface: "", createdAt: 2 }) },
  { op: "insert", cwd: ST.a, record: rec("a4", { rating: "sideways", comment: CONTROL, createdAt: 2 }) },
  { op: "insert", cwd: ST.a, record: rec("a5", { createdAt: 1.5 }) },
  { op: "insert", cwd: ST.a, record: rec("a6", { createdAt: -5 }) },
  { op: "insert", cwd: ST.a, record: rec("a7", { createdAt: 1e300 }) },
  { op: "insert", cwd: ST.a, record: rec("a8", { createdAt: 9007199254740993 }) },
  { op: "insert", cwd: ST.a, record: rec("a9", { createdAt: 1793000000000.5, forwarded: true }) },
  { op: "insert", cwd: ST.a, record: rec("", { createdAt: 0 }) },
  // The same id again: the constraint's error.
  { op: "insert", cwd: ST.a, record: rec("a1", { comment: "again" }) },
  { op: "rows", cwd: ST.a },
  ...[100, 1, 3, 500, 0, -1, 2.5, 0.5, 1e300, 2 ** 53].map((limit) => ({ op: "list", cwd: ST.a, limit })),
  // Removed under its cached handles: both stay on the unlinked file.
  { op: "insert", cwd: ST.ghost, record: rec("g1") },
  { op: "list", cwd: ST.ghost, limit: 100 },
  { op: "rmdb", cwd: ST.ghost },
  { op: "insert", cwd: ST.ghost, record: rec("g2", { createdAt: 2 }) },
  { op: "list", cwd: ST.ghost, limit: 100 },
  { op: "rows", cwd: ST.ghost },
  { op: "dbdir", cwd: ST.ghost },
  { op: "insert", cwd: ST.ghost, record: rec("g3", { createdAt: 3 }) },
  { op: "list", cwd: ST.ghost, limit: 2 },
  // No table, then an older one: the statements' errors.
  { op: "sql", cwd: ST.a, sql: "DROP TABLE feedback;" },
  { op: "insert", cwd: ST.a, record: rec("a10") },
  { op: "list", cwd: ST.a, limit: 100 },
  { op: "sql", cwd: ST.a, sql: "CREATE TABLE feedback (id TEXT PRIMARY KEY, created_at INTEGER);" },
  { op: "insert", cwd: ST.a, record: rec("a11") },
  { op: "list", cwd: ST.a, limit: 100 },
];
const threwOf = (e) => ({ threw: e instanceof Error ? e.message : String(e) });
const store = [];
for (const s of STORE) {
  let out = {};
  if (s.op === "insert") {
    out = await insertFeedback(s.cwd, s.record).then(
      () => ({ ok: true }),
      (e) => threwOf(e),
    );
  } else if (s.op === "list") {
    out = await listFeedback(s.cwd, s.limit).then(
      (items) => ({ items: J(items) }),
      (e) => threwOf(e),
    );
  } else if (s.op === "rows") {
    const rows = onDisk(s.cwd, ROWS_SQL);
    out = { got: rows && JSON.parse(J(rows)) };
  } else if (s.op === "sql") {
    (await openDb(s.cwd)).exec(s.sql);
  } else if (s.op === "dbdir") {
    mkdirSync(dbFile(s.cwd), { recursive: true });
  } else {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile(s.cwd) + suffix, { recursive: true, force: true });
  }
  store.push({ ...s, ...out, state: dbState(s.cwd) });
}

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), J({ sdkVersion, now: BASE, refusals, groups, store }));
process.exit(0);
