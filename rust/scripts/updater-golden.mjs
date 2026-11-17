#!/usr/bin/env node
// Golden fixture for the updater's first half (D27a): the five routes
// `GET/PUT /api/updater/settings`, `GET /api/updater/status`,
// `GET /api/updater/log`, `POST /api/updater/check` and
// `GET /api/updater/changelog`, recorded from the real TS route handlers on
// the real `lib/server/updater/{settings,root,detect,git,spawn-env,
// release-changelog}.ts` and `lib/shared/release-changelog.ts`:
//
//   node rust/scripts/updater-golden.mjs     (node@22)
//
// Re-runs itself twice under `--experimental-transform-types` (two temp
// roots; both recordings must agree byte for byte), with a resolve hook for
// the `@/` imports and a pinned environment: HOME, XDG_CONFIG_HOME and
// CLAUDE_CONFIG_DIR under the root, no system git config,
// GIT_CEILING_DIRECTORIES at the root, a fixed author, committer and date
// (stable hashes), LANG / LC_ALL = C, TZ = UTC, and PATH = node's dir, the
// system dirs, then the three absolute dirs `extendedPath` would prepend
// (so it only ever prepends `$HOME/.bun/bin`). `Date.now` is a counter: each
// request runs one millisecond after the one before (T0 + n), and every
// such value prints as `$T<n>`. The root prints as `$ROOT`.
//
// Parts:
// * `phases`: each a fresh server in the replay: its env (the install
//   root), then `steps`: the world built as data (`git` runs with its args,
//   `write` / `hex` / `gen` / `rm` / `mkdir` / `link` / `chmod` on paths
//   under the root), the route handlers (`req`: method, url, body; `got` is
//   the status, content type and body text, or `threw`; `file` is
//   updater.json after it: its text, `null` when missing, `"<dir>"`), and
//   `calls` (what the fake git logged since the last `calls`: cwd, argv,
//   GIT_TERMINAL_PROMPT, GIT_ASKPASS and PATH's first entry; then the log
//   is removed). The install root is `$ROOT/current`, a symlink the steps
//   re-point; a fake git is active while `$ROOT/home/.bun/bin/git` exists
//   (`extendedPath` puts that dir first), its scenario in `scenario.sh`
//   next to it (anything it doesn't handle runs `$REAL_GIT`). Changelog
//   requests go to a local raw-TCP server instead of api.github.com: the
//   step's scripted `responses` (raw bytes as hex; `close` = hang up;
//   `refuse` = a closed port) and the `wire` it received (method, path,
//   headers; the port as `$PORT`). Steps tagged `nonRoot` only hold for a
//   user that a 000 mode locks out.
// * `pure`: `toReleaseTag`, `classifyCommit`, `buildReleaseChangelog` and
//   `extendedPath` called directly (`extendedPath` with which of its
//   absolute dirs existed), and `ttl`: the changelog's failure cache over a
//   scripted fetch and a moving clock (`advance`).
// * `messages`: V8 / undici texts the replay checks against (the
//   `AbortSignal.timeout` rejection).
//
// Written to rust/crates/claudius-core/tests/fixtures/updater_golden.json;
// replayed by crates/claudius-core/tests/updater_golden.rs (`pure`,
// `messages`) and crates/claudius-server/tests/updater_routes.rs (`phases`,
// against the real binary).
import { spawnSync } from "node:child_process";
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
import net from "node:net";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-core/tests/fixtures/updater_golden.json");

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
/** `spawn-env.ts` ABSOLUTE_LOCATIONS: on PATH already, so never prepended. */
const ABS = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];

if (!process.env.UPD_GOLDEN_CHILD) {
  const PATH = [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin", ...ABS].join(":");
  const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { env: { PATH }, encoding: "utf8" }).stdout.trim();
  if (!realGit) throw new Error("no git on PATH");
  const texts = [];
  for (let run = 0; run < 2; run++) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "updater-golden-")));
    const outDir = mkdtempSync(join(tmpdir(), "updater-golden-out-"));
    try {
      const env = { PATH, REAL_GIT: realGit, UPD_GOLDEN_CHILD: root, UPD_GOLDEN_OUT: join(outDir, "out.json") };
      for (const [k, v] of Object.entries(ENV)) env[k] = v.replaceAll("$ROOT", root);
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        { cwd: repo, stdio: "inherit", env },
      );
      if (r.status !== 0) process.exit(r.status ?? 1);
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
  const n = fx.phases.reduce((a, p) => a + p.steps.filter((s) => s.op === "req").length, 0);
  console.log(`wrote ${out}: ${fx.phases.length} phases, ${n} requests (two runs identical)`);
  process.exit(0);
}

const ROOT = process.env.UPD_GOLDEN_CHILD;
const REAL_GIT = process.env.REAL_GIT;

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

const T0 = 1_800_000_000_000;
let clock = T0;
Date.now = () => clock;
// readUpdaterFile warns on a file it can't read; the replay doesn't compare logs.
console.warn = () => {};

const mod = (p) => import(pathToFileURL(join(repo, p)).href);
const settingsRoute = await mod("app/api/updater/settings/route.ts");
const statusRoute = await mod("app/api/updater/status/route.ts");
const logRoute = await mod("app/api/updater/log/route.ts");
const checkRoute = await mod("app/api/updater/check/route.ts");
const changelogRoute = await mod("app/api/updater/changelog/route.ts");
const shared = await mod("lib/shared/release-changelog.ts");
const spawnEnv = await mod("lib/server/updater/spawn-env.ts");
const serverChangelog = await mod("lib/server/updater/release-changelog.ts");

// ------------------------------- text helpers -------------------------------

/** Characters by code point, so this file stays ASCII. */
const ch = (...cps) => String.fromCodePoint(...cps);
/** A lone UTF-16 unit. */
const unit = (u) => String.fromCharCode(u);
/** `\uXXXX` as six characters (a JSON escape inside raw body text). */
const esc = (hex4) => "\\" + "u" + hex4;
const TOKEN_RE = /18000000\d{5}/g;
/** `$ROOT` for the root, `$T<n>` for the clock values. */
function sub(s) {
  return s.split(ROOT).join("$ROOT").replace(TOKEN_RE, (m) => `$T${Number(m) - T0}`);
}
function subValue(v) {
  if (typeof v === "string") return sub(v);
  if (Array.isArray(v)) return v.map(subValue);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subValue(x)]));
  return v;
}
const P = (rel) => (rel ? join(ROOT, rel) : ROOT);
const SETTINGS = "home/.claude/.claudius/updater.json";
const FAKE_DIR = "home/.bun/bin";

// ------------------------------- the world -------------------------------

const phases = [];
let cur = null;
function phase(name, installRoot) {
  cur = { name, env: installRoot === null ? {} : { CLAUDIUS_INSTALL_ROOT: installRoot }, steps: [] };
  phases.push(cur);
  if (installRoot === null) delete process.env.CLAUDIUS_INSTALL_ROOT;
  else process.env.CLAUDIUS_INSTALL_ROOT = installRoot.replaceAll("$ROOT", ROOT);
}
const op = (s) => cur.steps.push(s);

function git(cwd, ...args) {
  const r = spawnSync(REAL_GIT, args.map((a) => a.replaceAll("$ROOT", ROOT)), { cwd: P(cwd), env: process.env });
  op({ op: "git", cwd, args, fails: r.status !== 0 });
}
function write(path, text) {
  mkdirSync(dirname(P(path)), { recursive: true });
  writeFileSync(P(path), text);
  op({ op: "write", path, text });
}
function hex(path, bytes) {
  mkdirSync(dirname(P(path)), { recursive: true });
  writeFileSync(P(path), bytes);
  op({ op: "hex", path, hex: Buffer.from(bytes).toString("hex") });
}
/** `count` lines `line <i>\n`, then `tail`: a big log the fixture keeps small. */
function gen(path, count, tail = "") {
  mkdirSync(dirname(P(path)), { recursive: true });
  let s = "";
  for (let i = 0; i < count; i++) s += `line ${i}\n`;
  writeFileSync(P(path), s + tail);
  op({ op: "gen", path, count, tail });
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
function chmod(path, mode, nonRoot = false) {
  chmodSync(P(path), mode);
  op({ op: "chmod", path, mode: mode.toString(8), ...(nonRoot ? { nonRoot } : {}) });
}
const target = (name) => link("current", `$ROOT/${name}`);

function fileState() {
  try {
    const st = lstatSync(P(SETTINGS));
    if (st.isDirectory()) return "<dir>";
    return sub(readFileSync(P(SETTINGS), "utf8"));
  } catch {
    return null;
  }
}
function calls() {
  const p = P(`${FAKE_DIR}/calls.log`);
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    // nothing ran
  }
  rmSync(p, { force: true });
  op({ op: "calls", text: sub(text) });
}

// ------------------------------- requests -------------------------------

const ROUTES = {
  "GET /api/updater/settings": (r) => settingsRoute.GET(r),
  "PUT /api/updater/settings": (r) => settingsRoute.PUT(r),
  "GET /api/updater/status": (r) => statusRoute.GET(r),
  "GET /api/updater/log": (r) => logRoute.GET(r),
  "POST /api/updater/check": (r) => checkRoute.POST(r),
  "GET /api/updater/changelog": (r) => changelogRoute.GET(r),
};
async function call(method, url, body) {
  const handler = ROUTES[`${method} ${url.split("?")[0]}`];
  if (!handler) throw new Error(`no route for ${method} ${url}`);
  const init = { method };
  if (body !== undefined) init.body = body;
  try {
    const res = await handler(new Request(`http://localhost${url}`, init));
    return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}
const BIG = 200_000;
/** FNV-1a 64 of the UTF-8 bytes, as 16 hex digits. */
function fnv(s) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}
function keep(got) {
  if (got.body === undefined || got.body.length <= BIG) return subValue(got);
  return { ...got, body: undefined, bodyLen: Buffer.byteLength(got.body), bodyFnv: fnv(got.body), head: sub(got.body.slice(0, 200)) };
}
/** One request; `body` is raw text, or a Buffer (kept as hex). */
async function req(label, method, url, body, extra = {}) {
  clock += 1;
  const got = await call(method, url, body === undefined ? undefined : Buffer.from(body));
  const s = { op: "req", label, method, url: sub(url) };
  if (Buffer.isBuffer(body)) s.bodyHex = body.toString("hex");
  else if (body !== undefined) s.body = body;
  Object.assign(s, extra, { got: keep(got), file: fileState() });
  op(s);
  return got;
}
/** Several requests at once (the check's single flight). */
async function together(label, method, url, n) {
  clock += 1;
  const all = await Promise.all(Array.from({ length: n }, () => call(method, url)));
  op({ op: "together", label, method, url, n, got: all.map(keep), file: fileState() });
}
const put = (label, body) => req(label, "PUT", "/api/updater/settings", body);
const getSettings = (label) => req(label, "GET", "/api/updater/settings");
const status = (label) => req(label, "GET", "/api/updater/status");
const check = (label) => req(label, "POST", "/api/updater/check");
const log = (label, query = "", extra = {}) => req(label, "GET", `/api/updater/log${query}`, undefined, extra);
const settingsFile = (text) => write(SETTINGS, text);

// ------------------------------- fake GitHub -------------------------------

let wireQueue = [];
let wireLog = [];
const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let done = false;
  sock.on("error", () => {});
  sock.on("data", (d) => {
    if (done) return;
    buf = Buffer.concat([buf, d]);
    const at = buf.indexOf("\r\n\r\n");
    if (at < 0) return;
    done = true;
    const lines = buf.subarray(0, at).toString("latin1").split("\r\n");
    const [method, path] = lines[0].split(" ");
    const headers = lines.slice(1).map((l) => {
      const i = l.indexOf(":");
      const k = l.slice(0, i);
      const v = l.slice(i + 1).trim();
      return [k, k.toLowerCase() === "host" ? v.replace(/:\d+$/, ":$PORT") : v];
    });
    wireLog.push({ method, path, headers });
    const r = wireQueue.shift();
    if (!r) {
      wireLog.at(-1).unscripted = true;
      sock.destroy();
      return;
    }
    if (r.close) {
      sock.destroy();
      return;
    }
    sock.end(Buffer.from(r.wireHex, "hex"));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const closed = net.createServer();
await new Promise((r) => closed.listen(0, "127.0.0.1", r));
const CLOSED_PORT = closed.address().port;
await new Promise((r) => closed.close(r));

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const refuse = wireQueue[0]?.refuse === true;
  if (refuse) wireQueue.shift();
  const t = `http://127.0.0.1:${refuse ? CLOSED_PORT : PORT}/${u.host}${u.pathname}${u.search}`;
  return realFetch(t, init);
};

/** A raw HTTP/1.1 response: status line, headers, then `body` bytes. */
function wire(statusLine, body, headers = ["Content-Type: application/json; charset=utf-8"]) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const head = [statusLine, ...headers, `Content-Length: ${b.length}`, "Connection: close", "", ""].join("\r\n");
  return { wireHex: Buffer.concat([Buffer.from(head, "latin1"), b]).toString("hex") };
}
const ok = (json) => wire("HTTP/1.1 200 OK", typeof json === "string" ? json : JSON.stringify(json));
/** `GET /api/updater/changelog?<query>` against scripted responses. */
async function changelog(label, query, responses = []) {
  wireQueue = responses.slice();
  wireLog = [];
  await req(label, "GET", `/api/updater/changelog${query}`, undefined, {});
  const s = cur.steps.at(-1);
  s.responses = responses;
  s.wire = wireLog;
  if (wireQueue.length) throw new Error(`${label}: ${wireQueue.length} responses unused`);
}
const commit = (sha, message, parents = [{ sha: "p0" }]) => ({ sha, commit: { message }, parents });

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ======================================================================
// main: CLAUDIUS_INSTALL_ROOT = $ROOT/current
// ======================================================================

mkdirSync(P("home"), { recursive: true });
mkdirSync(P("servercwd"), { recursive: true });
process.chdir(P("servercwd"));

phase("main", "$ROOT/current");
mkdir("plain");
target("plain");

// ---- no settings file yet
await getSettings("settings: defaults, no file");
await status("status: not a repo, no file");
await check("check: not a git checkout (writes nothing)");
await log("log: no log file");
await log("log: no log file, with an offset", "?offset=5");

// ---- PUT bodies
await put("put {} writes the defaults", "{}");
await put("put all four", JSON.stringify({ mode: "ff-only", remote: "upstream", branch: "dev", intervalHours: 2.5 }));
await put("put an unknown mode", '{"mode":"bogus"}');
await put("put a null mode", '{"mode":null}');
await put("put a numeric mode", '{"mode":5}');
await put("put an overflowing mode", '{"mode":1e400}');
await put("put a prototype-name mode", '{"mode":"constructor"}');
await put("put an upper-case mode", '{"mode":"FF-ONLY"}');
await put("put each mode: cc-merge", '{"mode":"cc-merge"}');
await put("put each mode: notify-only", '{"mode":"notify-only"}');
await put("put each mode: disabled", '{"mode":"disabled"}');
await put("put a blank remote", '{"remote":"   "}');
await put("put a JS-whitespace remote", JSON.stringify({ remote: ch(0xa0, 0x2028, 0xfeff, 0x3000) }));
await put("put a NEL remote (not JS whitespace)", JSON.stringify({ remote: ch(0x85) }));
await put("put odd types", '{"remote":5,"branch":true,"intervalHours":"3","mode":"ff-only"}');
await put("put intervalHours 0", '{"intervalHours":0}');
await put("put intervalHours -1", '{"intervalHours":-1}');
await put("put intervalHours 1e400", '{"intervalHours":1e400}');
await put("put intervalHours -1e400", '{"intervalHours":-1e400}');
await put("put intervalHours -0", '{"intervalHours":-0}');
await put("put intervalHours 1e21", '{"intervalHours":1e21}');
await put("put intervalHours 5e-324", '{"intervalHours":5e-324}');
await put("put intervalHours 1e-7", '{"intervalHours":1e-7}');
await put("put intervalHours 1.0", '{"intervalHours":1.0}');
await put("put intervalHours 12345678901234567890", '{"intervalHours":12345678901234567890}');
await put("put intervalHours null", '{"intervalHours":null}');
await put("put a null body", "null");
await put("put an array body", "[]");
await put("put a string body", '"mode"');
await put("put a number body", "7");
await put("put a true body", "true");
await put("put a malformed body", "{");
await put("put an empty body", "");
await put("put a trailing comma", '{"mode":"ff-only",}');
await put("put one BOM", Buffer.concat([BOM, Buffer.from('{"mode":"notify-only"}')]));
await put("put two BOMs", Buffer.concat([BOM, BOM, Buffer.from('{"mode":"ff-only"}')]));
await put("put three BOMs", Buffer.concat([BOM, BOM, BOM, Buffer.from('{"mode":"ff-only"}')]));
await put("put invalid UTF-8 in a string", Buffer.concat([Buffer.from('{"branch":"b'), Buffer.from([0xff, 0xc3]), Buffer.from('x"}')]));
await put("put spaced values (kept as they are)", '{"remote":" spaced ","branch":"\\tmain\\t"}');
await put("put a lone surrogate branch", `{"branch":"${esc("d800")}x","remote":"r${esc("dfff")}"}`);
await put("put unicode", JSON.stringify({ branch: "ma" + ch(0xef) + "n-" + ch(0x1f600), remote: ch(0x4e2d, 0x6587) }));
await put("put extra keys (state ignored)", '{"mode":"cc-merge","extra":1,"state":{"lastError":"x"}}');
await put("put duplicate keys (last wins)", '{"mode":"bogus","mode":"notify-only","remote":"a","remote":"b"}');
await put("put a __proto__ key", '{"__proto__":{"mode":"bogus"},"remote":"origin"}');
await put("put a bad mode with good fields (nothing written)", '{"mode":"x","remote":"never"}');
await put("put an overflowing interval with a good mode", '{"mode":"ff-only","intervalHours":1e999}');
await getSettings("settings: after the puts");

// ---- hand-written settings files
const FILES = [
  ["not JSON", "not json"],
  ["a BOM", ch(0xfeff) + '{"mode":"ff-only"}'],
  ["null", "null"],
  ["an array", "[]"],
  ["a string", '"x"'],
  ["a number", "5"],
  ["true", "true"],
  ["empty", ""],
  ["whitespace", " \n"],
  ["an empty object", "{}"],
  ["wrong types", '{"mode":"FF-ONLY","remote":"","branch":7,"intervalHours":"24"}'],
  ["an overflowing interval", '{"intervalHours":1e400,"mode":"notify-only"}'],
  ["a tiny interval, spaced names", `{"intervalHours":5e-324,"remote":" origin ","branch":"${esc("00a0")}"}`],
  ["a big interval", '{"intervalHours":1e308,"remote":"' + ch(0x85) + '"}'],
  [
    "state field types",
    '{"state":{"lastCheckAt":5,"lastUpdateAt":"6","lastUpdateSha":7,"lastError":"boom","pending":{"remoteSha":"abc","x":[1,{"y":2}]},"conflicts":[1],"recovery":"x","status":{"kind":"idle","extra":true}}}',
  ],
  ["status applying", '{"state":{"status":{"kind":"applying","startedAt":1,"strategy":"ff-only"}}}'],
  ["status kind null", '{"state":{"status":{"kind":null}}}'],
  ["status an array", '{"state":{"status":[]}}'],
  ["status empty", '{"state":{"status":{}}}'],
  ["status a string", '{"state":{"status":"idle"}}'],
  ["status idle with extras", '{"state":{"status":{"extra":[1],"kind":"idle"}}}'],
  ["state null", '{"state":null}'],
  ["state a string", '{"state":"str"}'],
  ["state an array", '{"state":[1,2]}'],
  ["state zero", '{"state":0}'],
  ["infinite stamps", '{"state":{"lastCheckAt":1e400,"lastUpdateAt":-1e400,"lastUpdateSha":"s","pending":{"n":1e400}}}'],
  [
    "lone surrogates",
    `{"remote":"${esc("dc00")}","state":{"lastError":"${esc("d83d")}","pending":{"remoteSha":"${esc("d800")}x","note":"${esc("00e9")}"}}}`,
  ],
  ["__proto__ keys", '{"state":{"pending":{"__proto__":{"a":1},"remoteSha":"x"},"conflicts":{"__proto__":null}}}'],
  ["index keys", '{"state":{"pending":{"b":1,"2":2,"1":1,"a":0,"10":3,"01":4,"4294967295":5,"4294967294":6}}}'],
  ["duplicate keys", '{"mode":"ff-only","mode":"disabled","state":{"lastError":"a","lastError":"b"}}'],
  ["number text", '{"intervalHours":2.50,"state":{"lastCheckAt":1.50,"pending":{"n":[1.0,1e2,1e21,-0,0.000001,1e-7,123456789012345678]}}}'],
  ["pending empty", '{"state":{"pending":{}}}'],
  ["falsy members", '{"state":{"pending":false,"conflicts":0,"recovery":null,"lastError":""}}'],
  ["unicode", JSON.stringify({ remote: ch(0x1f600), state: { lastError: ch(0x2028) + "x" + ch(0x85) } })],
  ["control characters", `{"remote":"a${esc("0000")}b","state":{"lastError":"${esc("001f")}${esc("007f")}"}}`],
];
for (const [label, text] of FILES) {
  settingsFile(text);
  await getSettings(`settings: file with ${label}`);
  await status(`status: file with ${label}`);
}
// A write normalizes what it read.
for (const label of ["state field types", "lone surrogates", "infinite stamps", "__proto__ keys", "index keys", "a BOM"]) {
  settingsFile(FILES.find(([l]) => l === label)[1]);
  await put(`put {} over a file with ${label}`, "{}");
}
hex(SETTINGS, Buffer.concat([Buffer.from('{"remote":"o'), Buffer.from([0xff]), Buffer.from('k","branch":"'), Buffer.from([0xe2, 0x82]), Buffer.from('"}')]));
await getSettings("settings: invalid UTF-8 in the file");
await put("put {} over invalid UTF-8", "{}");

// ---- the settings path is a directory, or under a file
rm(SETTINGS);
mkdir(SETTINGS);
await getSettings("settings: the file is a directory");
await put("put when the file is a directory", '{"mode":"ff-only"}');
await check("check: not a repo, with the settings a directory");
rm(SETTINGS);
rm("home/.claude/.claudius");
write("home/.claude/.claudius", "a file\n");
await getSettings("settings: .claudius is a file");
await put("put when .claudius is a file", "{}");
rm("home/.claude/.claudius");

// ---- runtime mode: the daemon pid file
const PID = "plain/.claudius/claudius.pid";
for (const [label, text] of [
  ["a pid", "12345"],
  ["words", "abc"],
  ["empty", ""],
  ["zero", "0"],
  ["padded", " 42 \n"],
  ["hex", "0x1f"],
  ["binary", "0b11"],
  ["a signed hex", "-0x1"],
  ["Infinity", "Infinity"],
  ["negative", "-3"],
  ["a fraction", "1.5"],
  ["an exponent", "1e3"],
  ["a BOM", ch(0xfeff) + "5"],
  ["a no-break space", ch(0xa0) + "9"],
  ["two numbers", "1 2"],
]) {
  write(PID, text);
  await status(`status: pid file with ${label}`);
}
hex(PID, Buffer.from([0xff, 0x31]));
await status("status: pid file with invalid UTF-8");
rm(PID);
mkdir(PID);
await status("status: pid file is a directory");
rm(PID);
link(PID, "$ROOT/nowhere");
await status("status: pid file is a dangling link");
write("pidtarget", "77");
link(PID, "$ROOT/pidtarget");
await status("status: pid file links to a file");
rm(PID);

// ---- the log tail
const LOG = "plain/.claudius/logs/updater.log";
write(LOG, "hello\nw" + ch(0xf6) + "rld " + ch(0x1f600) + "\n");
await log("log: size only");
for (const q of [
  "?offset=0",
  "?offset=6",
  "?offset=8",
  "?offset=13",
  "?offset=17",
  "?offset=18",
  "?offset=19",
  "?offset=-1",
  "?offset=abc",
  "?offset=",
  "?offset",
  "?offset=1e1",
  "?offset=0x3",
  "?offset=%20%203",
  "?offset=+4",
  "?offset=1.5",
  "?offset=17.9",
  "?offset=Infinity",
  "?offset=-Infinity",
  "?offset=-0",
  "?offset=NaN",
  "?offset=2&offset=3",
  "?a=1&offset=4",
  "?OFFSET=1",
  "?off%73et=2",
  "?offset=1e400",
  "?offset=99999999999999999999",
]) {
  await log(`log: ${q}`, q);
}
gen(LOG, 30000);
await log("log: a big log, size only");
await log("log: a big log from 0 (one capped chunk)", "?offset=0");
await log("log: a big log from 100", "?offset=100");
await log("log: a big log near the end", "?offset=318880");
await log("log: a big log at a fractional offset", "?offset=1.5");
await log("log: a big log at 0.5 from the end of a chunk", "?offset=56745.5");
gen(LOG, 0, "a".repeat(262143) + ch(0xe9) + "z");
await log("log: a chunk that ends inside a character", "?offset=0");
await log("log: the tail after that cut", "?offset=262144");
write("plain/real.log", "abc");
link(LOG, "$ROOT/plain/real.log");
await log("log: a link to a file", "?offset=1");
await log("log: a link to a file, size only");
link(LOG, "$ROOT/nowhere");
await log("log: a dangling link");
await log("log: a dangling link, with an offset", "?offset=0");
rm("plain/.claudius");
write("plain/.claudius", "not a dir");
await log("log: .claudius is a file", "?offset=0");
rm("plain/.claudius");
write(LOG, "locked\n");
chmod(LOG, 0o000, true);
await log("log: unreadable, size only", "", { nonRoot: true });
await log("log: unreadable, with an offset", "?offset=0", { nonRoot: true });
chmod(LOG, 0o644);
rm("plain/.claudius");

// ---- the changelog (one process-wide cache)
for (const [label, q] of [
  ["no params", ""],
  ["from only", "?from=0.3.1"],
  ["to only", "?to=0.3.1"],
  ["the same version", "?from=0.3.1&to=v0.3.1"],
  ["five parts", "?from=1.2.3.4.5&to=1.2.3"],
  ["two parts", "?from=1.2&to=1.2.3"],
  ["five digits", "?from=12345.1.1&to=1.2.3"],
  ["a double v", "?from=vv1.2.3&to=1.2.4"],
  ["a capital V", "?from=V1.2.3&to=1.2.4"],
  ["a trailing newline", "?from=1.2.3%0A&to=1.2.4"],
  ["a leading space", "?from=%201.2.3&to=1.2.4"],
  ["a plus (a space)", "?from=1.2.3+&to=1.2.4"],
  ["Arabic-Indic digits", `?from=${encodeURIComponent(ch(0x661))}.2.3&to=1.2.4`],
  ["an empty from", "?from=&to=1.2.4"],
  ["a negative part", "?from=1.-2.3&to=1.2.4"],
  ["first from wins", "?from=1.2.3&from=1.2.4&to=1.2.4"],
]) {
  await changelog(`changelog: ${label}`, q);
}
const ROUTE_COMMITS = [
  commit("1111111111111111111111111111111111111111", "feat(composer): add a thing (CC 2.1.300)"),
  commit("2222222222222222222222222222222222222222", "fix: crash on empty input\n\nlong body"),
  commit("3333333333333333333333333333333333333333", "Merge pull request #12 from a/b", [{ sha: "x" }, { sha: "y" }]),
  commit("4444444444444444444444444444444444444444", "perf(core)!: faster boot"),
  commit("5555555555555555555555555555555555555555", "docs: readme"),
  commit("6666666666666666666666666666666666666666", "refactor: tidy the store (CC 2.1.299 parity review)"),
  commit("7777777777777777777777777777777777777777", "Feat(Composer): Add a thing"),
  commit("8888888888888888888888888888888888888888", "chore(release): v0.3.298.0"),
  commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "fix(release): ship the manifest"),
  commit("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "feat(E2E): a new spec"),
  commit("9999999999999999999999999999999999999999", "fix(ui): " + ch(0xdf) + "-first"),
];
await changelog("changelog: a range", "?from=0.3.296.1&to=0.3.298.0", [
  ok({ html_url: "https://github.com/filipegarcia/claudius/compare/v0.3.296.1...v0.3.298.0", commits: ROUTE_COMMITS }),
]);
await changelog("changelog: the same range again (cached)", "?from=v0.3.296.1&to=v0.3.298.0");
await changelog("changelog: the reversed pair is another key", "?from=0.3.298.0&to=0.3.296.1", [ok({ commits: [] })]);
let n = 1;
const pair = () => `?from=0.0.1&to=0.0.${++n}`;
const fail = async (label, responses) => {
  const q = pair();
  await changelog(`changelog: ${label}`, q, responses);
  return q;
};
const q404 = await fail("404", [wire("HTTP/1.1 404 Not Found", '{"message":"Not Found"}')]);
await changelog("changelog: 404 again (the failure is cached)", q404);
await fail("403", [wire("HTTP/1.1 403 rate limit exceeded", "{}")]);
await fail("500", [wire("HTTP/1.1 500 Internal Server Error", "")]);
await fail("204", [wire("HTTP/1.1 204 No Content", "", [])]);
await fail("an HTML body", [wire("HTTP/1.1 200 OK", "<html>", ["Content-Type: text/html"])]);
await fail("an empty body", [wire("HTTP/1.1 200 OK", "")]);
await fail("a null body", [ok("null")]);
await fail("a number body", [ok("5")]);
await fail("an array body", [ok("[1]")]);
await fail("commits a string", [ok({ commits: "abc" })]);
await fail("commits an object", [ok({ commits: { length: 1 } })]);
await fail("commits a number", [ok({ commits: 5 })]);
await fail("commits null", [ok({ commits: null })]);
await fail("a null commit", [ok({ commits: [null] })]);
await fail("a numeric message", [ok({ commits: [{ sha: "a", commit: { message: 5 } }] })]);
await fail("an array message", [ok({ commits: [{ sha: "a", commit: { message: ["feat: x"] } }] })]);
await fail("no sha", [ok({ commits: [{ commit: { message: "feat: x" } }] })]);
await fail("a null sha", [ok({ commits: [{ sha: null, commit: { message: "feat: x" } }] })]);
await fail("a numeric sha", [ok({ commits: [{ sha: 123, commit: { message: "feat: x" } }] })]);
await fail("an array sha", [ok({ commits: [{ sha: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], commit: { message: "fix: y" } }] })]);
await fail("a numeric sha on a dropped commit", [ok({ commits: [{ sha: 5, commit: { message: "chore: x" } }] })]);
await fail("a numeric sha on a prototype type", [ok({ commits: [{ sha: 5, commit: { message: "constructor: x" } }] })]);
await fail("parents shapes", [
  ok({
    commits: [
      commit("s01", "feat: string parents", "ab"),
      commit("s02", "feat: a string length", { length: "1" }),
      commit("s03", "feat: no parents", []),
      commit("s04", "feat: null parents", null),
      commit("s05", "feat: a null length", { length: null }),
      commit("s06", "feat: a NaN length", { length: "x" }),
      commit("s07", "feat: an array length", { length: [1] }),
      commit("s08", "feat: two parents", [{}, {}]),
      commit("s09", "feat: a boolean length", { length: true }),
      commit("s10", "feat: numeric parents", 7),
      commit("s11", "feat: a one-char parents string", "a"),
      commit("s12", "feat: a two-item array length", { length: [1, 2] }),
      commit("s13", "feat: an object length", { length: {} }),
      commit("s14", "feat: a valueOf length", { length: { valueOf: 1 } }),
      commit("s15", "feat: a padded length", { length: " 1 " }),
      commit("s16", "feat: a zero length string", { length: "" }),
    ],
  }),
]);
await fail("a parents length with its own toString", [ok({ commits: [commit("s", "feat: x", { length: { toString: 1 } })] })]);
await fail("odd commits", [
  ok({ commits: [5, "str", true, [], {}, { commit: "msg" }, { commit: null }, { commit: { message: null } }, { commit: { message: "" } }] }),
]);
await fail("a BOM", [wire("HTTP/1.1 200 OK", Buffer.concat([BOM, Buffer.from(JSON.stringify({ commits: [commit("abcdef0123", "fix: bom")] }))]))]);
await fail("invalid UTF-8", [
  wire(
    "HTTP/1.1 200 OK",
    Buffer.concat([Buffer.from('{"commits":[{"sha":"x","commit":{"message":"fix: bad '), Buffer.from([0xff, 0xfe]), Buffer.from(' bytes"}}]}')]),
  ),
]);
await fail("lone surrogates", [
  ok(`{"commits":[{"sha":"abcdefg${esc("d83d")}${esc("de00")}","commit":{"message":"fix: ${esc("dc00")} lone"}},{"sha":"${esc("d83d")}${esc("de00")}abc","commit":{"message":"feat: ${esc("d83d")}${esc("de00")} emoji first"}}]}`),
]);
await fail("an html_url that isn't a string", [ok({ html_url: 5, commits: [] })]);
await fail("a null html_url", [ok({ html_url: null, commits: [] })]);
await fail("a refused connection", [{ refuse: true }]);
await fail("a hang-up", [{ close: true }]);
await fail("a cut body", [{ wireHex: Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 50\r\nConnection: close\r\n\r\n{"commits":').toString("hex") }]);
await fail("a chunked body", [
  { wireHex: Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\n{"co\r\nb\r\nmmits":[]}\r\n0\r\n\r\n').toString("hex") },
]);

// ---- the install root as a real checkout
rm(SETTINGS);
git("", "init", "-q", "--bare", "--initial-branch=main", "remote.git");
git("", "clone", "-q", "$ROOT/remote.git", "seed");
git("seed", "symbolic-ref", "HEAD", "refs/heads/main");
write("seed/a.txt", "one\n");
git("seed", "add", "a.txt");
git("seed", "commit", "-q", "-m", "feat: initial");
git("seed", "push", "-q", "origin", "main");
git("", "clone", "-q", "$ROOT/remote.git", "install");
git("", "init", "-q", "--initial-branch=main", "empty");

target("empty");
await status("status: an empty repo");
await check("check: an empty repo (unborn HEAD)");
await status("status: after the empty-repo check");
rm(SETTINGS);

target("install");
await status("status: a checkout, up to date");
settingsFile('{"mode":"disabled"}');
await check("check: disabled");
rm(SETTINGS);
await check("check: up to date (no settings file)");
await status("status: after an up-to-date check");

write("seed/a.txt", "one\ntwo\n");
git("seed", "commit", "-qam", "fix: second");
write("seed/b.txt", "b\n");
git("seed", "add", "b.txt");
git("seed", "commit", "-qm", "feat(ui): third (CC 2.1.300)");
git("seed", "push", "-q", "origin", "main");
await check("check: behind 2");
await status("status: pending, not incorporated");
git("install", "merge", "-q", "--ff-only", "origin/main");
await status("status: pending incorporated by an outside pull");
await check("check: up to date again (pending cleared)");

write("install/c.txt", "c\n");
git("install", "add", "c.txt");
git("install", "commit", "-qm", "local: ahead");
await check("check: ahead only (pending kept, answers up to date)");
await status("status: an ahead-only pending is incorporated");

write("seed/d.txt", "d\n");
git("seed", "add", "d.txt");
git("seed", "commit", "-qm", "perf: diverge");
git("seed", "push", "-q", "origin", "main");
write("install/a.txt", "dirty\n");
await check("check: diverged and dirty");
await status("status: diverged");
git("install", "checkout", "-q", "--", "a.txt");
write("install/untracked.txt", "u\n");
await check("check: an untracked file is dirty");
rm("install/untracked.txt");

const CONFLICTED = JSON.stringify({
  state: { lastError: "old", conflicts: { toSha: "t", fromSha: "f", detectedAt: 1, origin: "stash-ff", detail: "d" }, recovery: { phase: "build" } },
});
settingsFile(CONFLICTED);
await check("check: a clean tree clears conflicts (not recovery)");
settingsFile(CONFLICTED);
write("install/a.txt", "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n");
await check("check: markers in content keep conflicts");
git("install", "checkout", "-q", "--", "a.txt");
git("install", "checkout", "-q", "-b", "side", "HEAD~1");
write("install/a.txt", "side\n");
git("install", "commit", "-qam", "side change");
git("install", "checkout", "-q", "main");
write("install/a.txt", "main change\n");
git("install", "commit", "-qam", "main change");
git("install", "merge", "-q", "side");
settingsFile(CONFLICTED);
await check("check: unmerged entries keep conflicts");
await status("status: mid-merge");
git("install", "merge", "--abort");
git("install", "reset", "-q", "--hard", "origin/main");
await check("check: up to date after the reset (conflicts cleared)");

git("install", "checkout", "-q", "--detach");
await check("check: a detached HEAD");
await status("status: a detached HEAD");
git("install", "checkout", "-q", "main");

settingsFile('{"remote":"nope"}');
await check("check: an unknown remote");
settingsFile('{"branch":"nobranch"}');
await check("check: an unknown remote branch");
git("install", "config", "remote.bare.url", "$ROOT/remote.git");
settingsFile('{"remote":"bare"}');
await check("check: fetched, but no tracking ref");
settingsFile('{"remote":"-x"}');
await check("check: a remote that reads as an option");
rm(SETTINGS);

// ---- a fake git ($HOME/.bun/bin comes first on the extended PATH)
const FAKE = [
  "#!/bin/sh",
  'd=$(dirname "$0")',
  "{",
  '  printf \'%s\' "$(pwd -P)"',
  '  for a in "$@"; do printf \' [%s]\' "$a"; done',
  '  printf \' TP=%s AP=%s P0=%s\\n\' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "${PATH%%:*}"',
  '} >> "$d/calls.log"',
  '. "$d/scenario.sh"',
  'exec "$REAL_GIT" "$@"',
  "",
].join("\n");
const BASE = [
  ["rev-parse --is-inside-work-tree", "echo true; exit 0"],
  ["rev-parse --abbrev-ref HEAD", "echo main; exit 0"],
  ["rev-parse HEAD", "echo aaaa; exit 0"],
  ["rev-parse origin/main", "echo bbbb; exit 0"],
  ["fetch --quiet --no-tags origin main", "exit 0"],
  ["status --porcelain", "exit 0"],
  ["ls-files -u", "exit 0"],
  ["diff --check HEAD", "exit 0"],
  ["rev-list --left-right --count HEAD...origin/main", "printf '0\\t2\\n'; exit 0"],
  ["log --pretty=%s -n 8 HEAD..origin/main", "printf 'two\\none\\n'; exit 0"],
  ["merge-base --is-ancestor *", "exit 1"],
];
/** The fake's scenario: `over` entries replace the base ones with the same pattern. */
function scenario(over = []) {
  const keys = new Set(over.map(([k]) => k));
  const all = [...over, ...BASE.filter(([k]) => !keys.has(k))];
  const lines = ['case "$*" in'];
  for (const [pat, body] of all) {
    const quoted = pat.endsWith(" *") ? `"${pat.slice(0, -2)}"*` : `"${pat}"`;
    lines.push(`  ${quoted}) ${body} ;;`);
  }
  lines.push('  *) echo "fake git: $*" >&2; exit 99 ;;', "esac", "");
  write(`${FAKE_DIR}/scenario.sh`, lines.join("\n"));
}
write(`${FAKE_DIR}/git`, FAKE);
chmod(`${FAKE_DIR}/git`, 0o755);
mkdir("fakeroot");
target("fakeroot");

scenario();
await status("fake: status, base");
await check("fake: check, base (update available)");
calls();

scenario([
  ["rev-list --left-right --count HEAD...origin/main", "printf '  3\\t\\t5  extra\\n'; exit 0"],
  ["log --pretty=%s -n 8 HEAD..origin/main", "printf ' first \\r\\n\\n  \\nsecond\\n\\377 end\\n\\342\\200\\250\\n'; exit 0"],
  ["status --porcelain", "printf ' \\n \\n'; exit 0"],
  ["diff --check HEAD", "printf 'a b.txt:3: leftover conflict marker\\n'; exit 2"],
]);
settingsFile(CONFLICTED);
await check("fake: odd counts, odd subjects, whitespace status, markers on stdout");
calls();

for (const [label, out] of [
  ["words", "abc def"],
  ["one number", "7"],
  ["exponent and hex", "1e3 0x10 9"],
  ["a negative", "-3 4"],
  ["empty", ""],
  ["a NUL", "1\\0002"],
  ["no-break spaces", "4\\302\\2405"],
]) {
  scenario([
    ["rev-list --left-right --count HEAD...origin/main", `printf '${out}\\n'; exit 0`],
    ["log --pretty=%s -n 8 HEAD..origin/main", "exit 0"],
  ]);
  await check(`fake: rev-list counts ${label}`);
}
calls();

scenario([["fetch --quiet --no-tags origin main", "exit 1"]]);
await check("fake: fetch fails with no stderr");
scenario([["fetch --quiet --no-tags origin main", "printf '  fatal: out \\n\\n' >&2; exit 128"]]);
await check("fake: fetch fails, padded stderr");
scenario([["fetch --quiet --no-tags origin main", "echo dying >&2; kill -9 $$"]]);
await check("fake: fetch killed by a signal");
scenario([["fetch --quiet --no-tags origin main", "echo partial; exit 3"]]);
await check("fake: fetch fails with stdout only");
calls();

scenario([["rev-parse --abbrev-ref HEAD", "printf ' HEAD \\n'; exit 0"]]);
await check("fake: a padded HEAD reads as detached");
scenario([["rev-parse --abbrev-ref HEAD", "printf 'ma\\377in\\n'; exit 0"]]);
await check("fake: a branch name with invalid UTF-8");
await status("fake: status with that branch");
scenario([["rev-parse --abbrev-ref HEAD", "echo nope >&2; exit 128"]]);
await check("fake: abbrev-ref fails");
await status("fake: status when abbrev-ref fails");
scenario([["rev-parse HEAD", "echo 'fatal: bad HEAD' >&2; exit 128"]]);
settingsFile('{"state":{"pending":{"remoteSha":"bbbb"}}}');
await status("fake: status when rev-parse HEAD fails (no reconcile)");
await check("fake: check when rev-parse HEAD fails");
scenario([["rev-parse HEAD", "printf ''; exit 0"]]);
settingsFile('{"state":{"pending":{"remoteSha":"bbbb"}}}');
await status("fake: status with an empty HEAD sha (no reconcile)");
scenario([["rev-parse origin/main", "echo aaaa; exit 0"]]);
settingsFile(CONFLICTED);
await check("fake: equal shas, clean (conflicts cleared)");
scenario([
  ["rev-parse origin/main", "echo aaaa; exit 0"],
  ["ls-files -u", "printf '100644 x 1\\ta.txt\\n'; exit 0"],
]);
settingsFile(CONFLICTED);
await check("fake: equal shas, unmerged (conflicts kept)");
calls();

scenario([["ls-files -u", "exit 128"]]);
settingsFile(CONFLICTED);
await check("fake: ls-files fails (conflicts kept)");
scenario([
  [
    "diff --check HEAD",
    "printf '  a b.txt:12: leftover conflict marker  \\nx:y:3: leftover conflict marker\\n:4: leftover conflict marker\\nc.txt:12: trailing whitespace.\\n'; exit 1",
  ],
]);
settingsFile(CONFLICTED);
await check("fake: diff --check lists markers (conflicts kept)");
scenario([
  [
    "diff --check HEAD",
    "printf ':4: leftover conflict marker\\nc.txt:12: trailing whitespace.\\nd.txt:1a: leftover conflict marker\\ne.txt:3: leftover conflict marker extra\\n'; exit 2",
  ],
]);
settingsFile(CONFLICTED);
await check("fake: diff --check lists no marker (conflicts cleared)");
scenario([["diff --check HEAD", "printf 'z.txt:1: leftover conflict marker\\n'; exit 0"]]);
settingsFile(CONFLICTED);
await check("fake: diff --check exits 0 with a marker (conflicts kept)");
scenario([["diff --check HEAD", "echo boom >&2; kill -9 $$"]]);
settingsFile(CONFLICTED);
await check("fake: diff --check killed (conflicts kept)");
calls();

scenario([["status --porcelain", "echo 'fatal: index' >&2; exit 128"]]);
await check("fake: status --porcelain fails");
scenario([["rev-list --left-right --count HEAD...origin/main", "echo 'fatal: rev-list' >&2; exit 128"]]);
await check("fake: rev-list fails");
scenario([["log --pretty=%s -n 8 HEAD..origin/main", "echo 'fatal: log' >&2; exit 128"]]);
await check("fake: log fails (no recent commits)");
scenario([["rev-parse origin/main", "echo 'fatal: no upstream' >&2; exit 128"]]);
await check("fake: rev-parse of the upstream fails");
calls();

scenario([["rev-parse --is-inside-work-tree", "exit 128"]]);
await status("fake: not a work tree");
await check("fake: check, not a work tree");
calls();

// The pending reconcile: what `isAncestor` is handed.
for (const [label, remoteSha, code] of [
  ["a string, yes", '"bbbb"', 0],
  ["a string, no", '"bbbb"', 1],
  ["a string, git fails", '"bbbb"', 128],
  ["a number", "123", 0],
  ["an array", '["x","y"]', 0],
  ["null", "null", 0],
  ["missing", undefined, 0],
  ["an object", "{}", 0],
  ["an object with toString", '{"toString":1}', 0],
  ["a NUL", `"a${esc("0000")}b"`, 0],
  ["a lone surrogate", `"${esc("d800")}"`, 0],
  ["a nested array", '[["a",null],[]]', 0],
  ["a boolean", "true", 0],
  ["an empty string", '""', 0],
]) {
  scenario([["merge-base --is-ancestor *", `exit ${code}`]]);
  settingsFile(`{"state":{"pending":{${remoteSha === undefined ? "" : `"remoteSha":${remoteSha},`}"ahead":0}}}`);
  await status(`fake: reconcile with remoteSha ${label}`);
}
calls();

// Two checks at once share one run.
scenario([["fetch --quiet --no-tags origin main", "sleep 1; exit 0"]]);
rm(SETTINGS);
await together("fake: two checks at once", "POST", "/api/updater/check", 2);
calls();
rm(FAKE_DIR);
rm(SETTINGS);
await check("real git again: fakeroot is not a repo");

// Leave a log for the next phases.
target("plain");
write(LOG, "phase log\n");

// ======================================================================
// the install root's other spellings
// ======================================================================

phase("padded", ch(0xa0) + " $ROOT/current \t");
await status("padded: status");
await log("padded: log", "?offset=6");
await check("padded: check");

phase("unset", null);
await status("unset: status (the server's cwd)");
await log("unset: log");
await check("unset: check");

phase("blank", " \t ");
await status("blank: status (the server's cwd)");
await log("blank: log", "?offset=0");

phase("slash", "/");
await status("slash: status");
await log("slash: log (refused)");
await log("slash: log with an offset (refused)", "?offset=0");
await check("slash: check");

phase("relative", "current");
link("servercwd/current", "$ROOT/install");
mkdir("install/.claudius/logs");
write("install/.claudius/logs/updater.log", "relative log\n");
write("install/.claudius/claudius.pid", "4242\n");
await status("relative: status");
await log("relative: log", "?offset=9");
await check("relative: check");

// ======================================================================
// pure: the shared changelog helpers and extendedPath
// ======================================================================

const TAGS = [
  "",
  "v",
  "1",
  "1.2",
  "1.2.3",
  "v1.2.3",
  "vv1.2.3",
  "V1.2.3",
  "1.2.3.4",
  "v0.3.298.0",
  "1.2.3.4.5",
  "1234.5678.9012.3456",
  "12345.1.1",
  "1.2.3.12345",
  "01.02.03",
  "1.2.3\n",
  " 1.2.3",
  "1.2.3 ",
  "1..2.3",
  "1.2.3.",
  ".1.2.3",
  "-1.2.3",
  "+1.2.3",
  "1.2.3-beta",
  "a.b.c",
  ch(0x661) + ".2.3",
  "1." + ch(0xff12) + ".3",
  "1.2.3" + ch(0x2028),
  "v1.2.3.4",
  "0.0.0",
  "9999.9999.9999.9999",
];
const MESSAGES = [
  "feat(composer): add a thing (CC 2.1.300)",
  "fix: crash on empty input",
  "perf(core)!: faster boot",
  "refactor: tidy the store",
  "docs: update readme",
  "chore(release): v0.3.298.0",
  "test: more coverage",
  "FEAT(Scope): upper-case type",
  "fix(  spaced  ): trailing parity (CC 2.1.299 parity review)  ",
  "feat: (CC 1.2)",
  "fix: " + ch(0xdf) + "-start",
  "fix: " + ch(0x1f600) + " emoji first",
  "fix: " + ch(0x10428) + " deseret",
  "fix: " + ch(0x1c6) + " digraph",
  "fix: " + ch(0x149) + " apostrophe n",
  "fix: " + ch(0x3c3) + " sigma",
  "feat:no space",
  "feat(scope: unclosed",
  "feat()!: empty scope",
  "feat( ): blank scope",
  "constructor: prototype type",
  "__proto__: prototype key",
  "toString: not lower-case",
  "hasownproperty: lower-cased name",
  "fix: first line\n\nbody text",
  "fix: carriage\rreturn",
  "fix:\rafter the colon",
  "fix: a" + ch(0x2028) + "b",
  "fix:" + ch(0x2028) + "line separator after the colon",
  "fix:" + ch(0xa0) + "no-break space",
  "  feat: leading space",
  "fix(cc): (cc 2.1.300 PARITY)",
  "fix: keep (CC 2.1) inner (CC 3)",
  "fix: not a suffix (CC 2.1.300 )",
  "fix: two spaces (CC 2.1.300  )",
  "fix: digits only (CC 1)",
  "fix: dotted (CC 1.2.3.4.5)",
  "fix: a letter (CC 1.a)",
  "fix: words (CC 2 parity Review)",
  "fix: unicode words (CC 2 r" + ch(0xe9) + "view)",
  "fix: tab\tinside",
  "Merge pull request #12 from x/y",
  "revert: \"feat: x\"",
  "feat!: breaking",
  "fix(ui)(extra): double scope",
  "fix(a(b)): nested",
  "fix(a)b: text after the scope",
  "fix_1: underscore type",
  "Fix_Bug: mixed",
  ch(0xfc) + "nicode: type",
  "feat(" + ch(0xfc) + "): unicode scope",
  "fix:",
  "fix: ",
  "fix: " + ch(0xa0),
  "perf: tail spaces   (CC 9)   ",
  "feat: " + "x".repeat(300),
  "",
  "\n",
  "feat",
  ":",
  "(scope): no type",
  "feat:(CC 1)",
  "fix: " + ch(0) + "nul",
  "fix: lone " + unit(0xd800) + " surrogate",
  unit(0xdc00) + "fix: lone first",
  "fix: " + unit(0xd83d) + " high first",
  "FIX: SHOUT",
  "Perf(x)!: mixed case",
  "feat: a" + ch(0x0b) + "vertical tab",
  "fix(" + ch(0x2028) + "): separator scope",
  "fix: ends with a colon:",
  "feat: dedupe me",
  "feat: Dedupe me",
  "feat(x): dedupe me",
  "fix: dedupe me",
  // INTERNAL_SCOPES (the release machinery): matched case-insensitively
  // against the whole trimmed scope.
  "fix(release): a release-scoped fix",
  "feat(CI): an upper-case ci scope",
  "fix( e2e ): a spaced e2e scope",
  "feat(update-pipeline): the pipeline",
  "fix(releases): plural",
  "fix(Tests): tests",
  "perf(test): test",
  "refactor(ci): an internal refactor",
  "fix(ci-x): not the whole scope",
  "fix(sdk-update): kept",
  "fix(security): kept",
  "fix(release)!: breaking, still internal",
  "chore(ci): internal either way",
];
const classify = MESSAGES.map((message) => {
  const r = shared.classifyCommit(message, "0123456789abcdef");
  return { message, got: r === null ? null : { group: typeof r.group === "string" ? r.group : "<proto>", entry: r.entry } };
});
const shaCases = ["", "abc", "0123456789", "abcdefg" + ch(0x1f600), ch(0x1f600) + "abcdefg"].map((sha) => {
  const r = shared.classifyCommit("fix: sha cut", sha);
  return { sha, got: r.entry.sha };
});
const BUILDS = [
  [],
  MESSAGES.map((message, i) => ({ sha: `sha${String(i).padStart(5, "0")}`, message })),
  [
    { sha: "a1", message: "fix: same" },
    { sha: "a2", message: "fix: Same" },
    { sha: "a3", message: "fix(x): same" },
    { sha: "a4", message: "feat: same" },
    { sha: "a5", message: "constructor: same" },
    { sha: "a6", message: "perf: same" },
    { sha: "a7", message: "refactor: same" },
  ],
  [{ sha: "b1", message: "docs: only internal" }],
  [
    { sha: "c1", message: "fix: " + ch(0x3a3) + "IGMA" },
    { sha: "c2", message: "fix: " + ch(0x3c3) + "igma" },
    { sha: "c3", message: "fix: " + ch(0x130) + " dotted" },
    { sha: "c4", message: "fix: i" + ch(0x307) + " dotted" },
  ],
];
const build = BUILDS.map((commits) => ({
  commits,
  got: shared.buildReleaseChangelog({ from: "v1.0.0", to: "v1.0.1", commits, compareUrl: "https://example.com/c" }),
}));

mkdirSync(P("eh/with/.bun/bin"), { recursive: true });
mkdirSync(P("eh/without"), { recursive: true });
const ABS_PATH = ABS.join(":");
const HOMES = ["$ROOT/eh/with", "$ROOT/eh/without", "$ROOT/eh/with/", "$ROOT/eh/x/../with", "/", "", "eh-relative"];
const PATHS = [
  ["abs", ABS_PATH],
  ["abs, then /usr/bin", `${ABS_PATH}:/usr/bin`],
  ["empty segments", `::${ABS_PATH}::/usr/bin:`],
  ["duplicates", `/usr/bin:/usr/bin:${ABS_PATH}`],
  ["bun already first", `$HOME/.bun/bin:${ABS_PATH}`],
  ["bun already last", `${ABS_PATH}:$HOME/.bun/bin`],
  ["only some abs (machine)", "/usr/bin:/opt/homebrew/bin", true],
  ["empty (machine)", "", true],
  ["just colons (machine)", ":::", true],
];
const extended = [];
for (const home of HOMES) {
  for (const [label, path, machine] of PATHS) {
    const h = home.replaceAll("$ROOT", ROOT);
    const p = path.replaceAll("$HOME", h);
    extended.push({
      label,
      home,
      path: path.replaceAll("$HOME", home),
      ...(machine ? { machine } : {}),
      got: sub(spawnEnv.extendedPath(p, h)),
      candidates: spawnEnv.bunInstallCandidates(h).map(sub),
    });
  }
}

// The failure cache's time to live, on the module itself.
const ttl = [];
async function ttlStep(label, advance, responses) {
  clock += advance;
  wireQueue = responses.slice();
  wireLog = [];
  const r = await serverChangelog.getReleaseChangelog("v9.0.0", "v9.0.1");
  ttl.push({ label, advance, responses, fetched: wireLog.length, got: r });
}
await ttlStep("a 404", 0, [wire("HTTP/1.1 404 Not Found", "{}")]);
await ttlStep("cached", 1, []);
await ttlStep("still cached at TTL - 1", 299_998, []);
await ttlStep("refetched at the TTL", 1, [wire("HTTP/1.1 503 Service Unavailable", "")]);
await ttlStep("cached again", 299_999, []);
await ttlStep("refetched: a success", 1, [ok({ commits: [commit("ffffffffff", "fix: later")] })]);
await ttlStep("a success is kept", 10_000_000_000, []);
ttl.push({ label: "invalid tags", got: await serverChangelog.getReleaseChangelog("1.2.3", "v1.2.4") });

// ======================================================================
// messages
// ======================================================================

const hang = net.createServer(() => {});
await new Promise((r) => hang.listen(0, "127.0.0.1", r));
const messages = {};
try {
  await realFetch(`http://127.0.0.1:${hang.address().port}/`, { signal: AbortSignal.timeout(50) });
} catch (e) {
  messages.timeout = e.message;
  messages.timeoutIsError = e instanceof Error;
}
hang.close();
server.close();

const gitVersion = spawnSync(REAL_GIT, ["--version"], { encoding: "utf8" }).stdout.trim();
writeFileSync(
  process.env.UPD_GOLDEN_OUT,
  JSON.stringify(
    {
      node: process.version,
      git: gitVersion,
      t0: T0,
      env: ENV,
      abs: ABS,
      absExists: ABS.map((d) => existsSync(d)),
      phases,
      pure: { tags: TAGS.map((v) => ({ v, tag: shared.toReleaseTag(v) })), classify, shaCases, build, extended, ttl },
      messages,
    },
    null,
    1,
  ) + "\n",
);
