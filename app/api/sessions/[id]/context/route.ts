import { NextResponse } from "next/server";
import { getOrResumeSession } from "@/lib/server/session-resume";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getOrResumeSession(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const result = await session.getContextUsage();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json(result.data);
}
