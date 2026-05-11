import { notificationBus } from "@/lib/server/notification-bus";
import type { NotificationStreamEvent } from "@/lib/shared/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/stream
 *
 * Single per-tab SSE that fans out notification + count events for *every*
 * workspace the user can see. The browser opens exactly one EventSource here
 * (see `useNotificationCounts`) and uses it to drive:
 *   • per-workspace tile badges in the left rail
 *   • favicon + document.title overlay
 *   • the live notification drawer
 *
 * On connect we emit a synthetic `count` event for every workspace so the
 * client can paint badges immediately without a separate `/counts` fetch
 * race. Heartbeat + abort cleanup follow the pattern from the sessions
 * stream route.
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: NotificationStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller closed
        }
      };

      // Seed the stream with current counts. Cheap (memoized 1s) and avoids
      // the gap between EventSource open and the first real notification.
      try {
        const counts = await notificationBus.countsAllWorkspaces();
        for (const [workspaceId, unread] of Object.entries(counts)) {
          send({ type: "count", workspaceId, unread });
        }
      } catch {
        // seeding is best-effort; the client also fetches /counts on mount
      }

      const unsubscribe = notificationBus.subscribe(send);

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
