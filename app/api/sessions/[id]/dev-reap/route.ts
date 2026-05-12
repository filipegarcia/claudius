import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dev-only: forcibly evict an in-memory Session, simulating the reaper
 * having fired. Used by the e2e to verify the resume-from-disk path
 * without depending on a long idle window. Mirrors the dev-broadcast
 * 404-in-production guard.
 *
 * After this call, the next subscriber (SSE) for the same id will run
 * through `getOrResumeSession` → `sessionManager.create({ resume })`,
 * which loads historical messages from the JSONL on disk and replays
 * them to the new subscriber.
 *
 * Returns `{ ok: true, reaped: boolean }` — `reaped: false` means the
 * session wasn't in the in-memory map (already reaped, or never woken).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only endpoint" }, { status: 404 });
  }
  const { id } = await ctx.params;
  const existed = !!sessionManager.get(id);
  if (existed) {
    // `remove` cancels the reap timer, unsubscribes the subscriber-count
    // listener, calls `session.end()` (which aborts the SDK abort
    // controller + closes the input queue + stops the JSONL watcher),
    // and finally deletes from the map. Same path the natural reaper
    // takes when the idle window elapses.
    await sessionManager.remove(id);
  }
  return NextResponse.json({ ok: true, reaped: existed });
}
