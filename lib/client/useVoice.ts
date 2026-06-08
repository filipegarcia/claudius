"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice dictation client.
 *
 * Captures the user's microphone, downsamples to 16 kHz mono Int16
 * via an AudioWorklet, and streams the PCM up to /api/voice/chunk.
 * Server-sent events on /api/voice/stream carry transcript events
 * back. This mirrors the Claude Code CLI's voice dictation feature —
 * see lib/server/voice-stream.ts for the full proxy design and the
 * upstream wire format.
 *
 * The OAuth token never reaches this code. The proxy in
 * lib/server/voice-stream.ts resolves it from the active account
 * profile and uses it to authenticate the upstream WebSocket.
 *
 * `onTranscript(text, isFinal)` is called with the *whole* current
 * transcript on every server event (interim chunks include the full
 * running text, not just the latest delta). The composer is in
 * charge of stitching that into the textarea — see
 * `components/chat/PromptInput.tsx`. `text` is `""` only for the
 * `TranscriptEndpoint` event, which is a finalize signal carrying
 * no new content.
 */

/**
 * Public surface returned by `useVoice`. Stable identity across
 * renders (`start`/`stop` come from `useCallback`), so it's safe to
 * place this object in dependency arrays.
 */
export interface UseVoiceResult {
  /** True when the browser can run dictation (HTTPS + getUserMedia + AudioWorklet). */
  supported: boolean;
  /** True from the moment `start()` is called until upstream confirms close. */
  listening: boolean;
  /** Latest error message, or null. Cleared by the next successful `start()`. */
  error: string | null;
  start: () => void;
  stop: () => void;
}

// Feature-detect on every render — `navigator` is undefined during SSR
// and HMR can fake it in tests. Cheap enough to recompute.
//
// This used to also gate on `!window.claudius` (Electron) because the
// previous Web Speech API path silently hangs in stock Chromium-in-
// Electron. The new path doesn't use Web Speech at all — we stream
// PCM ourselves to the Anthropic voice_stream proxy in
// lib/server/voice-stream.ts — so Electron's Chromium is fine here as
// long as the renderer gets `getUserMedia` permission (see
// electron/main.ts's setPermissionRequestHandler).
function detectSupport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof navigator === "undefined") return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  // AudioContext is the only path here — AudioWorklet rides on it.
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) return false;
  return true;
}

// 32 ms of 16 kHz Int16 = 1024 bytes per worklet message ×
// (we batch worklet messages to ~50ms = 1600 bytes each in the worklet).
// We upload-batch a little further to keep POST overhead down: every
// ~200 ms of audio becomes one POST. Latency is dominated by the
// upstream `utterance_end_ms=1000` anyway, so 200 ms is in the noise.
const UPLOAD_BATCH_BYTES = 6_400; // 200 ms at 16 kHz/Int16

interface UpstreamMessage {
  type:
    | "TranscriptInterim"
    | "TranscriptText"
    | "TranscriptEndpoint"
    | "TranscriptError"
    | string;
  data?: string;
  message?: string;
}

export function useVoice(
  onTranscript: (text: string, isFinal: boolean) => void,
): UseVoiceResult {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lazy initializer runs once per component instance. On the server
  // it returns `false` (no `window`); on the client's first render it
  // returns the real feature-detect. This means a single render pass —
  // no setState-in-effect cascading render — at the cost of a brief
  // hydration mismatch on the mic button, which is the same trade-off
  // the previous Web Speech API path made and which React tolerates.
  const [supported] = useState<boolean>(detectSupport);

  // Latest callback ref — lets `start()` enqueue interim text without
  // re-binding the AudioContext / SSE every time the composer
  // re-renders with a new closure.
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  });

  // Mutable session state lives in refs so we can tear it down from
  // the `stop()` path or the SSE `close` handler without re-rendering.
  const stateRef = useRef<{
    sessionId: string | null;
    audioContext: AudioContext | null;
    workletNode: AudioWorkletNode | null;
    mediaStream: MediaStream | null;
    eventSource: EventSource | null;
    uploadBuffer: Uint8Array;
    uploadFill: number;
    /** Set true once we've seen the upstream `open` event. */
    upstreamReady: boolean;
    /** Queue of chunks captured before the upstream confirmed open. */
    pendingChunks: Uint8Array[];
  }>({
    sessionId: null,
    audioContext: null,
    workletNode: null,
    mediaStream: null,
    eventSource: null,
    uploadBuffer: new Uint8Array(UPLOAD_BATCH_BYTES),
    uploadFill: 0,
    upstreamReady: false,
    pendingChunks: [],
  });

  // Tear down all resources. Idempotent — safe to call multiple times,
  // safe to call when nothing is open. Centralizing this means every
  // error path can just call `cleanup()` and be done.
  const cleanup = useCallback(() => {
    const s = stateRef.current;
    if (s.workletNode) {
      try { s.workletNode.port.close(); } catch { /* ignore */ }
      try { s.workletNode.disconnect(); } catch { /* ignore */ }
    }
    if (s.audioContext) {
      // Closing the context releases the OS audio handle — important
      // because Chromium keeps the red mic indicator lit otherwise.
      void s.audioContext.close().catch(() => {});
    }
    if (s.mediaStream) {
      for (const track of s.mediaStream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
    if (s.eventSource) {
      try { s.eventSource.close(); } catch { /* ignore */ }
    }
    s.sessionId = null;
    s.audioContext = null;
    s.workletNode = null;
    s.mediaStream = null;
    s.eventSource = null;
    s.uploadFill = 0;
    s.upstreamReady = false;
    s.pendingChunks = [];
    setListening(false);
  }, []);

  const flushUpload = useCallback(async (sessionId: string, bytes: Uint8Array) => {
    if (bytes.byteLength === 0) return;
    try {
      const res = await fetch(`/api/voice/chunk?id=${sessionId}`, {
        method: "POST",
        body: new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
        headers: {
          "Content-Type": "application/octet-stream",
        },
      });
      if (res.status === 410) {
        // Upstream is gone (timeout / network drop). The SSE handler
        // will also notice; tearing down here saves one round-trip.
        cleanup();
      }
    } catch {
      // Network failure on a single chunk is recoverable — the next
      // one may succeed. Don't tear down here.
    }
  }, [cleanup]);

  const start = useCallback(() => {
    if (stateRef.current.sessionId) return; // already running
    setError(null);

    // Generate a session id the renderer owns. The server uses it as
    // a one-shot capability that pairs the SSE with the chunk POSTs —
    // so it MUST come from a CSPRNG. Use crypto.randomUUID directly to
    // match the rest of the codebase (use-session.ts, PromptInput.tsx)
    // and avoid the Math.random fallback CodeQL flagged as
    // js/insecure-randomness (#42). Any browser that supports the
    // EventSource + MediaRecorder used below also supports randomUUID.
    const sessionId = crypto.randomUUID().replace(/-/g, "");
    stateRef.current.sessionId = sessionId;
    setListening(true);

    // Kick off the SSE BEFORE the mic prompt. If permission is denied
    // we close immediately and the user sees a clear error; if it's
    // granted, the upstream has already had time to negotiate
    // headers and the first audio frame ships with no extra wait.
    const lang =
      typeof navigator !== "undefined" && navigator.language
        ? navigator.language.split("-")[0]
        : "en";
    const es = new EventSource(`/api/voice/stream?id=${sessionId}&lang=${lang}`);
    stateRef.current.eventSource = es;

    // IMPORTANT: listen for the server's custom `event: ready` SSE
    // frame, NOT EventSource's native `open` event. The native one
    // fires the instant the HTTP 200 lands, well before our
    // upstream WebSocket to api.anthropic.com has finished its
    // handshake — using it would let chunks fly upstream-not-ready
    // and the route handler returns 410. The renamed event is sent
    // by `voice-stream.ts` *after* the upstream's `onOpen` fires.
    es.addEventListener("ready", () => {
      stateRef.current.upstreamReady = true;
      // Drain anything captured during the upstream handshake.
      for (const chunk of stateRef.current.pendingChunks) {
        void flushUpload(sessionId, chunk);
      }
      stateRef.current.pendingChunks = [];
    });

    es.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data) as UpstreamMessage;
        switch (msg.type) {
          case "TranscriptInterim":
            if (msg.data) onTranscriptRef.current(msg.data, false);
            break;
          case "TranscriptText":
            if (msg.data) onTranscriptRef.current(msg.data, true);
            break;
          case "TranscriptEndpoint":
            // Final boundary for the current utterance — no new text,
            // but signals "stop and ship". The composer treats final
            // text as authoritative, so we don't need to emit again.
            break;
          case "TranscriptError":
            setError(msg.message ?? "voice transcription error");
            break;
          default:
            // Unknown event types — log without breaking flow.
            console.warn("[voice] unknown upstream event", msg);
        }
      } catch {
        // Non-JSON payload — log and ignore so a single bad frame
        // doesn't kill the whole session.
      }
    });

    es.addEventListener("error", (ev) => {
      // EventSource fires `error` for non-200 responses AND for
      // benign network blips. We surface the message we have and
      // tear down; the next start() resets.
      const data = (ev as MessageEvent).data;
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data) as { kind?: string; message?: string };
          setError(parsed.message ?? parsed.kind ?? "voice error");
        } catch {
          setError("voice error");
        }
      }
      // Some browsers (and our SSE handler) fire `error` on normal
      // close; only flip to a hard error state when we never opened.
      if (!stateRef.current.upstreamReady) {
        setError((prev) => prev ?? "voice connection failed");
      }
    });

    es.addEventListener("close", () => {
      // Upstream has finalized. Audio capture is no longer useful —
      // shut everything down. We don't fire onTranscript here; the
      // final transcript was already delivered as TranscriptText.
      cleanup();
    });

    // Wire mic → worklet asynchronously. Errors here translate to a
    // graceful close — the SSE has already been opened, so we POST a
    // close to the server to release the upstream WS.
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // Browser-side cleanup matters for STT quality. These are
            // standard hints — the OS / driver decides whether to honour.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        stateRef.current.mediaStream = stream;

        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctx!();
        stateRef.current.audioContext = ctx;

        await ctx.audioWorklet.addModule("/voice-recorder-worklet.js");
        const source = ctx.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(ctx, "voice-recorder");
        stateRef.current.workletNode = worklet;

        worklet.port.onmessage = (ev) => {
          if (!stateRef.current.sessionId) return;
          const chunk = new Uint8Array(ev.data as ArrayBuffer);
          if (!stateRef.current.upstreamReady) {
            stateRef.current.pendingChunks.push(chunk);
            return;
          }
          // Batch worklet chunks (~50 ms each) into ~200 ms uploads.
          const s = stateRef.current;
          let offset = 0;
          while (offset < chunk.byteLength) {
            const free = UPLOAD_BATCH_BYTES - s.uploadFill;
            const take = Math.min(free, chunk.byteLength - offset);
            s.uploadBuffer.set(
              chunk.subarray(offset, offset + take),
              s.uploadFill,
            );
            s.uploadFill += take;
            offset += take;
            if (s.uploadFill >= UPLOAD_BATCH_BYTES) {
              const out = new Uint8Array(s.uploadFill);
              out.set(s.uploadBuffer.subarray(0, s.uploadFill));
              s.uploadFill = 0;
              void flushUpload(s.sessionId!, out);
            }
          }
        };

        source.connect(worklet);
        // The worklet has no audio output (transcription only), so
        // we don't connect it to ctx.destination. This also avoids
        // a brief feedback loop on some setups.
      } catch (err) {
        const message =
          err instanceof Error && err.name === "NotAllowedError"
            ? "Microphone permission denied — enable it for Claudius in System Settings."
            : err instanceof Error
              ? err.message
              : String(err);
        setError(message);
        // Tell the server to release the upstream WS we just opened.
        const sid = stateRef.current.sessionId;
        if (sid) {
          void fetch(`/api/voice/close?id=${sid}`, { method: "POST" }).catch(() => {});
        }
        cleanup();
      }
    })();
  }, [cleanup, flushUpload]);

  const stop = useCallback(() => {
    const sid = stateRef.current.sessionId;
    if (!sid) return;
    // Flush any tail audio before asking the upstream to finalize —
    // otherwise the last word might be missing.
    if (stateRef.current.uploadFill > 0) {
      const out = new Uint8Array(stateRef.current.uploadFill);
      out.set(stateRef.current.uploadBuffer.subarray(0, stateRef.current.uploadFill));
      stateRef.current.uploadFill = 0;
      void flushUpload(sid, out);
    }
    // Stop microphone capture immediately so the OS indicator clears
    // even if the upstream finalize takes a moment. We keep the SSE
    // open until the server pushes the final TranscriptText + close.
    if (stateRef.current.workletNode) {
      try { stateRef.current.workletNode.disconnect(); } catch { /* ignore */ }
    }
    if (stateRef.current.mediaStream) {
      for (const track of stateRef.current.mediaStream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
    void fetch(`/api/voice/close?id=${sid}`, { method: "POST" }).catch(() => {
      // The session may have already been torn down server-side
      // (upstream close raced). Either way, the SSE will fire its
      // own close and `cleanup()` will run.
    });
  }, [flushUpload]);

  // Belt-and-braces cleanup if the component unmounts mid-recording.
  // Without this an unmount during dictation leaks the AudioContext
  // and the mic stays hot.
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return { supported, listening, error, start, stop };
}
