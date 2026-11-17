#!/usr/bin/env node
// Golden fixture for the CC 2.1.309 session set (R05), recorded from the real
// TS:
//
//   lib/shared/session-history.ts     isHistoryWorthyDbRow
//   lib/shared/dangerous-rm-deny.ts   bypassDangerousRmDenial
//   lib/server/sessions-db.ts         retitleIndexedSession
//   app/api/sessions/rename/route.ts  POST (live and non-live)
//   lib/server/session.ts             rename / flushPendingTitleMirror
//
//   node rust/scripts/cc2309-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself twice under `--experimental-transform-types` (repo cwd, a
// resolve hook for the `@/` and extensionless imports, a `load` hook so the
// JSON imports under lib/ work), each run in its own temp root with HOME at
// `<root>/home` (Claudius's state: workspaces.json and the per-project
// `.claudius.db` files under `$HOME/.claude/projects`) and
// CLAUDE_CONFIG_DIR at `<root>/config` (the SDK's transcripts). Both
// recordings must agree byte for byte.
//
// Records:
// - `history`: `isHistoryWorthyDbRow(row, isLive)` over the row shapes
//   better-sqlite3 hands JS (null, text, blank, BOM, a number, a Buffer, a
//   boolean, an object), with the ids `isLive` was asked about.
// - `rm`: `bypassDangerousRmDenial(ask)` over the engine's real
//   `decision_reason` forms, every mode, both reason types, ANSI, a forced
//   ask rule, odd types and the 600-code-point cap.
// - `retitle`: `retitleIndexedSession(id, title)` on a world built from a
//   `workspaces.json` (verbatim) and per-root SQL (`store` and `roots`, as
//   the fixture records them), recording the result (or the thrown
//   message), then every root's `sessions` rows and which `.claudius.db`
//   files exist.
// - `renameRoute`: `POST /api/sessions/rename` through the real handler,
//   with the live session manager seeded by stand-ins, recording the status,
//   body, the rows and what the transcripts gained.
// - `session`: `Session.prototype.rename` and `flushPendingTitleMirror` on a
//   bare `Object.create(Session.prototype)` with a stand-in `query`:
//   `pendingTitleMirror` before and after, the broadcasts, the engine's
//   `rename_session` calls and the transcript lines appended.
//
// Written to rust/crates/claudius-core/tests/fixtures/cc2309_golden.json and
// replayed by crates/claudius-core/tests/cc2309_golden.rs and
// crates/claudius-server/tests/cc2309_rename.rs.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/cc2309_golden.json");

if (!process.env.CC2309_GOLDEN_ROOT) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cc2309-golden-")));
    try {
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "config"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          // `openDb` reads its migrations from `process.cwd()`.
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            TZ: "UTC",
            CLAUDE_CONFIG_DIR: join(root, "config"),
            CC2309_GOLDEN_ROOT: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stdout + r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    writeFileSync(join(tmpdir(), "cc2309-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "cc2309-run1.json"), runs[1]);
    throw new Error(`the two recordings differ (see ${tmpdir()}/cc2309-run{0,1}.json)`);
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.history.length} history, ${fixture.rm.length} rm, ` +
      `${fixture.retitle.length} retitle, ${fixture.renameRoute.length} rename requests, ` +
      `${fixture.session.length} session cases (stable)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.CC2309_GOLDEN_ROOT;
const HOME = process.env.HOME;
const CONFIG = process.env.CLAUDE_CONFIG_DIR;

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

const load = (rel) => import(pathToFileURL(join(repo, rel)).href);
const { isHistoryWorthyDbRow } = await load("lib/shared/session-history.ts");
const { bypassDangerousRmDenial, DANGEROUS_RM_REWRITE_HINT } = await load(
  "lib/shared/dangerous-rm-deny.ts",
);
const { retitleIndexedSession } = await load("lib/server/sessions-db.ts");
const { openDb, closeAll } = await load("lib/server/db.ts");
const { Session } = await load("lib/server/session.ts");
const { sessionManager } = await load("lib/server/session-manager.ts");
const renameModule = await load("app/api/sessions/rename/route.ts");
const Database = (await import("better-sqlite3")).default;

/** Characters by code point, so this file stays ASCII. */
const U = (...cps) => String.fromCodePoint(...cps);
const BOM = U(0xfeff);
const NEL = U(0x85);
const CRAB = U(0x1f980);
const LONG_S = U(0x17f);
const DOTLESS_I = U(0x131);
const ESC = U(0x1b);
const J = (v) => (v === undefined ? "null" : JSON.stringify(v));
const encodeDir = (s) => s.replace(/[^A-Za-z0-9]/g, "-");
const EROOT = encodeDir(ROOT);
const rel = (s) => s.split(ROOT).join("$ROOT").split(EROOT).join("$EROOT");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const threw = (e) => ({ throws: rel(e instanceof Error ? e.message : String(e)) });
const attempt = async (f) => {
  try {
    return { result: J(await f()) };
  } catch (e) {
    return threw(e);
  }
};

// -------------------------------- history --------------------------------

const HISTORY = [
  ["no title", null],
  ["undefined title", undefined],
  ["a title", "Release prep"],
  ["an untrimmed title", "  Release prep  "],
  ["an empty title", ""],
  ["spaces only", "   "],
  ["tabs and newlines only", "\t\n\r "],
  ["a BOM only", BOM],
  ["a NEL only", NEL],
  ["an astral title", CRAB],
  ["a number title", 5],
  ["a zero title", 0],
  ["a NaN title", Number.NaN],
  ["a true title", true],
  ["a false title", false],
  ["a Buffer title", Buffer.from("hi")],
  ["an empty Buffer title", Buffer.alloc(0)],
  ["an object title", { toString: () => "x" }],
  ["an array title", ["x"]],
];

const history = [];
for (const [name, title] of HISTORY) {
  for (const live of [false, true]) {
    for (const id of ["a", ""]) {
      const asked = [];
      const isLive = (x) => {
        asked.push(J(x));
        return live;
      };
      let got;
      try {
        got = { result: J(isHistoryWorthyDbRow({ id, title }, isLive)) };
      } catch (e) {
        got = threw(e);
      }
      history.push({
        name: `${name}${live ? ", live" : ""}${id ? "" : ", empty id"}`,
        id,
        title: J(title),
        live,
        asked,
        ...got,
      });
    }
  }
}

// ---------------------------------- rm ----------------------------------

// The `decision_reason` forms the engine forwards for its dangerous-removal
// checks (the shapes the TS unit test pins).
const RM_WORKSPACE = "Dangerous rm operation on working directory or its ancestor: .";
const RMDIR_CRITICAL = "Dangerous rmdir operation on critical path: /usr";
const RM_UNCHECKED =
  "Dangerous rm operation not ruled out - some nested commands or function substitutions could not be analyzed";
const RM_DERIVED_VAR =
  "Dangerous rm operation on possibly-empty variable path: ${OUT}/x (use a literal path: $OUT is set in this command from `mktemp -d`, which can print nothing)";
const SENSITIVE = "Claude requested permissions to edit .git/config, which is a sensitive file.";

const RM = [
  ["the working directory", { decisionReason: RM_WORKSPACE, decisionReasonType: "safetyCheck" }],
  ["rmdir on a critical path", { decisionReason: RMDIR_CRITICAL, decisionReasonType: "safetyCheck" }],
  ["a compound command", { decisionReason: RM_WORKSPACE, decisionReasonType: "subcommandResults" }],
  ["not ruled out", { decisionReason: RM_UNCHECKED, decisionReasonType: "safetyCheck" }],
  ["a derived variable", { decisionReason: RM_DERIVED_VAR, decisionReasonType: "subcommandResults" }],
  ["another safety check", { decisionReason: SENSITIVE, decisionReasonType: "safetyCheck" }],
  ["a hook ask", { decisionReason: RM_WORKSPACE, decisionReasonType: "hook" }],
  ["no reason type", { decisionReason: RM_WORKSPACE }],
  ["a null reason type", { decisionReason: RM_WORKSPACE, decisionReasonType: null }],
  ["a reason type object", { decisionReason: RM_WORKSPACE, decisionReasonType: { t: "safetyCheck" } }],
  ["no reason", { decisionReasonType: "safetyCheck" }],
  ["a null reason", { decisionReason: null, decisionReasonType: "safetyCheck" }],
  ["a number reason", { decisionReason: 5, decisionReasonType: "safetyCheck" }],
  ["an object reason", { decisionReason: { text: RM_WORKSPACE }, decisionReasonType: "safetyCheck" }],
  ["an array reason", { decisionReason: [RM_WORKSPACE], decisionReasonType: "safetyCheck" }],
  ["a forced ask rule", {
    decisionReason: RM_WORKSPACE,
    decisionReasonType: "safetyCheck",
    matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "rm:*" },
  }],
  ["an empty ask rule object", {
    decisionReason: RM_WORKSPACE,
    decisionReasonType: "safetyCheck",
    matchedAskRule: {},
  }],
  ["a falsy ask rule", {
    decisionReason: RM_WORKSPACE,
    decisionReasonType: "safetyCheck",
    matchedAskRule: 0,
  }],
  ["an ask rule empty string", {
    decisionReason: RM_WORKSPACE,
    decisionReasonType: "safetyCheck",
    matchedAskRule: "",
  }],
  ["ANSI around the reason", {
    decisionReason: `${ESC}[1m${RMDIR_CRITICAL}${ESC}[0m`,
    decisionReasonType: "safetyCheck",
  }],
  ["an OSC sequence", {
    decisionReason: `${ESC}]8;;http://x${U(7)}${RM_WORKSPACE}${ESC}]8;;${U(7)}`,
    decisionReasonType: "safetyCheck",
  }],
  ["a two-character escape", {
    decisionReason: `${ESC}B${RM_WORKSPACE}`,
    decisionReasonType: "safetyCheck",
  }],
  ["padded with whitespace", {
    decisionReason: `  \n${RM_WORKSPACE}\t `,
    decisionReasonType: "safetyCheck",
  }],
  ["a BOM around the reason", {
    decisionReason: `${BOM}${RM_WORKSPACE}${BOM}`,
    decisionReasonType: "safetyCheck",
  }],
  ["only the phrase", { decisionReason: "dangerous rm operations", decisionReasonType: "safetyCheck" }],
  ["the phrase in upper case", { decisionReason: "DANGEROUS RMDIR OPERATION", decisionReasonType: "safetyCheck" }],
  ["the phrase without the noun", { decisionReason: "dangerous rm", decisionReasonType: "safetyCheck" }],
  ["the phrase glued to a word", { decisionReason: "xdangerous rm operations", decisionReasonType: "safetyCheck" }],
  ["a word glued after it", { decisionReason: "dangerous rm operationsx", decisionReasonType: "safetyCheck" }],
  ["rmdir glued to a word", { decisionReason: "dangerous rmdirx operations", decisionReasonType: "safetyCheck" }],
  ["two spaces inside", { decisionReason: "dangerous  rm operations", decisionReasonType: "safetyCheck" }],
  ["a long s", { decisionReason: `dangerou${LONG_S} rm operations`, decisionReasonType: "safetyCheck" }],
  ["a long s as the plural", { decisionReason: `dangerous rm operation${LONG_S}`, decisionReasonType: "safetyCheck" }],
  ["a dotless i", { decisionReason: `dangerous rmd${DOTLESS_I}r operations`, decisionReasonType: "safetyCheck" }],
  ["underscored", { decisionReason: "a_dangerous rm operations", decisionReasonType: "safetyCheck" }],
  ["in parentheses", { decisionReason: "(dangerous rmdir operations)", decisionReasonType: "safetyCheck" }],
  ["a long reason", {
    decisionReason: `dangerous rm operations ${"x".repeat(900)}`,
    decisionReasonType: "safetyCheck",
  }],
  ["a long astral reason", {
    decisionReason: `dangerous rm operations ${CRAB.repeat(700)}`,
    decisionReasonType: "safetyCheck",
  }],
  ["exactly at the cap", {
    decisionReason: `dangerous rm operations ${"y".repeat(600 - "dangerous rm operations ".length)}`,
    decisionReasonType: "safetyCheck",
  }],
  ["one past the cap", {
    decisionReason: `dangerous rm operations ${"y".repeat(601 - "dangerous rm operations ".length)}`,
    decisionReasonType: "safetyCheck",
  }],
];

const MODES = ["bypassPermissions", "default", "acceptEdits", "plan", "auto", "dontAsk", "", "BYPASSPERMISSIONS"];
const rm = [];
for (const [name, ask] of RM) {
  for (const permissionMode of ask.decisionReasonType === "safetyCheck" ? MODES : ["bypassPermissions"]) {
    let got;
    try {
      got = { result: J(bypassDangerousRmDenial({ permissionMode, ...ask })) };
    } catch (e) {
      got = threw(e);
    }
    rm.push({
      name: `${name} in ${permissionMode || "(empty mode)"}`,
      permissionMode,
      ask: J(ask),
      ...got,
    });
  }
}

// --------------------------------- worlds ---------------------------------

const STORE = join(HOME, ".claude", ".claudius", "workspaces.json");
const PROJECTS = join(HOME, ".claude", "projects");

/** A store entry, in the order createWorkspace writes one. */
const ws = (id, name, rootPath) => ({
  id,
  name,
  ...(rootPath === undefined ? {} : { rootPath }),
  icon: { kind: "letter", letter: "W", color: "#d97757" },
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  defaults: { permissionMode: "auto" },
});
const store = (entries) => `${JSON.stringify({ version: 1, workspaces: entries }, null, 2)}\n`;

const esc = (s) => s.replace(/'/g, "''");
const insert = (id, cwd, title = null) =>
  `INSERT INTO sessions(id, cwd, title, model, created_at, updated_at, last_seen_at) VALUES (${
    id === null ? "NULL" : `'${esc(id)}'`
  }, '${esc(cwd)}', ${title === null ? "NULL" : `'${esc(title)}'`}, NULL, 1000, 2000, 3000);`;

/** Reset the world: no projects dir, no store, no cached handles. */
function reset() {
  closeAll();
  rmSync(PROJECTS, { recursive: true, force: true });
  rmSync(dirname(STORE), { recursive: true, force: true });
  mkdirSync(dirname(STORE), { recursive: true });
  rmSync(join(CONFIG, "projects"), { recursive: true, force: true });
}

/** Build a world: the store text and per-root setup. */
async function build(spec) {
  reset();
  if (spec.store !== undefined) writeFileSync(STORE, spec.store.split("$ROOT").join(ROOT));
  for (const r of spec.roots ?? []) {
    const root = r.root.split("$ROOT").join(ROOT);
    if (r.raw !== undefined) {
      const dir = join(PROJECTS, encodeDir(root));
      mkdirSync(dir, { recursive: true });
      if (r.raw === null) {
        writeFileSync(join(dir, ".claudius.db"), "not a database, just text\n".repeat(40));
      } else {
        const db = new Database(join(dir, ".claudius.db"));
        db.pragma("journal_mode = WAL");
        db.exec(r.raw.split("$ROOT").join(ROOT));
        db.close();
      }
      continue;
    }
    if (r.dir) {
      mkdirSync(join(PROJECTS, encodeDir(root)), { recursive: true });
      continue;
    }
    const db = await openDb(root);
    for (const sql of r.sql ?? []) db.exec(sql.split("$ROOT").join(ROOT));
  }
  closeAll();
}

/** Every root's `sessions` rows (type and text per cell), and the db files. */
function dump(roots) {
  const out = {};
  for (const r of roots) {
    const root = r.root.split("$ROOT").join(ROOT);
    const file = join(PROJECTS, encodeDir(root), ".claudius.db");
    let db;
    try {
      db = new Database(file, { fileMustExist: true, readonly: true });
    } catch (e) {
      out[r.root] = { error: rel(e.message) };
      continue;
    }
    try {
      const rows = db
        .prepare(
          "SELECT typeof(id), CAST(id AS TEXT), typeof(title), CAST(title AS TEXT), updated_at FROM sessions ORDER BY rowid",
        )
        .raw()
        .all();
      out[r.root] = { rows: rows.map((x) => x.map((c) => (typeof c === "string" ? rel(c) : c))) };
    } catch (e) {
      out[r.root] = { error: rel(e.message) };
    } finally {
      db.close();
    }
  }
  return out;
}

/** The names under the projects dir, sorted. */
const projectDirs = () => {
  try {
    return readdirSync(PROJECTS).sort().map(rel);
  } catch {
    return [];
  }
};

// -------------------------------- retitle --------------------------------

const A = "$ROOT/w/a";
const B = "$ROOT/w/b";
const RETITLE = [
  ["no store at all", { roots: [] }, uuid(1), "New name"],
  ["no workspaces", { store: store([]), roots: [] }, uuid(1), "New name"],
  [
    "the row of the only workspace",
    { store: store([ws("wks_a", "A", A)]), roots: [{ root: A, sql: [insert(uuid(1), A, "Old")] }] },
    uuid(1),
    "  New name  ",
  ],
  [
    "a workspace without a database",
    { store: store([ws("wks_a", "A", A)]), roots: [] },
    uuid(1),
    "New name",
  ],
  [
    "a workspace whose database has no such row",
    { store: store([ws("wks_a", "A", A)]), roots: [{ root: A, sql: [insert(uuid(2), A, "Other")] }] },
    uuid(1),
    "New name",
  ],
  [
    "the row in the second workspace",
    {
      store: store([ws("wks_a", "A", A), ws("wks_b", "B", B)]),
      roots: [{ root: A, sql: [insert(uuid(2), A)] }, { root: B, sql: [insert(uuid(1), B)] }],
    },
    uuid(1),
    "New name",
  ],
  [
    "the row in both workspaces",
    {
      store: store([ws("wks_a", "A", A), ws("wks_b", "B", B)]),
      roots: [{ root: A, sql: [insert(uuid(1), A)] }, { root: B, sql: [insert(uuid(1), B, "Keep?")] }],
    },
    uuid(1),
    "New name",
  ],
  [
    "two workspaces on the same root",
    {
      store: store([ws("wks_a", "A", A), ws("wks_b", "B", A)]),
      roots: [{ root: A, sql: [insert(uuid(1), A)] }],
    },
    uuid(1),
    "New name",
  ],
  [
    "a row recorded under another cwd",
    { store: store([ws("wks_a", "A", A)]), roots: [{ root: A, sql: [insert(uuid(1), "/elsewhere")] }] },
    uuid(1),
    "New name",
  ],
  [
    "falsy and odd roots before the real one",
    {
      store: store([
        ws("wks_empty", "Empty", ""),
        ws("wks_none", "None", undefined),
        ws("wks_null", "Null", null),
        ws("wks_num", "Number", 5),
        ws("wks_obj", "Object", { path: A }),
        ws("wks_true", "True", true),
        ws("wks_a", "A", A),
      ]),
      roots: [{ root: A, sql: [insert(uuid(1), A)] }],
    },
    uuid(1),
    "New name",
  ],
  [
    "a null store entry",
    {
      store: store([ws("wks_a", "A", A), null]),
      roots: [{ root: A, sql: [insert(uuid(1), A)] }],
    },
    uuid(1),
    "New name",
  ],
  [
    "a null store entry before the workspace",
    {
      store: store([null, ws("wks_a", "A", A)]),
      roots: [{ root: A, sql: [insert(uuid(1), A)] }],
    },
    uuid(1),
    "New name",
  ],
  [
    "a store that is not JSON",
    { store: "{ not json", roots: [{ root: A, sql: [insert(uuid(1), A)] }] },
    uuid(1),
    "New name",
  ],
  [
    "a database that is not one",
    { store: store([ws("wks_a", "A", A)]), roots: [{ root: A, raw: null }] },
    uuid(1),
    "New name",
  ],
  [
    "a database without the sessions table",
    {
      store: store([ws("wks_a", "A", A)]),
      roots: [{ root: A, raw: "CREATE TABLE other (id TEXT);" }],
    },
    uuid(1),
    "New name",
  ],
  [
    "a newer schema without the table, after an update",
    {
      store: store([ws("wks_a", "A", A), ws("wks_b", "B", B)]),
      roots: [
        { root: A, sql: [insert(uuid(1), A)] },
        { root: B, raw: "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\nINSERT INTO schema_meta VALUES ('version', '999');" },
      ],
    },
    uuid(1),
    "New name",
  ],
  [
    "a foreign sessions table without a title column",
    {
      store: store([ws("wks_a", "A", A)]),
      roots: [{ root: A, raw: `CREATE TABLE sessions (id TEXT, cwd TEXT);\nINSERT INTO sessions VALUES ('${uuid(1)}', '$ROOT/w/a');` }],
    },
    uuid(1),
    "New name",
  ],
  [
    "an empty id",
    { store: store([ws("wks_a", "A", A)]), roots: [{ root: A, sql: [insert(uuid(1), A)] }] },
    "",
    "New name",
  ],
  [
    "a blank title",
    { store: store([ws("wks_a", "A", A)]), roots: [{ root: A, sql: [insert(uuid(1), A, "Old")] }] },
    uuid(1),
    "   ",
  ],
  [
    "a BOM title",
    { store: store([ws("wks_a", "A", A)]), roots: [{ root: A, sql: [insert(uuid(1), A, "Old")] }] },
    uuid(1),
    BOM,
  ],
  [
    "an astral title",
    { store: store([ws("wks_a", "A", A)]), roots: [{ root: A, sql: [insert(uuid(1), A, "Old")] }] },
    uuid(1),
    ` ${CRAB} ${NEL} `,
  ],
  [
    "a non-uuid id",
    { store: store([ws("wks_a", "A", A)]), roots: [{ root: A, sql: [insert("not-a-uuid", A)] }] },
    "not-a-uuid",
    "New name",
  ],
  [
    "a numeric id in the row",
    {
      store: store([ws("wks_a", "A", A)]),
      roots: [{ root: A, raw: `CREATE TABLE sessions (id, cwd, title, updated_at);\nINSERT INTO sessions VALUES (5, '$ROOT/w/a', NULL, 1);` }],
    },
    "5",
    "New name",
  ],
];

const retitle = [];
for (const [name, spec, id, title] of RETITLE) {
  await build(spec);
  const t0 = Date.now();
  const got = await attempt(() => retitleIndexedSession(id, title));
  const t1 = Date.now();
  closeAll();
  const rows = dump(spec.roots ?? []);
  // Times the call wrote read as "$NOW".
  const stamp = (v) => (typeof v === "number" && v >= t0 && v <= t1 ? "$NOW" : v);
  for (const r of Object.values(rows)) {
    if (r.rows) r.rows = r.rows.map((x) => [...x.slice(0, 4), stamp(x[4])]);
  }
  retitle.push({ name, id, title, store: spec.store ?? null, roots: spec.roots ?? [], ...got, rows, dirs: projectDirs() });
}

// ------------------------------ rename route ------------------------------

/** Bare stand-ins for live sessions: what the route touches. */
function standIn(id, result) {
  return { id, rename: async () => result };
}

const RENAME = [
  ["no body", { raw: "" }],
  ["a malformed body", { raw: "{" }],
  ["a null body", { raw: "null" }],
  ["an array body", { raw: "[]" }],
  ["a string body", { raw: '"x"' }],
  ["no fields", { body: {} }],
  ["no title", { body: { sessionId: uuid(1) } }],
  ["no session id", { body: { title: "New" } }],
  ["an empty session id", { body: { sessionId: "", title: "New" } }],
  ["an empty title", { body: { sessionId: uuid(1), title: "" } }],
  ["a blank title", { body: { sessionId: uuid(1), title: "   " } }],
  ["a BOM title", { body: { sessionId: uuid(1), title: BOM } }],
  ["a number title", { body: { sessionId: uuid(1), title: 5 } }],
  ["a null title", { body: { sessionId: uuid(1), title: null } }],
  ["an object title", { body: { sessionId: uuid(1), title: { t: "New" } } }],
  ["a number session id", { body: { sessionId: 5, title: "New" } }],
  ["the row and the transcript", { body: { sessionId: uuid(1), title: "  New name  " }, jsonl: uuid(1) }],
  ["the row only, no transcript", { body: { sessionId: uuid(1), title: "New name" } }],
  ["no row and no transcript", { body: { sessionId: uuid(3), title: "New name" } }],
  ["a transcript with no row", { body: { sessionId: uuid(4), title: "New name" }, jsonl: uuid(4) }],
  ["the dir of the transcript", { body: { sessionId: uuid(4), title: "New name", dir: A }, jsonl: uuid(4) }],
  ["a dir with no transcript", { body: { sessionId: uuid(4), title: "New name", dir: B }, jsonl: uuid(4) }],
  ["a non-string dir", { body: { sessionId: uuid(4), title: "New name", dir: 5 }, jsonl: uuid(4) }],
  ["a non-uuid id with a row", { body: { sessionId: "not-a-uuid", title: "New name" } }],
  ["a live session that renames", { body: { sessionId: uuid(1), title: " Live " }, live: { ok: true } }],
  ["a live session that fails", { body: { sessionId: uuid(1), title: "Live" }, live: { ok: false, error: "disk full" } }],
];

const userLine = (id, cwd) =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: "hello" },
    uuid: `${id.slice(0, 8)}-0000-4000-8000-000000000001`,
    timestamp: "2026-10-01T10:00:00.000Z",
    cwd,
    sessionId: id,
  });

/** The transcript lines of `id` under `cwd`, or null. */
function transcript(id, cwd) {
  const file = join(CONFIG, "projects", encodeDir(cwd), `${id}.jsonl`);
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map(rel);
  } catch {
    return null;
  }
}

const RENAME_WORLD = {
  store: store([ws("wks_a", "A", A), ws("wks_b", "B", B)]),
  roots: [
    { root: A, sql: [insert(uuid(1), A, "Old A"), insert("not-a-uuid", A)] },
    { root: B, sql: [insert(uuid(1), B), insert(uuid(2), B, "Old B")] },
  ],
};

const renameRoute = [];
for (const [name, c] of RENAME) {
  await build(RENAME_WORLD);
  const absA = A.split("$ROOT").join(ROOT);
  if (c.jsonl) {
    const dir = join(CONFIG, "projects", encodeDir(absA));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${c.jsonl}.jsonl`), `${userLine(c.jsonl, absA)}\n`);
  }
  sessionManager.sessions.clear();
  if (c.live) sessionManager.sessions.set(String(c.body.sessionId), standIn(c.body.sessionId, c.live));
  const init = { method: "POST" };
  if (c.raw !== undefined) init.body = c.raw;
  else init.body = JSON.stringify(c.body).split("$ROOT").join(ROOT);
  const req = new Request("http://localhost/api/sessions/rename", init);
  const t0 = Date.now();
  let got;
  try {
    const res = await renameModule.POST(req);
    got = { status: res.status, body: rel(await res.text()) };
  } catch (e) {
    got = { threw: rel(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
  }
  const t1 = Date.now();
  sessionManager.sessions.clear();
  closeAll();
  const rows = dump(RENAME_WORLD.roots);
  const stamp = (v) => (typeof v === "number" && v >= t0 && v <= t1 ? "$NOW" : v);
  for (const r of Object.values(rows)) {
    if (r.rows) r.rows = r.rows.map((x) => [...x.slice(0, 4), stamp(x[4])]);
  }
  renameRoute.push({
    name,
    request: c.raw !== undefined ? { raw: c.raw } : { body: J(c.body) },
    jsonl: c.jsonl ?? null,
    live: c.live ? J(c.live) : null,
    got,
    rows,
    transcript: c.jsonl ? transcript(c.jsonl, absA) : null,
  });
}

// --------------------------------- session ---------------------------------

/** A stand-in SDK query: records `renameSession` calls, answers as told. */
function fakeQuery(kind) {
  const calls = [];
  if (kind === "none") return { query: null, calls };
  if (kind === "no-method") return { query: { calls }, calls };
  const renameSession = async (title, sessionId) => {
    calls.push(J([title, sessionId]));
    if (kind === "throws") throw new Error("rename_session refused");
    if (kind === "hangs") await new Promise(() => {});
    return { ok: true };
  };
  return { query: { renameSession }, calls };
}

const SESSION = [
  ["a rename with no transcript and no query", { title: "New name", query: "none" }],
  ["a rename with no transcript, the engine takes it", { title: "New name", query: "ok" }],
  ["a rename with no transcript, the engine refuses", { title: "New name", query: "throws" }],
  ["a rename with no transcript, a query without the method", { title: "New name", query: "no-method" }],
  ["a rename with a transcript", { title: "  New name  ", query: "none", jsonl: true }],
  ["a rename with a transcript and the engine", { title: "New name", query: "ok", jsonl: true }],
  ["a blank rename", { title: "   ", query: "ok" }],
  ["an astral rename", { title: ` ${CRAB} `, query: "none" }],
  ["a rename the engine never answers", { title: "New name", query: "hangs" }],
  // `flushPendingTitleMirror` on its own.
  ["a flush with no pending mirror", { flush: true, pending: null, jsonl: true }],
  ["a flush with no transcript", { flush: true, pending: "Pending", jsonl: false }],
  ["a flush that lands", { flush: true, pending: "Pending", jsonl: true }],
  ["a flush of an untrimmed name", { flush: true, pending: "  Pending  ", jsonl: true }],
  ["a flush raced by a newer rename", { flush: true, pending: "Pending", racedTo: "Newer", jsonl: true }],
  ["a flush raced with no current title", { flush: true, pending: "Pending", racedTo: null, jsonl: true }],
  ["a flush raced to the same title", { flush: true, pending: "Pending", racedTo: "Pending", jsonl: true }],
];

const session = [];
for (const [name, c] of SESSION) {
  await build({ store: store([ws("wks_a", "A", A)]), roots: [{ root: A, dir: true }] });
  const absA = A.split("$ROOT").join(ROOT);
  const id = uuid(session.length + 50);
  if (c.jsonl) {
    const dir = join(CONFIG, "projects", encodeDir(absA));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${userLine(id, absA)}\n`);
  }
  const { query, calls } = fakeQuery(c.query ?? "none");
  const bare = Object.create(Session.prototype);
  const broadcasts = [];
  Object.assign(bare, { cwd: absA, id, title: undefined, query });
  bare.broadcast = (ev) => broadcasts.push(ev);
  const t0 = Date.now();
  let got;
  if (c.flush) {
    bare.pendingTitleMirror = c.pending;
    bare.title = c.racedTo === undefined ? c.pending : c.racedTo;
    if (c.racedTo !== undefined) {
      // A newer rename landing while the append is in flight: the field
      // reads the pending name once, then the newer one.
      let reads = 0;
      let held = c.pending;
      Object.defineProperty(bare, "pendingTitleMirror", {
        configurable: true,
        get: () => (reads++ === 0 ? held : c.racedTo),
        set: (v) => {
          held = v;
        },
      });
    }
    got = await attempt(() => bare.flushPendingTitleMirror());
  } else {
    got = await attempt(() => bare.rename(c.title));
  }
  const t1 = Date.now();
  closeAll();
  const rows = dump([{ root: A }]);
  for (const r of Object.values(rows)) {
    if (r.rows) {
      r.rows = r.rows.map((x) => [
        ...x.slice(0, 4),
        typeof x[4] === "number" && x[4] >= t0 && x[4] <= t1 ? "$NOW" : x[4],
      ]);
    }
  }
  session.push({
    name,
    id,
    title: c.title ?? null,
    query: c.query ?? null,
    jsonl: !!c.jsonl,
    pending: c.pending ?? null,
    racedTo: c.racedTo === undefined ? "$none" : J(c.racedTo),
    ...got,
    after: J(bare.title),
    mirror: J(bare.pendingTitleMirror),
    broadcasts: J(broadcasts),
    engine: calls,
    transcript: transcript(id, absA),
    rows,
  });
}

closeAll();
writeFileSync(
  join(ROOT, "out.json"),
  JSON.stringify({
    node: process.version,
    hint: DANGEROUS_RM_REWRITE_HINT,
    renameWorld: RENAME_WORLD,
    history,
    rm,
    retitle,
    renameRoute,
    session,
  }),
);
process.exit(0);
