#!/usr/bin/env node
// Golden fixture for the Git page's commit routes (D08): the real
// `app/api/workspaces/[id]/git/{stage,commit,commit-draft,commit-message}/
// route.ts` handlers, `lib/server/commit-drafts.ts` (on the real `db.ts`),
// `lib/server/commit-message.ts` (the real SDK `query()` against the fake
// CLI) and the `lib/server/git.ts` functions under them, recorded against
// real `git` on scripted repos:
//
//   node rust/scripts/git-commit-golden.mjs     (node@22; builds claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd (db.ts reads its migrations from `process.cwd()` when it loads; the
// handlers then run in `$ROOT/servercwd`), a resolve hook for the `@/`
// imports, and the pinned environment of git-sync-golden.mjs (D09): HOME,
// XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR under a temp root, no system git
// config, GIT_CEILING_DIRECTORIES at the root, LANG / LC_ALL = C, TZ = UTC,
// a fixed author, committer and date (so every hash is stable), and
// GIT_ALLOW_PROTOCOL=file. The hook maps commit-message.ts's SDK import to
// a shim that adds one option, `pathToClaudeCodeExecutable` (the fake CLI);
// its script, argv, env and stdin files are fixed paths under the root.
//
// `steps` is the setup as data (`git` runs; `write` / `big` / `rm` / `mkdir`
// / `chmod`; `workspaces` writes workspaces.json; `sysbin` links the tools
// the wrappers and hooks use; `fakes` installs the logging git wrapper;
// `sql` runs SQL on a workspace's `.claudius.db`, `$CWD` being its root;
// `block` puts a file where a workspace's project dir would be),
// interleaved with the real route handlers (`req`), `state` (a repo read
// back by real git: refs, HEAD, status, the last commit's message bytes),
// `ls` and `dbs` (every project dir under `home/.claude/projects`, with the
// `commit_drafts` rows of its database). `got` is the status, content type
// and body text, or `threw` (Next's empty 500), plus `calls`: every git the
// handler ran, in order (cwd, then argv), and for `commit-message` `cli`:
// the fake CLI's argv, its stdin lines (request ids numbered, strings past
// 2000 units as `{$big, fnv, head, tail}`) and `sdkEnv`, the variables the
// SDK set or changed (its version as `$SDK_VERSION`). The root shows as `$ROOT`, its project-dir encoding
// as `$ENCROOT`.
//
// Every request runs with PATH = `$ROOT/fakebin:$ROOT/sysbin`; `nogit`
// requests with PATH at an empty dir. The `git` wrapper logs the call and
// runs the real git.
//
// Written to rust/crates/claudius-server/tests/fixtures/git_commit_golden.json
// and replayed by crates/claudius-server/tests/git_commit.rs (against the
// real binary, recreating every repo with the same steps).
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/git_commit_golden.json");

/** The pinned environment; `$ROOT` is the temp root. Mirrored by the replay. */
const ENV = {
  HOME: "$ROOT/home",
  XDG_CONFIG_HOME: "$ROOT/home/.config",
  CLAUDE_CONFIG_DIR: "$ROOT/config",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: "$ROOT",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_AUTHOR_NAME: "Golden",
  GIT_AUTHOR_EMAIL: "golden@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Golden",
  GIT_COMMITTER_EMAIL: "golden@example.com",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  FAKE_CLAUDE_SCRIPT: "$ROOT/fakeclaude/script.json",
  FAKE_CLAUDE_ARGV: "$ROOT/fakeclaude/argv.json",
  FAKE_CLAUDE_ENV: "$ROOT/fakeclaude/env.json",
  FAKE_CLAUDE_LOG: "$ROOT/fakeclaude/stdin.log",
};

if (!process.env.GIT_COMMIT_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-commit-golden-")));
  try {
    const env = {
      PATH: process.env.PATH,
      GIT_COMMIT_GOLDEN_CHILD: root,
      GIT_COMMIT_GOLDEN_FAKE: join(rustDir, "target/debug/claudius-fake-claude"),
    };
    for (const [k, v] of Object.entries(ENV)) env[k] = v.replaceAll("$ROOT", root);
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      { cwd: repo, stdio: "inherit", env },
    );
    process.exit(r.status ?? 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ROOT = process.env.GIT_COMMIT_GOLDEN_CHILD;
// The env the CLI would inherit, before `query()` writes its version into it.
const BASE_ENV = { ...process.env };

const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "git-commit-golden-shim-")));
const shim = join(shimDir, "sdk-shim.mjs");
writeFileSync(
  shim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.GIT_COMMIT_GOLDEN_FAKE } });
}
`,
);
const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SHIM = ${JSON.stringify(pathToFileURL(shim).href)};
export async function resolve(spec, ctx, next) {
  if (spec === ${JSON.stringify(SDK)} && ctx.parentURL && ctx.parentURL.endsWith("/lib/server/commit-message.ts")) {
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

// Loaded with the repo as cwd: db.ts pins its migrations dir now.
const ROUTES = ["stage", "commit", "commit-draft", "commit-message"];
const routes = {};
for (const r of ROUTES) routes[r] = await import(join(repo, `app/api/workspaces/[id]/git/${r}/route.ts`));
const { encodeProjectDir } = await import(join(repo, "lib/server/auto-memory.ts"));
const Database = createRequire(join(repo, "package.json"))("better-sqlite3");

const ch = (...codes) => String.fromCharCode(...codes);
const NBSP = ch(0xa0);
const NEL = ch(0x85);
const BOM = ch(0xfeff);
const E_ACUTE = ch(0xe9);
const GRIN = ch(0xd83d, 0xde00);
const J = JSON.stringify;

const FAKEBIN = join(ROOT, "fakebin");
const SYSBIN = join(ROOT, "sysbin");
const CALLS = join(ROOT, "fakelog");
const EMPTY_PATH = join(ROOT, "emptybin");
const FAKE_PATH = `${FAKEBIN}:${SYSBIN}`;
const REAL_PATH = process.env.PATH;
const ENCROOT = encodeProjectDir(ROOT);
const sdkVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(realSdk)), "package.json"), "utf8")).version;

/** The git wrapper; `@ROOT@` is the root and `@GIT@` the real git. */
const FAKE_GIT = [
  "#!/bin/sh",
  "cwd=$(pwd -P)",
  "rec=\"git$(printf '\\037')$cwd\"",
  "for a in \"$@\"; do rec=\"$rec$(printf '\\037')$a\"; done",
  "printf '%s\\036' \"$rec\" >> '@ROOT@/fakelog'",
  "exec '@GIT@' \"$@\"",
  "",
].join("\n");

/** The tools the wrapper and the hooks find on PATH. */
const SYS_TOOLS = ["sh", "cat", "rm", "sleep"];

/** What `state` reads, with real git, in the repo's dir. */
const STATE_CMDS = [
  ["for-each-ref", "--format=%(refname) %(objectname)"],
  ["symbolic-ref", "-q", "HEAD"],
  ["--no-optional-locks", "status", "--porcelain=v1", "-b", "-uall", "-z"],
  ["log", "-1", "--format=%B"],
];

const normalize = (text) =>
  text.split(ROOT).join("$ROOT").split(ROOT.slice(1)).join("$ROOT_REL").split(ENCROOT).join("$ENCROOT");
const abs = (p) => (p === "" ? ROOT : join(ROOT, p));
const projects = join(ROOT, "home/.claude/projects");
const dbFile = (root) => join(projects, encodeProjectDir(abs(root)), ".claudius.db");

/** FNV-1a over UTF-16 units. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
/** Strings past 2000 units as `{$big, fnv, head, tail}`. */
function shrink(v) {
  if (typeof v === "string") {
    return v.length > 2000 ? { $big: v.length, fnv: fnv(v), head: v.slice(0, 200), tail: v.slice(-200) } : v;
  }
  if (Array.isArray(v)) return v.map(shrink);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
  return v;
}
function norm(v) {
  if (typeof v === "string") return normalize(v);
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  return v;
}

function exec(step) {
  switch (step.op) {
    case "git": {
      const r = spawnSync("git", step.args, { cwd: abs(step.cwd), encoding: "utf8" });
      if ((r.status !== 0) !== Boolean(step.fails)) {
        throw new Error(`git ${step.args.join(" ")} in ${step.cwd}: ${r.status}\n${r.stdout}${r.stderr}`);
      }
      break;
    }
    case "mkdir":
      mkdirSync(abs(step.path), { recursive: true });
      break;
    case "write":
      mkdirSync(dirname(abs(step.path)), { recursive: true });
      writeFileSync(abs(step.path), step.hex != null ? Buffer.from(step.hex, "hex") : step.text);
      break;
    case "big":
      mkdirSync(dirname(abs(step.path)), { recursive: true });
      writeFileSync(abs(step.path), step.head + "x".repeat(step.n) + step.tail);
      break;
    case "rm":
      rmSync(abs(step.path), { recursive: true, force: true });
      break;
    case "chmod":
      chmodSync(abs(step.path), parseInt(step.mode, 8));
      break;
    case "workspaces": {
      const workspaces = step.list.map((w, i) => ({
        id: w.id,
        name: w.id,
        rootPath: w.raw ?? abs(w.root),
        icon: { kind: "letter", letter: "W", color: "#d97757" },
        createdAt: 1_700_000_000_000 + i,
        updatedAt: 1_700_000_000_000 + i,
      }));
      const text = step.text ?? JSON.stringify({ version: 1, workspaces }, null, 2);
      mkdirSync(join(ROOT, "home/.claude/.claudius"), { recursive: true });
      writeFileSync(join(ROOT, "home/.claude/.claudius/workspaces.json"), text);
      break;
    }
    case "sysbin":
      mkdirSync(SYSBIN, { recursive: true });
      for (const tool of SYS_TOOLS) {
        const p = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
        if (!p.startsWith("/")) throw new Error(`no ${tool} on PATH`);
        execFileSync("ln", ["-s", p, join(SYSBIN, tool)]);
      }
      break;
    case "fakes": {
      const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      mkdirSync(FAKEBIN, { recursive: true });
      writeFileSync(join(FAKEBIN, "git"), FAKE_GIT.replaceAll("@ROOT@", ROOT).replaceAll("@GIT@", git), { mode: 0o755 });
      break;
    }
    case "sql": {
      const file = dbFile(step.root);
      mkdirSync(dirname(file), { recursive: true });
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.exec(step.sql.replaceAll("$CWD", abs(step.root)));
      db.close();
      break;
    }
    case "block": {
      const dir = dirname(dbFile(step.root));
      mkdirSync(dirname(dir), { recursive: true });
      writeFileSync(dir, "not a dir\n");
      break;
    }
    case "state":
      step.got = STATE_CMDS.map((args) => {
        const r = spawnSync("git", args, { cwd: abs(step.cwd), encoding: "utf8" });
        return { code: r.status, out: normalize(r.stdout), err: normalize(r.stderr) };
      });
      break;
    case "ls":
      step.got = readdirSync(abs(step.path)).sort();
      break;
    case "dbs":
      step.got = readDbs();
      break;
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

/** Each project dir (sorted) with its drafts: `[cwd, typeof message, hex message, typeof updated_at]`. */
function readDbs() {
  if (!existsSync(projects)) return null;
  return readdirSync(projects)
    .sort()
    .map((name) => {
      const p = join(projects, name);
      const entry = { name: normalize(name) };
      if (!statSync(p).isDirectory()) return { ...entry, kind: "file" };
      const file = join(p, ".claudius.db");
      if (!existsSync(file)) return { ...entry, kind: "dir" };
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare(
            "SELECT cwd, typeof(message) AS t, hex(message) AS m, typeof(updated_at) AS u FROM commit_drafts ORDER BY rowid",
          )
          .all();
        return { ...entry, kind: "db", rows: rows.map((r) => [normalize(String(r.cwd)), r.t, r.m, r.u]) };
      } catch {
        return { ...entry, kind: "db", rows: null };
      } finally {
        db.close();
      }
    });
}

/** The calls the wrapper logged since the last read: `[program, cwd, ...argv]`. */
function readCalls() {
  if (!existsSync(CALLS)) return [];
  const text = readFileSync(CALLS, "utf8");
  rmSync(CALLS, { force: true });
  return text
    .split("\x1e")
    .filter((r) => r !== "")
    .map((r) => r.split("\x1f").map(normalize));
}

const FAKE = {
  argv: join(ROOT, "fakeclaude/argv.json"),
  env: join(ROOT, "fakeclaude/env.json"),
  log: join(ROOT, "fakeclaude/stdin.log"),
};
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
/** What the fake CLI saw on its last run (and clears it). */
function readCli() {
  const argv = readJson(FAKE.argv);
  const cliEnv = readJson(FAKE.env);
  let stdin = null;
  if (existsSync(FAKE.log)) {
    const ids = new Map();
    stdin = readFileSync(FAKE.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((m) => {
        if (typeof m.request_id === "string") {
          if (!ids.has(m.request_id)) ids.set(m.request_id, `$ID${ids.size}`);
          return { ...m, request_id: ids.get(m.request_id) };
        }
        if (m.type === "control_response" && typeof m.response?.request_id === "string") {
          return { ...m, response: { ...m.response, request_id: "$CLI_ID" } };
        }
        return m;
      });
  }
  let sdkEnv = null;
  if (cliEnv) {
    sdkEnv = {};
    for (const k of Object.keys(cliEnv).sort()) {
      if (k.startsWith("__CF")) continue;
      const base = k === "PATH" ? FAKE_PATH : BASE_ENV[k];
      if (base !== cliEnv[k]) sdkEnv[k] = cliEnv[k].split(sdkVersion).join("$SDK_VERSION");
    }
  }
  for (const f of Object.values(FAKE)) rmSync(f, { force: true });
  return norm(shrink({ argv, stdin, sdkEnv }));
}

async function handle(step) {
  const url = `http://localhost/api/workspaces/${encodeURIComponent(step.id)}/git/${step.route}`;
  const ctx = { params: Promise.resolve({ id: step.id }) };
  try {
    const init = { method: step.method };
    if (step.method !== "GET" && step.method !== "DELETE") {
      init.headers = { "content-type": "application/json" };
      if (step.bodyHex != null) init.body = Buffer.from(step.bodyHex, "hex");
      else if (step.body != null) init.body = step.body;
    }
    const res = await routes[step.route][step.method](new Request(url, init), ctx);
    return { status: res.status, type: res.headers.get("content-type"), body: normalize(await res.text()) };
  } catch (e) {
    return { threw: normalize(e instanceof Error ? e.message : String(e)) };
  }
}

async function request(step) {
  process.env.PATH = step.nogit ? EMPTY_PATH : FAKE_PATH;
  try {
    const got = await handle(step);
    got.calls = readCalls();
    if (step.route === "commit-message") got.cli = readCli();
    return got;
  } finally {
    process.env.PATH = REAL_PATH;
  }
}

// The step builders. Paths are relative to the root.
const S = [];
const G = (cwd, ...args) => S.push({ op: "git", cwd, args });
const W = (path, text) => S.push({ op: "write", path, text });
const BIG = (path, head, n, tail) => S.push({ op: "big", path, head, n, tail });
const RM = (path) => S.push({ op: "rm", path });
const MKDIR = (path) => S.push({ op: "mkdir", path });
const CHMOD = (path, mode) => S.push({ op: "chmod", path, mode });
const WS = (list, text) => S.push({ op: "workspaces", list, ...(text != null ? { text } : {}) });
const STATE = (cwd) => S.push({ op: "state", cwd });
const DIR = (path) => S.push({ op: "ls", path });
const DBS = () => S.push({ op: "dbs" });
const SQL = (root, sql) => S.push({ op: "sql", root, sql });
const BLOCK = (root) => S.push({ op: "block", root });
const CLI = (script) => W("fakeclaude/script.json", J(script));

const req = (label, method, route, id, extra) => ({ op: "req", label, method, route, id, ...extra });
/** A POST (body as text, or JSON-encoded); `state` is a repo dir to read back afterwards. */
function POST(label, route, id, body, state, extra) {
  S.push(req(label, "POST", route, id, { ...(body === undefined ? {} : { body: typeof body === "string" ? body : J(body) }), ...extra }));
  if (state) STATE(state);
}
const STAGE = (label, id, body, state, extra) => POST(label, "stage", id, body, state, extra);
const COMMIT = (label, id, body, state, extra) => POST(label, "commit", id, body, state, extra);
const MSG = (label, id, body, extra) => POST(label, "commit-message", id, body, null, extra);
const DRAFT_GET = (label, id) => S.push(req(label, "GET", "commit-draft", id));
const DRAFT_POST = (label, id, body) => POST(label, "commit-draft", id, body);
const DRAFT_DELETE = (label, id) => S.push(req(label, "DELETE", "commit-draft", id));
const hex = (s) => Buffer.from(s, "utf8").toString("hex");

/** A commit of `files` (text, or `null` to delete). */
function commit(dir, msg, files) {
  for (const [p, t] of Object.entries(files)) {
    if (t === null) RM(`${dir}/${p}`);
    else W(`${dir}/${p}`, t);
  }
  G(dir, "add", "-A");
  G(dir, "commit", "-qm", msg);
}
function repoWith(dir, files) {
  MKDIR(dir);
  G(dir, "init", "-q");
  if (files) commit(dir, "base", files);
}

// -- global config, plain dirs, the server's cwd, the wrapper --
W("home/.gitconfig", '[init]\n\tdefaultBranch = main\n[protocol]\n\tallow = never\n[protocol "file"]\n\tallow = always\n');
MKDIR("emptybin");
MKDIR("plain");
W("plain/f.txt", "outside the repos\n");
MKDIR("servercwd");
G("servercwd", "init", "-q");
commit("servercwd", "server cwd", { "server-cwd.txt": "the server's cwd\n" });
S.push({ op: "sysbin" });
S.push({ op: "fakes" });
MKDIR("fakeclaude");

const CAFE = "caf" + E_ACUTE + ".txt";
repoWith("repos/a", {
  "keep.txt": "keep\n",
  "keep2.txt": "keep two\n",
  "mod.txt": "mod\n",
  "del.txt": "del\n",
  "staged.txt": "staged\n",
  "dir/nested.txt": "nested\n",
  "space name.txt": "space\n",
  [CAFE]: "cafe\n",
});
repoWith("repos/empty", null);
repoWith("repos/nohead", null);
repoWith("repos/hook", { "h.txt": "h\n" });
repoWith("repos/m", { "app.js": "export const a = 1;\n", "clean.txt": "clean\n", "bin.dat": "x\n" });
for (const d of ["drafts/one", "drafts/two", "drafts/lone", "drafts/foreign", "drafts/notable", "drafts/blocked", "drafts/fresh"]) MKDIR(d);
WS([
  { id: "wks_a", root: "repos/a" },
  { id: "wks_e", root: "repos/empty" },
  { id: "wks_n", root: "repos/nohead" },
  { id: "wks_h", root: "repos/hook" },
  { id: "wks_m", root: "repos/m" },
  { id: "wks_p", root: "plain" },
  { id: "wks_x", root: "missing" },
  { id: "wks_r", raw: "" },
  { id: "wks_d1", root: "drafts/one" },
  { id: "wks_d2", root: "drafts/two" },
  { id: "wks_dl", root: "drafts/lone" },
  { id: "wks_df", root: "drafts/foreign" },
  { id: "wks_dn", root: "drafts/notable" },
  { id: "wks_db", root: "drafts/blocked" },
  { id: "wks_dz", root: "drafts/fresh" },
]);

// ---------------------------------- stage ----------------------------------

W("repos/a/mod.txt", "mod changed\n");
RM("repos/a/del.txt");
W("repos/a/new.txt", "new\n");
W("repos/a/dir/new2.txt", "new two\n");
W("repos/a/staged.txt", "staged two\n");
G("repos/a", "add", "staged.txt");
W("repos/a/" + CAFE, "cafe changed\n");
W("repos/a/space name.txt", "space changed\n");
STATE("repos/a");

STAGE("no body", "wks_a", undefined);
STAGE("null body", "wks_a", "null");
STAGE("malformed body", "wks_a", "{");
STAGE("array body", "wks_a", "[]");
STAGE("string body", "wks_a", '"stage"');
STAGE("number body", "wks_a", "7");
STAGE("op missing", "wks_a", { paths: ["mod.txt"] });
STAGE("op wrong case", "wks_a", { op: "Stage", paths: ["mod.txt"] });
STAGE("op number", "wks_a", { op: 5, paths: ["mod.txt"] });
STAGE("op array", "wks_a", { op: ["stage"], paths: ["mod.txt"] });
STAGE("op padded", "wks_a", { op: " stage", paths: ["mod.txt"] });
STAGE("op bad before paths bad", "wks_a", { op: "nope", paths: "x" });
STAGE("paths missing", "wks_a", { op: "stage" });
STAGE("paths null", "wks_a", { op: "stage", paths: null });
STAGE("paths string", "wks_a", { op: "stage", paths: "mod.txt" });
STAGE("paths object", "wks_a", { op: "stage", paths: { 0: "mod.txt" } });
STAGE("paths with a number", "wks_a", { op: "stage", paths: ["mod.txt", 1] });
STAGE("paths with null", "wks_a", { op: "stage", paths: [null] });
STAGE("paths with infinity", "wks_a", '{"op":"stage","paths":[1e400]}');
STAGE("dotdot path", "wks_a", { op: "stage", paths: ["mod.txt", "../x"] });
STAGE("dotdot prefix", "wks_a", { op: "unstage", paths: ["..x"] });
STAGE("nul path", "wks_a", { op: "discard", paths: ["a\u0000b"] });
STAGE("dot slash dotdot passes", "wks_a", { op: "stage", paths: ["./../x"] }, "repos/a");
STAGE("unknown workspace", "wks_nope", { op: "stage", paths: ["x"] });
STAGE("customization id", "cust_x", { op: "stage", paths: ["x"] });
STAGE("empty paths outside a repo", "wks_p", { op: "stage", paths: [] });
STAGE("empty paths, missing dir", "wks_x", { op: "remove", paths: [] });
STAGE("not a repo", "wks_p", { op: "stage", paths: ["f.txt"] });
STAGE("missing dir", "wks_x", { op: "unstage", paths: ["f.txt"] });
STAGE("no git", "wks_a", { op: "stage", paths: ["mod.txt"] }, null, { nogit: true });
STAGE("bom body", "wks_a", null, null, { bodyHex: "efbbbf" + hex(J({ op: "stage", paths: ["staged.txt"] })) });
STAGE("fully staged only", "wks_a", { op: "stage", paths: ["staged.txt"] }, "repos/a");
STAGE("unknown path only", "wks_a", { op: "stage", paths: ["ghost.txt", "dir"] }, "repos/a");
STAGE(
  "stage a mix",
  "wks_a",
  { op: "stage", paths: ["mod.txt", "new.txt", "del.txt", "staged.txt", "ghost.txt", "mod.txt", CAFE, "space name.txt"] },
  "repos/a",
);
STAGE("unstage some", "wks_a", { op: "unstage", paths: ["mod.txt", "new.txt"] }, "repos/a");
STAGE("unstage unknown", "wks_a", { op: "unstage", paths: ["ghost.txt"] }, "repos/a");
STAGE("stage nested untracked", "wks_a", { op: "stage", paths: ["dir/new2.txt"] }, "repos/a");
W("repos/a/.git/index.lock", "");
STAGE("stage with index.lock", "wks_a", { op: "stage", paths: ["mod.txt"] }, "repos/a");
STAGE("discard with index.lock", "wks_a", { op: "discard", paths: ["staged.txt", "mod.txt"] }, "repos/a");
RM("repos/a/.git/index.lock");
// Discard: a modified tracked file, a fresh add, an untracked file, a staged modification, an unknown path.
W("repos/a/keep.txt", "keep changed\n");
W("repos/a/added.txt", "added\n");
G("repos/a", "add", "added.txt");
W("repos/a/junk.txt", "junk\n");
STATE("repos/a");
STAGE("discard a mix", "wks_a", { op: "discard", paths: ["keep.txt", "added.txt", "junk.txt", "staged.txt", "ghost.txt"] }, "repos/a");
DIR("repos/a");
STAGE("discard a deletion", "wks_a", { op: "discard", paths: ["del.txt"] }, "repos/a");
// Remove: a tracked file, an untracked file, an untracked nested repo, an unknown path.
W("repos/a/rmme.txt", "remove me\n");
MKDIR("repos/a/sub");
G("repos/a/sub", "init", "-q");
W("repos/a/sub/inner.txt", "inner\n");
STATE("repos/a");
STAGE("remove tracked and untracked", "wks_a", { op: "remove", paths: ["keep2.txt", "rmme.txt", "ghost.txt"] }, "repos/a");
DIR("repos/a");
STAGE("remove a nested repo", "wks_a", { op: "remove", paths: ["sub/"] }, "repos/a", { os: "darwin" });
STAGE("remove a modified tracked file", "wks_a", { op: "remove", paths: ["mod.txt"] }, "repos/a");
// The empty repo: no HEAD.
W("repos/empty/x.txt", "x\n");
W("repos/empty/y.txt", "y\n");
STAGE("stage in an empty repo", "wks_e", { op: "stage", paths: ["x.txt"] }, "repos/empty");
STAGE("discard in an empty repo", "wks_e", { op: "discard", paths: ["x.txt", "y.txt"] }, "repos/empty");
DIR("repos/empty");
// An empty rootPath runs git in the server's cwd.
W("servercwd/server-cwd.txt", "changed\n");
STAGE("empty root path", "wks_r", { op: "stage", paths: ["server-cwd.txt"] }, "servercwd");
STAGE("empty root path, unstage", "wks_r", { op: "unstage", paths: ["server-cwd.txt"] }, "servercwd");

// ---------------------------------- commit ----------------------------------

COMMIT("no body", "wks_a", undefined);
COMMIT("null body", "wks_a", "null");
COMMIT("array body", "wks_a", "[]");
COMMIT("message missing", "wks_a", { stagePaths: [] });
COMMIT("message number", "wks_a", { message: 5 });
COMMIT("message blank", "wks_a", { message: " \n\t " });
COMMIT("message nbsp and bom", "wks_a", { message: NBSP + BOM });
COMMIT("stagePaths null", "wks_a", { message: "m", stagePaths: null });
COMMIT("stagePaths string", "wks_a", { message: "m", stagePaths: "mod.txt" });
COMMIT("stagePaths with a number", "wks_a", { message: "m", stagePaths: [1] });
COMMIT("unknown workspace", "wks_nope", { message: "m" });
COMMIT("not a repo", "wks_p", { message: "m" });
COMMIT("not a repo, stagePaths", "wks_p", { message: "m", stagePaths: ["f.txt"] });
COMMIT("not a repo, empty stagePaths", "wks_p", { message: "m", stagePaths: [] });
COMMIT("no git", "wks_a", { message: "m" }, null, { nogit: true });
STATE("repos/a");
COMMIT("stage then commit", "wks_a", { message: "fix: the thing\n\nbody line\n# a comment\n", stagePaths: ["new.txt", "ghost.txt"] }, "repos/a");
COMMIT("nothing staged", "wks_a", { message: "nothing" }, "repos/a");
COMMIT("unknown stagePaths only", "wks_a", { message: "nothing", stagePaths: ["ghost.txt"] }, "repos/a");
W("repos/a/keep.txt", "keep 3\n");
COMMIT("leading comment and blanks", "wks_a", { message: "\n\n# only a comment\n  real subject  \n\n\nbody\n", stagePaths: ["keep.txt"] }, "repos/a");
W("repos/a/keep.txt", "keep 4\n");
COMMIT("only comments", "wks_a", { message: "# x\n# y", stagePaths: ["keep.txt"] }, "repos/a");
COMMIT("nel subject", "wks_a", { message: NEL + "nel" + NEL }, "repos/a");
W("repos/a/keep.txt", "keep 5\n");
COMMIT("unicode subject", "wks_a", { message: CAFE + " " + GRIN + "\r\n\r\nbody", stagePaths: ["keep.txt"] }, "repos/a");
W("repos/a/keep.txt", "keep 6\n");
COMMIT("lone surrogate subject", "wks_a", '{"message":"\\ud800 lone","stagePaths":["keep.txt"]}', "repos/a");
W("repos/a/keep.txt", "keep 7\n");
COMMIT("nul in message", "wks_a", { message: "a\u0000b", stagePaths: ["keep.txt"] }, "repos/a");
W("repos/empty/root.txt", "root\n");
COMMIT("first commit in an empty repo", "wks_e", { message: "root commit", stagePaths: ["root.txt"] }, "repos/empty");
// A pre-commit hook: one that fails with output on both streams, then one that passes.
W("repos/hook/.git/hooks/pre-commit", '#!/bin/sh\necho "lint: 1 problem"\necho "hook stderr" >&2\nexit 1\n');
CHMOD("repos/hook/.git/hooks/pre-commit", "755");
W("repos/hook/h.txt", "h2\n");
COMMIT("a failing hook", "wks_h", { message: "hooked", stagePaths: ["h.txt"] }, "repos/hook");
W("repos/hook/.git/hooks/pre-commit", '#!/bin/sh\necho "hook ok"\nexit 0\n');
COMMIT("a passing hook", "wks_h", { message: "hooked", stagePaths: ["h.txt"] }, "repos/hook");

// ------------------------------- commit-draft -------------------------------

DBS();
DRAFT_GET("no database yet", "wks_d1");
DBS();
DRAFT_GET("unknown workspace", "wks_nope");
DRAFT_POST("unknown workspace", "wks_nope", { message: "m" });
DRAFT_DELETE("unknown workspace", "wks_nope");
DRAFT_GET("customization id", "cust_x");
DRAFT_POST("no body", "wks_d1", undefined);
DRAFT_POST("null body", "wks_d1", "null");
DRAFT_POST("malformed", "wks_d1", "{");
DRAFT_POST("array body", "wks_d1", "[]");
DRAFT_POST("message number", "wks_d1", { message: 5 });
DRAFT_POST("message null", "wks_d1", { message: null });
DRAFT_POST("message array", "wks_d1", { message: ["m"] });
DBS();
DRAFT_POST("a draft", "wks_d1", { message: "  draft one \n" });
DBS();
DRAFT_GET("the draft", "wks_d1");
DRAFT_POST("overwrite", "wks_d1", { message: "second " + E_ACUTE + " " + GRIN });
DBS();
DRAFT_GET("overwritten", "wks_d1");
DRAFT_POST("js whitespace only deletes", "wks_d1", { message: " " + NBSP + BOM + " \n" });
DBS();
DRAFT_GET("deleted", "wks_d1");
DRAFT_POST("nel kept", "wks_d1", { message: NEL + " nel " + NEL });
DRAFT_GET("nel draft", "wks_d1");
DRAFT_POST("empty string deletes", "wks_d1", { message: "" });
DRAFT_GET("deleted again", "wks_d1");
DRAFT_POST("multi-line", "wks_d2", { message: "subject\n\nbody line 1\nbody line 2" });
DRAFT_GET("multi-line", "wks_d2");
DRAFT_DELETE("delete", "wks_d2");
DRAFT_GET("after delete", "wks_d2");
DRAFT_DELETE("delete again", "wks_d2");
DRAFT_DELETE("delete with no database", "wks_dz");
DBS();
DRAFT_POST("lone surrogate", "wks_dl", '{"message":"\\ud800x"}');
DRAFT_GET("lone surrogate", "wks_dl");
DRAFT_POST("empty root path", "wks_r", { message: "root draft" });
DRAFT_GET("empty root path", "wks_r");
DRAFT_POST("missing dir", "wks_x", { message: "missing dir draft" });
DRAFT_GET("missing dir", "wks_x");
DBS();
// A foreign table: no key, no types, the version past ours.
SQL(
  "drafts/foreign",
  "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
    "INSERT INTO schema_meta VALUES ('version', '999');" +
    "CREATE TABLE commit_drafts (cwd, message, updated_at);" +
    "INSERT INTO commit_drafts VALUES ('$CWD', 42, 1);",
);
DRAFT_GET("foreign integer", "wks_df");
for (const [label, value] of [
  ["foreign real", "1.5"],
  ["foreign big integer", "9007199254740993"],
  ["foreign blob", "x'00ff41'"],
  ["foreign null", "NULL"],
  ["foreign empty text", "''"],
  ["foreign invalid utf-8", "CAST(x'61ff62' AS TEXT)"],
]) {
  SQL("drafts/foreign", `UPDATE commit_drafts SET message = ${value};`);
  DRAFT_GET(label, "wks_df");
}
SQL("drafts/foreign", "INSERT INTO commit_drafts VALUES ('other', 'not ours', 2);");
DRAFT_POST("foreign upsert has no key", "wks_df", { message: "m" });
DRAFT_POST("foreign delete through post", "wks_df", { message: "  " });
DBS();
DRAFT_GET("foreign after delete", "wks_df");
SQL("drafts/foreign", "INSERT INTO commit_drafts VALUES ('$CWD', 'first', 3); INSERT INTO commit_drafts VALUES ('$CWD', 'second', 4);");
DRAFT_GET("foreign duplicate rows", "wks_df");
DRAFT_DELETE("foreign delete", "wks_df");
DBS();
// No table at all.
SQL(
  "drafts/notable",
  "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" + "INSERT INTO schema_meta VALUES ('version', '999');",
);
DRAFT_GET("no table", "wks_dn");
DRAFT_POST("no table", "wks_dn", { message: "m" });
DRAFT_DELETE("no table", "wks_dn");
// A file where the project dir would be.
BLOCK("drafts/blocked");
DRAFT_GET("blocked project dir", "wks_db");
DRAFT_POST("blocked project dir", "wks_db", { message: "m" });
DRAFT_DELETE("blocked project dir", "wks_db");
DBS();

// ------------------------------ commit-message ------------------------------

const turn = (steps, result) => ({ turns: [{ match: "Generate a commit message", steps, ...(result !== undefined ? { result } : {}) }] });
const resultMsg = (fields) => ({ type: "result", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, session_id: "$SESSION_ID", total_cost_usd: 0, usage: {}, ...fields });

W("repos/m/app.js", "export const a = 2;\n");
W("repos/m/new.js", "export const b = 1;\n");
W("repos/m/bin.dat", "\u0000\u0001binary\n");
W("repos/m/blob.bin", "\u0000\u0002\u0003");
CLI(turn([{ $text: "Add the thing\n" }]));
MSG("no body", "wks_m", undefined);
MSG("null body", "wks_m", "null");
MSG("paths missing", "wks_m", {});
MSG("paths string", "wks_m", { paths: "app.js" });
MSG("paths with a number", "wks_m", { paths: ["app.js", 2] });
MSG("no files", "wks_m", { paths: [] });
MSG("unknown workspace", "wks_nope", { paths: ["app.js"] });
MSG("not a repo", "wks_p", { paths: ["f.txt"] });
MSG("no git", "wks_m", { paths: ["app.js"] }, { nogit: true });
MSG("a clean file", "wks_m", { paths: ["clean.txt"] });
MSG("an unknown file", "wks_m", { paths: ["ghost.js"] });
MSG("outside the repo", "wks_m", { paths: ["../outside.js"] });
MSG("nul path", "wks_m", { paths: ["a\u0000b"] });
MSG("dash path", "wks_m", { paths: ["--output=x"] });
W("repos/nohead/z.txt", "z\n");
G("repos/nohead", "add", "z.txt");
MSG("no HEAD yet", "wks_n", { paths: ["z.txt"] });
MSG("tracked and untracked", "wks_m", { paths: ["app.js", "new.js"] });
MSG("binary files", "wks_m", { paths: ["bin.dat", "blob.bin"] });
CLI(turn([{ $text: "```text\nfeat: fenced\n\nbody\n```" }]));
MSG("fenced", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "  ```DIFF\nx\n```  " }]));
MSG("upper-case fence", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "```js2\nx\n```" }]));
MSG("fence with a digit", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "```\n\n```" }]));
MSG("empty fence", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "```\nx\n```\n```" }]));
MSG("two fences", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: " \n " + NBSP }]));
MSG("blank answer", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "ignored" }], { subtype: "error_max_turns", is_error: true, errors: ["Reached max turns"] }));
MSG("error result", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "x" }, resultMsg({ subtype: "success", result: null })], false));
MSG("null result", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "x" }, resultMsg({ subtype: "success", result: 5 })], false));
MSG("number result", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "x" }, resultMsg({ subtype: "success" })], false));
MSG("no result field", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "x" }, resultMsg({ subtype: { a: 1 } })], false));
MSG("object subtype", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "x" }, resultMsg({})], false));
MSG("no subtype", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "x" }, resultMsg({ subtype: "success", result: "first" }), resultMsg({ subtype: "success", result: "second" })], false));
MSG("two results", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $stderr: "boom" }, { $exit: 3 }]));
MSG("the CLI exits", "wks_m", { paths: ["app.js"] });
CLI(turn([{ $text: "no result" }, { $exit: 0 }], false));
MSG("no result", "wks_m", { paths: ["app.js"] });
BIG("repos/m/big.txt", "start\n", 210_000, "\nend\n");
CLI(turn([{ $text: "Add a big file" }]));
MSG("a diff past the cap", "wks_m", { paths: ["big.txt"] });
BIG("repos/m/big.txt", "", 199_900, "");
MSG("a diff near the cap", "wks_m", { paths: ["big.txt", "app.js"] });
DIR("fakeclaude");

// The server's own cwd, where an empty rootPath runs git (`cwd: ""` is no cwd).
mkdirSync(join(ROOT, "servercwd"), { recursive: true });
process.chdir(join(ROOT, "servercwd"));
const steps = [];
for (const step of S) {
  if (step.op === "req") step.got = await request(step);
  else exec(step);
  steps.push(step);
}
rmSync(shimDir, { recursive: true, force: true });

const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
const fixture = {
  gitVersion,
  sdkVersion,
  platform: process.platform,
  env: ENV,
  fakeGit: FAKE_GIT,
  sysTools: SYS_TOOLS,
  stateCmds: STATE_CMDS,
  steps,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
const reqs = steps.filter((s) => s.op === "req");
console.log(
  `wrote ${out.slice(repo.length + 1)}: ${steps.length} steps (${reqs.length} requests, ${steps.filter((s) => s.op === "state").length} states) on ${gitVersion}, SDK ${sdkVersion}`,
);
process.exit(0);
