import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  await session.interrupt();
  return NextResponse.json({ ok: true });
}
