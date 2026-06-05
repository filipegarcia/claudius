import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * DELETE a queued message and return the row's full contents (text + images)
 * back to the client. The combined "remove + return content" shape exists to
 * support the composer's "Edit" UX without a second round-trip:
 *
 *   - "Cancel" → caller ignores the response body.
 *   - "Edit"   → caller takes `text`/`images` from the response and pre-fills
 *               the composer, where the user can re-edit and re-send.
 *
 * Images are NOT included in the `queue:updated` SSE snapshot (kept slim to
 * avoid shipping multi-MB blobs on every reorder), so this endpoint is the
 * only way the client gets the original image bytes for an "Edit".
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; uuid: string }> },
) {
  const { id, uuid } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  // Snapshot the row before deletion so we can hand its content back to the
  // caller. `getQueueSnapshot` returns metadata only (no images); load the
  // full row via the cwd-scoped helper directly.
  const { listQueue } = await import("@/lib/server/queued-messages-db");
  const all = await listQueue(session.cwd, session.id);
  const row = all.find((r) => r.uuid === uuid);
  if (!row) {
    return NextResponse.json({ error: "queued message not found" }, { status: 404 });
  }
  const removed = await session.removeQueued(uuid);
  if (!removed) {
    return NextResponse.json({ error: "queued message not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    uuid: row.uuid,
    text: row.text,
    ...(row.images && row.images.length > 0 ? { images: row.images } : {}),
    ...(row.slash ? { slash: true } : {}),
    ...(row.fromSuggestion ? { fromSuggestion: true } : {}),
    ...(row.fromGoal ? { fromGoal: true } : {}),
  });
}
