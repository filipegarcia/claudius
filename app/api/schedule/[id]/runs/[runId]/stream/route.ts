import { scheduler } from "@/lib/server/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live event stream for a scheduled-job run. Mirrors the chat SSE route's
 * shape so the client can reuse the same event reducers. When the run is no
 * longer live the scheduler emits one synthetic `error: run_not_live` and the
 * client should fall back to the persisted transcript (`/runs`).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; runId: string }> },
) {
  const { runId } = await ctx.params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const unsubscribe = scheduler.subscribeRun(runId, send);

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Auto-close once the run is no longer live. Poll cheaply since runs
      // typically last seconds-to-minutes; the client can also disconnect.
      const liveCheck = setInterval(() => {
        if (!scheduler.isRunLive(runId)) {
          clearInterval(liveCheck);
          // One last marker so the client UI can swap to the final transcript.
          send({ type: "ready", sessionId: `${runId}:done` });
          cleanup();
        }
      }, 1000);

      const signal = req.signal;
      if (signal) {
        const onAbort = () => {
          clearInterval(liveCheck);
          cleanup();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
