import { NextResponse } from "next/server";
import { getOrResumeSession } from "@/lib/server/session-resume";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getOrResumeSession(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  // SDK 0.3.257 — `?detail=summary` skips the per-category token-count API
  // calls the SDK otherwise makes for every poll; the idle-polling context
  // watcher only reads the headline totalTokens/maxTokens/percentage, so it
  // requests 'summary'. Anything else (notably the /context overlay's full
  // category breakdown) omits the param and gets the default 'full'.
  const detail = new URL(req.url).searchParams.get("detail");
  const result = await session.getContextUsage(
    detail === "summary" ? { detail: "summary" } : undefined,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json(result.data);
}
