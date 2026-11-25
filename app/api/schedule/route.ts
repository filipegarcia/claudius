import { NextResponse } from "next/server";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";
import { randomUUID } from "node:crypto";
import { validateCron } from "@/lib/shared/cron";
import { scheduler } from "@/lib/server/scheduler";
import { JobsFileShapeError, type Job } from "@/lib/server/scheduler-store";
import { parseScheduleEffort } from "@/lib/shared/schedule-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CC 2.1.328: an unreadable jobs.json is reported, never overwritten. */
function jobsFileFailure(err: unknown): NextResponse {
  if (err instanceof JobsFileShapeError) return NextResponse.json({ error: err.message }, { status: 500 });
  throw err;
}

export async function GET() {
  try {
    await scheduler.boot();
    const jobs = await scheduler.listJobs();
    return NextResponse.json({ jobs });
  } catch (err) {
    return jobsFileFailure(err);
  }
}

type CreateBody = {
  name?: string;
  cron?: string;
  prompt?: string;
  model?: string;
  /** CC 2.1.312 — one of low/medium/high/xhigh/max; absent or "" = model default. */
  effort?: unknown;
  cwd?: string;
  enabled?: boolean;
};

export async function POST(req: Request) {
  try {
    return await createJob(req);
  } catch (err) {
    return jobsFileFailure(err);
  }
}

async function createJob(req: Request): Promise<NextResponse> {
  await scheduler.boot();
  const body = (await req.json()) as CreateBody;
  if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!body?.cron) return NextResponse.json({ error: "cron required" }, { status: 400 });
  if (!body?.prompt?.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });
  const v = validateCron(body.cron);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  // The body is untrusted: only a known level is stored.
  const effort = body.effort === undefined ? null : parseScheduleEffort(body.effort);
  if (effort === undefined) return NextResponse.json({ error: "unknown effort" }, { status: 400 });

  // A scheduled job's cwd is where the agent will actually be spawned, so it
  // must be a directory the user registered — not one named by the caller.
  const cwd = await resolveTrustedCwd(body.cwd);
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    name: body.name.trim(),
    cron: v.cron,
    prompt: body.prompt,
    model: body.model || undefined,
    ...(effort ? { effort } : {}),
    cwd,
    enabled: body.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };
  await scheduler.saveJob(job);
  if (job.enabled) await scheduler.arm(job);
  return NextResponse.json(job, { status: 201 });
}
