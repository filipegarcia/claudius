import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { mergeBranchIntoCurrent } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { name?: unknown };

/**
 * Merge `name` into the currently-checked-out branch. Mirrors `pull-merge`'s
 * three-outcome shape so the client can reuse the conflict handoff:
 *   200 — clean merge (incl. fast-forward)
 *   409 — `kind: "conflicts"` — tree mid-merge, conflicts listed
 *   400 — `kind: "error"`     — operational failure (dirty tree, unknown ref, …)
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Body;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name (string) required" }, { status: 400 });
  }
  const result = await mergeBranchIntoCurrent(ws.rootPath, body.name);
  if (result.ok) return NextResponse.json(result);
  if (result.kind === "conflicts") {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result, { status: 400 });
}
