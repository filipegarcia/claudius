import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import type { PermissionDecision } from "@/lib/shared/events";

export const runtime = "nodejs";

type Body = { requestId: string; decision: PermissionDecision };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body = (await req.json()) as Body;
  if (!body?.requestId || !body?.decision) {
    return NextResponse.json({ error: "requestId and decision required" }, { status: 400 });
  }
  const ok = session.resolvePermission(body.requestId, body.decision);
  if (!ok) return NextResponse.json({ error: "no pending permission with that id" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
