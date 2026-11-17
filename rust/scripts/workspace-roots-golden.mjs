#!/usr/bin/env node
// Golden fixture for D02: `lib/server/workspace-roots.ts`
// (`listWorkspaceRoots`, `resolveWorkspaceRoot`) behind
// `app/api/workspaces/[id]/roots` (GET) and `[id]/reveal` (POST: show a
// path in Finder), and `lib/server/shell.ts` (`execShellCommand`) behind
// `[id]/shell` (POST: one `/bin/bash -c` in the workspace root; it opens no
// terminal).
//
//   node rust/scripts/workspace-roots-golden.mjs     (node@22)
//
// Re-runs itself twice under `--experimental-transform-types`, each time in
// a fresh temp root with HOME at <root>/home, CLAUDE_CONFIG_DIR at
// <root>/config, the cwd at <root>/project and PATH at <root>/bin ALONE.
// <root>/bin holds a fake `open`, `osascript` and `xdg-open` (one /bin/sh
// script, `fake` in the fixture): it writes one record per call to
// $FAKE_LAUNCH_DIR (its name, physical cwd, what fds 0-2 are, whether it
// leads its process group, $WSR_MARK and its argv) and opens nothing. No
// real launcher is ever on PATH, so neither run can open Finder or a
// terminal, even with the fake removed. Both recordings must agree byte
// for byte. Each route handler runs inside Next's own
// `AppRouteRouteModule.handle`, and an uncaught exception is logged and
// survived as `next start`'s router server does (`process.on
// ("uncaughtException")`).
//
// Sections:
// * `steps`, in order:
//   - `fs`: write (text or hex) / mkdir / rm / symlink / chmod under $ROOT;
//   - `bin`: what <root>/bin/open is (`fake`, `missing`, `noexec` (0644),
//     `dir`, `badinterp` (a missing interpreter), `noshebang`);
//   - `req`: a request and `got` (status, content type, the body as text,
//     or `sha256:<hex>:<len>` past 64 KiB; `threw` is Next's empty 500),
//     `launched` (the records the fake wrote for it, sorted; a reveal waits
//     for its one record) and `uncaught` (the messages of uncaught
//     exceptions, e.g. the spawn `error` event `revealOnHost` doesn't
//     listen to). `os: true` marks a reveal that reached `revealOnHost`,
//     whose command depends on the platform (`platform`). A step with `as`
//     is a listed difference: it is also recorded with `as` applied
//     (`gotAs`, `launchedAs`), which is what the Rust port answers.
// * `exec`: `execShellCommand(cwd, command, opts)` called directly with the
//   test-only options (`timeoutMs`, `maxOutputBytes`, `stdin`): the result
//   or `threw` (the rejection's message). `cwd` absent is `undefined`;
//   `opts.stdinRepeat: [text, n]` stands for `stdin: text.repeat(n)`.
//
// The temp root is written "$ROOT". Strings stay ASCII here: non-ASCII
// text is built with String.fromCodePoint, lone surrogates with
// String.fromCharCode and JSON escapes with `esc`.
//
// Written (ASCII only) to rust/crates/claudius-core/tests/fixtures/workspace_roots_golden.json;
// replayed by crates/claudius-server/tests/workspace_roots.rs (`steps`, on
// the real binary with the same fake) and
// crates/claudius-core/tests/shell_golden.rs (`exec`).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/workspace_roots_golden.json");
/** A JSON `\uXXXX` escape, built so no tool turns it into the character. */
const esc = (hex) => "\\" + "u" + hex;

if (!process.env.WSR_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-roots-golden-")));
    try {
      for (const d of ["home", "config", "project", "bin", "launch"]) mkdirSync(join(root, d));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: join(root, "project"),
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: join(root, "bin"),
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            TZ: "UTC",
            WSR_MARK: "mark-d02",
            FAKE_LAUNCH_DIR: join(root, "launch"),
            WSR_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      // An unreadable dir would stop the cleanup.
      spawnSync("/bin/chmod", ["-R", "u+rwx", root]);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) {
    if (process.env.WSR_GOLDEN_DIFF_DIR) runs.forEach((r, i) => writeFileSync(join(process.env.WSR_GOLDEN_DIFF_DIR, `run${i}.json`), r));
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  // ASCII only: every other UTF-16 unit as a JSON escape.
  const nonAscii = new RegExp(`[${String.fromCharCode(0x7f)}-${String.fromCharCode(0xffff)}]`, "g");
  const text = JSON.stringify(fixture, null, 1).replace(nonAscii, (ch) => esc(ch.charCodeAt(0).toString(16).padStart(4, "0")));
  writeFileSync(out, `${text}\n`);
  const reqs = fixture.steps.filter((s) => s.op === "req");
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.steps.length} steps (${reqs.length} requests, ` +
      `${reqs.filter((s) => s.launched.length).length} launches), ${fixture.exec.length} exec calls (stable)`,
  );
  process.exit(0);
}

const ROOT = process.env.WSR_GOLDEN_CHILD;
const BIN = join(ROOT, "bin");
const LAUNCH = process.env.FAKE_LAUNCH_DIR;

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

// `next start` logs an uncaught exception and keeps serving.
const uncaught = [];
process.on("uncaughtException", (e) => uncaught.push(e instanceof Error ? e.message : String(e)));

const require = createRequire(join(repo, "package.json"));
const { AppRouteRouteModule } = require("next/dist/server/route-modules/app-route/module.js");
const { NextRequest } = require("next/server.js");
const { execShellCommand } = await import(join(repo, "lib/server/shell.ts"));

function routeModule(userland, pathname) {
  return new AppRouteRouteModule({
    userland: () => userland,
    definition: { kind: "APP_ROUTE", page: `${pathname}/route`, pathname, filename: "route", bundlePath: "" },
    distDir: ".next",
    relativeProjectDir: "",
    resolvedPagePath: `app${pathname}/route.ts`,
    nextConfigOutput: undefined,
  });
}
const api = join(repo, "app/api/workspaces/[id]");
const ROUTES = {
  roots: routeModule(await import(join(api, "roots/route.ts")), "/api/workspaces/[id]/roots"),
  reveal: routeModule(await import(join(api, "reveal/route.ts")), "/api/workspaces/[id]/reveal"),
  shell: routeModule(await import(join(api, "shell/route.ts")), "/api/workspaces/[id]/shell"),
};
const context = (params) => ({
  params,
  previewProps: { previewModeId: "p", previewModeSigningKey: "s", previewModeEncryptionKey: "e" },
  renderOpts: {
    experimental: {},
    cacheComponents: false,
    supportsDynamicResponse: true,
    waitUntil: undefined,
    onClose: () => {},
    onAfterTaskError: undefined,
  },
  sharedContext: { buildId: "golden" },
});
/** `/api/workspaces/<id>/<route>`: the module and the decoded id. */
function routeFor(path) {
  const segs = path.split("?")[0].split("/").slice(3);
  return [ROUTES[segs[1]], { id: decodeURIComponent(segs[0]) }];
}

// ------------------------------- helpers -------------------------------

const cp = (...cps) => String.fromCodePoint(...cps);
const unit = (...units) => String.fromCharCode(...units);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const real = (s) => s.replaceAll("$ROOT", ROOT);
const fake = (s) => s.replaceAll(ROOT, "$ROOT");
const R = "$ROOT";
const CLAUDIUS = `${R}/home/.claude/.claudius`;
const STORE = `${CLAUDIUS}/workspaces.json`;
const CUSTS = `${CLAUDIUS}/customizations`;
const INDEX = `${CUSTS}/index.json`;
const W = (n) => `wks_r${String(n).padStart(11, "0")}`;
const CUST = "cust_a00000000001";

// ------------------------------- the fake launcher -------------------------------

const FAKE_BODY = [
  "# Fake GUI launcher (D02 golden): `open`, `osascript` and `xdg-open`.",
  "# Writes one record to $FAKE_LAUNCH_DIR and opens nothing.",
  'd="$FAKE_LAUNCH_DIR"',
  '[ -n "$d" ] || exit 99',
  'io=""',
  "for f in 0 1 2; do",
  '  if [ -p /dev/fd/$f ]; then io="${io}p"; elif [ -c /dev/fd/$f ]; then io="${io}c"; elif [ -e /dev/fd/$f ]; then io="${io}f"; else io="${io}-"; fi',
  "done",
  "pg=$(/bin/ps -o pgid= -p $$ | /usr/bin/tr -d ' ')",
  'if [ "$pg" = "$$" ]; then leader=1; else leader=0; fi',
  't="$d/.tmp.$$"',
  "{",
  "  printf 'name=%s\\n' \"${0##*/}\"",
  "  printf 'cwd=%s\\n' \"$(/bin/pwd -P)\"",
  "  printf 'io=%s\\n' \"$io\"",
  "  printf 'leader=%s\\n' \"$leader\"",
  "  printf 'mark=%s\\n' \"$WSR_MARK\"",
  "  printf 'argv:\\n'",
  "  for a in \"$@\"; do printf '%s\\000' \"$a\"; done",
  '} > "$t"',
  '/bin/mv "$t" "$d/rec.$$"',
  "",
].join("\n");
const FAKE = `#!/bin/sh\n${FAKE_BODY}`;
const BINS = { badinterp: `#!/nonexistent-claudius-d02/sh\n${FAKE_BODY}`, noshebang: FAKE_BODY };
const LAUNCHERS = ["open", "osascript", "xdg-open"];
for (const name of LAUNCHERS) {
  writeFileSync(join(BIN, name), FAKE);
  chmodSync(join(BIN, name), 0o755);
}
/** Make <root>/bin/open what `kind` says (the others stay the fake). */
function installBin(kind) {
  const p = join(BIN, "open");
  rmSync(p, { recursive: true, force: true });
  if (kind === "missing") return;
  if (kind === "dir") return mkdirSync(p);
  const text = { fake: FAKE, noexec: FAKE, ...BINS }[kind];
  if (text === undefined) throw new Error(`bin ${kind}`);
  writeFileSync(p, text);
  chmodSync(p, kind === "noexec" ? 0o644 : 0o755);
}

/** The records the fake wrote, parsed, removed, sorted. */
function takeRecords() {
  const recs = [];
  for (const name of readdirSync(LAUNCH)) {
    if (!name.startsWith("rec.")) continue;
    const p = join(LAUNCH, name);
    const buf = readFileSync(p);
    rmSync(p);
    const at = buf.indexOf("argv:\n");
    const rec = {};
    for (const line of buf.subarray(0, at).toString("utf8").split("\n")) {
      if (!line) continue;
      const i = line.indexOf("=");
      rec[line.slice(0, i)] = fake(line.slice(i + 1));
    }
    const args = buf.subarray(at + 6).toString("utf8").split("\0");
    args.pop();
    rec.args = args.map(fake);
    recs.push(rec);
  }
  return recs.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------- steps -------------------------------

const REQ = (method, path, extra = {}) => ({ op: "req", method, path, ...extra });
const G = (path) => REQ("GET", path);
const J = (path, value) => REQ("POST", path, { body: JSON.stringify(value) });
const T = (path, text) => REQ("POST", path, { body: text });
const X = (path, hex) => REQ("POST", path, { bodyHex: hex });
const FS = {
  write: (path, text) => ({ op: "fs", act: "write", path, text }),
  hex: (path, hex) => ({ op: "fs", act: "write", path, hex }),
  json: (path, value) => ({ op: "fs", act: "write", path, text: JSON.stringify(value, null, 2) }),
  mkdir: (path) => ({ op: "fs", act: "mkdir", path }),
  rm: (path) => ({ op: "fs", act: "rm", path }),
  link: (path, target) => ({ op: "fs", act: "symlink", path, target }),
  chmod: (path, mode) => ({ op: "fs", act: "chmod", path, mode }),
};
const BIN_STEP = (kind) => ({ op: "bin", kind });
const roots = (id) => G(`/api/workspaces/${id}/roots`);
const reveal = (id, value) => J(`/api/workspaces/${id}/reveal`, value);
const shell = (id, command) => J(`/api/workspaces/${id}/shell`, { command });

const emoji = cp(0x1f600);
const UNI = `${cp(0xe9)}t${cp(0xe9)} ${emoji}`;
const LONG = "x".repeat(300);
const settings = (root, value) => FS.json(`${root}/.claude/settings.json`, value);
const dirs = (...xs) => ({ permissions: { additionalDirectories: xs } });
const ws = (n, extra) => ({
  id: W(n),
  name: `w${n}`,
  rootPath: `${R}/p1`,
  icon: { kind: "letter", letter: "W", color: "#000001" },
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});
const fileUrl = (extra) => ({ href: "file:///x", protocol: "file:", hostname: "", pathname: `${R}/p%31`, ...extra });
const twelve = Array.from({ length: 12 }, (_, i) => `${R}/many/m${i}`);

const WORKSPACES = [
  ws(1, {
    defaults: {
      permissionMode: "auto",
      additionalDirectories: [
        `${R}/d1`,
        "rel",
        "  ",
        "",
        `${cp(0xa0, 0xfeff, 0x2028, 0x3000)}\t\n`,
        5,
        null,
        true,
        {},
        [],
        `${R}/d1`,
        `${R}/p1`,
        `${R}/p1/`,
        `${R}/d2/`,
        `${R}/d1/../d2`,
        `${R}//d3//`,
        `${R}/${UNI}`,
        ` ${R}/d1 `,
        `${cp(0xa0)}${R}/d4`,
      ],
    },
  }),
  ws(2, { rootPath: "rel", defaults: { additionalDirectories: ["../p2", "."] } }),
  ws(3, { rootPath: 5 }),
  ws(4, { rootPath: undefined }),
  ws(5, { rootPath: "" }),
  ws(6, { rootPath: `${R}/p2`, defaults: { additionalDirectories: `ab${emoji} a` } }),
  ws(7, { defaults: { additionalDirectories: 5 } }),
  ws(8, { defaults: { additionalDirectories: {} } }),
  ws(9, { defaults: { additionalDirectories: true } }),
  ws(10, { defaults: null }),
  ws(11, { defaults: "additionalDirectories" }),
  ws(12, { defaults: [`${R}/d1`] }),
  ws(13, { defaults: { additionalDirectories: null } }),
  ws(14, { rootPath: `${R}/p3`, defaults: { additionalDirectories: [] } }),
  ws(15, { rootPath: "/" }),
  ws(16, { rootPath: `${R}/p1${unit(0)}x`, defaults: { additionalDirectories: [`${R}/d1${unit(0)}`] } }),
  ws(17, { rootPath: `${R}/${unit(0xd800)}`, defaults: { additionalDirectories: [`${R}/${unit(0xdc00)}`, `${R}/${unit(0xd800)}`] } }),
  ws(18, { rootPath: `${R}/p3` }),
  ws(19, { rootPath: fileUrl() }),
  ws(20, { rootPath: fileUrl({ protocol: "http:" }) }),
  ws(21, { rootPath: fileUrl({ auth: null }) }),
  ws(22, { rootPath: fileUrl({ pathname: `${R}%2Fp1` }) }),
  ws(23, { rootPath: fileUrl({ hostname: "host" }) }),
  ws(24, { rootPath: fileUrl({ pathname: `${R}/p1%00` }) }),
  ws(25, { rootPath: fileUrl({ pathname: `${R}/%E0%A4%A` }) }),
  ws(26, { rootPath: `${R}/missing` }),
  ws(27, { rootPath: `${R}/file.txt` }),
  ws(28, { rootPath: `${R}/noperm` }),
  ws(29, { rootPath: `${R}/loop` }),
  ws(30, { rootPath: `${R}/${LONG}` }),
  ws(31, { rootPath: `${R}/link-dir` }),
  ws(32, { rootPath: `${R}/many`, defaults: { additionalDirectories: twelve } }),
  ws(33, { rootPath: [`${R}/p1`] }),
  ws(34, { rootPath: { pathname: `${R}/p1` } }),
  ws(35, { rootPath: null }),
  ws(36, { rootPath: true }),
  { ...ws(37), id: "cust_w00000000001" },
];
const STORE_VALUE = { version: 1, activeId: W(1), workspaces: WORKSPACES };

const WORLD = [
  ...["p1/sub", "p2", "p3", "d1", "d2", "d3", "d5", UNI, "project/rel/.claude", "project/a", "many/m10", cp(0xfffd), "noperm"].map((d) =>
    FS.mkdir(`${R}/${d}`),
  ),
  FS.write(`${R}/p1/a.txt`, "a"),
  FS.write(`${R}/p1/sub/b.txt`, "b"),
  FS.write(`${R}/p1/sp ace.txt`, "s"),
  FS.write(`${R}/p1/semi;colon $(touch x) \`y\` 'q\".txt`, "s"),
  FS.write(`${R}/p1/..foo`, "dots"),
  FS.write(`${R}/p1/...`, "dots"),
  FS.write(`${R}/p1/${UNI}.txt`, "u"),
  FS.write(`${R}/p1/${cp(0xfffd)}`, "replacement char"),
  FS.write(`${R}/p1/-R`, "dash"),
  FS.link(`${R}/p1/link-file`, `${R}/p1/a.txt`),
  FS.link(`${R}/p1/link-dir`, `${R}/p1/sub`),
  FS.link(`${R}/p1/link-out`, `${R}/p2`),
  FS.link(`${R}/p1/dangling`, `${R}/p1/nowhere`),
  FS.write(`${R}/d1/x.txt`, "x"),
  FS.write(`${R}/file.txt`, "not a dir"),
  FS.link(`${R}/link-dir`, `${R}/p1`),
  FS.link(`${R}/loop`, `${R}/loop`),
  settings(`${R}/p1`, { other: 1, ...dirs(`${R}/d2`, `${R}/d5`, "", " ", 7, null, "rel", "rel2", `${R}/d5`, `${R}/p1`) }),
  settings(`${R}/project/rel`, dirs(`${R}/d1`, "../d3")),
  settings(`${R}/${cp(0xfffd)}`, dirs(`${R}/d5`)),
  FS.write(STORE, JSON.stringify(STORE_VALUE, null, 2)),
  FS.json(INDEX, {
    version: 1,
    customizations: [5, "cust_x", { id: 5 }, { id: CUST, name: "c" }, { id: "cust_../../esc", name: "climbs" }, { id: "cust_nosrc" }],
    publishes: [],
  }),
  FS.mkdir(`${CUSTS}/${CUST}/src/sub`),
  FS.write(`${CUSTS}/${CUST}/src/f.txt`, "f"),
  FS.mkdir(`${CLAUDIUS}/esc/src`),
  FS.chmod(`${R}/noperm`, 0o000),
];

const ALL_IDS = [...WORKSPACES.map((w) => w.id), "wks_r99999999999", CUST, "missing"];

// The project settings.json as each roots request finds it (workspace 18, root p3).
const P3 = `${R}/p3/.claude/settings.json`;
const SETTINGS_SHAPES = [
  FS.write(P3, "null"),
  FS.write(P3, "5"),
  FS.write(P3, "[]"),
  FS.write(P3, '"s"'),
  FS.write(P3, "{"),
  FS.write(P3, ""),
  FS.hex(P3, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"permissions":{"additionalDirectories":["/bom"]}}')]).toString("hex")),
  FS.write(P3, '{"permissions":null}'),
  FS.write(P3, '{"permissions":[]}'),
  FS.write(P3, '{"permissions":"x"}'),
  FS.write(P3, '{"permissions":{"additionalDirectories":"x"}}'),
  FS.write(P3, '{"permissions":{"additionalDirectories":{"0":"/a","length":1}}}'),
  FS.write(P3, '{"permissions":{"additionalDirectories":["/a"]},"permissions":{"additionalDirectories":["/b"]}}'),
  FS.write(P3, '{"__proto__":{"additionalDirectories":["/proto"]},"permissions":{"__proto__":["/p2"]}}'),
  FS.write(P3, `{"permissions":{"additionalDirectories":["/${esc("d800")}","/${esc("d83d")}${esc("de00")}","/a${esc("0000")}"]}}`),
  FS.hex(P3, Buffer.concat([Buffer.from('{"permissions":{"additionalDirectories":["/bad'), Buffer.from([0xff, 0xc3]), Buffer.from('"]}}')]).toString("hex")),
  FS.write(P3, `{"permissions":{"additionalDirectories":["${R}/d1",1e400,"${R}/d2"]}}`),
  FS.rm(P3),
  FS.mkdir(P3),
  FS.rm(P3),
  FS.link(P3, `${R}/p1/.claude/settings.json`),
  FS.rm(P3),
  FS.link(P3, `${R}/nowhere.json`),
  FS.rm(`${R}/p3/.claude`),
  FS.write(`${R}/p3/.claude`, "a file"),
  FS.rm(`${R}/p3/.claude`),
  FS.write(P3, JSON.stringify(dirs(`${R}/d1`))),
  FS.chmod(P3, 0o000),
  FS.chmod(P3, 0o644),
].flatMap((s) => [s, roots(W(18))]);

const P1 = W(1);
const RV = (value) => reveal(P1, value);
const REVEALS = [
  // Bodies.
  T(`/api/workspaces/${P1}/reveal`, ""),
  T(`/api/workspaces/${P1}/reveal`, "{"),
  T(`/api/workspaces/${P1}/reveal`, "null"),
  T(`/api/workspaces/${P1}/reveal`, "[]"),
  T(`/api/workspaces/${P1}/reveal`, '"a.txt"'),
  T(`/api/workspaces/${P1}/reveal`, "5"),
  T(`/api/workspaces/${P1}/reveal`, "true"),
  X(`/api/workspaces/${P1}/reveal`, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"relPath":"a.txt"}')]).toString("hex")),
  X(`/api/workspaces/${P1}/reveal`, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('{"relPath":"a.txt"}')]).toString("hex")),
  T(`/api/workspaces/${P1}/reveal`, '{"relPath":"a.txt","relPath":"sub"}'),
  RV({}),
  // relPath.
  ...[
    "a.txt",
    "/a.txt",
    "///sub//b.txt",
    "sub/",
    "sub",
    "./sub/../a.txt",
    ".",
    "./",
    "/",
    "//",
    "..",
    "../p2",
    "../",
    "sub/../../p2",
    "a/../../..",
    "/../a.txt",
    "/../../sub",
    "..foo",
    "...",
    ".../x",
    "missing.txt",
    "a.txt/x",
    "a.txt/",
    "sub\\b.txt",
    "link-file",
    "link-dir",
    "link-dir/",
    "link-out",
    "dangling",
    "sp ace.txt",
    "semi;colon $(touch x) `y` 'q\".txt",
    `${UNI}.txt`,
    `a.txt${unit(0)}`,
    unit(0xd800),
    unit(0xdc00),
    "-R",
    "./-R",
  ].map((relPath) => RV({ relPath })),
  ...[5, null, [], {}, true, ["a.txt"]].map((relPath) => RV({ relPath })),
  // Roots.
  ...[
    { root: "primary" },
    { root: "primary", relPath: "a.txt" },
    { root: "" },
    { root: 5, relPath: "a.txt" },
    { root: null },
    { root: ["extra:0"] },
    { root: "extra:0" },
    { root: "extra:0", relPath: "x.txt" },
    { root: "extra:0", relPath: "../p1" },
    { root: "extra:0", relPath: "nope" },
    { root: "extra:1" },
    { root: "extra:2" },
    { root: "extra:3" },
    { root: "extra:4" },
    { root: "extra:5" },
    { root: "extra:6" },
    { root: "extra:7" },
    { root: "extra:8" },
    { root: "extra:9" },
    { root: "extra:99" },
    { root: "PRIMARY" },
    { root: "extra:0 " },
    { root: "extra:00" },
    { root: "extra:-1" },
    { root: "settings" },
  ].map(RV),
  reveal(W(32), { root: "extra:10" }),
  reveal(W(32), { root: "extra:11" }),
  reveal(W(32), { root: "extra:12" }),
  reveal(W(6), { root: "extra:0" }),
  reveal(W(6), { root: "extra:1" }),
  reveal(W(2), {}),
  reveal(W(2), { root: "extra:0" }),
  reveal(W(2), { root: "extra:2" }),
  reveal(W(17), {}),
  reveal(W(17), { root: "extra:0" }),
  reveal(W(17), { root: "extra:1" }),
  // Odd workspaces.
  ...[3, 4, 5, 7, 8, 9, 10, 11, 15, 16, 19, 26, 27, 28, 29, 30, 31, 33, 35].map((n) => reveal(W(n), {})),
  reveal(W(16), { relPath: "a.txt" }),
  reveal(W(27), { relPath: "x" }),
  reveal(W(28), { relPath: "x" }),
  // Unknown workspaces.
  reveal("wks_r99999999999", {}),
  reveal("wks_r99999999999", { root: "primary" }),
  reveal("wks_r99999999999", { root: "" }),
  reveal("wks_r99999999999", { root: 5 }),
  T("/api/workspaces/wks_r99999999999/reveal", "null"),
  T("/api/workspaces/wks_r99999999999/reveal", "{"),
  // Customizations: single-root, at `customizationSrcDir(id)`.
  reveal(CUST, {}),
  reveal(CUST, { root: "primary" }),
  reveal(CUST, { root: "" }),
  reveal(CUST, { root: "extra:0" }),
  reveal(CUST, { relPath: "f.txt" }),
  reveal(CUST, { relPath: "sub" }),
  reveal(CUST, { relPath: "../" }),
  reveal(CUST, { relPath: "nope" }),
  reveal("cust_..%2F..%2Fesc", {}),
  reveal("cust_nosrc", {}),
  reveal("cust_zzz", {}),
  reveal("cust_zzz", { root: "x" }),
  reveal("cust_x", {}),
  reveal("cust_w00000000001", {}),
  reveal("cust_", {}),
  FS.write(INDEX, "null"),
  reveal(CUST, {}),
  FS.write(INDEX, "{"),
  reveal(CUST, {}),
  FS.json(INDEX, { version: 1, customizations: [null, { id: CUST }], publishes: [] }),
  reveal(CUST, {}),
  FS.json(INDEX, { version: 1, customizations: [{ id: CUST }, null], publishes: [] }),
  reveal(CUST, {}),
  FS.json(INDEX, { version: 1, customizations: [{ id: CUST }] }),
  reveal(CUST, {}),
  FS.json(INDEX, { version: 1.0, customizations: [{ id: CUST }], publishes: {} }),
  reveal(CUST, {}),
  FS.json(INDEX, { version: 2, customizations: [{ id: CUST }], publishes: [] }),
  reveal(CUST, {}),
  FS.rm(INDEX),
  FS.mkdir(INDEX),
  reveal(CUST, {}),
  FS.rm(INDEX),
  reveal(CUST, {}),
  FS.json(INDEX, { version: 1, customizations: [{ id: CUST, name: "back" }], publishes: [] }),
  reveal(CUST, { relPath: "f.txt" }),
  // The launcher: spawn errors `revealOnHost` throws or never listens to.
  BIN_STEP("missing"),
  RV({}),
  RV({ relPath: "a.txt" }),
  BIN_STEP("noexec"),
  RV({}),
  BIN_STEP("dir"),
  RV({}),
  BIN_STEP("badinterp"),
  RV({}),
  BIN_STEP("noshebang"),
  {
    ...RV({ relPath: "a.txt" }),
    as: { bin: "fake" },
    why: "std's fork + execvp runs an executable without a shebang through /bin/sh; Node's spawn() throws spawn ENOEXEC",
  },
  BIN_STEP("fake"),
  RV({ relPath: "a.txt" }),
];

/** The descriptors past 0-2 the shell holds. */
const FD_PROBE = "f=3; while [ $f -lt 256 ]; do [ -e /dev/fd/$f ] && printf '%s ' $f; f=$((f+1)); done; printf end";
const S1 = W(1);
const SH = (command) => shell(S1, command);
const BIG = 16 * 1024 * 1024;
const SHELLS = [
  // Bodies and validation (the workspace is looked up first).
  T(`/api/workspaces/${S1}/shell`, ""),
  T(`/api/workspaces/${S1}/shell`, "{"),
  T(`/api/workspaces/${S1}/shell`, "null"),
  T(`/api/workspaces/${S1}/shell`, "[]"),
  T(`/api/workspaces/${S1}/shell`, '"printf x"'),
  T(`/api/workspaces/${S1}/shell`, "5"),
  J(`/api/workspaces/${S1}/shell`, {}),
  ...["", "   ", "\n\t\r", `${cp(0xa0, 0xfeff, 0x2028, 0x2029, 0x3000, 0x1680, 0x205f)}`, 5, null, true, ["printf x"], { c: 1 }].map(SH),
  X(`/api/workspaces/${S1}/shell`, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"command":"printf bom"}')]).toString("hex")),
  T(`/api/workspaces/${S1}/shell`, '{"command":"printf a","command":"printf b"}'),
  shell("wks_r99999999999", "printf x"),
  T("/api/workspaces/wks_r99999999999/shell", "null"),
  shell(CUST, "printf x"),
  shell("cust_w00000000001", "pwd"),
  // What runs.
  ...[
    "printf out; printf err >&2",
    "pwd",
    'printf %s "$WSR_MARK"',
    'printf "%s|" "$0" "$#" "$@"',
    "exit 7",
    "exit 300",
    "kill -TERM $$",
    "kill -KILL $$",
    "kill -USR1 $$",
    "kill -HUP $$",
    "kill -INT $$",
    "nosuchcmd-d02 2>/dev/null; printf %s $?",
    "cd /; pwd",
    "printf '\\303\\251\\360\\237\\230\\200'",
    "printf '\\377\\376\\303'",
    "printf '\\342\\202x'; printf '\\342\\202' >&2",
    `printf '%s' '${UNI}'`,
    "printf 'a\\0b'",
    "printf '\\r\\n\\033[31mred\\033[0m'",
    "[ -p /dev/stdin ] && printf stdin-pipe",
    FD_PROBE,
    "[ \"$(/bin/ps -o pgid= -p $$ | /usr/bin/tr -d ' ')\" = \"$$\" ] && printf leader",
    "(/bin/sleep 0.3; printf late) & printf early",
    "/bin/sleep 3 >/dev/null 2>&1 & printf quick",
    "open -a Terminal .",
    "osascript -e 'tell application \"Terminal\" to do script \"echo hi\"'",
    "open a; open -R \"$PWD/a.txt\"; xdg-open .",
    "echo multi\necho line",
    // Output caps: 16 Mi UTF-16 units per stream.
    `/usr/bin/head -c ${BIG + 10} /dev/zero | /usr/bin/tr '\\0' a`,
    `/usr/bin/head -c ${BIG} /dev/zero | /usr/bin/tr '\\0' a >&2`,
    `/usr/bin/head -c ${BIG - 1} /dev/zero | /usr/bin/tr '\\0' a; printf '\\360\\237\\230\\200'`,
  ].map(SH),
  T(`/api/workspaces/${S1}/shell`, `{"command":"printf '%s' '${esc("d800")}x'"}`),
  T(`/api/workspaces/${S1}/shell`, `{"command":"printf a${esc("0000")}b"}`),
  // Where it runs: `ws.rootPath` as `spawn()` takes it.
  ...[2, 3, 4, 5, 15, 16, 17, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 33, 34, 35, 36].map((n) => shell(W(n), "pwd")),
];

const STEPS = [
  ...WORLD,
  // ---- roots
  ...ALL_IDS.map(roots),
  ...SETTINGS_SHAPES,
  // ---- reveal
  ...REVEALS,
  // ---- shell
  ...SHELLS,
  // ---- a store that doesn't load
  FS.write(STORE, "null"),
  roots(P1),
  reveal(P1, {}),
  reveal(CUST, {}),
  shell(P1, "printf x"),
  FS.write(STORE, "{"),
  roots(P1),
  reveal(P1, {}),
  shell(P1, "printf x"),
  FS.json(STORE, { version: 1, workspaces: [null, ws(1)] }),
  roots(P1),
  reveal(P1, {}),
  shell(P1, "printf x"),
  FS.rm(STORE),
  roots(P1),
  reveal(P1, {}),
  shell(P1, "printf x"),
  FS.chmod(`${R}/noperm`, 0o755),
];

// ------------------------------- run the steps -------------------------------

async function request(s) {
  const [mod, params] = routeFor(s.path);
  const headers = {};
  let body;
  if (s.body !== undefined) body = real(s.body);
  else if (s.bodyHex !== undefined) body = Buffer.from(real(s.bodyHex), "hex");
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest(`http://localhost${s.path}`, { method: s.method, headers, body });
  let got;
  try {
    const res = await mod.handle(req, context(params));
    got = { status: res.status, type: res.headers.get("content-type") };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 65536) got.sha256 = `${sha(buf)}:${buf.length}`;
    else got.body = fake(buf.toString("utf8"));
  } catch (e) {
    got = { threw: fake(e instanceof Error ? e.message : String(e)) };
  }
  // Let a spawn `error` event (next tick) land.
  await new Promise((r) => setImmediate(r));
  await pause(20);
  const fired = uncaught.splice(0);
  // A reveal that answered `{ok: true}` with no spawn error launched once.
  const launches = s.path.endsWith("/reveal") && got.body === '{"ok":true}' && fired.length === 0 ? 1 : 0;
  const t0 = Date.now();
  let launched = takeRecords();
  while (launched.length < launches && Date.now() - t0 < 10_000) {
    await pause(10);
    launched = launched.concat(takeRecords());
  }
  if (launched.length !== launches && s.path.endsWith("/reveal")) throw new Error(`launches ${JSON.stringify(s)}`);
  const step = { got, launched };
  if (fired.length) step.uncaught = fired.map(fake);
  const reachedHost = s.path.endsWith("/reveal") && (launches === 1 || fired.length > 0 || (got.status === 500 && got.type === "application/json"));
  if (reachedHost) step.os = true;
  return step;
}

let currentBin = "fake";
const steps = [];
for (const raw of STEPS) {
  const s = { ...raw };
  if (s.op === "fs") {
    const p = real(s.path);
    if (s.act === "write") {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s.hex !== undefined ? Buffer.from(s.hex, "hex") : real(s.text));
    } else if (s.act === "mkdir") mkdirSync(p, { recursive: true });
    else if (s.act === "rm") rmSync(p, { recursive: true, force: true });
    else if (s.act === "symlink") symlinkSync(real(s.target), p);
    else if (s.act === "chmod") chmodSync(p, s.mode);
    steps.push(s);
    continue;
  }
  if (s.op === "bin") {
    installBin(s.kind);
    currentBin = s.kind;
    steps.push(s);
    continue;
  }
  const step = { ...s, ...(await request(s)) };
  if (s.as) {
    installBin(s.as.bin);
    const again = await request(s);
    installBin(currentBin);
    step.gotAs = again.got;
    step.launchedAs = again.launched;
    if (again.uncaught) step.uncaughtAs = again.uncaught;
  }
  steps.push(step);
}
await pause(300);
if (takeRecords().length) throw new Error("a launch nobody asked for");
if (uncaught.length) throw new Error(`stray uncaught: ${uncaught}`);

// ------------------------------- execShellCommand -------------------------------

const P = `${R}/p1`;
const EXEC = [
  // The per-stream cap, in UTF-16 units.
  [P, "printf abcdef", { maxOutputBytes: 4 }],
  [P, "printf abcd", { maxOutputBytes: 4 }],
  [P, "printf ab; printf cdef >&2", { maxOutputBytes: 3 }],
  [P, "printf '\\303\\251\\360\\237\\230\\200x'", { maxOutputBytes: 2 }],
  [P, "printf '\\303\\251\\360\\237\\230\\200x'", { maxOutputBytes: 3 }],
  [P, "printf '\\303\\251\\360\\237\\230\\200x'", { maxOutputBytes: 4 }],
  [P, "printf '\\303\\251\\360\\237\\230\\200x'", { maxOutputBytes: 1 }],
  [P, "printf ab; /bin/sleep 0.1; printf cd; /bin/sleep 0.1; printf ef", { maxOutputBytes: 3 }],
  [P, "printf abc; /bin/sleep 0.1; printf d", { maxOutputBytes: 3 }],
  [P, "printf abc; /bin/sleep 0.1; printf d >&2", { maxOutputBytes: 3 }],
  [P, "printf x", { maxOutputBytes: 0 }],
  [P, "true", { maxOutputBytes: 0 }],
  [P, `/usr/bin/head -c ${70_000} /dev/zero | /usr/bin/tr '\\0' b`, { maxOutputBytes: 65_537 }],
  // Decoding across reads.
  [P, "printf '\\342'; /bin/sleep 0.1; printf '\\202\\254'", {}],
  [P, "printf '\\342\\202'", {}],
  [P, "printf '\\342\\202x\\355\\240\\200\\300\\257'", {}],
  [P, "printf '\\360\\237'; /bin/sleep 0.1; printf '\\230\\200'", { maxOutputBytes: 1 }],
  // The timeout: SIGTERM to the group, then SIGKILL 1.5 s later (CC 2.1.300).
  [P, "/bin/sleep 5", { timeoutMs: 300 }],
  [P, "printf before; /bin/sleep 5; printf after", { timeoutMs: 500 }],
  // A command that outruns the TERM but finishes inside the 1.5 s grace
  // (`trap '' TERM` is inherited, so the sleep ignores TERM too).
  [P, "trap '' TERM; /bin/sleep 0.6; printf survived", { timeoutMs: 500 }],
  // Past the grace the group is SIGKILLed: the shell itself, and a `&` job
  // that would otherwise hold the stdio pipes (and the answer) open.
  [P, "trap '' TERM; while :; do /bin/sleep 1; done", { timeoutMs: 300 }],
  [P, "(trap '' TERM; while :; do /bin/sleep 1; done) & printf early", { timeoutMs: 300 }],
  [P, "trap 'printf got-term; exit 3' TERM; /bin/sleep 5 & wait", { timeoutMs: 1000 }],
  [P, "(/bin/sleep 5; printf never) & printf early", { timeoutMs: 1000 }],
  [P, "/bin/cat", { timeoutMs: 300 }],
  // stdin.
  [P, "/bin/cat", { stdin: `line1\nline2\n${UNI}` }],
  [P, "/bin/cat", { stdin: "" }],
  [P, "read -r a; printf '[%s]' \"$a\"", { stdin: "p'w\"$x\nrest" }],
  [P, "exit 0", { stdinRepeat: ["x", 1 << 20] }],
  [P, "/bin/cat", { stdin: `${unit(0xd800)}|${emoji}` }],
  // Node destroys stdin once the shell exits: a job still reading it ends.
  [P, "exec 3<&0; (/bin/cat <&3 >/dev/null; printf done) & exit 0", { timeoutMs: 5000 }],
  // Nothing past 0-2 reaches the shell.
  [P, FD_PROBE, {}],
  // Exit codes and signals.
  [P, "exit 0", {}],
  [P, "exit 42", {}],
  [P, "kill -TERM $$", {}],
  [P, "kill -KILL $$", {}],
  [P, "kill -USR2 $$", {}],
  [P, "kill -SEGV $$", {}],
  [P, "kill -ABRT $$", {}],
  // Where and whether it spawns.
  [`${R}/missing`, "printf x", {}],
  [`${R}/file.txt`, "printf x", {}],
  [`${R}/loop`, "printf x", {}],
  [`${R}/${LONG}`, "printf x", {}],
  [P, `printf a${unit(0)}b`, {}],
  [`${P}${unit(0)}`, "printf x", {}],
  [`${P}${unit(0)}`, `a${unit(0)}`, {}],
  ["", "printf x", {}],
  [null, "printf x", {}],
  [undefined, "printf x", {}],
  [5, "printf x", {}],
  [true, "printf x", {}],
  [[P], "printf x", {}],
  [{}, "printf x", {}],
  [fileUrl(), "pwd", {}],
  [fileUrl({ pathname: `${R}/p1%2f` }), "pwd", {}],
  [fileUrl({ protocol: "http:" }), "pwd", {}],
  [fileUrl({ path: "x" }), "pwd", {}],
  [fileUrl({ href: "" }), "pwd", {}],
];
const exec = [];
for (const [cwd, command, opts] of EXEC) {
  const c = { command, opts };
  if (cwd !== undefined) c.cwd = cwd;
  const realCwd = cwd === undefined ? undefined : JSON.parse(real(JSON.stringify(cwd)));
  // `stdinRepeat: [text, n]` is `stdin: text.repeat(n)`, kept short here.
  const { stdinRepeat, ...realOpts } = opts;
  if (stdinRepeat) realOpts.stdin = stdinRepeat[0].repeat(stdinRepeat[1]);
  let got;
  try {
    const r = await execShellCommand(realCwd, real(command), realOpts);
    got = JSON.parse(fake(JSON.stringify(r)));
  } catch (e) {
    got = { threw: fake(e instanceof Error ? e.message : String(e)) };
  }
  exec.push({ ...c, got });
}

const fixture = {
  platform: process.platform,
  cwd: "$ROOT/project",
  mark: process.env.WSR_MARK,
  fake: FAKE,
  bins: BINS,
  launchers: LAUNCHERS,
  steps,
  exec,
};
writeFileSync(join(ROOT, "out.json"), JSON.stringify(fixture));
process.exit(0);
