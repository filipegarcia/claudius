import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

type Body = { sessionId: string; enabled: boolean };

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const body = (await req.json()) as Body;
  if (!body?.sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  const session = sessionManager.get(body.sessionId);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const r = await session.toggleMcp(name, !!body.enabled);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
