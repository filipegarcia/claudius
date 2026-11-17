#!/usr/bin/env node
// Golden fixture for the updater's second half (D27b): `POST
// /api/updater/apply` over the real `lib/server/updater/{apply,restart,
// git,detect,settings,root,spawn-env}.ts`, and the scheduler
// (`lib/server/updater/scheduler.ts`):
//
//   node rust/scripts/updater-apply-golden.mjs     (node@22)
//
// Re-runs itself twice under `--experimental-transform-types` (two temp
// roots; both recordings must agree byte for byte), with a resolve hook for
// the `@/` imports and a pinned environment: HOME, XDG_CONFIG_HOME and
// CLAUDE_CONFIG_DIR under the root, no system git config,
// GIT_CEILING_DIRECTORIES at the root, a fixed author, committer and date
// (stable hashes), LANG / LC_ALL = C, TZ = UTC, CLAUDIUS_UPDATER_DISABLED=1,
// and PATH = `$ROOT/xbin`, the system dirs, then the three absolute dirs
// `extendedPath` would prepend (so it only ever prepends `$HOME/.bun/bin`).
// The four vars `envForBunPhase` scrubs are set (`scrub`). `Date.now` and
// `new Date()` run on a counter: each request one millisecond after the one
// before (T0 + n, printed `$T<n>`); ISO dates print as `$ISO`, the root as
// `$ROOT`, this process's pid as `$PID`. The thread pool has one thread, so
// the apply's fire-and-forget log appends land in the order they were made.
//
// SAFETY: the apply stashes, pulls, merges and resets. Every install root is
// `$ROOT/current`, a symlink to a throwaway clone under the temp root, and
// `assertSafe` checks that (through the link) before every request; the
// fake `git` and `bun` refuse to run outside the root.
//
// The world:
// * `$ROOT/remote.git` (bare) is upstream; `seed` pushes to it; each scenario
//   clones a fresh install (`i<n>`) and points `current` at it.
// * `$ROOT/home/.bun/bin/git`: a logging pass-through to the real git (its
//   `scenario.sh` can answer some argv instead), first on the extended PATH;
//   `home/.bun/bin/bun`: a fake bun that logs and runs `bun-scenario.sh`.
//   Both append to `home/.bun/bin/calls.log`: cwd, argv, then the env bits
//   the updater sets (NODE_ENV and the scrubbed vars for bun;
//   GIT_TERMINAL_PROMPT, GIT_ASKPASS and PATH's first entry for both).
//   The bun line is followed by `updater.json` as it is mid-apply.
// * `$ROOT/claude-wrap` is the `claude` the apply's Claude sessions run (the
//   SDK's `pathToClaudeCodeExecutable` here, `--claude-bin` in the replay):
//   it logs `claude <cwd>` and `updater.json` there too, counts launches in
//   `claude-n`, sources `claude-pre.sh` (real git work: a merge, a resolve)
//   and execs the fake CLI (`claudius-fake-claude`, `$FAKE_CLAUDE_SCRIPT` =
//   claude-script.json).
// * restart: `restart.ts`'s detached spawn and its 1.5 s self-SIGTERM are
//   recorded, not run, one JSON line each in `$ROOT/restart.log`, as the
//   Rust server's `CLAUDIUS_DEV_RESTART_LOG` boundary writes them. `setsid`
//   is found when `$ROOT/xbin/setsid` exists.
//
// Parts:
// * `phases[].steps`: world ops as in updater-golden.mjs (`git`, `write`,
//   `rm`, `mkdir`, `link`, `chmod`; `begin` marks a scenario's start, a
//   fresh clone and settings, so a replay can pick scenarios) and
//   requests: `req` (body text or
//   `bodyHex`; `got` = status, content type and body text, or `threw`), and
//   `together` (n at once). After each: `tree` (the install's `git status
//   --porcelain -b -uall`, stash list and last three commits; null outside a
//   repo), `file` (updater.json: text, null,
//   `"<dir>"`), `log` (the install's `.claudius/logs/updater.log`, then
//   removed), `restart` (restart.log, then removed), `calls` (calls.log,
//   then removed) and `claude` (the prompts the fake CLI was sent and its
//   last argv, then removed).
// * `scheduler`: cases on a fresh `UpdaterScheduler` each, with fake timers
//   and a stub `applyUpdate` (it only records). Ops: world ops, `boot`
//   (`disabled` = $CLAUDIUS_UPDATER_DISABLED, `mirror` = inside a
//   customization mirror), `tick` (a source; `nonRoot`: only holds for a
//   user a 0444 mode locks out), `fire` (the k-th timer set),
//   `race` (a check in flight, then a manual tick); each with the `events`
//   it caused (`{set: delay}`, `{clear: k}`, `"apply"`), `file` and `calls`.
// * `pure`: `pickStrategy` over the pendings a check writes, and
//   `envForBunPhase`.
//
// Written to rust/crates/claudius-core/tests/fixtures/updater_apply_golden.json;
// replayed by crates/claudius-server/tests/updater_apply.rs (`phases`, on the
// real binary) and crates/claudius-core/tests/updater_scheduler.rs
// (`scheduler`, `pure`).
import { spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/updater_apply_golden.json");

/** The pinned environment; `$ROOT` is the temp root. Mirrored by the replays. */
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
  CLAUDIUS_UPDATER_DISABLED: "1",
  FAKE_CLAUDE_SCRIPT: "$ROOT/claude-script.json",
  FAKE_CLAUDE_LOG: "$ROOT/claude-stdin.log",
  FAKE_CLAUDE_ARGV: "$ROOT/claude-argv.json",
};
/** What `envForBunPhase` scrubs, set so the fake bun can see it go. */
const SCRUB = {
  __NEXT_PRIVATE_STANDALONE_CONFIG: "{}",
  __NEXT_PRIVATE_ORIGIN: "http://localhost:1",
  TURBOPACK: "1",
  NEXT_DEPLOYMENT_ID: "dep-1",
};
/** `spawn-env.ts` ABSOLUTE_LOCATIONS: on PATH already, so never prepended. */
const ABS = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
const SYS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

if (!process.env.UPD_APPLY_GOLDEN_CHILD) {
  const base = [...SYS, ...ABS].join(":");
  const which = (cmd) =>
    spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { env: { PATH: base }, encoding: "utf8" }).stdout.trim();
  const realGit = which("git");
  if (!realGit) throw new Error("no git on PATH");
  // The fake bun / the missing-bun steps rely on there being no real one.
  for (const cmd of ["bun", "setsid", "claude"]) {
    if (which(cmd)) throw new Error(`a real ${cmd} is on ${base}; the recording needs it absent`);
  }
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const cli = join(rustDir, "target/debug/claudius-fake-claude");
  const texts = [];
  for (let run = 0; run < 2; run++) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "updater-apply-golden-")));
    const outDir = mkdtempSync(join(tmpdir(), "updater-apply-golden-out-"));
    try {
      const env = {
        PATH: `${root}/xbin:${base}`,
        REAL_GIT: realGit,
        GOLDEN_FAKE_CLI: cli,
        UV_THREADPOOL_SIZE: "1",
        GOLDEN_TMP: realpathSync(tmpdir()),
        UPD_APPLY_GOLDEN_CHILD: root,
        UPD_APPLY_GOLDEN_OUT: join(outDir, "out.json"),
      };
      for (const [k, v] of Object.entries(ENV)) env[k] = v.replaceAll("$ROOT", root);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        { cwd: repo, stdio: "inherit", env },
      );
      // `process.exit` skips the `finally`: clean the temp root first.
      if (r.status !== 0) {
        rmSync(root, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
        process.exit(r.status ?? 1);
      }
      texts.push(readFileSync(join(outDir, "out.json"), "utf8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  }
  if (texts[0] !== texts[1]) {
    writeFileSync(`${out}.run2`, texts[1]);
    writeFileSync(out, texts[0]);
    throw new Error(`the two runs differ: diff ${out} ${out}.run2`);
  }
  writeFileSync(out, texts[0]);
  const fx = JSON.parse(texts[0]);
  const n = fx.phases.reduce((a, p) => a + p.steps.filter((s) => s.op === "req" || s.op === "together").length, 0);
  console.log(`wrote ${out}: ${n} apply requests, ${fx.scheduler.length} scheduler cases (two runs identical)`);
  process.exit(0);
}

const ROOT = process.env.UPD_APPLY_GOLDEN_CHILD;
const REAL_GIT = process.env.REAL_GIT;
const TMP = process.env.GOLDEN_TMP;
if (!ROOT.startsWith(TMP + "/")) throw new Error(`root ${ROOT} is not under ${TMP}`);

// ------------------------------- module hooks -------------------------------

const SDK = "@anthropic-ai/claude-agent-sdk";
const realSdk = import.meta.resolve(SDK);
const shimDir = realpathSync(mkdtempSync(join(tmpdir(), "updater-apply-golden-shim-")));
const sdkShim = join(shimDir, "sdk-shim.mjs");
writeFileSync(
  sdkShim,
  `import * as real from ${JSON.stringify(realSdk)};
export * from ${JSON.stringify(realSdk)};
export function query(args) {
  return real.query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: process.env.GOLDEN_CLAUDE } });
}
`,
);
// restart.ts: the detached restarter is recorded, not spawned.
const cpShim = join(shimDir, "cp-shim.mjs");
writeFileSync(
  cpShim,
  `import * as real from "node:child_process";
import { appendFileSync } from "node:fs";
export * from "node:child_process";
export function spawn(cmd, args, opts) {
  if (cmd === "setsid" || cmd === "nohup") {
    const spawn = { program: cmd, args, detached: opts.detached, stdio: opts.stdio, PATH: opts.env.PATH };
    appendFileSync(process.env.GOLDEN_RESTART_LOG, JSON.stringify({ spawn }) + "\\n");
    return { unref() {} };
  }
  return real.spawn(cmd, args, opts);
}
`,
);
// scheduler.ts: applyUpdate only records.
const applyStub = join(shimDir, "apply-stub.mjs");
writeFileSync(
  applyStub,
  `export function applyUpdate(opts) {
  globalThis.__goldenSchedApply(opts);
  return Promise.resolve({ kind: "no-update" });
}
`,
);

const hook = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = ${JSON.stringify(pathToFileURL(repo + "/").href)};
const SDK_SHIM = ${JSON.stringify(pathToFileURL(sdkShim).href)};
const CP_SHIM = ${JSON.stringify(pathToFileURL(cpShim).href)};
const APPLY_STUB = ${JSON.stringify(pathToFileURL(applyStub).href)};
export async function resolve(spec, ctx, next) {
  const parent = (ctx.parentURL || "").split("?")[0];
  if (spec === ${JSON.stringify(SDK)} && parent.endsWith("/lib/server/updater/apply.ts")) {
    return { url: SDK_SHIM, shortCircuit: true };
  }
  if (spec === "node:child_process" && parent.endsWith("/lib/server/updater/restart.ts")) {
    return { url: CP_SHIM, shortCircuit: true };
  }
  if (spec === "./apply" && parent.endsWith("/lib/server/updater/scheduler.ts")) {
    return { url: APPLY_STUB, shortCircuit: true };
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

// ------------------------------- clock, timers -------------------------------

const T0 = 1_800_000_000_000;
let clock = T0;
const RealDate = Date;
class PinnedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock);
    else super(...args);
  }
  static now() {
    return clock;
  }
}
globalThis.Date = PinnedDate;
// readUpdaterFile warns on a file it can't read; the scheduler on a failed
// tick. The replays don't compare logs.
console.warn = () => {};

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** The scheduler's timers, captured (see `scheduler` below). */
let schedTimers = [];
let schedEvents = [];
const fakeTimer = Symbol("fake timer");
globalThis.setTimeout = function (fn, delay, ...rest) {
  const stack = new Error().stack ?? "";
  if (stack.includes("/lib/server/updater/scheduler.ts")) {
    const t = { [fakeTimer]: schedTimers.length, fn, unref() {}, ref() {}, hasRef: () => false };
    schedTimers.push(t);
    schedEvents.push({ set: delay });
    return t;
  }
  if (delay === 1500 && stack.includes("/lib/server/updater/restart.ts")) {
    // scheduleSelfExit: run it with process.kill caught, record the signal.
    const realKill = process.kill;
    let signal = null;
    process.kill = (pid, sig) => {
      if (pid !== process.pid) throw new Error(`restart signalled ${pid}`);
      signal = sig;
      return true;
    };
    try {
      fn();
    } finally {
      process.kill = realKill;
    }
    writeFileSync(process.env.GOLDEN_RESTART_LOG, JSON.stringify({ selfExit: { delayMs: delay, signal } }) + "\n", {
      flag: "a",
    });
    return { unref() {}, ref() {}, hasRef: () => false };
  }
  return realSetTimeout(fn, delay, ...rest);
};
globalThis.clearTimeout = function (t) {
  if (t && typeof t === "object" && fakeTimer in t) {
    schedEvents.push({ clear: t[fakeTimer] });
    return;
  }
  return realClearTimeout(t);
};

process.env.GOLDEN_CLAUDE = join(ROOT, "claude-wrap");
process.env.GOLDEN_RESTART_LOG = join(ROOT, "restart.log");

const mod = (p) => import(pathToFileURL(join(repo, p)).href);
const applyRoute = await mod("app/api/updater/apply/route.ts");
const applyMod = await mod("lib/server/updater/apply.ts");
const rootMod = await mod("lib/server/updater/root.ts");
const detect = await mod("lib/server/updater/detect.ts");
const runtimeDir = await mod("lib/server/runtime-dir.ts");
const custStore = await mod("lib/server/customizations-store.ts");
const custStartup = await mod("lib/server/customizations-startup.ts");
// Set after the imports, so nothing loading reads them.
Object.assign(process.env, SCRUB);

// ------------------------------- text helpers -------------------------------

/** Characters by code point, so this file stays ASCII. */
const ch = (...cps) => String.fromCodePoint(...cps);
const TOKEN_RE = /18000000\d{5}/g;
const ISO_RE = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
const PID_RE = new RegExp(`(?<![0-9A-Za-z_])${process.pid}(?![0-9A-Za-z_])`, "g");
/** `$ROOT` for the root, `$T<n>` for the clock values, `$ISO` for dates. */
function sub(s) {
  return s
    .split(ROOT)
    .join("$ROOT")
    .replace(TOKEN_RE, (m) => `$T${Number(m) - T0}`)
    .replace(ISO_RE, "$ISO");
}
const subPid = (s) => sub(s).replace(PID_RE, "$PID");
function subValue(v, f = sub) {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => subValue(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subValue(x, f)]));
  return v;
}
const P = (rel) => (rel ? join(ROOT, rel) : ROOT);
const SETTINGS = "home/.claude/.claudius/updater.json";
const FAKE_DIR = "home/.bun/bin";
const LOG = "current/.claudius/logs/updater.log";

// ------------------------------- the world -------------------------------

const phases = [];
let cur = null;
let steps = null;
function phase(name) {
  cur = { name, env: { CLAUDIUS_INSTALL_ROOT: "$ROOT/current" }, steps: [] };
  steps = cur.steps;
  phases.push(cur);
  process.env.CLAUDIUS_INSTALL_ROOT = P("current");
}
const op = (s) => steps.push(s);

function git(cwd, ...args) {
  const r = spawnSync(REAL_GIT, args.map((a) => a.replaceAll("$ROOT", ROOT)), { cwd: P(cwd), env: process.env });
  op({ op: "git", cwd, args, fails: r.status !== 0 });
  return r.status === 0;
}
function write(path, text) {
  mkdirSync(dirname(P(path)), { recursive: true });
  writeFileSync(P(path), text);
  op({ op: "write", path, text });
}
function rm(path) {
  rmSync(P(path), { recursive: true, force: true });
  op({ op: "rm", path });
}
function mkdir(path) {
  mkdirSync(P(path), { recursive: true });
  op({ op: "mkdir", path });
}
function link(path, to) {
  rmSync(P(path), { force: true });
  mkdirSync(dirname(P(path)), { recursive: true });
  symlinkSync(to.replaceAll("$ROOT", ROOT), P(path));
  op({ op: "link", path, to });
}
function chmod(path, mode) {
  chmodSync(P(path), mode);
  op({ op: "chmod", path, mode: mode.toString(8) });
}
const target = (name) => link("current", `$ROOT/${name}`);

/** The install root is a throwaway clone under the temp root, or no request runs. */
function assertSafe() {
  const ir = process.env.CLAUDIUS_INSTALL_ROOT;
  if (ir !== P("current") || rootMod.installRoot() !== ir) throw new Error(`install root ${ir}`);
  const real = realpathSync(ir);
  if (!real.startsWith(ROOT + "/")) throw new Error(`install root resolves to ${real}`);
}

function fileState() {
  try {
    const st = lstatSync(P(SETTINGS));
    if (st.isDirectory()) return "<dir>";
    return sub(readFileSync(P(SETTINGS), "utf8"));
  } catch {
    return null;
  }
}
/** A file's text (null when missing), then the file is gone. */
function take(rel, f = sub) {
  let text;
  try {
    if (!lstatSync(P(rel)).isFile()) return null;
    text = readFileSync(P(rel), "utf8");
  } catch {
    return null;
  }
  rmSync(P(rel), { force: true });
  return f(text);
}
/** The prompts the fake CLI was sent (all launches) and its last argv. */
function takeClaude() {
  const log = take("claude-stdin.log", (s) => s);
  const argv = take("claude-argv.json", (s) => s);
  if (log === null && argv === null) return null;
  const prompts = [];
  for (const line of (log ?? "").split("\n")) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type !== "user") continue;
    const c = m.message?.content;
    if (typeof c === "string") prompts.push(sub(c));
    else if (Array.isArray(c)) for (const b of c) if (b?.type === "text") prompts.push(sub(b.text));
  }
  return { prompts, argv: argv === null ? null : subValue(JSON.parse(argv)) };
}
/** The install's git state: status, stashes, the last commits (null outside a repo). */
function treeState() {
  const run = (...args) => {
    const r = spawnSync(REAL_GIT, args, { cwd: P("current"), env: process.env, encoding: "utf8" });
    return r.status === 0 ? r.stdout : `<exit ${r.status}>\n`;
  };
  if (spawnSync(REAL_GIT, ["rev-parse", "--is-inside-work-tree"], { cwd: P("current"), env: process.env }).status !== 0) return null;
  return sub([run("status", "--porcelain", "-b", "-uall"), run("stash", "list", "--format=%gd %s"), run("log", "--format=%h %s", "-3")].join("--\n"));
}
function after(s) {
  s.tree = treeState();
  s.file = fileState();
  s.log = take(LOG);
  s.restart = take("restart.log", subPid);
  s.calls = take(`${FAKE_DIR}/calls.log`);
  s.claude = takeClaude();
}

// ------------------------------- requests -------------------------------

async function call(body) {
  const init = { method: "POST" };
  if (body !== undefined) init.body = body;
  try {
    const res = await applyRoute.POST(new Request("http://localhost/api/updater/apply", init));
    return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}
/** One apply; `body` is raw text, or a Buffer (kept as hex). */
async function apply(label, body) {
  assertSafe();
  clock += 1;
  const got = await call(body === undefined ? undefined : Buffer.from(body));
  const s = { op: "req", label };
  if (Buffer.isBuffer(body)) s.bodyHex = body.toString("hex");
  else if (body !== undefined) s.body = body;
  s.got = subValue(got, subPid);
  after(s);
  op(s);
  return got;
}
/** Several applies at once (single flight). */
async function together(label, n) {
  assertSafe();
  clock += 1;
  const all = await Promise.all(Array.from({ length: n }, () => call(undefined)));
  const s = { op: "together", label, n, got: all.map((g) => subValue(g, subPid)) };
  after(s);
  op(s);
}

// ------------------------------- the fakes -------------------------------

const GUARD = 'case "$(pwd -P)" in "$GIT_CEILING_DIRECTORIES"/*) ;; *) echo "fake: outside the golden root" >&2; exit 97 ;; esac';
const FAKE_GIT = [
  "#!/bin/sh",
  GUARD,
  'd=$(dirname "$0")',
  "{",
  '  printf \'git %s\' "$(pwd -P)"',
  '  for a in "$@"; do printf \' [%s]\' "$a"; done',
  '  printf \' TP=%s AP=%s P0=%s\\n\' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "${PATH%%:*}"',
  '} >> "$d/calls.log"',
  '. "$d/scenario.sh"',
  'exec "$REAL_GIT" "$@"',
  "",
].join("\n");
// The state file as the fakes see it mid-apply (whitespace runs squeezed):
// the `applying` status and its strategy, the check's fresh `pending`.
const SNAP = `  printf '  updater.json: %s\\n' "$(tr -s ' \\n' '  ' 2>/dev/null < "$GIT_CEILING_DIRECTORIES/${SETTINGS}")"`;
const FAKE_BUN = [
  "#!/bin/sh",
  GUARD,
  'd=$(dirname "$0")',
  "{",
  '  printf \'bun %s\' "$(pwd -P)"',
  '  for a in "$@"; do printf \' [%s]\' "$a"; done',
  '  printf \' NODE_ENV=%s\' "${NODE_ENV--}"',
  '  printf \' SC=%s ORIGIN=%s TURBOPACK=%s DEPLOY=%s\' "${__NEXT_PRIVATE_STANDALONE_CONFIG--}" "${__NEXT_PRIVATE_ORIGIN--}" "${TURBOPACK--}" "${NEXT_DEPLOYMENT_ID--}"',
  '  printf \' TP=%s AP=%s P0=%s\\n\' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "${PATH%%:*}"',
  SNAP,
  '} >> "$d/calls.log"',
  '. "$d/bun-scenario.sh"',
  "exit 0",
  "",
].join("\n");
const CLAUDE_WRAP = [
  "#!/bin/sh",
  GUARD,
  'r="$GIT_CEILING_DIRECTORIES"',
  'printf \'claude %s\\n\' "$(pwd -P)" >> "$r/home/.bun/bin/calls.log"',
  `${SNAP} >> "$r/home/.bun/bin/calls.log"`,
  'n=$(( $(cat "$r/claude-n" 2>/dev/null || echo 0) + 1 ))',
  'echo "$n" > "$r/claude-n"',
  'if [ -f "$r/claude-pre.sh" ]; then . "$r/claude-pre.sh"; fi',
  'exec "$GOLDEN_FAKE_CLI" "$@"',
  "",
].join("\n");

const written = new Map();
/** `write`, skipped when the file already holds `text`. */
function put(path, text) {
  if (written.get(path) === text) return;
  write(path, text);
  written.set(path, text);
}
function drop(path) {
  if (!written.has(path)) return;
  rm(path);
  written.delete(path);
}
/** The fake git's answers: `[argv pattern, sh body]` (`*` suffix = prefix). */
function gitScenario(over = []) {
  const lines = ['case "$*" in'];
  for (const [pat, body] of over) {
    const quoted = pat.endsWith(" *") ? `"${pat.slice(0, -2)}"*` : `"${pat}"`;
    lines.push(`  ${quoted}) ${body} ;;`);
  }
  lines.push("  *) ;;", "esac", "");
  put(`${FAKE_DIR}/scenario.sh`, lines.join("\n"));
}
/** The fake bun: `install` / `build` sh bodies. */
function bunScenario({ install = ":", build = ":" } = {}) {
  put(
    `${FAKE_DIR}/bun-scenario.sh`,
    ['case "$1 $2" in', `  "install "*) ${install} ;;`, `  "run build") ${build} ;;`, "esac", ""].join("\n"),
  );
}
function claudeScript(script) {
  if (script === null) drop("claude-script.json");
  else put("claude-script.json", JSON.stringify(script));
}
function claudePre(sh) {
  if (sh === null) drop("claude-pre.sh");
  else put("claude-pre.sh", sh + "\n");
}
function settings(json) {
  if (json === null) {
    if (existsSync(P(SETTINGS)) || lstatSyncSafe(P(SETTINGS))) rm(SETTINGS);
  } else write(SETTINGS, typeof json === "string" ? json : JSON.stringify(json));
}
function lstatSyncSafe(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

let seq = 0;
/**
 * A scenario: settings, the fakes' behaviour, and a fresh install clone at
 * upstream's tip that `current` points at.
 */
function begin({ mode = null, file = null, gitOver = [], bun = {}, claude = null, pre = null, clone = true } = {}) {
  op({ op: "begin" });
  settings(file !== null ? file : mode === null ? null : { mode });
  gitScenario(gitOver);
  bunScenario(bun);
  claudeScript(claude);
  claudePre(pre);
  if (existsSync(P("claude-n"))) rm("claude-n");
  if (!clone) return null;
  const name = `i${++seq}`;
  git("", "clone", "-q", "$ROOT/remote.git", name);
  target(name);
  return name;
}
/** An upstream commit (it must be one: an unchanged file would be no update). */
function up(file, text, msg) {
  write(`seed/${file}`, text);
  git("seed", "add", "-A");
  if (!git("seed", "commit", "-qm", msg)) throw new Error(`up(${file}): nothing to commit`);
  git("seed", "push", "-q", "origin", "main");
}
/** A local commit in an install. */
function local(name, file, text, msg) {
  write(`${name}/${file}`, text);
  git(name, "add", "-A");
  git(name, "commit", "-qm", msg);
}

/** Fake CLI turns. */
const text = (t) => ({ $text: t });
const assistant = (...content) => ({ type: "assistant", message: { role: "assistant", content } });
const bash = (command) => ({ type: "tool_use", id: "tu1", name: "Bash", input: { command } });
const turn = (match, steps, result) => (result === undefined ? { match, steps } : { match, steps, result });
const MERGE = "reconciling this Claudius checkout";
const RESOLVE = "resolving leftover Git conflict markers";
const MERGE_SH = '"$REAL_GIT" merge -q --no-edit origin/main >/dev/null 2>&1';

// ======================================================================
// the world
// ======================================================================

mkdirSync(P("home"), { recursive: true });
mkdirSync(P("servercwd"), { recursive: true });
mkdirSync(P("xbin"), { recursive: true });
process.chdir(P("servercwd"));

phase("apply");
write(`${FAKE_DIR}/git`, FAKE_GIT);
chmod(`${FAKE_DIR}/git`, 0o755);
write(`${FAKE_DIR}/bun`, FAKE_BUN);
chmod(`${FAKE_DIR}/bun`, 0o755);
write("claude-wrap", CLAUDE_WRAP);
chmod("claude-wrap", 0o755);
gitScenario();
bunScenario();

git("", "init", "-q", "--bare", "-b", "main", "remote.git");
git("", "init", "-q", "-b", "main", "seed");
git("seed", "remote", "add", "origin", "$ROOT/remote.git");
write("seed/.gitignore", ".claudius/\nbin/\nnode_modules/\n.next/\n");
write("seed/a.txt", "one\ntwo\nthree\n");
write("seed/package.json", '{\n  "name": "x"\n}\n');
write("seed/bun.lock", "lock 1\n");
git("seed", "add", "-A");
git("seed", "commit", "-qm", "init");
git("seed", "push", "-q", "-u", "origin", "main");

// ---- not a git checkout
mkdir("plain");
begin({ clone: false });
target("plain");
await apply("plain dir: HEAD can't be read outside the try (empty 500)");
settings({ state: { conflicts: { fromSha: "abc1234567", toSha: "t", origin: "stash-ff", detail: "d", detectedAt: 1 } } });
await apply("plain dir with a recorded fromSha: runs install/build, then HEAD throws in init");

// ---- disabled
begin({ mode: "disabled" });
await apply("disabled: skipped before anything runs");

// ---- request bodies (notify-only, dirty and behind: only an override applies)
{
  const i = begin({ mode: "notify-only" });
  up("c.txt", "c\n", "feat: c");
  write(`${i}/a.txt`, "one\ntwo local\nthree\n");
  await apply("body: none (no override)");
  for (const body of [
    "",
    "null",
    "[]",
    '"true"',
    "{bad",
    '{"allowCcMerge":"true"}',
    '{"allowCcMerge":1}',
    '{"allowCcMerge":true,"allowCcMerge":false}',
    '{"__proto__":{"allowCcMerge":true}}',
    '{"allowCcMerge":true} x',
    '[{"allowCcMerge":true}]',
  ]) {
    await apply(`body: ${body || "(empty)"}`, body);
  }
  await apply("body: a BOM, then allowCcMerge true (stash-ff applies)", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"allowCcMerge":true}')]));
}

// ---- nothing to pull
{
  const i = begin();
  await apply("up to date: no-update");
  local(i, "local.txt", "l\n", "local: ahead");
  await apply("ahead only: no-update");
  git(i, "checkout", "-q", "--detach");
  await apply("detached HEAD: skipped");
  git(i, "checkout", "-q", "main");
  git(i, "config", "remote.origin.url", "$ROOT/missing.git");
  await apply("fetch fails: error in detect");
}

// ---- ff-only strategy (a clean fast-forward)
{
  begin({
    bun: {
      install: "printf 'bun install v1\\r\\n'; sleep 0.2; printf 'warn: peer\\r\\nsecond\\n' >&2; sleep 0.2; printf 'done'",
      build: "printf 'built\\n\\n'",
    },
  });
  up("a.txt", "one\ntwo\nthree\nfour\n", "fix: four");
  await apply("ff: a.txt only (frozen, scripts skipped)");
  begin();
  up("bun.lock", "lock 2\n", "chore: lock");
  await apply("ff: bun.lock moved (scripts run)");
  begin();
  up("patches/p.patch", "patch\n", "chore: patch");
  await apply("ff: patches/ moved (scripts run)");
  begin({ gitOver: [["diff --name-only *", "exit 1"]] });
  up("nd.txt", "nd\n", "feat: nd");
  await apply("ff: the native-dep diff fails silently (scripts run)");
  begin({ mode: "ff-only" });
  up("d.txt", "d\n", "feat: d");
  await apply("ff in ff-only mode");
}

// ---- restart
{
  const i = begin();
  up("e.txt", "e\n", "feat: e");
  write(`${i}/.claudius/claudius.pid`, "4242\n");
  write(`${i}/bin/claudiusd`, "#!/bin/sh\nexit 0\n");
  await apply("daemon: restart scheduled (nohup)");
  const j = begin();
  up("f.txt", "f\n", "feat: f");
  write(`${j}/.claudius/claudius.pid`, "4242\n");
  write(`${j}/bin/claudiusd`, "#!/bin/sh\nexit 0\n");
  write("xbin/setsid", "#!/bin/sh\nexit 0\n");
  chmod("xbin/setsid", 0o755);
  await apply("daemon: restart scheduled (setsid)");
  rm("xbin/setsid");
  const k = begin();
  up("g.txt", "g\n", "feat: g");
  write(`${k}/.claudius/claudius.pid`, "4242\n");
  await apply("daemon: no bin/claudiusd (init error after the state says restarting)");
  const l = begin();
  up("h.txt", "h\n", "feat: h");
  write(`${l}/.claudius/claudius.pid`, "4242\n");
  write(`${l}/bin/claudiusd`, "#!/bin/sh\nexit 0\n");
  write(`${l}/.claudius/logs`, "not a dir\n");
  await apply("daemon: .claudius/logs is a file (no log; mkdir fails in init)");
  const m = begin();
  up("j.txt", "j\n", "feat: j");
  write(`${m}/.claudius/claudius.pid`, "abc\n");
  await apply("pid file not a pid: manual restart");
}

// ---- ff pull failures
{
  begin({ gitOver: [["pull --ff-only --quiet origin main", "echo 'fatal: Not possible to fast-forward, aborting.' >&2; exit 128"]] });
  up("k.txt", "k\n", "feat: k");
  await apply("ff: pull refused (stderr)");
  gitScenario([["pull --ff-only --quiet origin main", "exit 1"]]);
  await apply("ff: pull fails silently (the error's message)");
  gitScenario([["pull --ff-only --quiet origin main", "echo dying >&2; kill -9 $$"]]);
  await apply("ff: pull killed");
  gitScenario();
  await apply("ff: pull works again");
}

// ---- stash-ff (dirty, nothing local committed)
{
  const i = begin({ mode: "ff-only" });
  up("l.txt", "l\n", "feat: l");
  write(`${i}/a.txt`, "one\ntwo mine\nthree\n");
  write(`${i}/u.txt`, "untracked\n");
  await apply("stash-ff: tracked + untracked edits come back");

  const j = begin();
  up("a.txt", "one\nTWO upstream\nthree\n", "fix: two upstream");
  write(`${j}/a.txt`, "one\nTWO local\nthree\n");
  claudeScript({ turns: [turn(RESOLVE, [assistant(bash("git  diff\t--check\n  HEAD")), text("\n  Resolved a.txt.  \nRESOLVE_OK")])] });
  claudePre(`printf 'one\\nTWO merged\\nthree\\n' > a.txt; "$REAL_GIT" add a.txt`);
  await apply("stash-ff: pop conflicts, Claude resolves inline (cc-merge)");

  const k = begin({ mode: "ff-only" });
  up("a.txt", "one\nTWO again\nthree\n", "fix: two again");
  write(`${k}/a.txt`, "one\nTWO mine again\nthree\n");
  await apply("stash-ff: pop conflicts, ff-only records them");
  await apply("conflicted tree, ff-only: skipped (conflicts re-recorded)");
  claudeScript({ turns: [turn(RESOLVE, [text("RESOLVE_OK")])] });
  claudePre(`printf 'one\\nTWO resolved\\nthree\\n' > a.txt; "$REAL_GIT" add a.txt`);
  await apply("conflicted tree, a click: Claude resolves, the resume finishes", '{"allowCcMerge":true}');

  const l = begin();
  write(`${l}/n.txt`, "mine\n");
  write(`${l}/a.txt`, "one\ntwo\nthree\nmine\n");
  up("n.txt", "theirs\n", "feat: n");
  await apply("stash-ff: an untracked file upstream now has (a false conflict)");

  const m = begin();
  up("o.txt", "o\n", "feat: o");
  write(`${m}/package.json`, '{\n  "name": "leftover"\n}\n');
  git(m, "stash", "push", "-q", "-m", "claudius-updater-stash");
  write(`${m}/a.txt`, "one\nuser wip\nthree\n");
  git(m, "stash", "push", "-q", "-m", "user wip");
  write(`${m}/u.txt`, "u\n");
  await apply("stash-ff: a leftover updater stash is folded in, a user stash kept");

  begin({ gitOver: [["stash push -u -m claudius-updater-stash", "echo 'error: could not write index' >&2; exit 1"]] });
  up("p.txt", "p\n", "feat: p");
  write(`current/a.txt`, "one\ntwo\nthree\ndirty\n");
  await apply("stash-ff: stash push fails twice (init)");

  // A blocked stash push: an in-progress merge is aborted, then the push
  // is retried (or not: the abort left nothing to stash).
  const once = [["stash push -u -m claudius-updater-stash", 'if [ ! -f "$d/once" ]; then : > "$d/once"; echo "error: once" >&2; exit 1; fi']];
  for (const extra of [false, true]) {
    const n = begin({ gitOver: once });
    git(n, "checkout", "-q", "-b", "side");
    local(n, `side-${extra}.txt`, "side\n", "side: commit");
    git(n, "checkout", "-q", "main");
    up(`v-${extra}.txt`, "v\n", `feat: v ${extra}`);
    git(n, "merge", "-q", "--no-ff", "--no-commit", "side");
    if (extra) write(`${n}/extra.txt`, "extra\n");
    await apply(`stash-ff: the push is blocked once by a merge in progress${extra ? ", still dirty after the abort" : ""}`);
    rm(`${FAKE_DIR}/once`);
  }

  // A leftover updater stash that conflicts: its apply leaves unmerged
  // entries, so the push fails, the index is reset, and the retry stashes
  // the markers, which the pop brings back.
  {
    const o = begin({ mode: "ff-only" });
    up("a.txt", "one\nup2\nthree\n", "fix: up2");
    git(o, "pull", "-q", "--ff-only");
    write(`${o}/a.txt`, "one\nstashed\nthree\n");
    git(o, "stash", "push", "-q", "-m", "claudius-updater-stash");
    git(o, "reset", "-q", "--hard", "HEAD~1");
    write(`${o}/u.txt`, "u\n");
    await apply("stash-ff: a leftover updater stash conflicts (index reset, markers come back)");
  }

  // Two leftover updater stashes: applied oldest first, so each drop
  // leaves the next one's index alone.
  {
    const r = begin();
    up("x2.txt", "x\n", "feat: x2");
    write(`${r}/package.json`, '{\n  "name": "older"\n}\n');
    git(r, "stash", "push", "-q", "-m", "claudius-updater-stash");
    write(`${r}/bun.lock`, "lock newer\n");
    git(r, "stash", "push", "-q", "-m", "claudius-updater-stash");
    write(`${r}/u.txt`, "u\n");
    await apply("stash-ff: two leftover updater stashes, oldest first");
  }

  // The tree's own edit to the file a leftover stash touches: its apply
  // refuses (exit 1, nothing unmerged), so the entry counts as applied and
  // is dropped.
  {
    const q = begin();
    up("w.txt", "w\n", "feat: w");
    write(`${q}/a.txt`, "one\nleft A\nthree\n");
    git(q, "stash", "push", "-q", "-m", "claudius-updater-stash");
    write(`${q}/a.txt`, "one\nleft B\nthree\n");
    await apply("stash-ff: a leftover stash git refuses to apply over the tree is dropped");
  }

  begin({ gitOver: [["pull --ff-only --quiet origin main", "echo 'fatal: refusing' >&2; exit 128"]] });
  up("q.txt", "q\n", "feat: q");
  write(`current/a.txt`, "one\ntwo\nthree\nkept\n");
  await apply("stash-ff: pull fails, the stash is popped back");
}

// ---- cc-merge (diverged)
{
  const diverge = (tag, extra = {}) => {
    const i = begin(extra);
    local(i, `local-${tag}.txt`, "local\n", `local: ${tag}`);
    up(`up-${tag}.txt`, "up\n", `feat: up ${tag}`);
    return i;
  };
  diverge("ok", {
    claude: {
      turns: [
        turn(MERGE, [
          assistant(bash("git status && git   log --oneline HEAD..origin/main\n| head -30"), { type: "text", text: "Merging now." }),
          text("Merged cleanly.\nMERGE_OK"),
        ]),
      ],
    },
    pre: MERGE_SH,
  });
  await apply("cc-merge: MERGE_OK, HEAD moved, clean");

  diverge("fail", { claude: { turns: [turn(MERGE, [text("Could not merge.\nMERGE_FAIL: a.txt")])] }, pre: MERGE_SH });
  await apply("cc-merge: merged but says MERGE_FAIL (first line; no rollback)");

  diverge("nomove", { claude: { turns: [turn(MERGE, [text("MERGE_OK")])] } });
  await apply("cc-merge: HEAD didn't move");

  diverge("dirty", { claude: { turns: [turn(MERGE, [text("MERGE_OK")])] }, pre: `${MERGE_SH}; echo junk > junk.txt` });
  await apply("cc-merge: moved and left dirty (conflicts)");

  diverge("turns", { claude: { turns: [turn(MERGE, [text("working")], { subtype: "error_max_turns", is_error: true, errors: ["  max turns  ", ""] })] } });
  await apply("cc-merge: error_max_turns");

  diverge("exit", { claude: { turns: [turn(MERGE, [{ $stderr: "boom\n" }, { $exit: 3 }])] } });
  await apply("cc-merge: the CLI exits 3");

  diverge("nullsub", { claude: { turns: [turn(MERGE, [text("x")], { subtype: null })] } });
  await apply("cc-merge: a null subtype");
  diverge("objsub", { claude: { turns: [turn(MERGE, [text("x")], { subtype: {} })] } });
  await apply("cc-merge: an object subtype");
  diverge("tostr", { claude: { turns: [turn(MERGE, [text("x")], { subtype: { toString: 1 } })] } });
  await apply("cc-merge: a subtype that can't be a string");
  diverge("result", { claude: { turns: [turn(MERGE, [text("MERGE_FAIL: draft")], "Merged after all.\nMERGE_OK")] }, pre: MERGE_SH });
  await apply("cc-merge: the result's text wins over the last block");
  diverge("numres", { claude: { turns: [turn(MERGE, [text("Gave up.\nMERGE_FAIL: x")], { result: 7 })] }, pre: MERGE_SH });
  await apply("cc-merge: a non-string result keeps the last block");

  const long = "x".repeat(158) + ch(0x1f600) + "tail";
  diverge("blocks", {
    claude: {
      turns: [
        turn(MERGE, [
          { type: "assistant", message: { content: "not blocks" } },
          { type: "assistant", message: null },
          assistant(
            5,
            "s",
            { type: "text", text: 5 },
            { type: "tool_use", name: "Read", input: { command: "x" } },
            { type: "tool_use", name: "Bash", input: { command: 5 } },
            { type: "tool_use", name: 7 },
            bash("a" + ch(0xa0) + ch(0x2028) + "b \t\n c" + "y".repeat(130)),
            { type: "text", text: "   \n\n  " },
            { type: "text", text: ch(0x2028) + " " + long + "\nsecond" },
            { type: "text", text: ch(0xfeff) + "bom gist" + ch(0xfeff) },
          ),
          assistant({ type: "text", text: "before null" }, null),
        ]),
      ],
    },
  });
  await apply("cc-merge: odd blocks, then a null block (TypeError)");

  diverge("click", { mode: "notify-only", claude: { turns: [turn(MERGE, [text("MERGE_OK")])] } });
  await apply("notify-only diverged, no click: skipped");
  await apply("notify-only diverged, a click: cc-merge", '{"allowCcMerge":true}');

  diverge("ffonly", { mode: "ff-only" });
  await apply("ff-only diverged: skipped");
  write("current/a.txt", "one\ntwo\nthree\ndirty\n");
  await apply("ff-only diverged and dirty: skipped");
}

// ---- install / build failures (recoverable)
{
  const errLines = [];
  for (let n = 0; n < 17; n++) errLines.push(`err ${n}`);
  errLines.splice(3, 0, "", "   ");
  errLines.push("y".repeat(399) + ch(0x1f600) + "zz");
  errLines.push("z".repeat(400));
  errLines.push("w".repeat(401));
  const errText = errLines.join("\n").replaceAll(ch(0x1f600), "\\360\\237\\230\\200") + "\\r\\nlast\\377 bad";
  begin({ bun: { install: `printf 'resolving\\nfetching\\n'; sleep 0.2; printf '${errText}' >&2; sleep 0.2; printf 'out tail'; exit 1` } });
  up("r.txt", "r\n", "feat: r");
  await apply("install fails: recovery recorded, tree left advanced");
  bunScenario();
  await apply("resume after the install failure: finishes, recovery cleared");

  begin({ bun: { build: "echo 'error: build broke' >&2; exit 2" } });
  up("s.txt", "s\n", "feat: s");
  await apply("build fails: recovery in build");

  begin({ bun: { install: "echo killed >&2; kill -9 $$" } });
  up("t.txt", "t\n", "feat: t");
  await apply("install killed by a signal: code 1");

  begin();
  up("u2.txt", "u\n", "feat: u2");
  rm(`${FAKE_DIR}/bun`);
  await apply("no bun on PATH: ENOENT with the hint");
  write(`${FAKE_DIR}/bun`, FAKE_BUN);
  chmod(`${FAKE_DIR}/bun`, 0o755);
}

// ---- a conflicted tree at the start
{
  const marked = "one\n<<<<<<< Updated upstream\ntwo\n=======\nTWO\n>>>>>>> Stashed changes\nthree\n";
  const i = begin({ claude: { turns: [turn(RESOLVE, [text("RESOLVE_OK")])] }, pre: "printf 'one\\ntwo\\nthree\\n' > a.txt" });
  write(`${i}/a.txt`, marked);
  await apply("markers at the start: Claude resolves, then the resume finishes");

  const j = begin({ claude: { turns: [turn(RESOLVE, [text("Tried hard\nRESOLVE_FAIL: too tangled")])] } });
  write(`${j}/a.txt`, marked);
  await apply("markers at the start: RESOLVE_FAIL");

  const k = begin({ claude: { turns: [turn(RESOLVE, [text("RESOLVE_OK")])] } });
  write(`${k}/a.txt`, marked);
  write(`${k}/package.json`, '{\n<<<<<<< ours\n  "name": "x"\n=======\n  "name": "y"\n>>>>>>> theirs\n}\n');
  await apply("markers at the start: RESOLVE_OK but the markers stay");

  const l = begin({ claude: { turns: [turn(RESOLVE, [text("x")], { subtype: "error_during_execution", is_error: true, errors: [] })] } });
  write(`${l}/a.txt`, marked);
  await apply("markers at the start: the resolve session errors");

  const m = begin({
    claude: { turns: [turn(RESOLVE, [text("RESOLVE_OK")]), turn(MERGE, [text("MERGE_OK")])] },
    pre: 'if [ "$n" = 1 ]; then "$REAL_GIT" add a.txt; else "$REAL_GIT" commit -q --no-edit; fi',
  });
  local(m, "a.txt", "one\ntwo local commit\nthree\n", "local: a");
  up("a.txt", "one\ntwo upstream commit\nthree\n", "fix: a upstream");
  git(m, "fetch", "-q");
  git(m, "merge", "-q", "origin/main");
  write(`${m}/a.txt`, "one\ntwo both\nthree\n");
  await apply("unmerged index, no markers: resolve, then cc-merge commits the merge");

  const n = begin({
    mode: "ff-only",
    file: { mode: "ff-only", state: { conflicts: { fromSha: "f00", toSha: "t", origin: { toString: 1 }, detail: "d", detectedAt: 1 } } },
  });
  write(`${n}/a.txt`, marked);
  await apply("markers, ff-only, an origin that can't be a string (init)");
}

// ---- odd recorded state on a clean, up-to-date tree
{
  begin({ file: { state: { conflicts: { fromSha: 12345, origin: 7 } } } });
  await apply("recorded fromSha a number: install/build run, then the log line throws");
  begin({ file: { state: { conflicts: { fromSha: ["abcdefg123", "x"], origin: "cc-merge" } } } });
  await apply("recorded fromSha an array");
  begin({ file: { state: { conflicts: null, recovery: { fromSha: "deadbeefdeadbeef", phase: "build" } } } });
  await apply("recorded recovery only: resumes as cc-merge");
  begin({ file: { state: { conflicts: [1], recovery: { fromSha: null } } } });
  await apply("conflicts an array, recovery without fromSha: HEAD is the base");
}

// ---- recorded conflicts on a clean tree are cleared before anything else
{
  const i = begin({
    file: { state: { conflicts: { fromSha: "c0ffee", toSha: "t", origin: "stash-ff", detail: "old", detectedAt: 1 } } },
    bun: { install: "echo 'install broke' >&2; exit 1" },
  });
  git(i, "checkout", "-q", "--detach");
  // Nothing is logged before the install's stderr line, whose append is
  // fire-and-forget. Into a fresh `.claudius/logs` its recursive mkdir is
  // longer than the failure line's, which can then land first (seen under
  // load); the folder already there keeps the order the lines were made in.
  mkdir(`${i}/.claudius/logs`);
  await apply("recorded conflicts, clean and detached: cleared first, then the install fails");
}

// ---- single flight
{
  begin({ gitOver: [["fetch --quiet --no-tags origin main", "sleep 1"]] });
  await together("two applies at once share one run", 2);
}

// ---- the settings file is a directory
{
  begin();
  mkdir(SETTINGS);
  await apply("settings path is a directory: the catch's own write throws (empty 500)");
  rm(SETTINGS);
}

// ---- an unfinished update survives a failed check: it is finished at HEAD
{
  const i = begin({
    file: { state: { recovery: { phase: "build", fromSha: "0123456789abcdef", toSha: "t", detail: "d", detectedAt: 1 } } },
  });
  git(i, "config", "remote.origin.url", "$ROOT/missing.git");
  await apply("recorded recovery, the check fails: finished at HEAD anyway");
}

// ======================================================================
// scheduler
// ======================================================================

const scheduler = [];
let sched = null;
let schedTicks = [];
let schedClears = [];
let schedN = 0;
globalThis.__goldenSchedApply = () => schedEvents.push("apply");
async function newScheduler() {
  delete globalThis.__claudiusUpdaterScheduler;
  const m = await import(`${pathToFileURL(join(repo, "lib/server/updater/scheduler.ts")).href}?n=${++schedN}`);
  sched = m.updaterScheduler;
  const tick = sched.tick.bind(sched);
  sched.tick = (source) => {
    const p = tick(source);
    schedTicks.push(p);
    return p;
  };
  const clear = sched.clearStaleRecovery.bind(sched);
  sched.clearStaleRecovery = () => {
    const p = clear();
    schedClears.push(p);
    return p;
  };
  schedTimers = [];
  schedEvents = [];
}
/** Wait for the ticks and recovery clears in flight. */
async function settle() {
  while (schedTicks.length || schedClears.length) {
    const all = [...schedTicks, ...schedClears];
    schedTicks = [];
    schedClears = [];
    await Promise.all(all);
  }
}
function schedStep(s) {
  s.events = schedEvents;
  schedEvents = [];
  s.file = fileState();
  s.calls = take(`${FAKE_DIR}/calls.log`);
  op(s);
}
async function schedCase(label, body) {
  const c = { label, steps: [] };
  scheduler.push(c);
  steps = c.steps;
  await newScheduler();
  await body();
  await settle();
}
async function boot(disabled, mirror = false) {
  clock += 1;
  if (mirror) process.env.CLAUDIUS_LIVE_SOURCE = join(custStore.customizationsRoot(), "c1", "src");
  else delete process.env.CLAUDIUS_LIVE_SOURCE;
  runtimeDir.resetLiveSourceDirForTests();
  const inside = custStartup.isRunningInsideCustomizationMirror();
  if (inside !== mirror) throw new Error("mirror detection");
  if (disabled === null) delete process.env.CLAUDIUS_UPDATER_DISABLED;
  else process.env.CLAUDIUS_UPDATER_DISABLED = disabled;
  await sched.boot();
  await settle();
  process.env.CLAUDIUS_UPDATER_DISABLED = "1";
  delete process.env.CLAUDIUS_LIVE_SOURCE;
  runtimeDir.resetLiveSourceDirForTests();
  schedStep({ op: "boot", disabled, mirror });
}
async function tick(source, nonRoot = false) {
  assertSafe();
  clock += 1;
  await sched.tick(source);
  await settle();
  schedStep({ op: "tick", source, ...(nonRoot ? { nonRoot } : {}) });
}
async function fire(k) {
  assertSafe();
  clock += 1;
  schedTimers[k].fn();
  await settle();
  schedStep({ op: "fire", timer: k });
}
async function race() {
  assertSafe();
  clock += 1;
  const c = detect.checkForUpdates();
  await sched.tick("manual");
  const check = await c;
  await settle();
  schedStep({ op: "race", check: subValue(check) });
}

const RECOVERY = { lastError: "install: old", recovery: { phase: "install", fromSha: "a", toSha: "b", detail: "d", detectedAt: 1 }, pending: { remoteSha: "r", ahead: 0, behind: 1, dirty: false, branch: "main", upstreamBranch: "origin/main" } };
const behindClone = (tag, mode) => {
  const i = begin({ mode });
  up(`sched-${tag}.txt`, `${tag}\n`, `feat: sched ${tag}`);
  return i;
};

await schedCase("boot: CLAUDIUS_UPDATER_DISABLED=1 does nothing", async () => {
  begin({ file: { state: RECOVERY } });
  await boot("1");
});
await schedCase("boot: inside a customization mirror does nothing", async () => {
  begin({ file: { state: RECOVERY } });
  await boot(null, true);
});
await schedCase("boot: enabled clears a stale recovery, then ticks", async () => {
  begin({ file: { mode: "cc-merge", state: RECOVERY } });
  await boot("0");
  await boot(null);
  await fire(0);
  await fire(1);
});
await schedCase("boot: DISABLED ' 1' is not 1; no recovery leaves the file alone", async () => {
  begin({ file: '{"mode":"notify-only",  "state": {"lastError": "keep"}}' });
  await boot(" 1");
});
await schedCase("boot: a recovery array is cleared too", async () => {
  begin({ file: { state: { recovery: [], lastError: "x" } } });
  await boot(null);
});
await schedCase("boot: no settings file", async () => {
  begin();
  await boot(null);
});
await schedCase("tick: disabled re-arms without checking", async () => {
  begin({ file: { mode: "disabled", intervalHours: 2.5 } });
  await tick("boot");
});
await schedCase("tick: notify-only with an update: no apply", async () => {
  behindClone("notify", "notify-only");
  await tick("daily");
});
await schedCase("tick: ff-only with an update applies (boot: no re-arm)", async () => {
  behindClone("ff", "ff-only");
  await tick("boot");
});
await schedCase("tick: cc-merge with an update applies (daily: no re-arm)", async () => {
  behindClone("cc", null);
  await tick("daily");
});
await schedCase("tick: manual with an update applies and re-arms", async () => {
  behindClone("manual", "cc-merge");
  await tick("manual");
});
await schedCase("tick: up to date and clean re-arms", async () => {
  begin({ mode: "cc-merge" });
  await tick("boot");
  await tick("daily");
});
await schedCase("tick: a stuck tree (markers) applies", async () => {
  const i = begin();
  write(`${i}/a.txt`, "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n");
  await tick("boot");
});
await schedCase("tick: ff-only, a stuck tree applies", async () => {
  const i = begin({ mode: "ff-only" });
  write(`${i}/a.txt`, "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n");
  await tick("daily");
});
await schedCase("tick: notify-only, a stuck tree doesn't", async () => {
  const i = begin({ mode: "notify-only" });
  write(`${i}/a.txt`, "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n");
  await tick("boot");
});
await schedCase("tick: a failed check (no remote) re-arms at the interval", async () => {
  const i = begin({ file: { intervalHours: 3 } });
  git(i, "config", "remote.origin.url", "$ROOT/missing.git");
  await tick("boot");
});
await schedCase("tick: a check that throws re-arms at 24 h", async () => {
  begin();
  mkdir(SETTINGS);
  await tick("boot");
  rm(SETTINGS);
});
await schedCase("tick: a check whose state write fails re-arms at 24 h, not the interval", async () => {
  if (process.getuid() === 0) throw new Error("record as a user a 0444 mode locks out");
  begin({ file: { intervalHours: 3 } });
  chmod(SETTINGS, 0o444);
  await tick("boot", true);
  chmod(SETTINGS, 0o644);
});
await schedCase("tick: intervals below an hour, fractional, huge", async () => {
  begin({ file: { intervalHours: 0.5 } });
  await tick("boot");
  settings({ intervalHours: 2.5 });
  await tick("boot");
  settings({ intervalHours: 1000 });
  await tick("boot");
  settings({ intervalHours: -4 });
  await tick("boot");
});
await schedCase("race: a check in flight is shared with a manual tick", async () => {
  begin({ gitOver: [["fetch --quiet --no-tags origin main", "sleep 0.5"]] });
  await race();
  gitScenario();
});

// ======================================================================
// pure
// ======================================================================

const pend = (dirty, ahead, behind) => ({ remoteSha: "r", ahead, behind, dirty, branch: "main", upstreamBranch: "origin/main" });
const PENDINGS = [pend(false, 0, 2), pend(true, 0, 2), pend(false, 1, 2), pend(true, 1, 2), pend(false, 0, 0), pend(true, 0, 0), pend(false, 3, 0)];
const pick = [];
for (const mode of ["cc-merge", "ff-only", "notify-only", "disabled"]) {
  for (const pending of PENDINGS) {
    for (const override of [false, true]) {
      pick.push({ mode, pending, override, got: applyMod.pickStrategy(mode, pending, override) });
    }
  }
}
const bunEnv = ["install", "build"].map((phase) => ({
  phase,
  got: Object.entries(applyMod.envForBunPhase(phase)).map(([k, v]) => [k, v === undefined ? null : v]),
}));

rmSync(shimDir, { recursive: true, force: true });
const gitVersion = spawnSync(REAL_GIT, ["--version"], { encoding: "utf8" }).stdout.trim();
writeFileSync(
  process.env.UPD_APPLY_GOLDEN_OUT,
  JSON.stringify(
    {
      node: process.version,
      git: gitVersion,
      t0: T0,
      env: ENV,
      scrub: SCRUB,
      sys: SYS,
      abs: ABS,
      phases,
      scheduler,
      pure: { pick, bunEnv },
    },
    null,
    1,
  ) + "\n",
);
process.exit(0);
