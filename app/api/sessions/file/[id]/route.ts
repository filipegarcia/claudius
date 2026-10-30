import { NextResponse } from "next/server";
import { remove } from "@/lib/server/sessions-store";
import { sessionManager } from "@/lib/server/session-manager";
import { deleteIndexedSession } from "@/lib/server/sessions-db";
import { deleteSessionTitle } from "@/lib/server/session-titles";

export const runtime = "nodejs";

function isTranscriptNotFound(err: unknown): boolean {
  return err instanceof Error && /\bnot found\b/i.test(err.message);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  try {
    // CC 2.1.314 — a deleted session must not come back in the list as an
    // almost empty entry. End a live copy first, so its SDK child can't
    // write the transcript again after the unlink.
    await sessionManager.remove(id);
    try {
      await remove(id, dir);
    } catch (err) {
      // A session renamed before its first message has an index row but no
      // transcript, and the SDK refuses with "Session … not found". That
      // row is exactly the stub that kept coming back, so finish the
      // cleanup below instead of failing (silently, before 2.1.314).
      if (!isTranscriptNotFound(err)) throw err;
    }
    // Then drop what `/api/sessions/all` would rebuild a stub entry from:
    // the `.claudius.db` index row and the legacy title (whose on-the-fly
    // migration in `getSessionTitle` would re-insert the row). Best-effort:
    // the transcript is already gone, so a failure here must not report the
    // delete as failed.
    await deleteIndexedSession(id).catch(() => 0);
    await deleteSessionTitle(id).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
