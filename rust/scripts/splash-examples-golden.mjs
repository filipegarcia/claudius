#!/usr/bin/env node
// Golden fixture for the splash screen's per-workspace store (D26a):
// `lib/server/splash-examples-db.ts` (the suggestion chips and the display
// name override in the per-cwd `ui_state` table) on the real DB layer
// (`lib/server/db.ts`: `openDb`, its migrations and handle cache), and
// `lib/server/splash-fallback-name.ts` (the greeting's fallback name) on the
// real `accounts-store.ts` and `claude-global-config.ts`.
//
//   node rust/scripts/splash-examples-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd (db.ts reads the migrations from there), HOME and CLAUDE_CONFIG_DIR in
// a temp root and a resolve hook for the `@/` and extensionless imports,
// twice (two temp roots); both recordings must agree byte for byte.
//
// `db`: one sequence of steps over a handful of cwds (each its own DB file
// under $HOME/.claude/projects and its own cached handles):
// - the module's functions: `get` (getSplashExamples), `set`
//   (setSplashExamples), `reset`, `getName`, `setName`; `got` is the
//   result's `JSON.stringify` text (so a lone surrogate reads `\udXXX`),
//   `undefined`, or `{threw: message}`;
// - world steps: `open` (the real `openDb` then `closeDb`: a migrated DB, no
//   cached handle), `raw` (SQL on the DB file through a bare connection, no
//   migrations; `wal` turns WAL on first), `file` (the DB path made a file
//   with `text` / `hex`, a directory, removed, or chmod'ed), `projectFile`
//   (the cwd's project dir made a regular file);
// - dumps: `rows` (every `ui_state` row: key, typeof, hex of the value),
//   `meta` (every `schema_meta` row: key, typeof, quote()), `flag` (the
//   same without the version row), `files` (what the project dir and the DB
//   path are).
// Messages and dumps name the temp HOME as "$HOME". In `raw` SQL, `$LAST`,
// `$HEX` and `$UTF8HEX` stand for the newest migration id (decimal, hex, and
// the hex of its digits), filled in by whoever runs it; `last` is the id at
// recording time, for information.
//
// `fallback`: cases of `resolveSplashFallbackName()`, each a list of calls;
// before a call `accounts` / `global` (re)write `~/.claude/.claudius/
// accounts.json` / `~/.claude.json` (`json`, `text`, `dir`, `mode`, or null
// to remove it) and `reset` clears the global config's 30 s cache (every
// case starts with both files removed and the cache clear).
//
// Written to rust/crates/claudius-core/tests/fixtures/splash_examples_golden.json
// and replayed by crates/claudius-core/tests/splash_examples_golden.rs.
import { spawnSync } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/splash_examples_golden.json");

if (!process.env.SPLASH_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "splash-examples-golden-")));
    try {
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "config"));
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
            SPLASH_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      restoreModes(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.db.length} db steps, ` +
      `${fixture.fallback.length} fallback cases (${fixture.fallback.reduce((n, c) => n + c.calls.length, 0)} calls) (stable)`,
  );
  process.exit(0);
}

/** Make everything under `dir` writable again so it can be removed. */
function restoreModes(dir) {
  let entries = [];
  try {
    chmodSync(dir, 0o755);
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) restoreModes(p);
    else {
      try {
        chmodSync(p, 0o644);
      } catch {
        // a dangling entry
      }
    }
  }
}

const ROOT_DIR = process.env.SPLASH_GOLDEN_CHILD;
const HOME = process.env.HOME;

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

const { default: Database } = await import("better-sqlite3");
const { openDb, closeDb } = await import(join(repo, "lib/server/db.ts"));
const splash = await import(join(repo, "lib/server/splash-examples-db.ts"));
const { resolveSplashFallbackName } = await import(join(repo, "lib/server/splash-fallback-name.ts"));
const { __resetClaudeGlobalConfigCache } = await import(join(repo, "lib/server/claude-global-config.ts"));

const LAST = Math.max(
  ...readdirSync(join(repo, "lib/server/db-migrations"))
    .filter((n) => /^\d+_.*\.sql$/.test(n))
    .map((n) => Number(/^(\d+)_/.exec(n)[1])),
);

const fill = (sql) =>
  sql
    .replaceAll("$UTF8HEX", Buffer.from(String(LAST)).toString("hex"))
    .replaceAll("$HEX", LAST.toString(16))
    .replaceAll("$LAST", String(LAST));
const scrub = (s) => s.split(HOME).join("$HOME");
const threw = (e) => ({ threw: scrub(e instanceof Error ? e.message : String(e)) });
const J = (v) => (v === undefined ? "undefined" : JSON.stringify(v));

// ------------------------------- world -------------------------------

const projectDir = (cwd) => join(HOME, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
const dbPath = (cwd) => join(projectDir(cwd), ".claudius.db");
const kind = (p) => {
  try {
    const st = statSync(p);
    return st.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
};

function raw(cwd, sql, wal) {
  mkdirSync(projectDir(cwd), { recursive: true });
  const db = new Database(dbPath(cwd));
  try {
    if (wal) db.pragma("journal_mode = WAL");
    db.exec(sql);
  } finally {
    db.close();
  }
}

function dump(cwd, sql) {
  if (kind(dbPath(cwd)) !== "file") return "missing";
  let db;
  try {
    db = new Database(dbPath(cwd), { readonly: true, fileMustExist: true });
    return db.prepare(sql).raw().all();
  } catch (e) {
    return threw(e);
  } finally {
    db?.close();
  }
}
const ROWS_SQL = "SELECT key, typeof(value), hex(value) FROM ui_state ORDER BY key, rowid";
const META_SQL = "SELECT key, typeof(value), quote(value) FROM schema_meta ORDER BY key, rowid";
const FLAG_SQL = "SELECT key, typeof(value), quote(value) FROM schema_meta WHERE key <> 'version' ORDER BY key, rowid";

function fileOp(cwd, spec) {
  const p = dbPath(cwd);
  mkdirSync(projectDir(cwd), { recursive: true });
  if (spec.rm) rmSync(p, { recursive: true, force: true });
  if (spec.text !== undefined) writeFileSync(p, spec.text);
  if (spec.hex !== undefined) writeFileSync(p, Buffer.from(spec.hex, "hex"));
  if (spec.dir) mkdirSync(p);
  if (spec.mode !== undefined) chmodSync(spec.target === "project" ? projectDir(cwd) : p, spec.mode);
}

// ------------------------------- steps -------------------------------

const C = (name) => `/claudius-golden/splash/${name}`;
const get = (cwd) => ({ op: "get", cwd });
const set = (cwd, examples) => ({ op: "set", cwd, examples });
const reset = (cwd) => ({ op: "reset", cwd });
const getName = (cwd) => ({ op: "getName", cwd });
const setName = (cwd, name) => ({ op: "setName", cwd, name });
const open = (cwd) => ({ op: "open", cwd });
const rawSql = (cwd, sql, wal = true) => ({ op: "raw", cwd, sql, wal });
const file = (cwd, spec) => ({ op: "file", cwd, spec });
const rows = (cwd) => ({ op: "rows", cwd });
const meta = (cwd) => ({ op: "meta", cwd });
const flag = (cwd) => ({ op: "flag", cwd });
const files = (cwd) => ({ op: "files", cwd });
const putExamples = (cwd, valueSql) =>
  rawSql(cwd, `INSERT OR REPLACE INTO ui_state(key, value) VALUES ('splash_examples', ${valueSql});`);
const putName = (cwd, valueSql) =>
  rawSql(cwd, `INSERT OR REPLACE INTO ui_state(key, value) VALUES ('splash_display_name', ${valueSql});`);
const q = (s) => `'${s.replace(/'/g, "''")}'`;

const EMOJI = "\ud83d\ude00";
const NBSP = "\u00a0";
const NEL = "\u0085";
const BOM = "\ufeff";
const LS = "\u2028";
const PS = "\u2029";
const IDEO = "\u3000";
const MVS = "\u180e";
const ZWSP = "\u200b";
const OGHAM = "\u1680";
const r = (c, n) => c.repeat(n);

const A = C("main");
const F = C("foreign");
const G = C("loose-schema");
const N = C("no-table");
const X = C("not-a-db");
const D = C("db-is-a-dir");
const P = C("project-is-a-file");
const JR = C("rollback-journal");
const RO = C("read-only-file");
const RD = C("read-only-dir");
const M = C("moved");

const STEPS = [
  // Nothing on disk: the defaults. The read-only open still makes the project dir.
  get(A),
  files(A),
  getName(A),
  files(A),
  // An empty list is a deliberate choice.
  set(A, []),
  files(A),
  rows(A),
  get(A),
  // Trim, drop blanks.
  set(A, ["  Fix the build  ", "", "   ", "\t\n", "Add tests"]),
  get(A),
  rows(A),
  // Non-strings are skipped by the function itself.
  set(A, [1, null, true, {}, [], ["x"], "ok", 0, false, " ", { toString: "y" }]),
  get(A),
  // At most 12; blanks don't count against the cap.
  set(A, Array.from({ length: 15 }, (_, i) => `s${i + 1}`)),
  get(A),
  set(A, [...Array(12).fill("  "), "a", "b", "c"]),
  get(A),
  set(A, [...Array.from({ length: 11 }, (_, i) => `t${i + 1}`), "", "u1", "u2", ""]),
  get(A),
  // No dedupe.
  set(A, ["x", "x", " x ", "X", "x"]),
  get(A),
  rows(A),
  // 240 UTF-16 units per entry, cut after the trim; a cut can split a surrogate pair.
  set(A, [
    r("a", 240),
    r("b", 241),
    ` ${r("c", 240)} `,
    r("d", 239) + EMOJI,
    r("e", 238) + EMOJI,
    `${r("f", 240)}  g`,
    `${r("g", 239)} h`,
    r(EMOJI, 130),
    `  ${r("h", 239)}${EMOJI}`,
  ]),
  get(A),
  rows(A),
  // JS whitespace: trim strips NBSP, LS/PS, BOM, the ideographic space, Ogham, VT/FF;
  // not NEL, the Mongolian vowel separator, ZWSP or a unit separator.
  set(A, [
    `${NBSP}x${NBSP}`,
    `${LS}y${PS}`,
    `${BOM}z${BOM}`,
    `${NEL}n${NEL}`,
    `${IDEO}w${IDEO}`,
    `${MVS}m${MVS}`,
    `${ZWSP}zw${ZWSP}`,
    `${OGHAM}o`,
    "\u000bvt\u000c",
    "\u001fus",
    NBSP,
    `${LS}${PS}${BOM}`,
  ]),
  get(A),
  rows(A),
  // What JSON.stringify escapes, and what it doesn't.
  set(A, [
    'say "hi"',
    "back\\slash",
    "nul\u0000one\u0001del\u007f",
    "</script><!--",
    `line${LS}sep${PS}`,
    `${EMOJI} smile`,
    "\u4e2d\u6587 \u00e9\u0301",
    "\ud835\udd18\ud835\udd2b\ud835\udd26",
    "\u05e9\u05dc\u05d5\u05dd",
    "tab\there\nnewline\rcr\bbs\fff",
  ]),
  get(A),
  rows(A),
  // reset deletes the row: the defaults again.
  reset(A),
  rows(A),
  get(A),
  reset(A),
  rows(A),
  // The display name: trimmed, 60 units, "" / blank / null delete the row.
  getName(A),
  setName(A, "Filipe"),
  rows(A),
  getName(A),
  setName(A, "  Filipe Garcia  "),
  getName(A),
  setName(A, ""),
  rows(A),
  getName(A),
  setName(A, "Ana"),
  setName(A, "   \t"),
  rows(A),
  setName(A, r("x", 61)),
  getName(A),
  setName(A, r("y", 59) + EMOJI + "z"),
  getName(A),
  rows(A),
  setName(A, `${NBSP}Ana${NBSP}`),
  getName(A),
  setName(A, `${NEL}Nel${NEL}`),
  getName(A),
  setName(A, 'Quote " and \\ back'),
  getName(A),
  setName(A, null),
  rows(A),
  getName(A),
  // reset leaves the name alone.
  setName(A, "Kept"),
  set(A, ["chip"]),
  reset(A),
  rows(A),
  getName(A),
  get(A),

  // Rows another writer stored (TEXT affinity: numbers are stored as text).
  open(F),
  rows(F),
  get(F),
  ...[
    "''",
    "'0'",
    "'null'",
    "'{}'",
    "'\"a\"'",
    "'true'",
    "'1e400'",
    "'[]'",
    q('["a"]'),
    q('[ "  a  " , "" , 1 , null , [ "b" ] , { "c" : "d" } , true , "\\t" , "e" ]'),
    q('["\\ud83d"]'),
    q('["\\udc00x", "\\ud83d\\ude00", "\\u00e9\\u0000"]'),
    q(`["${r("l", 300)}"]`),
    q(JSON.stringify(Array.from({ length: 14 }, (_, i) => `r${i}`))),
    q(JSON.stringify([" ", "", ...Array.from({ length: 13 }, (_, i) => `k${i}`)])),
    q(`["ok", ${r("[", 200)}${r("]", 200)}, "deep"]`),
    q(`${r("[", 300)}"x"${r("]", 300)}`),
    q('["a",]'),
    q('[1'),
    q('{"a"'),
    q(' \n\t\r ["ws"] \r\n'),
    q(`${BOM}["bom"]`),
    q('["a","a"]'),
    q('[1e400, -0, 0.1, "num"]'),
    q('["\\"q\\"", "\\\\", "\\/", "\\b\\f\\n\\r\\t"]'),
    q('["a\\nb\\rc\\td\\fe\\bf"]'),
    q(`["${NBSP}${LS}x${IDEO}", "${NEL}"]`),
    q('["x"] trailing'),
    q('"[\\"a\\"]"'),
    "5",
    "0.5",
    "X'5b2261225d'",
    "X''",
    "X'5b22ff225d'",
    "CAST(X'5b22c3225d' AS TEXT)",
    "CAST(X'5b22eda0bd78225d' AS TEXT)",
    "CAST(X'5b2261005d' AS TEXT)",
  ].flatMap((v) => [putExamples(F, v), get(F)]),
  rows(F),
  // The display name row.
  ...[
    q('"Ana"'),
    q('"  Ana  "'),
    q('""'),
    q('"   "'),
    "'5'",
    "'null'",
    q('["Ana"]'),
    q("Ana"),
    "''",
    q('"\\ud83d"'),
    q(`"${r("n", 100)}"`),
    q(`"${r("n", 59)}\\ud83d\\ude00"`),
    q('"x\\u0000y"'),
    "X'22416e6122'",
    "X''",
    q(`"${BOM} Bom ${NEL}"`),
  ].flatMap((v) => [putName(F, v), getName(F)]),
  rows(F),
  // A write replaces a foreign row.
  set(F, ["mine"]),
  setName(F, "Mine"),
  rows(F),

  // A table another writer made: no key constraint, no column type.
  open(G),
  rawSql(G, "DROP TABLE ui_state; CREATE TABLE ui_state (key TEXT, value);"),
  get(G),
  getName(G),
  ...[
    "0",
    "1",
    "NULL",
    "0.0",
    "1.5",
    "'[\"text\"]'",
    "X'5b22626c6f62225d'",
  ].flatMap((v) => [
    rawSql(G, `DELETE FROM ui_state; INSERT INTO ui_state VALUES ('splash_examples', ${v}), ('splash_display_name', ${v});`),
    get(G),
    getName(G),
  ]),
  rawSql(G, `DELETE FROM ui_state; INSERT INTO ui_state VALUES ('splash_examples', '["first"]'), ('splash_examples', '["second"]'), ('splash_display_name', '"One"'), ('splash_display_name', '"Two"');`),
  get(G),
  getName(G),
  set(G, ["x"]),
  setName(G, "x"),
  setName(G, "   "),
  rows(G),
  rawSql(G, `INSERT INTO ui_state VALUES ('splash_examples', '["again"]'), ('splash_display_name', '"Again"');`),
  reset(G),
  setName(G, null),
  rows(G),

  // A table without the key column: each write fails as it is prepared.
  open(C("no-key")),
  rawSql(C("no-key"), "DROP TABLE ui_state; CREATE TABLE ui_state (k TEXT PRIMARY KEY, value TEXT);"),
  get(C("no-key")),
  getName(C("no-key")),
  set(C("no-key"), ["x"]),
  reset(C("no-key")),
  setName(C("no-key"), "x"),
  setName(C("no-key"), null),

  // A database from a newer schema without the table.
  rawSql(N, "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999');"),
  get(N),
  getName(N),
  set(N, ["x"]),
  reset(N),
  setName(N, null),
  setName(N, "x"),
  meta(N),

  // Not a database at all.
  file(X, { text: r("this is not a database, just text\n", 64) }),
  get(X),
  getName(X),
  set(X, ["x"]),
  reset(X),
  setName(X, "x"),
  setName(X, null),
  // The DB path is a directory.
  file(D, { dir: true }),
  get(D),
  getName(D),
  set(D, ["x"]),
  reset(D),
  setName(D, null),
  files(D),
  // The project dir is a regular file: every open fails at its mkdir.
  { op: "projectFile", cwd: P },
  get(P),
  getName(P),
  set(P, ["x"]),
  reset(P),
  setName(P, "x"),
  files(P),

  // A database in rollback-journal mode (not WAL) with a row.
  open(JR),
  rawSql(JR, "PRAGMA journal_mode = DELETE; INSERT INTO ui_state VALUES ('splash_examples', '[\"journal\"]');", false),
  get(JR),
  getName(JR),
  set(JR, ["wal now"]),
  get(JR),
  rows(JR),

  // A read-only DB file.
  open(RO),
  putExamples(RO, q('["read-only"]')),
  file(RO, { mode: 0o444 }),
  get(RO),
  set(RO, ["x"]),
  reset(RO),
  setName(RO, null),
  get(RO),
  file(RO, { mode: 0o644 }),
  // A read-only project dir with no DB in it.
  file(RD, { mode: 0o555, target: "project" }),
  get(RD),
  set(RD, ["x"]),
  files(RD),
  file(RD, { mode: 0o755, target: "project" }),
  set(RD, ["now"]),
  get(RD),

  // The DB file moves away under the cached handles.
  set(M, ["before"]),
  get(M),
  file(M, { rm: true }),
  files(M),
  get(M),
  set(M, ["after"]),
  get(M),
  getName(M),
  files(M),

  // openDb's schema version is a JS Number(): the migrations run when it
  // isn't >= the newest id, from the first id that isn't <= it. `$LAST` is
  // the newest id, `$HEX` the same in hex and `$UTF8HEX` its digits' bytes,
  // filled in by whoever runs the SQL, so the cases hold for any number of
  // migrations. The version row isn't dumped: it reads back as written.
  // Then a fresh read-write open of the file made read-only: one that is up
  // to date (and flagged) writes nothing, so it opens.
  ...[
    "'$LAST'",
    "' $LAST '",
    "'$LAST.0'",
    "'0x$HEX'",
    "'$LASTe0'",
    "'99999999999'",
    "'Infinity'",
    "'1e999'",
    "'abc'",
    "''",
    "'-1'",
    "'0'",
    "'$LAST.5'",
    "$LAST",
    "$LAST.0",
    "X'$UTF8HEX'",
    // Number(null) is 0. 010 adds sessions.goal, so `10` reruns from 011
    // only.
    "NULL",
    "'10'",
    "'10.5'",
  ].flatMap((v, i) => {
    const cwd = C(`version-${i}`);
    return [
      open(cwd),
      rawSql(cwd, `DROP TABLE schema_meta; CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value); INSERT INTO schema_meta VALUES ('version', ${v}), ('notifications_abort_cleanup_v1', '1');`),
      set(cwd, ["v"]),
      get(cwd),
      flag(cwd),
      file(cwd, { mode: 0o444 }),
      open(cwd),
      open(cwd),
    ];
  }),
  // The one-shot cleanup's flag is compared with === "1".
  ...["1", "'1.0'", "' 1'", "'1'", "X'31'"].flatMap((v, i) => {
    const cwd = C(`cleanup-${i}`);
    return [
      open(cwd),
      rawSql(cwd, `DROP TABLE schema_meta; CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value); INSERT INTO schema_meta VALUES ('version', '$LAST'), ('notifications_abort_cleanup_v1', ${v});`),
      set(cwd, ["c"]),
      flag(cwd),
      file(cwd, { mode: 0o444 }),
      open(cwd),
      open(cwd),
    ];
  }),
  // A schema_meta table without the value column.
  open(C("meta-no-value")),
  rawSql(C("meta-no-value"), "DROP TABLE schema_meta; CREATE TABLE schema_meta (key TEXT PRIMARY KEY);"),
  set(C("meta-no-value"), ["x"]),
  get(C("meta-no-value")),
];

const db = [];
for (const s of STEPS) {
  let got;
  try {
    switch (s.op) {
      case "get":
        got = J(await splash.getSplashExamples(s.cwd));
        break;
      case "set":
        got = J(await splash.setSplashExamples(s.cwd, s.examples));
        break;
      case "reset":
        got = J(await splash.resetSplashExamples(s.cwd));
        break;
      case "getName":
        got = J(await splash.getSplashDisplayName(s.cwd));
        break;
      case "setName":
        got = J(await splash.setSplashDisplayName(s.cwd, s.name));
        break;
      case "open":
        await openDb(s.cwd);
        closeDb(s.cwd);
        got = "ok";
        break;
      case "raw":
        raw(s.cwd, fill(s.sql), s.wal);
        got = "ok";
        break;
      case "file":
        fileOp(s.cwd, s.spec);
        got = "ok";
        break;
      case "projectFile":
        mkdirSync(dirname(projectDir(s.cwd)), { recursive: true });
        writeFileSync(projectDir(s.cwd), "a file, not a directory\n");
        got = "ok";
        break;
      case "rows":
        got = dump(s.cwd, ROWS_SQL);
        break;
      case "meta":
        got = dump(s.cwd, META_SQL);
        break;
      case "flag":
        got = dump(s.cwd, FLAG_SQL);
        break;
      case "files":
        got = { dir: kind(projectDir(s.cwd)), db: kind(dbPath(s.cwd)) };
        break;
      default:
        throw new Error(`unknown op ${s.op}`);
    }
  } catch (e) {
    got = threw(e);
  }
  db.push({ ...s, got });
}

// ------------------------------- fallback name -------------------------------

const ACCOUNTS = join(HOME, ".claude", ".claudius", "accounts.json");
const GLOBAL = join(HOME, ".claude.json");

function writeSpec(path, spec) {
  if (spec === undefined) return;
  try {
    chmodSync(path, 0o644);
  } catch {
    // missing
  }
  rmSync(path, { recursive: true, force: true });
  if (spec === null) return;
  mkdirSync(dirname(path), { recursive: true });
  if (spec.dir) {
    mkdirSync(path);
    return;
  }
  const text = spec.json !== undefined ? JSON.stringify(spec.json, null, 2) : spec.text;
  writeFileSync(path, text);
  if (spec.mode !== undefined) chmodSync(path, spec.mode);
}

let seq = 0;
const profile = (label, extra = {}) => {
  seq += 1;
  return {
    id: `acc_${String(seq).padStart(16, "0")}`,
    label,
    kind: "oauth-token",
    secret: `sk-ant-oat01-${seq}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
};
const accounts = (profiles, active) => ({
  json: { profiles, activeProfileId: active === undefined ? (profiles[0]?.id ?? null) : active, autoRotateOnRateLimit: false },
});
const oauth = (acct) => ({ json: { numStartups: 3, oauthAccount: acct } });
const named = (displayName) => oauth({ accountUuid: "u-1", emailAddress: "a@example.com", displayName });

const two = [profile("Work Max"), profile("Personal Pro")];
const FALLBACK = [
  ["nothing configured", [{}]],
  ["the global display name", [{ global: named("Filipe Garcia") }]],
  ["the first word only", [{ global: named("  Ana  Maria  ") }]],
  ["an empty display name", [{ global: named("") }]],
  ["a blank display name", [{ global: named("   ") }]],
  ["a display name split by a tab", [{ global: named("Jo\tSmith") }]],
  ["a display name split by a newline", [{ global: named("Jo\nSmith") }]],
  ["a display name split by an NBSP", [{ global: named(`Jo${NBSP}Smith`) }]],
  ["a display name split by a line separator", [{ global: named(`Jo${LS}Smith`) }]],
  ["a display name split by an ideographic space", [{ global: named(`\uff2a\uff4f${IDEO}Smith`) }]],
  ["a NEL is not a separator", [{ global: named(`Jo${NEL}Smith`) }]],
  ["a Mongolian vowel separator is not one", [{ global: named(`Jo${MVS}Smith`) }]],
  ["a ZWSP is not one", [{ global: named(`Jo${ZWSP}Smith`) }]],
  ["a BOM is trimmed", [{ global: named(`${BOM}Jo Smith`) }]],
  ["an astral first word", [{ global: named(`${EMOJI} Smile`) }]],
  ["a non-string display name", [{ global: named(42) }]],
  ["no oauthAccount", [{ global: { json: { numStartups: 3 } } }]],
  ["oauthAccount null", [{ global: oauth(null) }]],
  ["oauthAccount a string", [{ global: oauth("Filipe") }]],
  ["oauthAccount an array", [{ global: oauth(["Filipe"]) }]],
  ["global config malformed", [{ global: { text: '{"oauthAccount": {"displayName": "X"}' } }]],
  ["global config null", [{ global: { text: "null" } }]],
  ["global config a directory", [{ global: { dir: true } }]],
  ["global config unreadable", [{ global: { ...named("Hidden"), mode: 0 } }]],
  ["one account, no global", [{ accounts: accounts([profile("Work Max")]) }]],
  ["one account, the global name wins", [{ accounts: accounts([profile("Work Max")]), global: named("Filipe Garcia") }]],
  ["one account, a blank global name", [{ accounts: accounts([profile("Work Max")]), global: named("   ") }]],
  ["one account, an empty global name", [{ accounts: accounts([profile("Work Max")]), global: named("") }]],
  ["one account with a blank label", [{ accounts: accounts([profile("   ")]) }]],
  ["one account, not the active one", [{ accounts: accounts([profile("Solo Label")], null) }]],
  ["two accounts: the active label", [{ accounts: accounts(two, two[1].id), global: named("Filipe Garcia") }]],
  ["two accounts: the first active", [{ accounts: accounts(two, two[0].id) }]],
  ["two accounts, none active", [{ accounts: accounts(two, null), global: named("Filipe Garcia") }]],
  ["two accounts, an unknown active id", [{ accounts: accounts(two, "acc_missing"), global: named("Filipe Garcia") }]],
  ["two accounts, a blank active label", [{ accounts: accounts([profile(" \t "), profile("Other One")], undefined), global: named("Filipe") }]],
  ["two accounts, a padded active label", [{ accounts: accounts([profile("  Padded  Label "), profile("Other")]) }]],
  [
    "two accounts sharing an id",
    [{ accounts: { json: { profiles: [{ ...two[0], label: "First Twin" }, { ...two[0], label: "Second Twin" }], activeProfileId: two[0].id } } }],
  ],
  [
    "two entries, one invalid: counts as one",
    [{ accounts: { json: { profiles: [profile("Valid One"), { id: "x", label: "No Secret", kind: "oauth-token", createdAt: "x" }], activeProfileId: null } } }],
  ],
  [
    "two entries, one invalid, with a global name",
    [{ accounts: { json: { profiles: [profile("Valid One"), { id: "x", label: "Bad Kind", kind: "nope", secret: "s", createdAt: "x" }] } }, global: named("Global Name") }],
  ],
  [
    "a bedrock profile without its config is dropped",
    [{ accounts: { json: { profiles: [profile("Rock One", { kind: "bedrock" }), profile("Plain Two")], activeProfileId: null } } }],
  ],
  ["three accounts", [{ accounts: accounts([profile("A a"), profile("B b"), profile("C c")], undefined) }]],
  ["accounts malformed, global name", [{ accounts: { text: '{"profiles": [' }, global: named("Fallback Name") }]],
  ["accounts null, global name", [{ accounts: { text: "null" }, global: named("Fallback Name") }]],
  ["accounts a directory", [{ accounts: { dir: true }, global: named("Fallback Name") }]],
  ["accounts unreadable", [{ accounts: { ...accounts([profile("Hidden")]), mode: 0 } }]],
  ["accounts with profiles not an array", [{ accounts: { json: { profiles: { a: 1 } } }, global: named("G g") }]],
  ["an astral label", [{ accounts: accounts([profile(`${EMOJI}${EMOJI} two`)]) }]],
  ["a label with a NEL", [{ accounts: accounts([profile(`One${NEL}Word`)]) }]],
  [
    "the global config is cached for 30 s, failures too",
    [
      { global: named("First Name") },
      { global: named("Second Name") },
      { reset: true },
      { global: null },
      { reset: true },
      { global: named("Third Name") },
      { reset: true },
    ],
  ],
  [
    "accounts are read every time",
    [
      { accounts: accounts([profile("One Label")]) },
      { accounts: accounts(two, two[1].id) },
      { accounts: null },
      { accounts: accounts([profile("Back Again")]) },
    ],
  ],
];

const fallback = [];
for (const [name, calls] of FALLBACK) {
  writeSpec(ACCOUNTS, null);
  writeSpec(GLOBAL, null);
  __resetClaudeGlobalConfigCache();
  const recorded = [];
  for (const c of calls) {
    writeSpec(ACCOUNTS, c.accounts);
    writeSpec(GLOBAL, c.global);
    if (c.reset) __resetClaudeGlobalConfigCache();
    let got;
    try {
      got = J(await resolveSplashFallbackName());
    } catch (e) {
      got = threw(e);
    }
    recorded.push({ ...c, got });
  }
  fallback.push({ name, calls: recorded });
}
writeSpec(ACCOUNTS, null);
writeSpec(GLOBAL, null);

writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ last: LAST, db, fallback }));
process.exit(0);
