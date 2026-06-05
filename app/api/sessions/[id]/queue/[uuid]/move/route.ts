import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

type Body = { direction: "up" | "down" };

/**
 * Swap a queued message with its neighbor in the requested direction. Routed
 * through `Session.moveQueuedMessage` so the read-modify-write on the
 * (session_id, position) index is serialized through the single in-memory
 * Session object — two tabs clicking reorder at the same instant can't
 * collide on positions.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; uuid: string }> },
) {
  const { id, uuid } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || (body.direction !== "up" && body.direction !== "down")) {
    return NextResponse.json(
      { error: "body.direction must be 'up' or 'down'" },
      { status: 400 },
    );
  }
  const ok = await session.moveQueuedMessage(uuid, body.direction);
  if (!ok) {
    // No-op when already at the boundary OR the uuid doesn't match — the UI
    // doesn't care which; either way the queue didn't change.
    return NextResponse.json({ ok: false, moved: false });
  }
  return NextResponse.json({ ok: true, moved: true });
}
