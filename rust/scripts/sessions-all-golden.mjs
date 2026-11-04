#!/usr/bin/env node
// Golden fixture for the disk-only session collection routes (D19), recorded
// from the real TS handlers:
//
//   GET    /api/sessions/all              app/api/sessions/all/route.ts
//   GET    /api/sessions/info/[id]        app/api/sessions/info/[id]/route.ts
//   GET    /api/sessions/export/[id]      app/api/sessions/export/[id]/route.ts
//   GET    /api/sessions/transcript/[id]  app/api/sessions/transcript/[id]/route.ts
//   DELETE /api/sessions/file/[id]        app/api/sessions/file/[id]/route.ts
//
//   node rust/scripts/sessions-all-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself twice under `--experimental-transform-types` (repo cwd, a
// resolve hook for the `@/` imports, UV_THREADPOOL_SIZE=1 so the parallel
// children of a recursive `fs.rm` finish in the order they start) and fails
// unless both recordings are byte for byte the same. Each group gets its own
// root of ROOT_LEN chars (so encoded names and file sizes match wherever it
// is rebuilt): HOME is `$ROOT/home` (Claudius's state: workspaces.json,
// accounts.json, the legacy session-titles.json and the per-project
// `.claudius.db` files under `$HOME/.claude/projects`) and CLAUDE_CONFIG_DIR
// is `$ROOT/config` (the SDK's transcripts under `$CONFIG/projects`).
//
// A group is `ops` (the tree: files with exact mtimes, symlinks, modes, real
// git worktrees, the real SDK `forkSession`, SQL on a migrated database
// opened through the real `openDb`, raw database files) and `steps`: more
// ops, route calls (`call`: the status, content type, content disposition and
// raw body text, or `threw`), `tree` (every entry under a path: kind, size,
// link target) and `rows` (the `sessions` table with each cell's type).
// Results have the root written as `$ROOT` and its encoded form as `$EROOT`.
//
// Written to rust/crates/claudius-server/tests/fixtures/sessions_all_golden.json
// (or $SAG_OUT) and replayed by crates/claudius-server/tests/sessions_all.rs
// on the real binary.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = process.env.SAG_OUT || join(rustDir, "crates/claudius-server/tests/fixtures/sessions_all_golden.json");
const sdkPath = join(repo, "node_modules/@anthropic-ai/claude-agent-sdk");
const ROOT_LEN = 100;

if (!process.env.SAG_CHILD) {
  const runs = [0, 1].map(() => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sag-rec-")));
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(tmp, "unused-home"),
            TZ: "UTC",
            UV_THREADPOOL_SIZE: "1",
            SAG_CHILD: join(tmp, "out.json"),
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stdout + r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(tmp, "out.json"), "utf8");
    } finally {
      spawnSync("chmod", ["-R", "u+rwX", tmp]);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    writeFileSync(join(tmpdir(), "sag-run0.json"), runs[0]);
    writeFileSync(join(tmpdir(), "sag-run1.json"), runs[1]);
    throw new Error(`the two recordings differ (see ${tmpdir()}/sag-run{0,1}.json)`);
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.op === "call").length, 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.groups.length} groups, ${steps} requests (stable)`);
  process.exit(0);
}

// ---- child ------------------------------------------------------------------

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
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const load = (rel) => import(pathToFileURL(join(repo, rel)).href);
const routes = {
  all: await load("app/api/sessions/all/route.ts"),
  info: await load("app/api/sessions/info/[id]/route.ts"),
  export: await load("app/api/sessions/export/[id]/route.ts"),
  transcript: await load("app/api/sessions/transcript/[id]/route.ts"),
  file: await load("app/api/sessions/file/[id]/route.ts"),
};
const { openDb } = await load("lib/server/db.ts");
const { encodeProjectDir } = await load("lib/server/auto-memory.ts");
const { forkSession } = await import(pathToFileURL(join(sdkPath, "sdk.mjs")).href);
const Database = (await import("better-sqlite3")).default;
const sdkVersion = JSON.parse(readFileSync(join(sdkPath, "package.json"), "utf8")).version;
// The export route logs its failures; keep them off the recorder's output.
console.error = () => {};

// ---- transcripts --------------------------------------------------------------

const sid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** An id with hex letters, so its upper-case form is another name. */
const hid = (n) => `abcdef00-abcd-4abc-8abc-${n.toString(16).padStart(12, "a")}`;
const mid = (s, n) => `${s.slice(0, 24)}${(0xa00000000000 + n).toString(16)}`;
const iso = (n) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
const T = 1767225600; // 2026-01-01T00:00:00Z
const ns = (sec, nsec = 0) => (BigInt(Math.floor(sec)) * 1000000000n + BigInt(nsec)).toString();

const userLine = (s, n, cwd, content, extra = {}) => ({
  parentUuid: n > 1 ? mid(s, n - 1) : null,
  isSidechain: false,
  userType: "external",
  ...(cwd !== undefined && { cwd }),
  sessionId: s,
  version: "2.1.299",
  gitBranch: "main",
  type: "user",
  message: { role: "user", content },
  uuid: mid(s, n),
  timestamp: iso(n),
  ...extra,
});
const asstLine = (s, n, cwd, content, extra = {}) => ({
  parentUuid: mid(s, n - 1),
  isSidechain: false,
  userType: "external",
  ...(cwd !== undefined && { cwd }),
  sessionId: s,
  version: "2.1.299",
  gitBranch: "main",
  message: {
    id: `msg_${n}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    stop_reason: "end_turn",
  },
  type: "assistant",
  uuid: mid(s, n),
  timestamp: iso(n),
  ...extra,
});
/** A plain conversation: one prompt and a reply per entry of `prompts`. */
const convo = (s, cwd, prompts = ["hello there"], { head = [], tail = [], user = {} } = {}) => {
  const lines = [...head];
  prompts.forEach((p, i) => {
    lines.push(userLine(s, 2 * i + 1, cwd, p, user));
    lines.push(asstLine(s, 2 * i + 2, cwd, `reply ${i}`));
  });
  lines.push(...tail);
  return lines;
};
const jsonl = (lines) => lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";

// ---- paths and ops --------------------------------------------------------------

const ja = (s) => s.replace(/[^a-zA-Z0-9]/g, "-");
function eE(e) {
  let t = 0;
  for (let n = 0; n < e.length; n++) t = ((t << 5) - t + e.charCodeAt(n)) | 0;
  return t;
}
/** The SDK's project dir name (`Qc`). */
const qc = (s) => {
  const t = ja(s);
  return t.length <= 200 ? t : `${t.slice(0, 200)}-${Math.abs(eE(s)).toString(36)}`;
};

const proj = (rel, sub) => ({ proj: rel, ...(sub !== undefined && { sub }) });
const projName = (name, sub) => ({ projName: name, ...(sub !== undefined && { sub }) });
const C = (rel) => `$ROOT/${rel}`;

/** A path spec: "$ROOT/..." text, or a project dir (the SDK's or Claudius's) plus `sub`. */
function resolvePath(root, spec) {
  const sub = (s) => s.replaceAll("$ROOT", root);
  if (typeof spec === "string") return sub(spec);
  let dir;
  if (spec.proj !== undefined) dir = join(root, "config", "projects", qc(join(root, sub(spec.proj))));
  else if (spec.projName !== undefined) dir = join(root, "config", "projects", spec.projName);
  else if (spec.projPrefix !== undefined) {
    dir = join(root, "config", "projects", ja(join(root, sub(spec.projPrefix))).slice(0, 200) + spec.suffix);
  } else dir = join(root, "home", ".claude", "projects", encodeProjectDir(join(root, sub(spec.db))));
  return spec.sub === undefined ? dir : join(dir, sub(spec.sub));
}

function bytesOf(root, parts) {
  return Buffer.concat(
    parts.map((p) => {
      if (p.text !== undefined) return Buffer.from(p.text.replaceAll("$ROOT", root), "utf8");
      if (p.hex !== undefined) return Buffer.from(p.hex, "hex");
      return Buffer.from(p.repeat.repeat(p.count), "utf8");
    }),
  );
}

const write = (path, text, mtime, extra = {}) => ({ op: "write", path, parts: [{ text }], ...(mtime && { mtime }), ...extra });
const writeParts = (path, parts, mtime) => ({ op: "write", path, parts, ...(mtime && { mtime }) });
const session = (rel, s, lines, mtime) => write(proj(rel, `${s}.jsonl`), jsonl(lines), mtime);
const mkdir = (path) => ({ op: "mkdir", path });
const symlink = (path, target) => ({ op: "symlink", path, target });
const rm = (path) => ({ op: "rm", path });
const chmod = (path, mode) => ({ op: "chmod", path, mode });
const git = (cwd, ...args) => ({ op: "git", cwd, args });
const sql = (cwd, text) => ({ op: "sql", cwd, sql: text });
const rawdb = (cwd, extra) => ({ op: "rawdb", cwd, ...extra });

const STATE = "$ROOT/home/.claude/.claudius";
const workspaces = (list) =>
  write(`${STATE}/workspaces.json`, JSON.stringify({ version: 1, workspaces: list }, null, 2));
const ws = (id, rel) => ({ id, name: id, rootPath: C(rel), createdAt: 1, updatedAt: 1, lastOpenedAt: 1 });
const accounts = (profiles, activeProfileId = null) =>
  write(`${STATE}/accounts.json`, JSON.stringify({ profiles, activeProfileId, autoRotateOnRateLimit: false }));
const profile = (id, label, extra = {}) => ({
  id,
  label,
  kind: "oauth-token",
  secret: `sk-${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});
const legacy = (titles) => write(`${STATE}/session-titles.json`, JSON.stringify({ version: 1, titles }));

/** A `sessions` row (SQL literal text per column; `$ROOT` substituted). */
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
function row(cwdRel, id, { title = null, created = 1000, updated = 2000, seen = 3000, state = null, cwd } = {}) {
  const lit = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : typeof v === "object" ? v.sql : q(v));
  const cols = ["id", "cwd", "title", "created_at", "updated_at", "last_seen_at"];
  const vals = [lit(id), lit(cwd ?? C(cwdRel)), lit(title), lit(created), lit(updated), lit(seen)];
  if (state !== null) {
    cols.push("state");
    vals.push(lit(state));
  }
  return `INSERT INTO sessions(${cols.join(", ")}) VALUES (${vals.join(", ")});`;
}
const raw = (text) => ({ sql: text });
const pin = (acc) => JSON.stringify({ accountProfileId: acc });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** Run ops; a `fork` op runs the SDK's `forkSession` and comes back as a write. */
async function runOps(root, ops) {
  const recorded = [];
  const times = [];
  const modes = [];
  for (const op of ops) {
    const at = op.path === undefined ? undefined : resolvePath(root, op.path);
    switch (op.op) {
      case "mkdir":
        mkdirSync(at, { recursive: true });
        break;
      case "write":
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, bytesOf(root, op.parts));
        if (op.mtime) times.push([at, op.mtime]);
        break;
      case "symlink":
        mkdirSync(dirname(at), { recursive: true });
        symlinkSync(op.target.replaceAll("$ROOT", root), at);
        break;
      case "rm":
        rmSync(at, { recursive: true, force: true });
        break;
      case "chmod":
        modes.push([at, op.mode]);
        break;
      case "git": {
        const cwd = join(root, op.cwd);
        mkdirSync(cwd, { recursive: true });
        const r = spawnSync("git", op.args.map((a) => a.replaceAll("$ROOT", root)), { cwd, env: GIT_ENV, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`git ${op.args.join(" ")}: ${r.stderr}`);
        break;
      }
      case "sql": {
        const db = await openDb(op.cwd.replaceAll("$ROOT", root));
        db.exec(op.sql.replaceAll("$ROOT", root));
        break;
      }
      case "rawdb": {
        // A database file another writer left: no migrations, or not SQLite.
        const path = resolvePath(root, { db: op.cwd.replace("$ROOT/", ""), sub: ".claudius.db" });
        mkdirSync(dirname(path), { recursive: true });
        rmSync(path, { force: true });
        if (op.text !== undefined) writeFileSync(path, op.text);
        else {
          const db = new Database(path);
          db.exec(op.sql.replaceAll("$ROOT", root));
          db.close();
        }
        break;
      }
      case "fork": {
        // The real SDK's fork, normalized: its id becomes `op.as`, the other
        // new uuids `ffffffff-...-<n>`, its new timestamps a fixed instant.
        const src = resolvePath(root, op.from);
        const source = readFileSync(src, "utf8");
        const before = new Set(readdirSync(dirname(src)));
        const res = await forkSession(op.sessionId, {
          dir: join(root, op.dir),
          ...(op.title !== undefined && { title: op.title }),
          ...(op.upToMessageId !== undefined && { upToMessageId: op.upToMessageId }),
        });
        const made = readdirSync(dirname(src)).filter((n) => !before.has(n));
        if (made.length !== 1 || made[0] !== `${res.sessionId}.jsonl`) throw new Error(`fork wrote ${made}`);
        const file = join(dirname(src), made[0]);
        let text = readFileSync(file, "utf8").replaceAll(res.sessionId, op.as);
        unlinkSync(file);
        const seen = new Map();
        text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
          if (u === op.as || source.includes(u)) return u;
          if (!seen.has(u)) seen.set(u, `ffffffff-0000-4000-8000-${(seen.size + 1).toString(16).padStart(12, "0")}`);
          return seen.get(u);
        });
        text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (t) =>
          source.includes(t) ? t : "2026-06-01T00:00:00.000Z",
        );
        const w = write({ ...op.from, sub: `${op.as}.jsonl` }, text.replaceAll(root, "$ROOT"), op.mtime);
        const wat = resolvePath(root, w.path);
        writeFileSync(wat, bytesOf(root, w.parts));
        times.push([wat, w.mtime]);
        recorded.push(w);
        continue;
      }
      default:
        throw new Error(`unknown op ${op.op}`);
    }
    recorded.push(op);
  }
  if (times.length > 0) {
    const r = spawnSync(
      "python3",
      ["-c", "import json,os,sys\nfor p,m in json.load(sys.stdin): os.utime(p, ns=(int(m), int(m)), follow_symlinks=False)"],
      // No HOME: macOS's python3 would cache bytecode under ~/Library.
      { input: JSON.stringify(times), encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    if (r.status !== 0) throw new Error(`os.utime: ${r.stderr}`);
  }
  // Modes last, so the writes and mtimes above can still reach every file.
  for (const [p, mode] of modes) chmodSync(p, mode);
  return recorded;
}

// ---- steps ----------------------------------------------------------------------

const call = (route, { id, query, method, os } = {}) => ({
  op: "call",
  route,
  method: method ?? (route === "file" ? "DELETE" : "GET"),
  ...(id !== undefined && { id }),
  ...(query !== undefined && { query }),
  ...(os && { os }),
});
const all = (query) => call("all", { query });
const info = (id, query, os) => call("info", { id, query, os });
const transcript = (id, query, os) => call("transcript", { id, query, os });
const exportOf = (id, query, os) => call("export", { id, query, os });
const del = (id, query, os) => call("file", { id, query, os });
const tree = (path) => ({ op: "tree", path });
const rows = (cwd) => ({ op: "rows", cwd });

const sub = (root, s) => s.replaceAll("$ROOT", root);
// A hashed project dir name (`qc` of a cwd past 200 encoded chars) hashes the
// whole path, temp root included: it is written as `$QC{<rel>}`.
let hashedNames = [];
const unroot = (root, s) => {
  for (const [name, mark] of hashedNames) s = s.replaceAll(name, mark);
  return s.replaceAll(root, "$ROOT").replaceAll(ja(root), "$EROOT");
};

async function runCall(root, s) {
  const query = s.query === undefined ? "" : `?${sub(root, s.query)}`;
  const seg = s.route === "all" ? "all" : `${s.route}/${encodeURIComponent(s.id)}`;
  const req = new Request(`http://localhost:3000/api/sessions/${seg}${query}`, { method: s.method });
  const handler = routes[s.route][s.method];
  let res;
  try {
    res = s.route === "all" ? await handler(req) : await handler(req, { params: Promise.resolve({ id: s.id }) });
  } catch (err) {
    return { threw: unroot(root, String(err?.message ?? err)) };
  }
  const got = { status: res.status, type: res.headers.get("content-type") };
  const disp = res.headers.get("content-disposition");
  if (disp !== null) got.disposition = disp;
  got.body = unroot(root, await res.text());
  return got;
}

/** Every entry under `path`, sorted: kind, size (files) and link target. */
function treeOf(root, path) {
  const base = resolvePath(root, path);
  const outList = [];
  const walk = (p, rel) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (/-(wal|shm)$/.test(rel)) return;
    if (st.isSymbolicLink()) outList.push([rel, "link", unroot(root, readlinkSync(p))]);
    else if (st.isDirectory()) {
      outList.push([rel, "dir"]);
      let names = [];
      try {
        names = readdirSync(p);
      } catch {
        return;
      }
      for (const n of names.sort()) walk(join(p, n), rel === "" ? n : `${rel}/${n}`);
    } else if (st.isFile()) outList.push(rel.endsWith(".claudius.db") ? [rel, "file"] : [rel, "file", st.size]);
    else outList.push([rel, "other"]);
  };
  walk(base, "");
  // Sorted once the names are unrooted: a hashed name's place depends on its hash.
  return outList
    .map((e) => e.map((x, i) => (i === 0 ? unroot(root, x) : x)))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The `sessions` rows (no timestamps: the legacy migration stamps the clock). */
function rowsOf(root, cwdRel) {
  const path = resolvePath(root, { db: cwdRel.replace("$ROOT/", ""), sub: ".claudius.db" });
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch (e) {
    return { error: String(e.message) };
  }
  try {
    const cell = (t, v) => [t, t === "blob" ? Buffer.from(v).toString("hex") : typeof v === "string" ? unroot(root, v) : v];
    return db
      .prepare("SELECT typeof(id) ti, id, typeof(cwd) tc, cwd, typeof(title) tt, title, typeof(state) ts, state FROM sessions ORDER BY rowid")
      .all()
      .map((r) => [cell(r.ti, r.id), cell(r.tc, r.cwd), cell(r.tt, r.title), cell(r.ts, r.state)]);
  } catch (e) {
    return { error: String(e.message) };
  } finally {
    db.close();
  }
}

// ---- groups ---------------------------------------------------------------------

const groups = [];
const add = (name, ops, steps, extra = {}) => groups.push({ name, ...extra, ops, steps });

// 1. One workspace: the SDK listing, DB-only rows, titles, account pins, the
//    limit forms, then deleting one (its DB row comes back as a DB-only entry).
{
  const W = "w1";
  const titled = (s, extra) => convo(s, C(W), ["titled"], { tail: [extra] });
  add(
    "basic",
    [
      workspaces([ws("wks_a", W)]),
      accounts([profile("acc_one", "Work"), profile("acc_two", "Personal")], "acc_two"),
      session(W, sid(1), convo(sid(1), C(W), ["first prompt"]), ns(T + 10)),
      session(W, sid(2), titled(sid(2), { type: "custom-title", customTitle: "Named in SDK", sessionId: sid(2) }), ns(T + 20)),
      session(W, sid(3), titled(sid(3), { type: "ai-title", aiTitle: "AI named", sessionId: sid(3) }), ns(T + 30)),
      session(W, sid(4), convo(sid(4), C(W), ["sidecar"]), ns(T + 40)),
      write(proj(W, `${sid(4)}/custom-title.json`), JSON.stringify({ customTitle: "  Side\u0007car \u200b title " })),
      write(proj(W, `${sid(4)}/subagents/agent-a1.jsonl`), "{}\n"),
      session(W, sid(5), convo(sid(5), C(W), ["side chain"], { user: { isSidechain: true } }), ns(T + 50)),
      write(proj(W, `${sid(6)}.jsonl`), "", ns(T + 60)),
      session(
        W,
        sid(7),
        convo(sid(7), C(W), ["summarized"], {
          tail: [{ type: "summary", summary: "The summary", leafUuid: mid(sid(7), 2) }, { type: "last-prompt", lastPrompt: "the last prompt", sessionId: sid(7) }],
        }),
        ns(T + 70),
      ),
      session(W, sid(8), [userLine(sid(8), 1, C(W), [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]), asstLine(sid(8), 2, C(W), "nice picture")], ns(T + 80)),
      sql(C(W), [
        row(W, sid(1), { title: "Claudius name", seen: 1767225605000, state: pin("acc_one") }),
        row(W, sid(2), { state: pin("acc_gone") }),
        row(W, sid(3), { title: "   ", state: pin("acc_two") }),
        row(W, sid(9), { title: "Draft before first turn", seen: 1767225690000, state: pin("acc_one") }),
        row(W, sid(10), { seen: 0, updated: 1767225600500 }),
        row(W, sid(11), { title: "elsewhere", cwd: C("other") }),
        row(W, sid(12), { title: "Older draft", seen: 0, updated: 0, created: 1700000000000 }),
      ].join("\n")),
    ],
    [
      all(),
      all(`dir=${C(W)}`),
      all(`dir=${C(W)}&limit=3`),
      all("limit=2"),
      all("limit=0"),
      all("limit=-2"),
      all("limit=abc"),
      all("limit=2.5"),
      all("limit=Infinity"),
      all("limit=%20%203%20"),
      all("limit=0x2"),
      all("limit=1e1"),
      all("limit="),
      all("dir="),
      all("dir=%24ROOT%2Fw1&limit=1"),
      all(`dir=${C("nowhere")}`),
      all(`dir=${C(W)}/`),
      tree("$ROOT/home"),
      info(sid(1)),
      info(sid(1), `dir=${C(W)}`),
      info(sid(2)),
      info(sid(3), `dir=${C(W)}`),
      info(sid(4)),
      info(sid(5)),
      info(sid(6)),
      info(sid(7)),
      info(sid(8)),
      info(sid(9)),
      info(sid(9), `dir=${C(W)}`),
      info("not-a-uuid"),
      info(sid(1), `dir=${C("nowhere")}`),
      info(sid(1), "dir="),
      transcript(sid(1)),
      transcript(sid(1), "system=0"),
      transcript(sid(2), `dir=${C(W)}&system=1`),
      transcript(sid(9)),
      transcript("nope"),
      transcript(sid(1), "dir="),
      exportOf(sid(1)),
      exportOf(sid(2), `dir=${C(W)}`),
      exportOf(sid(1), "dir="),
      exportOf(sid(9)),
      exportOf("not-a-uuid"),
      exportOf("a b \"q\" caf\u00e9\ty"),
      exportOf("\u4e2d"),
      exportOf("x\ny"),
      rows(C(W)),
      del(sid(6), `dir=${C(W)}`),
      del(sid(6)),
      del("not-a-uuid"),
      del(sid(1), `dir=${C(W)}`),
      tree("$ROOT/config/projects"),
      all(),
      del(sid(4)),
      tree("$ROOT/config/projects"),
      del(sid(1), `dir=${C(W)}`),
      tree("$ROOT/config/projects"),
      rows(C(W)),
      all(`dir=${C(W)}`),
    ],
  );
}

// 2. Odd transcript lines, unicode titles and names that aren't transcripts.
{
  const W = "odd";
  const lines = [
    "\ufeff" + JSON.stringify({ type: "summary", summary: "bom first" }),
    "not json at all",
    JSON.stringify(userLine(sid(1), 1, C(W), "line \u2028 sep and \u00e9t\u00e9 \ud83d\ude00")),
    "{\"type\":\"user\",\"broken\":",
    JSON.stringify(asstLine(sid(1), 2, C(W), "ok")),
    "",
    "   ",
    JSON.stringify({ type: "custom-title", customTitle: "T\u00eftle \u4e2d\u6587 \ud83c\udf89 \u05e9\u05dc\u05d5\u05dd", sessionId: sid(1) }),
  ];
  const long = `${"x".repeat(199)}\ud83d\ude00 and more`;
  add(
    "odd",
    [
      workspaces([ws("wks_o", W)]),
      writeParts(proj(W, `${sid(1)}.jsonl`), [{ text: lines.join("\r\n") }, { hex: "0a7b22747970" }, { hex: "65223affe2820a" }], ns(T + 1)),
      session(W, sid(2), convo(sid(2), C(W), [long]), ns(T + 2)),
      session(W, sid(3), convo(sid(3), C(W), ["<command-name>/model</command-name>", "<bash-input>  ls -la </bash-input>"]), ns(T + 3)),
      session(W, sid(4), convo(sid(4), C(W), ["<local-command-stdout>x</local-command-stdout>"]), ns(T + 4)),
      write(proj(W, `${hid(5).toUpperCase()}.jsonl`), jsonl(convo(hid(5).toUpperCase(), C(W), ["upper name"])), ns(T + 5)),
      write(proj(W, "notes.txt"), "x\n", ns(T + 6)),
      write(proj(W, "abc.jsonl"), jsonl(convo(sid(9), C(W))), ns(T + 7)),
      mkdir(proj(W, `${sid(6)}.jsonl`)),
      write("$ROOT/outside/target.jsonl", jsonl(convo(sid(7), C(W), ["linked target"])), ns(T + 8)),
      symlink(proj(W, `${sid(7)}.jsonl`), "$ROOT/outside/target.jsonl"),
      session(W, sid(8), convo(sid(8), C(W), ["custom with escapes"], { tail: [{ type: "custom-title", customTitle: "quote \" back\\slash \n newline\ttab", sessionId: sid(8) }] }), ns(T + 9)),
      sql(C(W), [
        row(W, sid(2), { title: "DB \u00e9 \ud83d\ude00 title", seen: 5 }),
        row(W, sid(13), { title: "\u0001ctl\u001f end", seen: 6 }),
      ].join("\n")),
    ],
    [
      all(),
      all(`dir=${C(W)}`),
      info(sid(1)),
      info(sid(2)),
      info(sid(3)),
      info(sid(4)),
      info(hid(5).toUpperCase()),
      info(hid(5), undefined, "darwin"),
      transcript(hid(5), undefined, "darwin"),
      info(sid(6)),
      info(sid(7)),
      info(sid(8)),
      info("abc"),
      transcript("abc"),
      exportOf("abc"),
      del("abc"),
      transcript(sid(1)),
      transcript(sid(6)),
      transcript(sid(7)),
      exportOf(sid(1)),
      exportOf(sid(7)),
      exportOf(sid(8)),
      del(sid(6)),
      del(sid(7)),
      tree("$ROOT/config"),
      tree("$ROOT/outside"),
    ],
  );
}

// 3. Forks made by the real SDK, and a session continued in another.
{
  const W = "fk";
  add(
    "forks",
    [
      workspaces([ws("wks_f", W)]),
      session(W, sid(1), convo(sid(1), C(W), ["fork me", "second turn"]), ns(T + 1)),
      { op: "fork", from: proj(W, `${sid(1)}.jsonl`), sessionId: sid(1), dir: W, as: sid(2), mtime: ns(T + 2) },
      { op: "fork", from: proj(W, `${sid(1)}.jsonl`), sessionId: sid(1), dir: W, title: "Forked title", upToMessageId: mid(sid(1), 2), as: sid(3), mtime: ns(T + 3) },
      session(
        W,
        sid(4),
        convo(sid(4), C(W), ["continued later"], { tail: [{ type: "continued-in", continuedInSessionId: sid(5), sessionId: sid(4) }] }),
        ns(T + 4),
      ),
      session(W, sid(5), convo(sid(5), C(W), ["the continuation"]), ns(T + 5)),
      sql(C(W), [row(W, sid(4), { title: "Continued one", seen: 7 }), row(W, sid(3), { title: "DB fork title", state: pin("p1") })].join("\n")),
      accounts([profile("p1", "Only")]),
    ],
    [all(), all(`dir=${C(W)}`), info(sid(2)), info(sid(3)), info(sid(4)), transcript(sid(2)), transcript(sid(3)), exportOf(sid(3)), del(sid(4)), all()],
  );
}

// 4. Relocated cwds and two paths that encode to the same project dir.
{
  add(
    "relocated",
    [
      workspaces([ws("wks_1", "w1"), ws("wks_2", "w2")]),
      mkdir("$ROOT/w1"),
      mkdir("$ROOT/w2"),
      mkdir("$ROOT/w-1"),
      mkdir("$ROOT/w/1"),
      session("w2", sid(1), convo(sid(1), C("w1"), ["moved here"], { tail: [{ type: "relocated", relocatedCwd: C("w2"), sessionId: sid(1) }] }), ns(T + 1)),
      session("w-1", sid(2), convo(sid(2), C("w/1"), ["same name other path"]), ns(T + 2)),
      session("w-1", sid(3), convo(sid(3), C("w-1"), ["own path"]), ns(T + 3)),
      sql(C("w2"), row("w2", sid(1), { title: "Relocated title", state: pin("acc") })),
      sql(C("w1"), row("w1", sid(1), { title: "Stale title" })),
      accounts([profile("acc", "Acc A"), profile("acc2", "Acc B")]),
    ],
    [
      all(),
      all(`dir=${C("w2")}`),
      all(`dir=${C("w-1")}`),
      all(`dir=${C("w/1")}`),
      info(sid(1)),
      info(sid(1), `dir=${C("w2")}`),
      info(sid(2), `dir=${C("w-1")}`),
      info(sid(2), `dir=${C("w/1")}`),
      del(sid(2), `dir=${C("w/1")}`),
      tree("$ROOT/config/projects"),
    ],
  );
}

// 5. Foreign rows: odd ids, odd stamps, odd pins, odd workspace entries.
{
  const W = "w";
  add(
    "foreign",
    [
      workspaces([
        ws("wks_a", W),
        ws("wks_dup", W),
        { id: "wks_num", rootPath: 5 },
        { id: "wks_empty", rootPath: "" },
        "a string entry",
        { id: "wks_none" },
        ws("wks_nodb", "nodb"),
        ws("wks_b", "wb"),
      ]),
      accounts([profile("acc_one", "One"), profile("acc_two", "Two"), profile("acc_one", "One again")]),
      session(W, sid(1), convo(sid(1), C(W), ["real one"]), ns(T + 1)),
      sql(C(W), [
        row(W, null, { title: "null id", seen: 11 }),
        row(W, raw("X'30303030303030302d303030302d343030302d383030302d303030303030303030306666'"), { title: "blob id title", seen: 12 }),
        row(W, "abc", { title: "not a uuid", seen: 13, state: pin("acc_two") }),
        row(W, "123", { seen: 14 }),
        row(W, sid(20), { seen: "abc", title: "text stamp" }),
        row(W, sid(21), { seen: 1.5, title: "real stamp" }),
        row(W, sid(22), { seen: raw("X'3132'"), title: "blob stamp" }),
        row(W, sid(23), { seen: 0, updated: "", created: 0, title: "all zero" }),
        row(W, sid(24), { seen: raw("1e999"), title: "infinite stamp" }),
        row(W, sid(25), { seen: -5, title: "negative stamp", state: JSON.stringify({ accountProfileId: 5 }) }),
        row(W, sid(26), { title: "", state: JSON.stringify({ accountProfileId: "" }) }),
        row(W, sid(27), { title: "obj pin", state: JSON.stringify({ accountProfileId: { a: 1 } }) }),
        row(W, sid(28), { title: "true pin", state: JSON.stringify({ accountProfileId: true }) }),
        row(W, sid(29), { title: "pinned null", state: JSON.stringify({ accountProfileId: null, other: 1 }) }),
        row(W, sid(1), { title: "  real title  ", state: pin("acc_one") }),
        row(W, "null", { title: "named null" }),
        row(W, "", { title: "empty id", seen: 10, state: pin("acc_one") }),
      ].join("\n")),
      sql(C("wb"), [row("wb", sid(30), { title: "in b", seen: 9 }), row("wb", sid(31), { title: "Bee", cwd: C(W) })].join("\n")),
    ],
    [
      all(),
      all(`dir=${C(W)}`),
      all(`dir=${C("wb")}`),
      all("limit=3"),
      info(sid(1)),
      info(sid(20), `dir=${C(W)}`),
      tree("$ROOT/home/.claude/projects"),
    ],
  );
}

// 6. The throws that end in the route's 500: a null workspace entry, a BLOB
//    title, a legacy title that isn't a string, a database without the table.
add(
  "null_workspace",
  [
    workspaces([ws("wks_a", "w"), null]),
    session("w", sid(1), convo(sid(1), C("w"), ["one"]), ns(T + 1)),
    write(projName("-nocwd", `${sid(2)}.jsonl`), jsonl(convo(sid(2), undefined, ["no cwd"])), ns(T + 2)),
    sql(C("w"), row("w", sid(1), { title: "t" })),
  ],
  [all(), all(`dir=${C("w")}`), info(sid(1))],
);
add(
  "blob_title",
  [
    workspaces([ws("wks_a", "w")]),
    session("w", sid(1), convo(sid(1), C("w"), ["one"]), ns(T + 1)),
    sql(C("w"), [row("w", sid(1), { title: raw("X'6869'") }), row("w", sid(2), { title: raw("X'6869'") })].join("\n")),
  ],
  [all(), all(`dir=${C("w")}`), info(sid(1)), info(sid(1), `dir=${C("w")}`), rows(C("w"))],
);
add(
  "legacy_titles",
  [
    workspaces([ws("wks_a", "w"), ws("wks_b", "wb")]),
    session("w", sid(1), convo(sid(1), C("w"), ["has cwd"]), ns(T + 1)),
    write(projName("-nocwd", `${sid(2)}.jsonl`), jsonl(convo(sid(2), undefined, ["no cwd"])), ns(T + 2)),
    write(projName("-nocwd", `${sid(3)}.jsonl`), jsonl(convo(sid(3), undefined, ["no cwd either"])), ns(T + 3)),
    write(projName("-nocwd", `${sid(4)}.jsonl`), jsonl(convo(sid(4), undefined, ["no cwd, db title"])), ns(T + 4)),
    sql(C("wb"), [row("wb", sid(4), { title: "From b", state: pin("pa") }), row("wb", sid(3), { state: pin("pb") })].join("\n")),
    legacy({ [sid(1)]: "Legacy one", [sid(2)]: "Legacy two", [sid(3)]: "   ", [sid(4)]: "Legacy four", [sid(5)]: "Legacy only" }),
    accounts([profile("pa", "A"), profile("pb", "B")]),
  ],
  [
    all(),
    all(`dir=${C("w")}`),
    info(sid(1)),
    info(sid(2)),
    info(sid(4), `dir=${C("wb")}`),
    rows(C("w")),
    legacy({ [sid(2)]: 42 }),
    all(),
    all(`dir=${C("w")}`),
    legacy({ [sid(1)]: 42 }),
    all(`dir=${C("w")}`),
    write(`${STATE}/session-titles.json`, "{ not json"),
    all(),
  ],
);
add(
  "foreign_dbs",
  [
    workspaces([ws("wks_a", "notable"), ws("wks_b", "garbage"), ws("wks_c", "deletejournal"), ws("wks_d", "ok")]),
    rawdb(C("notable"), { sql: "PRAGMA journal_mode = WAL; CREATE TABLE other(x);" }),
    rawdb(C("garbage"), { text: "this is not a database file at all, not even close" }),
    rawdb(C("deletejournal"), { sql: "CREATE TABLE sessions(id TEXT, cwd TEXT, title TEXT, model TEXT, created_at, updated_at, last_seen_at, state);" + `INSERT INTO sessions VALUES ('${sid(7)}', '$ROOT/deletejournal', 'dj', NULL, 1, 2, 3, '{}');` }),
    sql(C("ok"), [row("ok", sid(8), { title: "fine", state: "not json" }), row("ok", sid(9), { title: "also fine", state: pin("acc") })].join("\n")),
    accounts([profile("acc", "Acc")]),
  ],
  [
    all(),
    all(`dir=${C("notable")}`),
    all(`dir=${C("garbage")}`),
    all(`dir=${C("deletejournal")}`),
    all(`dir=${C("ok")}`),
    tree("$ROOT/home/.claude/projects"),
  ],
);

// 7. accounts.json in its forms: the count, the labels, the failures.
{
  const W = "w";
  const ACC = `${STATE}/accounts.json`;
  add(
    "accounts",
    [
      workspaces([ws("wks_a", W)]),
      session(W, sid(1), convo(sid(1), C(W), ["one"]), ns(T + 1)),
      session(W, sid(2), convo(sid(2), C(W), ["two"]), ns(T + 2)),
      sql(C(W), [row(W, sid(1), { state: pin("a1") }), row(W, sid(2), { state: pin("a2") })].join("\n")),
    ],
    [
      all(),
      accounts([profile("a1", "Solo")]),
      all(),
      accounts([profile("a1", "First"), profile("a2", "Second"), profile("a1", "Dup label wins")]),
      all(),
      accounts([profile("a1", "Shaped"), { id: "a2", label: "no secret", kind: "oauth-token", createdAt: "x" }, profile("a3", "Bedrock", { kind: "bedrock" }), profile("a4", "Bad kind", { kind: "nope" }), 7, null]),
      all(),
      write(ACC, JSON.stringify({ profiles: "nope" })),
      all(),
      write(ACC, "null"),
      all(),
      write(ACC, "{ broken"),
      all(),
      write(ACC, "\ufeff" + JSON.stringify({ profiles: [profile("a1", "Bom")] })),
      all(),
      rm(ACC),
      mkdir(ACC),
      all(),
      rm(ACC),
      all(),
      all(`dir=${C("nowhere")}`),
    ],
  );
}

// 8. Deleting: which copy, sidecars, links, directories, read-only dirs.
{
  const outsideDir = "$ROOT/outside";
  add(
    "delete",
    [
      workspaces([ws("wks_a", "a")]),
      session("a", sid(1), convo(sid(1), C("a"), ["copy a"]), ns(T + 1)),
      session("b", sid(1), convo(sid(1), C("b"), ["copy b"]), ns(T + 2)),
      write(proj("a", `${sid(2)}.jsonl`), "", ns(T + 3)),
      session("b", sid(2), convo(sid(2), C("b"), ["real two"]), ns(T + 4)),
      session("a", sid(3), convo(sid(3), C("a"), ["with sidecar"]), ns(T + 5)),
      write(proj("a", `${sid(3)}/subagents/agent-x.jsonl`), "{}\n"),
      write(proj("a", `${sid(3)}/tool-results/r1.txt`), "out\n"),
      write(proj("a", `${sid(3)}/custom-title.json`), JSON.stringify({ customTitle: "side" })),
      session("a", sid(4), convo(sid(4), C("a"), ["sidecar is a file"]), ns(T + 6)),
      write(proj("a", sid(4)), "a file where the sidecar dir goes\n"),
      session("a", sid(5), convo(sid(5), C("a"), ["sidecar is a link"]), ns(T + 7)),
      write(`${outsideDir}/side5/keep.txt`, "keep\n"),
      symlink(proj("a", sid(5)), `${outsideDir}/side5`),
      write(`${outsideDir}/t6.jsonl`, jsonl(convo(sid(6), C("a"), ["link target"])), ns(T + 8)),
      symlink(proj("a", `${sid(6)}.jsonl`), `${outsideDir}/t6.jsonl`),
      mkdir(proj("a", `${sid(7)}.jsonl`)),
      session("b", sid(7), convo(sid(7), C("b"), ["seven in b"]), ns(T + 13)),
      session("ro", sid(8), convo(sid(8), C("ro"), ["read-only dir"]), ns(T + 9)),
      session("a", sid(9), convo(sid(9), C("a"), ["stuck sidecar"]), ns(T + 10)),
      write(proj("a", `${sid(9)}/gone.txt`), "x\n"),
      write(proj("a", `${sid(9)}/stuck/inner.txt`), "x\n"),
      write(`${outsideDir}/proj/${sid(10)}.jsonl`, jsonl(convo(sid(10), C("lnk"), ["through a linked project dir"])), ns(T + 11)),
      symlink(projName("zz-linked"), `${outsideDir}/proj`),
      write(projName("zzz-file"), "not a dir\n"),
      symlink(projName("zzzz-file-link"), `${outsideDir}/t6.jsonl`),
      mkdir("$ROOT/real"),
      symlink("$ROOT/link", "$ROOT/real"),
      session("real", sid(11), convo(sid(11), C("real"), ["via a linked dir"]), ns(T + 12)),
      sql(C("a"), [row("a", sid(1), { title: "row stays" }), row("a", sid(3), { title: "three" })].join("\n")),
      chmod(proj("ro"), 0o555),
      chmod(proj("a", `${sid(9)}/stuck`), 0o555),
    ],
    [
      tree("$ROOT/config/projects"),
      info(sid(1)),
      info(sid(2)),
      transcript(sid(2)),
      info(sid(7)),
      transcript(sid(7)),
      info(sid(7), `dir=${C("b")}`),
      info(sid(11), "dir=$ROOT/link"),
      transcript(sid(11), "dir=$ROOT/link"),
      del(sid(1)),
      tree("$ROOT/config/projects"),
      del(sid(1)),
      del(sid(1)),
      del(sid(2)),
      del(sid(3), `dir=${C("a")}`),
      del(sid(4), `dir=${C("a")}`),
      del(sid(5), `dir=${C("a")}`),
      del(sid(6), `dir=${C("a")}`),
      del(sid(7), `dir=${C("a")}`),
      del(sid(8), `dir=${C("ro")}`),
      del(sid(9), `dir=${C("a")}`),
      del(sid(9), `dir=${C("a")}`),
      del(sid(10)),
      del(sid(11), `dir=${C("link")}`),
      del(sid(12), `dir=${C("nope")}`),
      del(sid(12)),
      tree("$ROOT/config/projects"),
      tree(outsideDir),
      rows(C("a")),
      chmod(proj("ro"), 0o755),
      chmod(proj("a", `${sid(9)}/stuck`), 0o755),
      tree("$ROOT/config/projects"),
    ],
    { perms: true },
  );
}

// 9. On a case-insensitive disk an upper-case id finds the lower-case file.
add(
  "case_fold",
  [
    session("w", hid(1), convo(hid(1), C("w"), ["lower case name"]), ns(T + 1)),
    write(proj("w", hid(1)), "sidecar file\n"),
    sql(C("w"), row("w", hid(1), { title: "lower row" })),
  ],
  [
    info(hid(1).toUpperCase()),
    transcript(hid(1).toUpperCase()),
    exportOf(hid(1).toUpperCase()),
    all(),
    del(hid(1).toUpperCase()),
    tree("$ROOT/config/projects"),
    all(),
  ],
  { os: "darwin" },
);

// 10. A project dir that can't be searched stops a delete that scans them all.
add(
  "stat_denied",
  [
    session("a", sid(1), convo(sid(1), C("a"), ["behind a locked dir"]), ns(T + 1)),
    session("b", sid(2), convo(sid(2), C("b"), ["after it"]), ns(T + 2)),
    chmod(proj("a"), 0o600),
  ],
  [del(sid(2)), del(sid(1), `dir=${C("a")}`), del(sid(2), `dir=${C("b")}`), info(sid(1)), transcript(sid(1)), chmod(proj("a"), 0o755), tree("$ROOT/config/projects")],
  { perms: true },
);

// 11. Git worktrees: listed, found and deleted from the main checkout.
add(
  "worktrees",
  [
    git("repo", "init", "-q", "-b", "main"),
    git("repo", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"),
    git("repo", "worktree", "add", "-q", "-b", "wt", "$ROOT/wt"),
    workspaces([ws("wks_r", "repo")]),
    session("repo", sid(1), convo(sid(1), C("repo"), ["in main"]), ns(T + 1)),
    session("wt", sid(2), convo(sid(2), C("wt"), ["in worktree"]), ns(T + 2)),
    sql(C("wt"), [row("wt", sid(2), { title: "WT title" }), row("wt", sid(3), { title: "WT three" })].join("\n")),
    write(proj("wt", `${sid(3)}.jsonl`), jsonl(convo(sid(3), undefined, ["no cwd in the worktree"])), ns(T + 3)),
    write(proj("repo", `${sid(4)}.jsonl`), jsonl(convo(sid(4), undefined, ["no cwd in main"])), ns(T + 4)),
  ],
  [
    all(`dir=${C("repo")}`),
    info(sid(2), `dir=${C("repo")}`),
    info(sid(3), `dir=${C("repo")}`),
    info(sid(4), `dir=${C("repo")}`),
    info(sid(3)),
    transcript(sid(2), `dir=${C("repo")}&system=0`),
    exportOf(sid(2), `dir=${C("repo")}`),
    del(sid(2), `dir=${C("repo")}`),
    tree("$ROOT/config/projects"),
    all(`dir=${C("repo")}`),
  ],
);

// 12. A cwd past 200 encoded chars (hashed SDK dir, same-prefix siblings) and
//     one whose Claudius dir name is too long to create.
{
  const LONG = `long/${"L".repeat(120)}`;
  const LONGER = `long/${"M".repeat(170)}`;
  add(
    "long_paths",
    [
      workspaces([ws("wks_l", LONG), ws("wks_m", LONGER)]),
      mkdir(C(LONG)),
      mkdir(C(LONGER)),
      session(LONG, sid(1), convo(sid(1), C(LONG), ["hashed dir"]), ns(T + 1)),
      write({ projPrefix: LONG, suffix: "-otherhash", sub: `${sid(2)}.jsonl` }, jsonl(convo(sid(2), C(LONG), ["sibling, same cwd"])), ns(T + 2)),
      write({ projPrefix: LONG, suffix: "-elsewhere", sub: `${sid(3)}.jsonl` }, jsonl(convo(sid(3), C("other"), ["sibling, other cwd"])), ns(T + 3)),
      session(LONGER, sid(4), convo(sid(4), C(LONGER), ["claudius dir too long"]), ns(T + 4)),
      sql(C(LONG), row(LONG, sid(1), { title: "Long title" })),
    ],
    [
      all(),
      all(`dir=${C(LONG)}`),
      all(`dir=${C(LONGER)}`),
      info(sid(2), `dir=${C(LONG)}`),
      info(sid(3), `dir=${C(LONG)}`),
      info(sid(4), `dir=${C(LONGER)}`),
      info(sid(4)),
      del(sid(2), `dir=${C(LONG)}`),
      del(sid(3), `dir=${C(LONG)}`),
      tree("$ROOT/config/projects"),
    ],
    { hashed: [LONG, LONGER] },
  );
}

// 13. Transcript shapes for the transcript and export routes.
{
  const W = "tx";
  const S = sid(1);
  let n = 0;
  const u = (content, extra = {}) => userLine(S, ++n, C(W), content, extra);
  const a = (content, extra = {}) => asstLine(S, ++n, C(W), content, extra);
  const rich = [
    u("plain prompt"),
    a([
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x", nested: { a: [1, 2.5, "s"] } } },
      { type: "tool_use", id: "tu_2", input: null },
      { type: "redacted_thinking", data: "zz" },
    ]),
    u([
      { type: "tool_result", tool_use_id: "tu_1", content: "file body" },
      { type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: "a" }, { type: "image" }, { text: 5 }, { text: { o: 1 } }, { text: ["x", "y"] }, "str part"] },
      { type: "tool_result", tool_use_id: "tu_3", content: { odd: true } },
      { type: "text", text: 7 },
      "bare string block",
      5,
    ]),
    a("string reply as text block"),
    u("meta prompt", { isMeta: true }),
    { type: "system", subtype: "local_command", content: "<local-command-stdout>ok</local-command-stdout>", level: "info", parentUuid: mid(S, n), uuid: mid(S, ++n), sessionId: S, timestamp: iso(n), isSidechain: false, cwd: C(W) },
    a([{ type: "text", text: "after system" }]),
    u("side", { isSidechain: true }),
    { type: "progress", parentUuid: mid(S, n), uuid: mid(S, ++n), sessionId: S, timestamp: iso(n), data: { type: "x" } },
    a([{ type: "text", text: "last words" }]),
  ];
  const S2 = sid(2);
  const S3 = sid(3);
  const S4 = sid(4);
  const S5 = sid(5);
  const S6 = sid(6);
  add(
    "transcripts",
    [
      session(W, S, rich, ns(T + 1)),
      session(W, S2, [userLine(S2, 1, C(W), "no message next"), { ...asstLine(S2, 2, C(W), "x"), message: undefined }], ns(T + 2)),
      session(W, S3, [userLine(S3, 1, C(W), "null message next"), { ...asstLine(S3, 2, C(W), "x"), message: null }], ns(T + 3)),
      session(W, S4, [userLine(S4, 1, C(W), "null block next"), asstLine(S4, 2, C(W), [{ type: "text", text: "ok" }, null])], ns(T + 4)),
      session(W, S5, [userLine(S5, 1, C(W), [{ type: "tool_result", tool_use_id: "t", content: [{ text: "a" }, null] }]), asstLine(S5, 2, C(W), "y")], ns(T + 5)),
      session(W, S6, [userLine(S6, 1, C(W), { not: "a list" }), asstLine(S6, 2, C(W), { also: "not" })], ns(T + 6)),
    ],
    [
      transcript(S),
      transcript(S, "system=0"),
      transcript(S, "system=false"),
      exportOf(S),
      exportOf(S, `dir=${C(W)}`),
      transcript(S2),
      exportOf(S2),
      transcript(S3),
      exportOf(S3),
      transcript(S4),
      exportOf(S4),
      transcript(S5),
      exportOf(S5),
      transcript(S6),
      exportOf(S6),
    ],
  );
}

// ---- record ---------------------------------------------------------------------

const results = [];
for (const g of groups) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sag-")));
  const pad = ROOT_LEN - base.length - 1;
  if (pad < 1) throw new Error(`temp dir ${base} is too long for ROOT_LEN ${ROOT_LEN}`);
  const root = join(base, "p".repeat(pad));
  mkdirSync(join(root, "config", "projects"), { recursive: true });
  mkdirSync(join(root, "home", ".claude", ".claudius"), { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  hashedNames = (g.hashed ?? []).map((rel) => [qc(join(root, rel)), `$QC{${rel}}`]);
  try {
    const ops = await runOps(root, g.ops);
    const steps = [];
    for (const s of g.steps) {
      if (s.op === "call") steps.push({ ...s, got: await runCall(root, s) });
      else if (s.op === "tree") steps.push({ ...s, got: treeOf(root, s.path) });
      else if (s.op === "rows") steps.push({ ...s, got: rowsOf(root, s.cwd) });
      else steps.push(...(await runOps(root, [s])));
    }
    results.push({ ...g, ops, steps });
  } finally {
    spawnSync("chmod", ["-R", "u+rwX", base]);
    rmSync(base, { recursive: true, force: true });
  }
}

writeFileSync(process.env.SAG_CHILD, JSON.stringify({ sdkVersion, rootLen: ROOT_LEN, groups: results }));
