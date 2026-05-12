import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { pullWithMerge } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pull-and-merge endpoint that ships conflicts back to the client as data
 * instead of as a 500. Used by the "Pull (auto-resolve with Claude)" button
 * — the UI either celebrates a clean merge, opens a Claude chat with the
 * conflict list, or shows a normal error toast.
 *
 * Status codes deliberately distinguish the three outcomes so the client can
 * route without sniffing the body:
 *   200 — clean merge
 *   409 — conflict (kind: "conflicts")
 *   400 — operational error (kind: "error")
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const result = await pullWithMerge(ws.rootPath);
  if (result.ok) {
    return NextResponse.json(result);
  }
  if (result.kind === "conflicts") {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result, { status: 400 });
}
