import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import type { PlanDecisionSubmission } from "@/lib/shared/events";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  let body: PlanDecisionSubmission;
  try {
    body = (await req.json()) as PlanDecisionSubmission;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body?.requestId || !body?.decision?.kind) {
    return NextResponse.json({ error: "requestId and decision required" }, { status: 400 });
  }

  const ok = await session.resolvePlan(body.requestId, body.decision);
  if (!ok) {
    return NextResponse.json({ ok: false, reason: "stale" }, { status: 200 });
  }
  return NextResponse.json({ ok: true });
}
