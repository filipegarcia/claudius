import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { validateCron } from "@/lib/shared/cron";
import { scheduler } from "@/lib/server/scheduler";
import type { Job } from "@/lib/server/scheduler-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await scheduler.boot();
  const jobs = await scheduler.listJobs();
  return NextResponse.json({ jobs });
}

type CreateBody = {
  name?: string;
  cron?: string;
  prompt?: string;
  model?: string;
  cwd?: string;
  enabled?: boolean;
};

export async function POST(req: Request) {
  await scheduler.boot();
  const body = (await req.json()) as CreateBody;
  if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!body?.cron) return NextResponse.json({ error: "cron required" }, { status: 400 });
  if (!body?.prompt?.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });
  const v = validateCron(body.cron);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    name: body.name.trim(),
    cron: v.cron,
    prompt: body.prompt,
    model: body.model || undefined,
    cwd: body.cwd?.trim() || process.cwd(),
    enabled: body.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };
  await scheduler.saveJob(job);
  if (job.enabled) await scheduler.arm(job);
  return NextResponse.json(job, { status: 201 });
}
