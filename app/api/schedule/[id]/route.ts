import { NextResponse } from "next/server";
import { validateCron } from "@/lib/shared/cron";
import { scheduler } from "@/lib/server/scheduler";
import { deleteJob, patchJob, type Job } from "@/lib/server/scheduler-store";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

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
  const body = (await req.json()) as Patch;
  // Build the patch from known fields only, then merge it into the job as
  // stored at write time — a read-then-save here would clobber a run's
  // concurrent status write (or let a stray `id` key rename the job).
  const patch: Partial<Omit<Job, "id">> = { updatedAt: Date.now() };
  if (typeof body.cron === "string") {
    const v = validateCron(body.cron);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    patch.cron = v.cron;
  }
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.prompt === "string") patch.prompt = body.prompt;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.model === null) patch.model = undefined;
  else if (typeof body.model === "string") patch.model = body.model || undefined;
  if (typeof body.cwd === "string") {
    // Same rule as POST: the agent spawns here, so only a registered dir.
    const cwd = await resolveTrustedCwd(body.cwd);
    if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
    patch.cwd = cwd;
  }
  const next = await patchJob(id, patch);
  if (!next) return NextResponse.json({ error: "not found" }, { status: 404 });
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
