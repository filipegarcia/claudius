import { sessionManager } from "@/lib/server/session-manager";
import { info as sessionFileInfo } from "@/lib/server/sessions-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let session = sessionManager.get(id);
  if (!session) {
    // Session may have been reaped after an idle window. The JSONL on disk
    // is the durable source of truth — if we can find it, rebuild the
    // Session via resume so the user's `?session=<id>` URL keeps working
    // without forcing them to refresh into a brand-new conversation.
    try {
      const fileInfo = await sessionFileInfo(id);
      if (fileInfo?.cwd) {
        session = await sessionManager.create({ resume: id, cwd: fileInfo.cwd });
      }
    } catch {
      // fall through to 404
    }
  }
  if (!session) {
    return new Response("session not found", { status: 404 });
  }

  const url = new URL(req.url);
  const tailParam = url.searchParams.get("tail");
  const tail = tailParam !== null ? Math.max(0, Math.min(500, Number(tailParam) || 0)) : undefined;

  // Pull any turns added to the on-disk JSONL since we last looked. Covers
  // the case where the user continued the session via `claude --resume` in
  // the terminal between this tab being open and being refreshed — without
  // this the in-memory buffer is frozen at whatever was loaded at start().
  // Best-effort: errors here just leave the buffer as-is, the subscribe
  // call below still works.
  //
  // Method-existence guard: in Next.js dev, an in-memory Session created
  // before this method was added to the class is still bound to the old
  // prototype. Calling a method that doesn't exist throws TypeError and
  // crashes the route — so check first and skip the resync silently when
  // the instance is stale. A dev-server restart picks up the new method.
  const maybeResync = (session as unknown as { resyncFromDisk?: () => Promise<unknown> })
    .resyncFromDisk;
  if (typeof maybeResync === "function") {
    await maybeResync.call(session).catch(() => {});
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => {
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      const unsubscribe = session.subscribe(send, tail !== undefined ? { tail } : undefined);

      // Belt-and-suspenders ready emit. The Session.subscribe() path also
      // emits a synthetic ready when this.query is set, but in dev-mode HMR
      // an existing in-memory Session can be bound to the pre-edit prototype
      // and never run that branch. The route handler always picks up edits,
      // and `setReady(true)` is idempotent on the client, so this is safe to
      // emit unconditionally as long as the session object exists.
      try {
        send({ type: "ready", sessionId: id });
      } catch {
        // controller closed already — heartbeat cleanup will handle it
      }

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // closed
        }
      }, 15000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const signal = req.signal;
      if (signal) {
        if (signal.aborted) cleanup();
        else signal.addEventListener("abort", cleanup, { once: true });
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
