import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Stop a single running task (Bash / subagent) by id — B2.4.
 *
 * Body: `{ taskId: string }`. Unlike interrupting the whole turn, this
 * targets just the one task; the SDK emits a `task_notification` with
 * status 'stopped'. 404 unknown session, 400 missing taskId, 503 when the
 * session has no active SDK query or the SDK call throws.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { taskId?: string };
  if (!body?.taskId || typeof body.taskId !== "string") {
    return NextResponse.json({ error: "taskId required" }, { status: 400 });
  }

  const result = await session.stopTask(body.taskId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  return NextResponse.json({ ok: true });
}
