#!/usr/bin/env node
// Golden fixture for the HTML preview's file server (D03c):
// `app/api/workspaces/[id]/files/preview/[...path]/route.ts` with what it
// imports (`resolveWorkspaceRoot` / `listWorkspaceRoots`, the workspace and
// customization stores), behind Next's own route matcher.
//
//   node rust/scripts/files-preview-golden.mjs     (node@22)
//
// Re-runs itself under `--experimental-transform-types` (with a resolve hook
// for the `@/` and extensionless imports), once per group and twice over,
// each group in a fresh world; both recordings must agree byte for byte. A
// world is `$ROOT` (a temp dir through realpath); the child runs with its cwd
// at `$ROOT/project`, HOME at `$ROOT/home`, CLAUDE_CONFIG_DIR at
// `$ROOT/config` and umask 022.
//
// Each request's raw path goes through Next's `getRouteMatcher(getRouteRegex(
// "/api/workspaces/[id]/files/preview/[...path]"))` (per-segment
// `decodeURIComponent`, a leading `_NEXTSEP_` stripped), and the exported GET
// is called with those params, as Next calls it. A path the matcher refuses
// records `decode: true` (Next's 400 page; the Rust port hands such a request
// to Next). The matcher sees `parseUrl(url).pathname` (WHATWG), so a URL
// with a dot segment (`..`, `.`, `%2e`) or a `//`, `\` or trailing `/` (which
// Next redirects before matching) isn't recorded: the Rust replay checks
// that it hands those to Next. Encoded slashes (`..%2F`) reach the handler.
//
// Records `groups`, one world each: `steps` are fs setup ops (`fs`: `mkdir`,
// `write` text / hex, `zero` (a sparse file of `size` bytes), `symlink`,
// `fifo`, `chmod`) and requests (`req`: the `url`). A request records `got`:
// `status`, `type`, `cache` and the body (`text` for a text/plain refusal,
// else `hex` up to 64 bytes or `sha`: sha256 and length), `threw` (Next's
// empty 500), or `garbage: n` for an empty file, which TS serves as the
// 64 KiB uninitialized buffer Node's `readFile` read it into (the Rust port
// serves it empty). `perms` marks groups that need permissions enforced
// (not root).
//
// Placeholders: `$ROOT` in paths, file texts and link targets. Strings stay
// ASCII here: non-ASCII text is built with String.fromCodePoint and lone
// surrogates with String.fromCharCode.
//
// Written to rust/crates/claudius-server/tests/fixtures/files_preview_golden.json;
// replayed by crates/claudius-server/tests/files_preview.rs on the real binary.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/files_preview_golden.json");

const GROUPS = ["serve", "perms"];

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

if (!process.env.FP_GOLDEN_ROOT) {
  const child = (group) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fp-")));
    try {
      if (!/^[A-Za-z0-9_./-]+$/.test(root)) throw new Error(`bad root: ${root}`);
      for (const d of ["home", "config", "project"]) mkdirSync(join(root, d), { recursive: true });
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: join(root, "project"),
          encoding: "utf8",
          maxBuffer: 1 << 28,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            TZ: "UTC",
            FP_GOLDEN_ROOT: root,
            FP_GOLDEN_GROUP: group,
            FP_GOLDEN_OUT: join(root, "out.json"),
          },
        },
      );
      if (r.status !== 0) {
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return JSON.parse(readFileSync(join(root, "out.json"), "utf8"));
    } finally {
      openUp(root);
      rmSync(root, { recursive: true, force: true });
    }
  };
  const runs = [0, 1].map(() => JSON.stringify({ groups: GROUPS.map((g) => child(g)) }));
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const reqs = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.op === "req").length, 0);
  console.log(`wrote ${out.slice(repo.length + 1)}: ${fixture.groups.length} groups, ${reqs} requests (stable)`);
  process.exit(0);
}

// --------------------------------- child ---------------------------------

const ROOT = process.env.FP_GOLDEN_ROOT;
const GROUP = process.env.FP_GOLDEN_GROUP;
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

const cp = (...cps) => String.fromCodePoint(...cps);
const unit = (...units) => String.fromCharCode(...units);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const real = (s) => s.replaceAll("$ROOT", ROOT);

const route = await import(join(repo, "app/api/workspaces/[id]/files/preview/[...path]/route.ts"));
const nextRequire = createRequire(join(repo, "package.json"));
const { getRouteRegex } = nextRequire("next/dist/shared/lib/router/utils/route-regex");
const { getRouteMatcher } = nextRequire("next/dist/shared/lib/router/utils/route-matcher");
const { parseUrl } = nextRequire("next/dist/shared/lib/router/utils/parse-url");
const match = getRouteMatcher(getRouteRegex("/api/workspaces/[id]/files/preview/[...path]"));

const STORE = "home/.claude/.claudius/workspaces.json";
const CUST = "home/.claude/.claudius/customizations";

const F = {
  mkdir: (path) => ({ op: "fs", act: "mkdir", path }),
  write: (path, text) => ({ op: "fs", act: "write", path, text }),
  hex: (path, hex) => ({ op: "fs", act: "write", path, hex }),
  zero: (path, size) => ({ op: "fs", act: "zero", path, size }),
  link: (path, target) => ({ op: "fs", act: "symlink", path, target }),
  fifo: (path) => ({ op: "fs", act: "fifo", path }),
  chmod: (path, mode) => ({ op: "fs", act: "chmod", path, mode }),
};
const wsEntry = (id, rootPath, extra = {}) => ({ id, name: id, rootPath, ...extra });
const store = (workspaces) => F.write(STORE, JSON.stringify({ version: 1, workspaces }, null, 2));
const custIndex = (customizations) =>
  F.write(`${CUST}/index.json`, JSON.stringify({ version: 1, customizations, publishes: [] }));

/** A request; `emptyFile` marks one that serves a 0-byte file. */
const G = (id, path, extra = {}) => ({ op: "req", url: `/api/workspaces/${id}/files/preview/${path}`, ...extra });
const A = (path, extra) => G("wks_a", path, extra);

const E = cp(0xe9);
const EMOJI = cp(0x1f600);
const PNG = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489";
let all = "";
for (let b = 0; b < 256; b++) all += b.toString(16).padStart(2, "0");

/** One small file per MIME key, plus the names whose type is a JS quirk. */
const TYPED = [
  "style.css",
  "app.js",
  "m.mjs",
  "c.cjs",
  "d.json",
  "d.jsonc",
  "i.svg",
  "i.jpg",
  "i.jpeg",
  "i.gif",
  "i.webp",
  "i.avif",
  "i.ico",
  "i.bmp",
  "f.woff",
  "f.woff2",
  "f.ttf",
  "f.otf",
  "t.txt",
  "x.xml",
  "UP.HTML",
  "Mixed.Css",
  "page.htm",
  "noext",
  "html",
  "css",
  "x.constructor",
  "x.__proto__",
  "y.CONSTRUCTOR",
  "y.__PROTO__",
  "x.toString",
  "x.hasownproperty",
  "x.valueof",
  "x.unknown",
  "a.tar.gz",
  ".hidden",
  "trailingdot.",
  "x.JS",
];

function groupServe() {
  const lone = `$ROOT/ws${unit(0xd800)}`;
  return [
    F.mkdir("ws"),
    F.mkdir("outside/dir"),
    F.write("outside/secret.txt", "outside the root\n"),
    F.write("outside/dir/o.txt", "o"),
    F.write("ws/index.html", '<!doctype html><link rel="stylesheet" href="style.css"><p>hi</p>\n'),
    ...TYPED.map((name) => F.write(`ws/${name}`, `${name}\n`)),
    F.hex("ws/i.png", PNG),
    F.mkdir("ws/dir.v2"),
    F.write("ws/dir.v2/file", "no extension under a dotted folder\n"),
    F.write("ws/dir.v2/page.html", "<p>v2</p>\n"),
    F.hex("ws/bytes.bin", all),
    F.write("ws/empty.txt", ""),
    F.write(`ws/caf${E}.html`, `<p>caf${E}</p>\n`),
    F.write(`ws/${EMOJI}.txt`, `${EMOJI}\n`),
    F.write(`ws/${E}.${cp(0xc9)}`, "accented extension\n"),
    F.write("ws/a b.html", "space\n"),
    F.write("ws/a+b.txt", "plus\n"),
    F.write("ws/100%.html", "percent\n"),
    F.write("ws/a#b.txt", "hash\n"),
    F.write("ws/a?b.txt", "question\n"),
    F.write("ws/it's.txt", "quote\n"),
    F.write("ws/sub/inner.html", "<p>inner</p>\n"),
    F.write("ws/sub/..foo", "dotdot inside sub\n"),
    F.write("ws/..foo", "dotdot at the top\n"),
    F.write("ws/.../x.txt", "three dots\n"),
    F.write("ws/x.txt", "x\n"),
    F.write("ws/_NEXTSEP_x.txt", "never reachable\n"),
    F.link("ws/link-out.txt", "$ROOT/outside/secret.txt"),
    F.link("ws/link-dir", "$ROOT/outside"),
    F.link("ws/dangling", "$ROOT/nowhere"),
    F.link("ws/loop", "loop"),
    F.link("ws/link-to-dir", "$ROOT/outside/dir"),
    F.link("ws/devnull", "/dev/null"),
    F.fifo("ws/pipe.png"),
    F.mkdir("ws/dir.png"),
    F.zero("ws/big-exact.bin", 128 * 1024 * 1024),
    F.zero("ws/big-over.bin", 128 * 1024 * 1024 + 1),
    F.write(`ws${cp(0xfffd)}/lone.html`, "<p>lone</p>\n"),
    F.link("wslink", "$ROOT/ws"),
    F.write("project/rel/r.html", "<p>relative root</p>\n"),
    F.write(`${CUST}/cust_aaaaaaaaaaaa/src/index.html`, "<p>customization</p>\n"),
    F.write("home/.claude/.claudius/evil/src/e.html", "<p>outside the customizations folder</p>\n"),
    store([
      wsEntry("wks_a", "$ROOT/ws"),
      wsEntry("wks_rel", "rel"),
      wsEntry("wks_trail", "$ROOT/ws/"),
      wsEntry("wks_dots", "$ROOT/project/../ws"),
      wsEntry("wks_slash", "/"),
      wsEntry("wks_num", 5),
      wsEntry("wks_badextra", "$ROOT/ws", { defaults: { additionalDirectories: 5 } }),
      wsEntry("wks_lone", lone),
      wsEntry("wks_link", "$ROOT/wslink"),
      wsEntry("wks_missing", "$ROOT/nope"),
      wsEntry("wks_file", "$ROOT/ws/index.html"),
      wsEntry("wks_extra", "$ROOT/outside", { defaults: { additionalDirectories: ["$ROOT/ws"] } }),
      wsEntry(`wks_${E}`, "$ROOT/ws"),
    ]),
    custIndex([
      { id: "cust_aaaaaaaaaaaa", name: "A" },
      { id: "cust_x/../../evil", name: "E" },
    ]),
    // Types.
    A("index.html"),
    ...TYPED.map((name) => A(name)),
    A("i.png"),
    A("dir.v2/file"),
    A("dir.v2/page.html"),
    A("bytes.bin"),
    A("empty.txt", { emptyFile: true }),
    // Names.
    A("caf%C3%A9.html"),
    A("%F0%9F%98%80.txt"),
    A("%C3%A9.%C3%89"),
    A("a%20b.html"),
    A("a+b.txt"),
    A("100%25.html"),
    A("100%.html"),
    A("a%23b.txt"),
    A("a%3Fb.txt"),
    A("it's.txt"),
    A("it%27s.txt"),
    A("sub/inner.html"),
    A("sub%2Finner.html"),
    A("sub/..foo"),
    A("..foo"),
    A(".../x.txt"),
    A("_NEXTSEP_x.txt"),
    A("%5FNEXTSEP%5Fx.txt"),
    A("_NEXTSEP__NEXTSEP_x.txt"),
    A("_NEXTSEP_sub/_NEXTSEP_inner.html"),
    A("index.html?x=1&y=%zz"),
    A("nope.html"),
    // What the path names.
    A("link-out.txt"),
    A("link-dir/secret.txt"),
    A("link-dir/dir/o.txt"),
    A("dangling"),
    A("loop"),
    A("link-to-dir"),
    A("devnull"),
    A("pipe.png"),
    A("dir.png"),
    A("sub"),
    A("big-exact.bin"),
    A("big-over.bin"),
    // Traversal and odd segments.
    A("..%2Foutside%2Fsecret.txt"),
    A("%2E%2E%2Foutside%2Fsecret.txt"),
    A("sub%2F..%2F..%2Foutside%2Fsecret.txt"),
    A("sub%2F..%2Findex.html"),
    A("sub%2F.%2Finner.html"),
    A("..%2F"),
    A(".%2F"),
    A("%2Fetc%2Fhosts"),
    A("%2F%2Findex.html"),
    A("index.html%2F"),
    A("index.html%2F."),
    A("index.html%00"),
    A("%00"),
    A("%E9.html"),
    A("%ED%A0%80.html"),
    A("%C0%AF"),
    A("%"),
    // Ids.
    G("wks_rel", "r.html"),
    G("wks_trail", "index.html"),
    G("wks_dots", "index.html"),
    G("wks_slash", "index.html"),
    G("wks_slash", "etc/hosts"),
    G("wks_num", "index.html"),
    G("wks_badextra", "index.html"),
    G("wks_lone", "lone.html"),
    G("wks_link", "index.html"),
    G("wks_link", "link-out.txt"),
    G("wks_missing", "x.html"),
    G("wks_file", "x"),
    G("wks_extra", "secret.txt"),
    G("wks_extra", "index.html"),
    G("wks_%C3%A9", "index.html"),
    G("wks_nope", "index.html"),
    G("WKS_A", "index.html"),
    G("_NEXTSEP_wks_a", "index.html"),
    G("wks%5Fa", "index.html"),
    G("wks%zz", "index.html"),
    G("wks_a%2Fx", "index.html"),
    G("cust_aaaaaaaaaaaa", "index.html"),
    G("cust_aaaaaaaaaaaa", "..%2F..%2Fcustomizations%2Findex.json"),
    G("cust_bbbbbbbbbbbb", "index.html"),
    G("cust_x%2F..%2F..%2Fevil", "e.html"),
    // Stores that don't load.
    F.write(STORE, "{"),
    A("index.html"),
    G("cust_aaaaaaaaaaaa", "index.html"),
    F.write(STORE, "null"),
    A("index.html"),
    F.write(STORE, JSON.stringify({ version: 1, workspaces: [null, wsEntry("wks_a", "$ROOT/ws")] })),
    A("index.html"),
    F.write(STORE, JSON.stringify({ version: 2, workspaces: [wsEntry("wks_a", "$ROOT/ws")] })),
    A("index.html"),
    F.write(`${CUST}/index.json`, "{"),
    G("cust_aaaaaaaaaaaa", "index.html"),
    F.write(`${CUST}/index.json`, JSON.stringify({ version: 1, customizations: [null], publishes: [] })),
    G("cust_aaaaaaaaaaaa", "index.html"),
    F.write(STORE, JSON.stringify({ version: 1, workspaces: [wsEntry("wks_a", "$ROOT/ws")] })),
    A("index.html"),
  ];
}

function groupPerms() {
  return [
    F.write("ws/index.html", "<p>hi</p>\n"),
    F.write("ws/closed.txt", "mode 000\n"),
    F.chmod("ws/closed.txt", 0o000),
    F.write("ws/write-only.txt", "mode 200\n"),
    F.chmod("ws/write-only.txt", 0o200),
    F.write("ws/shut/in.txt", "inside a mode-000 folder\n"),
    F.chmod("ws/shut", 0o000),
    F.write("ws/noexec/in.txt", "inside a mode-600 folder\n"),
    F.chmod("ws/noexec", 0o600),
    store([wsEntry("wks_a", "$ROOT/ws")]),
    A("index.html"),
    A("closed.txt"),
    A("write-only.txt"),
    A("shut/in.txt"),
    A("shut"),
    A("noexec/in.txt"),
    A("noexec"),
    F.chmod("ws", 0o000),
    A("index.html"),
    F.chmod("ws", 0o755),
    F.chmod(STORE, 0o000),
    A("index.html"),
    F.chmod(STORE, 0o644),
    A("index.html"),
  ];
}

function applyFs(s) {
  const p = join(ROOT, real(s.path));
  switch (s.act) {
    case "mkdir":
      mkdirSync(p, { recursive: true });
      break;
    case "write":
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s.hex !== undefined ? Buffer.from(s.hex, "hex") : Buffer.from(real(s.text)));
      break;
    case "zero": {
      const fd = openSync(p, "w");
      ftruncateSync(fd, s.size);
      closeSync(fd);
      break;
    }
    case "symlink":
      symlinkSync(real(s.target), p);
      break;
    case "fifo": {
      const r = spawnSync("mkfifo", [p]);
      if (r.status !== 0) throw new Error(`mkfifo ${p}`);
      break;
    }
    case "chmod":
      chmodSync(p, s.mode);
      break;
    default:
      throw new Error(`unknown fs op ${s.act}`);
  }
}

async function request(s) {
  // Next matches the pathname of `parseUrl(req.url)` (WHATWG: dot segments
  // resolved). The recorded URLs are ones it leaves alone; the Rust port
  // hands the others to Next.
  const pathname = parseUrl(s.url).pathname;
  if (pathname !== s.url.split("?", 1)[0]) throw new Error(`Next rewrites ${s.url} to ${pathname}`);
  let params;
  try {
    params = match(pathname);
  } catch (e) {
    if (e?.constructor?.name === "DecodeError") return { decode: true };
    throw e;
  }
  if (!params) throw new Error(`no match: ${s.url}`);
  const req = new Request(`http://localhost${s.url}`);
  let res;
  try {
    res = await route.GET(req, { params: Promise.resolve(params) });
  } catch {
    return { threw: true };
  }
  const type = res.headers.get("content-type");
  const got = { status: res.status, type };
  const cache = res.headers.get("cache-control");
  if (cache !== null) got.cache = cache;
  const others = [...res.headers.keys()].filter((k) => !["content-type", "cache-control"].includes(k));
  if (others.length) got.headers = others;
  const buf = Buffer.from(await res.arrayBuffer());
  if (s.emptyFile) {
    if (buf.length !== 65536) throw new Error(`empty file served as ${buf.length} bytes`);
    got.garbage = buf.length;
  } else if (type === "text/plain;charset=UTF-8") got.text = buf.toString("utf8");
  else if (buf.length <= 64) got.hex = buf.toString("hex");
  else got.sha = `${sha(buf)}:${buf.length}`;
  return got;
}

const BUILD = { serve: groupServe, perms: groupPerms };
const META = { perms: { perms: true } };

const steps = [];
for (const raw of BUILD[GROUP]()) {
  const s = { ...raw };
  if (s.op === "fs") applyFs(s);
  else s.got = await request(s);
  steps.push(s);
}
writeFileSync(process.env.FP_GOLDEN_OUT, JSON.stringify({ name: GROUP, ...(META[GROUP] ?? {}), steps }));
process.exit(0);
