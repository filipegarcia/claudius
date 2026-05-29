import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { gitRemote, isGitError, type RemoteOp } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPS: RemoteOp[] = ["fetch", "pull", "push"];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { op?: unknown };
  if (typeof body.op !== "string" || !OPS.includes(body.op as RemoteOp)) {
    return NextResponse.json({ error: `op must be one of ${OPS.join(", ")}` }, { status: 400 });
  }
  const result = await gitRemote(ws.rootPath, body.op as RemoteOp);
  if (isGitError(result)) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: 500 });
  }
  return NextResponse.json(result);
}
