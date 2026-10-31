#!/usr/bin/env node
// Golden fixture for the session's MCP notices (S15b), recorded from the TS
// sources:
//
//   node rust/scripts/mcp-notices-golden.mjs   (node@22: the DB modules need
//                                               better-sqlite3, which bun
//                                               can't load; builds
//                                               claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME at a temp
// dir, the repo as its cwd (db.ts reads the migrations from
// `process.cwd()/lib/server/db-migrations`) and a resolve hook for the
// extensionless / `@/` imports, twice (two temp roots); both recordings must
// agree byte for byte. `Date.now` is pinned per step. Records:
//
// - `due`: `mcpRecheckDue(now, lastAt[, intervalMs])` (lib/server/session.ts)
//   at its edges. Numbers JSON can't hold are written as strings ("NaN",
//   "Infinity", "-Infinity"); a missing `interval` is the default.
// - `db`: `syncNeedsAuthNotifications` / `syncDisconnectedNotifications`
//   (mcp-needs-auth-db.ts, mcp-disconnected-db.ts) over sequences of
//   observations, per case on its own cwds (strings, not directories). Each
//   step: what it returned (`announce`) or that it rejected (`threw`), and
//   then the rows of both tables for every cwd of the case
//   (`[rowid, typeof(server_name), hex(server_name), notified_at,
//   typeof(notified_at)]` by rowid; null when the database or the table
//   can't be read). `seed` prepares a cwd first: `block` puts a file where
//   its project dir goes (openDb fails: fail open), `v999` writes a
//   database whose schema_meta claims version 999 and has no tables (the
//   sync throws), `sql` runs statements on the opened database.
// - `sessions`: the real `Session.prototype` methods
//   `noteMcpNeedsAuthAtStartup`, `noteMcpDisconnectedAtStartup` and
//   `recheckMcpStatusMidSession` on a bare session object (the class fields
//   they read set to their initial values, `broadcast` recorded) whose
//   `query` is a real SDK `query()` against the fake CLI. A small consume
//   loop calls them where `Session` does: the notes on a live
//   `system/init`, the re-check on every `result`. The fake answers the
//   n-th `mcp_status` request with the n-th `replies` entry (the last one
//   repeats). Sessions of a case run in order and share its cwds (real
//   directories, created per run). Steps: `start` (the CLI's init), then
//   one `turn` per prompt, each at its pinned clock. After each step, once
//   every check it started has settled: the `events` broadcast, the
//   `mcp_status` requests written (`wire`, ids as `$ID`) and the `rows` of
//   the session's cwd.
//
// Written to rust/crates/claudius-core/tests/fixtures/mcp_notices_golden.json
// and replayed by crates/claudius-core/tests/mcp_notices.rs.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/mcp_notices_golden.json");

// ------------------------------- recording -------------------------------

if (!process.env.MCP_NOTICES_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-notices-golden-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            MCP_NOTICES_GOLDEN_CHILD: root,
            MCP_NOTICES_GOLDEN_FAKE: fake,
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
  const dbSteps = fixture.db.reduce((n, c) => n + c.steps.length, 0);
  const sessions = fixture.sessions.reduce((n, c) => n + c.sessions.length, 0);
  const sessionSteps = fixture.sessions.reduce(
    (n, c) => n + c.sessions.reduce((m, s) => m + s.steps.length, 0),
    0,
  );
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.due.length} due cases, ${fixture.db.length} db cases (${dbSteps} steps), ${fixture.sessions.length} session cases (${sessions} sessions, ${sessionSteps} steps; SDK ${fixture.sdkVersion})`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT_DIR = process.env.MCP_NOTICES_GOLDEN_CHILD;
const FAKE = process.env.MCP_NOTICES_GOLDEN_FAKE;

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

const SDK = "@anthropic-ai/claude-agent-sdk";
const { Session, mcpRecheckDue } = await import(join(repo, "lib/server/session.ts"));
const { syncNeedsAuthNotifications } = await import(join(repo, "lib/server/mcp-needs-auth-db.ts"));
const { syncDisconnectedNotifications } = await import(join(repo, "lib/server/mcp-disconnected-db.ts"));
const { openDb } = await import(join(repo, "lib/server/db.ts"));
const { encodeProjectDir } = await import(join(repo, "lib/server/auto-memory.ts"));
const { default: Database } = await import("better-sqlite3");
const { query } = await import(SDK);
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.resolve(SDK))), "package.json"), "utf8"),
).version;

let CLOCK = 0;
Date.now = () => CLOCK;

const HOME = process.env.HOME;
const projectDir = (cwd) => join(HOME, ".claude", "projects", encodeProjectDir(cwd));
const TABLES = { needsAuth: "mcp_needs_auth_notified", disconnected: "mcp_disconnected_notified" };
const SYNC = { needsAuth: syncNeedsAuthNotifications, disconnected: syncDisconnectedNotifications };
const V999 =
  "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES('version', '999');";

async function seed(s) {
  if (s.kind === "block") {
    mkdirSync(dirname(projectDir(s.cwd)), { recursive: true });
    writeFileSync(projectDir(s.cwd), "");
  } else if (s.kind === "v999") {
    mkdirSync(projectDir(s.cwd), { recursive: true });
    const db = new Database(join(projectDir(s.cwd), ".claudius.db"));
    db.exec(V999);
    db.close();
  } else {
    (await openDb(s.cwd)).exec(s.sql);
  }
}

async function tableRows(cwd, table) {
  try {
    const db = await openDb(cwd);
    return db
      .prepare(
        `SELECT rowid, typeof(server_name) AS t, hex(server_name) AS h, notified_at AS n, typeof(notified_at) AS nt FROM ${table} ORDER BY rowid`,
      )
      .all()
      .map((r) => [r.rowid, r.t, r.h, r.n, r.nt]);
  } catch {
    return null;
  }
}

async function rowsOf(cwd) {
  return { needsAuth: await tableRows(cwd, TABLES.needsAuth), disconnected: await tableRows(cwd, TABLES.disconnected) };
}

// ------------------------------- mcpRecheckDue -------------------------------

const T = 1_761_500_000_000;
const DUE = [
  [1_000_000, 1_000_000],
  [1_000_000, 970_001],
  [1_000_000, 970_000],
  [1_000_000, 969_999],
  [1_000_000, 880_000],
  [30_000, 0],
  [29_999, 0],
  [30_001, 0],
  [0, 0],
  [T, 0],
  [T, T - 29_999],
  [T, T - 30_000],
  [T, T],
  [T, T + 1],
  [1_000, 2_000],
  [5_000, 0, 10_000],
  [10_000, 0, 10_000],
  [10_001, 0, 10_000],
  [5, 5, 0],
  [4, 5, 0],
  [1_000, 2_000, -1_000],
  [1_000, 2_000, -1_001],
  [30_000.5, 0.5],
  [30_000.4, 0.5],
  [30_000.25, 0, 30_000.25],
  [0.1 + 0.2, 0, 0.3],
  [Number.MAX_SAFE_INTEGER, 0],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 30_000],
  [1e300, -1e300],
  [Number.MAX_VALUE, -Number.MAX_VALUE],
  [-30_000, -60_000],
  [-30_000, -59_999],
  [NaN, 0],
  [1_000, NaN],
  [1_000, 0, NaN],
  [Infinity, 0],
  [Infinity, Infinity],
  [-Infinity, 0],
  [0, -Infinity],
  [0, Infinity],
  [Infinity, 0, Infinity],
  [0, 0, -Infinity],
  [-0, 0, 0],
];
const enc = (x) => (typeof x === "number" && !Number.isFinite(x) ? String(x) : x);
const due = DUE.map(([now, lastAt, interval]) => ({
  now: enc(now),
  lastAt: enc(lastAt),
  ...(interval === undefined ? {} : { interval: enc(interval) }),
  due: interval === undefined ? mcpRecheckDue(now, lastAt) : mcpRecheckDue(now, lastAt, interval),
}));

// ------------------------------- the DB modules -------------------------------

const LONG = "srv-".repeat(600);
const MANY = Array.from({ length: 40 }, (_, i) => `server-${i}`);
const ODD_NAMES = [
  "",
  "unknown",
  " ",
  "A",
  "a",
  "s\u00EBrv\u00E9r",
  "\u{1F600}",
  "a\nb",
  "\u0000nul",
  "\u00A0\uFEFF\u2028",
  "it's",
  'q"d',
  "back\\slash",
  "%_",
  LONG,
];
const n = (cwd, servers, clock) => ["needsAuth", cwd, servers, clock];
const d = (cwd, servers, clock) => ["disconnected", cwd, servers, clock];
const C = (name, label = "p") => `/golden-mcp/${name}/${label}`;

const DB_CASES = [
  { name: "once", steps: [n(C("once"), ["github"], 1000), n(C("once"), ["github"], 2000), n(C("once"), ["github"], 3000)] },
  {
    name: "only the new one",
    steps: [
      n(C("new"), ["github"], 1000),
      n(C("new"), ["github", "linear"], 2000),
      n(C("new"), ["linear", "github"], 3000),
      n(C("new"), ["slack", "linear", "github"], 4000),
    ],
  },
  {
    name: "clear and re-announce",
    steps: [
      n(C("clear"), ["github"], 1000),
      n(C("clear"), [], 2000),
      n(C("clear"), [], 3000),
      n(C("clear"), ["github"], 4000),
      n(C("clear"), ["github"], 5000),
    ],
  },
  {
    name: "partial clear",
    steps: [
      d(C("partial"), ["a", "b", "c"], 1000),
      d(C("partial"), ["b"], 2000),
      d(C("partial"), ["a", "b", "c"], 3000),
      d(C("partial"), ["c", "a"], 4000),
      d(C("partial"), ["d"], 5000),
    ],
  },
  {
    name: "duplicates",
    steps: [
      n(C("dup"), ["a", "a"], 1000),
      n(C("dup"), ["a", "a"], 2000),
      n(C("dup"), ["b", "a", "b", "a"], 3000),
      n(C("dup"), ["c", "c", "c"], 4000),
      n(C("dup"), [], 5000),
      n(C("dup"), ["a", "b", "a"], 6000),
    ],
  },
  {
    name: "per cwd",
    steps: [
      n(C("cwd", "a"), ["x"], 1000),
      n(C("cwd", "b"), ["x"], 2000),
      n(C("cwd", "a"), [], 3000),
      n(C("cwd", "b"), ["x"], 4000),
      n(C("cwd", "a"), ["x"], 5000),
      n(C("cwd", "a/sub"), ["x"], 6000),
    ],
  },
  {
    name: "colliding cwds share a database",
    steps: [n(C("collide", "x y"), ["x"], 1000), n(C("collide", "x-y"), ["x"], 2000), n(C("collide", "x.y"), [], 3000), n(C("collide", "x y"), ["x"], 4000)],
  },
  {
    name: "the tables are independent",
    steps: [
      n(C("tables"), ["a"], 1000),
      d(C("tables"), ["a"], 2000),
      n(C("tables"), [], 3000),
      d(C("tables"), ["a"], 4000),
      n(C("tables"), ["a"], 5000),
      d(C("tables"), [], 6000),
    ],
  },
  {
    name: "odd names",
    steps: [
      n(C("odd"), ODD_NAMES, 1000),
      n(C("odd"), [...ODD_NAMES].reverse(), 2000),
      n(C("odd"), ["a", "A", "", "\u{1F600}"], 3000),
      n(C("odd"), ["a ", " a", "\u00E9", "e\u0301"], 4000),
    ],
  },
  { name: "many", steps: [d(C("many"), MANY, 1000), d(C("many"), MANY.slice(10, 30), 2000), d(C("many"), [...MANY].reverse(), 3000)] },
  { name: "empty first", steps: [n(C("empty"), [], 1000), d(C("empty"), [], 2000)] },
  { name: "real clock", steps: [n(C("clock"), ["a"], T), n(C("clock"), ["a", "b"], T + 1)] },
  {
    name: "fails open",
    seed: [{ cwd: C("open"), kind: "block" }],
    steps: [
      n(C("open"), ["a", "a"], 1000),
      n(C("open"), ["a", "a"], 2000),
      n(C("open"), [], 3000),
      d(C("open"), ["b"], 4000),
      d(C("open"), ["b"], 5000),
    ],
  },
  {
    name: "a database without the tables throws",
    seed: [{ cwd: C("v999"), kind: "v999" }],
    steps: [n(C("v999"), ["a"], 1000), d(C("v999"), ["a"], 2000), n(C("v999"), [], 3000)],
  },
  {
    name: "foreign rows",
    seed: [
      {
        cwd: C("foreign"),
        kind: "sql",
        sql: "INSERT INTO mcp_needs_auth_notified(server_name, notified_at) VALUES (NULL, 1), (x'6162', 2), ('a', 3), (5, 4), ('gone', 5), (1.5, 6);",
      },
    ],
    steps: [
      n(C("foreign"), ["a", "5", "ab", "1.5"], 1000),
      n(C("foreign"), ["5"], 2000),
      n(C("foreign"), [], 3000),
      n(C("foreign"), ["ab"], 4000),
    ],
  },
];

const db = [];
for (const c of DB_CASES) {
  for (const s of c.seed ?? []) await seed(s);
  const cwds = [...new Set([...(c.seed ?? []).map((s) => s.cwd), ...c.steps.map((s) => s[1])])];
  const steps = [];
  for (const [fn, cwd, servers, clock] of c.steps) {
    CLOCK = clock;
    let result;
    try {
      result = { announce: await SYNC[fn](cwd, servers) };
    } catch {
      result = { threw: true };
    }
    const rows = {};
    for (const w of cwds) rows[w] = await rowsOf(w);
    steps.push({ fn, cwd, servers, clock, ...result, rows });
  }
  db.push({ name: c.name, seed: c.seed ?? [], cwds, steps });
}

// --------------------------------- sessions ---------------------------------

const srv = (name, status) => ({ name, status });
const list = (...entries) => ({ mcpServers: entries });
const MIX = list(
  srv("github", "needs-auth"),
  srv("slack", "failed"),
  srv("linear", "connected"),
  srv("jira", "pending"),
  srv("notion", "disabled"),
);
const QUIET = list(srv("github", "connected"), srv("slack", "connected"));
const ODD_ENTRIES = list(
  null,
  5,
  "needs-auth",
  "failed",
  [],
  {},
  { status: "needs-auth" },
  { name: 5, status: "needs-auth" },
  { name: null, status: "failed" },
  { name: "", status: "needs-auth" },
  { name: "", status: "failed" },
  { name: "A", status: "NEEDS-AUTH" },
  { name: "b", status: " needs-auth" },
  { name: "b2", status: "needs-auth\u00A0" },
  { name: "c", status: "needs-auth", extra: { n: 1.5 } },
  { name: "c", status: "needs-auth" },
  { name: "d", status: ["needs-auth"] },
  { name: ["e"], status: "needs-auth" },
  { name: { x: 1 }, status: "failed" },
  { name: "unknown", status: "failed" },
  { name: true, status: "failed" },
  { name: "s\u00EBrv\u00E9r \u{1F600}", status: "needs-auth" },
  { name: "tab\there", status: "failed" },
  { name: "f", status: "failed", tools: [] },
  { status: "failed" },
  { name: "g", status: null },
  { name: "h" },
);
const turn = (prompt, clock) => ({ prompt, clock });
// A turn that re-emits `system/init` before its result.
const REINIT = [
  {
    match: "reinit",
    steps: [
      {
        type: "system",
        subtype: "init",
        session_id: "$SESSION_ID",
        model: "$MODEL",
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        apiKeySource: "none",
      },
    ],
  },
];

const SESSION_CASES = [
  {
    name: "startup announces, the re-check is throttled and deduped",
    sessions: [
      {
        cwd: "a",
        replies: [MIX],
        start: T,
        turns: [
          turn("one", T),
          turn("two", T + 29_999),
          turn("three", T + 30_000),
          turn("four", T + 30_001),
          turn("five", T + 59_999),
          turn("six", T + 60_000),
        ],
      },
    ],
  },
  {
    name: "once per server across sessions in a cwd",
    sessions: [
      { cwd: "a", replies: [MIX], start: T, turns: [] },
      { cwd: "a", replies: [MIX], start: T + 1, turns: [turn("again", T + 2)] },
      { cwd: "b", replies: [MIX], start: T + 3, turns: [] },
      { cwd: "a", replies: [QUIET], start: T + 4, turns: [] },
      { cwd: "a", replies: [MIX], start: T + 5, turns: [] },
    ],
  },
  {
    name: "a server that recovers and drops again re-announces",
    sessions: [
      {
        cwd: "a",
        replies: [
          list(srv("gh", "needs-auth"), srv("sl", "failed")),
          list(srv("gh", "needs-auth"), srv("sl", "failed")),
          QUIET,
          QUIET,
          list(srv("gh", "needs-auth"), srv("sl", "failed")),
          list(srv("gh", "needs-auth"), srv("sl", "failed")),
          list(srv("gh", "needs-auth"), srv("lin", "needs-auth")),
          list(srv("sl", "connected"), srv("gh", "failed")),
          list(srv("gh", "failed")),
        ],
        start: T,
        turns: [turn("one", T), turn("two", T + 30_000), turn("three", T + 60_000), turn("four", T + 90_000)],
      },
    ],
  },
  {
    name: "a re-entrant init doesn't check again",
    sessions: [
      {
        cwd: "a",
        replies: [MIX],
        script: REINIT,
        start: T,
        turns: [turn("reinit one", T + 1), turn("reinit two", T + 2), turn("plain", T + 30_001)],
      },
    ],
  },
  {
    name: "replies without a list leave the tables alone",
    sessions: [
      {
        cwd: "a",
        replies: [
          list(srv("gh", "needs-auth")),
          list(srv("sl", "failed")),
          {},
          { mcpServers: null },
          "x",
          { mcpServers: { gh: { status: "needs-auth" } } },
          { $error: "status failed" },
          { mcpServers: "failed" },
          { mcpServers: 5 },
          { mcpServers: false },
          null,
          [],
          { mcpServers: [] },
          { mcpServers: [] },
          list(srv("gh", "needs-auth")),
          list(srv("sl", "failed")),
        ],
        start: T,
        turns: [
          turn("one", T),
          turn("two", T + 30_000),
          turn("three", T + 60_000),
          turn("four", T + 90_000),
          turn("five", T + 120_000),
          turn("six", T + 150_000),
          turn("seven", T + 180_000),
        ],
      },
    ],
  },
  {
    name: "odd entries",
    sessions: [{ cwd: "a", replies: [ODD_ENTRIES], start: T, turns: [turn("one", T), turn("two", T + 30_000)] }],
  },
  {
    name: "duplicates in a reply",
    sessions: [
      {
        cwd: "a",
        replies: [list(srv("a", "needs-auth"), srv("b", "needs-auth"), srv("a", "needs-auth"), srv("a", "failed"), srv("a", "failed"))],
        start: T,
        turns: [turn("one", T)],
      },
    ],
  },
  {
    name: "fails open",
    seed: [{ cwd: "a", kind: "block" }],
    sessions: [
      {
        cwd: "a",
        // The second startup reply waits, so the two checks' failing
        // `openDb` calls can't race.
        replies: [
          list(srv("gh", "needs-auth"), srv("gh", "needs-auth"), srv("sl", "failed")),
          { $response: list(srv("gh", "needs-auth"), srv("gh", "needs-auth"), srv("sl", "failed")), $delay_ms: 100 },
          list(srv("gh", "needs-auth"), srv("gh", "needs-auth"), srv("sl", "failed")),
        ],
        start: T,
        turns: [turn("one", T), turn("two", T + 1), turn("three", T + 30_000)],
      },
    ],
  },
  {
    name: "a database that throws announces nothing",
    seed: [{ cwd: "a", kind: "v999" }],
    sessions: [{ cwd: "a", replies: [MIX], start: T, turns: [turn("one", T)] }],
  },
  {
    name: "the first re-check waits for 30 s of clock",
    sessions: [
      {
        cwd: "a",
        replies: [MIX],
        start: 10,
        turns: [
          turn("one", 29_999),
          turn("two", 30_000),
          turn("three", 30_000),
          turn("four", 59_999),
          turn("five", 60_000),
          turn("six", 1_000),
          turn("seven", 90_000),
        ],
      },
    ],
  },
  {
    name: "colliding cwds share a database",
    sessions: [
      { cwd: "x y", replies: [MIX], start: T, turns: [] },
      { cwd: "x-y", replies: [MIX], start: T + 1, turns: [] },
    ],
  },
  {
    name: "no server in either state",
    sessions: [{ cwd: "a", replies: [{ mcpServers: [] }], start: T, turns: [turn("one", T)] }],
  },
  {
    name: "a failed status request",
    sessions: [{ cwd: "a", replies: [{ $error: "boom" }], start: T, turns: [turn("one", T)] }],
  },
];

const readLines = (f) => {
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/** The `mcp_status` control requests among `lines`, ids as `$ID`. */
function statusWire(lines) {
  return lines
    .filter((l) => {
      const m = JSON.parse(l);
      return m.type === "control_request" && m.request?.subtype === "mcp_status";
    })
    .map((l) => l.replace(JSON.stringify(JSON.parse(l).request_id), '"$ID"'));
}

let sessionNo = 0;
async function runSession(sess, cwd) {
  const dir = join(ROOT_DIR, "s", String(sessionNo++));
  mkdirSync(join(dir, "home"), { recursive: true });
  const log = join(dir, "stdin.log");
  const script = { control: { mcp_status: { $sequence: sess.replies } }, turns: sess.script ?? [] };
  const host = Object.create(Session.prototype);
  // The class fields the three methods read, at their initial values.
  Object.assign(host, {
    id: `golden-${sessionNo}`,
    cwd,
    query: null,
    mcpNeedsAuthNoticeFired: false,
    mcpDisconnectedNoticeFired: false,
    lastMcpRecheckAt: 0,
    isReplayingTranscript: false,
  });
  let events = [];
  host.broadcast = (ev) => events.push(JSON.parse(JSON.stringify(ev)));
  let pending = [];
  let onInit;
  let onResult = null;
  const sawInit = new Promise((r) => (onInit = r));
  const inbox = [];
  let wake = null;
  let closed = false;
  async function* prompt() {
    for (;;) {
      if (inbox.length) {
        yield inbox.shift();
        continue;
      }
      if (closed) return;
      await new Promise((r) => (wake = r));
      wake = null;
    }
  }
  CLOCK = sess.start;
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
        FAKE_CLAUDE_SCRIPT: JSON.stringify(script),
      },
    },
  });
  host.query = q;
  // `Session.consume` + `broadcast`, as far as these checks go.
  const drained = (async () => {
    try {
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init" && !host.isReplayingTranscript) {
          pending.push(host.noteMcpNeedsAuthAtStartup(), host.noteMcpDisconnectedAtStartup());
          onInit();
        }
        if (m.type === "result") {
          pending.push(host.recheckMcpStatusMidSession());
          onResult?.();
        }
      }
    } catch {
      // the abort ends the stream with an error
    }
  })();
  const steps = [];
  let from = 0;
  const record = async (step) => {
    await Promise.all(pending);
    pending = [];
    const lines = readLines(log);
    steps.push({ ...step, events, wire: statusWire(lines.slice(from)), rows: await rowsOf(cwd) });
    from = lines.length;
    events = [];
  };
  await q.initializationResult();
  await sawInit;
  await record({ step: "start", clock: sess.start });
  for (const t of sess.turns) {
    CLOCK = t.clock;
    const done = new Promise((r) => (onResult = r));
    inbox.push({ type: "user", message: { role: "user", content: t.prompt }, parent_tool_use_id: null, session_id: "" });
    wake?.();
    await done;
    await record({ step: "turn", prompt: t.prompt, clock: t.clock });
  }
  closed = true;
  wake?.();
  ctrl.abort();
  await drained;
  return steps;
}

const sessions = [];
for (const [i, c] of SESSION_CASES.entries()) {
  const base = join(ROOT_DIR, "w", String(i));
  const labels = [...new Set([...(c.seed ?? []).map((s) => s.cwd), ...c.sessions.map((s) => s.cwd)])];
  const cwdOf = Object.fromEntries(labels.map((l) => [l, join(base, l)]));
  for (const l of labels) mkdirSync(cwdOf[l], { recursive: true });
  for (const s of c.seed ?? []) await seed({ ...s, cwd: cwdOf[s.cwd] });
  // A live session has opened its cwd's database long before the init (the
  // sessions index), so both checks find the handle cached.
  for (const l of labels) {
    if (!(c.seed ?? []).some((s) => s.cwd === l && s.kind === "block")) await openDb(cwdOf[l]);
  }
  const runs = [];
  for (const s of c.sessions) {
    runs.push({ cwd: s.cwd, replies: s.replies, script: s.script ?? [], steps: await runSession(s, cwdOf[s.cwd]) });
  }
  sessions.push({ name: c.name, seed: c.seed ?? [], sessions: runs });
}

// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ sdkVersion, due, db, sessions }));
process.exit(0);
