/**
 * Embedded-server + HTTP/2-proxy smoke test.
 *
 * Boots `startEmbeddedNextServer` exactly as Electron does, puts the
 * `startHttp2Proxy` (electron/proxy.ts) in front of it — the same topology the
 * packaged app runs — and asserts, over a real Node http2 client:
 *   1. ALPN negotiated `h2` (the whole point: multiplexing, no 6-conn limit),
 *   2. `/api/heartbeat` returns 200 `{status:"ok"}` through the proxy,
 *   3. an SSE endpoint streams its first event through the proxy WITHOUT
 *      buffering (proves the pipe path that real-time session/notification
 *      streams depend on).
 *
 * Runs in Node, no display server — CI can call it to catch the class of
 * runtime bugs `tsc --noEmit` misses (wrong appDir, missing standalone
 * server.js, proxy/cert regressions, buffered SSE). It CANNOT exercise
 * Electron's `certificate-error` trust path (no browser) — the packaged e2e
 * suite covers that.
 *
 * Prerequisites (see the `electron:smoke` script):
 *   - `next build` (output:'standalone') → `.next/standalone/server.js`
 *   - `node scripts/electron-gen-cert.mjs` → `build/cert/{cert,key}.pem`
 *   - `electron:compile` → `dist-electron/smoke.js`
 */
import fs from "node:fs";
import http2 from "node:http2";
import path from "node:path";

import { startHttp2Proxy, type EmbeddedProxy } from "./proxy";
import { defaultAppDir, startEmbeddedNextServer, type EmbeddedNextServer } from "./server";

const TIMEOUT_MS = 30_000;
const SSE_FIRST_EVENT_TIMEOUT_MS = 10_000;

/** One-shot HTTP/2 GET over the proxy. Resolves status + body + negotiated ALPN. */
function h2Get(
  client: http2.ClientHttp2Session,
  reqPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = client.request({ ":path": reqPath, ":method": "GET" });
    let status = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
    });
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolve({ status, body }));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Open an SSE stream over the proxy and resolve once the FIRST byte of body
 * arrives — proving the response isn't buffered end-to-end. Rejects on timeout.
 */
function h2SseFirstEvent(
  client: http2.ClientHttp2Session,
  reqPath: string,
): Promise<{ status: number; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = client.request({ ":path": reqPath, ":method": "GET" });
    let status = 0;
    let contentType = "";
    const timer = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      reject(new Error(`no SSE event within ${SSE_FIRST_EVENT_TIMEOUT_MS}ms`));
    }, SSE_FIRST_EVENT_TIMEOUT_MS);
    req.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
      contentType = String(headers["content-type"] ?? "");
    });
    req.once("data", () => {
      clearTimeout(timer);
      req.close(http2.constants.NGHTTP2_CANCEL);
      resolve({ status, contentType });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

async function main(): Promise<void> {
  const appDir = process.env.CLAUDIUS_SMOKE_APP_DIR ?? defaultAppDir();
  const serverJs = path.join(appDir, "server.js");
  const nextDir = path.join(appDir, ".next");
  console.log(`[smoke] appDir=${appDir}`);
  if (!fs.existsSync(serverJs)) {
    throw new Error(`server.js not found at ${serverJs} — run \`bun run build\` first`);
  }
  if (!fs.existsSync(nextDir)) {
    throw new Error(`.next not found at ${nextDir} — standalone tree is incomplete`);
  }

  // Load the build-time cert (dev/smoke: <project>/build/cert; this file
  // compiles to dist-electron/smoke.js, so build/ is one level up).
  const certDir = path.resolve(__dirname, "..", "build", "cert");
  const key = fs.readFileSync(path.join(certDir, "key.pem"));
  const cert = fs.readFileSync(path.join(certDir, "cert.pem"));

  const startedAt = Date.now();
  let server: EmbeddedNextServer | null = null;
  let proxy: EmbeddedProxy | null = null;
  let client: http2.ClientHttp2Session | null = null;

  try {
    server = await startEmbeddedNextServer(appDir);
    console.log(`[smoke] internal Next up at ${server.url} (${Date.now() - startedAt}ms)`);

    proxy = await startHttp2Proxy({ internalOrigin: server.url, key, cert });
    console.log(`[smoke] h2 proxy up at ${proxy.url}`);

    // rejectUnauthorized:false — smoke trusts the self-signed cert by config;
    // Electron's real cert-trust path is validated by the packaged e2e suite.
    client = http2.connect(proxy.url, { rejectUnauthorized: false });
    const connectDeadline = setTimeout(() => client?.destroy(new Error("h2 connect timeout")), TIMEOUT_MS);
    await new Promise<void>((resolve, reject) => {
      client!.once("connect", () => resolve());
      client!.once("error", reject);
    });
    clearTimeout(connectDeadline);

    if (client.alpnProtocol !== "h2") {
      throw new Error(`expected ALPN "h2", got "${client.alpnProtocol}"`);
    }
    console.log(`[smoke] ALPN negotiated: ${client.alpnProtocol}`);

    const hb = await h2Get(client, "/api/heartbeat");
    if (hb.status !== 200) throw new Error(`heartbeat returned ${hb.status}`);
    const body = JSON.parse(hb.body) as { status?: string };
    if (body.status !== "ok") throw new Error(`heartbeat body unexpected: ${hb.body}`);
    console.log("[smoke] heartbeat 200 {status:ok} over h2");

    const sse = await h2SseFirstEvent(client, "/api/notifications/stream");
    if (sse.status !== 200) throw new Error(`SSE stream returned ${sse.status}`);
    if (!sse.contentType.includes("text/event-stream")) {
      throw new Error(`SSE content-type unexpected: "${sse.contentType}"`);
    }
    console.log("[smoke] SSE first event streamed through proxy (not buffered)");

    console.log(`[smoke] OK — h2 proxy verified in ${Date.now() - startedAt}ms total`);
  } finally {
    try {
      client?.close();
    } catch {
      // ignore
    }
    try {
      if (proxy) await proxy.close();
    } catch (err) {
      console.error("[smoke] failed to close proxy:", err);
    }
    try {
      if (server) await server.close();
      console.log("[smoke] servers closed");
    } catch (err) {
      console.error("[smoke] failed to close server:", err);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[smoke] FAILED:", err);
    process.exit(1);
  });
