import { NextResponse } from "next/server";
import { scheduler } from "@/lib/server/scheduler";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await scheduler.boot();
  // Fire async — don't make the caller wait for the run to finish.
  const promise = scheduler.runNow(id);
  const r = await promise;
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ runId: r.runId }, { status: 202 });
}
