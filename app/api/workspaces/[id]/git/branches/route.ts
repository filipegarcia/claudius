import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { listBranches, isGitError } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const result = await listBranches(ws.rootPath);
  if (isGitError(result)) {
    if (result.code === "not-a-repo") {
      return NextResponse.json({ branches: [] });
    }
    return NextResponse.json({ error: result.message, code: result.code }, { status: 500 });
  }
  return NextResponse.json({ branches: result });
}
