import { NextResponse } from "next/server";
import { info } from "@/lib/server/sessions-store";
import { getSessionTitle } from "@/lib/server/sessions-db";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  const meta = await info(id, dir);
  if (!meta) return NextResponse.json({ error: "session not found" }, { status: 404 });
  // Mirror what /api/sessions/all does: enrich with our DB title so the
  // detail page can show the Claudius-side rename even when the SDK's
  // JSONL header doesn't carry a customTitle yet. See the route comment
  // in /api/sessions/all for the full rationale.
  const cwd = meta.cwd ?? dir;
  if (cwd) {
    const claudiusTitle = await getSessionTitle(cwd, id).catch(() => null);
    if (claudiusTitle) {
      return NextResponse.json({ ...meta, claudiusTitle });
    }
  }
  return NextResponse.json(meta);
}
