#!/usr/bin/env node
// Golden fixture for D04: `GET/POST /api/fs/dirs`, `GET /api/fs/list` and
// `lib/server/fs-list.ts`, recorded from the real TS sources:
//
//   node rust/scripts/fs-list-golden.mjs      (node@22)
//
// Re-runs itself under `--experimental-transform-types` with the repo as its
// cwd, HOME and CLAUDE_CONFIG_DIR in a temp dir (no LANG, so ICU collates
// for en-US), and a resolve hook for the `@/` imports. Four parts:
// * `collate`: `a.localeCompare(b)` over a matrix of hand-picked strings,
//   seeded random pairs, and stable sorts of name lists with ties.
// * `paths`: node's `path.resolve` / `normalize` / `join` / `relative` /
//   `dirname` / `isAbsolute` (posix), with `process.cwd()` at `/`.
// * `tcc`: `categorizeTccPath` and `isHiddenHomeSubpath` over a grid of
//   inputs, for darwin, linux and win32.
// * `scenarios`: temp trees under the temp root (`@@ROOT@@` in the fixture:
//   `home` is HOME, `w` the usual work tree, `out` a sibling outside it).
//   `ops` builds the tree (each with `ok`: an op that failed here, such as a
//   name that only differs by case on a case-folding disk, is skipped on
//   replay); `env` is CLAUDIUS_FS_ROOT (`null` = unset, read when the dirs
//   route module loads), `cwd` the process cwd (the trusted root fs/list
//   falls back to). The steps run in order against the real route handlers,
//   once with `process.platform` as darwin and once as linux, each on a
//   fresh tree: `got` (an index into the scenario's `gots`) is the status,
//   content type and body text (a body over 40 000 chars as its length,
//   FNV-1a 64 and head), or `threw` (Next's empty 500). A 200 from fs/list
//   also records the `listFs` arguments the route passed (`args`: the
//   trusted cwd, `q`, `limit`). `snap` is the tree afterwards.
//   `needs` names what the replay's disk must share with this one: `fold`
//   (case- and normalization-insensitive names), `perm` (permissions
//   enforced, i.e. not root) and `uchg` (BSD immutable flags, `chflags`);
//   `fs` records all three for this disk.
//
// Written to rust/crates/claudius-core/tests/fixtures/fs_list_golden.json;
// replayed by crates/claudius-core/tests/fs_list_golden.rs (collate, paths,
// tcc, and the fs/list steps through `list_fs_in`) and
// crates/claudius-server/tests/fs_routes.rs (every step, on the real binary
// for this platform and in process for both).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
// `FS_GOLDEN_OUT` writes elsewhere (to compare two runs without touching the fixture).
const out = process.env.FS_GOLDEN_OUT || join(rustDir, "crates/claudius-core/tests/fixtures/fs_list_golden.json");

/** chmod u+rwx every directory under `dir` (lstat, so links aren't followed). */
function restorePerms(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(dir, 0o755);
  } catch {
    // best effort
  }
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) restorePerms(join(dir, n));
}

if (!process.env.FS_GOLDEN_CHILD) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fs-list-golden-")));
  let status = 1;
  try {
    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
      {
        cwd: repo,
        stdio: "inherit",
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: join(root, "config"),
          FS_GOLDEN_CHILD: "1",
          FS_GOLDEN_ROOT: root,
          ...(process.env.FS_GOLDEN_OUT ? { FS_GOLDEN_OUT: process.env.FS_GOLDEN_OUT } : {}),
        },
      },
    );
    status = r.status ?? 1;
  } finally {
    spawnSync("chflags", ["-R", "nouchg", root]);
    restorePerms(root);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(status);
}

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

const ROOT = process.env.FS_GOLDEN_ROOT;
const PH = "@@ROOT@@";
const sub = (s) => s.split(PH).join(ROOT);
const unsub = (s) => s.split(ROOT).join(PH);

const path = await import("node:path");
const tcc = await import(join(repo, "lib/shared/tcc-protected.ts"));
const { __resetTrustedCwdCache, resolveTrustedCwd } = await import(join(repo, "lib/server/trusted-cwd.ts"));
const listRoute = await import(join(repo, "app/api/fs/list/route.ts"));
const dirsUrl = pathToFileURL(join(repo, "app/api/fs/dirs/route.ts")).href;

// Deterministic, so two runs write the same fixture.
let seed = 0x5eed;
const rnd = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const POOLS = [
  [0x21, 0x7e], [0x21, 0x7e], [0x21, 0x7e], [0x30, 0x39], [0x41, 0x5a], [0x61, 0x7a],
  [0xa0, 0x24f], [0x300, 0x36f], [0x370, 0x3ff], [0x400, 0x4ff], [0x590, 0x6ff],
  [0x900, 0x97f], [0xe00, 0xe7f], [0x1e00, 0x1eff], [0x2000, 0x206f], [0x3040, 0x30ff],
  [0x4e00, 0x4e80], [0xac00, 0xac80], [0x1f300, 0x1f6ff], [0x1, 0x1f], [0xff00, 0xffef],
  [0x10000, 0x1007f], [0x1f900, 0x1faff],
];
/** 1-6 code points from mixed scripts; no `/`, NUL or surrogate. */
function randomName() {
  const n = 1 + Math.floor(rnd() * 6);
  let s = "";
  for (let i = 0; i < n; i++) {
    const [lo, hi] = pick(POOLS);
    let cp = lo + Math.floor(rnd() * (hi - lo + 1));
    if (cp === 0x2f || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0x5f;
    s += String.fromCodePoint(cp);
  }
  return s;
}

// --------------------------------------------------------------- collate

const CMP_BASE = [
  "a", "A", "b", "B", "\u00e9", "e\u0301", "E", "\u00e4", "a\u0308", "\u00df", "ss", "\u00e6", "ae",
  "\u00c5", "\u212b", "\u03a9", "\u03c9", "\u03c2", "\u03c3", "10", "9", "_", "-", " ", "~", "a b",
  "a_b", "a-b", "\u00c5B", "Zed", "zed", "\u01c5", "\u01c6", "\u01c4", "\ufb01", "fi", "\u2163",
  "iv", "\u2460", "1", "\u4e00", "\u4e01", "\uac00", "\u30a2", "\u3042", "\ud83d\ude00",
  "\ud83d\ude01", "a\u0000", "a\u0001b", "ab", "\u200b", "a\u200bb", "", "  ", "a\t", "\u00a0",
  "#", "$", "%", "&", "'", "(", "*", "+", ",", ".", ":", ";", "<", "=", ">", "?", "@", "[",
  "\\", "]", "^", "`", "{", "|", "}", "\"", "!", "0", "00", "0a", "a0", "Ab", "aB", "AB",
  "\u0131", "I", "\u0130", "i", "\u0142", "l", "\u00f8", "o", "\u00fe", "th", "\u0111", "d",
];
const sign = (n) => (n < 0 ? "-" : n > 0 ? "+" : "0");
const collate = {
  base: CMP_BASE,
  // matrix[i][j] = sign(base[i].localeCompare(base[j]))
  matrix: CMP_BASE.map((a) => CMP_BASE.map((b) => sign(a.localeCompare(b))).join("")),
  pairs: [],
  sorts: [],
};
for (let i = 0; i < 1500; i++) {
  const a = randomName();
  const b = rnd() < 0.5 ? randomName() : Array.from(a).slice(0, -1).join("") + Array.from(randomName())[0];
  collate.pairs.push([a, b, sign(a.localeCompare(b))]);
}
const sortInputs = [
  CMP_BASE,
  ["a\u0001", "a", "a\u200b", "a\u0002", "A", "\u00e1", "a\u0000"],
  Array.from({ length: 120 }, randomName),
  ["file10", "file9", "file1", "File1", "file01", "file_1", "file-1", "file 1", "file.1"],
];
for (const input of sortInputs) {
  collate.sorts.push({ input, sorted: [...input].sort((x, y) => x.localeCompare(y)) });
}

// ----------------------------------------------------------------- paths

process.chdir("/");
const SEGS = ["a", "b", "c", ".", "..", "", "...", "..a", "a..", ".a", "/", "//", "\u00e9", "\ud83d\ude00", "~", "a b", "a\\b"];
function randomPath(abs) {
  const n = 1 + Math.floor(rnd() * 5);
  const parts = Array.from({ length: n }, () => pick(SEGS));
  return (abs ? "/" : "") + parts.join(rnd() < 0.8 ? "/" : "//");
}
const PATHS = [
  "", "/", "//", "///", ".", "..", "./", "../", "a", "a/", "/a", "/a/", "a//b", "/a/b/..", "/a/b/../..",
  "/a/b/../../..", "a/b/../../..", "../a/..", "/a/./b/.", "/..a", "/a..", "/...", "/a/...", "/a/b/...",
  "/a/.../..", "./a", "a/.", "/.", "/./", "..//..", "/a//b//", "~", "~/x", "/x/~/y", "\u00e9/..",
];
for (let i = 0; i < 160; i++) PATHS.push(randomPath(rnd() < 0.6));
const paths = {
  resolve: [],
  normalize: PATHS.map((p) => [p, path.normalize(p)]),
  join: [],
  relative: [],
  dirname: PATHS.map((p) => [p, path.dirname(p)]),
  isAbsolute: PATHS.map((p) => [p, path.isAbsolute(p)]),
};
const RESOLVE_ARGS = [
  [], [""], ["", ""], ["/a", ""], ["", "/a"], ["/a", "b"], ["/a", "/b"], ["/a", "..", "..", "c"],
  ["a", "b", "/c", "d"], ["/x", "~"], ["/x", "~/y"], ["/a/..b", "c"], ["/a/...", ".."], ["/a/b.", "..."],
  ["/caf\u00e9/\u00e9", ".."], ["/a\\b", ".."], ["/a/b/c", "../../../../.."], ["/w", "x\u0000y"],
];
for (const p of PATHS) RESOLVE_ARGS.push([p]);
for (let i = 0; i < 120; i++) RESOLVE_ARGS.push([randomPath(true), randomPath(rnd() < 0.3)]);
paths.resolve = RESOLVE_ARGS.map((a) => [a, path.resolve(...a)]);
for (let i = 0; i < 120; i++) {
  const a = Array.from({ length: Math.floor(rnd() * 4) }, () => randomPath(rnd() < 0.4));
  paths.join.push([a, path.join(...a)]);
}
const REL = [
  ["/a", "/a"], ["/a", "/a/b"], ["/a/b", "/a"], ["/", "/a"], ["/a", "/"], ["/a/b", "/a/c"],
  ["/ab", "/a"], ["/a", "/ab"], ["/a/b/c", "/x/y"], ["/home/u", "/home/u/Library/Containers"],
  ["/home/u", "/home/v/x"], ["a", "b"], ["", "/a"], ["/a/", "/a/b/"], ["/a/\u00e9", "/a/e\u0301"],
];
for (let i = 0; i < 160; i++) REL.push([randomPath(rnd() < 0.8), randomPath(rnd() < 0.8)]);
paths.relative = REL.map(([f, t]) => [f, t, path.relative(f, t)]);
process.chdir(repo);

// ------------------------------------------------------------------- tcc

const ABS = [
  "", "/", "/Users/me", "/Users/me/", "/Users/me/Desktop", "/Users/me/Desktop/", "/Users/me/Desktop/a/b",
  "/Users/me/desktop", "/Users/me/Desktopx", "/Users/me//Desktop", "/Users/meDesktop", "/Users/me/Library/Containers",
  "/Users/me/Documents", "/Users/me/Downloads/x", "/Users/me/Movies", "/Users/me/Music", "/Users/me/Pictures",
  "/Users/me/Public", "/Users/other/Desktop", "/Desktop", "Desktop", "/Users/me/./Desktop", "/Users/me/Desktop\\x",
];
const HOMES = ["", "/", "/Users/me", "/Users/me/", "/Users/me//", "/Users", "Users/me"];
const PLATFORMS = ["darwin", "linux", "win32"];
const RELS = [
  "", "Library", "Library/Containers", "Library/Containers/", "Library/Containers/x", "Library/Group Containers",
  "Library/Group Containers/y", "Library\\Containers", "Library\\Group Containers\\z", "library/containers",
  "Library/ContainersX", "Library/Containers2/x", "/Library/Containers", "../Library/Containers",
  "x/Library/Containers", "Library/Group  Containers", "Library//Containers",
];
const tccCases = { categorize: [], hidden: [] };
for (const p of PLATFORMS) {
  for (const h of HOMES) for (const a of ABS) tccCases.categorize.push([a, h, p, tcc.categorizeTccPath(a, h, p)]);
  for (const r of RELS) tccCases.hidden.push([r, p, tcc.isHiddenHomeSubpath(r, p)]);
}

// -------------------------------------------------------------- the disk

function probeDisk() {
  const p = join(ROOT, "probe");
  rmSync(p, { recursive: true, force: true });
  mkdirSync(join(p, "Ab\u00e9"), { recursive: true });
  const fold = existsSync(join(p, "aB" + "e\u0301"));
  mkdirSync(join(p, "locked"));
  chmodSync(join(p, "locked"), 0o000);
  let perm = false;
  try {
    readdirSync(join(p, "locked"));
  } catch {
    perm = true;
  }
  chmodSync(join(p, "locked"), 0o755);
  // BSD file flags (macOS): an immutable folder refuses mkdir with EPERM.
  mkdirSync(join(p, "frozen"));
  const uchg = spawnSync("chflags", ["uchg", join(p, "frozen")]).status === 0;
  if (uchg) spawnSync("chflags", ["nouchg", join(p, "frozen")]);
  rmSync(p, { recursive: true, force: true });
  return { fold, perm, uchg };
}

function resetDisk() {
  spawnSync("chflags", ["-R", "nouchg", ROOT]);
  restorePerms(ROOT);
  for (const n of readdirSync(ROOT)) {
    if (n !== "config") rmSync(join(ROOT, n), { recursive: true, force: true });
  }
  for (const d of ["home", "w", "out", "config"]) mkdirSync(join(ROOT, d), { recursive: true });
}

/** One op: `[kind, rel, arg]`, `rel` relative to the root. */
function runOp([kind, rel, arg]) {
  const p = join(ROOT, rel);
  switch (kind) {
    case "dir":
      mkdirSync(p);
      break;
    case "file":
      writeFileSync(p, sub(arg ?? ""), { flag: "wx" });
      break;
    case "link":
      symlinkSync(sub(arg), p);
      break;
    case "fifo": {
      const r = spawnSync("mkfifo", [p]);
      if (r.status !== 0) throw new Error("mkfifo failed");
      break;
    }
    case "chmod":
      chmodSync(p, arg);
      break;
    case "uchg":
      if (spawnSync("chflags", ["uchg", p]).status !== 0) throw new Error("chflags failed");
      break;
    case "files":
      // `arg` files named f0000, f0001, ...
      for (let i = 0; i < arg; i++) writeFileSync(join(p, "f" + String(i).padStart(4, "0")), "");
      break;
    default:
      throw new Error("unknown op " + kind);
  }
}

/**
 * Every path under w / out: `rel/` (dir), `rel` (file), `rel -> target`,
 * `rel |` (other), `rel !` (unreadable dir), `rel ?` (can't lstat).
 */
function snapshot() {
  const outList = [];
  const walk = (rel) => {
    let names;
    try {
      names = readdirSync(join(ROOT, rel));
    } catch {
      outList.push(rel + " !");
      return;
    }
    for (const n of names) {
      const r = rel + "/" + n;
      let st;
      try {
        st = lstatSync(join(ROOT, r));
      } catch {
        outList.push(r + " ?");
        continue;
      }
      if (st.isSymbolicLink()) outList.push(r + " -> " + unsub(readlinkSync(join(ROOT, r))));
      else if (st.isDirectory()) {
        outList.push(r + "/");
        walk(r);
      } else if (st.isFile()) outList.push(r);
      else outList.push(r + " |");
    }
  };
  for (const top of ["w", "out"]) walk(top);
  return outList;
}

function fnv1a64(text) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(text, "utf8")) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

// ------------------------------------------------------------- scenarios

const G = (label, query) => ({ label, route: "dirs", method: "GET", query });
const P = (label, body) => ({ label, route: "dirs", method: "POST", body });
const J = (label, obj) => P(label, JSON.stringify(obj));
const L = (label, query) => ({ label, route: "list", method: "GET", query });
const dirs = (...rels) => rels.map((r) => ["dir", r]);

const PICKER_NAMES = [
  "alpha", "Beta", "gamma", "_under", "~tilde", "10", "9", "a b", "a+b", "a-b", "a_b", "caf\u00e9",
  "e\u0301clair", "\u00c5ngstr\u00f6m", "\u212bx", "\u03a3\u03bf\u03c6\u03af\u03b1", "\u4e00\u4e8c",
  "\ud83d\ude00smile", "a\u0001", "a\u200b", "a", "A", "zed", "Zed", "ZED2", "x\ttab", "quote\"d",
  "back\\slash", "new\nline", "percent%41", "hash#", "amp&er", "eq=al", "q?mark", "  lead", "trail  ",
  " ", "~", "\u00a0nbsp",
];
const MANY = Array.from({ length: 150 }, randomName);
// Completely ignorable in the root collation (controls, U+200B..D, U+2060).
const TIE_MARKS = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127].map((c) =>
    String.fromCharCode(c),
  ),
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\u0001\u0002",
];

const SCENARIOS = [
  {
    name: "picker",
    env: `${PH}/w`,
    cwd: "w",
    snap: true,
    ops: [
      ...PICKER_NAMES.map((n) => ["dir", `w/${n}`]),
      ...dirs("w/node_modules", "w/dist", "w/build", "w/coverage", "w/.git", "w/.DS_Store", "w/.next", "w/.turbo"),
      ...dirs("w/.cache", "w/.hidden", "w/..foo", "w/...", "w/~/inner", "w/alpha/one", "w/alpha/two", "w/alpha/.dot"),
      ...dirs("w/deep", "w/deep/a", "w/deep/a/b", "w/Beta/b1x", "w/wx-not-root"),
      ["file", "w/file.txt", "hello"],
      ["file", "w/Readme.md", ""],
      ["link", "w/link-in", "alpha"],
      ["link", "w/link-out", "../out"],
      ["link", "w/link-abs", `${PH}/out`],
      ["link", "w/dangling", "nowhere"],
      ["link", "w/loop", "loop"],
      ["link", "w/link-file", "file.txt"],
      ["link", "w/node_modules/inner-link", "../alpha"],
      ["fifo", "w/pipe"],
      ...dirs("w/Desktop", "w/Desktop/proj", "w/Documents", "w/Downloads", "w/Movies", "w/Music", "w/Pictures"),
      ...dirs("w/desktop2", "w/Public", "w/Library", "w/Library/Containers", "w/Library/Containers/app"),
      ...dirs("w/Library/Group Containers", "w/Library/ContainersX", "w/Library/Caches", "w/Library/Caches/c"),
      ...dirs("w/many", ...MANY.map((n) => `w/many/${n}`)),
      ...dirs("out/o1", "out/o2", "out/.o3"),
      ["file", "out/of", ""],
      ...dirs("wx", "wx/inside"),
    ],
    steps: [
      G("root, no query", null),
      G("empty path", "path="),
      G("path key without =", "path"),
      G("other key case", "Path=alpha"),
      G("dot", "path=."),
      G("dotdot", "path=.."),
      G("relative escape", "path=../out"),
      G("absolute outside", `path=${PH}/out`),
      G("filesystem root", "path=/"),
      G("etc", "path=/etc"),
      G("absolute root", `path=${PH}/w`),
      G("absolute root, trailing slash", `path=${PH}/w/`),
      G("absolute, collapsing", `path=${PH}/w/alpha/..`),
      G("absolute via parent", `path=${PH}/w/../w/alpha`),
      G("prefix sibling", `path=${PH}/wx`),
      G("prefix sibling child", `path=${PH}/wx/inside`),
      G("relative child", "path=alpha"),
      G("relative climb out", "path=alpha/../.."),
      G("dot segments", "path=./alpha/./one"),
      G("tilde dir", "path=~"),
      G("tilde inner", "path=~/inner"),
      G("tilde-prefixed", "path=~tilde"),
      G("symlink in", "path=link-in"),
      G("symlink out (escape)", "path=link-out"),
      G("symlink absolute out", "path=link-abs"),
      G("dangling symlink", "path=dangling"),
      G("symlink loop", "path=loop"),
      G("symlink to file", "path=link-file"),
      G("file", "path=file.txt"),
      G("fifo", "path=pipe"),
      G("missing", "path=missing"),
      G("nul", "path=%00"),
      G("nul inside", "path=a%00b"),
      G("plus is space", "path=a+b"),
      G("encoded plus", "path=a%2Bb"),
      G("encoded unicode", "path=caf%C3%A9"),
      G("nfd name", "path=e%CC%81clair"),
      G("invalid utf-8", "path=%FF"),
      G("malformed percent", "path=%zz"),
      G("first of two", "path=alpha&path=Beta"),
      G("encoded dotdot", "path=%2e%2e"),
      G("encoded slash", "path=%2Fetc"),
      G("encoded inner slash", "path=alpha%2Fone"),
      G("too long", "path=" + "x".repeat(5000)),
      G("leading spaces", "path=%20%20lead"),
      G("newline name", "path=new%0Aline"),
      G("quote name", "path=quote%22d"),
      G("control name", "path=a%01"),
      G("dot-dot-name", "path=..foo"),
      G("three dots", "path=..."),
      G("hidden but navigable", "path=node_modules"),
      G("dot dir navigable", "path=.git"),
      G("big sort", "path=many"),
      G("tcc desktop", "path=Desktop"),
      G("tcc desktop ack", "path=Desktop&ack=1"),
      G("tcc ack=0", "path=Desktop&ack=0"),
      G("tcc ack=true", "path=Desktop&ack=true"),
      G("tcc ack first wins", "path=Desktop&ack=1&ack=0"),
      G("tcc ack first loses", "path=Desktop&ack=0&ack=1"),
      G("tcc ack before path", "ack=1&path=Desktop"),
      G("tcc child", "path=Desktop/proj"),
      G("tcc child ack", "path=Desktop/proj&ack=1"),
      G("tcc missing ack", "path=Desktop/missing&ack=1"),
      G("tcc missing", "path=Desktop/missing"),
      G("tcc documents", "path=Documents"),
      G("tcc downloads", "path=Downloads"),
      G("tcc movies", "path=Movies"),
      G("tcc music", "path=Music"),
      G("tcc pictures", "path=Pictures"),
      G("not tcc", "path=desktop2"),
      G("public", "path=Public"),
      G("tcc absolute", `path=${PH}/w/Desktop`),
      G("tcc collapsed away", `path=${PH}/w/Desktop/../alpha`),
      G("library", "path=Library"),
      G("containers", "path=Library/Containers"),
      G("containers ack", "path=Library/Containers&ack=1"),
      G("containers child", "path=Library/Containers/app"),
      G("group containers", "path=Library/Group%20Containers"),
      G("group containers plus", "path=Library/Group+Containers"),
      G("containers-ish", "path=Library/ContainersX"),
      G("containers collapsed", "path=Library/Containers/../Caches"),
      G("containers trailing slash", "path=Library/Containers/"),
      G("containers double slash", "path=Library//Containers"),
    ],
  },
  {
    name: "create",
    env: `${PH}/w`,
    cwd: "w",
    snap: true,
    ops: [
      ...dirs("w/alpha", "w/Beta", "w/caf\u00e9", "w/Desktop", "w/Library", "w/Library/Containers", "w/~", "w/..foo"),
      ["file", "w/file.txt", ""],
      ["link", "w/dangling", "nowhere"],
      ["link", "w/link-in", "alpha"],
      ["link", "w/link-out", "../out"],
      ["link", "w/link-file", "file.txt"],
      ["fifo", "w/pipe"],
      ...dirs("wx"),
    ],
    steps: [
      P("empty body", ""),
      P("open brace", "{"),
      P("nul literal typo", "nul"),
      P("trailing garbage", "{} x"),
      P("bom object", "\ufeff{}"),
      P("two boms", "\ufeff\ufeff{\"name\":\"bom2\"}"),
      P("null body", "null"),
      P("number body", "5"),
      P("string body", "\"str\""),
      P("array body", "[]"),
      P("empty object", "{}"),
      J("blank name", { name: "  " }),
      J("empty name", { name: "" }),
      J("null name", { name: null }),
      J("slash name", { name: "a/b" }),
      J("backslash name", { name: "a\\b" }),
      J("nul name", { name: "x\u0000y" }),
      J("dot name", { name: "." }),
      J("dotdot name", { name: ".." }),
      J("padded dotdot", { name: " .. " }),
      J("create", { name: "new1" }),
      J("create again", { name: "new1" }),
      J("trimmed", { name: " new2 " }),
      J("js trim set", { name: "\u00a0new3\u2028" }),
      J("nel kept", { name: "\u0085x" }),
      J("bom trimmed", { name: "\ufeffy" }),
      J("over a file", { name: "file.txt" }),
      J("over a dangling link", { name: "dangling" }),
      J("over a link", { name: "link-in" }),
      J("three dots", { name: "...", parent: "alpha" }),
      J("relative parent", { parent: "alpha", name: "sub" }),
      J("absolute parent", { parent: `${PH}/w/alpha`, name: "sub2" }),
      J("root parent, trailing slash", { parent: `${PH}/w/`, name: "top" }),
      J("parent collapses", { parent: "./alpha/../Beta", name: "b1" }),
      J("parent dotdot", { parent: "..", name: "x" }),
      J("parent slash", { parent: "/", name: "x" }),
      J("parent outside", { parent: `${PH}/out`, name: "x" }),
      J("parent prefix sibling", { parent: `${PH}/wx`, name: "x" }),
      J("parent ..foo", { parent: "..foo", name: "x" }),
      J("parent ... (missing)", { parent: "...", name: "x" }),
      J("parent through ..foo", { parent: "..foo/../alpha", name: "via" }),
      J("parent missing", { parent: "missing", name: "x" }),
      J("parent file", { parent: "file.txt", name: "x" }),
      J("parent dangling", { parent: "dangling", name: "x" }),
      J("parent link to file", { parent: "link-file", name: "x" }),
      J("parent fifo", { parent: "pipe", name: "x" }),
      J("through escape link", { parent: "link-out", name: "made-outside" }),
      J("number parent", { parent: 5, name: "x" }),
      J("bool parent", { parent: true, name: "x" }),
      J("object parent", { parent: {}, name: "x" }),
      J("array parent", { parent: [], name: "x" }),
      J("null parent", { parent: null, name: "nullparent" }),
      J("empty parent", { parent: "", name: "emptyparent" }),
      J("number name", { name: 5 }),
      J("bool name", { name: true }),
      J("array name", { name: [] }),
      J("object name", { name: {} }),
      J("outside parent wins over bad name", { parent: "/etc", name: 5 }),
      J("bad parent wins over bad name", { parent: 5, name: 5 }),
      P("overflowing name", "{\"name\":1e400}"),
      P("overflowing parent", "{\"parent\":1e400,\"name\":\"x\"}"),
      P("overflow elsewhere", "{\"x\":-1e400,\"name\":\"big\"}"),
      P("duplicate key", "{\"name\":\"dup1\",\"name\":\"dup2\"}"),
      P("lone surrogate", "{\"name\":\"\\ud800\"}"),
      P("surrogate pair escape", "{\"name\":\"\\ud83d\\ude00ok\"}"),
      { label: "invalid utf-8 byte", route: "dirs", method: "POST", bodyHex: "7b226e616d65223a22ff227d" },
      J("too long", { name: "x".repeat(300) }),
      J("tcc parent, no gate", { parent: "Desktop", name: "tccmade" }),
      J("hidden parent, no gate", { parent: "Library/Containers", name: "hid" }),
      J("tilde parent", { parent: "~", name: "t" }),
      J("unicode name", { name: "\u4e2d\u6587 \ud83d\ude00" }),
      J("control name", { name: "a\u0001b" }),
      P("proto key", "{\"__proto__\":{\"name\":\"evil\"},\"name\":\"proto-ok\"}"),
      G("root after creates", null),
      G("escape link after", "path=link-out"),
    ],
  },
  {
    name: "fold",
    needs: ["fold"],
    env: `${PH}/w`,
    cwd: "w",
    snap: true,
    ops: [
      ...dirs("w/alpha", "w/caf\u00e9", "w/Desktop", "w/Library", "w/Library/Containers", "w/Library/Containers/x"),
      ...dirs("w/A", "w/a"),
    ],
    steps: [
      G("upper-case lookup", "path=ALPHA"),
      G("nfd lookup", "path=cafe%CC%81"),
      G("tcc by other case", "path=desktop"),
      G("tcc by upper case", "path=DESKTOP/../Desktop"),
      G("containers by other case", "path=Library/containers"),
      G("library by other case", "path=LIBRARY/Containers"),
      J("mkdir other case", { name: "ALPHA" }),
      J("mkdir nfd", { name: "cafe\u0301" }),
      J("mkdir under other case", { parent: "ALPHA", name: "in" }),
      G("root after", null),
      L("walk", null),
    ],
  },
  {
    name: "perms",
    needs: ["perm"],
    env: `${PH}/w`,
    cwd: "w",
    snap: true,
    ops: [
      ...dirs("w/locked", "w/locked/inner", "w/noread", "w/noread/x", "w/readonly", "w/readonly/existing"),
      ...dirs("w/noexec", "w/noexec/child", "w/open"),
      ["file", "w/noexec/f", ""],
      ["chmod", "w/locked", 0o000],
      ["chmod", "w/noread", 0o333],
      ["chmod", "w/readonly", 0o555],
      ["chmod", "w/noexec", 0o666],
    ],
    steps: [
      G("locked", "path=locked"),
      G("inside locked", "path=locked/inner"),
      G("no read", "path=noread"),
      G("inside no read", "path=noread/x"),
      G("no exec lists", "path=noexec"),
      G("inside no exec", "path=noexec/child"),
      G("root", null),
      L("walk skips unreadable", null),
      L("walk query", "q=e"),
      J("into read-only", { parent: "readonly", name: "x" }),
      J("existing in read-only", { parent: "readonly", name: "existing" }),
      J("into locked", { parent: "locked", name: "x" }),
      J("under locked", { parent: "locked/inner", name: "x" }),
      J("into no exec", { parent: "noexec", name: "x" }),
      J("into no read", { parent: "noread", name: "y" }),
    ],
  },
  {
    // CC 2.1.301 -- a cwd the walk can't read fails the search ("Search
    // failed: ...", 403 or 500) instead of answering an empty list, while an
    // unreadable folder deeper in is still skipped. Only registered
    // directories are trusted, so each root here is a workspace.
    name: "listfail",
    needs: ["perm"],
    env: `${PH}/w`,
    cwd: "w",
    snap: true,
    ops: [
      ...dirs("home/.claude", "home/.claude/.claudius"),
      ...dirs("w/locked", "w/locked/inner", "w/noread", "w/noread/x", "w/open", "w/open/inner"),
      ...dirs("w/open/locked"),
      ["file", "w/open/f.txt", ""],
      ["file", "w/open/inner/deep.txt", ""],
      ["file", "w/open/locked/hidden.txt", ""],
      ["file", "w/afile", "not a folder"],
      ["chmod", "w/locked", 0o000],
      ["chmod", "w/noread", 0o333],
      ["chmod", "w/open/locked", 0o000],
      [
        "file",
        "home/.claude/.claudius/workspaces.json",
        JSON.stringify({
          version: 1,
          workspaces: [
            ["wks_locked", `${PH}/w/locked`],
            ["wks_noread", `${PH}/w/noread`],
            ["wks_file", `${PH}/w/afile`],
            ["wks_gone", `${PH}/w/gone`],
            ["wks_open", `${PH}/w/open`],
          ].map(([id, rootPath]) => ({
            id,
            name: id,
            rootPath,
            icon: { kind: "letter", letter: "W", color: "#d97757" },
            createdAt: 1,
            updatedAt: 1,
            defaults: {},
          })),
        }),
      ],
    ],
    steps: [
      L("unreadable root", `cwd=${PH}/w/locked`),
      L("unreadable root, query", `cwd=${PH}/w/locked&q=inner`),
      L("unreadable root, limit", `cwd=${PH}/w/locked&limit=1`),
      L("no read, has exec", `cwd=${PH}/w/noread`),
      L("a file as the root", `cwd=${PH}/w/afile`),
      L("a missing root", `cwd=${PH}/w/gone`),
      L("an unreadable child is still skipped", `cwd=${PH}/w/open`),
      L("unreadable child, query", `cwd=${PH}/w/open&q=deep`),
      L("unreadable child, subsequence", `cwd=${PH}/w/open&q=hdn`),
      L("untrusted child of an unreadable root", `cwd=${PH}/w/locked/inner`),
      G("the picker still lists the root", null),
      G("the picker on the unreadable folder", "path=locked"),
    ],
  },
  {
    // `chflags uchg`: the folder lists, but mkdir in it fails with EPERM.
    name: "immutable",
    needs: ["uchg"],
    env: `${PH}/w`,
    cwd: "w",
    snap: true,
    ops: [...dirs("w/frozen", "w/frozen/inner"), ["uchg", "w/frozen"]],
    steps: [
      G("lists", "path=frozen"),
      J("into it", { parent: "frozen", name: "x" }),
      J("existing in it", { parent: "frozen", name: "inner" }),
      J("under it", { parent: "frozen/inner", name: "x" }),
      L("walks it", "q=inner"),
    ],
  },
  {
    name: "home",
    env: null,
    cwd: "home",
    ops: [
      ...dirs("home/Desktop", "home/Desktop/proj", "home/Desktop/proj/src", "home/Documents", "home/Downloads"),
      ...dirs("home/Movies", "home/Music", "home/Pictures", "home/Projects", "home/Projects/app", "home/Projects/app/src"),
      ...dirs("home/Projects/app/packages", "home/Projects/app/packages/config", "home/Library", "home/Library/Containers"),
      ...dirs("home/Library/Containers/com.x", "home/Library/Group Containers", "home/Library/Group Containers/g"),
      ...dirs("home/Library/Caches", "home/Library/Caches/c", "home/Library/Preferences", "home/node_modules"),
      ...dirs("home/node_modules/x", "home/.claude", "home/.claude/.claudius", "home/Desktop/proj/src/deep"),
      ["file", "home/Desktop/proj/src/main.rs", ""],
      ["file", "home/Desktop/proj/src/deep/config.rs", ""],
      ["file", "home/Desktop/note.txt", ""],
      ["file", "home/Documents/notes.md", ""],
      ["file", "home/Projects/app/src/config.ts", ""],
      ["file", "home/Projects/app/packages/config/index.ts", ""],
      ["file", "home/Projects/app/packages/config/package.json", ""],
      ["file", "home/Projects/app/config.json", ""],
      ["file", "home/Library/Containers/com.x/data", ""],
      ["file", "home/Library/Group Containers/g/data", ""],
      ["file", "home/Library/Preferences/p.plist", ""],
      ["file", "home/.zshrc", ""],
      ["link", "app-link", "home/Projects/app"],
      [
        "file",
        "home/.claude/.claudius/workspaces.json",
        JSON.stringify({
          version: 1,
          workspaces: [
            ["wks_desk", `${PH}/home/Desktop/proj`],
            ["wks_app", `${PH}/home/Projects/app`],
            ["wks_link", `${PH}/app-link`],
            ["wks_lib", `${PH}/home/Library`, [`${PH}/home/Library/Caches`, "  ", 5]],
            // JS `trim`: U+FEFF is whitespace, U+0085 isn't (each resolves
            // against the cwd, `home`, when kept).
            ["wks_bom", "\ufeff"],
            ["wks_nel", "\u0085"],
            ["wks_extra", `${PH}/home/Projects/app`, ["\u3000\ufeff", "\u0085\u0085"]],
          ].map(([id, rootPath, extra]) => ({
            id,
            name: id,
            rootPath,
            icon: { kind: "letter", letter: "W", color: "#d97757" },
            createdAt: 1,
            updatedAt: 1,
            defaults: extra ? { additionalDirectories: extra } : {},
          })),
        }),
      ],
    ],
    steps: [
      G("home listing", null),
      G("home desktop", "path=Desktop"),
      G("home desktop ack", "path=Desktop&ack=1"),
      G("home library", "path=Library"),
      G("home containers", `path=${PH}/home/Library/Containers`),
      G("home tilde is literal", "path=~"),
      L("default cwd is home", null),
      L("default cwd, query", "q=config"),
      L("desktop project", `cwd=${PH}/home/Desktop/proj`),
      L("desktop project query", `cwd=${PH}/home/Desktop/proj&q=main`),
      L("app", `cwd=${PH}/home/Projects/app`),
      L("app config ranking", `cwd=${PH}/home/Projects/app&q=config`),
      L("app trailing slash", `cwd=${PH}/home/Projects/app/`),
      L("app collapsing", `cwd=${PH}/home/Projects/app/src/..`),
      L("symlinked root", `cwd=${PH}/app-link`),
      L("library root", `cwd=${PH}/home/Library`),
      L("additional dir", `cwd=${PH}/home/Library/Caches`),
      L("untrusted parent", `cwd=${PH}/home/Projects`),
      L("untrusted etc", "cwd=/etc"),
      L("untrusted tilde", "cwd=~"),
      L("dot is cwd", "cwd=."),
      L("blank cwd", "cwd=%20"),
      L("empty cwd", "cwd="),
      L("bom cwd trims", "cwd=%EF%BB%BF"),
      L("nel cwd doesn't", "cwd=%C2%85"),
      L("first cwd wins", `cwd=/etc&cwd=${PH}/home/Projects/app`),
      L("realpath of a link root", `cwd=${PH}/home/Projects/app&q=index`),
      L("bom root skipped", `cwd=${PH}/home/%EF%BB%BF`),
      L("nel root kept, missing", `cwd=${PH}/home/%C2%85`),
      L("bom extra dir skipped", `cwd=${PH}/home/%E3%80%80%EF%BB%BF`),
      L("nel extra dir kept, missing", `cwd=${PH}/home/%C2%85%C2%85`),
    ],
  },
  {
    name: "list",
    env: `${PH}/w`,
    cwd: "w",
    ops: [
      ...dirs("w/src", "w/src/app", "w/packages", "w/packages/config", "w/config", "w/docs", "w/emoji"),
      ...dirs("w/d1", "w/d1/d2", "w/d1/d2/d3", "w/d1/d2/d3/d4", "w/d1/d2/d3/d4/d5", "w/d1/d2/d3/d4/d5/d6"),
      ...dirs("w/d1/d2/d3/d4/d5/d6/d7", "w/.hidden", "w/node_modules", "w/node_modules/pkg", "w/dist", "w/coverage"),
      ...dirs("w/build", "w/docs/\u039f\u0394\u039f\u03a3", "w/Desktop", "w/Desktop/inner"),
      ["file", "w/src/config.ts", ""],
      ["file", "w/src/app/main.ts", ""],
      ["file", "w/packages/config/index.ts", ""],
      ["file", "w/packages/config/package.json", ""],
      ["file", "w/CONFIG.md", ""],
      ["file", "w/Config.json", ""],
      ["file", "w/docs/\u039f\u0394\u039f\u03a3.md", ""],
      ["file", "w/docs/\u0130stanbul.txt", ""],
      ["file", "w/docs/caf\u00e9.md", ""],
      ["file", "w/docs/cafe\u0301.txt", ""],
      ["file", "w/emoji/\ud83d\ude00.txt", ""],
      ["file", "w/d1/d2/d3/d4/d5/d6/f6.txt", ""],
      ["file", "w/d1/d2/d3/d4/d5/f5.txt", ""],
      ["file", "w/d1/d2/d3/d4/d5/d6/d7/f7.txt", ""],
      ["file", "w/.env", ""],
      ["file", "w/.hidden/x", ""],
      ["file", "w/node_modules/pkg/index.js", ""],
      ["file", "w/dist/out.js", ""],
      ["file", "w/Desktop/inner/f", ""],
      ["link", "w/link-dir", "src"],
      ["link", "w/link-file", "CONFIG.md"],
      ["fifo", "w/pipe"],
      ["file", "w/" + "long".repeat(60), ""],
    ],
    steps: [
      L("no params", null),
      L("empty q", "q="),
      L("blank q", "q=%20%20"),
      L("config", "q=config"),
      L("upper query", "q=CONFIG"),
      L("padded query", "q=%20config%20"),
      L("subsequence", "q=cfg"),
      L("dir prefix", "q=src/"),
      L("slash", "q=/"),
      L("dot", "q=."),
      L("ts", "q=ts"),
      L("none", "q=zzz"),
      L("final sigma dir", "q=%CE%BF%CE%B4%CE%BF%CF%82"),
      L("medial sigma file", "q=%CE%BF%CE%B4%CE%BF%CF%83"),
      L("dotted capital I", "q=%C4%B0"),
      L("i with combining dot", "q=i%CC%87s"),
      L("nfc only", "q=caf%C3%A9"),
      L("nfd only", "q=cafe%CC%81"),
      L("emoji", "q=%F0%9F%98%80"),
      L("deep path", "q=d1/d2"),
      L("deep file", "q=f7"),
      L("long name", "q=longlong"),
      L("limit 1", "limit=1"),
      L("limit 2.9", "limit=2.9"),
      L("limit -1", "limit=-1"),
      L("limit -0", "limit=-0"),
      L("limit 0", "limit=0"),
      L("limit abc", "limit=abc"),
      L("limit Infinity", "limit=Infinity"),
      L("limit -Infinity", "limit=-Infinity"),
      L("limit 1e1", "limit=1e1"),
      L("limit 0x2", "limit=0x2"),
      L("limit padded", "limit=%203%20"),
      L("limit empty", "limit="),
      L("limit 0b1", "limit=0b1"),
      L("limit +2", "limit=%2B2"),
      L("limit plus is space", "limit=+2"),
      L("limit -0.5", "limit=-0.5"),
      L("limit 0.5", "limit=0.5"),
      L("limit 1e400", "limit=1e400"),
      L("query with limit", "q=config&limit=2"),
      L("query with negative limit", "q=config&limit=-1"),
      L("cwd absolute", `cwd=${PH}/w`),
      L("cwd trailing slash", `cwd=${PH}/w/`),
      L("cwd collapsing", `cwd=${PH}/w/src/..`),
      L("cwd dot", "cwd=."),
      L("cwd child untrusted", `cwd=${PH}/w/src`),
      L("cwd outside", `cwd=${PH}/out`),
      L("cwd slash", "cwd=/"),
      L("cwd dotdot", "cwd=.."),
      L("cwd first wins", `cwd=${PH}/out&cwd=${PH}/w`),
      G("dirs on the same tree", null),
    ],
  },
  {
    name: "cap",
    env: `${PH}/w`,
    cwd: "w",
    ops: [
      ...dirs("w/a", "w/a/b", "w/a/b/c", "w/a/b/c/d", "w/a/b/c/d/e", "w/a/b/c/d/e/f", "w/a/b/c/d/e/f/g"),
      ...dirs("w/a/b/c/d/e/f/g/h", "w/m"),
      ...["a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e", "a/b/c/d/e/f", "a/b/c/d/e/f/g", "a/b/c/d/e/f/g/h"].map((d) => [
        "file",
        `w/${d}/x`,
        "",
      ]),
      ["files", "w/m", 5200],
      ["file", "w/zz", ""],
    ],
    steps: [
      L("capped", "limit=Infinity"),
      L("capped tail", "limit=-3"),
      L("capped query", "q=f51&limit=Infinity"),
      L("depth", "q=x&limit=Infinity"),
      L("past the depth", "q=h/"),
      L("default limit", "q=f"),
      G("files only", "path=m"),
    ],
  },
  {
    name: "relroot",
    env: " w ",
    cwd: "",
    ops: dirs("w/alpha", "w/Desktop"),
    steps: [G("relative root", null), G("relative root child", "path=alpha"), G("above", `path=${PH}`)],
  },
  {
    name: "dotroot",
    env: `${PH}/w/./sub/../`,
    cwd: "w",
    ops: dirs("w/alpha"),
    steps: [G("normalized root", null), G("normalized root, absolute", `path=${PH}/w/alpha`)],
  },
  {
    name: "blankroot",
    env: "   ",
    cwd: "w",
    ops: dirs("home/h1", "home/Desktop"),
    steps: [G("blank env is home", null), G("tcc in home", "path=Desktop")],
  },
  {
    name: "slashroot",
    env: "/",
    cwd: "w",
    ops: [],
    steps: [
      G("only / itself", "path=/fs-list-golden-nowhere"),
      G("relative under /", "path=fs-list-golden-nowhere"),
      J("mkdir under /", { parent: "/", name: "fs-list-golden-x" }),
      J("mkdir default parent", { name: "fs-list-golden-x" }),
      J("parent under /", { parent: "/tmp", name: "fs-list-golden-x" }),
    ],
  },
  {
    name: "goneroot",
    env: `${PH}/gone`,
    cwd: "w",
    ops: [],
    steps: [G("missing root", null), G("missing root child", "path=x"), J("mkdir in a missing root", { name: "x" })],
  },
  {
    // A match is kept only while its score is above 0: in `D/E/`
    // (491 + 1 units) `zq` at 494 in a 600-unit path scores exactly 0, at
    // 493 it scores 1, and at 494 in 640 units -0.4.
    name: "zero",
    env: `${PH}/w`,
    cwd: "w",
    ops: [
      ...dirs(`w/${"d".repeat(250)}`, `w/${"d".repeat(250)}/${"e".repeat(240)}`),
      ...[`ffzq${"g".repeat(104)}`, `fzq${"g".repeat(105)}`, `ffzq${"g".repeat(144)}`].map((n) => [
        "file",
        `w/${"d".repeat(250)}/${"e".repeat(240)}/${n}`,
        "",
      ]),
    ],
    steps: [L("score 0 dropped", "q=zq")],
  },
  {
    // Ties in a list long enough for a real sort: names that collate
    // alike (ignorable controls; bytes put `B` before `a`), and two
    // interleaved scores. Both sorts are stable.
    name: "ties",
    env: `${PH}/w`,
    cwd: "w",
    ops: [
      ...dirs("w/t", "w/k"),
      ...["a", "B"].flatMap((base) => TIE_MARKS.map((m) => ["dir", `w/t/${base}${m}`])),
      ...Array.from({ length: 64 }, (_, i) => ["file", `w/k/k${String(i).padStart(2, "0")}${i % 2 ? "" : "x"}`, ""]),
    ],
    steps: [G("collation ties", "path=t"), L("score ties", "q=k"), L("score ties, limit", "q=k&limit=5")],
  },
];

async function call(dirsRoute, step) {
  const url = `http://localhost/api/fs/${step.route}${step.query == null ? "" : "?" + sub(step.query)}`;
  const init = { method: step.method };
  if (step.method === "POST") {
    init.body = step.bodyHex !== undefined ? Buffer.from(step.bodyHex, "hex") : sub(step.body);
    init.headers = { "content-type": "application/json" };
  }
  const req = new Request(url, init);
  const handler = step.route === "list" ? listRoute.GET : dirsRoute[step.method];
  let res;
  try {
    res = await handler(req);
  } catch (e) {
    return { got: { threw: unsub(String(e)) } };
  }
  const text = unsub(await res.text());
  const got = { status: res.status, type: res.headers.get("content-type") };
  if (text.length > 40000) {
    Object.assign(got, { len: Buffer.byteLength(text, "utf8"), fnv: fnv1a64(text), head: text.slice(0, 400) });
  } else got.body = text;
  const r = { got };
  // The `listFs` call the route made, so the walk can be replayed in
  // process. A 200 carries the trusted cwd in its body; a failure (CC
  // 2.1.301: the folder couldn't be read) doesn't, so ask the resolver for
  // the same value it got.
  if (step.route === "list" && [200, 403, 500].includes(res.status)) {
    const params = new URL(url).searchParams;
    const limit = Number(params.get("limit") ?? "200") || 200;
    const cwd = res.status === 200 ? JSON.parse(text).cwd : await resolveTrustedCwd(params.get("cwd"));
    r.args = { cwd: unsub(cwd), q: params.get("q") ?? "", limit: String(limit) };
  }
  return r;
}

const realPlatform = process.platform;
const fsInfo = probeDisk();
let moduleN = 0;
const scenarios = [];
for (const s of SCENARIOS) {
  const rec = { name: s.name, needs: s.needs ?? [], env: s.env, cwd: s.cwd, ops: null, steps: {}, snap: {} };
  for (const platform of ["darwin", "linux"]) {
    resetDisk();
    const ops = s.ops.map((op) => {
      try {
        runOp(op);
        return { op, ok: true };
      } catch {
        return { op, ok: false };
      }
    });
    if (rec.ops === null) rec.ops = ops;
    else if (JSON.stringify(rec.ops) !== JSON.stringify(ops)) throw new Error(`${s.name}: ops differ between passes`);
    if (s.env === null) delete process.env.CLAUDIUS_FS_ROOT;
    else process.env.CLAUDIUS_FS_ROOT = sub(s.env);
    process.chdir(join(ROOT, s.cwd));
    __resetTrustedCwdCache();
    Object.defineProperty(process, "platform", { value: platform, configurable: true, enumerable: true });
    moduleN += 1;
    const dirsRoute = await import(`${dirsUrl}?scenario=${moduleN}`);
    // The route's FS_ROOT, as it took it at load.
    rec.fsRoot = unsub(path.resolve(process.env.CLAUDIUS_FS_ROOT?.trim() || homedir()));
    const steps = [];
    for (const step of s.steps) steps.push({ ...step, ...(await call(dirsRoute, step)) });
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true, enumerable: true });
    process.chdir(repo);
    rec.steps[platform] = steps;
    if (s.snap) rec.snap[platform] = snapshot();
  }
  // Many steps answer alike (and most alike on both platforms): each `got`
  // is an index into the scenario's `gots`.
  const seen = new Map();
  rec.gots = [];
  for (const steps of Object.values(rec.steps)) {
    for (const step of steps) {
      const key = JSON.stringify(step.got);
      if (!seen.has(key)) {
        seen.set(key, rec.gots.length);
        rec.gots.push(step.got);
      }
      step.got = seen.get(key);
    }
  }
  scenarios.push(rec);
}
resetDisk();
delete process.env.CLAUDIUS_FS_ROOT;

const fixture = { node: process.version, icu: process.versions.icu, fs: fsInfo, collate, paths, tcc: tccCases, scenarios };
writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
const steps = scenarios.reduce((n, s) => n + s.steps.darwin.length + s.steps.linux.length, 0);
console.log(
  `wrote ${out}: ${collate.pairs.length} pairs, ${paths.resolve.length} resolves, ${tccCases.categorize.length} tcc, ` +
    `${scenarios.length} scenarios, ${steps} steps`,
);
