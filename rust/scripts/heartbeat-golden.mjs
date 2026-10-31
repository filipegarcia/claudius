#!/usr/bin/env node
// Golden fixture for the liveness and readiness probes (D26a):
// `app/api/heartbeat/route.ts` (GET, HEAD) and `app/api/heartbeatz/route.ts`
// (GET: `openDb(process.cwd())` and `SELECT 1`), recorded from the real
// route modules on the real DB layer (`lib/server/db.ts`):
//
//   node rust/scripts/heartbeat-golden.mjs     (node@22: better-sqlite3)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd (db.ts reads the migrations from there, and heartbeatz probes the
// database of `process.cwd()`), HOME and CLAUDE_CONFIG_DIR in a temp root and
// a resolve hook for the `@/` imports, twice; both recordings must agree
// byte for byte.
//
// A request goes through what Next's server layer does around a route
// module, using Next's own code where it has it: the method table of
// `autoImplementMethods` (HEAD falls back to GET, OPTIONS answers 204 with
// `Allow`, other known methods 405), a method outside `HTTP_METHODS` is a
// 400, every answer carries the `vary` header `setVaryHeader` adds (built
// from Next's header constants), and a HEAD answer has no body. A live
// `next dev` and `next start` of these two route files (Next 16.3.8,
// 2026-10-27) sent exactly these statuses and headers, and nothing else
// besides `Date`, `Connection`, `Keep-Alive` and `Transfer-Encoding`; in
// particular no `Cache-Control`.
//
// `steps`, in order, against one process (so after the first success the
// readiness check runs on the cached handle):
// - `request`: `got` is the status, the headers (names lowercased, sorted)
//   and the body, with the `ts` field's number replaced by `$TS` (the
//   recorder checks it was `Date.now()` during the request);
// - world steps on paths under the temp HOME (`$HOME`; `$ENC` is the
//   encoded `process.cwd()`): `write` (a file with `text`), `rm` (recursive),
//   `mkdir`, `chmod`, `sql` (a database made through a bare connection:
//   WAL on, then the statements), and `migrated` (a database the real
//   `openDb` made and closed again, then `sql`, with `$LAST` the newest
//   migration id).
// Messages name the temp HOME as `$HOME` and the encoded cwd as `$ENC`.
//
// Written to rust/crates/claudius-server/tests/fixtures/heartbeat_golden.json
// and replayed on the real binary by crates/claudius-server/tests/heartbeat.rs.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/heartbeat_golden.json");

if (!process.env.HEARTBEAT_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "heartbeat-golden-")));
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
            HEARTBEAT_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      spawnSync("chmod", ["-R", "u+rwx", root]);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const requests = fixture.steps.filter((s) => s.op === "request").length;
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.steps.length} steps (${requests} requests) (stable)`);
  process.exit(0);
}

const ROOT_DIR = process.env.HEARTBEAT_GOLDEN_CHILD;
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
    // A bare CJS subpath without an exports map (\`next/server\`).
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !s.includes(":") && !s.startsWith(".")) return next(s + ".js", ctx);
    throw e;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const require = createRequire(join(repo, "package.json"));
const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js");
const { isHTTPMethod } = require("next/dist/server/web/http.js");
const H = require("next/dist/client/components/app-router-headers.js");
const VARY = `${H.RSC_HEADER}, ${H.NEXT_ROUTER_STATE_TREE_HEADER}, ${H.NEXT_ROUTER_PREFETCH_HEADER}, ${H.NEXT_ROUTER_SEGMENT_PREFETCH_HEADER}`;

const { default: Database } = await import("better-sqlite3");
const { openDb, closeDb } = await import(join(repo, "lib/server/db.ts"));
const ROUTES = {
  "/api/heartbeat": autoImplementMethods(await import(join(repo, "app/api/heartbeat/route.ts"))),
  "/api/heartbeatz": autoImplementMethods(await import(join(repo, "app/api/heartbeatz/route.ts"))),
};

const LAST = Math.max(
  ...readdirSync(join(repo, "lib/server/db-migrations"))
    .filter((n) => /^\d+_.*\.sql$/.test(n))
    .map((n) => Number(/^(\d+)_/.exec(n)[1])),
);
const CWD = process.cwd();
const ENC = CWD.replace(/[^A-Za-z0-9]/g, "-");
const real = (p) => p.replaceAll("$HOME", HOME).replaceAll("$ENC", ENC).replaceAll("$LAST", String(LAST));
const scrub = (s) => s.split(HOME).join("$HOME").split(ENC).join("$ENC");

async function request(method, path) {
  const methods = ROUTES[path];
  const handler = isHTTPMethod(method) ? methods[method] : () => new Response(null, { status: 400 });
  const before = Date.now();
  const res = await handler(new Request(`http://localhost${path}`, { method }));
  const after = Date.now();
  const headers = [["vary", VARY], ...res.headers].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let body = method === "HEAD" ? "" : await res.text();
  const m = /"ts":(\d+)/.exec(body);
  if (m) {
    const ts = Number(m[1]);
    if (ts < before || ts > after) throw new Error(`ts ${ts} outside ${before}..${after}`);
    body = body.replace(m[0], '"ts":$TS');
  }
  return { status: res.status, headers, body: scrub(body) };
}

function rawDb(path, sql) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(sql);
  } finally {
    db.close();
  }
}

// ------------------------------- steps -------------------------------

const PROJECTS = "$HOME/.claude/projects";
const DIR = `${PROJECTS}/$ENC`;
const DB = `${DIR}/.claudius.db`;
const req = (method, path) => ({ op: "request", method, path });
const Z = (method = "GET") => req(method, "/api/heartbeatz");
const write = (path, text) => ({ op: "write", path, text });
const rm = (path) => ({ op: "rm", path });
const mkdir = (path) => ({ op: "mkdir", path });
const chmod = (path, mode) => ({ op: "chmod", path, mode });
const sql = (path, s) => ({ op: "sql", path, sql: s });
const migrated = (s) => ({ op: "migrated", sql: s });

const STEPS = [
  // Liveness: no I/O, every method.
  ...["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH", "PROPFIND"].map((m) => req(m, "/api/heartbeat")),
  // Readiness, failing: nothing is cached until a check succeeds.
  write(PROJECTS, "a file where the projects dir goes\n"),
  Z(),
  Z("HEAD"),
  rm(PROJECTS),
  mkdir(PROJECTS),
  write(DIR, "a file where the project dir goes\n"),
  Z(),
  rm(DIR),
  rm(PROJECTS),
  chmod("$HOME/.claude", 0o555),
  Z(),
  chmod("$HOME/.claude", 0o755),
  mkdir(DIR),
  chmod(DIR, 0o555),
  Z(),
  Z("HEAD"),
  chmod(DIR, 0o755),
  mkdir(DB),
  Z(),
  rm(DB),
  write(DB, "this is not a database, just text\n".repeat(64)),
  Z(),
  ...["OPTIONS", "POST", "PUT", "DELETE", "PATCH", "PROPFIND"].map(Z),
  rm(DB),
  migrated(""),
  chmod(DB, 0o000),
  Z(),
  chmod(DB, 0o644),
  rm(DIR),
  migrated("UPDATE schema_meta SET value = '0' WHERE key = 'version';"),
  chmod(DB, 0o444),
  Z(),
  chmod(DB, 0o644),
  rm(DIR),
  migrated("UPDATE schema_meta SET value = 'abc' WHERE key = 'version';"),
  Z(),
  rm(DIR),
  migrated("DROP TABLE schema_meta; CREATE TABLE schema_meta (key TEXT PRIMARY KEY);"),
  Z(),
  rm(DIR),
  sql(DB, "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '9999'), ('notifications_abort_cleanup_v1', 'x');"),
  chmod(DB, 0o444),
  Z(),
  chmod(DB, 0o644),
  rm(DIR),
  // The first success opens, migrates and caches the handle.
  Z(),
  Z("HEAD"),
  Z(),
  // From then on the check runs on the cached handle, whatever the disk says.
  write(DB, "this is not a database, just text\n".repeat(64)),
  Z(),
  rm(DIR),
  Z(),
  write(PROJECTS, "a file where the projects dir goes\n"),
  Z(),
  Z("HEAD"),
  req("GET", "/api/heartbeat"),
];

const steps = [];
for (const s of STEPS) {
  if (s.op === "request") {
    steps.push({ ...s, got: await request(s.method, s.path) });
    continue;
  }
  const p = s.path === undefined ? undefined : real(s.path);
  if (s.op === "write") {
    rmSync(p, { recursive: true, force: true });
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, s.text);
  } else if (s.op === "rm") rmSync(p, { recursive: true, force: true });
  else if (s.op === "mkdir") mkdirSync(p, { recursive: true });
  else if (s.op === "chmod") chmodSync(p, s.mode);
  else if (s.op === "sql") rawDb(p, s.sql);
  else if (s.op === "migrated") {
    await openDb(CWD);
    closeDb(CWD);
    if (s.sql) rawDb(real(DB), real(s.sql));
  } else throw new Error(`unknown op ${s.op}`);
  steps.push(s);
}

writeFileSync(join(ROOT_DIR, "out.json"), JSON.stringify({ last: LAST, vary: VARY, steps }));
process.exit(0);
