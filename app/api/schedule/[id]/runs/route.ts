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
  // CC 2.1.221 parity: annotate in-flight runs with whether a client
  // currently has their live stream open ("attached") or the run is
  // progressing unwatched ("unattended"). `attached` is ephemeral process
  // state (subscriber count), not persisted alongside the Run record, so
  // it's computed fresh on every poll rather than stored.
  const withAttached = runs.map((r) =>
    r.status === "running" ? { ...r, attached: scheduler.isRunAttached(r.id) } : r,
  );
  return NextResponse.json({ runs: withAttached });
}
