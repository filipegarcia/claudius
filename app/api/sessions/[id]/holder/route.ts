import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * PATCH /api/sessions/[id]/holder
 * Body: { tabId: string }
 *
 * Force-assign the session write lock to the given tabId. Used by the
 * "Take over" button when a client wants to become the active holder
 * regardless of which tab currently holds it. All connected SSE subscribers
 * will receive a `holder_changed` event; any tab whose tabId no longer
 * matches will render read-only.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { tabId?: string } | null;
  if (!body?.tabId || typeof body.tabId !== "string") {
    return NextResponse.json({ error: "tabId required" }, { status: 400 });
  }

  session.claimHolder(body.tabId);
  return NextResponse.json({ ok: true, holderId: body.tabId });
}
