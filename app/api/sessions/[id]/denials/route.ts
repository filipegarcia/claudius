import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * GET /api/sessions/[id]/denials
 *
 * Returns the in-memory ring buffer of recent permission denials for the
 * given session (CC 2.1.193 parity — "Recent Denials" on /permissions).
 * Array is in insertion order (oldest first, newest last), capped at 20.
 * Returns 404 if the session isn't in memory; the /permissions page treats
 * an empty or missing response as "no recent denials."
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  return NextResponse.json({ denials: session.getRecentDenials() });
}
