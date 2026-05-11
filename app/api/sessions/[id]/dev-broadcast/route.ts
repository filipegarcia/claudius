import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import type { ServerEvent } from "@/lib/shared/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dev-only: invoke a session's private `broadcast(event)` method directly.
 * This exercises the in-Session bus hook (`Session.broadcast` calls
 * `notificationBus.recordSessionEvent` at the end) without needing the SDK
 * to fire a real event. The e2e uses it to verify the broadcast → bus chain
 * hasn't regressed.
 *
 * Body: { event: ServerEvent }
 *
 * 404s in production.
 */
type Body = { event?: ServerEvent };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only endpoint" }, { status: 404 });
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Body;
  if (!body.event) {
    return NextResponse.json({ error: "event required" }, { status: 400 });
  }
  const session = sessionManager.get(id);
  if (!session) {
    return NextResponse.json({ error: "session not bound" }, { status: 404 });
  }
  // `broadcast` is private — we reach for it via the unknown cast so the
  // production type contract stays untouched.
  const broadcast = (session as unknown as { broadcast?: (e: ServerEvent) => void })
    .broadcast;
  if (typeof broadcast !== "function") {
    return NextResponse.json({ error: "broadcast not available" }, { status: 500 });
  }
  broadcast.call(session, body.event);
  // Echo the session's cwd + id so test failures can diagnose
  // "bus didn't fire" cases where the cwd doesn't map to any workspace.
  return NextResponse.json({
    ok: true,
    sessionCwd: (session as unknown as { cwd?: string }).cwd ?? null,
    sessionId: (session as unknown as { id?: string }).id ?? null,
  });
}
