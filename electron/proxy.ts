/**
 * HTTP/2 TLS reverse proxy that fronts the embedded Next standalone server.
 *
 * WHY THIS EXISTS
 * Chromium enforces a hard limit of 6 concurrent TCP connections per origin on
 * HTTP/1.1. The app keeps several long-lived localhost connections (the session
 * SSE stream, the notifications SSE stream) plus bursts of RSC prefetches and
 * slow API calls (/context, /git/status). Once ~6 are in flight the pool
 * saturates and every new navigation sits in the browser's "Queueing" state for
 * 10-17s — the exact symptom users reported. HTTP/2 multiplexes ALL requests
 * and streams over a SINGLE connection, so the per-origin limit no longer
 * applies.
 *
 * WHY A PROXY (not a custom Next server)
 * Next 16 forbids a custom server together with `output: 'standalone'`
 * (node_modules/next/dist/docs/01-app/02-guides/custom-server.md), and the
 * packaged build depends on standalone. So we leave the standalone server
 * untouched on an internal HTTP/1.1 loopback port and put this h2 server in
 * front of it. Browser <-h2/TLS-> proxy <-http/1.1 keep-alive-> Next.
 *
 * WHY IN THE MAIN PROCESS
 * This is async stream I/O (microseconds per chunk), not the multi-second
 * synchronous CPU that electron/server.ts spawns Next in a child to avoid. It
 * cannot starve the splash. Keeping it in-process also lets main read the cert
 * fingerprint directly for its `certificate-error` trust handler (no IPC).
 *
 * SEE electron/main.ts for cert loading + the tightly-scoped trust handler, and
 * the plan file for the full rationale.
 */
import http from "node:http";
import http2 from "node:http2";
import { createServer } from "node:net";

export type EmbeddedProxy = {
  /** https://127.0.0.1:<port> — the origin Electron's BrowserWindow loads. */
  url: string;
  /** The public port the h2 server actually bound. */
  port: number;
  close: () => Promise<void>;
};

// Node's default SETTINGS_MAX_CONCURRENT_STREAMS is 100; exceeding it doesn't
// error, it QUEUES streams — silently reintroducing the very latency we're
// removing. 256 is ~40x the old 6-slot ceiling: ample headroom for SSE-heavy
// multi-tab sessions.
const MAX_CONCURRENT_STREAMS = 256;

// Hop-by-hop headers (RFC 7230 §6.1) must not be forwarded. Critically, HTTP/2
// FORBIDS connection-specific headers — Node's http2 compat layer throws if we
// copy `connection`/`transfer-encoding`/`keep-alive`/`upgrade` onto an h2
// response — so stripping these on the RESPONSE path is a correctness
// requirement, not just hygiene. h2 does its own framing, so dropping
// `transfer-encoding: chunked` is safe (and required).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Copy headers, dropping HTTP/2 pseudo-headers (`:method` …) and hop-by-hop. */
function sanitizeHeaders(
  headers: http.IncomingHttpHeaders | http2.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (k.startsWith(":")) continue; // h2 pseudo-headers — never forward
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Ask the kernel for a free loopback port (same pattern as
 * electron/server.ts's pickEphemeralPort). Used as the fallback when the
 * caller's preferred public port is already bound.
 */
function pickEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        srv.close();
        reject(new Error("could not assign ephemeral port"));
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * Start the h2 proxy in front of `internalOrigin` (the standalone Next server's
 * http://127.0.0.1:<port>). Binds `publicPort` if given and free, else a random
 * loopback port. `key`/`cert` are the self-signed loopback cert
 * (scripts/electron-gen-cert.mjs); main trusts it by fingerprint.
 */
export async function startHttp2Proxy(opts: {
  internalOrigin: string;
  publicPort?: number;
  key: Buffer;
  cert: Buffer;
}): Promise<EmbeddedProxy> {
  const internal = new URL(opts.internalOrigin);
  const internalHost = internal.hostname;
  const internalPort = Number(internal.port);
  const internalAuthority = `${internalHost}:${internalPort}`;

  // One keep-alive agent for the proxy→Next hop. maxSockets: Infinity means the
  // internal HTTP/1.1 leg is NOT the bottleneck — Node isn't subject to the
  // browser's 6-connection rule, so multiplexed h2 streams fan out into as many
  // upstream sockets as needed.
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: Infinity,
    maxFreeSockets: 256,
  });

  const server = http2.createSecureServer({
    key: opts.key,
    cert: opts.cert,
    allowHTTP1: true, // tolerate an HTTP/1.1 client, though Electron negotiates h2
    settings: { maxConcurrentStreams: MAX_CONCURRENT_STREAMS },
  });

  // Track live h2 sessions so close() can force them shut. server.close() alone
  // waits for open streams to end, and our long-lived SSE streams never do — so
  // without this, app quit would hang on an idle session.
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (s) => {
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });

  server.on("request", (req, res) => {
    // Forward to the internal Next server over HTTP/1.1. Rewrite Host to the
    // internal authority so Next sees a consistent host; strip pseudo/hop-by-hop.
    const headers = sanitizeHeaders(req.headers);
    headers.host = internalAuthority;

    const upstream = http.request(
      {
        protocol: "http:",
        host: internalHost,
        port: internalPort,
        method: req.method,
        path: req.url,
        headers,
        agent,
      },
      (upRes) => {
        // Copy status + headers verbatim (minus hop-by-hop, which h2 forbids),
        // then stream the body straight through. Piping flushes each chunk as
        // it arrives — essential for real-time SSE (`data: …\n\n`) + heartbeats.
        try {
          res.writeHead(upRes.statusCode ?? 502, sanitizeHeaders(upRes.headers));
        } catch {
          // Client already tore the stream down between upstream connect and
          // our writeHead — nothing to send.
          upstream.destroy();
          return;
        }
        upRes.pipe(res);
        upRes.on("error", () => res.destroy());
      },
    );

    // ABORT PROPAGATION (the correctness lynchpin): when the browser closes the
    // h2 stream (tab close, navigation), destroy the upstream request so Next's
    // `req.signal` fires and the SSE route runs its cleanup (clears the
    // heartbeat interval, unsubscribes from the session). Without this, every
    // tab close leaks an upstream subscription + interval.
    const abortUpstream = () => {
      if (!upstream.destroyed) upstream.destroy();
    };
    res.on("close", abortUpstream);
    req.on("close", abortUpstream);
    upstream.on("error", () => {
      if (!res.destroyed) res.destroy();
    });

    // Stream the request body (POST/PUT). GET/SSE bodies are empty — piping an
    // empty Readable is a harmless no-op.
    req.pipe(upstream);
  });

  // Swallow stream/socket-level errors so a single flaky connection can't crash
  // the main process. Per-request errors are handled above.
  server.on("sessionError", () => {});
  server.on("clientError", () => {});
  server.on("error", (err) => {
    console.error("[electron/proxy] h2 server error:", err);
  });

  // Bind the preferred public port; on collision fall back to an ephemeral one.
  let port = opts.publicPort;
  const listenOn = async (p: number | undefined): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(p ?? 0, "127.0.0.1", () => {
        server.off("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : (p ?? 0));
      });
    });

  try {
    port = await listenOn(port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && opts.publicPort != null) {
      console.warn(
        `[electron/proxy] public port ${opts.publicPort} unavailable, falling back to random`,
      );
      port = await listenOn(await pickEphemeralPort());
    } else {
      throw err;
    }
  }

  return {
    url: `https://127.0.0.1:${port}`,
    port: port as number,
    close: () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        agent.destroy();
        // Force live sessions shut — server.close() otherwise waits for the
        // long-lived SSE streams, which never end on their own.
        for (const s of sessions) s.destroy();
        sessions.clear();
        server.close(done);
        // Belt-and-suspenders: never let app quit hang on the proxy.
        setTimeout(done, 2_000).unref();
      }),
  };
}
