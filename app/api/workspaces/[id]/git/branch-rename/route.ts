import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { renameBranch, isGitError } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { oldName?: unknown; newName?: unknown };

/**
 * `git branch -m <old> <new>`. Renaming the current branch is fine; git
 * rewrites HEAD. Refuses if `<new>` already exists (no `-M` upgrade —
 * keeping the destructive force path out of the API surface for now).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Body;
  if (typeof body.oldName !== "string" || !body.oldName.trim()) {
    return NextResponse.json({ error: "oldName (string) required" }, { status: 400 });
  }
  if (typeof body.newName !== "string" || !body.newName.trim()) {
    return NextResponse.json({ error: "newName (string) required" }, { status: 400 });
  }
  const result = await renameBranch(ws.rootPath, body.oldName, body.newName);
  if (isGitError(result)) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: 400 });
  }
  return NextResponse.json(result);
}
