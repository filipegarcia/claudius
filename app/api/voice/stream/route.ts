/**
 * GET /api/voice/stream?id=<sessionId>&lang=en
 *
 * SSE: opens the upstream voice_stream WebSocket to api.anthropic.com
 * with the active profile's OAuth token, and relays every transcript
 * event to the renderer as an SSE message. The renderer never sees the
 * token or even knows the upstream URL.
 *
 * Event types we emit:
 *   event: open       — upstream connected, ready for chunks
 *   event: message    — JSON envelope from upstream (TranscriptInterim /
 *                       TranscriptText / TranscriptEndpoint / TranscriptError)
 *   event: error      — local proxy error (no-auth, upstream-error, …)
 *   event: close      — upstream closed; client should stop sending chunks
 */
import {
  closeSession,
  openVoiceSession,
  type SseSink,
} from "@/lib/server/voice-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const language = url.searchParams.get("lang") || "en";
  if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
    return new Response("invalid or missing id", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Emit a `retry:` directive once at the top of the stream so the
      // browser's auto-reconnect timer is set far enough out that it
      // never fires before our explicit client-side close. SSE's
      // default reconnect is ~3 s; without this, a normal finalize
      // (server EOF after `event: close`) would race the client's
      // EventSource.close() call and could spin up a fresh upstream
      // WS session every utterance.
      try {
        controller.enqueue(encoder.encode(`retry: 3600000\n\n`));
      } catch {
        /* closed already (shouldn't happen here, but defensive) */
      }

      const sink: SseSink = {
        send(event: string, data: string) {
          // SSE: each frame is "event: NAME\ndata: PAYLOAD\n\n". The
          // payload may itself be multi-line JSON in theory; we control
          // both ends so we stick to single-line JSON to keep this
          // simple. `try` because the controller may have been closed
          // by the abort handler before the upstream's last `close`
          // event fired.
          try {
            const frame =
              `event: ${event}\n` +
              `data: ${data}\n\n`;
            controller.enqueue(encoder.encode(frame));
          } catch {
            /* closed */
          }
        },
        close() {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      };

      // Heartbeat so proxies don't kill the SSE for idleness, and so
      // a half-closed TCP socket is detected by the client.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* closed */
        }
      }, 15_000);

      // Hook up abort cleanup before kicking off the upstream, so a
      // very-fast client cancel can't leak a session.
      const signal = req.signal;
      const cleanup = () => {
        clearInterval(heartbeat);
        closeSession(id, "client-abort");
      };
      if (signal) {
        if (signal.aborted) {
          cleanup();
          return;
        }
        signal.addEventListener("abort", cleanup, { once: true });
      }

      try {
        await openVoiceSession(id, sink, { language });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sink.send("error", JSON.stringify({ kind: "open-failed", message }));
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable Next.js's response buffering — otherwise the first
      // few SSE frames sit in a pipe until ~1 KB has accumulated.
      "X-Accel-Buffering": "no",
    },
  });
}
