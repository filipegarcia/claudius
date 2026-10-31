#!/usr/bin/env node
// Golden fixture for the workspace branch routes (D07): the real
// `app/api/workspaces/[id]/git/{branches,branch-compare,branch-delete,
// branch-rename,checkout}/route.ts` handlers and the `lib/server/git.ts`
// functions under them, recorded against real `git` on scripted repos:
//
//   node rust/scripts/git-branches-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd, a resolve hook for the `@/` imports, and the pinned environment of
// git-golden.mjs (D06): HOME, XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR under a
// temp root, no system git config, GIT_CEILING_DIRECTORIES at the root,
// LANG / LC_ALL = C, TZ = UTC, a fixed author and committer, and commit dates
// pinned per commit, so every hash is stable. Two parts:
// * `refnames`: the private `isValidRefName`, sliced out of git.ts as text,
//   over names at every rule's edge.
// * `steps`: the setup of every repo as data (`git` runs, with an optional
//   commit `date`; `write` / `rm` / `mkdir` / `symlink` / `chmod`;
//   `workspaces` writes workspaces.json; `fakegit` installs the git wrapper
//   below), interleaved with the real route handlers (`req`, or `par` for
//   requests run at once), `state` (the repo after a request: every ref,
//   HEAD, status, worktrees, branch config, read by real git) and `ls`.
//   `got` is the status, content type and body text, or `threw` (Next's
//   empty 500), plus `calls`: every git the handler ran, in order (cwd, then
//   argv), as the wrapper logged them (sorted for a `par` step). The root
//   shows as `$ROOT` (and `$ROOT_REL` without its leading slash).
//
// Every request runs with PATH = `$ROOT/fakebin` first. Its `git` (the
// fixture's `fakeGit`, with `@ROOT@` / `@GIT@` filled in) logs the call and
// then runs the real git, unless a one-shot marker under `$ROOT/fakemarks`
// says otherwise: `kill-<verb>-<tag>` / `slow-<verb>-<tag>` hold a word
// sequence; the first call whose argv has it sleeps 30 s (so the 15 s
// timeout kills it) or sleeps 16 s and then runs git (so only the 10 min hook
// timeout lets it finish; a marker another call took meanwhile is skipped,
// as `par` runs some verbs at once); `out-<verb>` / `err-<verb>` / `exit-<verb>`
// replace the call with canned output (the for-each-ref parser on lines git
// never writes). `nogit` requests run with PATH at an empty dir. The requests
// run in `$ROOT/servercwd`, a repo: an empty rootPath is no cwd to `execFile`.
//
// Written to rust/crates/claudius-core/tests/fixtures/git_branches_golden.json;
// replayed by crates/claudius-core/tests/git_branches_golden.rs (`refnames`)
// and crates/claudius-server/tests/git_branches.rs (`steps`, against the
// real binary, recreating every repo with the same steps).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/git_branches_golden.json");

/** The pinned environment; `$ROOT` is the temp root. Mirrored by the replay. */
const ENV = {
  HOME: "$ROOT/home",
  XDG_CONFIG_HOME: "$ROOT/home/.config",
  CLAUDE_CONFIG_DIR: "$ROOT/config",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: "$ROOT",
  GIT_AUTHOR_NAME: "Golden",
  GIT_AUTHOR_EMAIL: "golden@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Golden",
  GIT_COMMITTER_EMAIL: "golden@example.com",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
};

if (!process.env.GIT_BRANCHES_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-branches-golden-")));
  try {
    const env = { PATH: process.env.PATH, GIT_BRANCHES_GOLDEN_CHILD: root };
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

const ROOT = process.env.GIT_BRANCHES_GOLDEN_CHILD;

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

// ------------------------ the real source, as text ------------------------

const src = readFileSync(join(repo, "lib/server/git.ts"), "utf8");
const count = (needle) => src.split(needle).length - 1;
const once = (needle, what) => {
  if (count(needle) !== 1) throw new Error(`${what}: ${JSON.stringify(needle)} isn't in git.ts exactly once: update the recorder`);
  return src.indexOf(needle);
};
const refStart = once("function isValidRefName(", "isValidRefName");
const refEnd = src.indexOf("\n}\n", refStart);
const modPath = join(ROOT, "git-extract.ts");
writeFileSync(modPath, [src.slice(refStart, refEnd + 3), "export { isValidRefName };", ""].join("\n"));
const ex = await import(pathToFileURL(modPath).href);
const ROUTES = ["branches", "branch-compare", "branch-delete", "branch-rename", "checkout"];
const routes = {};
for (const r of ROUTES) routes[r] = await import(join(repo, `app/api/workspaces/[id]/git/${r}/route.ts`));

const ch = (...codes) => String.fromCharCode(...codes);
const NBSP = ch(0xa0);
const NEL = ch(0x85);
const BOM = ch(0xfeff);
const LSEP = ch(0x2028);
const IDEOSP = ch(0x3000);
const E_ACUTE = ch(0xe9);
const CAFE = "caf" + E_ACUTE;
const NIHON = ch(0x65e5, 0x672c);
const GRIN = ch(0xd83d, 0xde00);

// -------------------------------- refnames --------------------------------

const REFNAMES = [
  "",
  "a",
  "-",
  "-a",
  "--force",
  "a-",
  "a-b",
  " a",
  "a ",
  "a b",
  "a\tb",
  "a\nb",
  "a\x0bb",
  "a\fb",
  "a\rb",
  "a" + NBSP + "b",
  "a" + NEL + "b",
  "a" + ch(0x1680) + "b",
  "a" + ch(0x2000) + "b",
  "a" + ch(0x200a) + "b",
  "a" + ch(0x200b) + "b",
  "a" + LSEP + "b",
  "a" + ch(0x2029) + "b",
  "a" + ch(0x202f) + "b",
  "a" + ch(0x205f) + "b",
  "a" + IDEOSP + "b",
  "a" + BOM + "b",
  "a" + ch(0x180e) + "b",
  "a~b",
  "a^b",
  "a:b",
  "a?b",
  "a*b",
  "a[b",
  "a]b",
  "a\\b",
  "a/b",
  "a..b",
  "..",
  ".",
  "a.b",
  ".a",
  "a.",
  "a/.b",
  "a@{b",
  "a@b",
  "@",
  "@{",
  "a{b",
  "a}b",
  "a/",
  "a//b",
  "/a",
  "/",
  "a.lock",
  "a.lock/b",
  "a.LOCK",
  "a.loc",
  ".lock",
  "lock",
  "a\0b",
  "a\x01b",
  "a\x1fb",
  "a\x7fb",
  "a" + ch(0x9f) + "b",
  "x".repeat(254),
  "x".repeat(255),
  "x".repeat(256),
  "-" + "x".repeat(300),
  GRIN.repeat(127) + "a",
  GRIN.repeat(128),
  GRIN.repeat(127) + E_ACUTE + E_ACUTE,
  E_ACUTE.repeat(255),
  E_ACUTE.repeat(256),
  CAFE,
  NIHON,
  "emoji-" + GRIN,
  "feat/x",
  "feat/deep/nested",
  "HEAD",
  "origin/main",
  "heads/dup",
  "a'b",
  'a"b',
  "a$b#c!",
  "a%b",
  "a&b",
  "a|b",
  "a;b",
  "a<b>",
  "a=b",
  "a+b",
  "a,b",
  "a`b",
  ch(0xad),
  ch(0x2212) + "a",
  ch(0xff0d) + "a",
  "v1.2",
  "release-1.2.3",
];
const refnames = REFNAMES.map((name) => ({ name, got: ex.isValidRefName(name) }));

// -------------------------------- steps --------------------------------

const FAKEBIN = join(ROOT, "fakebin");
const MARKS = join(ROOT, "fakemarks");
const CALLS = join(ROOT, "fakelog");
const EMPTY_PATH = join(ROOT, "emptybin");
const REAL_PATH = process.env.PATH;

/** The git wrapper; `@ROOT@` is the root and `@GIT@` the real git. */
const FAKE_GIT = [
  "#!/bin/sh",
  "d='@ROOT@/fakemarks'",
  "rec=$(pwd -P)",
  "for a in \"$@\"; do rec=\"$rec$(printf '\\037')$a\"; done",
  "printf '%s\\036' \"$rec\" >> '@ROOT@/fakelog'",
  "for f in \"$d\"/kill-\"$1\"-* \"$d\"/slow-\"$1\"-*; do",
  "  [ -e \"$f\" ] || continue",
  "  pat=$(cat \"$f\" 2>/dev/null) || continue",
  "  case \" $* \" in *\" $pat \"*) ;; *) continue ;; esac",
  "  rm -f \"$f\"",
  "  case \"$f\" in \"$d\"/kill-*) exec sleep 30 ;; esac",
  "  sleep 16",
  "  break",
  "done",
  "k=\"$1\"",
  "if [ -e \"$d/out-$k\" ] || [ -e \"$d/err-$k\" ] || [ -e \"$d/exit-$k\" ]; then",
  "  c=0",
  "  if [ -e \"$d/out-$k\" ]; then cat \"$d/out-$k\"; fi",
  "  if [ -e \"$d/err-$k\" ]; then cat \"$d/err-$k\" >&2; fi",
  "  if [ -e \"$d/exit-$k\" ]; then c=$(cat \"$d/exit-$k\"); fi",
  "  rm -f \"$d/out-$k\" \"$d/err-$k\" \"$d/exit-$k\"",
  "  exit \"$c\"",
  "fi",
  "exec '@GIT@' \"$@\"",
  "",
].join("\n");

/** What `state` reads, with real git, in the repo's dir. */
const STATE_CMDS = [
  ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"],
  ["symbolic-ref", "-q", "HEAD"],
  ["rev-parse", "-q", "--verify", "HEAD"],
  ["--no-optional-locks", "status", "--porcelain=v1", "-b", "-uall", "-z"],
  ["worktree", "list", "--porcelain"],
  ["config", "--local", "--get-regexp", "^branch\\."],
];

const normalize = (text) => text.split(ROOT).join("$ROOT").split(ROOT.slice(1)).join("$ROOT_REL");
const abs = (p) => (p === "" ? ROOT : join(ROOT, p));

function exec(step) {
  switch (step.op) {
    case "git": {
      const env = { ...process.env };
      if (step.date) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = step.date;
      const r = spawnSync("git", step.args, { cwd: abs(step.cwd), encoding: "utf8", env });
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
    case "rm":
      rmSync(abs(step.path), { recursive: true, force: true });
      break;
    case "symlink":
      symlinkSync(step.target, abs(step.path));
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
    case "fakegit": {
      const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      mkdirSync(FAKEBIN, { recursive: true });
      mkdirSync(MARKS, { recursive: true });
      writeFileSync(join(FAKEBIN, "git"), FAKE_GIT.replaceAll("@ROOT@", ROOT).replaceAll("@GIT@", git), { mode: 0o755 });
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
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

/** The calls the wrapper logged since the last read: `[cwd, ...argv]`. */
function readCalls() {
  if (!existsSync(CALLS)) return [];
  const text = readFileSync(CALLS, "utf8");
  rmSync(CALLS, { force: true });
  return text
    .split("\x1e")
    .filter((r) => r !== "")
    .map((r) => r.split("\x1f").map(normalize));
}

async function handle(step) {
  const query = step.query ?? "";
  const url = `http://localhost/api/workspaces/${encodeURIComponent(step.id)}/git/${step.route}${query ? `?${query}` : ""}`;
  const ctx = { params: Promise.resolve({ id: step.id }) };
  try {
    let res;
    if (step.method === "GET") {
      res = await routes[step.route].GET(new Request(url), ctx);
    } else {
      const init = { method: "POST", headers: { "content-type": "application/json" } };
      if (step.bodyHex != null) init.body = Buffer.from(step.bodyHex, "hex");
      else if (step.body != null) init.body = step.body;
      res = await routes[step.route].POST(new Request(url, init), ctx);
    }
    return { status: res.status, type: res.headers.get("content-type"), body: normalize(await res.text()) };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}

async function request(step) {
  process.env.PATH = step.nogit ? EMPTY_PATH : `${FAKEBIN}:${REAL_PATH}`;
  try {
    const got = await handle(step);
    got.calls = readCalls();
    return got;
  } finally {
    process.env.PATH = REAL_PATH;
  }
}

/** UTF-16 order of the joined call, as the replay sorts it. */
const callKey = (c) => c.join("\x1f");
async function parallel(step) {
  process.env.PATH = `${FAKEBIN}:${REAL_PATH}`;
  try {
    const gots = await Promise.all(step.reqs.map(handle));
    step.reqs.forEach((r, i) => (r.got = gots[i]));
    step.calls = readCalls().sort((a, b) => (callKey(a) < callKey(b) ? -1 : callKey(a) > callKey(b) ? 1 : 0));
  } finally {
    process.env.PATH = REAL_PATH;
  }
}

// The step builders. Paths are relative to the root.
const S = [];
const G = (cwd, ...args) => S.push({ op: "git", cwd, args });
/** A commit (or any git run) at its own author and committer date. */
const GD = (cwd, date, ...args) => S.push({ op: "git", cwd, args, date });
const W = (path, text) => S.push({ op: "write", path, text });
const RM = (path) => S.push({ op: "rm", path });
const MKDIR = (path) => S.push({ op: "mkdir", path });
const LN = (path, target) => S.push({ op: "symlink", path, target });
const CHMOD = (path, mode) => S.push({ op: "chmod", path, mode });
const WS = (list, text) => S.push({ op: "workspaces", list, ...(text != null ? { text } : {}) });
const STATE = (cwd) => S.push({ op: "state", cwd });
const DIR = (path) => S.push({ op: "ls", path });
const MARK = (name, text) => W(`fakemarks/${name}`, text);
const MARKHEX = (name, hex) => S.push({ op: "write", path: `fakemarks/${name}`, hex });
const D = (day, tz = "Z") => `2026-01-${String(day).padStart(2, "0")}T00:00:00${tz}`;
const J = JSON.stringify;
/** `searchParams` from pairs, every value `encodeURIComponent`-ed. */
const q = (pairs) =>
  Object.entries(pairs)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

const req = (label, method, route, id, extra) => ({ op: "req", label, method, route, id, ...extra });
const listReq = (label, id, extra) => req(label, "GET", "branches", id, extra);
const cmpReq = (label, id, pairs, extra) => req(label, "GET", "branch-compare", id, { query: q(pairs), ...extra });
const postReq = (label, route, id, body, extra) =>
  req(label, "POST", route, id, { ...(body === undefined ? {} : { body: typeof body === "string" ? body : J(body) }), ...extra });

const LIST = (label, id, extra) => S.push(listReq(label, id, extra));
const CMP = (label, id, pairs, extra) => S.push(cmpReq(label, id, pairs, extra));
const CMPQ = (label, id, query, extra) => S.push(req(label, "GET", "branch-compare", id, { query, ...extra }));
/** A POST; `state` is the repo dir to read back afterwards. */
const POST = (label, route, id, body, state, extra) => {
  S.push(postReq(label, route, id, body, extra));
  if (state) STATE(state);
};
const POSTHEX = (label, route, id, hex) => S.push(req(label, "POST", route, id, { bodyHex: hex }));
const CO = (label, id, body, state, extra) => POST(label, "checkout", id, body, state, extra);
const REN = (label, id, body, state, extra) => POST(label, "branch-rename", id, body, state, extra);
const DEL = (label, id, body, state, extra) => POST(label, "branch-delete", id, body, state, extra);
const PAR = (reqs) => S.push({ op: "par", reqs });

const BR = "repos/br";
const hex = (s) => Buffer.from(s, "utf8").toString("hex");

// -- global config, plain dirs, the server's cwd, the git wrapper --
W("home/.gitconfig", '[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
MKDIR("emptybin");
MKDIR("plain");
W("plain/f.txt", "outside the repos\n");
G("servercwd", "init", "-q");
W("servercwd/server-cwd.txt", "the server's cwd\n");
G("servercwd", "add", "-A");
G("servercwd", "commit", "-qm", "server cwd");
G("servercwd", "branch", "srv-side");
S.push({ op: "fakegit" });

// -- br: many branches, two remotes, a linked worktree --
MKDIR("repos/origin.git");
G("repos/origin.git", "init", "-q", "--bare");
MKDIR(BR);
G(BR, "init", "-q");
W(`${BR}/f.txt`, "base\n");
W(`${BR}/same.txt`, "same everywhere\n");
W(`${BR}/sub/s.txt`, "sub\n");
G(BR, "add", "-A");
GD(BR, D(2), "commit", "-qm", "base");
G(BR, "tag", "v1");
G(BR, "remote", "add", "origin", "../origin.git");
G(BR, "push", "-q", "-u", "origin", "main");
G(BR, "switch", "-q", "-c", "feat/x");
W(`${BR}/f.txt`, "feat x\n");
W(`${BR}/x.txt`, "x\n");
G(BR, "add", "-A");
GD(BR, D(5), "commit", "-qm", "feat x");
G(BR, "push", "-q", "-u", "origin", "feat/x");
G(BR, "switch", "-q", "-c", "feat/deep/nested", "main");
W(`${BR}/deep.txt`, "deep\n");
G(BR, "add", "-A");
GD(BR, D(4, "+05:30"), "commit", "-qm", "deep");
G(BR, "push", "-q", "-u", "origin", "feat/deep/nested");
G(BR, "switch", "-q", "-c", "unmerged", "main");
W(`${BR}/u.txt`, "unmerged\n");
G(BR, "add", "-A");
GD(BR, D(6), "commit", "-qm", "unmerged work");
G(BR, "switch", "-q", "-c", "pushed", "main");
W(`${BR}/p.txt`, "pushed\n");
G(BR, "add", "-A");
GD(BR, D(7), "commit", "-qm", "pushed work");
G(BR, "push", "-q", "-u", "origin", "pushed");
G(BR, "switch", "-q", "-c", "trail", "main");
W(`${BR}/t.txt`, "trail\n");
G(BR, "add", "-A");
GD(BR, D(8), "commit", "-q", "--cleanup=verbatim", "-m", "subject ends in U+3000 and a BOM" + IDEOSP + BOM);
// trailnel: a subject and a last diff line ending in NEL, which JS keeps.
G(BR, "switch", "-q", "-c", "trailnel", "main");
W(`${BR}/zz-nel.txt`, "x" + NEL + "\n");
G(BR, "add", "-A");
GD(BR, D(8), "commit", "-q", "--cleanup=verbatim", "-m", "subject ends in NEL" + NEL);
G(BR, "switch", "-q", "main");
for (const name of ["merged-br", CAFE, NIHON, "emoji-" + GRIN, "v1.2", "it's", 'q"uote', "a$b#c!", "tokill", "nel" + NEL + "x", "a" + NBSP + "b", "l".repeat(250)]) {
  G(BR, "branch", name);
}
G(BR, "update-ref", "refs/heads/-dash", "HEAD");
// An upstream that is gone.
G(BR, "push", "-q", "origin", "HEAD:refs/heads/gonebr");
G(BR, "branch", "-q", "--track", "gonebr", "origin/gonebr");
G("repos/origin.git", "branch", "-q", "-D", "gonebr");
G(BR, "fetch", "-q", "--prune");
// A remote-only branch and main behind by one, from another clone.
G("repos", "clone", "-q", "origin.git", "other");
G("repos/other", "switch", "-q", "-c", "only-remote");
W("repos/other/r.txt", "only remote\n");
G("repos/other", "add", "-A");
GD("repos/other", D(9), "commit", "-qm", "only remote");
G("repos/other", "push", "-q", "origin", "only-remote");
G("repos/other", "switch", "-q", "main");
W("repos/other/o.txt", "upstream change\n");
G("repos/other", "add", "-A");
GD("repos/other", D(10), "commit", "-qm", "upstream change");
G("repos/other", "push", "-q", "origin", "main");
G(BR, "fetch", "-q", "origin");
// main ahead by one.
W(`${BR}/m.txt`, "local main\n");
G(BR, "add", "-A");
GD(BR, D(11), "commit", "-qm", "local main");
G(BR, "remote", "set-head", "origin", "main");
// A remote whose name has a slash.
MKDIR("repos/team.git");
G("repos/team.git", "init", "-q", "--bare");
G(BR, "remote", "add", "team/a", "../team.git");
G(BR, "push", "-q", "team/a", "main:refs/heads/main", "feat/x:refs/heads/tonly");
G(BR, "fetch", "-q", "team/a");
// A linked worktree on its own branch.
G(BR, "worktree", "add", "-q", "../br-wt", "-b", "wtbr");
MKDIR("links");
LN("links/br", "../repos/br");

// -- ambig: a branch and a tag of one name, a local branch named like a
// remote-tracking one, files named like a range and like a branch --
const AM = "repos/ambig";
MKDIR(AM);
G(AM, "init", "-q");
W(`${AM}/f.txt`, "a\n");
G(AM, "add", "-A");
GD(AM, D(2), "commit", "-qm", "a");
G(AM, "switch", "-q", "-c", "side");
W(`${AM}/s.txt`, "side\n");
G(AM, "add", "-A");
GD(AM, D(3), "commit", "-qm", "side");
G(AM, "switch", "-q", "main");
G(AM, "switch", "-q", "--orphan", "orphan");
W(`${AM}/o.txt`, "orphan\n");
G(AM, "add", "o.txt");
GD(AM, D(4), "commit", "-qm", "orphan");
G(AM, "switch", "-q", "main");
G(AM, "tag", "dup");
G(AM, "branch", "dup", "side");
G(AM, "remote", "add", "rem", "../origin.git");
G(AM, "fetch", "-q", "rem");
G(AM, "branch", "rem/main");
W(`${AM}/main..side`, "a file named like the range\n");
W(`${AM}/side`, "a file named like the branch\n");

// -- colors: color.ui=always, a textconv driver and diff.external --
W("tools/ext.sh", '#!/bin/sh\necho "EXTERNAL $1 $5"\necho "EXTERNAL on stderr" >&2\n');
CHMOD("tools/ext.sh", "755");
const CO_ = "repos/colors";
MKDIR(CO_);
G(CO_, "init", "-q");
W(`${CO_}/.gitattributes`, "*.txt diff=upper\n");
W(`${CO_}/a.txt`, "lower case\n");
G(CO_, "add", "-A");
GD(CO_, D(2), "commit", "-qm", "colors base");
G(CO_, "switch", "-q", "-c", "other");
W(`${CO_}/a.txt`, "lower case, changed on other\n");
W(`${CO_}/b.txt`, "new on other\n");
G(CO_, "add", "-A");
GD(CO_, D(3), "commit", "-qm", "other change");
G(CO_, "switch", "-q", "main");
G(CO_, "config", "color.ui", "always");
G(CO_, "config", "diff.upper.textconv", "tr a-z A-Z");
G(CO_, "config", "diff.external", "../../tools/ext.sh");

// -- empty, bare, corrupt packed-refs --
MKDIR("repos/empty");
G("repos/empty", "init", "-q");
MKDIR("repos/bare.git");
G("repos/bare.git", "init", "-q", "--bare");
MKDIR("repos/corrupt");
G("repos/corrupt", "init", "-q");
W("repos/corrupt/c.txt", "c\n");
G("repos/corrupt", "add", "-A");
G("repos/corrupt", "commit", "-qm", "c");
G("repos/corrupt", "pack-refs", "--all");
W("repos/corrupt/.git/packed-refs", "this is not a packed-refs line\n");

// -- slow: the timeouts, behind the wrapper's markers --
MKDIR("repos/slow-origin.git");
G("repos/slow-origin.git", "init", "-q", "--bare");
MKDIR("repos/slow");
G("repos/slow", "init", "-q");
W("repos/slow/f.txt", "slow\n");
G("repos/slow", "add", "-A");
GD("repos/slow", D(2), "commit", "-qm", "slow");
G("repos/slow", "remote", "add", "origin", "../slow-origin.git");
for (const b of ["one", "two", "three", "four", "five", "six"]) G("repos/slow", "branch", b);
G("repos/slow", "push", "-q", "-u", "origin", "main", "six");

WS([
  { id: "wks_br", root: BR },
  { id: "wks_wt", root: "repos/br-wt" },
  { id: "wks_nested", root: `${BR}/sub` },
  { id: "wks_link", root: "links/br" },
  { id: "wks_ambig", root: AM },
  { id: "wks_colors", root: CO_ },
  { id: "wks_empty", root: "repos/empty" },
  { id: "wks_bare", root: "repos/bare.git" },
  { id: "wks_corrupt", root: "repos/corrupt" },
  { id: "wks_slow", root: "repos/slow" },
  { id: "wks_plain", root: "plain" },
  { id: "wks_file", root: "plain/f.txt" },
  { id: "wks_missing", root: "nowhere/at/all" },
  { id: "wks_emptyroot", raw: "" },
  { id: "cust_x", root: BR },
]);
STATE(BR);

// -- branches --
LIST("many branches: remotes, origin/HEAD as `origin`, a gone upstream", "wks_br");
LIST("unknown workspace", "wks_nope");
LIST("nested dir: the repo root", "wks_nested");
LIST("through a symlink", "wks_link");
LIST("linked worktree: its own current", "wks_wt");
LIST("a cust_ id is a workspace id here", "cust_x");
LIST("branch and tag of one name, a local named like a remote ref", "wks_ambig");
LIST("empty repo", "wks_empty");
LIST("bare repo: not a repo", "wks_bare");
LIST("corrupt packed-refs: 500", "wks_corrupt");
LIST("plain dir", "wks_plain");
LIST("a file", "wks_file");
LIST("missing dir", "wks_missing");
LIST("empty rootPath: the server's cwd", "wks_emptyroot");
LIST("no git", "wks_br", { nogit: true });

// -- branch-compare --
CMP("log: main vs feat/x", "wks_br", { base: "main", head: "feat/x" });
CMP("log: feat/x vs main", "wks_br", { base: "feat/x", head: "main" });
CMP("log: same branch, no stat block", "wks_br", { base: "main", head: "main" });
CMP("log: diverged upstream", "wks_br", { base: "origin/main", head: "main" });
CMP("log: list trimmed of a trailing U+3000 and BOM", "wks_br", { base: "main", head: "trail" });
CMP("log: a trailing NEL stays", "wks_br", { base: "main", head: "trailnel" });
CMP("diff: a trailing NEL stays", "wks_br", { mode: "diff", head: "trailnel" });
CMP("log: unicode names", "wks_br", { base: CAFE, head: NIHON });
CMP("log: a tag and HEAD", "wks_br", { base: "v1", head: "HEAD" });
CMP("log: remote-tracking head", "wks_br", { base: "main", head: "origin/only-remote" });
CMP("log: unknown head", "wks_br", { base: "main", head: "nope" });
CMP("log: unknown base", "wks_br", { base: "nope", head: "main" });
CMP("log: dash head", "wks_br", { base: "main", head: "-x" });
CMP("log: dash base", "wks_br", { base: "--all", head: "main" });
CMP("log: base with a space", "wks_br", { base: "main ", head: "feat/x" });
CMP("log: a padded head isn't trimmed", "wks_br", { base: "main", head: " feat/x" });
CMP("log: dotdot head", "wks_br", { base: "main", head: "main..feat/x" });
CMP("log: tilde head", "wks_br", { base: "main", head: "main~1" });
CMP("log: NUL head", "wks_br", { base: "main", head: "a\0b" });
CMP("log: NBSP head", "wks_br", { base: "main", head: "a" + NBSP + "b" });
CMP("log: NEL head reaches git", "wks_br", { base: "main", head: "nel" + NEL + "x" });
CMP("log: the dash branch can't be compared", "wks_br", { base: "main", head: "-dash" });
CMP("log: range ambiguous with a file", "wks_ambig", { base: "main", head: "side" });
CMP("log: heads/dup as listed", "wks_ambig", { base: "main", head: "heads/dup" });
CMP("log: an ambiguous name warns on stderr, dropped", "wks_ambig", { base: "main", head: "dup" });
CMP("log: colors stay off", "wks_colors", { base: "main", head: "other" });
CMP("log: empty repo", "wks_empty", { base: "main", head: "main" });
CMP("log: no merge base", "wks_ambig", { base: "main", head: "orphan" });
CMP("diff: clean against main", "wks_br", { mode: "diff", head: "main" });
CMP("diff: against feat/x", "wks_br", { mode: "diff", head: "feat/x" });
CMP("diff: unknown head", "wks_br", { mode: "diff", head: "nope" });
CMP("diff: dash head", "wks_br", { mode: "diff", head: "--output=x" });
CMP("diff: a path, not a ref", "wks_br", { mode: "diff", head: "f.txt" });
CMP("diff: NUL head", "wks_br", { mode: "diff", head: "a\0" });
CMP("diff: a ref and a file of one name", "wks_ambig", { mode: "diff", head: "side" });
CMP("diff: the external diff runs", "wks_colors", { mode: "diff", head: "other" });
CMP("diff: empty repo", "wks_empty", { mode: "diff", head: "main" });
CMP("diff: base is ignored", "wks_br", { mode: "diff", head: "main", base: "-x" });
CMPQ("no query", "wks_br", "");
CMPQ("no head", "wks_br", "base=main");
CMPQ("empty head", "wks_br", "base=main&head=");
CMPQ("no base", "wks_br", "head=main");
CMPQ("empty base", "wks_br", "base=&head=main");
CMPQ("mode=log explicit", "wks_br", "mode=log&base=main&head=feat%2Fx");
CMPQ("other mode is log", "wks_br", "mode=DIFF&head=feat%2Fx");
CMPQ("empty mode is log", "wks_br", "mode=&base=main&head=main");
CMPQ("first head wins", "wks_br", "mode=diff&head=main&head=nope");
CMPQ("first mode wins", "wks_br", "mode=diff&mode=log&head=main");
CMPQ("plus is a space", "wks_br", "base=main&head=feat+x");
CMPQ("a blank head isn't missing", "wks_br", "mode=diff&head=%20");
CMPQ("a blank base isn't missing", "wks_br", "base=%20&head=main");
CMPQ("malformed percent", "wks_br", "base=main&head=%ZZ");
CMPQ("bad UTF-8 percent", "wks_br", "base=main&head=%C3");
CMPQ("encoded key", "wks_br", "%62ase=main&%68ead=feat%2Fx");
CMP("unknown workspace", "wks_nope", { base: "main", head: "x" });
CMPQ("unknown workspace, no params", "wks_nope", "");
CMP("plain dir", "wks_plain", { base: "main", head: "x" });
CMP("plain dir, diff", "wks_plain", { mode: "diff", head: "x" });
CMP("plain dir, invalid names: repo first", "wks_plain", { base: "-a", head: "-b" });
CMP("bare repo", "wks_bare", { base: "main", head: "main" });
CMP("no git", "wks_br", { base: "main", head: "feat/x" }, { nogit: true });

// -- checkout: bodies --
CO("no body", "wks_br");
CO("empty body", "wks_br", "");
CO("malformed body", "wks_br", "{");
CO("null body: throws", "wks_br", "null");
CO("array body", "wks_br", "[]");
CO("string body", "wks_br", '"main"');
CO("number body", "wks_br", "5");
CO("true body", "wks_br", "true");
CO("null name", "wks_br", { name: null });
CO("number name", "wks_br", { name: 5 });
CO("1e400 name", "wks_br", '{"name":1e400}');
CO("empty name", "wks_br", { name: "" });
CO("blank name", "wks_br", { name: " \t\n " });
CO("NBSP name", "wks_br", { name: NBSP });
CO("BOM name", "wks_br", { name: BOM });
CO("array name", "wks_br", { name: ["main"] });
CO("object name", "wks_br", { name: {} });
CO("unknown workspace, null body", "wks_nope", "null");
CO("unknown workspace, no body", "wks_nope");
CO("startPoint number", "wks_br", { name: "main", startPoint: 5 });
CO("startPoint false", "wks_br", { name: "main", startPoint: false });
CO("startPoint object", "wks_br", { name: "main", startPoint: {} });
CO("startPoint 1e400", "wks_br", '{"name":"main","startPoint":1e400}');
CO("startPoint number before an invalid name", "wks_br", { name: "-x", startPoint: 1 });
CO("startPoint empty: invalid even without create", "wks_br", { name: "main", startPoint: "" });
CO("startPoint dash", "wks_br", { name: "nope", startPoint: "-x" });
CO("startPoint padded", "wks_br", { name: "nope", startPoint: " main" });
CO("dash name", "wks_br", { name: "-x" });
CO("padded dash name", "wks_br", { name: " -x" });
CO("double-dash name", "wks_br", { name: "--orphan" });
CO("inner space", "wks_br", { name: "a b" });
CO("dotdot", "wks_br", { name: "a..b" });
CO("at-brace", "wks_br", { name: "main@{1}" });
CO("trailing slash", "wks_br", { name: "feat/" });
CO(".lock", "wks_br", { name: "x.lock" });
CO("256 units", "wks_br", { name: "x".repeat(256) });
CO("unknown branch", "wks_br", { name: "nope" });
CO("unknown branch, startPoint ignored", "wks_br", { name: "nope", startPoint: "main" });
CO("origin/HEAD is `origin` in the list", "wks_br", { name: "origin" });
CO("NUL name: unknown", "wks_br", { name: "a\0b" });
CO("NBSP branch can't be checked out", "wks_br", { name: "a" + NBSP + "b" });
CO("dash branch can't be checked out", "wks_br", { name: "-dash" });
CO("heads/dup as listed: unknown", "wks_ambig", { name: "heads/dup" });
CO("remotes/rem/main as listed: unknown", "wks_ambig", { name: "remotes/rem/main" });
CO("BOM-prefixed body", "wks_br", BOM + J({ name: "nope-bom" }));
CO("two BOMs", "wks_br", BOM + BOM + J({ name: "nope-two-boms" }));
CO("duplicate key: the last wins", "wks_br", '{"name":"-x","name":"nope-dup"}');
POSTHEX("invalid UTF-8 in the name", "checkout", "wks_br", hex('{"name":"x') + "ff" + hex('y"}'));
CO("lone surrogate name", "wks_br", '{"name":"\\ud800x"}');
CO("lone surrogate name and a 1e400 startPoint", "wks_br", '{"name":"\\ud800x","startPoint":1e400}');
CO("200-deep body", "wks_br", '{"name":"nope-deep","pad":' + "[".repeat(200) + "]".repeat(200) + "}");
CO("two BOMs and a 1e400 startPoint", "wks_br", BOM + BOM + '{"name":"nope","startPoint":1e400}');
CO("three BOMs: malformed", "wks_br", BOM + BOM + BOM + J({ name: "nope" }));

// -- checkout: switching --
G(BR, "update-ref", "refs/remotes/loose", "HEAD");
G(BR, "update-ref", "refs/remotes/origin/-x", "HEAD");
CO("a remote ref with no slash: no local name", "wks_br", { name: "loose" }, BR);
CO("a remote ref whose local name starts with a dash", "wks_br", { name: "origin/-x" }, BR);
CO("already on main: stdout then stderr", "wks_br", { name: "main" }, BR);
CO("startPoint null is no startPoint", "wks_br", { name: "main", startPoint: null }, BR);
CO("padded name is trimmed", "wks_br", { name: " feat/x " }, BR);
CO("back to main", "wks_br", { name: "main" }, BR);
CO("remote-only: --track", "wks_br", { name: "origin/only-remote" }, BR);
CO("remote-only again: the local", "wks_br", { name: "origin/only-remote" }, BR);
CO("remote with a local twin: the local", "wks_br", { name: "origin/feat/x" }, BR);
CO("slashed remote: git names the local", "wks_br", { name: "team/a/tonly" }, BR);
CO("slashed remote: git's local exists", "wks_br", { name: "team/a/main" }, BR);
CO("origin/HEAD", "wks_br", { name: "origin/HEAD" }, BR);
CO("unicode branch", "wks_br", { name: CAFE }, BR);
CO("CJK branch", "wks_br", { name: NIHON }, BR);
CO("emoji branch", "wks_br", { name: "emoji-" + GRIN }, BR);
CO("quote branches", "wks_br", { name: 'q"uote' }, BR);
CO("apostrophe branch", "wks_br", { name: "it's" }, BR);
CO("shell characters", "wks_br", { name: "a$b#c!" }, BR);
CO("NEL branch", "wks_br", { name: "nel" + NEL + "x" }, BR);
CO("250-unit branch", "wks_br", { name: "l".repeat(250) }, BR);
CO("main again", "wks_br", { name: "main" }, BR);
CO("used by another worktree", "wks_br", { name: "wtbr" }, BR);
CO("the worktree's own branch", "wks_wt", { name: "wtbr" }, "repos/br-wt");
CO("main from the worktree", "wks_wt", { name: "main" }, "repos/br-wt");
CO("branch and tag of one name", "wks_ambig", { name: "dup" }, AM);
CO("local named like a remote ref", "wks_ambig", { name: "rem/main" }, AM);
CO("ambig: back to main", "wks_ambig", { name: "main" }, AM);
W(`${AM}/.git/hooks/post-checkout`, "#!/bin/sh\nprintf 'post-checkout says \\302\\205\\n' >&2\nprintf ' out\\302\\205 \\n'\n");
CHMOD(`${AM}/.git/hooks/post-checkout`, "755");
CO("a hook's NEL-ended output", "wks_ambig", { name: "side" }, AM);
CO("and back with the hook", "wks_ambig", { name: "main" }, AM);
RM(`${AM}/.git/hooks/post-checkout`);
// A dirty tree.
W(`${BR}/f.txt`, "dirty\n");
CO("dirty: local changes would be overwritten", "wks_br", { name: "feat/x" }, BR);
CO("dirty: carried over", "wks_br", { name: CAFE }, BR);
CO("dirty: carried back", "wks_br", { name: "main" }, BR);
CO("dirty: create carries it", "wks_br", { name: "dirty-new", create: true }, BR);
CO("dirty: main once more", "wks_br", { name: "main" }, BR);
G(BR, "checkout", "-q", "--", "f.txt");
W(`${BR}/x.txt`, "untracked x\n");
CO("untracked file would be overwritten", "wks_br", { name: "feat/x" }, BR);
RM(`${BR}/x.txt`);
W(`${BR}/staged.txt`, "staged\n");
G(BR, "add", "staged.txt");
CO("staged file carried over", "wks_br", { name: "merged-br" }, BR);
CO("staged file carried back", "wks_br", { name: "main" }, BR);
G(BR, "reset", "-q");
RM(`${BR}/staged.txt`);
// A detached HEAD with a commit on it.
G(BR, "switch", "-q", "--detach", "HEAD");
LIST("detached HEAD: nothing current", "wks_br");
W(`${BR}/d.txt`, "detached\n");
G(BR, "add", "-A");
GD(BR, D(12), "commit", "-qm", "detached work");
CO("leaving a commit behind", "wks_br", { name: "main" }, BR);
// Creating.
CO("create", "wks_br", { name: "new1", create: true }, BR);
CO("create from a remote ref: tracks it", "wks_br", { name: "new2", create: true, startPoint: "origin/feat/x" }, BR);
CO("create from a tag", "wks_br", { name: "new3", create: true, startPoint: "v1" }, BR);
CO("create from an unknown start", "wks_br", { name: "new4", create: true, startPoint: "nope" }, BR);
CO("create an existing name", "wks_br", { name: "main", create: true }, BR);
CO("create padded", "wks_br", { name: " new5 ", create: true }, BR);
CO("create HEAD", "wks_br", { name: "HEAD", create: true });
CO("create a/.b", "wks_br", { name: "a/.b", create: true });
CO("create @", "wks_br", { name: "@", create: true });
CO("create a control character", "wks_br", { name: "a\x01b", create: true });
CO("create with a NUL", "wks_br", { name: "a\0b", create: true });
CO("create with a long NUL name", "wks_br", { name: "q\"'\0" + "r".repeat(130), create: true });
CO("create 255 units: too long for the disk", "wks_br", { name: "x".repeat(255), create: true });
CO("create 255 units of emoji", "wks_br", { name: GRIN.repeat(127) + "a", create: true });
CO("create as a string", "wks_br", { name: "new6", create: "true" });
CO("create as 1", "wks_br", { name: "new6", create: 1 });
CO("main to finish", "wks_br", { name: "main" }, BR);
CO("create in an empty repo", "wks_empty", { name: "first", create: true }, "repos/empty");
CO("checkout in an empty repo", "wks_empty", { name: "main" }, "repos/empty");
CO("corrupt packed-refs: probe", "wks_corrupt", { name: "main" }, "repos/corrupt");
CO("plain dir", "wks_plain", { name: "main" });
CO("plain dir, invalid name: repo first", "wks_plain", { name: "-x" });
CO("bare repo", "wks_bare", { name: "main" });
CO("missing dir", "wks_missing", { name: "main" });
CO("empty rootPath", "wks_emptyroot", { name: "srv-side" }, "servercwd");
CO("no git", "wks_br", { name: "main" }, null, { nogit: true });

// -- branch-rename --
REN("null body: throws", "wks_br", "null");
REN("no body", "wks_br");
REN("no oldName", "wks_br", { newName: "x" });
REN("blank oldName", "wks_br", { oldName: "  ", newName: "x" });
REN("number oldName", "wks_br", { oldName: 1, newName: "x" });
REN("no newName", "wks_br", { oldName: "merged-br" });
REN("blank newName", "wks_br", { oldName: "merged-br", newName: NBSP });
REN("array newName", "wks_br", { oldName: "merged-br", newName: ["x"] });
REN("array body", "wks_br", "[]");
REN("unknown workspace", "wks_nope", "null");
REN("rename: git prints nothing", "wks_br", { oldName: "merged-br", newName: "renamed-br" }, BR);
REN("onto an existing branch", "wks_br", { oldName: "renamed-br", newName: "feat/x" }, BR);
REN("onto itself", "wks_br", { oldName: "renamed-br", newName: "renamed-br" }, BR);
REN("a directory of an existing branch", "wks_br", { oldName: "renamed-br", newName: "feat" }, BR);
REN("under an existing branch", "wks_br", { oldName: "renamed-br", newName: "main/sub" }, BR);
REN("unknown branch", "wks_br", { oldName: "nope", newName: "nope2" }, BR);
REN("the current branch", "wks_br", { oldName: "main", newName: "trunk" }, BR);
REN("and back", "wks_br", { oldName: "trunk", newName: "main" }, BR);
REN("with an upstream", "wks_br", { oldName: "pushed", newName: "pushed-renamed" }, BR);
REN("another worktree's branch", "wks_br", { oldName: "wtbr", newName: "wtbr2" }, BR);
REN("padded names", "wks_br", { oldName: " renamed-br ", newName: "\tr2\n" }, BR);
REN("unicode", "wks_br", { oldName: CAFE, newName: CAFE + "-2" }, BR);
REN("dash old", "wks_br", { oldName: "-dash", newName: "dash" });
REN("dash new", "wks_br", { oldName: "r2", newName: "-r3" });
REN("NBSP old", "wks_br", { oldName: "a" + NBSP + "b", newName: "nbsp" });
REN("tilde new", "wks_br", { oldName: "r2", newName: "r~3" });
REN("256-unit new", "wks_br", { oldName: "r2", newName: "y".repeat(256) });
REN("git refuses a/.b", "wks_br", { oldName: "r2", newName: "a/.b" }, BR);
REN("git refuses @", "wks_br", { oldName: "r2", newName: "@" }, BR);
REN("git refuses a .lock component", "wks_br", { oldName: "r2", newName: "x.lock/y" }, BR);
REN("git refuses a control character", "wks_br", { oldName: "r2", newName: "r\x01" }, BR);
REN("NUL new", "wks_br", { oldName: "r2", newName: "r\0" });
REN("the dash branch stays", "wks_br", { oldName: "x", newName: "-dash" });
REN("ambig: the branch, not the tag", "wks_ambig", { oldName: "dup", newName: "dup2" }, AM);
REN("empty repo: the unborn branch", "wks_empty", { oldName: "first", newName: "unborn" }, "repos/empty");
REN("plain dir", "wks_plain", { oldName: "a", newName: "b" });
REN("bare repo", "wks_bare", { oldName: "a", newName: "b" });
REN("no git", "wks_br", { oldName: "r2", newName: "r3" }, null, { nogit: true });

// -- branch-delete --
DEL("null body: throws", "wks_br", "null");
DEL("no body", "wks_br");
DEL("number name", "wks_br", { name: 7 });
DEL("blank name", "wks_br", { name: IDEOSP });
DEL("unknown workspace", "wks_nope", { name: "x" });
DEL("merged", "wks_br", { name: "r2" }, BR);
DEL("unmerged: refused", "wks_br", { name: "unmerged" }, BR);
DEL("force as a string: refused", "wks_br", { name: "unmerged", force: "true" }, BR);
DEL("unmerged, forced", "wks_br", { name: "unmerged", force: true }, BR);
DEL("merged upstream, not HEAD: a warning", "wks_br", { name: "pushed-renamed" }, BR);
DEL("the current branch", "wks_br", { name: "main" }, BR);
DEL("the current branch, forced", "wks_br", { name: "main", force: true }, BR);
DEL("another worktree's branch", "wks_br", { name: "wtbr2" }, BR);
DEL("unknown", "wks_br", { name: "nope" }, BR);
DEL("a remote ref name, locally", "wks_br", { name: "origin/feat/x" }, BR);
DEL("remote as a string: local", "wks_br", { name: "origin/feat/x", remote: "true" }, BR);
DEL("gone upstream", "wks_br", { name: "gonebr" }, BR);
DEL("padded", "wks_br", { name: " new3 " }, BR);
DEL("dash", "wks_br", { name: "-dash" });
DEL("NUL", "wks_br", { name: "a\0" });
DEL("ambig: the branch, not the tag", "wks_ambig", { name: "dup2", force: true }, AM);
DEL("empty repo", "wks_empty", { name: "nope" });
DEL("plain dir", "wks_plain", { name: "x" });
DEL("bare repo", "wks_bare", { name: "x" });
DEL("no git", "wks_br", { name: "x" }, null, { nogit: true });
// Remote.
const REMOTE = (label, name, extra, more = {}) => {
  DEL(label, "wks_br", { name, remote: true, ...extra }, BR, more);
  if (!more.nogit) STATE("repos/origin.git");
};
REMOTE("remote: push --delete", "origin/feat/deep/nested");
REMOTE("remote: no such remote branch", "origin/nope");
REMOTE("remote: no such remote", "nosuch/x");
REMOTE("remote: no slash", "origin");
REMOTE("remote: leading slash", "/x");
REMOTE("remote: dash branch", "origin/-x");
REMOTE("remote: dash remote", "-origin/x");
REMOTE("remote: dotdot", "origin/a..b");
REMOTE("remote: a remote ending in .lock", "x.lock/foo");
REMOTE("remote: padded and force ignored", " origin/pushed ", { force: true });
REMOTE("remote: `.` deletes a local branch", "./tokill");
REMOTE("remote: `.` refuses the current branch", "./main");
REMOTE("remote: a slashed remote is misparsed", "team/a/tonly");
REMOTE("remote: a plain dir as the remote", "sub/x");
REMOTE("remote: NUL", "origin/a\0");
W(`${BR}/.git/hooks/pre-push`, "#!/bin/sh\necho hook stdout\necho hook stderr >&2\nexit 1\n");
CHMOD(`${BR}/.git/hooks/pre-push`, "755");
REMOTE("remote: a pre-push hook refuses", "origin/feat/x");
RM(`${BR}/.git/hooks/pre-push`);
W(`${BR}/.git/hooks/pre-push`, "#!/bin/sh\nexit 1\n");
CHMOD(`${BR}/.git/hooks/pre-push`, "755");
REMOTE("remote: a silent hook refuses", "origin/feat/x");
RM(`${BR}/.git/hooks/pre-push`);
REMOTE("remote: no git", "origin/feat/x", {}, { nogit: true });
DEL("remote: plain dir", "wks_plain", { name: "origin/x", remote: true });
LIST("after it all", "wks_br");

// -- the for-each-ref parser on canned output --
const CANNED = [
  ["one plain line", "refs/heads/a\0a\0abc1234\0\0" + "2026-01-02 00:00:00 +0000\0*\n"],
  ["no trailing newline", "refs/heads/a\0a\0abc1234\0origin/a\0d\0 "],
  ["empty output", ""],
  ["blank lines", "\n\n\n"],
  ["CRLF lines: the head flag is `*\\r`", "refs/heads/a\0a\0s\0\0d\0*\r\nrefs/heads/b\0b\0s\0\0d\0 \r\n"],
  ["missing fields", "refs/heads/b\0b\nrefs/heads/c\0c\0s1\nrefs/heads/d\0d\0s2\0u\n"],
  ["empty refname or name: skipped", "\0name\0s\0\0d\0*\nrefs/heads/x\0\0s\0\0d\0*\n\0\0\0\0\0\n"],
  ["remote HEADs", [
    "refs/remotes/o/HEAD\0o/HEAD\0s\0\0d\0 ",
    "refs/remotes/a/b/HEAD\0a/b/HEAD\0s\0\0d\0 ",
    "refs/remotes/x\0HEAD\0s\0\0d\0 ",
    "refs/remotes/y\0/HEAD\0s\0\0d\0 ",
    "refs/heads/o/HEAD\0o/HEAD\0s\0\0d\0 ",
    "refs/remotes/o/HEAD\0o/HEADx\0s\0\0d\0 ",
    "refs/remotes/o/HEAD\0o/head\0s\0\0d\0 ",
    "refs/remotes/o\0o\0s\0\0d\0 ",
  ].join("\n")],
  ["kinds by refname prefix", [
    "refs/remotes/\0r\0s\0\0d\0 ",
    "refs/remotesX/a\0a\0s\0\0d\0 ",
    " refs/remotes/b\0b\0s\0\0d\0 ",
    "REFS/REMOTES/c\0c\0s\0\0d\0 ",
    "refs/tags/t\0t\0s\0\0d\0 ",
  ].join("\n")],
  ["extra fields and odd head flags", [
    "refs/heads/a\0a\0s\0u\0d\0*\0extra\0more",
    "refs/heads/b\0b\0s\0u\0d\0**",
    "refs/heads/c\0c\0s\0u\0d\0",
    "refs/heads/d\0d\0s\0u\0d\0+",
  ].join("\n")],
  ["an upstream of 0 is kept", "refs/heads/a\0a\0s\0" + "0\0d\0 \n"],
  ["unicode and separators", "refs/heads/" + CAFE + "\0" + CAFE + "\0s\0o/" + NIHON + "\0d" + LSEP + "x\0*\n"],
];
for (const [label, text] of CANNED) {
  MARKHEX("out-for-each-ref", hex(text));
  LIST(`canned: ${label}`, "wks_slow");
}
MARKHEX("out-for-each-ref", hex("refs/heads/a\0a\0") + "ff" + hex("\0\0d\0*\n") + "e282");
LIST("canned: invalid UTF-8", "wks_slow");
MARK("out-for-each-ref", "partial out\n");
MARK("err-for-each-ref", "and err\n");
MARK("exit-for-each-ref", "3");
LIST("canned: exit 3 with both streams", "wks_slow");
MARK("exit-for-each-ref", "1");
LIST("canned: exit 1, no output", "wks_slow");
MARK("out-for-each-ref", "refs/heads/z\0z\0s\0\0d\0*\n");
MARK("err-for-each-ref", "warning: on stderr\n");
LIST("canned: stderr on success is ignored", "wks_slow");
DIR("fakemarks");

// -- the timeouts: one request per git call site, all at once --
MARK("kill-for-each-ref-1", "for-each-ref");
MARK("kill-log-2", "--no-color main..one");
MARK("kill-diff-3", "--no-textconv three");
MARK("kill-diff-4", "main...two");
MARK("kill-switch-5", "-c slowbr");
MARK("kill-show-ref-6", "refs/heads/one");
MARK("kill-branch-7", "-m four four2");
MARK("kill-branch-8", "-d five");
MARK("slow-push-9", "--delete six");
PAR([
  listReq("slow: for-each-ref killed at 15 s", "wks_slow"),
  cmpReq("slow: the first log killed", "wks_slow", { base: "main", head: "one" }),
  cmpReq("slow: the worktree diff killed", "wks_slow", { mode: "diff", head: "three" }),
  cmpReq("slow: diff --stat killed", "wks_slow", { base: "main", head: "two" }),
  postReq("slow: switch -c killed", "checkout", "wks_slow", { name: "slowbr", create: true }),
  postReq("slow: the first show-ref killed", "checkout", "wks_slow", { name: "one" }),
  postReq("slow: branch -m killed", "branch-rename", "wks_slow", { oldName: "four", newName: "four2" }),
  postReq("slow: branch -d killed", "branch-delete", "wks_slow", { name: "five" }),
  postReq("slow: push past 15 s still answers", "branch-delete", "wks_slow", { name: "origin/six", remote: true }),
]);
DIR("fakemarks");
STATE("repos/slow");
STATE("repos/slow-origin.git");

// -- a workspaces.json that doesn't parse: getWorkspace throws --
WS([], "{ not json");
LIST("broken store", "wks_br");
CMP("broken store", "wks_br", { base: "main", head: "main" });
CO("broken store", "wks_br", "null");
REN("broken store", "wks_br", { oldName: "a", newName: "b" });
DEL("broken store", "wks_br", { name: "a" });

// The server's own cwd, where an empty rootPath runs git (`cwd: ""` is no cwd).
mkdirSync(join(ROOT, "servercwd"), { recursive: true });
process.chdir(join(ROOT, "servercwd"));
const steps = [];
for (const step of S) {
  if (step.op === "req") step.got = await request(step);
  else if (step.op === "par") await parallel(step);
  else exec(step);
  steps.push(step);
}

const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
const fixture = { gitVersion, env: ENV, fakeGit: FAKE_GIT, stateCmds: STATE_CMDS, refnames, steps };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
const reqs = steps.flatMap((s) => (s.op === "req" ? [s] : s.op === "par" ? s.reqs : []));
console.log(
  `wrote ${out.slice(repo.length + 1)}: ${refnames.length} refnames; ${steps.length} steps (${reqs.length} requests, ${steps.filter((s) => s.op === "state").length} states) on ${gitVersion}`,
);
process.exit(0);
