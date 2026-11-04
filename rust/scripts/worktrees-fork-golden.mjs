#!/usr/bin/env node
// Golden fixture for D05: `GET /api/worktrees` (`lib/server/worktrees.ts`)
// and `POST /api/sessions/fork` (`lib/server/sessions-store.ts` `fork`, the
// SDK's `forkSession`, `lib/server/fork-worktrees.ts`), recorded from the real
// TS sources against real git:
//
//   node rust/scripts/worktrees-fork-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd, a resolve hook for the `@/` imports, and git-golden.mjs's pinned
// environment (HOME, XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR under a temp root,
// no system git config, GIT_CEILING_DIRECTORIES at the root, the C locale,
// UTC, a fixed author, committer and date, so every commit hash is stable).
// Two parts:
// * `parse`: `parsePorcelain` (worktrees.ts) on crafted texts, and
//   `forkSlug`, `forkWorktreeIds` and `worktreeFailureReason`
//   (lib/shared/fork-worktree.ts) on crafted inputs, each as its
//   `JSON.stringify` text.
// * `steps`: repos, worktrees, stores and transcripts set up as data (`git`
//   in a dir under the root, `write` / `mkdir` / `rm` / `symlink` on paths
//   under it, `transcript` into the SDK's project dir of a cwd, `cleanForks`
//   to remove a repo's fork worktrees and `claudius/*` branches), interleaved
//   with the real route handlers (`req`) and snapshots of what they wrote
//   (`state`). `got` is the status, content type and body text, or `threw`
//   (Next's empty 500); a fork's new transcript is `forked`. The root shows
//   as `$ROOT` (`$ENCROOT` in project dir names), the k-th fork id as
//   `$FORKk` and its 8-char slug as `$SLUGk`, and requests may name them too;
//   in `forked`, uuids and ISO times the source transcript doesn't hold are
//   `$U<n>` / `$NOW`. trusted-cwd.ts's caches are dropped before every
//   request, and the requests run in `$ROOT/servercwd`.
//
// Written to rust/crates/claudius-core/tests/fixtures/worktrees_fork_golden.json;
// replayed by crates/claudius-core/tests/worktrees_golden.rs (`parse`) and
// crates/claudius-server/tests/worktrees_fork.rs (`steps`, against the real
// binary, rebuilding every repo with the same steps).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/worktrees_fork_golden.json");

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

if (!process.env.WTF_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wtfork-golden-")));
  try {
    const env = { PATH: process.env.PATH, WTF_GOLDEN_CHILD: root };
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

const ROOT = process.env.WTF_GOLDEN_CHILD;

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

const { parsePorcelain } = await import(join(repo, "lib/server/worktrees.ts"));
const { forkSlug, forkWorktreeIds, worktreeFailureReason } = await import(join(repo, "lib/shared/fork-worktree.ts"));
const { __resetTrustedCwdCache } = await import(join(repo, "lib/server/trusted-cwd.ts"));
const worktreesRoute = await import(join(repo, "app/api/worktrees/route.ts"));
const forkRoute = await import(join(repo, "app/api/sessions/fork/route.ts"));
const sdkVersion = JSON.parse(readFileSync(join(repo, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version;

// ------------------------------- parse -------------------------------

const PORCELAIN = [
  "",
  "\n\n",
  "worktree /a\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n",
  "worktree /a\nHEAD abc\nbranch refs/heads/main",
  "worktree /a\r\nHEAD abc\r\nbranch refs/heads/feat/x\r\n\r\nworktree /b\r\nbare\r\n",
  "worktree /a  \t\nHEAD abc\u00a0\nbranch refs/heads/b\u2028\n \t \nworktree /b\ufeff\n",
  "worktree\nHEAD abc\nworktree \nHEAD def\n",
  "HEAD abc\nbranch refs/heads/x\nlocked\nworktree /a\n",
  "worktree /a\nHEAD abc\nworktree /b\nHEAD def\n\n",
  "worktree /a\nbranch refs/heads/one\nHEAD abc\nHEAD def\nbranch refs/heads/two\n",
  "worktree /a\nlocked reason here\nprunable gitdir file points to non-existent location\nbare x\ndetached y\n",
  "worktree /a\nbranch refs/heads/refs/heads/x\n\nworktree /b\nbranch refs/remotes/o/x\n\nworktree /c\nbranch refs/headsX\n\nworktree /d\nbranch heads/refs/heads/x\n",
  "worktree /a\nHEAD\nbranch\nfoo bar\nlocked\nlocked\n",
  " worktree /x\nworktree /y\n HEAD abc\n",
  "worktree  /two spaces\nHEAD  lead\n",
  "worktree /a\u0085\nHEAD x\u0085\n",
  "worktree /caf\u00e9 \u{1f600}\nbranch refs/heads/\u65e5\u672c\n",
  "worktree /a\rb\nHEAD c\r\r\n",
  "worktree /a\u0000b\nHEAD \u0000\n",
  "worktree /a\ndetached\nbare\nlocked\nprunable\nHEAD h\nbranch refs/heads/z\n\n\n\nworktree /b\n",
];
const REASONS = [
  "",
  "Preparing worktree (new branch 'x')\nfatal: a branch named 'x' already exists\n",
  "error: something\nfatal: other",
  "FATAL:   spaced   out  ",
  "warning: x\nhint: y\n",
  "fatal:",
  "fatal:   \n",
  "   \n\t\n",
  `fatal: ${"a".repeat(200)}`,
  `fatal: ${"b".repeat(120)}`,
  `fatal: ${"c".repeat(121)}`,
  `fatal: ${"d".repeat(118)}\u{1f600}tail`,
  `fatal: ${"e".repeat(119)}\u{1f600}`,
  "fatal:\u00a0x\u2028y\u3000z",
  "error:x",
  "fatalx: y\nnext",
  "  fatal: indented\n",
  "Fatal: X\r\nError: Y\r\n",
  "fatal: a\u0085b",
  "Preparing worktree (checking out 'x')\nHEAD is now at abc msg\n",
  "\u017fatal: long s\nother",
];
const SLUGS = [
  "11111111-2222-4333-8444-555555555555",
  "ABCDEF12-3456-4789-8abc-def012345678",
  "",
  "---",
  "a-b-c",
  "\u00c4\u00d6\u00dc12345678",
  "\u{1f600}abc",
  "abcdefghijklmnop",
  "\u0130x",
  "Z_9.y",
];
const parse = {
  porcelain: PORCELAIN.map((text) => ({ text, out: JSON.stringify(parsePorcelain(text)) })),
  reasons: REASONS.map((stderr) => ({ stderr, out: JSON.stringify(worktreeFailureReason(stderr)) })),
  slugs: SLUGS.map((id) => ({ id, slug: forkSlug(id), ids: forkWorktreeIds(id) })),
};

// ------------------------------- steps -------------------------------

const S = [];
const abs = (p) => (p ? join(ROOT, p) : ROOT);
const forkRoot = join(ROOT, "home/.claude/.claudius/fork-worktrees");
/** Fork ids in the order their responses named them. */
const forks = [];
const expand = (text) => {
  let t = text.replaceAll("$ROOT", ROOT);
  for (let k = forks.length; k >= 1; k--) {
    t = t.replaceAll(`$FORK${k}`, forks[k - 1]).replaceAll(`$SLUG${k}`, forks[k - 1].slice(0, 8));
  }
  return t;
};
const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
const norm = (text) => {
  let t = text.replaceAll(ROOT, "$ROOT").replaceAll(encode(ROOT), "$ENCROOT");
  forks.forEach((id, i) => {
    t = t.replaceAll(id, `$FORK${i + 1}`);
  });
  forks.forEach((id, i) => {
    t = t.replaceAll(id.slice(0, 8), `$SLUG${i + 1}`);
  });
  return t;
};
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
/** A forked transcript: `norm`, then the uuids / times the source lacks. */
function normForked(text, source) {
  const seen = new Map();
  return norm(text)
    .replace(UUID_RE, (u) => {
      if (source.includes(u)) return u;
      if (!seen.has(u)) seen.set(u, `$U${seen.size + 1}`);
      return seen.get(u);
    })
    .replace(ISO_RE, (t) => (source.includes(t) ? t : "$NOW"));
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}
const sources = new Map(); // session id -> transcript template

function exec(step) {
  switch (step.op) {
    case "git": {
      const r = git(abs(step.cwd), step.args);
      if ((r.status !== 0) !== (step.fails === true)) {
        throw new Error(`git ${step.args.join(" ")} in ${step.cwd}: ${r.status} ${r.stdout}${r.stderr}`);
      }
      break;
    }
    case "write":
      mkdirSync(dirname(abs(step.path)), { recursive: true });
      writeFileSync(abs(step.path), step.text.replaceAll("$ROOT", ROOT));
      break;
    case "mkdir":
      mkdirSync(abs(step.path), { recursive: true });
      break;
    case "rm":
      rmSync(abs(step.path), { recursive: true, force: true });
      break;
    case "symlink":
      symlinkSync(step.target.replaceAll("$ROOT", ROOT), abs(step.path));
      break;
    case "transcript": {
      const dir = join(ROOT, "config/projects", encode(abs(step.cwd)));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${step.id}.jsonl`), step.text.replaceAll("$ROOT", ROOT));
      sources.set(step.id, step.text);
      break;
    }
    case "cleanForks": {
      const r = abs(step.repo);
      for (const line of git(r, ["worktree", "list", "--porcelain"]).stdout.split("\n")) {
        if (line.startsWith("worktree ") && line.slice(9).startsWith(`${forkRoot}/`)) {
          git(r, ["worktree", "remove", "--force", line.slice(9)]);
        }
      }
      git(r, ["worktree", "prune"]);
      const refs = git(r, ["for-each-ref", "--format=%(refname:short)", "refs/heads/claudius/"]).stdout;
      for (const b of refs.split("\n").filter(Boolean)) git(r, ["branch", "-D", b]);
      break;
    }
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

function state(step) {
  const index = join(forkRoot, "index.json");
  let indexText = null;
  if (existsSync(index)) indexText = lstatSync(index).isDirectory() ? "<dir>" : norm(readFileSync(index, "utf8"));
  const entries = existsSync(forkRoot) && lstatSync(forkRoot).isDirectory()
    ? readdirSync(forkRoot, { withFileTypes: true }).map((e) => `${norm(e.name)}${e.isDirectory() ? "/" : ""}`).sort()
    : null;
  const projects = {};
  const pdir = join(ROOT, "config/projects");
  for (const d of readdirSync(pdir).sort()) {
    projects[norm(d)] = readdirSync(join(pdir, d)).map(norm).sort();
  }
  const refs = {};
  for (const r of step.repos ?? []) {
    const o = git(abs(r), ["for-each-ref", "--format=%(refname)", "refs/heads"]).stdout;
    refs[r] = o.split("\n").filter(Boolean).map(norm).sort();
  }
  return { index: indexText, forkRoot: entries, projects, refs };
}

async function request(step) {
  const init = { method: step.method };
  if (step.body != null) {
    init.body = expand(step.body);
    init.headers = { "content-type": "application/json" };
  }
  const req = new Request(`http://localhost${expand(step.url)}`, init);
  __resetTrustedCwdCache();
  let res;
  try {
    res = await (step.method === "GET" ? worktreesRoute.GET(req) : forkRoute.POST(req));
  } catch {
    return { got: { threw: true } };
  }
  const body = await res.text();
  let forked;
  if (step.method === "POST" && res.status === 200) {
    const id = JSON.parse(body).sessionId;
    forks.push(id);
    const pdir = join(ROOT, "config/projects");
    const dir = readdirSync(pdir).find((d) => existsSync(join(pdir, d, `${id}.jsonl`)));
    const sid = JSON.parse(expand(step.body)).sessionId;
    forked = normForked(readFileSync(join(pdir, dir, `${id}.jsonl`), "utf8"), sources.get(sid));
  }
  const got = { status: res.status, type: res.headers.get("content-type"), body: norm(body) };
  return forked == null ? { got } : { got, forked };
}

// -- step builders --
const G = (cwd, ...args) => S.push({ op: "git", cwd, args });
const W = (path, text) => S.push({ op: "write", path, text });
const MKDIR = (path) => S.push({ op: "mkdir", path });
const RM = (path) => S.push({ op: "rm", path });
const LINK = (path, target) => S.push({ op: "symlink", path, target });
const CLEAN = (repoDir) => S.push({ op: "cleanForks", repo: repoDir });
const STATE = (...repos) => S.push({ op: "state", repos });
const LIST = (label, query) => S.push({ op: "req", label, method: "GET", url: `/api/worktrees${query}` });
const FORK = (label, body, extra = {}) =>
  S.push({ op: "req", label, method: "POST", url: "/api/sessions/fork", body: typeof body === "string" ? body : JSON.stringify(body), ...extra });
/** `?cwd=` with the value URI-encoded (`$` placeholders kept). */
const cwdQ = (v) => `?cwd=${encodeURIComponent(v).replaceAll("%24", "$")}`;

// -- the server's cwd, repos and worktrees --
W("home/.gitconfig", "[init]\n\tdefaultBranch = main\n");
MKDIR("servercwd");
const repoWithCommit = (dir) => {
  MKDIR(dir);
  G(dir, "init", "-q", "-b", "main");
  W(`${dir}/a.txt`, "a\n");
  G(dir, "add", "a.txt");
  G(dir, "commit", "-q", "-m", "init");
};
repoWithCommit("repos/a");
G("repos/a", "worktree", "add", "-q", "-b", "feat", "../wt/feat");
G("repos/a", "worktree", "add", "-q", "--detach", "../wt/detached", "HEAD");
G("repos/a", "worktree", "add", "-q", "-b", "locked", "../wt/locked");
G("repos/a", "worktree", "lock", "--reason", "busy now", "../wt/locked");
G("repos/a", "worktree", "add", "-q", "-b", "gone", "../wt/gone");
RM("repos/wt/gone");
const UNI = "caf\u00e9 \u{1f600}";
G("repos/a", "worktree", "add", "-q", "-b", "uni", `../wt/${UNI}`);
MKDIR("repos/empty");
G("repos/empty", "init", "-q", "-b", "main");
MKDIR("repos/bare.git");
G("repos/bare.git", "init", "-q", "--bare");
MKDIR("repos/plain");
repoWithCommit("repos/dirty");
W("repos/dirty/untracked.txt", "new\n");
repoWithCommit("repos/dfc");
G("repos/dfc", "branch", "claudius");
repoWithCommit("repos/sub");
MKDIR("repos/sub/inner");
repoWithCommit("repos/extra");
MKDIR("links");
LINK("links/a", "$ROOT/repos/a");
W("afile", "not a dir\n");

const ws = (id, root, defaults) => ({
  id,
  name: id,
  rootPath: `$ROOT/${root}`,
  icon: { kind: "letter", letter: "W", color: "#d97757" },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...(defaults ? { defaults } : {}),
});
W(
  "home/.claude/.claudius/workspaces.json",
  JSON.stringify(
    {
      version: 1,
      workspaces: [
        ws("wks_a", "repos/a", { additionalDirectories: ["$ROOT/repos/extra"] }),
        ws("wks_empty", "repos/empty"),
        ws("wks_bare", "repos/bare.git"),
        ws("wks_plain", "repos/plain"),
        ws("wks_dirty", "repos/dirty"),
        ws("wks_dfc", "repos/dfc"),
        ws("wks_inner", "repos/sub/inner"),
        ws("wks_link", "links/a"),
        ws("wks_missing", "missing"),
        ws("wks_file", "afile"),
      ],
    },
    null,
    2,
  ),
);

// -- transcripts --
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = (sid, n, parent, type, text, extra = {}) => ({
  parentUuid: parent,
  isSidechain: false,
  userType: "external",
  cwd: "$ROOT/repos/a",
  sessionId: sid,
  version: "2.1.300",
  gitBranch: "main",
  type,
  message:
    type === "user"
      ? { role: "user", content: text }
      : { id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "text", text }] },
  uuid: U(n),
  timestamp: `2026-01-01T00:00:0${n}.000Z`,
  ...extra,
});
const jsonl = (lines) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");
S.push({
  op: "transcript",
  cwd: "repos/a",
  id: S1,
  text: jsonl([
    entry(S1, 1, null, "user", "hello there"),
    entry(S1, 2, U(1), "assistant", "hi"),
    entry(S1, 3, U(2), "user", "next"),
    entry(S1, 4, U(3), "assistant", "done"),
  ]),
});
S.push({
  op: "transcript",
  cwd: "repos/a",
  id: S2,
  text: jsonl([entry(S2, 5, null, "user", "side", { isSidechain: true }), entry(S2, 6, U(5), "assistant", "car", { isSidechain: true })]),
});
S.push({ op: "transcript", cwd: "repos/a", id: S3, text: "" });

// -- GET /api/worktrees --
LIST("no cwd: the server's cwd", "");
LIST("empty cwd", "?cwd=");
LIST("blank cwd", "?cwd=%20%20");
LIST("unknown cwd", cwdQ("/nope"));
LIST("a repo with every worktree kind", cwdQ("$ROOT/repos/a"));
LIST("trailing slash resolves to the root", cwdQ("$ROOT/repos/a/"));
LIST("dot segments resolve", cwdQ("$ROOT/repos/a/x/.."));
LIST("a worktree of a root", cwdQ("$ROOT/repos/wt/feat"));
LIST("a unicode worktree", cwdQ(`$ROOT/repos/wt/${UNI}`));
LIST("a pruned worktree: listed, but no dir", cwdQ("$ROOT/repos/wt/gone"));
LIST("no commits yet", cwdQ("$ROOT/repos/empty"));
LIST("a bare repo", cwdQ("$ROOT/repos/bare.git"));
LIST("not a repo", cwdQ("$ROOT/repos/plain"));
LIST("a symlinked root", cwdQ("$ROOT/links/a"));
LIST("a missing root", cwdQ("$ROOT/missing"));
LIST("a root that is a file", cwdQ("$ROOT/afile"));
LIST("an additional directory", cwdQ("$ROOT/repos/extra"));
LIST("dot is the server's cwd", "?cwd=.");
LIST("relative to the server's cwd", "?cwd=repos/a");
LIST("first cwd wins", `${cwdQ("$ROOT/repos/a")}&cwd=%2Fnope`);
LIST("plus is a space", "?cwd=$ROOT/repos/wt/caf%C3%A9+%F0%9F%98%80");
LIST("a subdir root inside a repo", cwdQ("$ROOT/repos/sub/inner"));
LIST("a subdir of a root is unknown", cwdQ("$ROOT/repos/a/sub"));

// -- POST /api/sessions/fork: the body and the session id --
FORK("empty body", "");
FORK("malformed body", "{");
FORK("null body", "null");
FORK("empty object", {});
FORK("array body", "[]");
FORK("string body", '"x"');
FORK("empty sessionId", { sessionId: "" });
FORK("zero sessionId", { sessionId: 0 });
FORK("false sessionId", { sessionId: false });
FORK("not a uuid", { sessionId: "nope" });
FORK("a number", { sessionId: 5 });
FORK("a big number", "{\"sessionId\":1.5e300}");
FORK("true", { sessionId: true });
FORK("an array", { sessionId: [1, [2, null], {}] });
FORK("an object", { sessionId: {} });
FORK("an own toString", { sessionId: { toString: 1 } });
FORK("a uuid in an array", { sessionId: [S1] });
FORK("a uuid with a newline", { sessionId: `${S1}\n` });
FORK("an overflowing number", '{"sessionId":1e400}');
FORK("a negative overflow", '{"sessionId":-1e400}');
FORK("overflows in an array", '{"sessionId":[1e400,null,-1e999]}');
FORK("a lone surrogate", '{"sessionId":"\\ud800x"}');
FORK("no such session", { sessionId: MISSING });
FORK("no such session in a dir", { sessionId: MISSING, dir: "$ROOT/repos/a" });
FORK("an empty transcript", { sessionId: S3 });
FORK("only sidechain messages", { sessionId: S2 });
STATE();

// -- forks --
FORK("a plain fork", { sessionId: S1 });
FORK("a title and a dir", { sessionId: S1, title: "  My fork  ", dir: "$ROOT/repos/a" });
FORK("up to a message", { sessionId: S1, upToMessageId: U(2) });
FORK("up to a missing message", { sessionId: S1, upToMessageId: U(99) });
FORK("up to a number", { sessionId: S1, upToMessageId: 5 });
FORK("up to an array", { sessionId: S1, upToMessageId: [U(2)] });
FORK("up to an own toString", { sessionId: S1, upToMessageId: { toString: 1 } });
FORK("up to an overflow", `{"sessionId":"${S1}","upToMessageId":1e400}`);
FORK("up to a lone surrogate", `{"sessionId":"${S1}","upToMessageId":"\\udc00"}`);
FORK("falsy upTo and a null title", { sessionId: S1, upToMessageId: 0, title: null });
FORK("a number title", { sessionId: S1, title: 5 });
FORK("a false title", { sessionId: S1, title: false });
FORK("an object title", { sessionId: S1, title: { trim: 1 } });
FORK("an overflowing title", `{"sessionId":"${S1}","title":-1e400}`);
FORK("a lone surrogate title", `{"sessionId":"${S1}","title":" \\ud83d "}`);
FORK("a number title, no messages", { sessionId: S2, title: 5 });
FORK("a number title, missing message", { sessionId: S1, upToMessageId: U(99), title: 5 });
FORK("an empty title", { sessionId: S1, title: "" });
FORK("a number dir", { sessionId: S1, dir: 5 });
FORK("an array dir", { sessionId: S1, dir: [] });
FORK("an overflowing dir", `{"sessionId":"${S1}","dir":1e400}`);
FORK("a lone surrogate dir", `{"sessionId":"${S1}","dir":"$ROOT/\\udfff"}`);
FORK("an empty dir searches everywhere", { sessionId: S1, dir: "" });
FORK("a zero dir searches everywhere", { sessionId: S1, dir: 0 });
FORK("a symlinked dir", { sessionId: S1, dir: "$ROOT/links/a" });
FORK("a worktree dir finds the main checkout", { sessionId: S1, dir: "$ROOT/repos/wt/feat" });
FORK("a dir with no project", { sessionId: S1, dir: "$ROOT/repos/plain" });
STATE();

// -- worktrees --
FORK("worktree without a cwd", { sessionId: S1, worktree: true });
FORK("worktree with a number cwd", { sessionId: S1, worktree: true, cwd: 5 });
FORK("worktree with an unknown cwd", { sessionId: S1, worktree: true, cwd: "/nope" });
FORK("worktree with an overflowing cwd", `{"sessionId":"${S1}","worktree":true,"cwd":1e400}`);
FORK("worktree: 0 skips it", { sessionId: S1, worktree: 0, cwd: "$ROOT/repos/a" });
FORK("worktree off a repo", { sessionId: S1, worktree: true, cwd: "$ROOT/repos/a" });
STATE("repos/a");
LIST("the fork's worktree is listed", cwdQ("$ROOT/repos/a"));
LIST("the fork's worktree is a trusted cwd", cwdQ("$ROOT/home/.claude/.claudius/fork-worktrees/fork-$SLUG$LAST"));
CLEAN("repos/a");
FORK("worktree: a truthy string", { sessionId: S1, worktree: "yes", cwd: "$ROOT/repos/a/" });
CLEAN("repos/a");
FORK("worktree off a dirty repo", { sessionId: S1, worktree: true, cwd: "$ROOT/repos/dirty" });
CLEAN("repos/dirty");
FORK("worktree off a repo with no commits", { sessionId: S1, worktree: true, cwd: "$ROOT/repos/empty" });
FORK("worktree: an overflow is truthy", `{"sessionId":"${S1}","worktree":1e400,"cwd":"$ROOT/repos/empty"}`);
FORK("worktree off a bare repo", { sessionId: S1, worktree: true, cwd: "$ROOT/repos/bare.git" });
FORK("worktree off a plain dir", { sessionId: S1, worktree: true, cwd: "$ROOT/repos/plain" });
FORK("worktree off the server's cwd", { sessionId: S1, worktree: true, cwd: "" });
FORK("worktree off a missing root", { sessionId: S1, worktree: true, cwd: "$ROOT/missing" });
FORK("worktree: the branch can't be made", { sessionId: S1, worktree: true, cwd: "$ROOT/repos/dfc" }, { gitText: true });
STATE("repos/dfc");
FORK("worktree off a subdir root", { sessionId: S1, worktree: true, cwd: "$ROOT/repos/sub/inner" });
STATE("repos/sub");
CLEAN("repos/sub");
FORK("worktree off a worktree", { sessionId: S1, worktree: true, cwd: "$ROOT/repos/wt/feat" });
STATE("repos/a");
CLEAN("repos/a");
FORK("worktree off a symlinked root", { sessionId: S1, worktree: true, cwd: "$ROOT/links/a" });
CLEAN("repos/a");
FORK("worktree, a failed fork", { sessionId: MISSING, worktree: true, cwd: "$ROOT/repos/a" });

// -- the fork index --
const IDX = "home/.claude/.claudius/fork-worktrees/index.json";
const indexCase = (label, text) => {
  if (text == null) MKDIR(IDX);
  else W(IDX, text);
  FORK(`index: ${label}`, { sessionId: S1, worktree: true, cwd: "$ROOT/repos/a" });
  STATE("repos/a");
  CLEAN("repos/a");
  RM(IDX);
};
indexCase("malformed", "{");
indexCase("foreign keys and integer-like ids", '{"version":7,"extra":1,"forks":{"x":2,"10":{"a":1},"2":null}}');
indexCase("forks is an array", '{"forks":[1,2]}');
indexCase("forks is a string", '{"version":1,"forks":"str"}');
indexCase("forks is a number", '{"forks":5}');
indexCase("forks is 0", '{"forks":0}');
indexCase("forks is null", '{"forks":null}');
indexCase("a top-level array", "[1]");
indexCase("a top-level null", "null");
indexCase("a BOM", '\ufeff{"forks":{"x":1}}');
indexCase("duplicate keys", '{"forks":{"a":1,"b":2,"a":3}}');
indexCase("a directory", null);
RM("home/.claude/.claudius/fork-worktrees");
W("home/.claude/.claudius/fork-worktrees", "a file\n");
FORK("the worktrees root is a file", { sessionId: S1, worktree: true, cwd: "$ROOT/repos/a" });
STATE("repos/a");
RM("home/.claude/.claudius/fork-worktrees");
LIST("after it all", cwdQ("$ROOT/repos/a"));

mkdirSync(join(ROOT, "servercwd"), { recursive: true });
process.chdir(join(ROOT, "servercwd"));
const steps = [];
for (const step of S) {
  if (step.op === "req") {
    // `$SLUG$LAST`: the latest fork's slug.
    if (step.url.includes("$LAST")) step.url = step.url.replaceAll("$LAST", String(forks.length));
    Object.assign(step, await request(step));
  } else if (step.op === "state") step.state = state(step);
  else exec(step);
  steps.push(step);
}

const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
const fixture = { recordedWith: { sdk: sdkVersion, git: gitVersion, node: process.version }, env: ENV, parse, steps };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
const reqs = steps.filter((s) => s.op === "req");
console.log(
  `wrote ${out.slice(repo.length + 1)}: ${parse.porcelain.length} porcelain texts, ${parse.reasons.length} reasons, ${parse.slugs.length} slugs; ${steps.length} steps (${reqs.length} requests, ${forks.length} forks) on ${gitVersion}, SDK ${sdkVersion}`,
);
process.exit(0);
