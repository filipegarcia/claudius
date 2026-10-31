#!/usr/bin/env node
// Golden fixture for the git core (D06): the exec wrapper and parsers of
// `lib/server/git.ts` behind `GET /api/workspaces/:id/git/{status,diff,show}`,
// recorded from the real TS sources against real `git`:
//
//   node rust/scripts/git-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd, a resolve hook for the `@/` imports, and a pinned environment: HOME,
// XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR under a temp root, no system git
// config, GIT_CEILING_DIRECTORIES at the root (a dir outside every repo is
// "not a repo" wherever the temp dir lives), LANG / LC_ALL = C, TZ = UTC,
// and a fixed author, committer and date so every commit hash is stable.
// Two parts:
// * `parsers`: the private `parseBranchHeader`, the `/^Binary files /m`
//   test and `gitShow`'s missing-blob regex (sliced out of git.ts as text),
//   the exported `parsePorcelainV1Z`, and the message `execFile` throws for
//   a NUL byte in an argument (`util.inspect` of it).
// * `steps`: the setup of every repo, as data (`git` runs with its args in a
//   dir under the root, `write` / `gen` / `rm` / `mkdir` / `symlink` /
//   `chmod` / `exists` on paths under it, `workspaces` writes
//   workspaces.json, `custIndex` the customizations index), interleaved with
//   the real route handlers (`req`). `got` is the status, content type and
//   body text, or `threw` (Next's empty 500). The root shows as `$ROOT`
//   (and `$ROOT_REL` without its leading slash); a body over 200 000 units
//   is kept as its UTF-8 length, FNV-1a 64 hash and head, and one a stream
//   overflow cut (`cut`) as its head only, the signal that killed git
//   shown as `$SIGNAL` (closing the pipes races the SIGTERM). `nogit`
//   requests run with PATH at an empty dir. The requests run in
//   `$ROOT/servercwd`, a repo: an empty rootPath is no cwd to `execFile`.
//
// Written to rust/crates/claudius-core/tests/fixtures/git_golden.json;
// replayed by crates/claudius-core/tests/git_golden.rs (`parsers`) and
// crates/claudius-server/tests/git_routes.rs (`steps`, against the real
// binary, recreating every repo with the same steps).
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/git_golden.json");

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

if (!process.env.GIT_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-golden-")));
  try {
    const env = { PATH: process.env.PATH, GIT_GOLDEN_CHILD: root };
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

const ROOT = process.env.GIT_GOLDEN_CHILD;

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
const headerStart = once("function parseBranchHeader(", "parseBranchHeader");
const headerEnd = src.indexOf("\n}\n", headerStart);
const headerSrc = src.slice(headerStart, headerEnd + 3);
const BINARY = "/^Binary files /m.test(stdout)";
if (count(BINARY) !== 2) throw new Error("getDiff / diffNoIndex no longer share `/^Binary files /m`: update the recorder");
const missingSrc = src.match(/\n {4}if \((\/[^\n]+\/i)\.test\(msg\)\) \{\n {6}return \{ content: "" \};/)?.[1];
if (!missingSrc) throw new Error("gitShow's missing-blob test moved: update the recorder");
const modPath = join(ROOT, "git-extract.ts");
writeFileSync(
  modPath,
  [
    headerSrc,
    "export { parseBranchHeader };",
    "export const isBinary = (stdout: string) => " + BINARY + ";",
    "export const isMissing = (msg: string) => " + missingSrc + ".test(msg);",
    "",
  ].join("\n"),
);
const ex = await import(pathToFileURL(modPath).href);
const { parsePorcelainV1Z } = await import(join(repo, "lib/server/git.ts"));
const routes = {
  status: await import(join(repo, "app/api/workspaces/[id]/git/status/route.ts")),
  diff: await import(join(repo, "app/api/workspaces/[id]/git/diff/route.ts")),
  show: await import(join(repo, "app/api/workspaces/[id]/git/show/route.ts")),
};

const ch = (...codes) => String.fromCharCode(...codes);
const NBSP = ch(0xa0);
const NEL = ch(0x85);
const BOM = ch(0xfeff);
const LS = ch(0x2028);
const PS = ch(0x2029);
const E_ACUTE = ch(0xe9);
const NIHON = ch(0x65e5, 0x672c);
const GRIN = ch(0xd83d, 0xde00);
const json = (v) => JSON.parse(JSON.stringify(v));

// -------------------------------- parsers --------------------------------

const HEADERS = [
  "## main",
  "main",
  "",
  "##",
  "## ",
  "##  main",
  "## main...origin/main",
  "## main...origin/main [ahead 1]",
  "## main...origin/main [behind 2]",
  "## main...origin/main [ahead 1, behind 22]",
  "## main...origin/main [gone]",
  "## main...o/m [ahead x, ahead 007]",
  "## main...o/m [ahead 1, ahead 2]",
  "## main...o/m [behind 1 ahead 3]",
  "## main...o/m [ahead -1]",
  "## main...o/m [ahead 1.5]",
  "## main...o/m [ahead 99999999999999999999]",
  "## main...o/m [ahead " + "9".repeat(400) + "]",
  "## main...o/m [aheadd 1]",
  "## main...o/m [AHEAD 1]",
  "## main...o/m [ahead\t1]",
  "## main...o/m   [ahead 2]  ",
  "## main...o/m\t[ahead 2]\n",
  "## main [ahead 2]",
  "## main...o/m [ahead 2] x",
  "## main...o/m [ahead 2",
  "## main...o/m []",
  "## main...o/m [[ahead 3]]",
  "## main...o/m [a]b]",
  "## main...o/m[ahead 2]",
  "## main...o/m [x\n] ",
  "## main...",
  "## main... ",
  "## main...." + "x",
  "## main..x",
  "## main.",
  "## .main",
  "## v1.2",
  "## release-1.2...origin/release-1.2",
  "## a[b",
  "## [ahead 1]",
  "## main  ",
  "## main\n",
  "## main\nx",
  "## a" + NBSP + "b",
  "## a" + NEL + "b",
  "## a" + BOM,
  "## a" + LS,
  "## a" + PS + "b",
  "## a...b" + NBSP + "c",
  "## a...b" + NEL + "c",
  "## f" + E_ACUTE + "/" + NIHON + "..." + "origin/f" + E_ACUTE,
  "## " + GRIN,
  "## HEAD (no branch)",
  "## HEAD (no branch) x",
  "## HEAD (no branch",
  "## HEAD",
  "## No commits yet on main",
  "## No commits yet on v1.0",
  "## No commits yet on v1.0 x",
  "## No commits yet on ",
  "## No commits yet on  ",
  "## No commits yet on a" + LS + "b",
  "## No commits yet on a" + PS,
  "## No commits yet on a\rb",
  "## No commits yet on a\nb",
  "## No commits yet on a" + NEL + "b",
  "## No commits yet on a" + NBSP + "b",
  "## No commits yet onmain",
  "## no commits yet on main",
  "##  No commits yet on main",
];
const headers = HEADERS.map((line) => ({ line, got: json(ex.parseBranchHeader(line)) }));

const PORCELAIN = [
  "",
  "\0",
  " M a\0",
  " M a",
  "M  a\0MM b\0AM c\0 D d\0D  e\0 T f\0?? g h\0",
  "R  new\0old\0",
  "R  new\0old",
  "R  new\0",
  "R  new",
  " R new\0old\0M  x\0",
  "C  copy\0src\0",
  "RM r\0o\0",
  "UU u\0AA a\0DD d\0AU x\0UA y\0DU z\0UD w\0",
  "M \0?? \0 M " + E_ACUTE + "\0",
  "?? " + GRIN + "\0",
  "?" + GRIN + "\0",
  "abc\0abcd\0",
  "?M p\0M? q\0!! ign\0",
  "?? a\0\0\0?? b\0",
  "XY  two spaces\0",
  "?? new\nline\0?? tab\there\0",
  "R  " + NIHON + "\0" + GRIN + "\0",
];
const porcelain = PORCELAIN.map((buf) => ({ buf, got: json(parsePorcelainV1Z(buf)) }));

const TEXTS = [
  "",
  "Binary files a and b differ",
  "Binary files",
  "binary files a",
  "BINARY FILES a",
  "x\nBinary files a",
  "x\rBinary files a",
  "x\r\nBinary files a",
  "x" + LS + "Binary files a",
  "x" + PS + "Binary files a",
  "x" + NEL + "Binary files a",
  "x\tBinary files a",
  " Binary files a",
  "+Binary files a",
  "+Binary files x\nBinary files y",
  "fatal: path 'x' does not exist in 'HEAD'",
  "fatal: path 'x' exists on disk, but not in 'HEAD'",
  "fatal: path 'x' exists on disk, but not in the index",
  "git show exited 128: fatal: Path 'x' DOES NOT EXIST",
  "FATAL: PATH",
  "Fatal: Path",
  "fatal:  path",
  "fatal: invalid object name 'x'.",
  "fatal: bad object HEAD:sub",
  "path 'x' exists on disk, but not in 'HEAD'",
  "EXISTS ON DISK, BUT NOT IN",
  "exists on disk,but not in",
  "doesnot exist",
  "does not exis",
  "does not exi" + ch(0x17f) + "t",
  "does not ex" + ch(0x130) + "st",
  "DOES NOT EXIST",
];
const binary = TEXTS.map((text) => ({ text, got: ex.isBinary(text) }));
const missing = TEXTS.map((text) => ({ text, got: ex.isMissing(text) }));

/** What `execFile` throws for a NUL byte in `args[1]`. */
function nulMessage(arg) {
  try {
    execFile("git", ["x", arg], {});
  } catch (e) {
    return e.message;
  }
  throw new Error(`no throw for ${JSON.stringify(arg)}`);
}
const INSPECT = [
  "\0",
  "a\0b",
  "it's\0",
  "q\"'\0",
  "q\"'`\0",
  "q\"'${\0",
  "q\"'$\0",
  "q\"'{\0",
  "\"\0",
  "`\0",
  "${\0",
  "\x7f\x85\0\t\n\\\b\x0b\f\r\x1b\x9f" + NBSP,
  E_ACUTE + NIHON + GRIN + "\0",
  "x".repeat(120) + "\n\0" + "y\n".repeat(20),
  "\0" + "z".repeat(200),
  "a".repeat(14) + "\n\0",
  "a".repeat(15) + "\n\0",
  "a".repeat(74) + "\n\0",
  "a".repeat(75) + "\n\0",
  "a".repeat(10) + "\n\0",
  "a".repeat(122) + "\n\0",
  "a".repeat(123) + "\n\0",
  "a\n".repeat(50) + "\0",
  "'\n".repeat(50) + "\0",
  "a\nb'\n\"c\n" + "d".repeat(80) + "\0",
  "\0" + "\n".repeat(100),
  "\0" + "\x01".repeat(40),
  "\0" + GRIN.repeat(70),
  "\0" + "e".repeat(10000),
  "\0" + "e".repeat(10001),
];
const inspect = INSPECT.map((arg) => ({ arg, got: nulMessage(arg) }));

// -------------------------------- steps --------------------------------

const steps = [];
const abs = (p) => (p === "" ? ROOT : join(ROOT, p));
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
    case "gen":
      mkdirSync(dirname(abs(step.path)), { recursive: true });
      writeFileSync(abs(step.path), generate(step));
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
    case "exists":
      step.got = existsSync(abs(step.path));
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
    case "custIndex": {
      const file = join(ROOT, "home/.claude/.claudius/customizations/index.json");
      mkdirSync(dirname(file), { recursive: true });
      if (step.hex != null) writeFileSync(file, Buffer.from(step.hex, "hex"));
      else if (step.text == null) rmSync(file, { force: true });
      else writeFileSync(file, step.text);
      break;
    }
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

/** `lines`: `${tag} ${i} ${"abcdefghij" x 6}\n` for i < n; `bytes`: n xorshift32 low bytes. */
function generate(step) {
  if (step.kind === "lines") {
    const unit = "abcdefghij".repeat(6);
    const parts = [];
    for (let i = 0; i < step.n; i++) parts.push(`${step.tag} ${i} ${unit}\n`);
    return parts.join("");
  }
  const buf = Buffer.alloc(step.n);
  let x = step.seed >>> 0;
  for (let i = 0; i < step.n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

function fnv1a64(buf) {
  let h = 0xcbf29ce484222325n;
  for (const b of buf) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const normalize = (text) => text.split(ROOT).join("$ROOT").split(ROOT.slice(1)).join("$ROOT_REL");
/** Closing the pipes and the SIGTERM race: git dies of either signal. */
const normalizeSignal = (text) => text.replace(/ killed by SIG(PIPE|TERM)\b/, " killed by $SIGNAL");
const EMPTY_PATH = join(ROOT, "emptybin");

async function request(step) {
  const query = step.query.replaceAll("$ROOT", ROOT);
  const url = `http://localhost/api/workspaces/${encodeURIComponent(step.id)}/git/${step.route}${query ? `?${query}` : ""}`;
  const path = process.env.PATH;
  if (step.nogit) process.env.PATH = EMPTY_PATH;
  try {
    const res = await routes[step.route].GET(new Request(url), { params: Promise.resolve({ id: step.id }) });
    const body = normalize(await res.text());
    const got = { status: res.status, type: res.headers.get("content-type") };
    if (step.cut) return { ...got, head: normalizeSignal(body.slice(0, 300)), cut: true };
    if (body.length > 200_000) {
      const bytes = Buffer.from(body, "utf8");
      return { ...got, len: bytes.length, fnv: fnv1a64(bytes), head: body.slice(0, 300) };
    }
    return { ...got, body };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  } finally {
    process.env.PATH = path;
  }
}

// The step builders. Paths are relative to the root.
const S = [];
const G = (cwd, ...args) => S.push({ op: "git", cwd, args });
const GFAIL = (cwd, ...args) => S.push({ op: "git", cwd, args, fails: true });
const W = (path, text) => S.push({ op: "write", path, text });
const WHEX = (path, hex) => S.push({ op: "write", path, hex });
const GEN = (path, kind, n, extra) => S.push({ op: "gen", path, kind, n, ...extra });
const RM = (path) => S.push({ op: "rm", path });
const MKDIR = (path) => S.push({ op: "mkdir", path });
const LN = (path, target) => S.push({ op: "symlink", path, target });
const CHMOD = (path, mode) => S.push({ op: "chmod", path, mode });
const EXISTS = (path) => S.push({ op: "exists", path });
const WS = (list, text) => S.push({ op: "workspaces", list, ...(text != null ? { text } : {}) });
const CUST = (text) => S.push({ op: "custIndex", text });
const CUSTHEX = (hex) => S.push({ op: "custIndex", hex });
const R = (label, route, id, query = "", extra = {}) => S.push({ op: "req", label, route, id, query, ...extra });
/** `searchParams` from pairs, every value `encodeURIComponent`-ed. */
const q = (pairs) =>
  Object.entries(pairs)
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replaceAll("%24ROOT", "$ROOT")}`)
    .join("&");
const DIFF = (label, id, path, mode, extra) => R(label, "diff", id, q({ path, mode }), extra);
const SHOW = (label, id, ref, path, extra) => R(label, "show", id, q({ path, ref }), extra);
const STATUS = (label, id, extra) => R(label, "status", id, "", extra);

const unit = "line of text that is long enough for copy detection to see it\n";

// -- global config, plain dirs, the server's cwd --
W("home/.gitconfig", '[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
MKDIR("emptybin");
MKDIR("plain");
W("plain/f.txt", "outside the repos\n");
G("servercwd", "init", "-q");
W("servercwd/server-cwd.txt", "the server's cwd\n");

// -- basic: every status letter --
MKDIR("repos/basic");
G("repos/basic", "init", "-q");
W("repos/basic/a.txt", "a\n");
W("repos/basic/b.txt", "b\n");
WHEX("repos/basic/bin.dat", "780079ff00");
W("repos/basic/keep.txt", unit.repeat(8));
W("repos/basic/copy-src.txt", unit.repeat(10));
W("repos/basic/mode.sh", "#!/bin/sh\necho hi\n");
W("repos/basic/nonl.txt", "no newline");
W("repos/basic/crlf.txt", "a\r\nb\r\n");
W("repos/basic/del-staged.txt", "gone\n");
W("repos/basic/typechange.txt", "t\n");
W("repos/basic/mm.txt", "1\n");
WHEX("repos/basic/latin1.txt", "6361666509");
W("repos/basic/cr.txt", "plain\n");
W("repos/basic/ls.txt", "plain\n");
W("repos/basic/.gitignore", "ignored.log\n");
W("repos/basic/sub dir/n" + E_ACUTE + ".txt", "nested\n");
G("repos/basic", "add", "-A");
G("repos/basic", "commit", "-qm", "init");
W("repos/basic/a.txt", "a\na2\n");
G("repos/basic", "mv", "b.txt", "c.txt");
RM("repos/basic/bin.dat");
G("repos/basic", "rm", "-q", "del-staged.txt");
W("repos/basic/mm.txt", "1\n2\n");
G("repos/basic", "add", "mm.txt");
W("repos/basic/mm.txt", "1\n2\n3\n");
W("repos/basic/new-staged.txt", "fresh\n");
G("repos/basic", "add", "new-staged.txt");
W("repos/basic/am.txt", "added\n");
G("repos/basic", "add", "am.txt");
W("repos/basic/am.txt", "added\nthen modified\n");
RM("repos/basic/typechange.txt");
LN("repos/basic/typechange.txt", "a.txt");
CHMOD("repos/basic/mode.sh", "755");
W("repos/basic/nonl.txt", "no newline, still");
W("repos/basic/crlf.txt", "a\r\nB\r\n");
WHEX("repos/basic/latin1.txt", "636166e90a6e61ef76650a");
W("repos/basic/cr.txt", "plain\rBinary files are text here\n");
W("repos/basic/ls.txt", "plain" + LS + "Binary files are text here\n");
G("repos/basic", "mv", "keep.txt", "kept.txt");
G("repos/basic", "reset", "-q", "--", "keep.txt", "kept.txt");
G("repos/basic", "add", "-N", "kept.txt");
G("repos/basic", "config", "status.renames", "copies");
W("repos/basic/copy-dst.txt", unit.repeat(10));
W("repos/basic/copy-src.txt", unit.repeat(10) + "changed\n");
G("repos/basic", "add", "copy-src.txt", "copy-dst.txt");
W("repos/basic/sp ace " + E_ACUTE + ".txt", "spaced\n");
W("repos/basic/d/e/f", "deep\n");
W("repos/basic/tab\there.txt", "tab\n");
W("repos/basic/new\nline.txt", "newline\n");
W('repos/basic/quote".txt', "quote\n");
W("repos/basic/back\\slash.txt", "backslash\n");
W("repos/basic/" + NIHON + ".txt", "nihon\n");
W("repos/basic/emoji " + GRIN + ".txt", "emoji\n");
W("repos/basic/-dash.txt", "dash\n");
W("repos/basic/ignored.log", "ignored\n");
MKDIR("repos/basic/inner");
G("repos/basic/inner", "init", "-q");
W("repos/basic/inner/x", "inner repo\n");
WHEX("repos/basic/raw.bin", "00ff10e282");

// -- more repos --
MKDIR("repos/empty");
G("repos/empty", "init", "-q");
MKDIR("repos/emptydot");
G("repos/emptydot", "init", "-q", "-b", "v1.0");
MKDIR("repos/emptyls");
G("repos/emptyls", "init", "-q", "-b", "x" + LS + "y");
MKDIR("repos/emptynel");
G("repos/emptynel", "init", "-q", "-b", "a" + NEL + "b");

MKDIR("repos/branches");
G("repos/branches", "init", "-q");
W("repos/branches/f.txt", "one\n");
G("repos/branches", "add", "f.txt");
G("repos/branches", "commit", "-qm", "one");
W("repos/branches/f.txt", "two\n");
G("repos/branches", "commit", "-qam", "two");

// tracking: an upstream and a clone of it, ahead 2 / behind 1, plus a gone upstream.
MKDIR("repos/upstream");
G("repos/upstream", "init", "-q");
W("repos/upstream/u.txt", "u\n");
G("repos/upstream", "add", "u.txt");
G("repos/upstream", "commit", "-qm", "u1");
G("repos", "clone", "-q", "upstream", "tracking");
W("repos/tracking/t.txt", "t1\n");
G("repos/tracking", "add", "t.txt");
G("repos/tracking", "commit", "-qm", "t1");
W("repos/tracking/t.txt", "t2\n");
G("repos/tracking", "commit", "-qam", "t2");
W("repos/upstream/u.txt", "u2\n");
G("repos/upstream", "commit", "-qam", "u2");
G("repos/tracking", "fetch", "-q");
G("repos/tracking", "push", "-q", "origin", "HEAD:refs/heads/gonebr");
G("repos/tracking", "branch", "-q", "--track", "gonebr", "origin/gonebr");
G("repos/upstream", "branch", "-q", "-D", "gonebr");
G("repos/tracking", "fetch", "-q", "--prune");

MKDIR("repos/conflict");
G("repos/conflict", "init", "-q");
W("repos/conflict/f.txt", "base\n");
W("repos/conflict/dm.txt", "dm\n");
G("repos/conflict", "add", ".");
G("repos/conflict", "commit", "-qm", "base");
G("repos/conflict", "switch", "-q", "-c", "other");
W("repos/conflict/f.txt", "other\n");
W("repos/conflict/new.txt", "o\n");
G("repos/conflict", "rm", "-q", "dm.txt");
G("repos/conflict", "add", ".");
G("repos/conflict", "commit", "-qm", "other");
G("repos/conflict", "switch", "-q", "main");
W("repos/conflict/f.txt", "main\n");
W("repos/conflict/new.txt", "m\n");
W("repos/conflict/dm.txt", "dm2\n");
G("repos/conflict", "add", ".");
G("repos/conflict", "commit", "-qm", "main");
GFAIL("repos/conflict", "merge", "-q", "other");

MKDIR("repos/wtmain");
G("repos/wtmain", "init", "-q");
W("repos/wtmain/w.txt", "w\n");
G("repos/wtmain", "add", "w.txt");
G("repos/wtmain", "commit", "-qm", "w");
G("repos/wtmain", "worktree", "add", "-q", "../wt", "-b", "wtbr");
W("repos/wt/w.txt", "w in the worktree\n");
W("repos/wt/only-wt.txt", "untracked in the worktree\n");

MKDIR("repos/sub");
G("repos/sub", "init", "-q");
W("repos/sub/s.txt", "s\n");
G("repos/sub", "add", "s.txt");
G("repos/sub", "commit", "-qm", "s");
MKDIR("repos/sup");
G("repos/sup", "init", "-q");
W("repos/sup/t.txt", "t\n");
G("repos/sup", "add", "t.txt");
G("repos/sup", "commit", "-qm", "t");
G("repos/sup", "submodule", "add", "-q", "../sub", "sub");
G("repos/sup", "commit", "-qm", "add sub");
W("repos/sup/sub/s.txt", "s changed\n");
G("repos/sup/sub", "commit", "-qam", "s2");
W("repos/sup/sub/untracked.txt", "u\n");

MKDIR("repos/bare.git");
G("repos/bare.git", "init", "-q", "--bare");

MKDIR("repos/corrupt");
G("repos/corrupt", "init", "-q");
W("repos/corrupt/c.txt", "c\n");
G("repos/corrupt", "add", "c.txt");
G("repos/corrupt", "commit", "-qm", "c");
W("repos/corrupt/.git/index", "this is not an index file at all\n");

MKDIR("repos/textconv");
G("repos/textconv", "init", "-q");
W("repos/textconv/.gitattributes", "*.txt diff=upper\n");
G("repos/textconv", "config", "diff.upper.textconv", "tr a-z A-Z");
G("repos/textconv", "config", "color.ui", "always");
W("repos/textconv/a.txt", "lower case\n");
G("repos/textconv", "add", ".");
G("repos/textconv", "commit", "-qm", "tc");
W("repos/textconv/a.txt", "lower case, changed\n");
W("repos/textconv/new.txt", "new lower\n");

W("tools/ext.sh", '#!/bin/sh\necho "EXTERNAL $1"\n');
CHMOD("tools/ext.sh", "755");
MKDIR("repos/extdiff");
G("repos/extdiff", "init", "-q");
W("repos/extdiff/a.txt", "a\n");
G("repos/extdiff", "add", "a.txt");
G("repos/extdiff", "commit", "-qm", "a");
G("repos/extdiff", "config", "diff.external", "../../tools/ext.sh");
W("repos/extdiff/a.txt", "a changed\n");

MKDIR("repos/quotepath");
G("repos/quotepath", "init", "-q");
G("repos/quotepath", "config", "core.quotepath", "false");
W("repos/quotepath/" + NIHON + ".txt", "x\n");
G("repos/quotepath", "add", ".");
G("repos/quotepath", "commit", "-qm", "q");
W("repos/quotepath/" + NIHON + ".txt", "y\n");
W("repos/quotepath/" + E_ACUTE + ".txt", "z\n");

MKDIR("repos/large");
G("repos/large", "init", "-q");
GEN("repos/large/big.txt", "lines", 1, { tag: "aaa" });
GEN("repos/large/big3.txt", "lines", 250_000, { tag: "ddd" });
GEN("repos/large/mid.txt", "lines", 6_000, { tag: "mmm" });
GEN("repos/large/rand.bin", "bytes", 300_000, { seed: 2463534242 });
G("repos/large", "add", ".");
G("repos/large", "commit", "-qm", "large");
GEN("repos/large/big.txt", "lines", 250_000, { tag: "aaa" });
GEN("repos/large/big2.txt", "lines", 250_000, { tag: "ccc" });
GEN("repos/large/mid.txt", "lines", 6_000, { tag: "nnn" });
GEN("repos/large/mid2.txt", "lines", 3_000, { tag: "ooo" });

MKDIR("repos/trail ");
G("repos/trail ", "init", "-q");
W("repos/trail /x.txt", "x\n");
MKDIR("repos/twin");
G("repos/twin", "init", "-q");
W("repos/twin/in-twin.txt", "the trimmed twin\n");
MKDIR("repos/twin ");
G("repos/twin ", "init", "-q");
W("repos/twin /in-spaced-twin.txt", "the real one\n");
MKDIR("repos/nel" + NEL);
G("repos/nel" + NEL, "init", "-q");
W("repos/nel" + NEL + "/n.txt", "n\n");
MKDIR("links");
LN("links/basic", "../repos/basic");

// Customization mirrors.
const CUST_ROOT = "home/.claude/.claudius/customizations";
MKDIR(`${CUST_ROOT}/cust_a/src`);
G(`${CUST_ROOT}/cust_a/src`, "init", "-q");
W(`${CUST_ROOT}/cust_a/src/mirror.txt`, "mirror\n");
MKDIR(`${CUST_ROOT}/cust_c/src`);

WS([
  { id: "wks_basic", root: "repos/basic" },
  { id: "wks_nested", root: "repos/basic/d" },
  { id: "wks_link", root: "links/basic" },
  { id: "wks_dotgit", root: "repos/basic/.git" },
  { id: "wks_empty", root: "repos/empty" },
  { id: "wks_emptydot", root: "repos/emptydot" },
  { id: "wks_emptyls", root: "repos/emptyls" },
  { id: "wks_emptynel", root: "repos/emptynel" },
  { id: "wks_branches", root: "repos/branches" },
  { id: "wks_tracking", root: "repos/tracking" },
  { id: "wks_conflict", root: "repos/conflict" },
  { id: "wks_wtmain", root: "repos/wtmain" },
  { id: "wks_wt", root: "repos/wt" },
  { id: "wks_wtgitfile", root: "repos/wt/.git" },
  { id: "wks_sup", root: "repos/sup" },
  { id: "wks_sub", root: "repos/sup/sub" },
  { id: "wks_bare", root: "repos/bare.git" },
  { id: "wks_corrupt", root: "repos/corrupt" },
  { id: "wks_textconv", root: "repos/textconv" },
  { id: "wks_extdiff", root: "repos/extdiff" },
  { id: "wks_quotepath", root: "repos/quotepath" },
  { id: "wks_large", root: "repos/large" },
  { id: "wks_trail", root: "repos/trail " },
  { id: "wks_twin", root: "repos/twin " },
  { id: "wks_nel", root: "repos/nel" + NEL },
  { id: "wks_plain", root: "plain" },
  { id: "wks_file", root: "plain/f.txt" },
  { id: "wks_missing", root: "nowhere/at/all" },
  { id: "wks_emptyroot", raw: "" },
  { id: "cust_a", root: "repos/branches" },
]);

// -- status --
STATUS("basic", "wks_basic");
STATUS("unknown workspace", "wks_nope");
STATUS("nested dir: the toplevel", "wks_nested");
STATUS("through a symlink: the real path", "wks_link");
STATUS(".git dir", "wks_dotgit");
STATUS("empty repo", "wks_empty");
STATUS("empty repo, dotted branch", "wks_emptydot");
STATUS("empty repo, U+2028 branch", "wks_emptyls");
STATUS("empty repo, NEL branch", "wks_emptynel");
STATUS("branch main", "wks_branches");
for (const [label, name] of [
  ["dotted branch reads as detached", "release-1.2"],
  ["slashed branch", "feat/x"],
  ["accented branch", "f" + E_ACUTE],
  ["NBSP branch reads as detached", "a" + NBSP + "b"],
  ["NEL branch", "a" + NEL + "b"],
  ["BOM-ended branch drops the BOM", "x" + BOM],
  ["U+2028 branch", "x" + LS + "y"],
]) {
  G("repos/branches", "switch", "-q", "-c", name);
  STATUS(label, "wks_branches");
}
G("repos/branches", "checkout", "-q", "HEAD~1");
STATUS("detached HEAD", "wks_branches");
G("repos/branches", "switch", "-q", "main");
STATUS("tracking: ahead 2, behind 1", "wks_tracking");
G("repos/tracking", "switch", "-q", "gonebr");
STATUS("tracking: gone", "wks_tracking");
G("repos/tracking", "switch", "-q", "main");
STATUS("conflict", "wks_conflict");
STATUS("worktree main", "wks_wtmain");
STATUS("linked worktree", "wks_wt");
STATUS("a worktree's .git file", "wks_wtgitfile");
STATUS("superproject", "wks_sup");
STATUS("submodule", "wks_sub");
STATUS("bare repo", "wks_bare");
STATUS("corrupt index", "wks_corrupt");
STATUS("textconv + color.ui", "wks_textconv");
STATUS("quotepath false", "wks_quotepath");
STATUS("large", "wks_large");
STATUS("trailing-space root: trimmed away", "wks_trail");
STATUS("trailing-space twin: the trimmed twin", "wks_twin");
STATUS("NEL root: not trimmed", "wks_nel");
STATUS("plain dir", "wks_plain");
STATUS("a file", "wks_file");
STATUS("missing dir", "wks_missing");
STATUS("empty rootPath", "wks_emptyroot");

// -- status: customizations --
STATUS("customization, no index", "cust_a");
CUST(JSON.stringify({ version: 1, customizations: [{ id: "cust_a", name: "A", createdAt: 1, updatedAt: 1 }], publishes: [] }));
STATUS("customization mirror", "cust_a");
STATUS("customization not in the index", "cust_b");
STATUS("cust_ prefix only", "cust_");
STATUS("cust prefix without the underscore", "custom");
CUST(JSON.stringify({ version: 1, customizations: [{ id: "cust_c" }, { id: "cust_b" }], publishes: [] }));
STATUS("customization without a repo", "cust_c");
STATUS("customization without a src dir", "cust_b");
CUST('{"version":1,"customizations":[{"id":"cust_x"},null,{"id":"cust_a"}],"publishes":[]}');
STATUS("customization after a null entry", "cust_a");
STATUS("customization before a null entry", "cust_x");
CUST('{"version":1,"customizations":["cust_a",5,[],true,{"id":5},{"id":"cust_a"}],"publishes":[]}');
STATUS("customization after odd entries", "cust_a");
CUST('{"version":2,"customizations":[{"id":"cust_a"}],"publishes":[]}');
STATUS("customization index version 2", "cust_a");
CUST('{"version":1.0,"customizations":[{"id":"cust_a"}],"publishes":[]}');
STATUS("customization index version 1.0", "cust_a");
CUST('{"version":"1","customizations":[{"id":"cust_a"}],"publishes":[]}');
STATUS("customization index version string", "cust_a");
CUST('{"version":1,"customizations":[{"id":"cust_a"}]}');
STATUS("customization index without publishes", "cust_a");
CUST('{"version":1,"customizations":{"0":{"id":"cust_a"}},"publishes":[]}');
STATUS("customization index, object list", "cust_a");
CUST('{"version":1,"customizations":[{"id":"cust_a"}],"publishes":[],');
STATUS("customization index malformed", "cust_a");
CUST("null");
STATUS("customization index null", "cust_a");
CUST("[1]");
STATUS("customization index array", "cust_a");
CUST('\uFEFF{"version":1,"customizations":[{"id":"cust_a"}],"publishes":[]}');
STATUS("customization index with a BOM", "cust_a");
CUSTHEX(Buffer.from('{"version":1,"x":"\xff","customizations":[{"id":"cust_a"}],"publishes":[]}', "latin1").toString("hex"));
STATUS("customization index with a bad byte", "cust_a");
CUST('{"version":1,"x":1e400,"y":"\\ud800","customizations":[{"id":"cust_a"}],"publishes":[]}');
STATUS("customization index with 1e400 and a lone surrogate", "cust_a");
CUST('{"version":1,"customizations":[{"id":"cust_a"}],"publishes":[],"version":2}');
STATUS("customization index, duplicate version key", "cust_a");
CUST(JSON.stringify({ version: 1, customizations: [{ id: "cust_a" }], publishes: [] }));

// -- diff --
DIFF("worktree modified", "wks_basic", "a.txt", "worktree");
DIFF("staged rename, new name", "wks_basic", "c.txt", "staged");
DIFF("staged rename, old name", "wks_basic", "b.txt", "staged");
DIFF("worktree deleted binary", "wks_basic", "bin.dat", "worktree");
DIFF("staged deleted", "wks_basic", "del-staged.txt", "staged");
DIFF("worktree MM", "wks_basic", "mm.txt", "worktree");
DIFF("staged MM", "wks_basic", "mm.txt", "staged");
DIFF("staged added", "wks_basic", "new-staged.txt", "staged");
DIFF("worktree AM", "wks_basic", "am.txt", "worktree");
DIFF("mode change", "wks_basic", "mode.sh", "worktree");
DIFF("type change", "wks_basic", "typechange.txt", "worktree");
DIFF("no newline at end", "wks_basic", "nonl.txt", "worktree");
DIFF("crlf", "wks_basic", "crlf.txt", "worktree");
DIFF("latin1 bytes", "wks_basic", "latin1.txt", "worktree");
DIFF("\\r then Binary files: binary", "wks_basic", "cr.txt", "worktree");
DIFF("U+2028 then Binary files: binary", "wks_basic", "ls.txt", "worktree");
DIFF("intent-to-add rename", "wks_basic", "kept.txt", "worktree");
DIFF("staged copy", "wks_basic", "copy-dst.txt", "staged");
DIFF("unicode dir", "wks_basic", "sub dir/n" + E_ACUTE + ".txt", "worktree");
DIFF("unchanged", "wks_basic", "sub dir", "worktree");
DIFF("glob pathspec", "wks_basic", "*.txt", "worktree");
DIFF("top magic", "wks_basic", ":(top)a.txt", "worktree");
DIFF("exclude magic", "wks_basic", ":!a.txt", "worktree");
DIFF("dash path", "wks_basic", "-dash.txt", "worktree");
DIFF("double-dash path", "wks_basic", "--cached", "worktree");
DIFF("outside the repo", "wks_basic", "../../plain/f.txt", "worktree");
DIFF("absolute outside", "wks_basic", "$ROOT/plain/f.txt", "staged");
DIFF("untracked spaced unicode", "wks_basic", "sp ace " + E_ACUTE + ".txt", "untracked");
DIFF("untracked deep", "wks_basic", "d/e/f", "untracked");
DIFF("untracked tab", "wks_basic", "tab\there.txt", "untracked");
DIFF("untracked newline", "wks_basic", "new\nline.txt", "untracked");
DIFF("untracked quote", "wks_basic", 'quote".txt', "untracked");
DIFF("untracked backslash", "wks_basic", "back\\slash.txt", "untracked");
DIFF("untracked CJK", "wks_basic", NIHON + ".txt", "untracked");
DIFF("untracked emoji", "wks_basic", "emoji " + GRIN + ".txt", "untracked");
DIFF("untracked dash", "wks_basic", "-dash.txt", "untracked");
DIFF("untracked raw bytes: binary", "wks_basic", "raw.bin", "untracked");
DIFF("untracked missing: exit 1, empty", "wks_basic", "nope.txt", "untracked");
DIFF("untracked dir: exit 1, empty", "wks_basic", "d", "untracked");
DIFF("untracked tracked file", "wks_basic", "a.txt", "untracked");
DIFF("untracked ignored", "wks_basic", "ignored.log", "untracked");
DIFF("untracked outside (relative)", "wks_basic", "../../plain/f.txt", "untracked");
DIFF("untracked outside (absolute)", "wks_basic", "$ROOT/plain/f.txt", "untracked");
DIFF("untracked /dev/null", "wks_basic", "/dev/null", "untracked");
// An unreadable file: git exits 128 and its stderr is the message.
W("repos/basic/unread.txt", "secret\n");
CHMOD("repos/basic/unread.txt", "000");
DIFF("untracked unreadable: git's stderr", "wks_basic", "unread.txt", "untracked");
CHMOD("repos/basic/unread.txt", "644");
RM("repos/basic/unread.txt");
DIFF("worktree NUL", "wks_basic", "a\0b", "worktree");
DIFF("staged NUL", "wks_basic", "it's\0", "staged");
DIFF("untracked NUL", "wks_basic", "x".repeat(90) + "\n\0\n" + "y".repeat(50), "untracked");
DIFF("nested workspace", "wks_nested", "a.txt", "worktree");
DIFF("nested workspace, relative path", "wks_nested", "e/f", "untracked");
DIFF("through a symlink", "wks_link", "a.txt", "worktree");
DIFF("empty repo, staged", "wks_empty", "f.txt", "staged");
DIFF("conflict worktree", "wks_conflict", "f.txt", "worktree");
DIFF("conflict staged", "wks_conflict", "f.txt", "staged");
DIFF("conflict modify/delete", "wks_conflict", "dm.txt", "worktree");
DIFF("linked worktree", "wks_wt", "w.txt", "worktree");
DIFF("linked worktree untracked", "wks_wt", "only-wt.txt", "untracked");
DIFF("submodule", "wks_sup", "sub", "worktree");
DIFF("submodule staged", "wks_sup", "sub", "staged");
DIFF("inside the submodule", "wks_sub", "s.txt", "staged");
DIFF("textconv ignored", "wks_textconv", "a.txt", "worktree");
DIFF("textconv ignored, untracked", "wks_textconv", "new.txt", "untracked");
DIFF("diff.external runs", "wks_extdiff", "a.txt", "worktree");
DIFF("quotepath false", "wks_quotepath", NIHON + ".txt", "worktree");
DIFF("quotepath false, untracked", "wks_quotepath", E_ACUTE + ".txt", "untracked");
DIFF("corrupt index", "wks_corrupt", "c.txt", "worktree");
DIFF("corrupt index, staged", "wks_corrupt", "c.txt", "staged");
DIFF("mid diff", "wks_large", "mid.txt", "worktree");
DIFF("mid untracked", "wks_large", "mid2.txt", "untracked");
DIFF("big diff: cut", "wks_large", "big.txt", "worktree", { cut: true });
DIFF("big untracked: exited null", "wks_large", "big2.txt", "untracked");
DIFF("trailing-space root", "wks_trail", "x.txt", "untracked");
DIFF("trailing-space twin", "wks_twin", "in-twin.txt", "untracked");
DIFF("NEL root", "wks_nel", "n.txt", "untracked");
DIFF("plain dir", "wks_plain", "f.txt", "worktree");
DIFF("missing dir", "wks_missing", "f.txt", "untracked");
DIFF(".git dir", "wks_dotgit", "a.txt", "worktree");
DIFF("bare", "wks_bare", "a.txt", "staged");
DIFF("unknown workspace", "wks_nope", "a.txt", "worktree");
DIFF("customization id", "cust_a", "a.txt", "worktree");
// Parameters, raw.
R("no query", "diff", "wks_basic", "");
R("no path", "diff", "wks_basic", "mode=worktree");
R("empty path", "diff", "wks_basic", "path=&mode=worktree");
R("no mode", "diff", "wks_basic", "path=a.txt");
R("empty mode", "diff", "wks_basic", "path=a.txt&mode=");
R("upper-case mode", "diff", "wks_basic", "path=a.txt&mode=WORKTREE");
R("mode with a space", "diff", "wks_basic", "path=a.txt&mode=worktree+");
R("bad path and bad mode", "diff", "wks_basic", "mode=x");
R("plus is a space", "diff", "wks_basic", "path=sp+ace+%C3%A9.txt&mode=untracked");
R("first path wins", "diff", "wks_basic", "path=a.txt&path=c.txt&mode=worktree");
R("first mode wins", "diff", "wks_basic", "path=c.txt&mode=staged&mode=worktree");
R("malformed percent", "diff", "wks_basic", "path=%ZZ&mode=worktree");
R("bad UTF-8 percent", "diff", "wks_basic", "path=%C3&mode=untracked");
R("encoded key", "diff", "wks_basic", "%70ath=a.txt&mode=worktree");
R("empty pairs", "diff", "wks_basic", "&&path=a.txt&&mode=worktree&");
R("unknown workspace, bad params", "diff", "wks_nope", "");

// -- show --
SHOW("HEAD", "wks_basic", "HEAD", "a.txt");
SHOW("index", "wks_basic", "", "a.txt");
SHOW("index, staged MM", "wks_basic", "", "mm.txt");
SHOW("on disk, not in HEAD", "wks_basic", "HEAD", "c.txt");
SHOW("not in HEAD at all", "wks_basic", "HEAD", "nope.txt");
SHOW("not in the index", "wks_basic", "", "nope.txt");
SHOW("untracked: on disk, not in the index", "wks_basic", "", "sp ace " + E_ACUTE + ".txt");
SHOW("bad ref", "wks_basic", "nope", "a.txt");
SHOW("no parent", "wks_basic", "HEAD~1", "a.txt");
SHOW("binary blob", "wks_basic", "HEAD", "bin.dat");
SHOW("latin1 blob", "wks_basic", "HEAD", "latin1.txt");
SHOW("crlf blob", "wks_basic", "HEAD", "crlf.txt");
SHOW("tree", "wks_basic", "HEAD", ".");
SHOW("subtree", "wks_basic", "HEAD", "sub dir");
SHOW("tree peel", "wks_basic", "HEAD^{tree}", "a.txt");
SHOW("ref with a colon", "wks_basic", "HEAD:a.txt", "x");
SHOW("message search", "wks_basic", ":/init", "a.txt");
SHOW("stage 1 of a non-conflict", "wks_basic", ":1", "a.txt");
SHOW("unicode path", "wks_basic", "HEAD", "sub dir/n" + E_ACUTE + ".txt");
SHOW("dotted path", "wks_basic", "HEAD", "./a.txt");
SHOW("inner dotdot", "wks_basic", "HEAD", "sub dir/../a.txt");
SHOW("absolute path", "wks_basic", "HEAD", "/a.txt");
SHOW("dash ref: unknown option", "wks_basic", "-x", "a.txt");
SHOW("dash-dash ref: unknown option", "wks_basic", "--nope", "a.txt");
SHOW("--output ref writes a file (refused in Rust)", "wks_basic", "--output=$ROOT/pwned", "a.txt");
EXISTS("pwned:a.txt");
SHOW("--format ref shows HEAD (refused in Rust)", "wks_basic", "--format=%s", "a.txt");
SHOW("lone dash ref", "wks_basic", "-", "a.txt");
SHOW("NUL ref", "wks_basic", "a\0", "a.txt");
SHOW("NUL ref, long", "wks_basic", "q\"'\0" + "r".repeat(130), "a.txt");
SHOW("dotdot path", "wks_basic", "HEAD", "../x");
SHOW("dotdot-prefixed name", "wks_basic", "HEAD", "..x");
SHOW("NUL path", "wks_basic", "HEAD", "a\0");
SHOW("nested workspace", "wks_nested", "HEAD", "a.txt");
SHOW("empty repo HEAD", "wks_empty", "HEAD", "f.txt");
SHOW("conflict, index", "wks_conflict", "", "f.txt");
SHOW("conflict, stage 1", "wks_conflict", ":1", "f.txt");
SHOW("conflict, stage 3", "wks_conflict", ":3", "f.txt");
SHOW("conflict, HEAD", "wks_conflict", "HEAD", "dm.txt");
SHOW("linked worktree", "wks_wt", "HEAD", "w.txt");
SHOW("other branch from a worktree", "wks_wt", "main", "w.txt");
SHOW("submodule gitlink", "wks_sup", "HEAD", "sub");
SHOW("submodule .gitmodules", "wks_sup", "HEAD", ".gitmodules");
SHOW("inside the submodule", "wks_sub", "HEAD", "s.txt");
SHOW("textconv not applied", "wks_textconv", "HEAD", "a.txt");
SHOW("corrupt index, HEAD", "wks_corrupt", "HEAD", "c.txt");
SHOW("corrupt index, index", "wks_corrupt", "", "c.txt");
SHOW("quotepath false", "wks_quotepath", "HEAD", NIHON + ".txt");
SHOW("mid blob", "wks_large", "HEAD", "mid.txt");
SHOW("random bytes", "wks_large", "HEAD", "rand.bin");
SHOW("big blob: cut", "wks_large", "HEAD", "big3.txt", { cut: true });
SHOW("trailing-space root", "wks_trail", "HEAD", "x.txt");
SHOW("plain dir", "wks_plain", "HEAD", "f.txt");
SHOW("unknown workspace", "wks_nope", "HEAD", "a.txt");
R("no query", "show", "wks_basic", "");
R("no path", "show", "wks_basic", "ref=HEAD");
R("empty path", "show", "wks_basic", "path=&ref=HEAD");
R("no ref", "show", "wks_basic", "path=a.txt");
R("no ref, dotdot path", "show", "wks_basic", "path=../x");
R("dotdot path, no ref check first", "show", "wks_basic", "path=..&ref=HEAD");
R("plus in ref", "show", "wks_basic", "path=a.txt&ref=HEAD+");
R("first ref wins", "show", "wks_basic", "path=a.txt&ref=&ref=HEAD");

// -- after changes --
W("repos/empty/f.txt", "first\n");
STATUS("empty repo, untracked", "wks_empty");
G("repos/empty", "add", "f.txt");
STATUS("empty repo, staged", "wks_empty");
DIFF("empty repo, staged file", "wks_empty", "f.txt", "staged");
DIFF("empty repo, worktree file", "wks_empty", "f.txt", "worktree");
SHOW("empty repo, index", "wks_empty", "", "f.txt");
G("repos/empty", "commit", "-qm", "first");
STATUS("empty repo, first commit", "wks_empty");
SHOW("empty repo, now HEAD", "wks_empty", "HEAD", "f.txt");

// -- git missing (PATH at an empty dir) --
STATUS("no git: status", "wks_basic", { nogit: true });
STATUS("no git: status, plain dir", "wks_plain", { nogit: true });
STATUS("no git: status, customization", "cust_a", { nogit: true });
DIFF("no git: diff", "wks_basic", "a.txt", "worktree", { nogit: true });
DIFF("no git: untracked diff", "wks_basic", "d/e/f", "untracked", { nogit: true });
SHOW("no git: show", "wks_basic", "HEAD", "a.txt", { nogit: true });
R("no git: bad params still 400", "diff", "wks_basic", "path=a.txt", { nogit: true });

// -- a workspaces.json that doesn't parse: getWorkspace throws --
WS([], "{ not json");
STATUS("broken store", "wks_basic");
DIFF("broken store", "wks_basic", "a.txt", "worktree");
SHOW("broken store", "wks_basic", "HEAD", "a.txt");
STATUS("broken store, customization", "cust_a");
WS([], JSON.stringify({ version: 2, workspaces: "nope" }));
STATUS("store from another version", "wks_basic");
RM("home/.claude/.claudius/workspaces.json");
STATUS("no store", "wks_basic");

// The server's own cwd, where an empty rootPath runs git (`cwd: ""` is no cwd).
mkdirSync(join(ROOT, "servercwd"), { recursive: true });
process.chdir(join(ROOT, "servercwd"));
for (const step of S) {
  if (step.op === "req") {
    step.got = await request(step);
  } else {
    exec(step);
  }
  steps.push(step);
}

const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
const fixture = {
  gitVersion,
  env: ENV,
  parsers: { headers, porcelain, binary, missing, inspect },
  steps,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
const reqs = steps.filter((s) => s.op === "req");
console.log(
  `wrote ${out.slice(repo.length + 1)}: ${headers.length} headers, ${porcelain.length} porcelain, ${TEXTS.length} texts, ${inspect.length} inspect; ${steps.length} steps (${reqs.length} requests) on ${gitVersion}`,
);
process.exit(0);
