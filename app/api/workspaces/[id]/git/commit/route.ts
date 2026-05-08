import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { commitStaged, isGitError, stagePaths } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { message?: unknown; stagePaths?: unknown };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Body;
  const message = body.message;
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  // Optional convenience: stage these paths first, then commit. The page uses
  // this for the IntelliJ-style "checked items become the commit" flow.
  if (body.stagePaths !== undefined) {
    if (!Array.isArray(body.stagePaths) || !body.stagePaths.every((p): p is string => typeof p === "string")) {
      return NextResponse.json({ error: "stagePaths must be string[]" }, { status: 400 });
    }
    if ((body.stagePaths as string[]).length > 0) {
      const staged = await stagePaths(ws.rootPath, body.stagePaths as string[], "stage");
      if (isGitError(staged)) {
        return NextResponse.json({ error: staged.message, code: staged.code }, { status: 500 });
      }
    }
  }
  const result = await commitStaged(ws.rootPath, message);
  if (isGitError(result)) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: 500 });
  }
  return NextResponse.json(result);
}
