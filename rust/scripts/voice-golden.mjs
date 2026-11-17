#!/usr/bin/env node
// Golden fixture for the dictation proxy (D25): `GET /api/voice/stream`
// (SSE), `POST /api/voice/chunk` and `POST /api/voice/close`, recorded from
// the real TS route handlers over the real `lib/server/voice-stream.ts`,
// `extra-ca-certs.ts`, `tls-cert-hint.ts` and `ws`:
//
//   node rust/scripts/voice-golden.mjs     (node@22, openssl on PATH)
//
// The upstream is a fake WebSocket server on 127.0.0.1 (plain TCP, or TLS
// with certificates made by `openssl` for each run), reached through
// `VOICE_STREAM_BASE_URL`, the override the TS honours. It speaks raw
// RFC 6455 and picks its behaviour from the `language` query parameter (the
// route's `?lang=`): the leading [a-z] run names the scenario, the whole
// value keys its connection log. Every world (one upstream origin plus its
// files, user settings and environment) runs in its own node process, since
// the TS reads the origin once at import; `CLAUDIUS_ACCOUNTS_DIR`, HOME and
// CLAUDE_CONFIG_DIR point into a temp dir.
//
// A world's files go into HOME: a fixed `text`, or a certificate made for
// the run (`cert`) with optional `before` / `after` text around its PEM. Its
// `env` paths are relative to HOME (`envRaw` values are set as they are).
//
// A world's `steps` drive the handlers: `accounts` (write / remove
// accounts.json), `file` (rewrite or remove one of the world's files),
// `open` (GET the stream; a 200 keeps reading in the
// background), `wait` (until a needle shows up on a stream), `post` (chunk /
// close; `cl` sends a Content-Length as the browser would, `fill` is
// [byte, length]), `drain` (read to the end), `abort` (the client goes away,
// as Next aborts `req.signal`), `upstream` (wait until the fake server is
// done with a connection, then its log) and `settle` (sleep). Each result is
// recorded at the same index: status / content type / body text, or the
// stream text without its `: ping` heartbeats (`pinged` says whether one
// came). The upstream's port reads as `:<port>`.
//
// Written to rust/crates/claudius-server/tests/fixtures/voice_golden.json;
// replayed against the real binary by crates/claudius-server/tests/voice.rs,
// which runs the same fake upstream.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rustDir = resolve(here, "..");
const repo = resolve(rustDir, "..");
const out = join(rustDir, "crates/claudius-server/tests/fixtures/voice_golden.json");

// ---------------------------------------------------------------- the worlds

const OAUTH = {
  profiles: [
    { id: "p-key", label: "Key", kind: "api-key", secret: "sk-ant-api-golden", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "p-oauth", label: "Max", kind: "oauth-token", secret: "sk-ant-oat-golden", createdAt: "2026-01-01T00:00:00.000Z" },
  ],
  activeProfileId: "p-oauth",
  autoRotateOnRateLimit: false,
};
const withActive = (id, patch = {}) => ({
  ...OAUTH,
  profiles: OAUTH.profiles.map((p) => (p.id === "p-oauth" ? { ...p, ...patch } : p)),
  activeProfileId: id,
});
const pcm = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0")).join("");

/** One stream opened, read to its end, and the upstream's log for it. */
const flow = (id, lang) => [
  { op: "open", s: id, q: `id=${id}&lang=${encodeURIComponent(lang)}` },
  { op: "drain", s: id },
  { op: "upstream", lang },
];
/** Opened until `ready`, then the client goes away. */
const readyThenAbort = (id, lang) => [
  { op: "open", s: id, q: lang === undefined ? `id=${id}` : `id=${id}&lang=${encodeURIComponent(lang)}` },
  { op: "wait", s: id, needle: "event: ready" },
  { op: "abort", s: id },
  { op: "upstream", lang: lang || "en" },
];
/** A CERTIFICATE block whose DER isn't one (OpenSSL: `ASN1 lib`). */
const BAD_DER = "-----BEGIN CERTIFICATE-----\nAAAAAAAA\n-----END CERTIFICATE-----\n";
const failedOpen = (id) => [
  { op: "open", s: id, q: `id=${id}` },
  { op: "drain", s: id },
  { op: "post", path: `/api/voice/chunk?id=${id}`, hex: "0102", cl: true },
];

const mainSteps = [
  // Ids the routes refuse, and the chunk checks before the session lookup.
  { op: "open", s: "x0", q: "" },
  { op: "open", s: "x1", q: "id=short" },
  { op: "open", s: "x2", q: `id=${"x".repeat(65)}` },
  { op: "open", s: "x3", q: "id=abcd%20efgh" },
  { op: "open", s: "x4", q: "id=" },
  { op: "post", path: "/api/voice/chunk?id=bad", hex: "00", cl: true },
  { op: "post", path: "/api/voice/close?id=bad!bad!bad" },
  { op: "post", path: "/api/voice/close" },
  { op: "post", path: "/api/voice/chunk?id=unknown01", hex: "", cl: true },
  { op: "post", path: "/api/voice/chunk?id=unknown01", hex: "00", cl: true },
  { op: "post", path: "/api/voice/close?id=unknown01" },
  { op: "post", path: "/api/voice/chunk?id=unknown01", fill: [1, 1048577], cl: true },
  { op: "post", path: "/api/voice/chunk?id=unknown01", fill: [1, 1048577], cl: false },
  { op: "post", path: "/api/voice/chunk?id=unknown01", fill: [1, 1048576], cl: false },
  // No usable account.
  { op: "accounts", remove: true },
  ...failedOpen("noAccounts01"),
  { op: "accounts", json: withActive("p-key") },
  ...failedOpen("apiKeyOnly01"),
  { op: "accounts", json: withActive("p-gone") },
  ...failedOpen("noActive0001"),
  { op: "accounts", json: withActive("p-oauth", { secret: "" }) },
  ...failedOpen("emptySecret1"),
  { op: "accounts", text: "{oops" },
  ...failedOpen("badAccounts1"),
  { op: "accounts", json: withActive("p-oauth", { secret: "tok\nen" }) },
  ...failedOpen("badHeader001"),
  { op: "accounts", json: OAUTH },
  // The idle reaper: a socket stuck in CONNECTING (a 401 the TS swallows)
  // with no chunk for 30 s. Drained last; everything else runs meanwhile.
  { op: "open", s: "idleSession1", q: "id=idleSession1&lang=reject-idle" },
  { op: "wait", s: "idleSession1", needle: "retry:" },
  // The full flow: ready, chunks relayed, CloseStream, the upstream's close.
  { op: "open", s: "echoSession1", q: "id=echoSession1&lang=echo" },
  { op: "wait", s: "echoSession1", needle: "event: ready" },
  { op: "post", path: "/api/voice/chunk?id=echoSession1", hex: pcm, cl: true },
  { op: "wait", s: "echoSession1", needle: "256 bytes" },
  { op: "post", path: "/api/voice/chunk?id=echoSession1", fill: [7, 1048576], cl: true },
  { op: "wait", s: "echoSession1", needle: "1048576 bytes" },
  { op: "post", path: "/api/voice/close?id=echoSession1" },
  { op: "drain", s: "echoSession1" },
  { op: "upstream", lang: "echo" },
  { op: "post", path: "/api/voice/chunk?id=echoSession1", hex: "00", cl: true },
  { op: "post", path: "/api/voice/close?id=echoSession1" },
  // A second stream for a live id fails on its own; the first lives on.
  { op: "open", s: "dupSession01", q: "id=dupSession01&lang=echo-dup" },
  { op: "wait", s: "dupSession01", needle: "event: ready" },
  { op: "open", s: "dupSession01-b", q: "id=dupSession01&lang=echo-other" },
  { op: "drain", s: "dupSession01-b" },
  { op: "post", path: "/api/voice/chunk?id=dupSession01", hex: "0a0b0c", cl: true },
  { op: "wait", s: "dupSession01", needle: "3 bytes" },
  { op: "abort", s: "dupSession01" },
  { op: "upstream", lang: "echo-dup" },
  { op: "post", path: "/api/voice/chunk?id=dupSession01", hex: "00", cl: true },
  // The language reaches the upstream form-encoded; none is `en`.
  ...readyThenAbort("langSession1", "echo \u00e9+&x"),
  ...readyThenAbort("deflangSess1", undefined),
  // Frames relayed verbatim, a binary one dropped, a ping answered, the
  // upstream's close code and reason.
  ...flow("multiSession", "multi"),
  // A response that isn't an upgrade: CONNECTING until the client leaves.
  { op: "open", s: "rejectSess01", q: "id=rejectSess01&lang=reject" },
  { op: "wait", s: "rejectSess01", needle: "retry:" },
  { op: "settle", ms: 300 },
  { op: "post", path: "/api/voice/chunk?id=rejectSess01", hex: "00", cl: true },
  { op: "post", path: "/api/voice/close?id=rejectSess01" },
  { op: "abort", s: "rejectSess01" },
  { op: "upstream", lang: "reject" },
  { op: "post", path: "/api/voice/close?id=rejectSess01" },
  // Handshakes `ws` refuses, and frames its receiver refuses.
  ...flow("badAccept001", "badaccept"),
  ...flow("badUpgrade01", "badupgrade"),
  ...flow("protocol0001", "protocol"),
  ...flow("extensions01", "extensions"),
  ...flow("hangup000001", "hangup"),
  ...flow("garbage00001", "garbage"),
  ...flow("rsvFrame0001", "rsv"),
  ...flow("badUtf800001", "badutf"),
  ...flow("badClose0001", "badclose"),
  ...flow("masked000001", "masked"),
  ...flow("bigFrame0001", "big"),
  // The idle reaper's self-stop frame.
  { op: "drain", s: "idleSession1" },
  { op: "upstream", lang: "reject-idle" },
  { op: "post", path: "/api/voice/close?id=idleSession1" },
];

const WORLDS = [
  { name: "main", upstream: "plain", accounts: null, steps: mainSteps },
  {
    name: "refused",
    upstream: "refused",
    steps: [...failedOpen("refusedSess1")],
  },
  { name: "bad-url", upstream: "badurl", steps: [...failedOpen("badUrlSess01")] },
  {
    // A settings bundle without a certificate is ignored.
    name: "tls-self-signed",
    upstream: "tls:self",
    files: { "not-a-cert.txt": { text: "hello\n" } },
    settings: { env: { NODE_EXTRA_CA_CERTS: "not-a-cert.txt" } },
    steps: [...failedOpen("tlsSelf00001")],
  },
  {
    // One that doesn't read is ignored too.
    name: "tls-leaf-untrusted",
    upstream: "tls:leaf",
    settings: { env: { NODE_EXTRA_CA_CERTS: "~/missing.pem" } },
    steps: [...failedOpen("tlsLeaf00001")],
  },
  {
    name: "tls-settings-ca",
    upstream: "tls:leaf",
    files: { "ca.pem": { cert: "ca" } },
    settings: { env: { NODE_EXTRA_CA_CERTS: " ca.pem " } },
    steps: [...readyThenAbort("tlsCaOk00001", "en")],
  },
  {
    name: "tls-settings-wrong-ca",
    upstream: "tls:leaf",
    files: { "other-ca.pem": { cert: "other" } },
    settings: { env: { NODE_EXTRA_CA_CERTS: "~/other-ca.pem" } },
    steps: [...failedOpen("tlsWrongCa01")],
  },
  {
    name: "tls-env-ca",
    upstream: "tls:leaf",
    files: { "ca.pem": { cert: "ca" } },
    env: { NODE_EXTRA_CA_CERTS: "ca.pem" },
    steps: [...readyThenAbort("tlsEnvCa0001", "en")],
  },
  {
    name: "tls-wrong-host",
    upstream: "tls:host",
    files: { "ca.pem": { cert: "ca" } },
    settings: { env: { NODE_EXTRA_CA_CERTS: "~/ca.pem" } },
    steps: [...failedOpen("tlsHost00001")],
  },
  {
    // Node reads the environment's bundle once, when `tls` loads: garbling
    // or removing the file afterwards changes nothing.
    name: "tls-env-ca-read-once",
    upstream: "tls:leaf",
    files: { "ca.pem": { cert: "ca" } },
    env: { NODE_EXTRA_CA_CERTS: "ca.pem" },
    steps: [
      ...readyThenAbort("tlsOnce00001", "en"),
      { op: "file", path: "ca.pem", text: "garbage\n" },
      ...readyThenAbort("tlsOnce00002", "en-garbled"),
      { op: "file", path: "ca.pem", remove: true },
      ...readyThenAbort("tlsOnce00003", "en-removed"),
    ],
  },
  {
    // Node keeps the certificates read before a block that fails (and
    // warns on stderr)...
    name: "tls-env-ca-then-bad-der",
    upstream: "tls:leaf",
    files: { "bundle.pem": { cert: "ca", after: BAD_DER } },
    env: { NODE_EXTRA_CA_CERTS: "bundle.pem" },
    steps: [...readyThenAbort("tlsPartial01", "en")],
  },
  {
    // ...and none after it.
    name: "tls-env-bad-der-then-ca",
    upstream: "tls:leaf",
    files: { "bundle.pem": { before: BAD_DER, cert: "ca" } },
    env: { NODE_EXTRA_CA_CERTS: "bundle.pem" },
    steps: [...failedOpen("tlsBadDer001")],
  },
  {
    // Both set: the environment's bundle is the one trusted, the settings'
    // is ignored.
    name: "tls-env-and-settings",
    upstream: "tls:leaf",
    files: { "ca.pem": { cert: "ca" }, "other-ca.pem": { cert: "other" } },
    settings: { env: { NODE_EXTRA_CA_CERTS: "~/ca.pem" } },
    env: { NODE_EXTRA_CA_CERTS: "other-ca.pem" },
    steps: [...failedOpen("tlsBoth00001")],
  },
  {
    // A blank one doesn't count for the TS, which takes the settings' (Node
    // tries a file named " " and warns).
    name: "tls-env-blank-and-settings",
    upstream: "tls:leaf",
    files: { "ca.pem": { cert: "ca" } },
    settings: { env: { NODE_EXTRA_CA_CERTS: "~/ca.pem" } },
    envRaw: { NODE_EXTRA_CA_CERTS: " " },
    steps: [...readyThenAbort("tlsBlank0001", "en")],
  },
];

// ------------------------------------------------------------ the fake server

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const KEEPALIVE = '{"type":"KeepAlive"}';

/** An unmasked server frame. */
function frame(opcode, payload) {
  const body = Buffer.from(payload);
  const head = body.length < 126 ? Buffer.from([0x80 | opcode, body.length]) : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([head, body]);
}
const closeFrame = (code, reason) => frame(0x8, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason)]));

/**
 * The fake upstream. `logs` maps a `language` value to its connection's
 * log and a promise that settles when the server is done with it.
 */
function fakeUpstream(secure) {
  const logs = new Map();
  const entry = (lang) => {
    if (!logs.has(lang)) {
      let done;
      const p = new Promise((r) => (done = r));
      logs.set(lang, { log: [], done, p });
    }
    return logs.get(lang);
  };
  const onConn = (sock) => {
    let buf = Buffer.alloc(0);
    let conn = null;
    let keepalive = false;
    let finished = false;
    const finish = (eof) => {
      if (finished || !conn) return;
      finished = true;
      if (eof) conn.log.push("eof");
      if (keepalive) conn.log.push("keepalive");
      conn.done();
    };
    const hangUp = () => {
      finish(false);
      sock.destroy();
    };
    sock.on("end", () => finish(true));
    sock.on("close", () => finish(true));
    sock.on("error", () => {});
    const onFrame = (op, payload) => {
      if (op === 0x1) {
        const text = payload.toString("utf8");
        if (text === KEEPALIVE) {
          keepalive = true;
          return;
        }
        conn.log.push(`text ${text}`);
        if (text === '{"type":"CloseStream"}') {
          sock.write(frame(0x1, '{"type":"TranscriptText","data":"final \\"text\\" \\u00e9"}'));
          sock.write(frame(0x1, '{"type":"TranscriptEndpoint"}'));
          sock.write(closeFrame(1000, ""));
        }
      } else if (op === 0x2) {
        conn.log.push(`binary ${payload.length} ${payload.subarray(0, 8).toString("hex")}`);
        sock.write(frame(0x1, `{"type":"TranscriptInterim","data":"${payload.length} bytes"}`));
      } else if (op === 0xa) {
        conn.log.push(`pong ${payload.toString("utf8")}`);
      } else if (op === 0x8) {
        conn.log.push(payload.length >= 2 ? `close ${payload.readUInt16BE(0)} ${payload.subarray(2).toString("utf8")}` : "close");
        hangUp();
      } else {
        conn.log.push(`opcode ${op}`);
      }
    };
    const pump = () => {
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = (buf[1] & 0x80) !== 0;
        const total = off + (masked ? 4 : 0) + len;
        if (buf.length < total) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(total);
        onFrame(op, payload);
        if (finished) return;
      }
    };
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (conn) return pump();
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
      buf = buf.subarray(end + 4);
      const path = lines[0].split(" ")[1];
      const lang = new URL(path, "http://x").searchParams.get("language") ?? "";
      conn = entry(lang);
      conn.log.push(`request ${lines[0]}`);
      let key = "";
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        const name = line.slice(0, i);
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === "sec-websocket-key") key = value;
        conn.log.push(`header ${name}: ${name.toLowerCase() === "sec-websocket-key" ? "<key>" : value}`);
      }
      const accept = createHash("sha1").update(key + GUID).digest("base64");
      const ok = (extra = "") =>
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`;
      const scenario = (lang.match(/^[a-z]+/) ?? [""])[0];
      switch (scenario) {
        case "multi":
          sock.write(
            Buffer.concat([
              Buffer.from(ok()),
              frame(0x1, "line one\nline two"),
              frame(0x2, Buffer.from([1, 2, 3])),
              frame(0x9, "hi"),
              frame(0x1, '{"type":"TranscriptInterim","data":"x"}'),
              closeFrame(4001, "bye \u00e9"),
            ]),
          );
          break;
        case "reject":
          sock.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
          break;
        case "badaccept":
          sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bm90IHRoZSBhY2NlcHQ=\r\n\r\n");
          break;
        case "badupgrade":
          sock.write(ok().replace("Upgrade: websocket", "Upgrade: h2c"));
          break;
        case "protocol":
          sock.write(ok("Sec-WebSocket-Protocol: chat\r\n"));
          break;
        case "extensions":
          sock.write(ok("Sec-WebSocket-Extensions: permessage-deflate\r\n"));
          break;
        case "hangup":
          hangUp();
          break;
        case "garbage":
          sock.write("NOPE\r\n\r\n");
          break;
        case "rsv":
          sock.write(Buffer.concat([Buffer.from(ok()), Buffer.from([0xa1, 0x01, 0x78])]));
          break;
        case "badutf":
          sock.write(Buffer.concat([Buffer.from(ok()), Buffer.from([0x81, 0x02, 0x61, 0xff])]));
          break;
        case "badclose":
          sock.write(Buffer.concat([Buffer.from(ok()), Buffer.from([0x88, 0x02, 0x03, 0xed])]));
          break;
        case "masked":
          sock.write(Buffer.concat([Buffer.from(ok()), Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x78 ^ 1])]));
          break;
        case "big":
          sock.write(Buffer.concat([Buffer.from(ok()), Buffer.from([0x81, 127, 0, 0, 0, 0, 0x06, 0x40, 0x00, 0x01])]));
          break;
        default:
          sock.write(ok());
      }
      if (buf.length > 0 && !finished) pump();
    });
  };
  const server = secure ? tls.createServer(secure, onConn) : net.createServer(onConn);
  if (secure) server.on("tlsClientError", () => {});
  return { server, logs, entry };
}

// ----------------------------------------------------------------- the child

if (process.env.VOICE_GOLDEN_WORLD) {
  const world = JSON.parse(process.env.VOICE_GOLDEN_WORLD);
  const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  let upstream = null;
  const ports = [];
  if (world.upstream === "plain" || world.upstream.startsWith("tls:")) {
    let secure = null;
    if (world.upstream !== "plain") {
      const [cert, key] = world.serve;
      secure = { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
    }
    upstream = fakeUpstream(secure);
    const port = await listen(upstream.server);
    ports.push(port);
    process.env.VOICE_STREAM_BASE_URL = `${secure ? "wss" : "ws"}://127.0.0.1:${port}`;
  } else if (world.upstream === "refused") {
    const probe = net.createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    ports.push(port);
    process.env.VOICE_STREAM_BASE_URL = `ws://127.0.0.1:${port}`;
  } else {
    process.env.VOICE_STREAM_BASE_URL = "not a url";
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
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !s.includes(":") && !s.startsWith(".")) return next(s + ".js", ctx);
    throw e;
  }
}`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
  // The routes' own logging is noise here.
  if (!process.env.VOICE_GOLDEN_DEBUG) {
    console.log = () => {};
    console.warn = () => {};
  }
  const streamRoute = await import(join(repo, "app/api/voice/stream/route.ts"));
  const chunkRoute = await import(join(repo, "app/api/voice/chunk/route.ts"));
  const closeRoute = await import(join(repo, "app/api/voice/close/route.ts"));

  const norm = (s) => ports.reduce((acc, p) => acc.split(`:${p}`).join(":<port>"), s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (what, ms, f) => {
    const t0 = Date.now();
    while (!f()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
      await sleep(10);
    }
  };
  const unpinged = (st) => ({ text: norm(st.text.split(": ping\n\n").join("")), pinged: st.text.includes(": ping\n\n") });
  const streams = new Map();
  const accountsPath = join(process.env.CLAUDIUS_ACCOUNTS_DIR, "accounts.json");
  const results = [];
  for (const step of world.steps) {
    let got = null;
    if (step.op === "accounts") {
      if (step.remove) rmSync(accountsPath, { force: true });
      else writeFileSync(accountsPath, step.text ?? JSON.stringify(step.json, null, 2));
    } else if (step.op === "file") {
      const path = join(process.env.HOME, step.path);
      if (step.remove) rmSync(path);
      else writeFileSync(path, step.text);
    } else if (step.op === "open") {
      const ac = new AbortController();
      const res = await streamRoute.GET(new Request(`http://127.0.0.1:3000/api/voice/stream?${step.q}`, { signal: ac.signal }));
      got = { status: res.status, type: res.headers.get("content-type") };
      if (res.status !== 200) {
        got.body = await res.text();
      } else {
        got.cache = res.headers.get("cache-control");
        got.connection = res.headers.get("connection");
        got.buffering = res.headers.get("x-accel-buffering");
        const st = { text: "", ended: false, ac, reader: res.body.getReader() };
        const dec = new TextDecoder();
        (async () => {
          for (;;) {
            const { done, value } = await st.reader.read().catch(() => ({ done: true }));
            if (done) break;
            st.text += dec.decode(value, { stream: true });
          }
          st.ended = true;
        })();
        streams.set(step.s, st);
      }
    } else if (step.op === "wait") {
      const st = streams.get(step.s);
      await until(step.needle, 10_000, () => st.text.includes(step.needle));
    } else if (step.op === "drain") {
      const st = streams.get(step.s);
      await until(`end of ${step.s}`, 60_000, () => st.ended);
      got = unpinged(st);
    } else if (step.op === "abort") {
      const st = streams.get(step.s);
      got = unpinged(st);
      st.ac.abort();
      await st.reader.cancel().catch(() => {});
    } else if (step.op === "upstream") {
      const e = upstream.entry(step.lang);
      await Promise.race([e.p, sleep(10_000).then(() => { throw new Error(`upstream ${step.lang} never finished`); })]);
      got = e.log.map(norm);
    } else if (step.op === "settle") {
      await sleep(step.ms);
    } else if (step.op === "post") {
      const body = step.fill ? Buffer.alloc(step.fill[1], step.fill[0]) : step.hex !== undefined ? Buffer.from(step.hex, "hex") : Buffer.alloc(0);
      const headers = step.cl ? { "content-length": String(body.length) } : {};
      const req = new Request(`http://127.0.0.1:3000${step.path}`, { method: "POST", headers, body, duplex: "half" });
      const route = step.path.startsWith("/api/voice/chunk") ? chunkRoute : closeRoute;
      const res = await route.POST(req);
      got = { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
    }
    results.push(got);
  }
  if (process.env.VOICE_GOLDEN_DEBUG) console.error(JSON.stringify(results, null, 1));
  writeFileSync(process.env.VOICE_GOLDEN_OUT, JSON.stringify(results));
  process.exit(0);
}

// ---------------------------------------------------------------- the parent

const root = realpathSync(mkdtempSync(join(tmpdir(), "voice-golden-")));
try {
  // The certificates: a CA, a leaf it signed for 127.0.0.1 and one for
  // `localhost` only, a self-signed leaf for 127.0.0.1, and another CA.
  const certs = join(root, "certs");
  mkdirSync(certs);
  const ssl = (...args) => {
    const r = spawnSync("openssl", args, { cwd: certs, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`openssl ${args.join(" ")}: ${r.stderr}`);
  };
  const ca = (name) =>
    ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "30",
      "-subj", `/CN=Voice Golden ${name}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  const leaf = (name, san) => {
    writeFileSync(join(certs, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`);
    ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=127.0.0.1");
    ssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "2", "-out", `${name}.pem`, "-days", "30", "-extfile", `${name}.ext`);
  };
  ca("ca");
  ca("other");
  leaf("leaf", "IP:127.0.0.1");
  leaf("host", "DNS:localhost");
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "self.key", "-out", "self.pem", "-days", "30",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "extendedKeyUsage=serverAuth");

  const runWorld = (world, i) => {
    const dir = join(root, `w${i}`);
    const home = join(dir, "home");
    const config = join(dir, "config");
    const accounts = join(dir, "accounts");
    for (const d of [home, config, accounts]) mkdirSync(d, { recursive: true });
    for (const [rel, src] of Object.entries(world.files ?? {})) {
      const bytes =
        src.text ?? Buffer.concat([Buffer.from(src.before ?? ""), readFileSync(join(certs, `${src.cert}.pem`)), Buffer.from(src.after ?? "")]);
      writeFileSync(join(home, rel), bytes);
    }
    // `readSettings("user", ...)` reads homedir()/.claude, not the config dir.
    if (world.settings) {
      mkdirSync(join(home, ".claude"));
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(world.settings, null, 2));
    }
    writeFileSync(join(accounts, "accounts.json"), JSON.stringify(OAUTH, null, 2));
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      CLAUDIUS_ACCOUNTS_DIR: accounts,
      VOICE_GOLDEN_OUT: join(dir, "out.json"),
    };
    if (process.env.VOICE_GOLDEN_DEBUG) env.VOICE_GOLDEN_DEBUG = "1";
    for (const [k, v] of Object.entries(world.env ?? {})) env[k] = join(home, v);
    Object.assign(env, world.envRaw ?? {});
    const serve = world.upstream.startsWith("tls:") ? world.upstream.slice(4) : null;
    env.VOICE_GOLDEN_WORLD = JSON.stringify({
      upstream: world.upstream,
      serve: serve && [join(certs, `${serve}.pem`), join(certs, `${serve}.key`)],
      steps: world.steps,
    });
    return new Promise((res, rej) => {
      const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url)], {
        cwd: repo,
        stdio: ["ignore", "inherit", "inherit"],
        env,
      });
      child.on("exit", (code) => {
        if (code !== 0) return rej(new Error(`world ${world.name} exited ${code}`));
        res(JSON.parse(readFileSync(env.VOICE_GOLDEN_OUT, "utf8")));
      });
    });
  };
  const only = process.env.VOICE_GOLDEN_ONLY;
  const results = await Promise.all(WORLDS.map((w, i) => (only && w.name !== only ? [] : runWorld(w, i))));
  if (only) process.exit(0);
  const fixture = {
    accounts: OAUTH,
    worlds: WORLDS.map((w, i) => ({
      name: w.name,
      upstream: w.upstream,
      files: w.files ?? {},
      settings: w.settings ?? null,
      env: w.env ?? {},
      ...(w.envRaw ? { envRaw: w.envRaw } : {}),
      steps: w.steps,
      results: results[i],
    })),
  };
  for (const w of fixture.worlds) {
    const idle = w.steps.findIndex((s) => s.op === "drain" && s.s === "idleSession1");
    if (idle >= 0 && !w.results[idle].pinged) throw new Error("the idle stream never pinged");
    w.steps.forEach((s, i) => {
      if (w.results[i]?.pinged !== undefined && i !== idle) delete w.results[i].pinged;
    });
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`wrote ${out}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
