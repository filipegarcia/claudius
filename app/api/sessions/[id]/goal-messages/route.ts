import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { info as sessionFileInfo } from "@/lib/server/sessions-store";
import { listGoalMessageUuids } from "@/lib/server/goal-messages-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns the uuids of user messages in this session that were sent as a
 * session goal. The chat fetches this on session bind and overlays a "Goal"
 * badge on matching bubbles — the provenance the SDK JSONL doesn't carry
 * across reloads. Mirrors the suggested-messages route.
 */

/** Mirror the helper in suggested-messages/route.ts — same fallback path. */
async function resolveCwd(sessionId: string): Promise<string | null> {
  const live = sessionManager.get(sessionId);
  if (live) return live.cwd;
  try {
    const info = await sessionFileInfo(sessionId);
    return info?.cwd ?? null;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cwd = await resolveCwd(id);
  if (!cwd) return NextResponse.json({ uuids: [] });
  const uuids = await listGoalMessageUuids(cwd, id).catch(() => []);
  return NextResponse.json({ uuids });
}
