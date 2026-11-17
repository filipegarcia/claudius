#!/usr/bin/env node
// Golden fixture for the customization preview routes (D15):
// `app/api/customizations/[id]/preview/route.ts` (GET / POST / DELETE),
// `[id]/preview/restart/route.ts` (POST) and the preview stop of
// `[id]/route.ts` (DELETE), over `lib/server/preview-server.ts`.
//
//   node rust/scripts/customization-preview-golden.mjs   (node@22)
//
// Re-runs itself twice under `--experimental-transform-types`, each time in
// a fresh temp root with HOME at <root>/home, CLAUDE_CONFIG_DIR at
// <root>/config, CLAUDIUS_LIVE_SOURCE at <root>/live and the cwd at the
// repo. Both recordings must agree byte for byte.
//
// Never a real Next, and never the 3100-3199 range: the load hook below
// rewrites preview-server.ts's `PORT_START` / `PORT_END` (3100 / 3199) to
// a block of 8 free ports picked here (CLAUDIUS_PREVIEW_PORTS gives the
// Rust server its own block). `node_modules/.bin/next` is a shell wrapper
// that execs `claudius-fake-next` (built here from claudius-agent): it logs
// its argv, cwd and env to <root>/logs/next.log, listens on `[::]:<port>`
// and registers its pid in <root>/lsof/<port>, prints scripted chunks and
// waits for SIGTERM. `lsof` is a fake too: it logs its argv and lists the
// live pids registered for the port, so the sweeps never see (or kill) a
// process that isn't this recording's. `process.execPath` is set to
// <root>/app/claudius, as the Rust server's own binary isn't a `node`.
//
// The world (`world`: dirs, the fakes, the live `node_modules`) is rebuilt
// before each of the `groups`, which run in order, each with its own `PATH`
// and extra env (`env`: leaked parent variables the preview env must scrub
// or keep). A group's steps:
// * `fs`: write (with `mode`) / mkdir / rm / symlink / chmod;
// * `req`: a request through Next's route module. It records `got`
//   (status, content type, normalized body, or `threw` for Next's empty
//   500) and, when they changed, `tree` (the customizations dir), `lsof`
//   and `bun` (the fakes' logs) and `sleepers` (whether each squatter is
//   alive);
// * `wait`: poll the preview state until its `status` and / or `logs`
//   count is reached; records `next` (the fake next's new log lines: a
//   spawn's line lands after its request returns);
// * `sleep`, `squat` (a `sleep 600` registered on a port), `plant` (lines
//   for a port's lsof answer; `self` is the server's own pid), `listen` /
//   `unlisten` (hold `::` or `127.0.0.1` on a port) and `gone` (wait until
//   the last pid a body showed for an id is dead).
// Every pid is `$PID<n>` and every `startedAt` `$T<n>`, numbered by first
// appearance within a group; a port is `$P<k>` (k from the block start);
// the root is `$ROOT` and the system dir `resolveNodeDir` falls back to is
// `$SYSNODE`. Strings stay ASCII here: non-ASCII text is built with
// String.fromCodePoint.
//
// Written to rust/crates/claudius-server/tests/fixtures/customization_preview_golden.json;
// replayed by crates/claudius-server/tests/customization_preview.rs.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, register } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/customization_preview_golden.json");
const BLOCK = 8;

// ------------------------------- the fakes -------------------------------

/** `node_modules/.bin/next` (via `next/dist/bin/next`): the fake binary. */
const NEXT_WRAPPER = `#!/bin/sh
FAKE_NEXT_ARGV0="$0" exec "$FAKE_NEXT_BIN" "$@"
`;

/**
 * `lsof -nP -iTCP -iTCP:<port> -sTCP:LISTEN -t`: logs its argv, prints the
 * live pids of $FAKE_LSOF_DIR/<port> and any other line as it is, exits 1
 * when it printed nothing (or with <port>.exit's code).
 */
const FAKE_LSOF = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG_DIR/lsof.log"
port=""
for a in "$@"; do
  case "$a" in
    -iTCP:*) port="\${a#-iTCP:}" ;;
  esac
done
f="$FAKE_LSOF_DIR/$port"
n=0
if [ -f "$f" ]; then
  while IFS= read -r line; do
    case "$line" in
      ''|*[!0-9]*) printf '%s\\n' "$line"; n=$((n+1)) ;;
      *) if kill -0 "$line" 2>/dev/null; then printf '%s\\n' "$line"; n=$((n+1)); fi ;;
    esac
  done < "$f"
fi
if [ -f "$f.exit" ]; then
  read code < "$f.exit"
  exit "$code"
fi
[ "$n" -gt 0 ] || exit 1
exit 0
`;

/** A `node` for `resolveNodeDir` to find; never run. */
const FAKE_NODE = `#!/bin/sh
exit 0
`;

/** The line every fake bun logs first. */
const BUN_LOG = `printf '%s argv=%s cwd=%s PORT=%s NODE_ENV=%s TEL=%s TURBO=%s PACKAGED=%s LEAK=%s PATH=%s\\n' "$0" "$*" "$(pwd -P)" "$PORT" "$NODE_ENV" "$NEXT_TELEMETRY_DISABLED" "\${TURBOPACK-unset}" "\${CLAUDIUS_PACKAGED-unset}" "\${LEAK_KEEP-unset}" "$PATH" >> "$FAKE_LOG_DIR/bun.log"`;

const BUN_FAIL = `#!/bin/sh
${BUN_LOG}
printf 'l1\\nl2\\r\\n\\nl3\\nl4\\n'
printf 'e1\\ne2\\n' >&2
exit 2
`;

/** Puts the stripped packages back (from the live tree) and the PostCSS plugin. */
const BUN_OK = `#!/bin/sh
${BUN_LOG}
mkdir -p node_modules/next/dist/cli node_modules/next/dist/bin node_modules/.bin node_modules/@tailwindcss/postcss
cp "$CLAUDIUS_LIVE_SOURCE/node_modules/next/dist/bin/next" node_modules/next/dist/bin/next
chmod 755 node_modules/next/dist/bin/next
printf '//\\n' > node_modules/next/dist/cli/next-dev.js
printf '//\\n' > node_modules/@tailwindcss/postcss/index.js
ln -s ../next/dist/bin/next node_modules/.bin/next
printf 'installed 3 packages\\n'
exit 0
`;

const BUN_READY = `#!/bin/sh
${BUN_LOG}
printf 'Ready? no\\n' >&2
exit 1
`;

const BUN_SIGNAL = `#!/bin/sh
${BUN_LOG}
printf 'resolving\\nfetching\\n'
kill -TERM $$
sleep 5
`;

const SYS_TOOLS = ["sh", "mkdir", "ln", "cp", "chmod", "cat", "rm", "sleep"];

async function canListen(port, host) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen({ port, host }, () => s.close(() => res(true)));
  });
}

/** A start port whose 8-port block is free on `::` and 127.0.0.1. */
async function freeBlock() {
  for (let tries = 0; tries < 200; tries++) {
    const start = 21000 + Math.floor(Math.random() * 18000);
    let ok = true;
    for (let p = start; ok && p < start + BLOCK; p++) {
      ok = (await canListen(p, "::")) && (await canListen(p, "127.0.0.1"));
    }
    if (ok) return start;
  }
  throw new Error("no free port block");
}

if (!process.env.PREVIEW_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-next"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fakeNext = join(rustDir, "target/debug/claudius-fake-next");
  const runs = [];
  for (let n = 0; n < 2; n++) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "preview-golden-")));
    const start = await freeBlock();
    try {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: `${join(root, "fakebin")}:${join(root, "sysbin")}`,
            HOME: join(root, "home"),
            CLAUDIUS_STATE_HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            CLAUDIUS_LIVE_SOURCE: join(root, "live"),
            CLAUDIUS_PREVIEW_PORTS: `${start}-${start + BLOCK - 1}`,
            FAKE_NEXT_BIN: fakeNext,
            FAKE_LSOF_DIR: join(root, "lsof"),
            FAKE_LOG_DIR: join(root, "logs"),
            TZ: "UTC",
            PREVIEW_GOLDEN_CHILD: root,
            PREVIEW_GOLDEN_START: String(start),
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      runs.push(readFileSync(join(root, "out.json"), "utf8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  if (runs[0] !== runs[1]) {
    const dir = process.env.PREVIEW_GOLDEN_DIFF_DIR;
    if (dir) runs.forEach((r, i) => writeFileSync(join(dir, `run${i}.json`), r));
    throw new Error("the two recordings differ");
  }
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.groups.reduce((n, g) => n + g.steps.length, 0);
  const reqs = fixture.groups.reduce((n, g) => n + g.steps.filter((s) => s.op === "req").length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.groups.length} groups, ${steps} steps (${reqs} requests) (stable)`,
  );
  process.exit(0);
}

// ------------------------------- the child -------------------------------

const ROOT = process.env.PREVIEW_GOLDEN_CHILD;
const START = Number(process.env.PREVIEW_GOLDEN_START);
const END = START + BLOCK - 1;
const FAKE = process.env.FAKE_NEXT_BIN;

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
}
export async function load(url, ctx, next) {
  if (url.endsWith("/lib/server/preview-server.ts")) {
    const r = await next(url, ctx);
    const text = typeof r.source === "string" ? r.source : new TextDecoder().decode(r.source);
    const from = ["const PORT_START = 3100;", "const PORT_END = 3199;"];
    const to = ["const PORT_START = ${START};", "const PORT_END = ${END};"];
    let source = text;
    for (let i = 0; i < 2; i++) {
      if (source.split(from[i]).length !== 2) throw new Error("preview-server.ts: no single " + from[i]);
      source = source.replace(from[i], to[i]);
    }
    return { ...r, source, shortCircuit: true };
  }
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

// The Rust server's own binary is no `node`: resolveNodeDir must scan PATH.
process.execPath = join(ROOT, "app", "claudius");

const require = createRequire(join(repo, "package.json"));
const { AppRouteRouteModule } = require("next/dist/server/route-modules/app-route/module.js");
const { NextRequest } = require("next/server.js");
const preview = await import(join(repo, "lib/server/preview-server.ts"));

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
const api = join(repo, "app/api/customizations");
const PR = "/api/customizations/[id]";
const ROUTES = {
  cust: routeModule(await import(join(api, "[id]/route.ts")), PR),
  preview: routeModule(await import(join(api, "[id]/preview/route.ts")), `${PR}/preview`),
  restart: routeModule(await import(join(api, "[id]/preview/restart/route.ts")), `${PR}/preview/restart`),
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
function routeFor(path) {
  const segs = path.split("/").slice(3);
  const params = { id: decodeURIComponent(segs[0]) };
  if (segs.length === 1) return [ROUTES.cust, params];
  return [segs[2] === "restart" ? ROUTES.restart : ROUTES.preview, params];
}

// ------------------------------- steps -------------------------------

const cp = (...cps) => String.fromCodePoint(...cps);
const R = "$ROOT";
const CR = `${R}/home/.claude/.claudius/customizations`;
const IDX = `${CR}/index.json`;
const SRC = (id) => `${CR}/${id}/src`;
const NM = (id) => `${SRC(id)}/node_modules`;
const LIVE_NM = `${R}/live/node_modules`;
const C = "/api/customizations";
const P = (id) => `${C}/${encodeURIComponent(id)}/preview`;

const REQ = (method, path) => ({ op: "req", method, path });
const G = (id) => REQ("GET", P(id));
const POST = (id) => REQ("POST", P(id));
const DEL = (id) => REQ("DELETE", P(id));
const RESTART = (id) => REQ("POST", `${P(id)}/restart`);
const DELC = (id) => REQ("DELETE", `${C}/${encodeURIComponent(id)}`);
const FS = {
  write: (path, text, mode) => ({ op: "fs", act: "write", path, text, ...(mode ? { mode } : {}) }),
  json: (path, value) => ({ op: "fs", act: "write", path, text: JSON.stringify(value) }),
  mkdir: (path) => ({ op: "fs", act: "mkdir", path }),
  rm: (path) => ({ op: "fs", act: "rm", path }),
  link: (path, target) => ({ op: "fs", act: "symlink", path, target }),
  chmod: (path, mode) => ({ op: "fs", act: "chmod", path, mode }),
  tool: (name) => ({ op: "fs", act: "systool", name }),
};
const W = (id, until) => ({ op: "wait", id, until });
const SLEEP = (ms) => ({ op: "sleep", ms });
const SQUAT = (port) => ({ op: "squat", port });
const PLANT = (port, lines) => ({ op: "plant", port, lines });
const LISTEN = (port, host) => ({ op: "listen", port, host });
const UNLISTEN = { op: "unlisten" };
const GONE = (id) => ({ op: "gone", id });
const LSOF = (k) => `${R}/lsof/$P${k}`;

const seed = (ids) =>
  FS.json(IDX, { version: 1, customizations: ids.map((id) => ({ id, name: `n ${id}` })), publishes: [] });
const mirror = (id) => FS.write(`${SRC(id)}/app/page.tsx`, "export default 1;\n");
const conf = (id, c) => FS.json(`${SRC(id)}/fake-next.json`, c);
/** Run a preview to its ready lines, then stop it. */
const runAndStop = (id, logs = 2) => [POST(id), W(id, { logs }), G(id), DEL(id), W(id, { status: "exited" })];
/** A mirror whose node_modules is a real dir without the PostCSS plugin. */
const depsMirror = (id) => [
  mirror(id),
  FS.write(`${NM(id)}/next/dist/cli/next-dev.js`, "//\n"),
  FS.write(`${NM(id)}/next/dist/bin/next`, NEXT_WRAPPER, 0o755),
  FS.link(`${NM(id)}/.bin/next`, "../next/dist/bin/next"),
  FS.write(`${NM(id)}/react/index.js`, "//\n"),
  FS.write(`${NM(id)}/scheduler/index.js`, "//\n"),
  FS.write(`${NM(id)}/zod/index.js`, "//\n"),
];

const WORLD = [
  ...["home", "config", "project", "live", "fakebin", "fakebin2", "sysbin", "lsof", "logs", "app"].map((d) =>
    FS.mkdir(`${R}/${d}`),
  ),
  FS.write(`${R}/fakebin/lsof`, FAKE_LSOF, 0o755),
  FS.write(`${R}/fakebin/node`, FAKE_NODE, 0o755),
  FS.write(`${R}/fakebin2/lsof`, FAKE_LSOF, 0o755),
  ...SYS_TOOLS.map(FS.tool),
  FS.write(`${LIVE_NM}/next/package.json`, '{"name":"next"}\n'),
  FS.write(`${LIVE_NM}/next/dist/cli/next-dev.js`, "// fake\n"),
  FS.write(`${LIVE_NM}/next/dist/bin/next`, NEXT_WRAPPER, 0o755),
  FS.link(`${LIVE_NM}/.bin/next`, "../next/dist/bin/next"),
  FS.write(`${LIVE_NM}/@tailwindcss/postcss/index.js`, "// fake\n"),
  FS.write(`${LIVE_NM}/react/index.js`, "// fake\n"),
];

const LEAKS = {
  __NEXT_PRIVATE_STANDALONE_CONFIG: "{}",
  __NEXT_PRIVATE_ORIGIN: "http://localhost:1",
  __NEXT_PRIVATEX: "kept",
  __next_private_lower: "kept",
  TURBOPACK: "1",
  CLAUDIUS_PACKAGED: "1",
  CLAUDIUS_ELECTRON: "1",
  CLAUDIUS_OTHER: "kept",
  NEXT_DEPLOYMENT_ID: "dep",
  NEXT_OTHER: "kept",
  NODE_ENV: "production",
  PORT: "9999",
  NEXT_TELEMETRY_DISABLED: "0",
  LEAK_KEEP: "kept",
};

const UID = `c ${cp(0xfc)}/y`;
const MAIN = [
  // No index yet: an empty store, so every route is 404.
  G("nope"),
  POST("nope"),
  DEL("nope"),
  RESTART("nope"),
  // An index the store can't read: Next's empty 500.
  FS.mkdir(IDX),
  G("c1"),
  POST("c1"),
  DEL("c1"),
  RESTART("c1"),
  FS.rm(IDX),
  seed(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "cw", "cg", "c9", "cx", "cs", "cf", "ce", "ct"]
    .concat(["cb1", "cb2", "cb3", "cb4", "cb5", "cb6", "cd", "../x", UID])),
  // Nothing tracked: the empty state, and a stop that does nothing.
  G("c1"),
  DEL("c1"),
  // No mirror, or a file where it should be.
  POST("c1"),
  RESTART("c1"),
  FS.write(SRC("c1"), "not a dir"),
  POST("c1"),
  FS.rm(SRC("c1")),
  // A first start: node_modules mirrored from live, the first port, the
  // scrubbed env (the fake's next.log line).
  mirror("c1"),
  POST("c1"),
  W("c1", { logs: 2 }),
  G("c1"),
  // Running: answered as it is (no spawn).
  POST("c1"),
  // Ready only at stderr's "- READY -"; the other lines don't match.
  mirror("c2"),
  conf("c2", {
    chunks: [
      "boot {port}\n",
      { err: "warn: Already done\n" },
      "readyz x_ready unready ready_ ready1\n",
      "started  server; startedserver; listen\n",
      { err: "- READY -\n" },
      "after\n",
    ],
  }),
  POST("c2"),
  W("c2", { logs: 6 }),
  G("c2"),
  // Never ready.
  mirror("c3"),
  conf("c3", { chunks: ["compiling\n", "still compiling\n"] }),
  POST("c3"),
  W("c3", { logs: 2 }),
  G("c3"),
  // Stop: SIGTERM and the state of that moment; then the exit.
  DEL("c1"),
  W("c1", { status: "exited" }),
  G("c1"),
  DEL("c1"),
  // A new start of an exited preview: fresh logs, its old port reaped first.
  POST("c1"),
  W("c1", { logs: 2 }),
  G("c1"),
  // Restart a running preview (stop, 600 ms, reap, sweep, start).
  RESTART("c2"),
  W("c2", { logs: 6 }),
  G("c2"),
  // The sweep kills an unowned squatter (then a second pass), never this
  // process or a tracked preview, and nothing for lines that aren't int32
  // pids or name no process.
  SQUAT(4),
  PLANT(3, [" 2147483648", "abc", "12.5", "1e9", "-5", "0x7fffffff", "Infinity", "  ", ""]),
  PLANT(5, ["self"]),
  RESTART("c3"),
  W("c3", { logs: 2 }),
  G("c3"),
  FS.rm(LSOF(3)),
  FS.rm(LSOF(5)),
  // An lsof that lists a pid but exits 1 lists nothing.
  SQUAT(6),
  FS.write(`${LSOF(6)}.exit`, "1\n"),
  RESTART("c3"),
  W("c3", { logs: 2 }),
  FS.rm(`${LSOF(6)}.exit`),
  DEL("c2"),
  W("c2", { status: "exited" }),
  DEL("c3"),
  W("c3", { status: "exited" }),
  // The newest 200 lines.
  mirror("c4"),
  conf("c4", {
    chunks: [
      Array.from({ length: 250 }, (_, i) => `line ${i}\n`).join("") + "ready\n",
    ],
  }),
  POST("c4"),
  W("c4", { status: "ready" }),
  G("c4"),
  DEL("c4"),
  W("c4", { status: "exited" }),
  // CRLF, lines cut across chunks, a character cut across chunks, stderr.
  mirror("c5"),
  conf("c5", {
    chunks: [
      "a\r\nb\r\n\r\n",
      "partial ",
      "line\n",
      { hex: "c3" },
      { hex: "a90a" },
      `${cp(0x20ac)} ${cp(0xfc)} ${cp(0x1f600)}\n`,
      { err: "e1\r\n" },
      { errHex: "ff0a" },
      "ready\n",
    ],
  }),
  POST("c5"),
  W("c5", { logs: 10 }),
  G("c5"),
  DEL("c5"),
  W("c5", { status: "exited" }),
  // An exit code, and a SIGTERM handler that exits 0.
  mirror("c6"),
  conf("c6", { go: { code: 3, chunks: ["bye\n"] } }),
  POST("c6"),
  W("c6", { logs: 2 }),
  FS.write(`${SRC("c6")}/go`, ""),
  W("c6", { status: "exited" }),
  G("c6"),
  mirror("c7"),
  conf("c7", { term: "exit:0" }),
  ...runAndStop("c7"),
  G("c7"),
  // A child that ignores SIGTERM: DELETE leaves it running (no SIGKILL);
  // restart's reap of its port kills it (SIGTERM, then SIGKILL).
  mirror("c8"),
  conf("c8", { term: "ignore" }),
  POST("c8"),
  W("c8", { logs: 2 }),
  DEL("c8"),
  SLEEP(1200),
  G("c8"),
  conf("c8", {}),
  RESTART("c8"),
  W("c8", { logs: 2 }),
  G("c8"),
  DEL("c8"),
  W("c8", { status: "exited" }),
  // A child that takes 200 ms to exit on SIGTERM: restart's 600 ms grace
  // sees it gone before the old port is reaped (one lsof call there).
  mirror("cw"),
  conf("cw", { term: "slow:200" }),
  POST("cw"),
  W("cw", { logs: 2 }),
  RESTART("cw"),
  W("cw", { logs: 2 }),
  DEL("cw"),
  W("cw", { status: "exited" }),
  G("cw"),
  // A worker grandchild keeps the port after the dev server exits: the next
  // start reaps it and takes the port back.
  mirror("cg"),
  conf("cg", { grandchild: true }),
  POST("cg"),
  W("cg", { logs: 2 }),
  DEL("cg"),
  W("cg", { status: "exited" }),
  conf("cg", {}),
  POST("cg"),
  W("cg", { logs: 2 }),
  G("cg"),
  DEL("cg"),
  W("cg", { status: "exited" }),
  // A restart with nothing tracked, and one whose start fails.
  mirror("c9"),
  RESTART("c9"),
  W("c9", { logs: 2 }),
  G("c9"),
  DEL("c9"),
  W("c9", { status: "exited" }),
  RESTART("cx"),
  G("cx"),
  // No free port: the exited entry is dropped all the same.
  DEL("c1"),
  W("c1", { status: "exited" }),
  ...Array.from({ length: BLOCK }, (_, k) => LISTEN(k, "::")),
  POST("c1"),
  G("c1"),
  UNLISTEN,
  // An older bootstrap's node_modules symlink is replaced by a copy.
  mirror("cs"),
  FS.link(`${NM("cs")}`, LIVE_NM),
  ...runAndStop("cs"),
  // node_modules a file: the copy's mkdir fails.
  mirror("cf"),
  FS.write(NM("cf"), "x"),
  POST("cf"),
  G("cf"),
  // No .bin/next (ENOENT), then a non-executable one (EACCES): `starting`
  // with no pid, the error right after. A failed preview starts again.
  mirror("ce"),
  FS.write(`${NM("ce")}/next/dist/cli/next-dev.js`, "//\n"),
  FS.write(`${NM("ce")}/@tailwindcss/postcss/index.js`, "//\n"),
  POST("ce"),
  G("ce"),
  DEL("ce"),
  POST("ce"),
  G("ce"),
  FS.write(`${NM("ce")}/.bin/next`, NEXT_WRAPPER, 0o644),
  POST("ce"),
  G("ce"),
  FS.chmod(`${NM("ce")}/.bin/next`, 0o755),
  ...runAndStop("ce"),
  // .bin a file: spawn() throws ENOTDIR.
  mirror("ct"),
  FS.write(`${NM("ct")}/next/dist/cli/next-dev.js`, "//\n"),
  FS.write(`${NM("ct")}/@tailwindcss/postcss/index.js`, "//\n"),
  FS.write(`${NM("ct")}/.bin`, "x"),
  POST("ct"),
  G("ct"),
  // An incomplete toolchain with no bun anywhere: a [deps] line, the start
  // goes on.
  ...depsMirror("cb1"),
  ...runAndStop("cb1", 3),
  // A failing bun on PATH: the stripped packages go first, .bin/next too.
  FS.write(`${R}/fakebin/bun`, BUN_FAIL, 0o755),
  ...depsMirror("cb2"),
  POST("cb2"),
  G("cb2"),
  // HOME's bun beats PATH's, and completes the toolchain.
  FS.write(`${R}/home/.bun/bin/bun`, BUN_OK, 0o755),
  ...depsMirror("cb3"),
  ...runAndStop("cb3", 3),
  // A failing bun whose tail says "Ready": `ready` before the spawn fails.
  FS.write(`${R}/home/.bun/bin/bun`, BUN_READY, 0o755),
  ...depsMirror("cb4"),
  POST("cb4"),
  G("cb4"),
  // A bun killed by a signal: code null.
  FS.write(`${R}/home/.bun/bin/bun`, BUN_SIGNAL, 0o755),
  ...depsMirror("cb5"),
  POST("cb5"),
  G("cb5"),
  // A bun that can't be run: spawnSync's EACCES, no output.
  FS.chmod(`${R}/home/.bun/bin/bun`, 0o644),
  ...depsMirror("cb6"),
  POST("cb6"),
  G("cb6"),
  FS.rm(`${R}/home/.bun`),
  FS.rm(`${R}/fakebin/bun`),
  // Deleting the customization stops its preview first.
  mirror("cd"),
  POST("cd"),
  W("cd", { logs: 2 }),
  DELC("cd"),
  GONE("cd"),
  G("cd"),
  // An id whose mirror is outside the root.
  G("../x"),
  POST("../x"),
  RESTART("../x"),
  DEL("../x"),
  // Unicode and a slash in the id.
  mirror(UID),
  ...runAndStop(UID),
];

const NONODE = [
  seed(["c1", "cb"]),
  // No node on PATH: the system dir comes first.
  mirror("c1"),
  ...runAndStop("c1"),
  // A `bun` that is a directory: spawnSync's EACCES.
  FS.mkdir(`${R}/fakebin2/bun`),
  ...depsMirror("cb"),
  POST("cb"),
  G("cb"),
];

const ODD_PATH = [
  FS.mkdir(`${R}/empty`),
  FS.mkdir(`${R}/nodedir/node`),
  FS.write(`${R}/bunbin/bun`, BUN_OK, 0o755),
  seed(["c1"]),
  // A dir named node counts; the PATH entry is kept as written. The bun
  // path is joined (normalized).
  ...depsMirror("c1"),
  ...runAndStop("c1", 3),
];

const DARWIN = [
  seed(["c1", "c2"]),
  mirror("c1"),
  mirror("c2"),
  // The probe binds `::`: a listener on 127.0.0.1 alone doesn't make the
  // port taken (macOS), one on `::` does.
  LISTEN(0, "127.0.0.1"),
  POST("c1"),
  W("c1", { logs: 2 }),
  G("c1"),
  LISTEN(1, "::"),
  POST("c2"),
  W("c2", { logs: 2 }),
  G("c2"),
  DEL("c1"),
  W("c1", { status: "exited" }),
  DEL("c2"),
  W("c2", { status: "exited" }),
  UNLISTEN,
];

const GROUPS = [
  { name: "main", path: [`${R}/fakebin`, `${R}/sysbin`], env: LEAKS, steps: MAIN },
  { name: "nonode", path: [`${R}/fakebin2`, `${R}/sysbin`], env: {}, steps: NONODE },
  {
    name: "oddpath",
    path: ["", `${R}/empty`, `${R}/nodedir`, `${R}//bunbin/./`, `${R}/fakebin`, `${R}/sysbin`],
    env: { LEAK_KEEP: "kept" },
    steps: ODD_PATH,
  },
  { name: "darwin", darwin: true, path: [`${R}/fakebin`, `${R}/sysbin`], env: {}, steps: DARWIN },
];

// ------------------------------- the harness -------------------------------

const SYSNODE = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].find((d) => existsSync(join(d, "node"))) ?? null;
const real = (s) => s.replaceAll("$ROOT", ROOT).replace(/\$P(\d+)/g, (_, k) => String(START + Number(k)));

let tokens;
const tok = (map, prefix, v) => {
  if (!map.has(v)) map.set(v, `${prefix}${map.size}`);
  return map.get(v);
};
function normStr(s) {
  let t = s.replaceAll(ROOT, "$ROOT").replaceAll(FAKE, "$FAKE");
  if (SYSNODE) t = t.replaceAll(`${SYSNODE}:`, "$SYSNODE:");
  return t.replace(/\d+/g, (m) => {
    const n = Number(m);
    return String(n) === m && n >= START && n <= END ? `$P${n - START}` : m;
  });
}
function normValue(v, top) {
  if (Array.isArray(v)) return v.map((x) => normValue(x, false));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (top && k === "pid" && typeof x === "number") o[k] = tok(tokens.pid, "$PID", x);
      else if (top && k === "port" && typeof x === "number") o[k] = normStr(String(x));
      else if (top && k === "startedAt" && typeof x === "number") o[k] = tok(tokens.time, "$T", x);
      else o[k] = normValue(x, false);
    }
    return o;
  }
  return typeof v === "string" ? normStr(v) : v;
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const CR_REAL = () => real(CR);
/** The customizations dir as nested names ("l>target", file text or sha256). */
function tree(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return `l>${normStr(readlinkSync(path))}`;
  if (!st.isDirectory()) {
    let text;
    try {
      text = normStr(readFileSync(path, "utf8"));
    } catch {
      return "f!";
    }
    const mode = (st.mode & 0o111) !== 0 ? "x:" : "";
    return text.length <= 2000 ? `${mode}${text}` : `${mode}sha256:${sha(text)}:${text.length}`;
  }
  let names;
  try {
    names = readdirSync(path).sort();
  } catch {
    return "d!";
  }
  const o = {};
  for (const n of names) o[normStr(n)] = tree(join(path, n));
  return o;
}
const treeText = () => JSON.stringify(tree(CR_REAL()));

/** New lines of a fake's log since the last read. */
const logAt = {};
function takeLog(name) {
  const file = join(ROOT, "logs", name);
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const from = logAt[name] ?? 0;
  logAt[name] = text.length;
  return text.slice(from).split("\n").filter(Boolean);
}
const nextPids = [];
function takeNext() {
  return takeLog("next.log").map((l) => {
    const v = JSON.parse(l);
    nextPids.push(v.pid);
    delete v.pid;
    return normValue(v, false);
  });
}

function lsofFiles() {
  const dir = join(ROOT, "lsof");
  try {
    return readdirSync(dir)
      .filter((n) => !n.endsWith(".exit"))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Drop the dead pids from the lsof files (the fake lsof skips them anyway). */
function prune() {
  for (const f of lsofFiles()) {
    const lines = readFileSync(f, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const keep = lines.filter((l) => !/^[0-9]+$/.test(l) || alive(Number(l)));
    if (keep.length !== lines.length) writeFileSync(f, keep.map((l) => `${l}\n`).join(""));
  }
}

function applyFs(s) {
  if (s.act === "systool") {
    for (const dir of ["/bin", "/usr/bin"]) {
      if (existsSync(join(dir, s.name))) {
        symlinkSync(join(dir, s.name), join(ROOT, "sysbin", s.name));
        return;
      }
    }
    throw new Error(`no ${s.name}`);
  }
  const p = real(s.path);
  if (s.act === "write") {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, s.text);
    if (s.mode) chmodSync(p, s.mode);
  } else if (s.act === "mkdir") mkdirSync(p, { recursive: true });
  else if (s.act === "rm") rmSync(p, { recursive: true, force: true });
  else if (s.act === "symlink") {
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(real(s.target), p);
  } else if (s.act === "chmod") chmodSync(p, s.mode);
}

let sleepers = [];
let listeners = [];
/** The pid the last body showed for each id. */
let lastPid = {};

async function runRequest(s) {
  const [mod, params] = routeFor(s.path);
  const req = new NextRequest(`http://localhost${s.path}`, { method: s.method });
  try {
    const res = await mod.handle(req, context(params));
    const got = { status: res.status, type: res.headers.get("content-type") };
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
    try {
      const v = JSON.parse(text);
      if (v && typeof v.pid === "number") lastPid[params.id] = v.pid;
      got.body = JSON.stringify(normValue(v, true));
    } catch {
      got.body = normStr(text);
    }
    return got;
  } catch (e) {
    return { threw: normStr(e instanceof Error ? e.message : String(e)) };
  }
}

async function waitFor(s) {
  for (let i = 0; i < 1200; i++) {
    const st = preview.getPreviewState(s.id);
    const okStatus = s.until.status === undefined || st.status === s.until.status;
    const okLogs = s.until.logs === undefined || st.logs.length >= s.until.logs;
    if (okStatus && okLogs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`wait ${s.id} ${JSON.stringify(s.until)}: ${JSON.stringify(preview.getPreviewState(s.id))}`);
}

async function hold(port, host) {
  const srv = createServer();
  await new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen({ port: START + port, host }, res);
  });
  listeners.push(srv);
}

/**
 * Kill every process this group left: the tracked previews (a replaced one
 * is dead by then), the squatters, and any other live pid an lsof file
 * holds (pruned after every step, so no pid there has been reused).
 */
async function endGroup() {
  const entries = globalThis.__claudiusPreviewEntries;
  for (const e of entries?.values() ?? []) {
    try {
      e.child.kill("SIGKILL");
    } catch {
      // gone
    }
  }
  for (const sl of sleepers) sl.proc.kill("SIGKILL");
  const pids = new Set();
  for (const f of lsofFiles()) {
    for (const l of readFileSync(f, "utf8").split("\n")) if (/^[0-9]+$/.test(l)) pids.add(Number(l));
  }
  pids.delete(process.pid);
  pids.delete(process.ppid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (let i = 0; i < 400; i++) {
    const running = [...(entries?.values() ?? [])].some((e) => e.status === "starting" || e.status === "ready");
    if (!running && sleepers.every((sl) => sl.dead) && [...pids].every((p) => !alive(p))) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  entries?.clear();
  for (const l of listeners) await new Promise((r) => l.close(r));
  listeners = [];
  sleepers = [];
  nextPids.length = 0;
}

const recorded = {
  block: BLOCK,
  sysNode: SYSNODE !== null,
  fakes: { lsof: FAKE_LSOF, node: FAKE_NODE, next: NEXT_WRAPPER },
  world: WORLD,
  groups: [],
};
const ownKeys = Object.keys(LEAKS);
for (const g of GROUPS) {
  for (const d of ["home", "config", "project", "live", "fakebin", "fakebin2", "sysbin", "lsof", "logs", "app"])
    rmSync(join(ROOT, d), { recursive: true, force: true });
  for (const d of ["empty", "nodedir", "bunbin"]) rmSync(join(ROOT, d), { recursive: true, force: true });
  for (const k of Object.keys(logAt)) delete logAt[k];
  for (const s of WORLD) applyFs(s);
  for (const k of ownKeys) delete process.env[k];
  Object.assign(process.env, g.env);
  process.env.PATH = g.path.map(real).join(":");
  tokens = { pid: new Map(), time: new Map() };
  lastPid = {};
  const steps = [];
  let lastTree = treeText();
  let lastSleepers = "[]";
  for (const s of g.steps) {
    const step = { ...s };
    if (s.op === "fs") {
      applyFs(s);
      lastTree = treeText();
    } else if (s.op === "req") {
      step.got = await runRequest(s);
      const lsof = takeLog("lsof.log").map(normStr);
      if (lsof.length) step.lsof = lsof;
      const bun = takeLog("bun.log").map(normStr);
      if (bun.length) step.bun = bun;
    } else if (s.op === "wait") {
      await waitFor(s);
      const next = takeNext();
      if (next.length) step.next = next;
    } else if (s.op === "sleep") {
      await new Promise((r) => setTimeout(r, s.ms));
    } else if (s.op === "squat") {
      const proc = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
      const sl = { proc, dead: false };
      proc.once("exit", () => {
        sl.dead = true;
      });
      sleepers.push(sl);
      const f = join(ROOT, "lsof", String(START + s.port));
      writeFileSync(f, `${existsSync(f) ? readFileSync(f, "utf8") : ""}${proc.pid}\n`);
    } else if (s.op === "plant") {
      const lines = s.lines.map((l) => (l === "self" ? String(process.pid) : l));
      writeFileSync(join(ROOT, "lsof", String(START + s.port)), lines.map((l) => `${l}\n`).join(""));
    } else if (s.op === "listen") {
      await hold(s.port, s.host);
    } else if (s.op === "unlisten") {
      for (const l of listeners) await new Promise((r) => l.close(r));
      listeners = [];
    } else if (s.op === "gone") {
      const pid = lastPid[s.id];
      for (let i = 0; alive(pid); i++) {
        if (i > 400) throw new Error(`${s.id} (${pid}) never died`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    if (s.op !== "fs") {
      const now = treeText();
      if (now !== lastTree) step.tree = JSON.parse(now);
      lastTree = now;
      const sl = JSON.stringify(sleepers.map((x) => !x.dead));
      if (s.op === "req" && sl !== lastSleepers) step.sleepers = JSON.parse(sl);
      lastSleepers = sl;
    }
    prune();
    steps.push(step);
  }
  await endGroup();
  const rec = { name: g.name, path: g.path, env: g.env, steps };
  if (g.darwin) rec.darwin = true;
  recorded.groups.push(rec);
}

writeFileSync(join(ROOT, "out.json"), JSON.stringify(recorded));
process.exit(0);
