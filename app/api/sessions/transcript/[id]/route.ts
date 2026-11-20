import { NextResponse } from "next/server";
import { messages } from "@/lib/server/sessions-store";
import { fullHistoryMessages } from "@/lib/server/compacted-history";

export const runtime = "nodejs";

/**
 * The session viewer's transcript (`/sessions/<id>`): the whole conversation,
 * including the turns before each compaction (see `fullHistoryMessages`). The
 * chat's paginated "load older" uses `/api/sessions/[id]/transcript`, which
 * stays on the post-compact chain the live session replays.
 *
 * If the stitched read fails, we fall back to the SDK's post-compact chain
 * and set `historyError` so the viewer can say it's showing a partial
 * history instead of passing it off as everything.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  const includeSystem = url.searchParams.get("system") !== "0";
  let historyError: string | undefined;
  try {
    return NextResponse.json({ messages: await fullHistoryMessages(id, dir, includeSystem) });
  } catch (err) {
    historyError = err instanceof Error ? err.message : String(err);
  }
  try {
    const list = await messages(id, dir, includeSystem);
    return NextResponse.json({ messages: list, historyError });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
