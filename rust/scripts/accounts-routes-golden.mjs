#!/usr/bin/env node
// Golden fixture for the account switcher's routes (G02c):
// app/api/accounts/route.ts (GET / POST / PATCH / DELETE),
// app/api/accounts/profile/route.ts and app/api/account/route.ts, over the
// real lib/server/accounts-store.ts, account-profile.ts,
// claude-global-config.ts, session-manager.ts and session.ts.
//
//   node rust/scripts/accounts-routes-golden.mjs     (node@22; builds claudius-fake-claude)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp root and a resolve hook for the `@/` and
// extensionless imports, twice (two temp roots); both recordings must agree
// byte for byte. Nothing outside the temp root is read or written, and the
// real Anthropic API is never called: `fetch` is wrapped so that every
// request goes, through node's real fetch (undici), to a local raw-TCP
// server instead (`https://<host>/<path>` becomes
// `http://127.0.0.1:<port>/<host>/<path>`), which records each request as it
// arrives (`wire`: method, path, header lines, body; the port as `$PORT`)
// and answers with the step's next scripted response, byte for byte
// (`responses`: `wire` text or `wireHex`; `close` = hang up). All tokens
// are fake.
//
// Determinism: `crypto.randomBytes` is a counter (byte i of call n is
// `(n * 37 + i * 11 + 5) & 255`, n counted from 0 per case), `Date` is
// pinned to T0, and fs.promises calls are counted so the profile lookup's
// fire-and-forget metadata write is waited out after each request. The
// world prints as `$W`, `process.pid` in a temp name as `$PID`.
//
// Records:
// - `cases`: each builds its world `$W` (`files`; HOME is `$W/home`, the
//   store usually `CLAUDIUS_ACCOUNTS_DIR=$W/acc`) with empty caches and no
//   live session, then runs steps: `req` (one route call: `method`, `path`
//   with its query, and a raw body as `body` text or `bodyHex`; `got` is the
//   status, content type and body text, or `threw` with the message; `wire`
//   the profile requests that reached the fake) and `files` (change the
//   world). After each step, the world tree when it changed (`tree`: type,
//   mode, text or hex, link target).
// - `account`: `GET /api/account?sessionId=` on a bare session object
//   (`Object.create(Session.prototype)`) whose `query` is a real SDK
//   `query()` against the fake CLI with the group's `script`
//   (`sessionManager.get` answers it for its id; `$ID` in a path is that
//   id). `query: "none"` has no query; `"exited"` waits for the CLI to exit
//   after `initialize`.
// - `drift`: the real `PATCH /api/accounts` and
//   `sessionManager.notifyActiveAccountChanged()` with bare sessions in
//   `sessionManager.sessions`, each pinned (`accountProfileId`,
//   `accountProfileLabel`, `accountDriftFromActive`) as `sessions` says and
//   its `broadcast` recording what it is handed. Each step records the
//   answer (`got`, or `count` for `notify`), every session's events since
//   the last step and its pin afterwards.
//
// Written to rust/crates/claudius-server/tests/fixtures/accounts_routes_golden.json
// and replayed by crates/claudius-server/tests/accounts_routes.rs (`cases`
// and `account` on the real binary, `drift` in process on live fake-CLI
// sessions pinned through `Session::set_account_pin`).
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import net from "node:net";
import { createRequire, register, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/accounts_routes_golden.json");

/** Make everything under `p` deletable again (cases chmod things away). */
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

if (!process.env.ACCOUNTS_ROUTES_GOLDEN_CHILD) {
  execFileSync("cargo", ["build", "-q", "-p", "claudius-agent", "--bin", "claudius-fake-claude"], {
    cwd: rustDir,
    stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
  });
  const fake = join(rustDir, "target/debug/claudius-fake-claude");
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "accounts-routes-golden-")));
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
            ACCOUNTS_ROUTES_GOLDEN_CHILD: root,
            ACCOUNTS_ROUTES_GOLDEN_FAKE: fake,
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
  const reqs = fixture.cases.reduce((n, c) => n + c.steps.filter((s) => s.op === "req").length, 0);
  const wire = fixture.cases.reduce((n, c) => n + c.steps.reduce((m, s) => m + (s.wire?.length ?? 0), 0), 0);
  const acct = fixture.account.reduce((n, g) => n + g.cases.length, 0);
  const drift = fixture.drift.reduce((n, g) => n + g.steps.length, 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} cases (${reqs} requests, ${wire} profile fetches), ` +
      `${fixture.account.length} account groups (${acct} requests), ${fixture.drift.length} drift scenarios (${drift} steps) ` +
      `(SDK ${fixture.sdkVersion}, node ${fixture.node}; stable)`,
  );
  process.exit(0);
}

// ---- child ------------------------------------------------------------------

const ROOT = process.env.ACCOUNTS_ROUTES_GOLDEN_CHILD;
const FAKE = process.env.ACCOUNTS_ROUTES_GOLDEN_FAKE;
const START_ENV = { ...process.env };
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

// randomBytes: a counter, so ids and temp names repeat.
const nodeCrypto = require("node:crypto");
let rngCalls = 0;
nodeCrypto.randomBytes = (n, cb) => {
  if (cb) throw new Error("the golden only stubs the synchronous randomBytes");
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (rngCalls * 37 + i * 11 + 5) & 0xff;
  rngCalls++;
  return b;
};
syncBuiltinESMExports();

// Date: a pinned clock.
const T0 = 1790000000123;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(T0);
    else super(...a);
  }
  static now() {
    return T0;
  }
};

// fs.promises: count operations in flight, to wait out fire-and-forget writes.
const fsp = require("node:fs").promises;
let pending = 0;
for (const k of ["readFile", "writeFile", "rename", "chmod", "unlink", "mkdir", "readdir", "readlink", "symlink", "rm", "lstat", "stat"]) {
  const orig = fsp[k];
  fsp[k] = (...a) => {
    pending++;
    return orig.apply(fsp, a).finally(() => {
      pending--;
    });
  };
}
async function drain() {
  let idle = 0;
  for (let i = 0; i < 100000 && idle < 5; i++) {
    await new Promise((r) => setImmediate(r));
    idle = pending === 0 ? idle + 1 : 0;
  }
  if (pending !== 0) throw new Error("fs operations never settled");
}

// ---- the local profile server -------------------------------------------------

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
    wireLog.push({
      method,
      path,
      headers: headers.map(([k, v]) => [k, k.toLowerCase() === "host" ? v.replace(/:\d+$/, ":$PORT") : v]),
      body: body.toString("latin1"),
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

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  return realFetch(`http://127.0.0.1:${PORT}/${u.host}${u.pathname}${u.search}`, init);
};

const SDK = "@anthropic-ai/claude-agent-sdk";
const mod = (p) => import(pathToFileURL(join(repo, p)).href);
const accountsRoute = await mod("app/api/accounts/route.ts");
const profileRoute = await mod("app/api/accounts/profile/route.ts");
const accountRoute = await mod("app/api/account/route.ts");
const profileInfo = await mod("lib/server/account-profile.ts");
const globalCfg = await mod("lib/server/claude-global-config.ts");
const { sessionManager } = await mod("lib/server/session-manager.ts");
const { Session } = await mod("lib/server/session.ts");
const { query } = await import(SDK);
const sdkVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.resolve(SDK))), "package.json"), "utf8"),
).version;
const realGet = sessionManager.get;

// Non-ASCII without escapes in this file: a code point, and a JSON `\uXXXX`
// escape as text.
const cp = (...n) => String.fromCodePoint(...n);
const ju = (hex) => `${"\\"}u${hex}`;

// ---- helpers ----------------------------------------------------------------

function setEnv(env) {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

function buildFiles(W, files) {
  const entries = Object.entries(files ?? {});
  for (const [rel, spec] of entries) {
    const p = join(W, rel);
    if (spec.delete) {
      unlock(p);
      rmSync(p, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    if (spec.dir) mkdirSync(p, { recursive: true });
    else if (spec.symlink !== undefined) symlinkSync(spec.symlink.replaceAll("$W", W), p);
    else writeFileSync(p, spec.hex !== undefined ? Buffer.from(spec.hex, "hex") : spec.text);
  }
  for (const [rel, spec] of [...entries].reverse()) {
    if (spec.mode !== undefined && !spec.delete) chmodSync(join(W, rel), parseInt(spec.mode, 8));
  }
}

function tree(W, sub) {
  const res = {};
  const walk = (rel) => {
    const dir = rel ? join(W, rel) : W;
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && (name === "config" || name === "project")) continue;
      const full = join(W, r);
      const st = lstatSync(full);
      const m = (st.mode & 0o777).toString(8);
      if (st.isSymbolicLink()) res[r] = { t: "l", to: sub(readlinkSync(full)) };
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
          res[r] = Buffer.from(text, "utf8").equals(b) ? { t: "f", m, x: sub(text) } : { t: "f", m, h: b.toString("hex") };
        }
      }
    }
  };
  walk("");
  return res;
}

/** A route's response, or `threw` (Next's empty 500) with the message. */
async function call(fn, sub) {
  try {
    const res = await fn();
    return { status: res.status, type: res.headers.get("content-type"), body: sub(await res.text()) };
  } catch (e) {
    return { threw: sub(e instanceof Error ? e.message : String(e)) };
  }
}

const HANDLERS = {
  "GET /api/accounts": () => accountsRoute.GET,
  "POST /api/accounts": () => accountsRoute.POST,
  "PATCH /api/accounts": () => accountsRoute.PATCH,
  "DELETE /api/accounts": () => accountsRoute.DELETE,
  "GET /api/accounts/profile": () => profileRoute.GET,
  "GET /api/account": () => accountRoute.GET,
};

/** One route call: `method`, `path` (with its query) and the raw body. */
async function request(step, sub) {
  const pathname = step.path.split("?")[0];
  const handler = HANDLERS[`${step.method} ${pathname}`]?.();
  if (!handler) throw new Error(`no handler for ${step.method} ${step.path}`);
  const body =
    step.bodyHex !== undefined ? Buffer.from(step.bodyHex, "hex") : step.body !== undefined ? Buffer.from(step.body, "utf8") : null;
  const req = new Request(`http://localhost${step.path}`, {
    method: step.method,
    ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
  });
  return call(() => handler(req), sub);
}

function resetCaches() {
  profileInfo.invalidateProfileCache();
  globalCfg.__resetClaudeGlobalConfigCache();
}

// ---- store cases (replayed on the binary) ----------------------------------------

async function runCase(c, index) {
  const W = join(ROOT, `w${index}`);
  mkdirSync(join(W, "home"), { recursive: true });
  const sub = (s) => s.replaceAll(W, "$W").replaceAll(`.${process.pid}.`, ".$PID.");
  const fill = (v) => JSON.parse(JSON.stringify(v ?? {}).replaceAll("$W", W));
  rngCalls = 0;
  resetCaches();
  if (sessionManager.sessions.size !== 0) throw new Error("a live session leaked into a store case");
  setEnv({ HOME: `${W}/home`, ...fill(c.env) });
  buildFiles(W, fill(c.files));
  const rec = { name: c.name, env: c.env ?? {}, files: c.files ?? {}, start: tree(W, sub), steps: [] };
  let last = JSON.stringify(rec.start);
  for (const step of c.steps) {
    const r = { ...step };
    wireQueue = [...(step.responses ?? [])];
    wireLog = [];
    if (step.op === "req") {
      r.got = await request(step, sub);
      await drain();
    } else if (step.op === "files") {
      buildFiles(W, fill(step.files));
    } else {
      throw new Error(`unknown op ${step.op}`);
    }
    if (wireQueue.length) throw new Error(`${c.name}: ${wireQueue.length} responses unused`);
    if (wireLog.some((w) => w.unscripted)) throw new Error(`${c.name}: an unscripted request`);
    if (wireLog.length) r.wire = JSON.parse(sub(JSON.stringify(wireLog)));
    const t = tree(W, sub);
    if (JSON.stringify(t) !== last) {
      r.tree = t;
      last = JSON.stringify(t);
    }
    rec.steps.push(r);
  }
  unlock(W);
  rmSync(W, { recursive: true, force: true });
  return rec;
}

// ---- responses --------------------------------------------------------------

const JSON_TYPE = [["content-type", "application/json"]];

/** A raw HTTP/1.1 response: status line, headers, `content-length`,
 *  `connection: close`, then the body (`hex` bytes or UTF-8 text). */
function http(status, reason, body = "", opts = {}) {
  const { headers = JSON_TYPE, hex } = opts;
  const bytes = hex !== undefined ? Buffer.from(hex, "hex") : Buffer.from(body, "utf8");
  let head = `HTTP/1.1 ${status} ${reason}\r\n`;
  for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
  head += `content-length: ${bytes.length}\r\nconnection: close\r\n\r\n`;
  const all = Buffer.concat([Buffer.from(head, "latin1"), bytes]);
  const text = all.toString("latin1");
  return /^[\x20-\x7e\r\n]*$/.test(text) ? { wire: text } : { wireHex: all.toString("hex") };
}
const ok = (data) => http(200, "OK", typeof data === "string" ? data : JSON.stringify(data));
const CLOSE = { close: true };

// ---- data -------------------------------------------------------------------

const C0 = "2026-01-02T03:04:05.006Z";
const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "22222222-3333-4444-8555-666666666666";
const ORG_A = "99999999-8888-4777-8666-555555555555";
const P = {
  max: { id: "acc_max", label: "Personal Max", kind: "oauth-token", secret: "sk-ant-oat01-FAKE-max-0001", createdAt: C0 },
  work: {
    id: "acc_work",
    label: "Work",
    kind: "oauth-token",
    secret: "sk-ant-oat01-FAKE-work-0002",
    createdAt: C0,
    accountUuid: UUID_B,
    emailAddress: "work@example.com",
    organizationUuid: ORG_A,
    subscriptionType: "Claude Team",
  },
  api: { id: "acc_api", label: "Overflow API", kind: "api-key", secret: "sk-ant-api03-FAKE-0003", createdAt: C0 },
  short: { id: "acc_short", label: "Short", kind: "api-key", secret: "abc", createdAt: C0 },
  empty: { id: "acc_empty", label: "Empty secret", kind: "api-key", secret: "", createdAt: C0 },
  bedrock: {
    id: "acc_bed",
    label: "AWS SSO",
    kind: "bedrock",
    secret: "",
    createdAt: C0,
    bedrock: { auth: "aws-profile", region: "us-east-1", awsProfile: "work-sso", model: "claude-x" },
  },
  bedrockKeys: {
    id: "acc_keys",
    label: "AWS keys",
    kind: "bedrock",
    secret: "FAKEsecret0004",
    createdAt: C0,
    bedrock: { auth: "access-keys", accessKeyId: "AKIAFAKE1234", sessionToken: "FAKEsession0005", regionPrefix: "eu" },
  },
  brokenBedrock: {
    id: "acc_bk",
    label: "Broken AWS",
    kind: "bedrock",
    secret: "FAKEsecret0006",
    createdAt: C0,
    bedrock: { auth: "access-keys", accessKeyId: 99 },
  },
  unicode: {
    id: `acc_${cp(0xe9)}t${cp(0xe9)}`,
    label: `Caf${cp(0xe9)} ${cp(0x1f600)} ${cp(0x65e5, 0x672c)}`,
    kind: "api-key",
    secret: `sk-${cp(0x1f600)}${cp(0x1f601)}`,
    createdAt: C0,
  },
};
const store = (profiles, activeProfileId = null, autoRotateOnRateLimit = false) =>
  JSON.stringify({ profiles, activeProfileId, autoRotateOnRateLimit }, null, 2);
const STORE = "acc/accounts.json";
const E = { CLAUDIUS_ACCOUNTS_DIR: "$W/acc" };
const PROFILE_OK = {
  account: { uuid: UUID_A, email: "max@example.com", display_name: "Max User" },
  organization: { uuid: ORG_A, organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
};
const PROFILE_PRO = {
  account: { uuid: UUID_B, email: "work-new@example.com", display_name: "Work User" },
  organization: { uuid: ORG_A, organization_type: "claude_pro", rate_limit_tier: "default_claude_pro" },
};

const req = (method, path, body, responses) => ({
  op: "req",
  method,
  path,
  ...(body === undefined ? {} : typeof body === "string" ? { body } : { bodyHex: body.hex }),
  ...(responses ? { responses } : {}),
});
const GET = (path = "/api/accounts", responses) => req("GET", path, undefined, responses);
const POST = (body) => req("POST", "/api/accounts", body);
const PATCH = (body) => req("PATCH", "/api/accounts", body);
const DEL = (query) => req("DELETE", `/api/accounts${query}`);
const PROFILE = (query = "", responses) => req("GET", `/api/accounts/profile${query}`, undefined, responses);
/** A world spec: a string is a file's text. */
const spec = (f) =>
  f && Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === "string" ? { text: v } : v]));
const files = (f) => ({ op: "files", files: spec(f) });
const J = (v) => JSON.stringify(v);

const cases = [];
const add = (c) => cases.push({ env: E, ...c, ...(c.files ? { files: spec(c.files) } : {}) });

// -- GET
add({
  name: "GET: no store at all",
  steps: [GET(), PROFILE(), PROFILE("?id=acc_max"), PROFILE("?refresh=1"), DEL("?id=acc_max"), GET()],
});
add({
  name: "GET: every kind of profile",
  files: {
    [STORE]: store([P.max, P.work, P.api, P.short, P.empty, P.bedrock, P.bedrockKeys, P.unicode], "acc_work", true),
  },
  steps: [GET()],
});
add({
  name: "GET: foreign and odd store contents",
  files: {
    [STORE]: J({
      version: 3,
      profiles: [
        { ...P.max, extra: { nested: [1, 2.5] }, emailAddress: "keep@example.com", expiresAt: 1.5e12 },
        { id: 5, label: "number id", kind: "api-key", secret: "x", createdAt: C0 },
        { id: "acc_nokind", label: "no kind", secret: "x", createdAt: C0 },
        { id: "acc_badkind", label: "bad kind", kind: "token", secret: "x", createdAt: C0 },
        { id: "acc_nobedrock", label: "no bedrock", kind: "bedrock", secret: "", createdAt: C0 },
        null,
        "acc_string",
        P.api,
      ],
      activeProfileId: "acc_nokind",
      autoRotateOnRateLimit: "true",
    }),
  },
  steps: [GET(), PROFILE()],
});
add({
  name: "GET: profiles not an array",
  files: { [STORE]: J({ profiles: { 0: P.max, length: 1 }, activeProfileId: "acc_max", autoRotateOnRateLimit: true }) },
  steps: [GET(), PATCH(J({ autoRotateOnRateLimit: false }))],
});
add({
  name: "GET: an active id held by two profiles",
  files: { [STORE]: store([P.api, { ...P.max, id: "acc_api", label: "Twin" }], "acc_api") },
  steps: [GET(), PROFILE(), DEL("?id=acc_api")],
});
add({
  name: "GET: the default store under HOME",
  env: {},
  files: { "home/.claude/.claudius/accounts.json": store([P.api], "acc_api") },
  steps: [GET(), POST(J({ label: "Second", kind: "api-key", secret: "sk-ant-api03-FAKE-0101" })), PROFILE()],
});

// -- broken stores
const BROKEN = [
  ["malformed JSON", { [STORE]: { text: '{"profiles": [' } }],
  ["trailing garbage", { [STORE]: { text: `${store([P.api])} x` } }],
  ["a BOM", { [STORE]: { hex: `efbbbf${Buffer.from(store([P.api]), "utf8").toString("hex")}` } }],
  ["an empty file", { [STORE]: { text: "" } }],
  ["the file is null", { [STORE]: { text: "null" } }],
  ["the file is a number", { [STORE]: { text: "5" } }],
  ["a directory", { [STORE]: { dir: true } }],
  ["unreadable", { [STORE]: { text: store([P.api]), mode: "000" } }],
  ["a dangling symlink", { [STORE]: { symlink: "$W/acc/missing.json" } }],
];
for (const [what, f] of BROKEN) {
  add({
    name: `broken store: ${what}`,
    files: f,
    steps: [
      GET(),
      PROFILE(),
      PROFILE("?id=acc_api"),
      POST(J({ label: "New", kind: "api-key", secret: "sk-ant-api03-FAKE-0102" })),
      PATCH(J({ autoRotateOnRateLimit: true })),
      PATCH(J({ activeProfileId: "acc_api" })),
      PATCH(J({ activeProfileId: 7 })),
      DEL("?id=acc_api"),
    ],
  });
}
add({
  name: "broken store: a Bedrock profile toPublic refuses",
  files: { [STORE]: store([P.api, P.brokenBedrock], "acc_api") },
  steps: [
    GET(),
    PROFILE("?id=acc_bk"),
    PROFILE(),
    POST(J({ label: "Added anyway", kind: "api-key", secret: "sk-ant-api03-FAKE-0103" })),
    PATCH(J({ autoRotateOnRateLimit: true })),
    PATCH(J({ activeProfileId: "acc_bk" })),
    DEL("?id=acc_api"),
    DEL("?id=acc_bk"),
    GET(),
  ],
});
add({
  name: "broken store: a read-only store dir",
  files: { [STORE]: { text: store([P.api], "acc_api") }, acc: { dir: true, mode: "555" } },
  steps: [
    GET(),
    POST(J({ label: "New", kind: "api-key", secret: "sk-ant-api03-FAKE-0104" })),
    PATCH(J({ autoRotateOnRateLimit: true })),
    PATCH(J({ activeProfileId: "acc_api" })),
    DEL("?id=acc_api"),
    DEL("?id=acc_other"),
  ],
});
add({
  name: "broken store: the store dir is a file",
  files: { acc: { text: "not a dir" } },
  steps: [GET(), POST(J({ label: "New", kind: "api-key", secret: "sk-ant-api03-FAKE-0105" })), DEL("?id=acc_api")],
});

// -- POST
const BAD_BODIES = [
  undefined,
  "",
  " ",
  "{",
  "not json",
  "{'label':'x'}",
  '{"label":"x"} x',
  "null",
  "[]",
  '["label","kind"]',
  "5",
  "0",
  "true",
  '"label"',
  "{}",
  J({ label: "x" }),
  J({ kind: "api-key" }),
  J({ label: "", kind: "api-key", secret: "s" }),
  J({ label: 0, kind: "api-key", secret: "s" }),
  J({ label: false, kind: "api-key", secret: "s" }),
  J({ label: null, kind: "api-key", secret: "s" }),
  J({ label: "x", kind: "", secret: "s" }),
  J({ label: "x", kind: 0, secret: "s" }),
  J({ label: "x", kind: null, secret: "s" }),
  J({ label: "x", kind: "api-key" }),
  J({ label: "x", kind: "api-key", secret: "" }),
  J({ label: "x", kind: "api-key", secret: 0 }),
  J({ label: "x", kind: "api-key", secret: null }),
  J({ label: "x", kind: "oauth-token", secret: false }),
  J({ label: "x", kind: "Bedrock", secret: "" }),
  J({ label: "x", kind: ["bedrock"] }),
  J({ label: "   ", kind: "api-key", secret: "s" }),
  J({ label: `${cp(0xa0)}${cp(0x2028)}${cp(0xfeff)}`, kind: "api-key", secret: "s" }),
  J({ label: "x", kind: "api-key", secret: "   " }),
  J({ label: 5, kind: "api-key", secret: "s" }),
  J({ label: true, kind: "api-key", secret: "s" }),
  J({ label: {}, kind: "api-key", secret: "s" }),
  J({ label: ["x"], kind: "api-key", secret: "s" }),
  J({ label: "x", kind: "api-key", secret: 5 }),
  J({ label: "x", kind: "api-key", secret: ["s"] }),
  J({ label: "x", kind: "token", secret: "s" }),
  J({ label: "x", kind: 5, secret: "s" }),
  J({ label: "x", kind: { k: 1 }, secret: "s" }),
  J({ label: "x", kind: "bedrock" }),
  J({ label: "x", kind: "bedrock", bedrock: null }),
  J({ label: "x", kind: "bedrock", bedrock: "aws-profile" }),
  J({ label: "x", kind: "bedrock", bedrock: { auth: "sso" } }),
  J({ label: "x", kind: "bedrock", bedrock: { auth: "aws-profile" } }),
  J({ label: "x", kind: "bedrock", bedrock: { auth: "aws-profile", awsProfile: "p", region: "mars-1" } }),
  J({ label: "x", kind: "bedrock", bedrock: { auth: "access-keys", accessKeyId: "AKIA" } }),
  J({ label: "x", kind: "bedrock", bedrock: { auth: "bearer-token" } }),
  J({ label: "x", kind: "bedrock", bedrock: { auth: "ambient", regionPrefix: "mars" } }),
  J({ label: "x", kind: "bedrock", bedrock: { auth: "ambient", baseUrl: "ftp://x" } }),
  J({ label: "x", kind: "bedrock", secret: 5, bedrock: { auth: "ambient" } }),
  '{"__proto__":{"label":"x","kind":"api-key","secret":"s"}}',
  { hex: "c080" },
];
add({
  name: "POST: bodies refused before anything is written",
  steps: BAD_BODIES.map((b) => POST(b)),
});
add({
  name: "POST: the first profile becomes active",
  steps: [
    POST(J({ label: "  Personal Max  ", kind: "oauth-token", secret: "  sk-ant-oat01-FAKE-0201  " })),
    POST(J({ label: "Overflow", kind: "api-key", secret: "sk-ant-api03-FAKE-0202", bedrock: { auth: "ambient" } })),
    POST(
      J({
        label: "Extras ignored",
        kind: "api-key",
        secret: "sk-ant-api03-FAKE-0203",
        accountUuid: UUID_A,
        emailAddress: "x@example.com",
        organizationUuid: ORG_A,
        subscriptionType: "Claude Max",
        expiresAt: 1790000000123,
        id: "acc_mine",
        createdAt: "then",
      }),
    ),
    POST(J({ label: "abc", kind: "api-key", secret: "abcd" })),
    POST(J({ label: "four", kind: "api-key", secret: "abcde" })),
    POST(J({ label: "x", kind: "api-key", secret: "a" })),
    GET(),
  ],
});
add({
  name: "POST: Bedrock profiles",
  steps: [
    POST(J({ label: "SSO", kind: "bedrock", bedrock: { auth: "aws-profile", awsProfile: " work-sso ", region: " us-west-2 ", model: "claude-x", regionPrefix: "" } })),
    POST(J({ label: "Ambient", kind: "bedrock", bedrock: { auth: "ambient", regionPrefix: null, baseUrl: "https://bedrock.example.com" } })),
    POST(J({ label: "Keys", kind: "bedrock", secret: " FAKEsecret0301 ", bedrock: { auth: "access-keys", accessKeyId: "AKIAFAKE9999", sessionToken: "FAKEsession0302", regionPrefix: "apac" } })),
    POST(J({ label: "Bearer", kind: "bedrock", secret: "FAKEbedrockkey0303", bedrock: { auth: "bearer-token", extra: true } })),
    POST(J({ label: "Ignored secret", kind: "bedrock", secret: "FAKE0304", bedrock: { auth: "aws-profile", awsProfile: "p" } })),
    GET(),
  ],
});
add({
  name: "POST: unicode, escapes and duplicate keys",
  steps: [
    POST(J({ label: `${cp(0xa0)}Caf${cp(0xe9)} ${cp(0x1f600)}${cp(0x3000)}`, kind: "api-key", secret: `sk-${cp(0x1f600)}${cp(0x1f601)}` })),
    POST(`{"label":"esc ${ju("00e9")}${ju("d83d")}${ju("de00")}","kind":"api-key","secret":"sk${ju("0001")}tail"}`),
    POST('{"label":"first","label":"second","kind":"oauth-token","kind":"api-key","secret":"sk-ant-FAKE-0401"}'),
    POST(`${cp(0xfeff)}${J({ label: "BOM", kind: "api-key", secret: "sk-ant-FAKE-0402" })}`),
    POST({ hex: `efbbbfefbbbf${Buffer.from(J({ label: "Two BOMs", kind: "api-key", secret: "sk-ant-FAKE-0403" })).toString("hex")}` }),
    POST({ hex: `7b226c6162656c223a2261ff62222c226b696e64223a226170692d6b6579222c22736563726574223a2273227d` }),
    POST(` \n\t${J({ label: "padded", kind: "api-key", secret: "sk-ant-FAKE-0404" })}\r\n`),
    GET(),
  ],
});
add({
  name: "POST: next to a dangling active pointer",
  files: { [STORE]: store([P.api], "acc_gone", true) },
  steps: [POST(J({ label: "Takes over", kind: "api-key", secret: "sk-ant-api03-FAKE-0501" })), GET()],
});

// -- PATCH
add({
  name: "PATCH: bodies refused before anything is written",
  files: { [STORE]: store([P.max, P.api], "acc_max") },
  steps: [
    PATCH(undefined),
    PATCH(""),
    PATCH("{"),
    PATCH("null"),
    PATCH("[]"),
    PATCH("5"),
    PATCH('"acc_api"'),
    PATCH("{}"),
    PATCH(J({ activeProfileId: "" })),
    PATCH(J({ activeProfileId: null })),
    PATCH(J({ activeProfileId: 0 })),
    PATCH(J({ activeProfileId: false })),
    PATCH(J({ autoRotateOnRateLimit: "true" })),
    PATCH(J({ autoRotateOnRateLimit: 1 })),
    PATCH(J({ autoRotateOnRateLimit: null })),
    PATCH(J({ ActiveProfileId: "acc_api" })),
    PATCH('{"__proto__":{"activeProfileId":"acc_api"}}'),
    GET(),
  ],
});
add({
  name: "PATCH: switching and auto-rotate",
  files: { [STORE]: store([P.max, P.api, P.bedrock], "acc_max") },
  steps: [
    PATCH(J({ autoRotateOnRateLimit: true })),
    PATCH(J({ activeProfileId: "acc_api" })),
    PATCH(J({ activeProfileId: "acc_bed", autoRotateOnRateLimit: false })),
    PATCH(J({ activeProfileId: "acc_bed" })),
    PATCH(J({ activeProfileId: "", autoRotateOnRateLimit: true })),
    PATCH(J({ activeProfileId: "acc_missing" })),
    PATCH(J({ activeProfileId: "acc_missing", autoRotateOnRateLimit: false })),
    PATCH(J({ activeProfileId: 5, autoRotateOnRateLimit: true })),
    PATCH(J({ activeProfileId: true })),
    PATCH(J({ activeProfileId: ["acc_api"] })),
    PATCH(J({ activeProfileId: { id: "acc_api" } })),
    PATCH(J({ activeProfileId: "ACC_API" })),
    PATCH(J({ activeProfileId: " acc_api" })),
    PATCH('{"activeProfileId":"acc_api","activeProfileId":"acc_max","autoRotateOnRateLimit":true,"autoRotateOnRateLimit":false}'),
    PATCH(J({ activeProfileId: "acc_api", extra: 1 })),
    GET(),
  ],
});

// -- DELETE
add({
  name: "DELETE: ids and the active pointer",
  files: {
    [STORE]: store([P.max, P.api, P.short, P.unicode, { ...P.empty, id: "acc a+b" }], "acc_api"),
    "acc/profiles/acc_api/.credentials.json": { text: '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-FAKE-0601"}}', mode: "600" },
    "acc/profiles/acc_api/settings.json": { symlink: "$W/home/.claude/settings.json" },
    "acc/profiles/acc_short": { dir: true },
    "acc/profiles/acc_other/keep": { text: "kept" },
  },
  steps: [
    DEL(""),
    DEL("?id="),
    DEL("?ID=acc_api"),
    DEL("?id=acc_unknown"),
    DEL("?id=acc_api"),
    DEL("?id=acc_api"),
    DEL("?id=acc%5Fshort&id=acc_max"),
    DEL(`?id=${encodeURIComponent(P.unicode.id)}`),
    DEL("?id=acc+a%2Bb"),
    DEL("?id=acc_max"),
    GET(),
  ],
});
add({
  name: "DELETE: the last profile",
  files: { [STORE]: store([P.max], "acc_max", true) },
  steps: [DEL("?id=acc_max"), GET(), POST(J({ label: "Fresh", kind: "api-key", secret: "sk-ant-api03-FAKE-0701" }))],
});

// -- GET /api/accounts/profile
add({
  name: "profile: an oauth-token profile, cached for later",
  files: { [STORE]: store([P.max, P.api], "acc_max") },
  steps: [
    PROFILE("", [ok(PROFILE_OK)]),
    PROFILE(),
    PROFILE("?id=acc_max"),
    PROFILE("?id=acc_max&refresh=1", [ok(PROFILE_PRO)]),
    PROFILE("?refresh=true"),
    PROFILE("?refresh=01"),
    PROFILE("?refresh=%201"),
    PROFILE("?refresh=1&refresh=0", [ok(PROFILE_OK)]),
    PROFILE("?refresh=0&refresh=1"),
    PROFILE("?Refresh=1"),
    PROFILE("?refresh=%31", [ok(PROFILE_OK)]),
    PROFILE("?id=acc_api"),
    PROFILE("?id=acc_api&refresh=1"),
    PROFILE("?id=acc_unknown"),
    PROFILE("?id=acc_unknown&refresh=1"),
    PROFILE("?id="),
    PROFILE("?id=&refresh=1", [ok(PROFILE_OK)]),
    PROFILE("?id=acc%5Fmax"),
    PROFILE("?id=acc_max&id=acc_api"),
    PROFILE("?id=acc_api&id=acc_max"),
  ],
});
add({
  name: "profile: lookups that fail are not cached",
  files: { [STORE]: store([P.max, P.work], "acc_work") },
  steps: [
    PROFILE("?id=acc_max", [http(401, "Unauthorized", '{"error":"bad token"}')]),
    PROFILE("?id=acc_max", [http(403, "Forbidden", "")]),
    PROFILE("?id=acc_max", [http(500, "Internal Server Error", "oops")]),
    PROFILE("?id=acc_max", [http(529, "Overloaded", "")]),
    PROFILE("?id=acc_max", [http(404, "Not Found", "")]),
    PROFILE("?id=acc_max", [CLOSE]),
    PROFILE("?id=acc_max", [ok("{")]),
    PROFILE("?id=acc_max", [ok("null")]),
    PROFILE("?id=acc_max", [ok("")]),
    PROFILE("?id=acc_max", [ok("[]")]),
    PROFILE("?id=acc_max"),
    PROFILE("?id=acc_max&refresh=1", [ok('{"organization":null,"account":"str"}')]),
    PROFILE("", [http(401, "Unauthorized", "")]),
    PROFILE("", [CLOSE]),
    PROFILE("", [ok(PROFILE_PRO)]),
    PROFILE(""),
  ],
});
add({
  name: "profile: the global config fills in",
  files: {
    [STORE]: store([P.max, P.work, P.api], "acc_max"),
    "home/.claude.json": {
      text: J({
        oauthAccount: {
          accountUuid: UUID_B,
          emailAddress: "global@example.com",
          displayName: "Global User",
          organizationUuid: ORG_A,
          organizationName: "Org",
          billingType: "stripe",
          hasExtraUsageEnabled: true,
          extra: "dropped",
        },
        other: 1,
      }),
    },
  },
  steps: [
    PROFILE("", [http(503, "Service Unavailable", "")]),
    PROFILE("?id=acc_work", [http(403, "Forbidden", "")]),
    PROFILE("?id=acc_api"),
    files({ "home/.claude.json": { text: J({ oauthAccount: { emailAddress: "changed@example.com" } }) } }),
    PROFILE("?id=acc_max", [CLOSE]),
    PROFILE("?id=acc_api"),
  ],
});
add({
  name: "profile: a delete drops its cache entry",
  files: { [STORE]: store([P.max, P.api], "acc_max") },
  steps: [
    PROFILE("?id=acc_max", [ok(PROFILE_OK)]),
    PROFILE("?id=acc_api"),
    PROFILE("?id=acc_max"),
    DEL("?id=acc_max"),
    PROFILE("?id=acc_max"),
    files({ [STORE]: { text: store([P.max, P.api], "acc_api") } }),
    PROFILE("?id=acc_max", [ok(PROFILE_PRO)]),
    PROFILE("?id=acc_max"),
    DEL("?id=acc_unknown"),
    PROFILE("?id=acc_max"),
    PROFILE("?id=acc_api"),
    files({ [STORE]: { text: store([{ ...P.api, label: "Relabelled" }], "acc_api") } }),
    PROFILE("?id=acc_api"),
    PATCH(J({ activeProfileId: "acc_api" })),
    PROFILE(),
  ],
});
add({
  name: "profile: Bedrock profiles and a broken one",
  files: { [STORE]: store([P.bedrock, P.bedrockKeys, P.brokenBedrock, { ...P.bedrock, id: "acc_nofields", bedrock: { auth: "ambient" } }], "acc_keys") },
  steps: [PROFILE(), PROFILE("?id=acc_bed"), PROFILE("?id=acc_nofields"), PROFILE("?id=acc_bk"), PROFILE("?id=acc_bk&refresh=1")],
});
add({
  name: "profile: an empty id names no profile",
  files: { [STORE]: store([{ ...P.max, id: "" }, P.api], "") },
  steps: [PROFILE(), PROFILE("?id="), PROFILE("?id=&refresh=1"), PROFILE("?id=acc_api"), GET()],
});
add({
  name: "profile: the store breaks between lookups",
  files: { [STORE]: store([P.max], "acc_max") },
  steps: [
    PROFILE("", [ok(PROFILE_OK)]),
    files({ [STORE]: { text: "{" } }),
    PROFILE(),
    PROFILE("?id=acc_max"),
    files({ [STORE]: { text: store([P.max], "acc_max") } }),
    PROFILE(),
  ],
});

// ---- GET /api/account (replayed on the binary) -----------------------------------

let qdirs = 0;
/** A real SDK query against the fake CLI, as a bare session's `query`. */
async function openQuery(script) {
  const dir = join(ROOT, `q${qdirs++}`);
  const cwd = join(dir, "proj");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "home"));
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* prompt() {
    await done;
  }
  const ctrl = new AbortController();
  const q = query({
    prompt: prompt(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: FAKE,
      abortController: ctrl,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: join(dir, "home"),
        ...(script ? { FAKE_CLAUDE_SCRIPT: typeof script === "string" ? script : JSON.stringify(script) } : {}),
      },
    },
  });
  const drained = (async () => {
    try {
      for await (const m of q) void m;
    } catch {
      // the abort (or the CLI's exit) ends the stream with an error
    }
  })();
  await q.initializationResult().catch(() => undefined);
  const close = async () => {
    finish();
    ctrl.abort();
    await drained;
  };
  return { q, close, drained };
}

function bareSession(id) {
  const host = Object.create(Session.prototype);
  host.id = id;
  host.query = null;
  return host;
}

const ACCT = (q) => ({ path: `/api/account${q}` });
const RICH_ACCOUNT =
  '{"initialize":{"account":{"email":"fake.user@example.com","organization":"Org ' +
  ju("00e9") +
  " " +
  ju("d83d") +
  ju("de00") +
  '","subscriptionType":"max","apiKeySource":"oauth","tokenSource":"claude.ai","n":[1.0,1e2,-0.0,1e21,0.1],"10":"ten","2":"two","nested":{"b":null,"a":[true,false]}}}}';
const ACCOUNT_GROUPS = [
  {
    name: "validation",
    script: null,
    cases: [
      ACCT(""),
      ACCT("?sessionId="),
      ACCT("?sessionid=$ID"),
      ACCT("?id=$ID"),
      ACCT("?sessionId=missing"),
      ACCT("?sessionId=+$ID"),
      ACCT("?sessionId=$ID"),
      ACCT("?sessionId=$ID&sessionId=missing"),
      ACCT("?sessionId=missing&sessionId=$ID"),
    ],
  },
  { name: "a rich account", script: RICH_ACCOUNT, cases: [ACCT("?sessionId=$ID")] },
  { name: "account null", script: { initialize: { account: null } }, cases: [ACCT("?sessionId=$ID")] },
  { name: "account a string", script: { initialize: { account: "acct" } }, cases: [ACCT("?sessionId=$ID")] },
  { name: "account a number", script: { initialize: { account: 0 } }, cases: [ACCT("?sessionId=$ID")] },
  { name: "account false", script: { initialize: { account: false } }, cases: [ACCT("?sessionId=$ID")] },
  { name: "account an array", script: { initialize: { account: [1, "a", null] } }, cases: [ACCT("?sessionId=$ID")] },
  { name: "account empty", script: { initialize: { account: {} } }, cases: [ACCT("?sessionId=$ID")] },
  {
    name: "no account in initialize",
    script: { control: { initialize: { $response: { commands: [], models: [], agents: [] } } } },
    cases: [ACCT("?sessionId=$ID"), ACCT("?sessionId=missing")],
  },
  {
    name: "initialize answers null",
    script: { control: { initialize: { $response: null } } },
    cases: [ACCT("?sessionId=$ID")],
  },
  {
    name: "initialize answers a string",
    script: { control: { initialize: { $response: "init" } } },
    cases: [ACCT("?sessionId=$ID")],
  },
  {
    name: "initialize refused",
    script: { control: { initialize: { $error: "initialize refused" } } },
    cases: [ACCT("?sessionId=$ID")],
  },
  {
    name: "exited after initialize",
    script: { initialize: { account: { email: "gone@example.com" } }, on_init: [{ $stderr: "boom" }, { $exit: 3 }] },
    query: "exited",
    cases: [ACCT("?sessionId=$ID")],
  },
  { name: "no query", script: null, query: "none", cases: [ACCT("?sessionId=$ID"), ACCT("")] },
];

async function runAccountGroup(g, index) {
  const id = `golden-account-${index}`;
  const host = bareSession(id);
  let q = null;
  if (g.query !== "none") {
    q = await openQuery(g.script);
    host.query = q.q;
    if (g.query === "exited") await q.drained;
  }
  sessionManager.get = (sid) => (sid === id ? host : undefined);
  const cases = [];
  for (const c of g.cases) {
    const got = await request({ method: "GET", path: c.path.replaceAll("$ID", id) }, (s) => s.replaceAll(id, "$ID"));
    cases.push({ ...c, got });
  }
  sessionManager.get = realGet;
  if (q && g.query !== "exited") await q.close();
  return { name: g.name, script: g.script, query: g.query ?? "live", cases };
}

// ---- drift: PATCH with pinned live sessions (replayed in process) -----------------

const pin = (id, label, drift = null) => ({ id, label, drift });
const D = (id, label) => ({ id, label });
const A = { id: "acc_a", label: "Alpha", kind: "api-key", secret: "sk-ant-api03-FAKE-0801", createdAt: C0 };
const B = { id: "acc_b", label: "Bravo", kind: "oauth-token", secret: "sk-ant-oat01-FAKE-0802", createdAt: C0 };
const C = { id: "acc_c", label: "Charlie", kind: "api-key", secret: "sk-ant-api03-FAKE-0803", createdAt: C0 };
const NOTIFY = { op: "notify" };

const DRIFT = [
  {
    name: "a switch reaches every pinned session",
    files: { [STORE]: store([A, B, C], "acc_a") },
    sessions: [
      pin("acc_a", "Alpha"),
      pin("acc_b", "Bravo"),
      pin(null, null),
      pin("acc_a", "Alpha", D("acc_c", "Charlie")),
      pin("acc_gone", "Gone"),
      pin("acc_a", ""),
      pin("", "Alpha"),
      pin("acc_c", "Charlie", D("acc_a", "Alpha")),
    ],
    steps: [
      PATCH(J({ activeProfileId: "acc_b" })),
      PATCH(J({ activeProfileId: "acc_b" })),
      PATCH(J({ autoRotateOnRateLimit: true })),
      PATCH(J({ activeProfileId: "acc_missing" })),
      PATCH(J({ activeProfileId: 5, autoRotateOnRateLimit: false })),
      PATCH(J({ activeProfileId: "acc_a", autoRotateOnRateLimit: true })),
      PATCH(J({ activeProfileId: "acc_c" })),
      files({ [STORE]: { text: store([A, { ...B, label: "Bravo 2" }, { ...C, label: `Ch${cp(0xe4)}rlie ${cp(0x1f600)}` }], "acc_c") } }),
      PATCH(J({ activeProfileId: "acc_c" })),
      PATCH(J({ activeProfileId: "acc_b" })),
    ],
  },
  {
    name: "a notify without a switch",
    files: { [STORE]: store([A, B], "acc_b") },
    sessions: [pin("acc_a", "Alpha"), pin("acc_b", "Bravo"), pin("acc_a", "Alpha", D("acc_b", "Bravo"))],
    steps: [
      NOTIFY,
      NOTIFY,
      files({ [STORE]: { text: store([A, B], null) } }),
      NOTIFY,
      files({ [STORE]: { text: store([A, B], "acc_b") } }),
      NOTIFY,
      files({ [STORE]: { text: "{" } }),
      NOTIFY,
      files({ [STORE]: { text: store([A, B, { ...A, label: "Alpha twin" }], "acc_a") } }),
      NOTIFY,
      files({ [STORE]: { delete: true } }),
      files({ [STORE]: { dir: true } }),
      NOTIFY,
    ],
  },
  {
    name: "no live session",
    files: { [STORE]: store([A, B], "acc_a") },
    sessions: [],
    steps: [PATCH(J({ activeProfileId: "acc_b" })), NOTIFY],
  },
];

async function runDrift(sc, index) {
  const W = join(ROOT, `d${index}`);
  mkdirSync(join(W, "home"), { recursive: true });
  const sub = (s) => s.replaceAll(W, "$W").replaceAll(`.${process.pid}.`, ".$PID.");
  const fill = (v) => JSON.parse(JSON.stringify(v ?? {}).replaceAll("$W", W));
  rngCalls = 0;
  resetCaches();
  setEnv({ HOME: `${W}/home`, ...fill(E) });
  buildFiles(W, fill(sc.files));
  const hosts = sc.sessions.map((p, i) => {
    const host = bareSession(`golden-drift-${index}-${i}`);
    host.accountProfileId = p.id;
    host.accountProfileLabel = p.label;
    host.accountDriftFromActive = p.drift;
    host.events = [];
    host.broadcast = (ev) => host.events.push(JSON.parse(JSON.stringify(ev)));
    sessionManager.sessions.set(host.id, host);
    return host;
  });
  const steps = [];
  for (const step of sc.steps) {
    const r = { ...step };
    if (step.op === "req") {
      r.got = await request(step, sub);
      await drain();
    } else if (step.op === "notify") {
      r.count = await sessionManager.notifyActiveAccountChanged();
    } else if (step.op === "files") {
      buildFiles(W, fill(step.files));
    } else {
      throw new Error(`unknown op ${step.op}`);
    }
    r.events = hosts.map((h) => h.events.splice(0));
    r.pins = hosts.map((h) => pin(h.accountProfileId, h.accountProfileLabel, h.accountDriftFromActive));
    r.store = tree(W, sub)[STORE] ?? null;
    steps.push(r);
  }
  for (const h of hosts) sessionManager.sessions.delete(h.id);
  unlock(W);
  rmSync(W, { recursive: true, force: true });
  return { name: sc.name, files: sc.files, sessions: sc.sessions, steps };
}

// ---- run ----------------------------------------------------------------------

const fixture = { node: process.version, sdkVersion, t0: T0, cases: [], account: [], drift: [] };
for (const [i, c] of cases.entries()) fixture.cases.push(await runCase(c, i));
for (const [i, g] of ACCOUNT_GROUPS.entries()) {
  setEnv(START_ENV);
  fixture.account.push(await runAccountGroup(g, i));
}
for (const [i, sc] of DRIFT.entries()) fixture.drift.push(await runDrift({ ...sc, files: spec(sc.files) }, i));
server.close();
// A file, not stdout: `process.exit` would cut a piped stdout short.
writeFileSync(join(ROOT, "out.json"), JSON.stringify(fixture));
process.exit(0);
