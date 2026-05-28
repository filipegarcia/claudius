import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { info as sessionFileInfo } from "@/lib/server/sessions-store";
import { listSuggestedMessageUuids } from "@/lib/server/suggested-messages-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns the uuids of user messages in this session that originated from a
 * clicked "Suggested follow-up" chip. The chat fetches this on session bind
 * and overlays an auto-suggested badge on matching bubbles — the provenance
 * the SDK JSONL doesn't carry across reloads.
 */

/** Mirror the helper in prompt-draft/route.ts — same fallback path. */
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
  const uuids = await listSuggestedMessageUuids(cwd, id).catch(() => []);
  return NextResponse.json({ uuids });
}
