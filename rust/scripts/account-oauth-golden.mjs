#!/usr/bin/env node
// Golden fixture for the account switcher's browser sign-in (G02b):
// lib/server/account-oauth.ts (`startOAuthFlow`, `exchangeOAuthCode`) and
// the handler in app/api/accounts/oauth/route.ts, over the real account
// store (lib/server/accounts-store.ts).
//
//   node rust/scripts/account-oauth-golden.mjs        (node@22)
//
// Re-runs itself under `--experimental-transform-types` with HOME and
// CLAUDE_CONFIG_DIR in a temp root and a resolve hook for the `@/` imports,
// twice (two temp roots); both recordings must agree byte for byte. Nothing
// outside the temp root is read or written, and the real Anthropic endpoints
// are never called: `fetch` is wrapped so that every request it is asked
// for (recorded as `fetches`: url, method, headers, body) goes, through
// node's real fetch (undici), to a local raw-TCP server instead
// (`https://<host>/<path>` becomes `http://127.0.0.1:<port>/<host>/<path>`).
// That server records each request as it arrives on the wire (`wire`:
// method, path, header lines, body; the port prints as `$PORT`) and answers
// with the step's next scripted response, sent byte for byte (`responses`:
// `wire` text or `wireHex`; `close` = hang up without answering; `refuse` =
// the request goes to a closed port instead). What undici made of it is
// recorded with the fetch (`res`: status, statusText and the body hex or the
// error reading it; or `throws`). All tokens and codes are fake.
//
// Determinism: `crypto.randomBytes` is a counter: byte i of call n is
// `(n * 37 + i * 11 + 5) & 255`, n counted from 0 per case, shared by the
// OAuth module and the store (`rng` lists each step's draw sizes). `Date` is
// pinned to T0 per case; only `advance` moves it. `process.pid` in a temp
// name prints as `$PID`, the world as `$W`.
//
// Each case builds its world `$W` (`files`: text, hex, dirs, modes; HOME is
// `$W/home`, the store usually `CLAUDIUS_ACCOUNTS_DIR=$W/acc`), then runs
// steps: `post` (the route's POST with a raw body, `body` text or `bodyHex`,
// where `$FLOWn` / `$STATEn` stand for the flowId / state of the case's n-th
// started flow; `got` is the status, content type and body text, or `threw`
// with the message), `start` / `exchange` (the module's exports called
// directly: `flow` / `code` are the raw arguments, absent = undefined;
// `out` is the result's `JSON.stringify`, or `throws`), `advance` (the
// clock) and `files`. After each step: `pending` (`__debugFlowCount()`) and
// the world tree when it changed (`tree`: type, mode, text or hex). The
// pending flows outlive a case in the TS module, so each case ends by
// taking its flows back out.
//
// Besides the cases, two tables recorded from the module's own exports:
// `refusedCodes` ([status, bodyText, isRefusedAuthCode(...)]: the CC 2.1.311
// predicate for a refused pasted code) and `certHints` ([errorSpec,
// isCaTrustFailure, ownRequestCertFailureHint] from
// lib/shared/tls-cert-hint.ts, the CC 2.1.309 hint; the specs are plain
// objects, because the TS only reads `code` / `message` / `cause`). A
// response `{throwCert: {code, message}}` makes the wrapped `fetch` reject
// with undici's shape (`TypeError("fetch failed", {cause})`) instead of
// sending anything, which is how a TLS-inspecting proxy shows; each step
// also records the `console.warn` lines it produced (`warns`).
//
// Written to rust/crates/claudius-core/tests/fixtures/account_oauth_golden.json;
// replayed by crates/claudius-core/tests/account_oauth_golden.rs (every
// case, scripted fetch) and crates/claudius-server/tests/accounts_oauth.rs
// (the `post`-only cases, on the real binary against a local token server).
import { spawnSync } from "node:child_process";
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
const out = join(rustDir, "crates/claudius-core/tests/fixtures/account_oauth_golden.json");

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

if (!process.env.OAUTH_GOLDEN_CHILD) {
  const runs = [0, 1].map(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "account-oauth-golden-")));
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
            OAUTH_GOLDEN_CHILD: root,
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
  const steps = fixture.cases.reduce((n, c) => n + c.steps.length, 0);
  const posts = fixture.cases.reduce((n, c) => n + c.steps.filter((s) => s.op === "post").length, 0);
  const fetches = fixture.cases.reduce((n, c) => n + c.steps.reduce((m, s) => m + (s.fetches?.length ?? 0), 0), 0);
  console.log(
    `wrote ${out.slice(repo.length + 1)}: ${fixture.cases.length} cases, ${steps} steps (${posts} requests, ` +
      `${fetches} fetches), ${fixture.refusedCodes.length} refusal checks, ${fixture.certHints.length} cert hints (stable)`,
  );
  process.exit(0);
}

// ---- child ------------------------------------------------------------------

const ROOT = process.env.OAUTH_GOLDEN_CHILD;
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
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const require = createRequire(import.meta.url);

// randomBytes: a counter, so states, verifiers, ids and temp names repeat.
const nodeCrypto = require("node:crypto");
let rngCalls = 0;
let rngSizes = [];
nodeCrypto.randomBytes = (n, cb) => {
  if (cb) throw new Error("the golden only stubs the synchronous randomBytes");
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (rngCalls * 37 + i * 11 + 5) & 0xff;
  rngCalls++;
  rngSizes.push(n);
  return b;
};
syncBuiltinESMExports();

// Date: a pinned clock.
const T0 = 1790000000123;
const RealDate = Date;
let NOW = T0;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(NOW);
    else super(...a);
  }
  static now() {
    return NOW;
  }
};

// console.warn: captured per step (the CC 2.1.309 cert-failure lines).
let warnLog = [];
console.warn = (...a) => warnLog.push(a.map((v) => String(v)).join(" "));

// ---- the local token server ---------------------------------------------------

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
    if (!r || r.refuse) {
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
// A port nothing listens on, for `refuse`.
const closed = net.createServer();
await new Promise((r) => closed.listen(0, "127.0.0.1", r));
const CLOSED_PORT = closed.address().port;
await new Promise((r) => closed.close(r));

const realFetch = globalThis.fetch;
let fetchCalls = [];
globalThis.fetch = async (url, init) => {
  const call = {
    url: String(url),
    method: init?.method ?? null,
    headers: init?.headers ? Object.entries(init.headers) : null,
    body: typeof init?.body === "string" ? init.body : null,
  };
  fetchCalls.push(call);
  const u = new URL(String(url));
  // A certificate failure: undici rejects with `TypeError("fetch failed")`
  // whose `cause` carries the OpenSSL code. Nothing is sent.
  const cert = wireQueue[0]?.throwCert;
  if (cert) {
    wireQueue.shift();
    const cause = Object.assign(new Error(cert.message), { code: cert.code });
    const err = new TypeError("fetch failed", { cause });
    call.res = { throws: err.message, cause: { code: cert.code, message: cert.message } };
    throw err;
  }
  const refuse = wireQueue[0]?.refuse === true;
  if (refuse) wireQueue.shift();
  const target = `http://127.0.0.1:${refuse ? CLOSED_PORT : PORT}/${u.host}${u.pathname}${u.search}`;
  try {
    const res = await realFetch(target, init);
    let body;
    try {
      body = { hex: Buffer.from(await res.clone().arrayBuffer()).toString("hex") };
    } catch (e) {
      body = { error: e.message };
    }
    call.res = { status: res.status, statusText: res.statusText, ...body };
    return res;
  } catch (e) {
    call.res = { throws: e.message };
    throw e;
  }
};

const mod = (p) => import(pathToFileURL(join(repo, p)).href);
const oauth = await mod("lib/server/account-oauth.ts");
const tlsHint = await mod("lib/shared/tls-cert-hint.ts");
const route = await mod("app/api/accounts/oauth/route.ts");

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
          res[r] = Buffer.from(text, "utf8").equals(b) ? { t: "f", m, x: text } : { t: "f", m, h: b.toString("hex") };
        }
      }
    }
  };
  walk("");
  return res;
}

const json = (v) => JSON.stringify(v === undefined ? null : v);

async function runCase(c, index) {
  const W = join(ROOT, `w${index}`);
  mkdirSync(W);
  const sub = (s) => s.replaceAll(W, "$W").replaceAll(`.${process.pid}.`, ".$PID.");
  const fill = (v) => JSON.parse(JSON.stringify(v ?? {}).replaceAll("$W", W));
  rngCalls = 0;
  NOW = T0;
  if (oauth.__debugFlowCount() !== 0) throw new Error(`case ${c.name} starts with pending flows`);
  setEnv({ HOME: `${W}/home`, ...fill(c.env) });
  buildFiles(W, fill(c.files));
  const rec = { name: c.name, env: c.env ?? {}, files: c.files ?? {}, start: tree(W, sub), steps: [] };
  let last = JSON.stringify(rec.start);
  const flows = [];
  const fillFlows = (s) =>
    s.replace(/\$(FLOW|STATE)(\d+)/g, (m, k, n) => {
      const f = flows[Number(n)];
      if (!f) throw new Error(`${c.name}: ${m} before its start`);
      return k === "FLOW" ? f.flowId : f.state;
    });
  for (const step of c.steps) {
    const r = { ...step };
    wireQueue = [...(step.responses ?? [])];
    wireLog = [];
    fetchCalls = [];
    rngSizes = [];
    warnLog = [];
    try {
      switch (step.op) {
        case "post": {
          const body =
            step.bodyHex !== undefined ? Buffer.from(step.bodyHex, "hex") : Buffer.from(fillFlows(step.body), "utf8");
          const req = new Request("http://localhost/api/accounts/oauth", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          try {
            const res = await route.POST(req);
            r.got = { status: res.status, type: res.headers.get("content-type"), body: sub(await res.text()) };
            if (res.status === 200) {
              const v = JSON.parse(r.got.body);
              if (typeof v?.flowId === "string") flows.push(v);
            }
          } catch (e) {
            r.got = { threw: sub(e instanceof Error ? e.message : String(e)) };
          }
          break;
        }
        case "start": {
          const v = oauth.startOAuthFlow();
          flows.push(v);
          r.out = json(v);
          break;
        }
        case "exchange": {
          const arg = (k) => (k in step ? JSON.parse(fillFlows(JSON.stringify(step[k]))) : undefined);
          try {
            r.out = sub(json(await oauth.exchangeOAuthCode(arg("flow"), arg("code"))));
          } catch (e) {
            r.throws = sub(e instanceof Error ? e.message : String(e));
          }
          break;
        }
        case "advance":
          NOW += step.ms;
          break;
        case "files":
          buildFiles(W, fill(step.files));
          break;
        default:
          throw new Error(`unknown op ${step.op}`);
      }
    } finally {
      if (wireQueue.length) throw new Error(`${c.name}: ${wireQueue.length} responses unused`);
      if (wireLog.some((w) => w.unscripted)) throw new Error(`${c.name}: an unscripted request`);
    }
    if (warnLog.length) r.warns = warnLog.map(sub);
    if (fetchCalls.length) r.fetches = JSON.parse(sub(JSON.stringify(fetchCalls)));
    if (wireLog.length) r.wire = JSON.parse(sub(JSON.stringify(wireLog)));
    if (rngSizes.length) r.rng = rngSizes;
    r.pending = oauth.__debugFlowCount();
    const t = tree(W, sub);
    if (JSON.stringify(t) !== last) {
      r.tree = t;
      last = JSON.stringify(t);
    }
    rec.steps.push(r);
  }
  // Take this case's flows back out of the module (the next case reuses
  // the same pinned ids).
  for (const f of flows) {
    try {
      await oauth.exchangeOAuthCode(f.flowId, " ");
    } catch {
      // "authorization code required", or already gone
    }
  }
  if (oauth.__debugFlowCount() !== 0) throw new Error(`case ${c.name} leaves pending flows`);
  unlock(W);
  rmSync(W, { recursive: true, force: true });
  return rec;
}

// ---- responses --------------------------------------------------------------

const JSON_TYPE = [["content-type", "application/json"]];

/**
 * A raw HTTP/1.x response: the status line (`reason: null` = none, not even
 * the space), the headers, `content-length` (or `chunked`, or nothing with
 * `noLength`), `connection: close`, then the body; `cut` bytes are promised
 * but never sent.
 */
function http(status, reason, body = "", opts = {}) {
  const { headers = JSON_TYPE, hex, chunked, cut = 0, version = "1.1", noLength = false } = opts;
  let bytes = hex !== undefined ? Buffer.from(hex, "hex") : Buffer.from(body, "utf8");
  let head = `HTTP/${version} ${status}${reason === null ? "" : ` ${reason}`}\r\n`;
  for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
  if (chunked) {
    head += "transfer-encoding: chunked\r\n";
    const parts = chunked.map((c) => `${Buffer.byteLength(c).toString(16)}\r\n${c}\r\n`);
    bytes = Buffer.from(`${parts.join("")}0\r\n\r\n`, "utf8");
  } else if (!noLength) head += `content-length: ${bytes.length + cut}\r\n`;
  head += "connection: close\r\n\r\n";
  const all = Buffer.concat([Buffer.from(head, "latin1"), bytes]);
  const text = all.toString("latin1");
  return /^[\x20-\x7e\r\n]*$/.test(text) ? { wire: text } : { wireHex: all.toString("hex") };
}
const ok = (data, opts) => http(200, "OK", typeof data === "string" ? data : JSON.stringify(data), opts);
const redirect = (status, reason, location) => http(status, reason, "", { headers: [["location", location]] });
const CLOSE = { close: true };
const REFUSE = { refuse: true };

// ---- data -------------------------------------------------------------------

const TOKEN = "sk-ant-oat01-FAKE-oauth-0001";
const REFRESH = "sk-ant-ort01-FAKE-refresh-0002";
const ACCOUNT = { uuid: "11111111-2222-4333-8444-555555555555", email_address: "fake.user@example.com" };
const ORG = { uuid: "99999999-8888-4777-8666-555555555555", organization_type: "claude_max" };
const DATA = {
  token_type: "Bearer",
  access_token: TOKEN,
  refresh_token: REFRESH,
  expires_in: 31536000,
  scope: "user:inference",
  account: ACCOUNT,
  organization: ORG,
};
const C0 = "2026-01-02T03:04:05.006Z";
const P = {
  oauth: { id: "acc_old", label: "Old Max", kind: "oauth-token", secret: "sk-ant-oat01-FAKE-old-0003", createdAt: C0 },
  api: { id: "acc_api", label: "Overflow API", kind: "api-key", secret: "sk-ant-api03-FAKE-0004", createdAt: C0 },
  brokenBedrock: {
    id: "acc_bk",
    label: "AWS keys",
    kind: "bedrock",
    secret: "FAKEsecret0005",
    createdAt: C0,
    bedrock: { auth: "access-keys", accessKeyId: 99 },
  },
};
const store = (profiles, activeProfileId = null, autoRotateOnRateLimit = false) =>
  JSON.stringify({ profiles, activeProfileId, autoRotateOnRateLimit }, null, 2);
const E = { CLAUDIUS_ACCOUNTS_DIR: "$W/acc" };

const START = '{"action":"start"}';
const complete = (code, label = "Work", flowId = "$FLOW0") => JSON.stringify({ action: "complete", flowId, code, label });
const post = (body, responses) => ({ op: "post", body, ...(responses ? { responses } : {}) });
const postHex = (bodyHex) => ({ op: "post", bodyHex });
const start = post(START);
const advance = (ms) => ({ op: "advance", ms });
const done = (data, label, code = "fake-code-0001#$STATE0") => [start, post(complete(code, label), [ok(data)])];

const cases = [];
const add = (c) => cases.push({ env: E, ...c });

// -- start
add({
  name: "start, then start again",
  steps: [start, start, post('{"action":"start","flowId":"x","code":"y","label":"z"}')],
});
add({
  name: "start answers for many random draws",
  steps: Array.from({ length: 24 }, () => ({ op: "start" })),
});

// -- the body
add({
  name: "bodies that are not a start or a complete",
  steps: [
    post(""),
    post("{"),
    post("{'action':'start'}"),
    post("null"),
    post("[]"),
    post('["start"]'),
    post('"start"'),
    post("5"),
    post("true"),
    post("{}"),
    post('{"action":"START"}'),
    post('{"action":" start"}'),
    post('{"action":["start"]}'),
    post('{"action":null}'),
    post('{"action":"stop"}'),
    post('{"action":"complete"}'),
    post('{"__proto__":{"action":"start"}}'),
    postHex("efbbbf7b22616374696f6e223a227374617274227d"),
    postHex("efbbbfefbbbf7b22616374696f6e223a227374617274227d"),
    postHex("efbbbfefbbbfefbbbf7b22616374696f6e223a227374617274227d"),
    postHex("7b22616374696f6e223a227374617274222c2278223a22ff227d"),
    post('{"action":"start","action":"complete"}'),
    post('{"action":"complete","action":"start"}'),
  ],
});

// -- complete: the required fields
add({
  name: "complete without flowId, code or label",
  steps: [
    start,
    post(JSON.stringify({ action: "complete", code: "c#$STATE0", label: "L" })),
    post(JSON.stringify({ action: "complete", flowId: "$FLOW0", label: "L" })),
    post(JSON.stringify({ action: "complete", flowId: "$FLOW0", code: "c#$STATE0" })),
    post(JSON.stringify({ action: "complete", flowId: "", code: "c", label: "L" })),
    post(JSON.stringify({ action: "complete", flowId: "$FLOW0", code: "", label: "L" })),
    post(JSON.stringify({ action: "complete", flowId: "$FLOW0", code: "c", label: "" })),
    post(JSON.stringify({ action: "complete", flowId: 0, code: "c", label: "L" })),
    post(JSON.stringify({ action: "complete", flowId: "$FLOW0", code: false, label: "L" })),
    post(JSON.stringify({ action: "complete", flowId: "$FLOW0", code: "c", label: null })),
  ],
});
add({
  name: "complete with an unknown or odd flowId",
  steps: [
    start,
    post(complete("c#$STATE0", "L", "oauth_0000000000000000")),
    post(complete("c#$STATE0", "L", " $FLOW0")),
    post(complete("c#$STATE0", "L", "$FLOW0 ")),
    post(JSON.stringify({ action: "complete", flowId: 5, code: "c", label: "L" })),
    post(JSON.stringify({ action: "complete", flowId: ["$FLOW0"], code: "c", label: "L" })),
    post(JSON.stringify({ action: "complete", flowId: { id: "$FLOW0" }, code: "c", label: "L" })),
    post(JSON.stringify({ action: "complete", flowId: true, code: "c", label: "L" })),
  ],
});

// -- complete: the pasted code
add({
  name: "complete with code#state, then the flow is gone",
  steps: [
    ...done(DATA, "  Work Max  "),
    post(complete("fake-code-0001#$STATE0")),
  ],
});
add({
  name: "complete with a bare code",
  steps: [start, post(complete("fake-code-bare", "Bare"), [ok(DATA)])],
});
add({
  name: "complete with a padded code",
  steps: [start, post(complete(" \t fake-code-pad#$STATE0 \n\u00a0\ufeff", "Padded"), [ok(DATA)])],
});
add({
  name: "complete with a malformed code#state",
  steps: [
    start,
    post(complete("#$STATE0")),
    start,
    post(complete("fake-code#", "L", "$FLOW1")),
    start,
    post(complete("#", "L", "$FLOW2")),
    start,
    post(complete("##", "L", "$FLOW3")),
    start,
    post(complete("fake-code#$STATE4#extra", "Extra", "$FLOW4"), [ok(DATA)]),
    start,
    post(complete("fake-code##$STATE5", "L", "$FLOW5")),
  ],
});
add({
  name: "complete with a state that does not match",
  steps: [
    start,
    start,
    post(complete("fake-code#$STATE1")),
    post(complete("fake-code#$STATE0")),
    post(complete("fake-code#$STATE1", "L", "$FLOW1"), [ok(DATA)]),
  ],
});
add({
  name: "complete with a blank code",
  steps: [start, post(complete("   ")), start, post(complete(" \u3000\u2028 ", "L", "$FLOW1"))],
});
add({
  name: "complete with a code that is not a string",
  steps: [
    start,
    post(JSON.stringify({ action: "complete", flowId: "$FLOW0", code: 5, label: "L" })),
    start,
    post(JSON.stringify({ action: "complete", flowId: "$FLOW1", code: true, label: "L" })),
    start,
    post(JSON.stringify({ action: "complete", flowId: "$FLOW2", code: ["c#$STATE2"], label: "L" })),
    start,
    post(JSON.stringify({ action: "complete", flowId: "$FLOW3", code: { c: 1 }, label: "L" })),
  ],
});
add({
  name: "complete with unicode, escapes and a long code",
  steps: [
    start,
    post(complete("c\u00f6de-\u{1f511}-\"q\"-\\-\u0001-\u2028#$STATE0", "\u{1f511} Keys"), [ok(DATA)]),
    start,
    post(complete(`${"x".repeat(20000)}#$STATE1`, "Long", "$FLOW1"), [ok(DATA)]),
  ],
});

// -- complete: the label
add({
  name: "complete with a label that is not a string",
  steps: [
    start,
    post(JSON.stringify({ action: "complete", flowId: "$FLOW0", code: "c#$STATE0", label: 5 }), [ok(DATA)]),
    start,
    post(JSON.stringify({ action: "complete", flowId: "$FLOW1", code: "c#$STATE1", label: true }), [ok(DATA)]),
    start,
    post(JSON.stringify({ action: "complete", flowId: "$FLOW2", code: "c#$STATE2", label: ["a"] }), [ok(DATA)]),
    start,
    post(JSON.stringify({ action: "complete", flowId: "$FLOW3", code: "c#$STATE3", label: { a: 1 } }), [ok(DATA)]),
    start,
    post(JSON.stringify({ action: "complete", flowId: "$FLOW4", code: "c#$STATE4", label: "x" }), [CLOSE]),
  ],
});
add({
  name: "a blank label falls back to the email",
  steps: [
    start,
    post(complete("c#$STATE0", "   "), [ok(DATA)]),
    start,
    post(complete("c#$STATE1", " \u00a0\ufeff\u3000 ", "$FLOW1"), [ok({ access_token: TOKEN })]),
    start,
    post(complete("c#$STATE2", " ", "$FLOW2"), [ok({ access_token: TOKEN, account: { email_address: 5 } })]),
    start,
    post(complete("c#$STATE3", " ", "$FLOW3"), [ok({ access_token: TOKEN, account: { email_address: { a: 1 } } })]),
    start,
    post(complete("c#$STATE4", " ", "$FLOW4"), [ok({ access_token: TOKEN, account: { email_address: [1, null, "x", [2, 3]] } })]),
    start,
    post(complete("c#$STATE5", " ", "$FLOW5"), [ok({ access_token: TOKEN, account: { email_address: true } })]),
    start,
    post(complete("c#$STATE6", " ", "$FLOW6"), [ok({ access_token: TOKEN, account: { email_address: "" } })]),
    start,
    post(complete("c#$STATE7", " ", "$FLOW7"), [ok({ access_token: TOKEN, account: { email_address: 0 } })]),
    start,
    post(complete("c#$STATE8", " ", "$FLOW8"), [ok({ access_token: TOKEN, account: { email_address: 1.5e21 } })]),
    start,
    post(complete("c#$STATE9", " ", "$FLOW9"), [ok({ access_token: TOKEN, account: { email_address: 0.000001 } })]),
    start,
    // Raw text: integer-like keys come first in JS, whatever the order sent.
    post(complete("c#$STATE10", " ", "$FLOW10"), [ok(`{"access_token":"${TOKEN}","account":{"email_address":{"b":1,"2":2,"1":3}}}`)]),
  ],
});

// -- the token endpoint's answers
const failing = [
  ["401 with a body", http(401, "Unauthorized", '{"error":"invalid_grant"}')],
  ["401 with nothing", http(401, null, "", { headers: [] })],
  ["400 with a JSON body", http(400, "Bad Request", '{"error":"invalid_grant","error_description":"Invalid code"}')],
  ["500 with no body", http(500, "Internal Server Error", "", { headers: [] })],
  ["500 with an empty reason", http(500, "", "", { headers: [] })],
  ["500 with a blank body", http(500, "Internal Server Error", " \n\t ")],
  ["503 with no reason", http(503, null, "", { headers: [] })],
  ["418 with an odd reason", http(418, "Odd   Reason  ", "", { headers: [] })],
  ["599 with no reason", http(599, null, "", { headers: [] })],
  ["429 with BOMs and bad bytes", http(429, "Too Many Requests", "", { hex: "efbbbfefbbbf736c6f7720646f776eff21" })],
  ["403 with a body cut short", http(403, "Forbidden", "partial", { cut: 9 })],
  ["404 with a chunked body", http(404, "Not Found", "", { chunked: ["not ", "found"] })],
  ["300 with no location", http(300, "Multiple Choices", "pick one")],
  ["302 to an error", null],
  ["a hang-up", CLOSE],
  ["a refused connection", REFUSE],
  ["a response that is not HTTP", { wire: "NOT HTTP AT ALL\r\n\r\n" }],
  ["a 200 cut short", http(200, "OK", '{"access_token":"x"', { cut: 5 })],
];
for (const [name, res] of failing) {
  const responses =
    res === null
      ? [redirect(302, "Found", "/platform.claude.com/v1/oauth/err"), http(500, "Internal Server Error", "after redirect")]
      : [res];
  add({ name: `token endpoint: ${name}`, steps: [start, post(complete("fake-code#$STATE0"), responses)] });
}
// -- CC 2.1.311: a refused pasted code says to sign in again
const refusals = [
  ["400 invalid_grant", http(400, "Bad Request", '{"error":"invalid_grant"}')],
  ["400 invalid_grant on hold", http(400, "Bad Request", '{"error":"invalid_grant","error_description":"account_on_hold"}')],
  ["400 invalid_grant nearly on hold", http(400, "Bad Request", '{"error":"invalid_grant","error_description":"account_on_holdx"}')],
  ["400 nested type", http(400, "Bad Request", '{"error":{"type":"invalid_grant","message":"nope"}}')],
  ["400 nested code", http(400, "Bad Request", '{"error":{"code":"invalid_grant"}}')],
  ["400 nested other", http(400, "Bad Request", '{"error":{"type":"invalid_request"}}')],
  ["400 nested deeper", http(400, "Bad Request", '{"error":{"type":{"type":"invalid_grant"}}}')],
  ["400 other error", http(400, "Bad Request", '{"error":"invalid_request"}')],
  ["400 error true", http(400, "Bad Request", '{"error":true}')],
  ["400 error array", http(400, "Bad Request", '{"error":["invalid_grant"]}')],
  ["400 not JSON", http(400, "Bad Request", "invalid_grant")],
  ["400 array body", http(400, "Bad Request", '["invalid_grant"]')],
  ["400 null body", http(400, "Bad Request", "null")],
  ["400 string body", http(400, "Bad Request", '"invalid_grant"')],
  ["400 padded body", http(400, "Bad Request", ' {"error":"invalid_grant"}\n')],
  ["400 duplicate error keys", http(400, "Bad Request", '{"error":"x","error":"invalid_grant"}')],
  ["400 body with a BOM", http(400, "Bad Request", "", { hex: `efbbbf${Buffer.from('{"error":"invalid_grant"}').toString("hex")}` })],
  ["400 on hold without invalid_grant", http(400, "Bad Request", '{"error_description":"account_on_hold"}')],
  ["401 invalid_grant", http(401, "Unauthorized", '{"error":"invalid_grant"}')],
  ["401 other error", http(401, "Unauthorized", '{"error":"invalid_client"}')],
  ["403 invalid_grant", http(403, "Forbidden", '{"error":"invalid_grant"}')],
  ["500 invalid_grant", http(500, "Internal Server Error", '{"error":"invalid_grant"}')],
];
for (const [name, res] of refusals) {
  add({ name: `refused code: ${name}`, steps: [start, post(complete("fake-code#$STATE0", "Refused"), [res])] });
}

// -- CC 2.1.309: the exchange can't verify the server's certificate
add({
  name: "token endpoint: the certificate is not trusted",
  steps: [start, post(complete("fake-code#$STATE0", "Proxy"), [{ throwCert: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "unable to verify the first certificate" } }])],
});
add({
  name: "token endpoint: a self-signed chain, by message alone",
  steps: [start, post(complete("fake-code#$STATE0", "SelfSigned"), [{ throwCert: { code: undefined, message: "self signed certificate in certificate chain" } }])],
});
add({
  name: "token endpoint: a TLS failure a CA bundle cannot fix",
  steps: [start, post(complete("fake-code#$STATE0", "Expired"), [{ throwCert: { code: "CERT_HAS_EXPIRED", message: "certificate has expired" } }])],
});

const bodies = [
  ["not JSON", "<html>nope</html>"],
  ["empty", ""],
  ["null", "null"],
  ["a number", "5"],
  ["a string", '"sk-ant-oat01-FAKE"'],
  ["an array", "[1]"],
  ["an empty object", "{}"],
  ["an empty token", '{"access_token":""}'],
  ["a zero token", '{"access_token":0}'],
  ["a false token", '{"access_token":false}'],
  ["a null token", '{"access_token":null}'],
  ["a number token", '{"access_token":12345}'],
  ["an object token", '{"access_token":{"t":1}}'],
  ["a blank token", '{"access_token":"   "}'],
  ["a padded token", '{"access_token":"  sk-ant-oat01-FAKE-pad-0006 \\n"}'],
  ["only a token", JSON.stringify({ access_token: TOKEN })],
  ["trailing garbage", `${JSON.stringify(DATA)}x`],
  ["a duplicate key", '{"access_token":"first","access_token":"sk-ant-oat01-FAKE-dup-0007"}'],
];
for (const [name, body] of bodies) {
  add({ name: `token body: ${name}`, steps: [start, post(complete("fake-code#$STATE0", "Body"), [ok(body)])] });
}
const wires = [
  ["one BOM", ok("", { hex: `efbbbf${Buffer.from(JSON.stringify(DATA)).toString("hex")}` })],
  ["two BOMs", ok("", { hex: `efbbbfefbbbf${Buffer.from(JSON.stringify(DATA)).toString("hex")}` })],
  ["three BOMs", ok("", { hex: `efbbbfefbbbfefbbbf${Buffer.from(JSON.stringify(DATA)).toString("hex")}` })],
  ["bad UTF-8 in the email", ok("", { hex: Buffer.from(JSON.stringify({ access_token: TOKEN, account: { email_address: "a@b.c__" } })).toString("hex").replace("5f5f", "ff80") })],
  ["chunked", ok("", { chunked: [JSON.stringify(DATA).slice(0, 20), JSON.stringify(DATA).slice(20)] })],
  ["HTTP/1.0, no length", ok(JSON.stringify(DATA), { version: "1.0", noLength: true })],
  ["a 201", http(201, "Created", JSON.stringify(DATA))],
  ["a 204", http(204, "No Content", "", { headers: [] })],
  ["a 299 with no reason", http(299, null, JSON.stringify(DATA))],
  ["a text/plain type", ok(JSON.stringify(DATA), { headers: [["content-type", "text/plain"]] })],
];
for (const [name, res] of wires) {
  add({ name: `token wire: ${name}`, steps: [start, post(complete("fake-code#$STATE0", "Wire"), [res])] });
}
add({
  name: "token redirects: 307 and 308 keep the POST",
  steps: [
    start,
    post(complete("fake-code#$STATE0", "R307"), [redirect(307, "Temporary Redirect", "/platform.claude.com/v1/oauth/token2"), ok(DATA)]),
    start,
    post(complete("fake-code#$STATE1", "R308", "$FLOW1"), [redirect(308, "Permanent Redirect", "/platform.claude.com/v1/oauth/token3"), ok(DATA)]),
  ],
});
add({
  name: "token redirects: 301, 302 and 303 turn into a GET",
  steps: [
    start,
    post(complete("fake-code#$STATE0", "R301"), [redirect(301, "Moved Permanently", "/platform.claude.com/moved"), ok(DATA)]),
    start,
    post(complete("fake-code#$STATE1", "R302", "$FLOW1"), [redirect(302, "Found", "/platform.claude.com/found?x=1"), ok(DATA)]),
    start,
    post(complete("fake-code#$STATE2", "R303", "$FLOW2"), [redirect(303, "See Other", "/platform.claude.com/other"), ok(DATA)]),
  ],
});
const hops = (n) => Array.from({ length: n }, (_, i) => redirect(307, "Temporary Redirect", `/platform.claude.com/hop/${i}`));
add({
  name: "token redirects: 20 are followed, 21 fail",
  steps: [
    start,
    post(complete("fake-code#$STATE0", "Twenty"), [...hops(20), ok(DATA)]),
    start,
    post(complete("fake-code#$STATE1", "TwentyOne", "$FLOW1"), hops(21)),
  ],
});

// -- what the token response says about the account
const shapes = [
  ["every org type", ["claude_max", "claude_pro", "claude_team", "claude_enterprise", "claude_free", "CLAUDE_MAX", 5, null]],
];
for (const [name, types] of shapes) {
  add({
    name: `account metadata: ${name}`,
    steps: types.flatMap((t, i) => [
      start,
      post(complete(`c#$STATE${i}`, `Org ${i}`, `$FLOW${i}`), [ok({ access_token: `${TOKEN}-${i}`, organization: { uuid: `org-${i}`, organization_type: t } })]),
    ]),
  });
}
const metas = [
  { access_token: TOKEN, account: null, organization: null },
  { access_token: TOKEN, account: "acct", organization: "org" },
  { access_token: TOKEN, account: [], organization: [] },
  { access_token: TOKEN, account: { uuid: 5, email_address: ["x@example.com"] }, organization: { uuid: { id: 1 } } },
  { access_token: TOKEN, account: { uuid: "", email_address: null }, organization: { uuid: 0 } },
  { access_token: TOKEN, account: { uuid: "u-1", email_address: "\u00e9@example.com" }, organization: { uuid: "o-1", organization_type: "claude_pro", rate_limit_tier: "x" } },
];
add({
  name: "account metadata: odd shapes",
  steps: metas.flatMap((d, i) => [start, post(complete(`c#$STATE${i}`, `Meta ${i}`, `$FLOW${i}`), [ok(d)])]),
});
const expiries = [3600, 0, -5, 1.5, 0.0001, "3600", null, true, [1], 1e300, 1e306, -1e306, 2 ** 53];
add({
  name: "expires_in values",
  steps: expiries.flatMap((e, i) => [
    start,
    post(complete(`c#$STATE${i}`, `Exp ${i}`, `$FLOW${i}`), [ok({ access_token: `${TOKEN}-${i}`, expires_in: e })]),
  ]),
});

// -- the store
add({
  name: "store: appended to existing profiles",
  files: { "acc/accounts.json": { text: store([P.oauth, P.api], "acc_api", true) } },
  steps: done(DATA, "Third"),
});
add({
  name: "store: no active profile, the new one becomes active",
  files: { "acc/accounts.json": { text: store([P.oauth, P.api], "acc_gone") } },
  steps: done(DATA, "New active"),
});
add({
  name: "store: foreign keys and an odd shape",
  files: {
    "acc/accounts.json": {
      text: JSON.stringify({ version: 2, profiles: [{ ...P.oauth, extra: { a: [1, 2] } }, { id: 5 }], activeProfileId: "acc_old", note: "x" }),
    },
  },
  steps: done(DATA, "Foreign"),
});
add({
  name: "store: accounts.json does not parse",
  files: { "acc/accounts.json": { text: '{"profiles": [' } },
  steps: done(DATA, "Broken"),
});
add({
  name: "store: accounts.json is a directory",
  files: { "acc/accounts.json": { dir: true } },
  steps: done(DATA, "Dir"),
});
add({
  name: "store: the directory is read-only",
  files: { acc: { dir: true, mode: "555" } },
  steps: done(DATA, "Read-only"),
});
add({
  name: "store: a broken Bedrock peer fails toPublic after the write",
  files: { "acc/accounts.json": { text: store([P.brokenBedrock], "acc_bk") } },
  steps: done(DATA, "After broken"),
});
add({
  name: "store: under HOME when CLAUDIUS_ACCOUNTS_DIR is not set",
  env: {},
  steps: done(DATA, "Home"),
});
add({
  name: "store: an empty CLAUDIUS_ACCOUNTS_DIR",
  env: { CLAUDIUS_ACCOUNTS_DIR: "" },
  steps: done(DATA, "Empty override"),
});
add({
  name: "store: two sign-ins in a row",
  steps: [
    start,
    start,
    post(complete("c1#$STATE1", "Second first", "$FLOW1"), [ok({ ...DATA, access_token: `${TOKEN}-a` })]),
    post(complete("c0#$STATE0", "First second"), [ok({ ...DATA, access_token: `${TOKEN}-b`, account: { uuid: "u-2", email_address: "two@example.com" } })]),
  ],
});

// -- the clock (core only)
add({
  name: "clock: a flow lives 10 minutes, to the millisecond",
  steps: [start, advance(600000), post(complete("c#$STATE0", "Edge"), [ok(DATA)]), start, advance(600001), post(complete("c#$STATE1", "Late", "$FLOW1"))],
});
add({
  name: "clock: a start sweeps expired flows",
  steps: [
    start,
    advance(300000),
    start,
    advance(300001),
    { op: "start" },
    advance(1),
    post(complete("c#$STATE1", "Middle", "$FLOW1"), [ok(DATA)]),
    post(complete("c#$STATE0", "Oldest")),
  ],
});
add({
  name: "clock: the expiry is taken at the exchange",
  steps: [start, advance(123456), post(complete("c#$STATE0", "Later"), [ok({ access_token: TOKEN, expires_in: 60 })])],
});

// -- the module's exports, called directly (core only)
add({
  name: "exchangeOAuthCode with raw arguments",
  steps: [
    { op: "start" },
    { op: "exchange", code: "c" },
    { op: "exchange", flow: null, code: "c" },
    { op: "exchange", flow: "$FLOW0" },
    { op: "start" },
    { op: "exchange", flow: "$FLOW1", code: null },
    { op: "start" },
    { op: "exchange", flow: "$FLOW2", code: 7 },
    { op: "start" },
    { op: "exchange", flow: "$FLOW3", code: "c#$STATE3", responses: [ok({ ...DATA, scope: ["odd"], refresh_token: null })] },
    { op: "start" },
    { op: "exchange", flow: "$FLOW4", code: "c", responses: [ok({ access_token: TOKEN, expires_in: 7200, refresh_token: 5, scope: "user:inference user:profile" })] },
    { op: "start" },
    { op: "exchange", flow: "$FLOW5", code: "c", responses: [ok({ access_token: [TOKEN] })] },
  ],
});

// -- known differences (each replayed with its own expectation; see the tests)
add({
  name: "divergent: a lone surrogate in the code",
  steps: [start, post(complete("fake-code-\ud800#$STATE0", "Surrogate"), [ok(DATA)])],
});
add({
  name: "divergent: expires_in past the f64 range",
  steps: [start, post(complete("c#$STATE0", "Huge"), [ok(`{"access_token":"${TOKEN}","expires_in":1e400}`)])],
});
add({
  name: "divergent: a body nested past 128 levels",
  steps: [post(`{"action":"start","x":${"[".repeat(200)}${"]".repeat(200)}}`)],
});

// ---- the module's own tables --------------------------------------------------

/** `isRefusedAuthCode(status, bodyText)` over every shape that matters. */
const REFUSED_CODES = [];
for (const status of [400, 401, 403, 500, 200, 0, -1, 1e3]) {
  for (const body of [
    '{"error":"invalid_grant"}',
    '{"error":"invalid_grant","error_description":"account_on_hold"}',
    '{"error":"invalid_grant","error_description":"ACCOUNT_ON_HOLD"}',
    '{"error":"invalid_grant","error_description":null}',
    '{"error":{"type":"invalid_grant"}}',
    '{"error":{"code":"invalid_grant"}}',
    '{"error":{"type":"x","code":"invalid_grant"}}',
    '{"error":{"type":"other"}}',
    '{"error":["invalid_grant"]}',
    '{"error":[{"type":"invalid_grant"}]}',
    '{"error":"Invalid_Grant"}',
    '{"error":" invalid_grant"}',
    '{"error":null}',
    '{"error":0}',
    '{"error":false}',
    '{"error":true}',
    '{"error":5}',
    "{}",
    "null",
    "[]",
    '["invalid_grant"]',
    "5",
    "true",
    '"invalid_grant"',
    "",
    "   ",
    "invalid_grant",
    "{",
    '{"error":"invalid_grant"',
    '{"error":"x","error":"invalid_grant"}',
    '{"error_description":"account_on_hold"}',
    '{"__proto__":{"error":"invalid_grant"}}',
    '{"error":"invalid_grant","error":"x"}',
    ' \t{"error":"invalid_grant"}\n',
    '{"error":"invalid_grant\u0000"}',
  ]) {
    REFUSED_CODES.push([status, body, oauth.isRefusedAuthCode(status, body)]);
  }
}

/**
 * `isCaTrustFailure` / `ownRequestCertFailureHint` over plain objects (the
 * TS reads only `code`, `message` and `cause`).
 */
const CERT_SPECS = [
  null,
  5,
  true,
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  {},
  [],
  { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
  { code: "SELF_SIGNED_CERT_IN_CHAIN" },
  { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
  { code: "UNABLE_TO_GET_ISSUER_CERT" },
  { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
  { code: "CERT_UNTRUSTED" },
  { code: "unable_to_verify_leaf_signature" },
  { code: "CERT_HAS_EXPIRED" },
  { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
  { code: "ECONNREFUSED" },
  { code: 5 },
  { code: null },
  { code: ["CERT_UNTRUSTED"] },
  { message: "unable to verify the first certificate" },
  { message: "UNABLE TO VERIFY THE FIRST CERTIFICATE" },
  { message: "Unable To Verify Leaf Signature" },
  { message: "x self signed certificate in certificate chain" },
  { message: "self-signed certificate" },
  { message: "unable to get issuer certificate" },
  { message: "unable to get local issuer certificate" },
  { message: "certificate trusted" },
  { message: "certificate untrusted" },
  { message: "certificate is trusted" },
  { message: "certificate is not trusted" },
  { message: "certificate is not untrusted" },
  { message: "CERTIFICATE NOT TRUSTED!" },
  { message: "trusted certificate" },
  { message: "certificate has expired" },
  { message: "Hostname/IP does not match certificate's altnames: Host: x" },
  { message: "fetch failed" },
  { message: 5 },
  // A non-ASCII unit that case-folds to ASCII: a non-`u` `i` regex does not
  // canonicalize it, so these do not match.
  { message: `unable to verify the fir${String.fromCodePoint(0x17f)}t certificate` },
  { message: `certificate ${String.fromCodePoint(0x131)}s not trusted` },
  { message: `certificate not trusted${String.fromCodePoint(0x212a)}` },
  { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } },
  { cause: { cause: { code: "CERT_UNTRUSTED" } } },
  { cause: { cause: { cause: { code: "CERT_UNTRUSTED" } } } },
  { message: "fetch failed", cause: { message: "self signed certificate" } },
  { code: "ECONNRESET", cause: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
  { cause: null },
  { cause: 5 },
  { cause: [{ code: "CERT_UNTRUSTED" }] },
  { message: 5, cause: { code: "CERT_UNTRUSTED" } },
];
const certHints = CERT_SPECS.map((spec) => [
  spec === undefined ? null : spec,
  tlsHint.isCaTrustFailure(spec),
  tlsHint.ownRequestCertFailureHint(spec) ?? null,
]);

// ---- run ----------------------------------------------------------------------

const fixture = { t0: T0, refusedCodes: REFUSED_CODES, certHints, cases: [] };
for (const [i, c] of cases.entries()) fixture.cases.push(await runCase(c, i));
server.close();
writeFileSync(join(ROOT, "out.json"), JSON.stringify(fixture));
