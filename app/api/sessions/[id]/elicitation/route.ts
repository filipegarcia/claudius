import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { parseElicitationDecision } from "@/lib/shared/elicitation";

export const runtime = "nodejs";

/**
 * POST /api/sessions/[id]/elicitation  { requestId, decision }
 *
 * Answer a pending MCP elicitation (`mcp_elicitation_request`) — form values,
 * a decline, or a cancel. The decision is re-validated here rather than cast:
 * whatever we hand the SDK goes straight back to the MCP server, so only the
 * MCP `ElicitResult` shape (primitive or string-array values) gets through.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { requestId?: unknown; decision?: unknown } | null;
  const requestId = typeof body?.requestId === "string" ? body.requestId : "";
  const decision = parseElicitationDecision(body?.decision);
  if (!requestId || !decision) {
    return NextResponse.json({ error: "requestId and a valid decision required" }, { status: 400 });
  }
  const ok = session.resolveElicitation(requestId, decision);
  if (!ok) return NextResponse.json({ error: "no pending elicitation with that id" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
