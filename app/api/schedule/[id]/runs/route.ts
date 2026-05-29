import { NextResponse } from "next/server";
import { scheduler } from "@/lib/server/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await scheduler.boot();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || "50") || 50;
  const runs = await scheduler.listRuns(id, limit);
  return NextResponse.json({ runs });
}
