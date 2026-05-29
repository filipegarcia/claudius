import { NextResponse } from "next/server";
import { validateCron } from "@/lib/shared/cron";
import { scheduler } from "@/lib/server/scheduler";
import { deleteJob } from "@/lib/server/scheduler-store";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await scheduler.boot();
  const job = await scheduler.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(job);
}

type Patch = Partial<{
  name: string;
  cron: string;
  prompt: string;
  model: string | null;
  cwd: string;
  enabled: boolean;
}>;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await scheduler.boot();
  const job = await scheduler.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json()) as Patch;
  if (typeof body.cron === "string") {
    const v = validateCron(body.cron);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  }
  const next = {
    ...job,
    ...body,
    model: body.model === null ? undefined : body.model ?? job.model,
    updatedAt: Date.now(),
  };
  await scheduler.saveJob(next);
  if (next.enabled) await scheduler.arm(next);
  else scheduler.disarm(id);
  return NextResponse.json(next);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await scheduler.boot();
  scheduler.disarm(id);
  const ok = await deleteJob(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
