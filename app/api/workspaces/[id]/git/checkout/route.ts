import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { checkoutBranch, isGitError } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { name?: unknown; create?: unknown; startPoint?: unknown };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Body;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name (string) required" }, { status: 400 });
  }
  const create = body.create === true;
  let startPoint: string | undefined;
  if (body.startPoint != null) {
    if (typeof body.startPoint !== "string") {
      return NextResponse.json({ error: "startPoint must be a string" }, { status: 400 });
    }
    startPoint = body.startPoint;
  }
  const result = await checkoutBranch(ws.rootPath, { name: body.name, create, startPoint });
  if (isGitError(result)) {
    // Git refusing to overwrite local changes lands here with "git-failed".
    // Surface its stderr to the UI so the user can see *why* the switch was
    // blocked (e.g. "Please commit your changes or stash them before you
    // switch branches").
    return NextResponse.json({ error: result.message, code: result.code }, { status: 400 });
  }
  return NextResponse.json(result);
}
