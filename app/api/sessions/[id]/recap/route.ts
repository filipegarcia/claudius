import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Trigger a "where were we?" recap for the active session. Fire-and-forget:
 * the body's `origin` distinguishes an automatic away-return from a manual
 * user action (the only difference on the wire is the `origin` field of the
 * resulting `session_recap` SSE event, which is informational).
 *
 * The actual generation runs asynchronously on the server; the recap text is
 * delivered to every subscribed tab via SSE (`session_recap` event). On the
 * sad paths a `session_recap_error` event lands instead with a reason —
 * disabled, running, no_history, rate_limited, failed.
 *
 * The HTTP response only signals "request accepted" — clients should listen
 * to SSE for the actual outcome.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  let origin: "away" | "manual" = "away";
  try {
    const body = (await req.json()) as { origin?: unknown } | null;
    if (body && (body.origin === "manual" || body.origin === "away")) {
      origin = body.origin;
    }
  } catch {
    // No body / invalid JSON — default to `away`, which is the safer
    // assumption (no banner phrasing tweak applied).
  }
  // Intentionally NOT awaited — requestRecap is fire-and-forget and the
  // outcome rides SSE. Wrap in a void promise to swallow any thrown reject
  // (requestRecap is designed to always resolve, but be defensive — a thrown
  // promise here would otherwise surface as an unhandled rejection).
  void session.requestRecap(origin).catch((err) => {
    console.warn("[api/sessions/recap] requestRecap failed:", err);
  });
  return NextResponse.json({ ok: true }, { status: 202 });
}
