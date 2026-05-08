import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { messages as allMessages } from "@/lib/server/sessions-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Paginated older-than-cursor transcript reader. Used by the chat UI's
 * "scroll up to load older" sentinel. Distinct from
 * /api/sessions/transcript/[id] which returns the full thing.
 *
 * Query params:
 *   ?before=<uuid> — return messages strictly before this uuid
 *   ?limit=<n>     — page size (default 50, capped at 200)
 *   ?dir=<cwd>     — project dir for the JSONL lookup (defaults to live session's cwd)
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const before = url.searchParams.get("before") || undefined;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
  let dir = url.searchParams.get("dir") || undefined;

  if (!dir) {
    const session = sessionManager.get(id);
    if (session) dir = session.cwd;
  }

  let all;
  try {
    all = await allMessages(id, dir, /* includeSystem */ true);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  let endIdx = all.length;
  if (before) {
    const idx = all.findIndex((m) => m.uuid === before);
    if (idx === -1) {
      return NextResponse.json({ error: "before uuid not found" }, { status: 400 });
    }
    endIdx = idx;
  }
  const start = Math.max(0, endIdx - limit);
  const messages = all.slice(start, endIdx);
  return NextResponse.json({
    messages,
    hasMore: start > 0,
  });
}
