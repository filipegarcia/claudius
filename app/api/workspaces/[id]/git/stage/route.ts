import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { stagePaths, isGitError, type StageOp } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPS: StageOp[] = ["stage", "unstage", "discard"];

type Body = { paths?: unknown; op?: unknown };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Body;
  const op = body.op;
  if (typeof op !== "string" || !OPS.includes(op as StageOp)) {
    return NextResponse.json({ error: `op must be one of ${OPS.join(", ")}` }, { status: 400 });
  }
  if (!Array.isArray(body.paths) || !body.paths.every((p): p is string => typeof p === "string")) {
    return NextResponse.json({ error: "paths must be string[]" }, { status: 400 });
  }
  // Reject obvious traversal — `git` itself is bounded by the repo root, but
  // paths starting with .. are malformed anyway.
  if (body.paths.some((p) => p.startsWith("..") || p.includes("\0"))) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  const result = await stagePaths(ws.rootPath, body.paths as string[], op as StageOp);
  if (isGitError(result)) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: 500 });
  }
  return NextResponse.json(result);
}
