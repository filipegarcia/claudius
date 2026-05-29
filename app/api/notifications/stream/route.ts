import { notificationBus } from "@/lib/server/notification-bus";
import type { NotificationStreamEvent } from "@/lib/shared/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/stream
 *
 * Single per-tab SSE that fans out notification + state events for *every*
 * workspace the user can see. The browser opens exactly one EventSource here
 * (see `NotificationsProvider`) and uses it to drive:
 *   • per-workspace tile badges in the left rail
 *   • favicon + document.title overlay
 *   • the live notification drawer
 *   • the per-session tab badge strip
 *
 * On connect we emit a `state` event per workspace (workspace total +
 * per-session map + monotonic version) so the client paints all four badges
 * atomically without racing a separate /counts fetch. Heartbeat + abort
 * cleanup follow the pattern from the sessions stream route.
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

      // Seed the stream with one state event per workspace. Bumps the bus's
      // `version` counter so any in-flight HTTP /counts response carrying a
      // smaller version is automatically dropped by the client.
      try {
        const states = await notificationBus.getAllWorkspaceStates();
        for (const state of Object.values(states)) {
          send({ type: "state", ...state });
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
