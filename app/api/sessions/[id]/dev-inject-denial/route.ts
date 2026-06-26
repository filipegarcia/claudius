import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * POST /api/sessions/[id]/dev-inject-denial
 *
 * Dev-only endpoint that seeds a synthetic permission denial into the
 * session's in-memory ring buffer. Used by Playwright tests to exercise
 * the "Recent Denials" section on /permissions without needing a real SDK
 * permission_denied event.
 *
 * Body: { toolName?: string; reasonType?: string }
 * Returns 403 in production.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev only" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({})) as { toolName?: string; reasonType?: string };
  session.injectDenialForTesting(
    typeof body.toolName === "string" ? body.toolName : "Bash",
    typeof body.reasonType === "string" ? body.reasonType : "auto_deny",
  );
  return NextResponse.json({ ok: true });
}
