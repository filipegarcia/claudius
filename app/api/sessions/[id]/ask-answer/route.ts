import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import type { AskAnswerSubmission } from "@/lib/shared/events";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  let body: AskAnswerSubmission;
  try {
    body = (await req.json()) as AskAnswerSubmission;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body?.requestId || !Array.isArray(body.answers)) {
    return NextResponse.json({ error: "requestId and answers required" }, { status: 400 });
  }

  const ok = session.submitAskAnswer(body.requestId, body.answers);
  if (!ok) {
    // Most likely the request was aborted or already resolved — not an error
    // worth surfacing to the user as a failure, but the client can stop
    // showing the form.
    return NextResponse.json({ ok: false, reason: "stale" }, { status: 200 });
  }
  return NextResponse.json({ ok: true });
}
