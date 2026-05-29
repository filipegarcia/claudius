import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import {
  isStaleWakeup,
  type SessionLoopListItem,
  type SessionLoopListResponse,
} from "@/lib/shared/session-loops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/schedule/session-loops
 *
 * Cross-session list of every loop/wake-up the agent has armed via the
 * harness-provided `CronCreate` / `ScheduleWakeup` tools. Each entry
 * carries its owning `sessionId` so the cancel endpoint can target it,
 * plus an optional `sessionTitle` for the `/schedule` page chip.
 *
 * Distinct from `GET /api/schedule` (which lists Claudius's own durable
 * jobs) — these loops live only as long as their session is alive on
 * the server. When a session is evicted, its loops vanish from this list
 * automatically because they live inside the Session object's RAM.
 */
export async function GET() {
  const sessions = sessionManager.list();
  const loops: SessionLoopListItem[] = [];
  // Compute `now` once per request so every loop is judged against the
  // same instant — keeps the staleness cut consistent across sessions.
  const now = Date.now();
  for (const s of sessions) {
    // Dev HMR caveat: the SessionManager singleton is shared across hot
    // reloads (see `globalThis.__claudiusSessionManager` in
    // `lib/server/session-manager.ts`), so Session instances created
    // before this method was added won't have `getScheduledLoops` at all.
    // The `typeof` guard makes the endpoint resilient to that, and also
    // protects test stubs that don't bother implementing the method.
    // Reloading any active session (or restarting `next dev`) replaces the
    // stale instance with a current one; until then we just skip it.
    if (typeof s.getScheduledLoops !== "function") continue;
    for (const loop of s.getScheduledLoops()) {
      // Drop wake-ups whose fire moment + grace has passed without a
      // chained replacement. The server still holds them in the per-
      // session Map (no in-process tick to prune them), but we don't
      // need to ship them — every client surface filters them out the
      // same way (see `isStaleWakeup`). Filtering here keeps the wire
      // payload honest and avoids the "stuck at due now forever" chip.
      if (isStaleWakeup(loop, now)) continue;
      loops.push({
        ...loop,
        sessionId: s.id,
        sessionTitle: s.title ?? null,
      });
    }
  }
  // Newest first so the `/schedule` page shows recent activity on top.
  loops.sort((a, b) => b.startedAt - a.startedAt);
  const body: SessionLoopListResponse = { loops };
  return NextResponse.json(body);
}
