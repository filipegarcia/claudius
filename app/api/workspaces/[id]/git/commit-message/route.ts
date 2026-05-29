import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { getDiffForCommit, isGitError } from "@/lib/server/git";
import { generateCommitMessage } from "@/lib/server/commit-message";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generation can take a while; let the platform run the route long enough
// for the model to finish.
export const maxDuration = 120;

type Body = { paths?: unknown };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Body;
  if (
    !Array.isArray(body.paths) ||
    !body.paths.every((p): p is string => typeof p === "string")
  ) {
    return NextResponse.json({ error: "paths must be string[]" }, { status: 400 });
  }
  const paths = body.paths as string[];
  if (paths.length === 0) {
    return NextResponse.json({ error: "no files selected" }, { status: 400 });
  }
  const diff = await getDiffForCommit(ws.rootPath, paths);
  if (isGitError(diff)) {
    return NextResponse.json({ error: diff.message, code: diff.code }, { status: 500 });
  }
  if (!diff.diff.trim()) {
    return NextResponse.json({ error: "no diff to summarise" }, { status: 400 });
  }
  const result = await generateCommitMessage(ws.rootPath, diff.diff);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ message: result.message });
}
