import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { getDiff, isGitError, type DiffMode } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES: DiffMode[] = ["worktree", "staged", "untracked"];

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const mode = url.searchParams.get("mode") as DiffMode | null;
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  if (!mode || !MODES.includes(mode)) {
    return NextResponse.json(
      { error: `mode must be one of ${MODES.join(", ")}` },
      { status: 400 },
    );
  }
  const result = await getDiff(ws.rootPath, path, mode);
  if (isGitError(result)) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: 500 });
  }
  return NextResponse.json(result);
}
