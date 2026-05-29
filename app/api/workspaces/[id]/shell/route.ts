import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { execShellCommand } from "@/lib/server/shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run an arbitrary shell command in the workspace root. Powers the prompt
 * at the bottom of the /git page's console. See `execShellCommand` for the
 * security model (short version: local-only, single-user; same trust as a
 * normal terminal).
 *
 * Body: `{ command: string }`. The command is passed verbatim to
 * `bash -c`, so pipes / redirects / chaining / quoting all work.
 *
 * Always returns 200 once the child has settled — ordinary non-zero exits
 * are user-visible data, not errors. 4xx is reserved for routing problems
 * (missing workspace, empty body).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { command?: unknown };
  if (typeof body.command !== "string" || !body.command.trim()) {
    return NextResponse.json({ error: "command required" }, { status: 400 });
  }
  const result = await execShellCommand(ws.rootPath, body.command);
  return NextResponse.json(result);
}
