import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Push in-flight foreground work to the background — the Ctrl+B equivalent
 * (B2.4).
 *
 * Body: `{ toolUseId?: string }`. With `toolUseId` it backgrounds just that
 * blocking task; without it, all foreground tasks. Returns `{ backgrounded }`
 * — false only when a given `toolUseId` matched no foreground task. 404
 * unknown session, 503 when the session has no active query or the SDK throws.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { toolUseId?: string };
  const result = await session.backgroundTasks(
    typeof body?.toolUseId === "string" ? body.toolUseId : undefined,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 503 });
  return NextResponse.json({ ok: true, backgrounded: result.backgrounded });
}
