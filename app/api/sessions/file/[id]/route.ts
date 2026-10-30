import { NextResponse } from "next/server";
import { info, remove } from "@/lib/server/sessions-store";
import { sessionManager } from "@/lib/server/session-manager";
import { deleteIndexedSession } from "@/lib/server/sessions-db";
import { deleteSessionTitle } from "@/lib/server/session-titles";
import { removeSessionFromSavedTabs } from "@/lib/server/open-tabs-db";

export const runtime = "nodejs";

function isTranscriptNotFound(err: unknown): boolean {
  return err instanceof Error && /\bnot found\b/i.test(err.message);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  // A chat that's mid-turn or waiting on a prompt isn't killed by a delete
  // (same rule as moving a workspace's sessions); the page shows this.
  const live = sessionManager.get(id);
  if (live && live.getStatus() !== "idle") {
    return NextResponse.json(
      { error: "This chat is still working. Wait for it to finish (or stop it), then delete again." },
      { status: 409 },
    );
  }
  try {
    // CC 2.1.314 — a deleted session must not come back in the list as an
    // almost empty entry. End an idle live copy first, so its SDK child
    // can't write the transcript again after the unlink.
    await sessionManager.remove(id);
    try {
      await remove(id, dir);
    } catch (err) {
      // A session renamed before its first message has an index row but no
      // transcript anywhere, and the SDK refuses with "Session … not found".
      // That row is exactly the stub that kept coming back, so finish the
      // cleanup below. Only when no transcript exists in ANY project: a
      // stale `dir` that misses a real transcript must still fail.
      if (!isTranscriptNotFound(err)) throw err;
      if (await info(id).catch(() => undefined)) throw err;
    }
    // Then drop what would rebuild a stub entry: the legacy title first
    // (its on-the-fly migration in `getSessionTitle` re-inserts the index
    // row), the `.claudius.db` index row, and saved tab strips (the next
    // chat boot would resume the id and re-index it). Best-effort: the
    // transcript is already gone, so a failure here must not report the
    // delete as failed.
    await deleteSessionTitle(id).catch(() => {});
    await deleteIndexedSession(id).catch(() => 0);
    await removeSessionFromSavedTabs(id).catch(() => 0);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
