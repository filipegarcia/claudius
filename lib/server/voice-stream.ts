/**
 * Voice-stream proxy — server side of the Claude Code-style dictation
 * flow.
 *
 * The renderer never holds a Claude.ai OAuth token (the
 * `account-profile.ts` comment is explicit: "the browser must never see
 * the raw access token"). Instead, the renderer:
 *
 *   1) creates a client-side session id (a uuid),
 *   2) opens an SSE stream to /api/voice/stream?id=<sid>,
 *   3) POSTs raw 16 kHz mono linear16 PCM bytes to /api/voice/chunk?id=<sid>,
 *   4) POSTs to /api/voice/close?id=<sid> when done.
 *
 * On the SSE-open side we resolve the active profile's OAuth token,
 * connect upstream to the same private endpoint Claude Code uses
 * (`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`), and
 * relay every transcript JSON event back to the renderer as SSE.
 *
 * Wire format (confirmed by probing the live endpoint with the stored
 * token — see scripts/voice-probe/probe.ts):
 *   client → server (binary): linear16 PCM frames, 16 kHz mono
 *   client → server (text):   {"type":"KeepAlive"}, {"type":"CloseStream"}
 *   server → client (text):   {"type":"TranscriptInterim","data":"…"}
 *                              {"type":"TranscriptText","data":"…"}
 *                              {"type":"TranscriptEndpoint"}
 *                              {"type":"TranscriptError", …}
 *
 * Session state is in-memory because the Claudius server is a
 * long-lived local Node process — no need for a shared store. Sessions
 * self-evict after `SESSION_IDLE_TIMEOUT_MS` of no activity, so a
 * renderer crash mid-recording doesn't leak the upstream WS.
 */
import WebSocket from "ws";

import { readAccountsRaw } from "./accounts-store";

/**
 * Bun's `ws` shim mis-translates the upstream's WS upgrade response
 * inside Next.js route handlers (manifests as "Unexpected server
 * response: 101" even when the handshake is correct — same upgrade
 * works fine using Bun's native WebSocket). Detect the Bun runtime
 * and use the global `WebSocket` constructor, which on Bun honours
 * the non-standard `{ headers }` option. Node 22+ (Electron Helper)
 * keeps the `ws` package — its global WebSocket follows WHATWG and
 * has no headers option, so we cannot use it for OAuth-bearer
 * connections there.
 */
const isBun =
  typeof (globalThis as unknown as { Bun?: unknown }).Bun !== "undefined";

interface UpstreamConn {
  send: (data: string | Uint8Array, opts?: { binary?: boolean }) => void;
  close: (code?: number, reason?: string) => void;
  readyState: number;
  onOpen: (cb: () => void) => void;
  onText: (cb: (data: string) => void) => void;
  onError: (cb: (err: Error) => void) => void;
  onClose: (cb: (code: number, reason: string) => void) => void;
}

function openUpstream(url: string, headers: Record<string, string>): UpstreamConn {
  if (isBun) {
    // Bun's `new WebSocket(url, { headers })` is a documented extension
    // — same shape used by our voice-probe script that confirmed the
    // protocol against the live endpoint.
    const ws = new (globalThis as unknown as {
      WebSocket: new (
        url: string,
        opts: { headers?: Record<string, string> },
      ) => {
        addEventListener: (
          ev: string,
          cb: (e: { data?: unknown; code?: number; reason?: string; message?: string }) => void,
        ) => void;
        send: (data: string | ArrayBuffer | ArrayBufferView) => void;
        close: (code?: number, reason?: string) => void;
        readyState: number;
        binaryType: string;
      };
    }).WebSocket(url, { headers });
    ws.binaryType = "arraybuffer";
    return {
      send(data, opts) {
        if (typeof data === "string") {
          ws.send(data);
        } else if (opts?.binary !== false) {
          // Bun's WebSocket accepts ArrayBuffer / ArrayBufferView. We
          // hand it an ArrayBufferView so the underlying SharedArrayBuffer
          // (which `ws.send` doesn't accept by type) is sliced into a
          // plain ArrayBuffer copy. The .slice() returns ArrayBuffer in
          // practice when called on Uint8Array — coerce so the type
          // checker agrees.
          const view = new Uint8Array(data);
          ws.send(view);
        } else {
          ws.send(data);
        }
      },
      close(code, reason) {
        ws.close(code, reason);
      },
      get readyState() { return ws.readyState; },
      onOpen(cb) { ws.addEventListener("open", () => cb()); },
      onText(cb) {
        ws.addEventListener("message", (e) => {
          if (typeof e.data === "string") cb(e.data);
        });
      },
      onError(cb) {
        ws.addEventListener("error", (e) => {
          cb(new Error(e.message ?? "websocket error"));
        });
      },
      onClose(cb) {
        ws.addEventListener("close", (e) => {
          cb(e.code ?? 1006, e.reason ?? "");
        });
      },
    };
  }

  // Node path — `ws` package handles the WS handshake correctly here.
  const ws = new WebSocket(url, {
    headers,
    // permessage-deflate isn't useful for already-compressed audio
    // upstream OR for short JSON transcripts downstream. Matches the
    // CLI's connection options.
    perMessageDeflate: false,
  });
  // Defensive: the CLI binary logs "unexpected-response fired with 101;
  // ignoring", meaning under some conditions `ws` emits this event
  // even on a valid 101 upgrade. The default `ws` behaviour then is to
  // abort the request and emit `error`. Mirror the CLI's swallow: if
  // we see a 101 here, drain the response stream and DON'T treat it
  // as fatal. Other status codes still propagate to the error handler
  // via ws's own emit path.
  ws.on("unexpected-response", (_req, res) => {
    if (res.statusCode === 101) {
      res.resume();
      return;
    }
    // Non-101 unexpected response — let ws's natural error emission
    // surface it. We intentionally do nothing here so the existing
    // onError-bound handler hears about it via `ws.on("error", …)`.
    res.resume();
  });
  return {
    send(data, opts) {
      if (typeof data === "string") ws.send(data);
      else ws.send(data, { binary: opts?.binary !== false });
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    get readyState() { return ws.readyState; },
    onOpen(cb) { ws.on("open", cb); },
    onText(cb) {
      ws.on("message", (data, isBinary) => {
        if (!isBinary) cb(data.toString());
      });
    },
    onError(cb) { ws.on("error", cb); },
    onClose(cb) {
      ws.on("close", (code, reason) => cb(code, reason.toString()));
    },
  };
}

// Production endpoint. `VOICE_STREAM_BASE_URL` mirrors the override the
// Claude Code CLI honours, useful for testing against a local proxy.
const VOICE_BASE_URL =
  process.env.VOICE_STREAM_BASE_URL || "wss://api.anthropic.com";
const VOICE_PATH = "/api/ws/speech_to_text/voice_stream";

// Drop a session that hasn't seen client activity (chunk POST or
// SSE poll-tick) for this long. 30 s is generous — the upstream
// `utterance_end_ms` is 1 s, so any real session is producing events
// faster than this. Tuned to forgive a slow network on the renderer
// side while still catching genuine leaks.
const SESSION_IDLE_TIMEOUT_MS = 30_000;

// How often to send {"type":"KeepAlive"} upstream while we're not
// actively forwarding audio. The CLI uses 1.5 s on the no-data path;
// 1 s here keeps the connection alive comfortably without spamming.
const UPSTREAM_KEEPALIVE_MS = 1_000;

/**
 * SSE writer surface. The route handler wires this up to a
 * ReadableStreamDefaultController so we can keep the route handler
 * thin and the proxy logic testable in isolation.
 */
export interface SseSink {
  send(event: string, data: string): void;
  close(): void;
}

interface VoiceSession {
  id: string;
  upstream: UpstreamConn;
  sink: SseSink;
  /** Wall-clock of the most recent client activity. */
  lastActivityAt: number;
  /** Cleared by close(); used by the idle reaper. */
  idleTimer: ReturnType<typeof setInterval>;
  keepaliveTimer: ReturnType<typeof setInterval>;
  closed: boolean;
}

// Sessions live on `globalThis` so every Route Handler that imports
// this module sees the SAME Map, even when Next.js's dev mode compiles
// each route into its own server bundle (which gives each its own copy
// of the module-level `const sessions = new Map(...)`). Without this
// the session opened from /api/voice/stream is invisible to
// /api/voice/chunk and every chunk POST lands as 410 Gone. Tying the
// lookup to the process realm fixes it without any custom-server
// rewiring. In production the export-once standalone bundle ALSO
// benefits — HMR doesn't apply there, but if a future packaging
// change splits routes the invariant stays correct.
declare global {
  var __claudiusVoiceSessions: Map<string, VoiceSession> | undefined;
}
const sessions: Map<string, VoiceSession> =
  globalThis.__claudiusVoiceSessions ??
  (globalThis.__claudiusVoiceSessions = new Map<string, VoiceSession>());

/**
 * Resolve the active OAuth token. Returns null if no account is
 * signed in or the active profile isn't OAuth-backed.
 */
async function resolveActiveOauthToken(): Promise<string | null> {
  const cur = await readAccountsRaw();
  const profile =
    cur.profiles.find((p) => p.id === cur.activeProfileId) ?? null;
  if (!profile) return null;
  if (profile.kind !== "oauth-token") return null;
  return profile.secret;
}

function buildUpstreamUrl(language: string): string {
  const params = new URLSearchParams({
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    endpointing_ms: "300",
    utterance_end_ms: "1000",
    language,
    use_conversation_engine: "true",
    forward_interims: "typed",
    stt_provider: "deepgram-nova3",
  });
  return `${VOICE_BASE_URL}${VOICE_PATH}?${params}`;
}

/**
 * Open a new session: resolve the OAuth token, open the upstream WS,
 * wire its messages to the SSE sink. Throws if no usable account is
 * available — the caller (route handler) translates to an HTTP error.
 */
export async function openVoiceSession(
  id: string,
  sink: SseSink,
  opts: { language?: string; keyterms?: readonly string[] } = {},
): Promise<VoiceSession> {
  if (sessions.has(id)) {
    throw new Error(`voice session ${id} already exists`);
  }

  const token = await resolveActiveOauthToken();
  if (!token) {
    sink.send("error", JSON.stringify({ kind: "no-auth" }));
    sink.close();
    throw new Error("no Claude.ai OAuth account is currently active");
  }

  const url = buildUpstreamUrl(opts.language ?? "en");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  // The CLI accepts a comma-separated list of code vocabulary
  // hints. Empty list → skip the header entirely so the server
  // can't mis-parse a blank value.
  if (opts.keyterms && opts.keyterms.length > 0) {
    headers["x-config-keyterms"] = opts.keyterms.join(",");
  }

  console.log(`[voice:${id}] openVoiceSession url=${url.split("?")[0]} ...?<params>`);
  const upstream = openUpstream(url, headers);

  const session: VoiceSession = {
    id,
    upstream,
    sink,
    lastActivityAt: Date.now(),
    idleTimer: setInterval(() => {
      if (Date.now() - session.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
        closeSession(id, "idle-timeout");
      }
    }, 5_000),
    keepaliveTimer: setInterval(() => {
      // readyState 1 = OPEN — same value in both `ws` and WHATWG WS.
      if (upstream.readyState === 1) {
        try {
          upstream.send(JSON.stringify({ type: "KeepAlive" }));
        } catch {
          // Will be caught by the upstream error handler — no need
          // to surface a separate error here.
        }
      }
    }, UPSTREAM_KEEPALIVE_MS),
    closed: false,
  };
  sessions.set(id, session);

  upstream.onOpen(() => {
    console.log(`[voice:${id}] upstream open`);
    // Mirror the CLI's "initial KeepAlive on connect" behaviour —
    // it primes the server's heartbeat-tracking state.
    try {
      upstream.send(JSON.stringify({ type: "KeepAlive" }));
    } catch {
      /* ignore */
    }
    // NOTE: the event name is `ready`, not `open` — EventSource
    // dispatches both its native "connection opened" event AND any
    // server-sent `event: open\n` frames to listeners registered
    // with `addEventListener("open", …)`. Using a distinct name
    // means the renderer can wait for "upstream WS ready" without
    // racing against the local TCP handshake.
    sink.send("ready", JSON.stringify({ id }));
  });

  upstream.onText((text) => {
    // Pass straight through to the renderer. Parsing here would mean
    // re-serializing for SSE; that's pointless overhead for a relay.
    sink.send("message", text);
  });

  upstream.onError((err) => {
    console.warn(`[voice:${id}] upstream error: ${err.message}`);
    sink.send(
      "error",
      JSON.stringify({ kind: "upstream", message: err.message }),
    );
    closeSession(id, "upstream-error");
  });

  upstream.onClose((code, reason) => {
    console.log(`[voice:${id}] upstream close code=${code} reason=${reason || "(none)"}`);
    sink.send("close", JSON.stringify({ code, reason }));
    closeSession(id, `upstream-close-${code}`);
  });

  return session;
}

/**
 * Forward an audio chunk to the upstream WS. No-ops if the session
 * has been closed (the renderer can race a chunk against a
 * CloseStream / network drop).
 */
export function pushAudioChunk(id: string, bytes: Uint8Array): boolean {
  const session = sessions.get(id);
  if (!session) {
    console.warn(`[voice:${id}] pushAudioChunk: session not in map (size=${sessions.size}, known=[${[...sessions.keys()].join(",")}])`);
    return false;
  }
  if (session.closed) {
    console.warn(`[voice:${id}] pushAudioChunk: session marked closed`);
    return false;
  }
  if (session.upstream.readyState !== 1) {
    console.warn(`[voice:${id}] pushAudioChunk: upstream readyState=${session.upstream.readyState}`);
    return false;
  }
  session.upstream.send(bytes, { binary: true });
  session.lastActivityAt = Date.now();
  return true;
}

/**
 * Tell the upstream we're done speaking. The server will reply with
 * a final `TranscriptText` and a `TranscriptEndpoint`, then close
 * the socket with code 1000.
 */
export function finalizeVoiceSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session || session.closed) return false;
  if (session.upstream.readyState === 1) {
    try {
      session.upstream.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      /* upstream is going down anyway */
    }
  }
  session.lastActivityAt = Date.now();
  return true;
}

/**
 * Tear down a session unconditionally. Safe to call multiple times.
 * `reason` shows up in logs to help diagnose unexpected drops.
 */
export function closeSession(id: string, reason: string): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.closed) return;
  console.log(`[voice:${id}] closeSession reason=${reason}`);
  session.closed = true;
  clearInterval(session.idleTimer);
  clearInterval(session.keepaliveTimer);
  try {
    // 0 = CONNECTING, 1 = OPEN — both are still cleanly closable.
    if (session.upstream.readyState === 0 || session.upstream.readyState === 1) {
      session.upstream.close(1000, reason);
    }
  } catch {
    /* ignore */
  }
  try {
    session.sink.close();
  } catch {
    /* ignore */
  }
  sessions.delete(id);
}

/** For tests + the `/voice/close` route. */
export function hasVoiceSession(id: string): boolean {
  return sessions.has(id);
}
