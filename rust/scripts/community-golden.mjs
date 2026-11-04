#!/usr/bin/env node
/**
 * Golden recorder for D24, the community chat's routes:
 *
 *   app/api/community/prefs/route.ts            GET / PUT (user settings)
 *   app/api/community/admin/check/route.ts      GET
 *   app/api/community/admin/[...path]/route.ts  GET / POST / DELETE proxy
 *
 * It drives the real route modules (node 22 with --experimental-transform-types,
 * a resolve hook for `@/`) in a child process with a temp HOME and
 * CLAUDE_CONFIG_DIR, twice, and the two recordings must match byte for byte.
 * It writes crates/claudius-server/tests/fixtures/community_golden.json, which
 * crates/claudius-server/tests/community.rs replays on the real binary.
 *
 * - prefs: one world and a run of GET / PUT requests and settings-file states;
 *   per step the answer (status, content type and body, or the message of
 *   what the route threw, which Next answers with an empty 500) and the
 *   `home` tree whenever it changed.
 * - admin: groups of env settings (a server of its own each in the replay);
 *   per group `admin/check`'s answer, then proxied requests against a local
 *   raw-TCP fake of the chat server that answers scripted bytes; per step the
 *   answer and every request that reached the fake. Next inlines
 *   NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL (next.config.ts `env`) into the
 *   routes, so each group imports next.config.ts afresh under its env and
 *   sets the value that computes. The catch-all's params are Next's own
 *   (`getRouteMatcher` on the route's regex). The default server,
 *   https://chat.claudius.network, is sent to
 *   http://127.0.0.1:<fake>/chat.claudius.network/..., as the replay's
 *   CLAUDIUS_DEV_FETCH_BASE does; any host but 127.0.0.1 is refused, so
 *   nothing leaves the machine.
 * - clients: getCommunityClient() per CLAUDIUS_ELECTRON value and
 *   process.platform, and withCommunityClientParam() on a few URLs.
 * - release: scripts/claudius-release.mjs in temp git repos.
 *
 * Run from rust/: node --experimental-transform-types scripts/community-golden.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/community_golden.json");

/** Make everything under `p` deletable again (steps chmod things away). */
function unlock(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(p, 0o700);
    for (const n of readdirSync(p)) unlock(join(p, n));
  } else {
    chmodSync(p, 0o600);
  }
}

if (!process.env.COMMUNITY_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "community-golden-")));
    try {
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "config"));
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 1 << 26,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            CLAUDE_CONFIG_DIR: join(root, "config"),
            COMMUNITY_GOLDEN_CHILD: root,
          },
        },
      );
      if (r.status !== 0) {
        process.stderr.write(r.stderr);
        process.exit(r.status ?? 1);
      }
      return readFileSync(join(root, "out.json"), "utf8");
    } finally {
      unlock(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  if (runs[0] !== runs[1]) throw new Error("the two recordings differ");
  const fixture = JSON.parse(runs[0]);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  const steps = fixture.admin.reduce((n, g) => n + g.steps.length, 0);
  const wire = fixture.admin.reduce((n, g) => n + g.steps.reduce((m, s) => m + (s.wire?.length ?? 0), 0), 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.prefs.length} prefs steps, ${fixture.admin.length} admin groups ` +
      `(${steps} requests, ${wire} upstream requests), ${fixture.clients.length} client ids, ` +
      `${fixture.releases.length} release scenarios (stable)`,
  );
  process.exit(0);
}

// ---- child ------------------------------------------------------------------

const ROOT = process.env.COMMUNITY_GOLDEN_CHILD;
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

const require = createRequire(import.meta.url);
const BASE_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const RELEASE = "7";

function setEnv(env) {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries({ ...BASE_ENV, NEXT_PUBLIC_CLAUDIUS_RELEASE: RELEASE, ...env })) {
    process.env[k] = v;
  }
}
setEnv({});

// ---- the fake chat server -------------------------------------------------------

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
    const lines = buf.subarray(0, at).toString("latin1").split("\r\n");
    const headers = lines.slice(1).map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i), l.slice(i + 1).trim()];
    });
    const len = Number(headers.find(([k]) => k.toLowerCase() === "content-length")?.[1] ?? 0);
    if (buf.length < at + 4 + len) return;
    done = true;
    const [method, path] = lines[0].split(" ");
    const body = buf.subarray(at + 4, at + 4 + len);
    const text = body.toString("utf8");
    wireLog.push({
      method,
      path,
      headers: headers.map(([k, v]) => [k, k.toLowerCase() === "host" ? v.replace(/:\d+$/, ":$PORT") : v]),
      ...(Buffer.from(text, "utf8").equals(body) ? { body: text } : { bodyHex: body.toString("hex") }),
    });
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
    sock.end(r.wireHex !== undefined ? Buffer.from(r.wireHex, "hex") : Buffer.from(r.wire, "latin1"));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
// A port nothing listens on.
const closed = net.createServer();
await new Promise((r) => closed.listen(0, "127.0.0.1", r));
const CLOSED_PORT = closed.address().port;
await new Promise((r) => closed.close(r));

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  let u = null;
  try {
    u = new URL(String(url));
  } catch {
    // Not a URL: undici fails it in its own words, without a connection.
  }
  let target = url;
  if (u && u.host === "chat.claudius.network") {
    target = `http://127.0.0.1:${PORT}/${u.host}${u.pathname}${u.search}`;
  } else if (u && u.hostname !== "127.0.0.1") {
    throw new Error(`community-golden: refusing to reach ${u.host}`);
  }
  return realFetch(target, init);
};

// ---- the modules ------------------------------------------------------------------

const mod = (p) => import(pathToFileURL(join(repo, p)).href);
const prefsRoute = await mod("app/api/community/prefs/route.ts");
const checkRoute = await mod("app/api/community/admin/check/route.ts");
const adminRoute = await mod("app/api/community/admin/[...path]/route.ts");
const communityClient = await mod("lib/shared/community-client.ts");
const { CLAUDIUS_VERSION } = await mod("lib/shared/version.ts");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const VERSION = `${pkg.version}.${RELEASE}`;
if (CLAUDIUS_VERSION !== VERSION) throw new Error(`CLAUDIUS_VERSION ${CLAUDIUS_VERSION} != ${VERSION}`);

const { getRouteMatcher } = require(join(repo, "node_modules/next/dist/shared/lib/router/utils/route-matcher.js"));
const { getNamedRouteRegex } = require(join(repo, "node_modules/next/dist/shared/lib/router/utils/route-regex.js"));
const matchAdmin = getRouteMatcher(getNamedRouteRegex("/api/community/admin/[...path]", { prefixRouteKeys: false }));

let configLoads = 0;
/** next.config.ts's `env`, evaluated under the current process.env. */
async function inlinedEnv() {
  const href = `${pathToFileURL(join(repo, "next.config.ts")).href}?load=${configLoads++}`;
  return (await import(href)).default.env;
}

const errText = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** What Next sends for a route's Response: the body's bytes as they are
 * (`res.text()` would drop a leading BOM). */
async function answer(res) {
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("a body that isn't UTF-8");
  return { status: res.status, type: res.headers.get("content-type"), body: text };
}

// Built at run time so this file stays ASCII-only.
const ch = (...cps) => String.fromCodePoint(...cps);
const BOM = ch(0xfeff);
const ASTRAL = ch(0x1f600);
const E_ACUTE = ch(0xe9);
/** A JSON `\uXXXX` escape, as text. */
const esc = (cp) => "\\" + "u" + cp.toString(16).padStart(4, "0");
const J = JSON.stringify;

// ---- prefs --------------------------------------------------------------------------

const W = join(ROOT, "w");
const S = "home/.claude/settings.json";

function tree() {
  const res = {};
  const walk = (rel) => {
    const dir = join(W, rel);
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = `${rel}/${name}`;
      const full = join(W, r);
      const st = lstatSync(full);
      const m = (st.mode & 0o777).toString(8);
      if (st.isSymbolicLink()) res[r] = { t: "l", to: readlinkSync(full).replaceAll(W, "$W") };
      else if (st.isDirectory()) {
        res[r] = { t: "d", m };
        walk(r);
      } else {
        let b = null;
        try {
          b = readFileSync(full);
        } catch {
          // unreadable: type and mode only
        }
        if (b === null) res[r] = { t: "f", m };
        else {
          const text = b.toString("utf8");
          res[r] = Buffer.from(text, "utf8").equals(b) ? { t: "f", m, x: text } : { t: "f", m, h: b.toString("hex") };
        }
      }
    }
  };
  walk("home");
  return res;
}

function buildFiles(files) {
  const entries = Object.entries(files);
  for (const [rel, spec] of entries) {
    const p = join(W, rel);
    unlock(p);
    rmSync(p, { recursive: true, force: true });
    if (spec.delete) continue;
    mkdirSync(dirname(p), { recursive: true });
    if (spec.dir) mkdirSync(p);
    else if (spec.symlink !== undefined) symlinkSync(spec.symlink.replaceAll("$W", W), p);
    else writeFileSync(p, spec.hex !== undefined ? Buffer.from(spec.hex, "hex") : spec.text);
  }
  for (const [rel, spec] of [...entries].reverse()) {
    if (spec.mode !== undefined && !spec.delete) chmodSync(join(W, rel), parseInt(spec.mode, 8));
  }
}

const subPrefs = (s) => s.replaceAll(W, "$W").replace(/\.tmp-\d+-\d+/g, ".tmp-$PID-$N");

const file = (text, extra = {}) => ({ op: "files", files: { [S]: { text, ...extra } } });
const put = (body) => ({ op: "put", body });
const GET = { op: "get" };

const RICH =
  `{"theme":"dark","communityNick":"old","n":1.50,"big":12345678901234567890,"neg":-0,"e":1E2,` +
  `"u":"${esc(0xe9)}${esc(0xd83d)}${esc(0xde00)}","sep":"${esc(0x2028)}","nested":{"b":1,"a":[]},` +
  `"10":"ten","2":"two","communityConsent":"bogus"}`;

const PREFS = [
  // No settings file yet.
  GET,
  put("{}"),
  put(J({ consent: "yes" })),
  put(J({ nick: "filipe" })),
  GET,
  put(J({ consent: "no", nick: null })),
  put(J({ consent: null })),
  put(J({ consent: null, nick: null })),
  // Refused values: nothing is written.
  put(J({ consent: "maybe" })),
  put(J({ consent: "YES" })),
  put(J({ consent: 1 })),
  put(J({ consent: true })),
  put(J({ consent: [] })),
  put(J({ consent: {} })),
  put(J({ consent: "" })),
  put(J({ consent: "yes", nick: 5 })),
  put(J({ nick: "x".repeat(64) })),
  put(J({ nick: "y".repeat(65) })),
  put(J({ nick: ASTRAL.repeat(32) })),
  put(J({ nick: ASTRAL.repeat(32) + "z" })),
  put(J({ nick: E_ACUTE.repeat(64) })),
  put(J({ nick: "" })),
  put(J({ nick: "  " })),
  put(J({ nick: null })),
  put(J({ nick: false })),
  put(J({ nick: 0 })),
  put(J({ nick: [] })),
  put(J({ nick: {} })),
  put(J({ nick: ["a"] })),
  put('{"consent":"yes","consent":"no","nick":"a","nick":"b"}'),
  put('{"__proto__":{"consent":"yes"}}'),
  put(J({ consent: "yes", nick: "n", theme: "dark" })),
  put('{"consent":1e400}'),
  put('{"nick":-1e400}'),
  put('{"other":1e400,"nick":"inf"}'),
  // Bodies that aren't objects, or aren't JSON.
  put("null"),
  put("[]"),
  put('["consent"]'),
  put('"consent"'),
  put("5"),
  put("1e400"),
  put("true"),
  put(""),
  put("{"),
  put('{"consent":"yes"} x'),
  put("{'consent':'yes'}"),
  put(BOM + J({ consent: "yes" })),
  put(BOM + BOM + J({ consent: "no" })),
  put(BOM + BOM + BOM + J({ consent: "no" })),
  // {"nick":"<ff>"}
  { op: "put", bodyHex: "7b226e69636b223a22ff227d" },
  put(" \t\n" + J({ nick: "ws" }) + "\n "),
  // What the file already holds: key order, number text, other keys.
  file(RICH),
  GET,
  put(J({ consent: "yes" })),
  put(J({ nick: null })),
  put(J({ nick: "new" })),
  file(J({ communityConsent: "no", communityNick: "" })),
  GET,
  file(J({ communityConsent: "yes", communityNick: 42 })),
  GET,
  file('  {"communityConsent" : "yes"}  \n\n'),
  GET,
  put("{}"),
  // {"n":"<ff><fe>"}: not UTF-8.
  { op: "files", files: { [S]: { hex: "7b226e223a22fffe227d" } } },
  GET,
  put("{}"),
  // Values TS assigns into as they are.
  file("[]"),
  GET,
  put(J({ consent: "yes", nick: "arr" })),
  GET,
  file('[1,{"a":2}]'),
  put("{}"),
  file('"abc"'),
  GET,
  put(J({ consent: "yes" })),
  put(J({ consent: null })),
  put(J({ nick: "" })),
  put("{}"),
  file("42"),
  GET,
  put(J({ consent: "no" })),
  put("{}"),
  file("1.5e3"),
  put(J({ nick: "n" })),
  file("true"),
  put(J({ nick: "x" })),
  file("false"),
  put(J({ consent: "yes" })),
  file("1e400"),
  GET,
  put(J({ consent: "yes" })),
  put("{}"),
  file("null"),
  GET,
  put(J({ consent: "yes" })),
  put(J({ consent: null })),
  put(J({ nick: "" })),
  put(J({ nick: "x" })),
  put("{}"),
  put("5"),
  // Files that don't load.
  file(""),
  GET,
  put(J({ consent: "yes" })),
  put("{"),
  file('{"a":'),
  GET,
  file(BOM + "{}"),
  GET,
  put("{}"),
  { op: "files", files: { [S]: { dir: true } } },
  GET,
  put(J({ consent: "yes" })),
  file(J({ communityConsent: "yes" }), { mode: "000" }),
  GET,
  put(J({ nick: "n" })),
  // Modes and links.
  file(J({ communityConsent: "yes" }), { mode: "600" }),
  put(J({ nick: "private" })),
  file(J({ communityConsent: "no" }), { mode: "640" }),
  put(J({ consent: "yes" })),
  { op: "files", files: { "home/.claude": { dir: true, mode: "555" }, [S]: { text: J({ communityNick: "ro" }) } } },
  GET,
  put(J({ consent: "yes" })),
  { op: "files", files: { "home/.claude": { dir: true }, [S]: { text: "{}\n" } } },
  {
    op: "files",
    files: { "home/dotfiles/settings.json": { text: J({ x: 1 }) }, [S]: { symlink: "../dotfiles/settings.json" } },
  },
  GET,
  put(J({ consent: "yes" })),
  { op: "files", files: { [S]: { symlink: "../dotfiles/new.json" } } },
  GET,
  put(J({ nick: "through" })),
  { op: "files", files: { [S]: { symlink: "$W/home/nowhere/settings.json" } } },
  GET,
  put(J({ nick: "lost" })),
  { op: "files", files: { [S]: { symlink: "settings.json" } } },
  GET,
  put("{}"),
  { op: "files", files: { [S]: { symlink: "../dotfiles" } } },
  GET,
  // No .claude dir at all: the write makes it.
  { op: "files", files: { "home/.claude": { delete: true }, "home/dotfiles": { delete: true } } },
  GET,
  put(J({ consent: "no", nick: "fresh" })),
  GET,
];

async function runPrefs() {
  mkdirSync(join(W, "home/.claude"), { recursive: true });
  setEnv({ HOME: join(W, "home") });
  const steps = [];
  let last = J(tree());
  const start = JSON.parse(last);
  for (const step of PREFS) {
    const r = { ...step };
    if (step.op === "files") {
      buildFiles(step.files);
    } else {
      try {
        let res;
        if (step.op === "get") res = await prefsRoute.GET();
        else {
          const body = step.bodyHex !== undefined ? Buffer.from(step.bodyHex, "hex") : Buffer.from(step.body, "utf8");
          const req = new Request("http://localhost/api/community/prefs", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body,
          });
          res = await prefsRoute.PUT(req);
        }
        r.got = await answer(res);
      } catch (e) {
        r.got = { threw: subPrefs(e instanceof Error ? e.message : String(e)) };
      }
    }
    const t = J(tree());
    if (t !== last) {
      r.tree = JSON.parse(t);
      last = t;
    }
    steps.push(r);
  }
  unlock(W);
  rmSync(W, { recursive: true, force: true });
  return { start, steps };
}

// ---- admin ----------------------------------------------------------------------------

/** One scripted HTTP response, as bytes (`wire` when they're all ASCII). */
function http(status, reason, body = "", opt = {}) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const lines = [`HTTP/${opt.version ?? "1.1"} ${status} ${reason}`];
  if (opt.type !== null) lines.push(`Content-Type: ${opt.type ?? "application/json"}`);
  for (const h of opt.headers ?? []) lines.push(h);
  if (opt.length !== false) lines.push(`Content-Length: ${opt.length ?? b.length}`);
  if (opt.close !== false) lines.push("Connection: close");
  const bytes = Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), b]);
  return bytes.every((c) => c < 0x80) ? { wire: bytes.toString("latin1") } : { wireHex: bytes.toString("hex") };
}
const OK = (body = '{"ok":true}', opt) => http(200, "OK", body, opt);
const get = (path, ...responses) => ({ method: "GET", path, responses });
const plain = "http://127.0.0.1:$PORT/";
const TOKEN = "s3cret token/+=";

const GROUPS = [
  {
    name: "the default server",
    env: { CLAUDIUS_CHAT_ADMIN_TOKEN: "tok-default" },
    steps: [
      get("bans", OK('{"bans":[]}')),
      { method: "POST", path: "bans", body: '{"nick":"troll"}', responses: [http(201, "Created", '{"ok":true}')] },
      { method: "DELETE", path: "bans/troll", responses: [OK()] },
      get("a%20b/caf%C3%A9", OK()),
    ],
  },
  {
    name: "a server URL",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: plain, CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [
      get("bans", OK('{"bans":[{"nick":"a"}]}', { type: "application/json; charset=utf-8" })),
      { method: "GET", path: "bans", body: '{"ignored":true}', responses: [OK()] },
      get("compact?keep=5", OK()),
      get("messages/recent?limit=1&x=%20", OK()),
      { method: "POST", path: "ban", body: '{"nick":"troll","minutes":10}', responses: [http(201, "Created", '{"ok":true}')] },
      { method: "POST", path: "ban", body: "", responses: [http(400, "Bad Request", '{"error":"bad json"}')] },
      { method: "POST", path: "ban", responses: [OK()] },
      { method: "POST", path: "ban", body: BOM, responses: [OK()] },
      { method: "POST", path: "ban", body: BOM + '{"nick":"b"}', responses: [OK()] },
      { method: "POST", path: "ban", body: BOM + BOM + BOM + "x", responses: [OK()] },
      { method: "POST", path: "ban", bodyHex: "7b226e69636b223a22ff227d", responses: [OK()] },
      { method: "POST", path: "note", body: "plain text, not json", responses: [OK()] },
      { method: "POST", path: "note", body: E_ACUTE + ASTRAL + ch(0x2028), responses: [OK()] },
      { method: "DELETE", path: "ban/troll", responses: [OK()] },
      { method: "DELETE", path: "messages/42", body: '{"reason":"spam"}', responses: [OK()] },
      { method: "DELETE", path: "messages/43", body: "", responses: [OK()] },
      // Path segments: decoded by Next, encoded again by the route.
      get("a%20b/caf%C3%A9/%c3%a9", OK()),
      get("a%2Fb/%25/%2B/+", OK()),
      get("!*'()~/@:$,;=&", OK()),
      get("%41%7A/%F0%9F%98%80/%22%3C%3E%60%7B%7D", OK()),
      get("_NEXTSEP_x/%5FNEXTSEP__NEXTSEP_y", OK()),
      get("_NEXTSEP_../up", OK()),
      get("deep/er/and/deeper", OK()),
      // Statuses.
      ...[201, 299, 400, 401, 403, 404, 409, 429, 500, 502, 503, 599].map((s) =>
        get(`status/${s}`, http(s, "Whatever", `{"status":${s}}`)),
      ),
      ...[204, 205, 304].map((s) => get(`status/${s}`, http(s, "Empty", "", { length: false }))),
      ...[600, 999].map((s) => get(`status/${s}`, http(s, "Odd", "{}"))),
      // Content types.
      get("type/text", OK("hi", { type: "text/plain" })),
      get("type/none", OK('{"a":1}', { type: null })),
      get("type/two", OK("x", { type: null, headers: ["Content-Type: text/plain", "Content-Type: text/html"] })),
      get("type/empty", OK("x", { type: "" })),
      get("type/latin1", OK("x", { type: `text/plain; charset=${String.fromCharCode(0xe9)}` })),
      get("type/case", OK("x", { type: null, headers: ["CONTENT-TYPE:   Text/HTML  "] })),
      // Bodies.
      get("body/empty", OK("")),
      get("body/unicode", OK(E_ACUTE + ASTRAL + ch(0x2028))),
      get("body/invalid", OK(Buffer.from("61ff62c3", "hex"))),
      get("body/bom", OK(BOM + BOM + BOM + "x")),
      get("body/chunked", OK("4\r\nchun\r\n3\r\nked\r\n0\r\n\r\n", { length: false, headers: ["Transfer-Encoding: chunked"] })),
      get("body/http10", OK("until close", { version: "1.0", length: false, close: false })),
      get("body/cut", OK("0123456789", { length: 100 })),
      get("hangup", { close: true }),
      // Redirects.
      get("redirect/302", http(302, "Found", "", { headers: ["Location: /moved"] }), OK('{"moved":true}')),
      {
        method: "POST",
        path: "redirect/303",
        body: '{"a":1}',
        responses: [http(303, "See Other", "", { headers: ["Location: /seen"] }), OK()],
      },
      {
        method: "POST",
        path: "redirect/307",
        body: '{"a":1}',
        responses: [http(307, "Temporary Redirect", "", { headers: ["Location: /again"] }), OK()],
      },
      {
        method: "POST",
        path: "redirect/302",
        body: '{"a":1}',
        responses: [http(302, "Found", "", { headers: ["Location: /got"] }), OK()],
      },
      {
        method: "DELETE",
        path: "redirect/301",
        body: '{"a":1}',
        responses: [http(301, "Moved Permanently", "", { headers: ["Location: /kept"] }), OK()],
      },
      {
        method: "DELETE",
        path: "redirect/303",
        responses: [http(303, "See Other", "", { headers: ["Location: /seen"] }), OK()],
      },
    ],
  },
  {
    name: "a path prefix and trailing slashes",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "http://127.0.0.1:$PORT/chat///", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans", OK())],
  },
  {
    name: "a query in the server URL",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "http://127.0.0.1:$PORT/q?x=1", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans", OK())],
  },
  {
    name: "a fragment in the server URL",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "http://127.0.0.1:$PORT/f#frag", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans", OK())],
  },
  {
    name: "a space before the server URL",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: " http://127.0.0.1:$PORT", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans", OK())],
  },
  {
    name: "a space after the server URL",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "http://127.0.0.1:$PORT ", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans")],
  },
  {
    name: "spaces and a tab around the token",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: plain, CLAUDIUS_CHAT_ADMIN_TOKEN: "  a\tb  " },
    steps: [get("bans", OK())],
  },
  {
    name: "a token that isn't a header value",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: plain, CLAUDIUS_CHAT_ADMIN_TOKEN: "bad\ntoken" },
    steps: [get("bans")],
  },
  {
    name: "electron",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: plain, CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN, CLAUDIUS_ELECTRON: "1" },
    steps: [get("bans", OK())],
  },
  {
    name: "CLAUDIUS_ELECTRON=true is the web",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: plain, CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN, CLAUDIUS_ELECTRON: "true" },
    steps: [get("bans", OK())],
  },
  {
    name: "the community turned off",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans"), { method: "POST", path: "ban", body: '{"nick":"x"}', responses: [] }, { method: "DELETE", path: "ban/x", responses: [] }],
  },
  {
    name: "a server URL of slashes",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "/", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans")],
  },
  {
    name: "no token",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: plain },
    steps: [get("bans"), { method: "POST", path: "ban", body: '{"nick":"x"}', responses: [] }],
  },
  {
    name: "an empty token",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: plain, CLAUDIUS_CHAT_ADMIN_TOKEN: "" },
    steps: [{ method: "DELETE", path: "ban/x", responses: [] }],
  },
  {
    name: "neither",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "" },
    steps: [get("bans")],
  },
  {
    name: "a server that refuses",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "http://127.0.0.1:$CLOSED", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans"), { method: "POST", path: "ban", body: '{"nick":"x"}', responses: [] }],
  },
  {
    name: "a server URL that doesn't parse",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "not a url", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans")],
  },
  {
    name: "a scheme fetch doesn't speak",
    env: { NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL: "ftp://127.0.0.1:$CLOSED", CLAUDIUS_CHAT_ADMIN_TOKEN: TOKEN },
    steps: [get("bans")],
  },
];

async function runAdmin() {
  const groups = [];
  for (const g of GROUPS) {
    const fill = (s) => s.replaceAll("$PORT", String(PORT)).replaceAll("$CLOSED", String(CLOSED_PORT));
    setEnv(Object.fromEntries(Object.entries(g.env).map(([k, v]) => [k, fill(v)])));
    const env = await inlinedEnv();
    if (env.NEXT_PUBLIC_CLAUDIUS_RELEASE !== RELEASE) throw new Error("next.config.ts didn't take the release");
    process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL = env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL;
    const client = communityClient.getCommunityClient();
    const encoded = encodeURIComponent(client);
    const sub = (s) =>
      s
        .replaceAll(`127.0.0.1:${PORT}`, "127.0.0.1:$PORT")
        .replaceAll(`127.0.0.1:${CLOSED_PORT}`, "127.0.0.1:$CLOSED")
        .replaceAll(encoded, "$CLIENT")
        .replaceAll(VERSION, "$VERSION");
    const rec = {
      name: g.name,
      env: g.env,
      inlined: sub(env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL),
      client: sub(client),
      check: await answer(await checkRoute.GET()),
      steps: [],
    };
    for (const step of g.steps) {
      const r = { ...step };
      const [pathname] = step.path.split("?");
      const params = matchAdmin(`/api/community/admin/${pathname}`);
      if (!params) throw new Error(`${g.name}: Next doesn't match ${step.path}`);
      r.params = params.path;
      wireQueue = [...(step.responses ?? [])];
      wireLog = [];
      const hasBody = step.method !== "GET" && step.method !== "HEAD";
      const bytes =
        step.bodyHex !== undefined
          ? Buffer.from(step.bodyHex, "hex")
          : step.body !== undefined
            ? Buffer.from(step.body, "utf8")
            : null;
      const req = new Request(`http://localhost/api/community/admin/${step.path}`, {
        method: step.method,
        ...(hasBody && bytes ? { body: bytes, headers: { "content-type": "application/json" } } : {}),
      });
      try {
        const res = await adminRoute[step.method](req, { params: Promise.resolve(params) });
        const a = await answer(res);
        r.got = { ...a, type: a.type === null ? null : sub(a.type), body: sub(a.body) };
      } catch (e) {
        r.got = { threw: sub(errText(e)) };
      }
      if (wireQueue.length) throw new Error(`${g.name} ${step.path}: ${wireQueue.length} responses unused`);
      if (wireLog.some((w) => w.unscripted)) throw new Error(`${g.name} ${step.path}: an unscripted request`);
      if (wireLog.length) r.wire = JSON.parse(sub(J(wireLog)));
      rec.steps.push(r);
    }
    groups.push(rec);
  }
  return groups;
}

// ---- client ids -----------------------------------------------------------------------

function runClients() {
  const realPlatform = process.platform;
  const rows = [];
  try {
    for (const electron of [null, "1", "0", "true", "", " 1", "1 ", "yes"]) {
      for (const platform of ["darwin", "win32", "linux", "freebsd", "openbsd", "aix", "sunos", "android", "cygwin"]) {
        setEnv(electron === null ? {} : { CLAUDIUS_ELECTRON: electron });
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        rows.push({ electron, platform, client: communityClient.getCommunityClient().replaceAll(VERSION, "$VERSION") });
      }
    }
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    setEnv({});
  }
  const urls = [
    "http://h/admin/x",
    "http://h/admin/x?y=1",
    "http://h/a#b?c",
    "http://h/a?",
    "",
    "?",
    "http://h/admin/caf%C3%A9",
  ].map((url) => ({ url, out: communityClient.withCommunityClientParam(url).replaceAll(VERSION, "$VERSION") }));
  return { rows, urls };
}

// ---- release ------------------------------------------------------------------------------

const RELEASES = [
  { name: "not a git repo", version: "1.2.3", git: false, tags: [] },
  { name: "no tags", version: "1.2.3", tags: [] },
  { name: "the highest", version: "1.2.3", tags: ["v1.2.3.0", "v1.2.3.4", "v1.2.3.12", "v1.2.3.9", "v1.2.4.99", "v1.2.30.50"] },
  {
    name: "only whole numbers count",
    version: "1.2.3",
    tags: ["v1.2.3.x", "v1.2.3.1.5", "v1.2.3.007", "v1.2.3.-1", "v1.2.3", "1.2.3.40", "v1.2.3.5a", "v1.2.3.1e3"],
  },
  { name: "past 2^53", version: "1.2.3", tags: ["v1.2.3.99999999999999999999", "v1.2.3.3"] },
  // (A tag is a file name: 255 bytes at most, so no run of digits past f64.)
  { name: "an exponent", version: "1.2.3", tags: [`v1.2.3.${"9".repeat(240)}`, "v1.2.3.2"] },
  { name: "a prerelease version", version: "1.0.0-beta.1", tags: ["v1.0.0-beta.1.3", "v1.0.0-beta.1.10", "v1.0.0-beta.10.99"] },
  { name: "an empty version", version: "", tags: ["v.1", "v.2.0"] },
];

function runReleases() {
  const gitEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (dir, ...args) =>
    execFileSync("git", ["-c", "user.name=golden", "-c", "user.email=golden@example.invalid", ...args], {
      cwd: dir,
      env: gitEnv,
      stdio: ["ignore", "pipe", "ignore"],
    });
  return RELEASES.map((s, i) => {
    const dir = join(ROOT, `release-${i}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), J({ name: "x", version: s.version }));
    if (s.git !== false) {
      git(dir, "init", "-q");
      git(dir, "commit", "-q", "--allow-empty", "-m", "golden");
      for (const t of s.tags) git(dir, "tag", t);
    }
    // next.config.ts: `execFileSync("node", [script]).toString().trim() || "0"`.
    const printed = execFileSync(process.execPath, [join(repo, "scripts/claudius-release.mjs")], {
      cwd: dir,
      env: gitEnv,
      stdio: ["ignore", "pipe", "ignore"],
    });
    rmSync(dir, { recursive: true, force: true });
    return { ...s, release: printed.toString().trim() || "0" };
  });
}

// ---- record -----------------------------------------------------------------------------------

const prefs = await runPrefs();
const admin = await runAdmin();
const clients = runClients();
const release = runReleases();
server.close();
writeFileSync(
  join(ROOT, "out.json"),
  J({
    platform: process.platform,
    release: RELEASE,
    prefsStart: prefs.start,
    prefs: prefs.steps,
    admin,
    clients: clients.rows,
    clientUrls: clients.urls,
    releases: release,
  }),
);
process.exit(0);
