#!/usr/bin/env node
// Golden fixture for workspace relocation (G09): `lib/server/workspace-relocate.ts`
// (`listWorkspaceSessionIds`, `relocateWorkspaceSessions`) and the route
// handlers of `app/api/workspaces/[id]/move-sessions/route.ts` (GET, POST),
// recorded from the real TS sources on the real DB layer:
//
//   node rust/scripts/workspace-relocate-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself under `--experimental-transform-types` with a resolve hook
// for the extensionless / `@/` imports, twice (two temp roots, both through
// realpath); both recordings must agree byte for byte. The child runs with
// its cwd at the repo (db.ts reads the migrations from there), HOME at
// `<root>/home` (the projects dir and the workspace store hang off it),
// CLAUDE_CONFIG_DIR at `<root>/config` (a decoy) and umask 022. `Date` is
// pinned: it reads a clock that starts at 2001-01-01T00:00:00.000Z and moves
// 1001 ms before every call or request.
//
// Placeholders: `$ROOT` is the root and `$EROOT` its `encodeProjectDir` form,
// swapped textually in paths, bodies, file texts, SQL and results.
//
// Records:
// - `core`: scenarios of direct calls (`list` = listWorkspaceSessionIds,
//   `relocate` = relocateWorkspaceSessions) on fixed roots (`/wsrel/...`, which
//   don't exist on disk), each in a fresh world built by `setup` ops (`write`
//   text or bytes, `mkdir`, `symlink`, `hardlink` (to a path under the root),
//   `chmod`, `fifo`, `rm`; `sql` runs SQL on
//   a root's DB through `openDb` (migrated) and closes it; `rawdb` makes a DB
//   file with plain better-sqlite3, `wal` or not, no migrations). Each call
//   records `result` (the value as JSON; a Buffer as `{type, data}`) or
//   `threw` (`{name, message}`), then the tree: every entry under
//   `home/.claude/projects` and `outside` (kind, mode, UTF-8 text or bytes,
//   symlink target; a `.claudius.db` as a dump of its tables: name, columns
//   and each cell's SQLite type and text; `-wal` / `-shm` files left out),
//   as `changes`: `[path, entry]` for every path whose entry differs from
//   the tree after the previous call (`null`: gone).
// - `routes`: groups of route requests (`method`, `id`, `body` text) and
//   setups, one world per group, with the workspace store written verbatim
//   (`store`). Each request records `now` (the pinned clock it ran at),
//   `got` (status, content type and body text, or `threw`: Next's empty 500)
//   and its `changes` (as above, plus `home/.claude/.claudius/workspaces.json`;
//   the first against the tree after the group's setup).
//   Groups with `sessions` put bare stand-ins in `sessionManager`'s map (the
//   route's `sessionsByCwd` and `remove` find them; `getStatus()` answers the
//   given status) after upserting each one's `sessions` row the way a real
//   `start()` does; each request then records which are still live (`live`)
//   and which `end()` was called on (`ended`).
// - `needs: ["perm"]` marks scenarios / groups that only replay on a disk
//   that enforces permissions (not root); they are recorded as skipped where
//   it doesn't.
//
// Written to rust/crates/claudius-core/tests/fixtures/workspace_relocate_golden.json
// and replayed by crates/claudius-core/tests/workspace_relocate_golden.rs (core)
// and crates/claudius-server/tests/workspace_relocate.rs (routes, against the
// real binary, with fake-CLI sessions in the live groups).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/workspace_relocate_golden.json");

/** chmod every directory under `p` back to 0755, so it can be removed. */
function openUp(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(p, 0o755);
  } catch {
    return;
  }
  for (const e of readdirSync(p)) openUp(join(p, e));
}

// ------------------------------- recording -------------------------------

if (!process.env.WSREL_GOLDEN_ROOT) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wsrel-golden-")));
    try {
      // Placeholders are swapped textually in paths, JSON text and files.
      if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error(`root needs escaping: ${root}`);
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
            WSREL_GOLDEN_ROOT: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      openUp(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    if (process.env.WSREL_GOLDEN_DUMP) {
      runs.forEach((r, i) => writeFileSync(`${process.env.WSREL_GOLDEN_DUMP}.${i}.json`, `${JSON.stringify(JSON.parse(r), null, 1)}\n`));
    }
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const calls = fixture.core.reduce((n, s) => n + (s.steps ?? []).filter((x) => x.call).length, 0);
  const requests = fixture.routes.reduce((n, g) => n + (g.steps ?? []).filter((x) => x.request).length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.core.length} core scenarios (${calls} calls), ${fixture.routes.length} route groups (${requests} requests)`,
  );
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.WSREL_GOLDEN_ROOT;
process.umask(0o022);

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

// The pinned clock: `new Date()` and `Date.now()` both read it.
const BASE = Date.UTC(2001, 0, 1);
let clock = BASE;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock);
    else super(...args);
  }
  static now() {
    return clock;
  }
};
const tick = () => {
  clock += 1001;
  return clock;
};

const { default: Database } = await import("better-sqlite3");
const reloc = await import(join(repo, "lib/server/workspace-relocate.ts"));
const { openDb, closeDb, closeAll } = await import(join(repo, "lib/server/db.ts"));
const { upsertSession } = await import(join(repo, "lib/server/sessions-db.ts"));
const { sessionManager } = await import(join(repo, "lib/server/session-manager.ts"));
const route = await import(join(repo, "app/api/workspaces/[id]/move-sessions/route.ts"));

/** Characters by code point, so this file stays ASCII. */
const U = (...cps) => String.fromCodePoint(...cps);
const BS = String.fromCharCode(92);
const J = (v) => JSON.stringify(v);

const encodeDir = (s) => s.replace(/[^A-Za-z0-9]/g, "-");
const EROOT = encodeDir(ROOT);
const toAbs = (s) => s.replaceAll("$EROOT", EROOT).replaceAll("$ROOT", ROOT);
const toRel = (s) => s.replaceAll(EROOT, "$EROOT").replaceAll(ROOT, "$ROOT");
/** `f` over every string (keys too) of a JSON value. */
function deep(v, f) {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), deep(x, f)]));
  return v;
}
/** The projects dir (relative to $ROOT) of a root. */
const PD = (root) => `home/.claude/projects/${encodeDir(toAbs(root)).replaceAll(EROOT, "$EROOT")}`;
/** A session id: `<8 hex>-0000-4000-8000-<12 hex>`, `n` in hex at the end of both. */
function SID(n, c = "a") {
  const h = n.toString(16);
  return `${c.repeat(8 - h.length)}${h}-0000-4000-8000-${h.padStart(12, "0")}`;
}

// --------------------------------- trees ---------------------------------

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const qi = (n) => `"${n.replace(/"/g, '""')}"`;

/** Every table of a DB file: its `sql`, columns and cells as [type, text]. */
function dumpDb(file) {
  let db;
  try {
    db = new Database(file, { fileMustExist: true });
  } catch (e) {
    return { error: e.message };
  }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const out = [];
    for (const { name } of tables) {
      const cols = db.prepare("SELECT name FROM pragma_table_info(?)").all(name).map((c) => c.name);
      const sel = cols
        .map((c) => `typeof(${qi(c)}), CASE typeof(${qi(c)}) WHEN 'blob' THEN hex(${qi(c)}) ELSE CAST(${qi(c)} AS TEXT) END`)
        .join(", ");
      const rows = db.prepare(`SELECT ${sel} FROM ${qi(name)}`).raw().all();
      out.push({ name, cols, rows: rows.map((r) => r.map((x) => (typeof x === "string" ? toRel(x) : x))) });
    }
    return { tables: out };
  } catch (e) {
    return { error: e.message };
  } finally {
    db.close();
  }
}

/** Every entry under the watched dirs (keys with placeholders), sorted. */
function snapshot(extra = []) {
  const snap = {};
  const visit = (rel) => {
    const abs = join(ROOT, toAbs(rel));
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    const mode = st.mode & 0o7777;
    if (st.isSymbolicLink()) {
      snap[rel] = { kind: "symlink", target: toRel(readlinkSync(abs)) };
    } else if (st.isDirectory()) {
      snap[rel] = { kind: "dir", mode };
      let names = [];
      try {
        names = readdirSync(abs).sort();
      } catch {
        snap[rel].unreadable = true;
      }
      for (const e of names) {
        if (/\.claudius\.db-(wal|shm)$/.test(e)) continue;
        visit(`${rel}/${toRel(e)}`);
      }
    } else if (st.isFIFO()) {
      snap[rel] = { kind: "fifo", mode };
    } else if (rel.endsWith("/.claudius.db")) {
      snap[rel] = { kind: "db", mode, db: dumpDb(abs) };
    } else {
      let buf;
      try {
        buf = readFileSync(abs);
      } catch {
        snap[rel] = { kind: "file", mode, unreadable: true };
        return;
      }
      let text = null;
      try {
        text = utf8.decode(buf);
      } catch {
        // not UTF-8: recorded as bytes
      }
      snap[rel] = text === null ? { kind: "file", mode, bytes: [...buf] } : { kind: "file", mode, text: toRel(text) };
    }
  };
  for (const w of ["home/.claude/projects", "outside", ...extra]) visit(w);
  return Object.fromEntries(Object.keys(snap).sort().map((k) => [k, snap[k]]));
}

/** `[path, entry]` for every path whose entry differs (`null`: gone), sorted. */
function changes(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => J(before[k]) !== J(after[k])).map((k) => [k, after[k] ?? null]);
}

function buildWorld(dirs = []) {
  openUp(ROOT);
  for (const e of readdirSync(ROOT)) {
    if (e === "out.json") continue;
    rmSync(join(ROOT, e), { recursive: true, force: true });
  }
  for (const d of ["home/.claude/.claudius", "config", "outside", ...dirs]) mkdirSync(join(ROOT, toAbs(d)), { recursive: true });
}

/** Apply a setup op; returns it as the fixture records it. */
async function apply(op) {
  const p = op.path === undefined ? undefined : join(ROOT, toAbs(op.path));
  switch (op.op) {
    case "write":
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, op.bytes ? Buffer.from(op.bytes) : toAbs(op.text));
      return op;
    case "mkdir":
      mkdirSync(p, { recursive: true });
      return op;
    case "rm":
      openUp(p);
      rmSync(p, { recursive: true, force: true });
      return op;
    case "symlink":
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(toAbs(op.target), p);
      return op;
    case "chmod":
      chmodSync(p, op.mode);
      return op;
    case "hardlink":
      mkdirSync(dirname(p), { recursive: true });
      linkSync(join(ROOT, toAbs(op.target)), p);
      return op;
    case "fifo": {
      mkdirSync(dirname(p), { recursive: true });
      const r = spawnSync("mkfifo", [p]);
      if (r.status !== 0) throw new Error(`mkfifo ${p}: ${r.stderr}`);
      return op;
    }
    case "sql": {
      const root = toAbs(op.root);
      const db = await openDb(root);
      db.exec(toAbs(op.sql));
      closeDb(root);
      return op;
    }
    case "rawdb": {
      mkdirSync(dirname(p), { recursive: true });
      const db = new Database(p);
      if (op.wal) db.pragma("journal_mode = WAL");
      db.exec(toAbs(op.sql));
      db.close();
      return op;
    }
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

const S = (...ops) => ({ setup: ops });
const W = (path, text) => ({ op: "write", path, text });
const WB = (path, bytes) => ({ op: "write", path, bytes });
const RM = (path) => ({ op: "rm", path });
const MK = (path) => ({ op: "mkdir", path });
const LN = (path, target) => ({ op: "symlink", path, target });
const HL = (path, target) => ({ op: "hardlink", path, target });
const CH = (path, mode) => ({ op: "chmod", path, mode });
const FIFO = (path) => ({ op: "fifo", path });
const SQL = (root, sql) => ({ op: "sql", root, sql });
const RAW = (path, sql, wal = true) => ({ op: "rawdb", path, sql, wal });

/** Whether this disk enforces permissions (not root). */
function probePerm() {
  const d = join(ROOT, "perm-probe");
  mkdirSync(d);
  chmodSync(d, 0);
  let enforced = false;
  try {
    readdirSync(d);
  } catch {
    enforced = true;
  }
  chmodSync(d, 0o755);
  rmSync(d, { recursive: true });
  return enforced;
}
const PERM = probePerm();

function threwOf(e) {
  return { name: e?.name ?? null, message: toRel(e instanceof Error ? e.message : String(e)) };
}

// ------------------------------ transcripts ------------------------------

function transcript(id, cwd, prompt = "hello", trailing = true) {
  const lines = [
    { parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: prompt }, uuid: `${id.slice(0, 8)}-0000-4000-8000-000000000001`, timestamp: "2026-10-01T10:00:00.000Z", cwd, sessionId: id },
    { parentUuid: `${id.slice(0, 8)}-0000-4000-8000-000000000001`, isSidechain: false, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, uuid: `${id.slice(0, 8)}-0000-4000-8000-000000000002`, timestamp: "2026-10-01T10:00:01.000Z", cwd, sessionId: id },
  ];
  const text = lines.map((l) => J(l)).join("\n");
  return trailing ? `${text}\n` : text;
}
/** A transcript file in `root`'s projects dir. */
const T = (root, id, opts = {}) => W(`${PD(root)}/${id}.jsonl`, transcript(id, root, opts.prompt, opts.trailing ?? true));
const esc = (s) => s.replace(/'/g, "''");
const ins = {
  session: (id, cwd, title = null) => `INSERT INTO sessions(id, cwd, title, model, created_at, updated_at, last_seen_at) VALUES (${id === null ? "NULL" : `'${esc(id)}'`}, '${esc(cwd)}', ${title === null ? "NULL" : `'${esc(title)}'`}, NULL, 1, 2, 3);`,
  draft: (sid, text) => `INSERT INTO prompt_drafts(session_id, text, updated_at) VALUES ('${sid}', '${esc(text)}', 5);`,
  commit: (cwd, msg, at = 1) => `INSERT INTO commit_drafts(cwd, message, updated_at) VALUES ('${esc(cwd)}', '${esc(msg)}', ${at});`,
  ui: (key, value) => `INSERT INTO ui_state(key, value) VALUES ('${key}', '${esc(value)}');`,
  tick: (sid, tool, at = 1) => `INSERT INTO loop_ticks(session_id, tool_use_id, prompt, fired_at, created_at) VALUES ('${sid}', '${tool}', 'p', ${at}, ${at});`,
  asset: (hash) => `INSERT INTO assets(hash, media_type, size_bytes, width, height, first_seen_ms, last_seen_ms) VALUES ('${hash}', 'image/png', 3, 1, 1, 10, 20);`,
  use: (hash, sid, n = 0) => `INSERT INTO asset_uses(asset_hash, session_id, message_uuid, ordinal, occurred_ms) VALUES ('${hash}', '${sid}', 'm${n}', ${n}, 30);`,
  feedback: (id, sid, cwd) => `INSERT INTO feedback(id, session_id, cwd, rating, comment, surface, forwarded, created_at) VALUES ('${id}', '${sid}', '${esc(cwd)}', 'good', 'c', 's', 0, 7);`,
  usage: (sid) => `INSERT INTO session_usage(session_id, total_cost_usd, num_turns, updated_at) VALUES ('${sid}', 0.5, 3, 9);`,
  goal: (sid, uuid) => `INSERT INTO goal_messages(session_id, message_uuid, goal_text, created_at) VALUES ('${sid}', '${uuid}', 'g', 11);`,
};

// --------------------------------- core ---------------------------------

const L = (root) => ({ call: ["list", root] });
const R = (from, to) => ({ call: ["relocate", from, to] });

const S1 = SID(1);
const S2 = SID(2);
const S3 = SID(3);
const S4 = SID(4);
const S5 = SID(5);
const S6 = SID(6);
const S7 = SID(7);
const S8 = SID(8);
const S12 = SID(12);
const S13 = SID(13);
const DBONLY = SID(9, "d");
const OTHER = SID(10, "e");
const UPPER = SID(11, "b").toUpperCase();

/** The usual Claudius state for a root. */
const DB_SEED = (root) =>
  [
    ins.session(S1, root, "Renamed first"),
    ins.session(DBONLY, root, "Renamed before first turn"),
    ins.session(OTHER, `${root}/elsewhere`, "Another root"),
    ins.draft(S1, "half a thought"),
    ins.commit(root, "old draft"),
    ins.ui("open_tabs", J([S1, S2])),
    ins.tick(S1, "t1"),
    ins.tick(S2, "t2", 2),
    ins.asset("abcd"),
    ins.use("abcd", S1),
    ins.feedback("f1", S1, root),
    ins.usage(S1),
    ins.goal(S1, "u1"),
  ].join("\n");

const CORE = [
  {
    name: "basic move",
    steps: [
      S(
        T("/wsrel/basic/old", S1),
        T("/wsrel/basic/old", S2, { trailing: false }),
        W(`${PD("/wsrel/basic/old")}/${S3}.jsonl`, ""),
        W(`${PD("/wsrel/basic/old")}/${S1}/subagents/agent-a.jsonl`, "{}\n"),
        W(`${PD("/wsrel/basic/old")}/${S1}/tool-results/r.txt`, "result\n"),
        LN(`${PD("/wsrel/basic/old")}/${S1}/rel-link`, "tool-results/r.txt"),
        WB(`${PD("/wsrel/basic/old")}/${S1}/tool-results/bin.dat`, [0xff, 0x00, 0xfe]),
        W(`${PD("/wsrel/basic/old")}/assets/ab/abcd.png`, "png"),
        W(`${PD("/wsrel/basic/old")}/memory/MEMORY.md`, "- note\n"),
        W(`${PD("/wsrel/basic/old")}/notes.txt`, "n\n"),
        W(`${PD("/wsrel/basic/old")}/x.jsonl`, "x\n"),
        W(`${PD("/wsrel/basic/old")}/${S4}.jsonl.bak`, "bak\n"),
        W(`${PD("/wsrel/basic/old")}/${S4}`, "a sidecar name without its transcript\n"),
        SQL("/wsrel/basic/old", DB_SEED("/wsrel/basic/old")),
      ),
      L("/wsrel/basic/old"),
      L("/wsrel/basic/new"),
      R("/wsrel/basic/old", "/wsrel/basic/new"),
      L("/wsrel/basic/old"),
      L("/wsrel/basic/new"),
      R("/wsrel/basic/new", "/wsrel/basic/new"),
      R("/wsrel/basic/old", "/wsrel/basic/new"),
    ],
  },
  {
    name: "merge into a folder with history",
    steps: [
      S(
        T("/wsrel/merge/old", S1),
        T("/wsrel/merge/old", S2),
        W(`${PD("/wsrel/merge/old")}/${S1}/subagents/agent-a.jsonl`, "old a\n"),
        W(`${PD("/wsrel/merge/old")}/${S1}/subagents/agent-b.jsonl`, "old b\n"),
        W(`${PD("/wsrel/merge/old")}/${S1}/deep/er/x.txt`, "deep\n"),
        CH(`${PD("/wsrel/merge/old")}/${S1}/deep`, 0o750),
        W(`${PD("/wsrel/merge/old")}/${S1}/exec.sh`, "#!/bin/sh\n"),
        CH(`${PD("/wsrel/merge/old")}/${S1}/exec.sh`, 0o751),
        W(`${PD("/wsrel/merge/old")}/${S2}/subagents/agent-c.jsonl`, "old c\n"),
        W(`${PD("/wsrel/merge/old")}/assets/ab/abcd.png`, "old png"),
        W(`${PD("/wsrel/merge/old")}/assets/ef/ef01.png`, "old ef"),
        SQL("/wsrel/merge/old", DB_SEED("/wsrel/merge/old")),
        W(`${PD("/wsrel/merge/new")}/${S1}/subagents/agent-a.jsonl`, "new a\n"),
        W(`${PD("/wsrel/merge/new")}/${S1}/other.txt`, "new other\n"),
        W(`${PD("/wsrel/merge/new")}/assets/ab/abcd.png`, "new png"),
        W(`${PD("/wsrel/merge/new")}/assets/cd/cd01.png`, "new cd"),
        SQL(
          "/wsrel/merge/new",
          [
            ins.session(S1, "/wsrel/merge/new", "Kept title"),
            ins.commit("/wsrel/merge/new", "new draft", 2),
            ins.ui("open_tabs", "[]"),
            ins.ui("active_tab", S2),
            ins.tick("other", "t0"),
            ins.tick("other", "t1"),
            ins.asset("abcd"),
            ins.draft(S2, "kept"),
          ].join("\n"),
        ),
      ),
      R("/wsrel/merge/old", "/wsrel/merge/new"),
      L("/wsrel/merge/new"),
    ],
  },
  {
    name: "collision",
    steps: [
      S(
        T("/wsrel/coll/old", S1),
        T("/wsrel/coll/old", S2),
        W(`${PD("/wsrel/coll/old")}/${S1}/a.txt`, "sidecar\n"),
        W(`${PD("/wsrel/coll/new")}/${S1}.jsonl`, "already here\n"),
        W(`${PD("/wsrel/coll/old")}/memory/MEMORY.md`, "- m\n"),
        SQL("/wsrel/coll/old", ins.session(S1, "/wsrel/coll/old")),
      ),
      R("/wsrel/coll/old", "/wsrel/coll/new"),
      L("/wsrel/coll/old"),
      L("/wsrel/coll/new"),
      R("/wsrel/coll/old", "/wsrel/coll/new"),
    ],
  },
  {
    name: "transcript names and shapes",
    steps: [
      S(
        W(`${PD("/wsrel/names/old")}/${UPPER}.JSONL`, "upper\n"),
        W(`${PD("/wsrel/names/old")}/${UPPER}/x.txt`, "upper sidecar\n"),
        W(`${PD("/wsrel/names/old")}/${S1}.JsOnL`, "mixed"),
        W(`${PD("/wsrel/names/old")}/${S2}.jsonl/inside.txt`, "a directory named like a transcript\n"),
        W("outside/target.jsonl", "linked"),
        LN(`${PD("/wsrel/names/old")}/${S3}.jsonl`, "$ROOT/outside/target.jsonl"),
        LN(`${PD("/wsrel/names/old")}/${S4}.jsonl`, "$ROOT/outside/missing.jsonl"),
        W("outside/rel.jsonl", "relative\n"),
        LN(`${PD("/wsrel/names/old")}/${S5}.jsonl`, "../../../../outside/rel.jsonl"),
        W(`${PD("/wsrel/names/old")}/not-a-uuid.jsonl`, "no\n"),
        W(`${PD("/wsrel/names/old")}/${S6}.jsonl.tmp`, "no\n"),
        W(`${PD("/wsrel/names/old")}/${S7.slice(0, 35)}g.jsonl`, "no\n"),
        W(`${PD("/wsrel/names/old")}/x${S7}.jsonl`, "no\n"),
        W(`${PD("/wsrel/names/old")}/${S8}/orphan.txt`, "a sidecar without a transcript\n"),
        W(`${PD("/wsrel/names/old")}/assets`, "assets as a plain file\n"),
      ),
      L("/wsrel/names/old"),
      R("/wsrel/names/old", "/wsrel/names/new"),
      L("/wsrel/names/new"),
    ],
  },
  {
    name: "sidecar shapes",
    steps: [
      S(
        // S1: the sidecar is a file and nothing waits for it.
        T("/wsrel/side/old", S1),
        W(`${PD("/wsrel/side/old")}/${S1}`, "sidecar file\n"),
        // S2: a directory where the new folder has a file.
        T("/wsrel/side/old", S2),
        W(`${PD("/wsrel/side/old")}/${S2}/a.txt`, "a\n"),
        W(`${PD("/wsrel/side/new")}/${S2}`, "a file in the way\n"),
        // S3: a file where the new folder has a directory.
        T("/wsrel/side/old", S3),
        W(`${PD("/wsrel/side/old")}/${S3}`, "sidecar file\n"),
        W(`${PD("/wsrel/side/new")}/${S3}/kept.txt`, "kept\n"),
        // S4: both directories, with links: new ones made absolute, a
        // different one replaced, a file in the way of a link.
        T("/wsrel/side/old", S4),
        W(`${PD("/wsrel/side/old")}/${S4}/sub/f.txt`, "f\n"),
        LN(`${PD("/wsrel/side/old")}/${S4}/rel-link`, "sub/f.txt"),
        LN(`${PD("/wsrel/side/old")}/${S4}/abs-link`, "$ROOT/outside"),
        W("outside/one", "one\n"),
        LN(`${PD("/wsrel/side/old")}/${S4}/swap-link`, "$ROOT/outside/one"),
        LN(`${PD("/wsrel/side/new")}/${S4}/swap-link`, "$ROOT/outside/two"),
        W(`${PD("/wsrel/side/new")}/${S4}/sub/g.txt`, "g\n"),
        // S5: the same link on both sides.
        T("/wsrel/side/old", S5),
        LN(`${PD("/wsrel/side/old")}/${S5}/same`, "$ROOT/outside/x"),
        LN(`${PD("/wsrel/side/new")}/${S5}/same`, "$ROOT/outside/x"),
        // S6: a link onto a directory, where the new folder has a directory.
        T("/wsrel/side/old", S6),
        LN(`${PD("/wsrel/side/old")}/${S6}`, "$ROOT/outside"),
        MK(`${PD("/wsrel/side/new")}/${S6}`),
        // S7: a link, nothing in the way.
        T("/wsrel/side/old", S7),
        LN(`${PD("/wsrel/side/old")}/${S7}`, "$ROOT/outside"),
        // S8: a FIFO in a merged directory.
        T("/wsrel/side/old", S8),
        W(`${PD("/wsrel/side/old")}/${S8}/a.txt`, "a\n"),
        FIFO(`${PD("/wsrel/side/old")}/${S8}/pipe`),
        MK(`${PD("/wsrel/side/new")}/${S8}`),
        // A file where the link points.
        W(`${PD("/wsrel/side/new")}/${UPPER}/x`, "x\n"),
        T("/wsrel/side/old", UPPER),
        LN(`${PD("/wsrel/side/old")}/${UPPER}/x`, "$ROOT/outside/y"),
        // S12: the same file (a hard link) on both sides.
        T("/wsrel/side/old", S12),
        W(`${PD("/wsrel/side/old")}/${S12}/h.txt`, "h\n"),
        HL(`${PD("/wsrel/side/new")}/${S12}/h.txt`, `${PD("/wsrel/side/old")}/${S12}/h.txt`),
        // S13: a link to a folder where the new folder links to its parent.
        T("/wsrel/side/old", S13),
        MK("outside/sub"),
        LN(`${PD("/wsrel/side/old")}/${S13}/l`, "$ROOT/outside/sub"),
        LN(`${PD("/wsrel/side/new")}/${S13}/l`, "$ROOT/outside"),
      ),
      R("/wsrel/side/old", "/wsrel/side/new"),
    ],
  },
  {
    name: "assets in the way",
    steps: [
      S(
        T("/wsrel/assets/old", S1),
        W(`${PD("/wsrel/assets/old")}/assets`, "a file\n"),
        W(`${PD("/wsrel/assets/new")}/assets/ab/x.png`, "x"),
      ),
      R("/wsrel/assets/old", "/wsrel/assets/new"),
    ],
  },
  {
    name: "assets and database errors together",
    steps: [
      S(
        T("/wsrel/both/old", S1),
        W(`${PD("/wsrel/both/old")}/assets/ab/abcd.png`, "png"),
        W(`${PD("/wsrel/both/new")}/assets`, "a file\n"),
        W(`${PD("/wsrel/both/old")}/.claudius.db`, "not a database, just text. ".repeat(40)),
      ),
      R("/wsrel/both/old", "/wsrel/both/new"),
      L("/wsrel/both/old"),
    ],
  },
  {
    name: "a foreign source database",
    steps: [
      S(
        T("/wsrel/foreign/old", S1),
        RAW(
          `${PD("/wsrel/foreign/old")}/.claudius.db`,
          [
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT, extra TEXT);",
            `INSERT INTO sessions VALUES ('${S1}', '/wsrel/foreign/old', 'from foreign', 'x');`,
            `INSERT INTO sessions VALUES ('${S2}', '/wsrel/foreign/old', NULL, 'y');`,
            "CREATE TABLE unknown_tbl (a TEXT, cwd TEXT);",
            "INSERT INTO unknown_tbl VALUES ('a1', '/wsrel/foreign/old');",
            "CREATE TABLE commit_drafts (cwd TEXT PRIMARY KEY, message TEXT);",
            "INSERT INTO commit_drafts VALUES ('/wsrel/foreign/old', 'no updated_at');",
            "CREATE TABLE loop_ticks (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, prompt TEXT NOT NULL, fired_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
            `INSERT INTO loop_ticks VALUES (1, '${S1}', 'tA', 'p', 1, 1), (7, '${S1}', 'tB', 'p', 2, 2);`,
            "CREATE TABLE dotless (id TEXT, v TEXT);",
            "INSERT INTO dotless VALUES ('1', 'src one'), ('2', 'src two');",
            "CREATE TABLE plain_pk (id INTEGER PRIMARY KEY, v TEXT);",
            "INSERT INTO plain_pk VALUES (1, 'src one'), (2, 'src two');",
            "CREATE TABLE sqliteXfoo (v TEXT);",
            "INSERT INTO sqliteXfoo VALUES ('like wildcard');",
            'CREATE TABLE "we""ird" ("a b" TEXT, cwd TEXT);',
            `INSERT INTO "we""ird" VALUES ('q', '/wsrel/foreign/old');`,
            "CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, note TEXT);",
            "INSERT INTO ui_state VALUES ('open_tabs', '[1]', 'n');",
            "CREATE TABLE feedback (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, cwd TEXT, rating BLOB);",
            "INSERT INTO feedback VALUES ('f1', 4, '/wsrel/foreign/old', X'00ff');",
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            "INSERT INTO schema_meta VALUES ('version', '2'), ('only_in_src', 'v');",
          ].join("\n"),
        ),
        RAW(
          `${PD("/wsrel/foreign/new")}/.claudius.db`,
          [
            `CREATE TABLE dotless (id ${U(0x131)}nteger PRIMARY KEY, v TEXT);`,
            "INSERT INTO dotless VALUES (1, 'dst one');",
            "CREATE TABLE plain_pk (id integer PRIMARY KEY, v TEXT);",
            "INSERT INTO plain_pk VALUES (1, 'dst one');",
            "CREATE TABLE sqliteXfoo (v TEXT);",
            "CREATE TABLE unknown_tbl (a TEXT, cwd TEXT UNIQUE);",
            "INSERT INTO unknown_tbl VALUES ('n1', '/wsrel/foreign/new');",
            'CREATE TABLE "we""ird" ("a b" TEXT, cwd TEXT);',
          ].join("\n"),
        ),
      ),
      R("/wsrel/foreign/old", "/wsrel/foreign/new"),
      L("/wsrel/foreign/new"),
    ],
  },
  {
    name: "a foreign key the merge can't keep",
    steps: [
      S(
        T("/wsrel/fk/old", S1),
        SQL("/wsrel/fk/old", `PRAGMA foreign_keys = OFF;\n${ins.session(S1, "/wsrel/fk/old")}\n${ins.use("nowhere", S1)}`),
        SQL("/wsrel/fk/new", ins.commit("/wsrel/fk/new", "kept")),
      ),
      R("/wsrel/fk/old", "/wsrel/fk/new"),
      L("/wsrel/fk/old"),
      L("/wsrel/fk/new"),
    ],
  },
  {
    name: "a child table before its parent",
    steps: [
      S(
        // Up to date (no migrations run), with `asset_uses` listed before
        // `assets`: its rows reach the new database before their parents.
        T("/wsrel/order/old", S1),
        RAW(
          `${PD("/wsrel/order/old")}/.claudius.db`,
          [
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            "INSERT INTO schema_meta VALUES ('version', '999'), ('notifications_abort_cleanup_v1', '1');",
            "CREATE TABLE asset_uses (asset_hash TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE, session_id TEXT NOT NULL, message_uuid TEXT NOT NULL, ordinal INTEGER NOT NULL, occurred_ms INTEGER NOT NULL, PRIMARY KEY (asset_hash, session_id, message_uuid, ordinal));",
            "CREATE TABLE assets (hash TEXT PRIMARY KEY, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, width INTEGER, height INTEGER, first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL);",
            ins.asset("abcd"),
            ins.use("abcd", S1),
          ].join("\n"),
        ),
      ),
      R("/wsrel/order/old", "/wsrel/order/new"),
      L("/wsrel/order/new"),
    ],
  },
  {
    name: "databases that won't open",
    steps: [
      S(
        T("/wsrel/dbdir/old", S1),
        MK(`${PD("/wsrel/dbdir/old")}/.claudius.db`),
        T("/wsrel/dstbad/old", S2),
        SQL("/wsrel/dstbad/old", ins.session(S2, "/wsrel/dstbad/old")),
        W(`${PD("/wsrel/dstbad/new")}/.claudius.db`, "garbage ".repeat(100)),
        T("/wsrel/newer/old", S3),
        SQL("/wsrel/newer/old", `${ins.session(S3, "/wsrel/newer/old")}\nUPDATE schema_meta SET value = '999' WHERE key = 'version';\nDROP TABLE prompt_drafts;`),
      ),
      L("/wsrel/dbdir/old"),
      R("/wsrel/dbdir/old", "/wsrel/dbdir/new"),
      R("/wsrel/dstbad/old", "/wsrel/dstbad/new"),
      R("/wsrel/newer/old", "/wsrel/newer/new"),
    ],
  },
  {
    name: "two roots in one folder",
    steps: [
      S(
        T("/wsrel/same/b-c", S1),
        T("/wsrel/same/b-c", S2, { trailing: false }),
        W(`${PD("/wsrel/same/b-c")}/assets/ab/x.png`, "x"),
        SQL(
          "/wsrel/same/b-c",
          [
            ins.session(S1, "/wsrel/same/b-c"),
            ins.session(DBONLY, "/wsrel/same/b-c"),
            ins.session(OTHER, "/wsrel/same/b/c"),
            ins.commit("/wsrel/same/b-c", "from"),
            ins.commit("/wsrel/same/b/c", "to wins"),
            ins.feedback("f1", S1, "/wsrel/same/b-c"),
          ].join("\n"),
        ),
      ),
      L("/wsrel/same/b-c"),
      L("/wsrel/same/b/c"),
      R("/wsrel/same/b-c", "/wsrel/same/b/c"),
      L("/wsrel/same/b-c"),
      L("/wsrel/same/b/c"),
    ],
  },
  {
    name: "missing, empty and odd folders",
    steps: [
      S(
        W(`${PD("/wsrel/odd/file")}`, "the folder is a file\n"),
        T("/wsrel/odd/src", S1),
        W(`${PD("/wsrel/odd/blocked")}`, "a file where the new folder goes\n"),
        MK(`${PD("/wsrel/odd/empty")}`),
        W(`${PD("/wsrel/odd/memonly")}/memory/MEMORY.md`, "- m\n"),
      ),
      R("/wsrel/odd/missing", "/wsrel/odd/new"),
      L("/wsrel/odd/missing"),
      R("/wsrel/odd/file", "/wsrel/odd/new"),
      L("/wsrel/odd/file"),
      R("/wsrel/odd/src", "/wsrel/odd/blocked"),
      R("/wsrel/odd/empty", "/wsrel/odd/new2"),
      R("/wsrel/odd/memonly", "/wsrel/odd/new3"),
      L(""),
      R("", "/wsrel/odd/new"),
      R("/wsrel/odd/src", ""),
      R("", ""),
      R("rel/a", "rel/b"),
    ],
  },
  {
    name: "unicode, escapes and long roots",
    steps: [
      S(
        T(`/wsrel/uni/caf${U(0xe9)} ${U(0x1f600)}`, S1),
        T(`/wsrel/uni/q"uo${BS}te`, S2),
        T("/wsrel/uni/long-src", S3),
      ),
      L(`/wsrel/uni/caf${U(0xe9)} ${U(0x1f600)}`),
      R(`/wsrel/uni/caf${U(0xe9)} ${U(0x1f600)}`, `/wsrel/uni/n${U(0xe9)}w ${U(0x2028)} ${U(0x1)}`),
      R(`/wsrel/uni/q"uo${BS}te`, `/wsrel/uni/to "q" ${BS}n`),
      L(`/wsrel/uni/${"x".repeat(300)}`),
      R(`/wsrel/uni/${"x".repeat(300)}`, "/wsrel/uni/n"),
      R("/wsrel/uni/long-src", `/wsrel/uni/${"y".repeat(300)}`),
    ],
  },
  {
    name: "session ids from the database",
    steps: [
      S(
        T("/wsrel/ids/a", S1),
        T("/wsrel/ids/a", S2),
        SQL(
          "/wsrel/ids/a",
          [
            ins.session(S1, "/wsrel/ids/a"),
            ins.session(DBONLY, "/wsrel/ids/a"),
            ins.session(SID(12, "d"), "/wsrel/ids/a"),
            ins.session(OTHER, "/wsrel/ids/b"),
            ins.session(SID(13, "e"), "/wsrel/ids/a/"),
            ins.session(null, "/wsrel/ids/a"),
            ins.session(null, "/wsrel/ids/a"),
            "INSERT INTO sessions(id, cwd, created_at, updated_at, last_seen_at) VALUES (X'0001', '/wsrel/ids/a', 1, 1, 1), (X'0002', '/wsrel/ids/a', 1, 1, 1), (5, '/wsrel/ids/a', 1, 1, 1), (2.5, '/wsrel/ids/a', 1, 1, 1);",
          ].join("\n"),
        ),
        T("/wsrel/ids/foreign", S1),
        RAW(
          `${PD("/wsrel/ids/foreign")}/.claudius.db`,
          "CREATE TABLE sessions (id, cwd);\nINSERT INTO sessions VALUES (5, '/wsrel/ids/foreign'), (5.0, '/wsrel/ids/foreign'), ('5', '/wsrel/ids/foreign'), (NULL, '/wsrel/ids/foreign'), (NULL, '/wsrel/ids/foreign'), (X'01', '/wsrel/ids/foreign'), (X'01', '/wsrel/ids/foreign'), (-0.0, '/wsrel/ids/foreign'), (0, '/wsrel/ids/foreign'), (9007199254740993, '/wsrel/ids/foreign'), (9007199254740992, '/wsrel/ids/foreign'), (1.5, '/wsrel/ids/foreign');",
        ),
        T("/wsrel/ids/rollback", S1),
        RAW(`${PD("/wsrel/ids/rollback")}/.claudius.db`, `CREATE TABLE sessions (id TEXT, cwd TEXT);\nINSERT INTO sessions VALUES ('${DBONLY}', '/wsrel/ids/rollback');`, false),
        T("/wsrel/ids/notable", S1),
        RAW(`${PD("/wsrel/ids/notable")}/.claudius.db`, "CREATE TABLE other (id TEXT);"),
        T("/wsrel/ids/corrupt", S1),
        W(`${PD("/wsrel/ids/corrupt")}/.claudius.db`, "corrupt ".repeat(100)),
        T("/wsrel/ids/onlydb", S1),
        RM(`${PD("/wsrel/ids/onlydb")}/${S1}.jsonl`),
        SQL("/wsrel/ids/onlydb", ins.session(DBONLY, "/wsrel/ids/onlydb")),
      ),
      L("/wsrel/ids/a"),
      L("/wsrel/ids/b"),
      L("/wsrel/ids/foreign"),
      L("/wsrel/ids/rollback"),
      L("/wsrel/ids/notable"),
      L("/wsrel/ids/corrupt"),
      L("/wsrel/ids/onlydb"),
    ],
  },
  {
    name: "permissions",
    needs: ["perm"],
    steps: [
      S(
        // A read-only transcript moves but can't be stamped.
        T("/wsrel/perm/ro", S1),
        CH(`${PD("/wsrel/perm/ro")}/${S1}.jsonl`, 0o444),
        T("/wsrel/perm/ro", S2),
        // A sidecar whose subfolder can't be emptied after the copy. One
        // file in it: Node removes siblings in parallel, so which of several
        // failures it reports is a race.
        T("/wsrel/perm/side", S3),
        W(`${PD("/wsrel/perm/side")}/${S3}/locked/a.txt`, "a\n"),
        W(`${PD("/wsrel/perm/side")}/${S3}/z-free.txt`, "free\n"),
        CH(`${PD("/wsrel/perm/side")}/${S3}/locked`, 0o555),
        MK(`${PD("/wsrel/perm/side2")}/${S3}`),
        // A folder that can't be written: nothing can be renamed out of it.
        T("/wsrel/perm/frozen", S4),
        W(`${PD("/wsrel/perm/frozen")}/assets/x.png`, "x"),
        SQL("/wsrel/perm/frozen", ins.session(S4, "/wsrel/perm/frozen")),
        CH(`${PD("/wsrel/perm/frozen")}`, 0o555),
        // A folder that can't be listed.
        T("/wsrel/perm/hidden", S5),
        CH(`${PD("/wsrel/perm/hidden")}`, 0o000),
        // An unreadable file in a merged sidecar.
        T("/wsrel/perm/unread", S6),
        W(`${PD("/wsrel/perm/unread")}/${S6}/secret.txt`, "s\n"),
        CH(`${PD("/wsrel/perm/unread")}/${S6}/secret.txt`, 0o000),
        MK(`${PD("/wsrel/perm/unread2")}/${S6}`),
        // A new folder that can't be searched: nothing can be looked up in it.
        T("/wsrel/perm/nosearch", S7),
        MK(`${PD("/wsrel/perm/nosearch2")}`),
        CH(`${PD("/wsrel/perm/nosearch2")}`, 0o600),
      ),
      R("/wsrel/perm/ro", "/wsrel/perm/ro2"),
      R("/wsrel/perm/side", "/wsrel/perm/side2"),
      R("/wsrel/perm/frozen", "/wsrel/perm/frozen2"),
      L("/wsrel/perm/hidden"),
      R("/wsrel/perm/hidden", "/wsrel/perm/hidden2"),
      R("/wsrel/perm/unread", "/wsrel/perm/unread2"),
      R("/wsrel/perm/nosearch", "/wsrel/perm/nosearch2"),
      S(CH(`${PD("/wsrel/perm/hidden")}`, 0o755), CH("home/.claude/projects", 0o555)),
      R("/wsrel/perm/hidden", "/wsrel/perm/hidden3"),
      S(CH("home/.claude/projects", 0o755)),
    ],
  },
];

async function call([fn, ...args]) {
  try {
    const v = fn === "list" ? await reloc.listWorkspaceSessionIds(...args) : await reloc.relocateWorkspaceSessions(...args);
    return { result: deep(JSON.parse(J(v)), toRel) };
  } catch (e) {
    return { threw: threwOf(e) };
  }
}

async function runScenario(sc) {
  closeAll();
  buildWorld();
  let prev = snapshot();
  const steps = [];
  for (const step of sc.steps) {
    if (step.setup) {
      const ops = [];
      for (const op of step.setup) ops.push(await apply(op));
      steps.push({ setup: ops });
      continue;
    }
    tick();
    const got = await call(step.call);
    const cur = snapshot();
    steps.push({ call: step.call, ...got, changes: changes(prev, cur) });
    prev = cur;
  }
  closeAll();
  openUp(ROOT);
  return { name: sc.name, needs: sc.needs ?? [], steps };
}

const core = [];
for (const sc of CORE) {
  if ((sc.needs ?? []).includes("perm") && !PERM) {
    core.push({ name: sc.name, needs: sc.needs, skipped: true });
    continue;
  }
  core.push(await runScenario(sc));
}

// -------------------------------- routes --------------------------------

const STORE = "home/.claude/.claudius/workspaces.json";

/** A store entry, in the order createWorkspace writes one. */
function ws(id, name, rootPath, extra = {}) {
  const w = { id };
  if (name !== undefined) w.name = name;
  if (rootPath !== undefined) w.rootPath = rootPath;
  return { ...w, icon: { kind: "letter", letter: "W", color: "#d97757" }, createdAt: 1, updatedAt: 1, lastOpenedAt: 1, defaults: { permissionMode: "auto" }, ...extra };
}
const store = (entries, extra = {}) => `${J({ version: 1, ...extra, workspaces: entries }, null, 2)}\n`;

async function request(req) {
  const init = { method: req.method };
  if (req.bodyBytes !== undefined) init.body = Buffer.from(req.bodyBytes);
  else if (req.body !== undefined) init.body = toAbs(req.body);
  const r = new Request(`http://localhost/api/workspaces/${encodeURIComponent(req.id)}/move-sessions`, init);
  try {
    const res = await route[req.method](r, { params: Promise.resolve({ id: req.id }) });
    return { status: res.status, type: res.headers.get("content-type"), body: toRel(await res.text()) };
  } catch (e) {
    // The store's temp file is named after the pid.
    return { threw: toRel(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replaceAll(`.${process.pid}.`, ".$PID.") };
  }
}

/** Bare stand-ins for live sessions: what `sessionsByCwd` and `remove` touch. */
function standIn(key, cwd, status, ended) {
  return {
    id: key.id,
    cwd,
    getStatus: () => status,
    end: async () => {
      ended.push(key.key);
    },
  };
}

async function runGroup(group) {
  closeAll();
  buildWorld(group.dirs ?? []);
  writeFileSync(join(ROOT, STORE), toAbs(group.store));
  for (const op of group.setup ?? []) await apply(op);
  sessionManager.sessions.clear();
  const ended = [];
  for (const s of group.sessions ?? []) {
    // What a real `start()` leaves behind: the session's row.
    await upsertSession({ id: s.id, cwd: toAbs(s.cwd) });
    sessionManager.sessions.set(s.id, standIn(s, toAbs(s.cwd), s.status, ended));
  }
  let prev = snapshot([STORE]);
  const steps = [];
  for (const step of group.steps) {
    if (step.setup) {
      const ops = [];
      for (const op of step.setup) ops.push(await apply(op));
      steps.push({ setup: ops });
      continue;
    }
    const now = tick();
    const got = await request(step);
    const cur = snapshot([STORE]);
    const rec = { request: step, now, got, changes: changes(prev, cur) };
    prev = cur;
    if (group.sessions) {
      rec.live = (group.sessions ?? []).filter((s) => sessionManager.sessions.has(s.id)).map((s) => s.key);
      rec.ended = [...ended];
    }
    steps.push(rec);
  }
  sessionManager.sessions.clear();
  closeAll();
  openUp(ROOT);
  return {
    name: group.name,
    needs: group.needs ?? [],
    dirs: group.dirs ?? [],
    store: group.store,
    setup: group.setup ?? [],
    sessions: group.sessions ?? null,
    steps,
  };
}

const GET = (id) => ({ method: "GET", id });
const POST = (id, body) => ({ method: "POST", id, ...(body === undefined ? {} : { body: typeof body === "string" ? body : J(body) }) });
const POSTB = (id, bytes) => ({ method: "POST", id, bodyBytes: bytes });

const OLD = "$ROOT/r/old";
const NEW = "$ROOT/r/new";
const SEED_OLD = [
  T(OLD, S1),
  T(OLD, S2, { trailing: false }),
  W(`${PD(OLD)}/${S1}/subagents/agent-a.jsonl`, "{}\n"),
  W(`${PD(OLD)}/assets/ab/abcd.png`, "png"),
  W(`${PD(OLD)}/memory/MEMORY.md`, "- note\n"),
  SQL(OLD, [ins.session(S1, OLD), ins.session(DBONLY, OLD), ins.session(OTHER, NEW), ins.commit(OLD, "old draft"), ins.ui("open_tabs", J([S1, S2]))].join("\n")),
];
// `r/lone<U+FFFD>`: where a root with a lone surrogate lands on disk.
const ROOT_DIRS = ["r/old", "r/new", "r/new2", "r/other", "r/live", `r/caf${U(0xe9)} ${U(0x1f600)}`, `r/lone${U(0xfffd)}`];

const ROUTES = [
  {
    name: "validation and the main move",
    dirs: ROOT_DIRS,
    store: store([
      ws("wks_a", "Alpha", OLD),
      ws("wks_b", "Beta", OLD),
      ws("wks_c", "Gamma", "$ROOT/r/other"),
      ws("wks_d", undefined, OLD),
      5,
      "str",
      [],
      {},
      { id: 5, rootPath: OLD, name: "numeric id" },
      { id: "wks_e", name: "Echo", rootPath: `${OLD}/` },
    ]),
    setup: [W("r/file", "a file\n"), LN("r/link", "$ROOT/r/new"), LN("r/dangling", "$ROOT/r/nowhere"), LN("r/filelink", "$ROOT/r/file"), ...SEED_OLD],
    steps: [
      GET("wks_missing"),
      GET("wks_a"),
      GET("wks_b"),
      GET("wks_e"),
      POST("wks_missing", "{}"),
      POST("wks_missing", "{"),
      POST("wks_a"),
      POST("wks_a", ""),
      POST("wks_a", "{"),
      POST("wks_a", "null"),
      POST("wks_a", "[]"),
      POST("wks_a", "5"),
      POST("wks_a", '"/x"'),
      POST("wks_a", "true"),
      POST("wks_a", "{}"),
      POST("wks_a", { TO: NEW }),
      POST("wks_a", { to: 5 }),
      POST("wks_a", { to: null }),
      POST("wks_a", { to: [NEW] }),
      POST("wks_a", { to: { path: NEW } }),
      POST("wks_a", '{"to":1e400}'),
      POST("wks_a", { to: "" }),
      POST("wks_a", { to: "r/new" }),
      POST("wks_a", { to: "./r/new" }),
      POST("wks_a", { to: `${NEW}${U(0)}x` }),
      POST("wks_a", { to: `${U(0)}` }),
      POST("wks_a", { to: "$ROOT/r/missing" }),
      POST("wks_a", { to: "$ROOT/r/file" }),
      POST("wks_a", { to: "$ROOT/r/filelink" }),
      POST("wks_a", { to: "$ROOT/r/dangling" }),
      POST("wks_a", { to: OLD }),
      POST("wks_a", { to: `${OLD}/` }),
      POST("wks_a", { to: "$ROOT/r/./x/../old//" }),
      POST("wks_a", `{"to":5,"to":"${OLD}"}`),
      POST("wks_a", `${U(0xfeff)} \n {"to" : "${OLD}"} \n`),
      POST("wks_a", `${U(0xfeff)}${U(0xfeff)}{"to":"${OLD}"}`),
      POST("wks_a", `{"to":"${OLD}"} trailing`),
      POSTB("wks_a", [0x7b, 0x22, 0x74, 0x6f, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      GET("wks_a"),
      POST("wks_a", { to: NEW, extra: true }),
      GET("wks_a"),
      GET("wks_b"),
      GET("wks_d"),
      POST("wks_b", { to: NEW }),
      GET("wks_b"),
      POST("wks_a", { to: "$ROOT/r/link" }),
      GET("wks_a"),
      POST("wks_a", { to: `$ROOT/r/caf${U(0xe9)} ${U(0x1f600)}` }),
      GET("wks_a"),
      POST("wks_e", { to: OLD }),
      POST("wks_a", `{"to":"$ROOT/r/lone${BS}ud800"}`),
      GET("wks_a"),
    ],
  },
  {
    name: "odd store entries",
    dirs: ROOT_DIRS,
    store: store([
      ws("wks_empty", "Empty root", ""),
      ws("wks_num", "Number root", 5),
      ws("wks_num2", "Number root too", 5),
      ws("wks_null", "Null root", null),
      ws("wks_null2", "Null root too", null),
      ws("wks_true", "True root", true),
      ws("wks_true2", "True root too", true),
      ws("wks_false", "False root", false),
      ws("wks_none", "No root", undefined),
      ws("wks_obj", "Object root", { path: OLD }),
      ws("wks_rel", "Relative root", "rel/x"),
      ws("wks k", "Spaced id", OLD),
      ws("wks_noname", undefined, undefined),
      7,
      "s",
      [],
      {},
      { id: null },
      { id: "wks_rel", name: "Duplicate id", rootPath: OLD },
    ]),
    setup: [T("rel/x", S1), W(`${PD("rel/x")}/assets/a.png`, "a"), T(OLD, S2)],
    steps: [
      GET("wks_empty"),
      GET("wks_num"),
      GET("wks_null"),
      GET("wks_true"),
      GET("wks_false"),
      GET("wks_none"),
      GET("wks_obj"),
      GET("wks_rel"),
      GET("wks k"),
      GET("wks_noname"),
      POST("wks_empty", { to: NEW }),
      POST("wks_num", { to: NEW }),
      POST("wks_null", { to: NEW }),
      POST("wks_true", { to: NEW }),
      POST("wks_none", { to: NEW }),
      POST("wks_obj", { to: NEW }),
      POST("wks_rel", { to: NEW }),
      GET("wks_rel"),
      POST("wks k", { to: "$ROOT/r/new2" }),
      GET("wks k"),
    ],
  },
  {
    name: "a null store entry",
    dirs: ROOT_DIRS,
    store: store([ws("wks_a", "Alpha", OLD), null, ws("wks_b", "Beta", OLD)]),
    setup: [T(OLD, S1)],
    steps: [GET("wks_a"), GET("wks_b"), POST("wks_b", { to: NEW }), POST("wks_a", { to: NEW }), GET("wks_a")],
  },
  {
    name: "unreadable stores",
    dirs: ROOT_DIRS,
    store: "{ not json",
    setup: [],
    steps: [GET("wks_a"), POST("wks_a", { to: NEW }), S(W(STORE, "null")), GET("wks_a"), POST("wks_a", { to: NEW }), S(W(STORE, J({ version: 2, workspaces: [ws("wks_a", "A", OLD)] }))), GET("wks_a"), POST("wks_a", { to: NEW })],
  },
  {
    name: "partial failures",
    dirs: ROOT_DIRS,
    store: store([ws("wks_a", "Alpha", OLD)]),
    setup: [
      T(OLD, S1),
      T(OLD, S2),
      T(OLD, S3),
      W(`${PD(NEW)}/${S1}.jsonl`, "already here\n"),
      W(`${PD(OLD)}/${S3}/a.txt`, "a\n"),
      W(`${PD(NEW)}/${S3}`, "a file in the way\n"),
      W(`${PD(OLD)}/assets`, "a file\n"),
      MK(`${PD(NEW)}/assets`),
      W(`${PD(OLD)}/.claudius.db`, "corrupt ".repeat(100)),
    ],
    steps: [GET("wks_a"), POST("wks_a", { to: NEW }), GET("wks_a")],
  },
  {
    name: "a store that can't be written",
    needs: ["perm"],
    dirs: ROOT_DIRS,
    store: store([ws("wks_a", "Alpha", OLD)]),
    setup: [...SEED_OLD, CH("home/.claude/.claudius", 0o555)],
    steps: [POST("wks_a", { to: NEW }), S(CH("home/.claude/.claudius", 0o755)), GET("wks_a")],
  },
  {
    name: "live sessions: two busy",
    dirs: ROOT_DIRS,
    store: store([ws("wks_live", "Live", "$ROOT/r/live"), ws("wks_other", "Other", "$ROOT/r/other")]),
    setup: [T("$ROOT/r/live", S1)],
    sessions: [
      { key: "A", id: SID(21, "c"), cwd: "$ROOT/r/live", status: "idle" },
      { key: "B", id: SID(22, "c"), cwd: "$ROOT/r/live", status: "running" },
      { key: "C", id: SID(23, "c"), cwd: "$ROOT/r/live", status: "needs_input" },
      { key: "D", id: SID(24, "c"), cwd: "$ROOT/r/other", status: "running" },
    ],
    steps: [GET("wks_live"), GET("wks_other"), POST("wks_live", { to: NEW }), GET("wks_live")],
  },
  {
    name: "live sessions: one busy",
    dirs: ROOT_DIRS,
    store: store([ws("wks_live", "Live", "$ROOT/r/live")]),
    setup: [],
    sessions: [
      { key: "A", id: SID(21, "c"), cwd: "$ROOT/r/live", status: "idle" },
      { key: "B", id: SID(22, "c"), cwd: "$ROOT/r/live", status: "running" },
    ],
    steps: [GET("wks_live"), POST("wks_live", { to: NEW }), POST("wks_live", { to: "$ROOT/r/live" })],
  },
  {
    name: "live sessions: idle ones end",
    dirs: ROOT_DIRS,
    store: store([ws("wks_live", "Live", "$ROOT/r/live"), ws("wks_other", "Other", "$ROOT/r/other")]),
    setup: [T("$ROOT/r/live", S1), W(`${PD("$ROOT/r/live")}/${S1}/a.txt`, "a\n")],
    sessions: [
      { key: "A", id: SID(21, "c"), cwd: "$ROOT/r/live", status: "idle" },
      { key: "B", id: SID(22, "c"), cwd: "$ROOT/r/live", status: "idle" },
      { key: "C", id: SID(23, "c"), cwd: "$ROOT/r/other", status: "idle" },
    ],
    steps: [GET("wks_live"), POST("wks_live", { to: NEW }), GET("wks_live"), GET("wks_other")],
  },
];

const routes = [];
for (const g of ROUTES) {
  if ((g.needs ?? []).includes("perm") && !PERM) {
    routes.push({ name: g.name, needs: g.needs, skipped: true });
    continue;
  }
  routes.push(await runGroup(g));
}

const fixture = {
  node: process.version,
  platform: process.platform,
  perm: PERM,
  clockBase: BASE,
  core,
  routes,
};
writeFileSync(join(ROOT, "out.json"), JSON.stringify(fixture));
