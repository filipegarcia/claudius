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
  const summary = detail === "summary";
  const result = await session.getContextUsage(summary ? { detail: "summary" } : undefined);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  // CC 2.1.261 (H4) — on the full `/context` overlay fetch (not the idle
  // summary poll), also fetch the week's used-skill names so the overlay can
  // flag "unused (7d)" skills. `null` when the experimental signal is
  // unavailable → the overlay shows no (potentially misleading) badge.
  const weeklyUsedSkills = summary ? null : await session.getWeeklyUsedSkills();
  const data = result.data as Record<string, unknown>;
  return NextResponse.json(summary ? data : { ...data, weeklyUsedSkills });
}
