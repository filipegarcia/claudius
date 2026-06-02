import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import {
  compareBranches,
  diffBranchAgainstWorktree,
  isGitError,
} from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Two modes selected via the `mode` query param:
 *   - mode=log   (default): `compareBranches` — ahead/behind commit lists +
 *                            file-level diffstat (read-only console dump)
 *   - mode=diff:            `diff <head>` vs. working tree — raw unified diff
 *
 * Both return `{ ok: true, output: string }` on success. The git page pipes
 * the string into the GitConsole — we don't render a bespoke comparison
 * pane on purpose; the console is the codebase's home for read-only git output.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "log";
  const head = url.searchParams.get("head");
  if (!head) {
    return NextResponse.json({ error: "head (string) required" }, { status: 400 });
  }
  if (mode === "diff") {
    const result = await diffBranchAgainstWorktree(ws.rootPath, head);
    if (isGitError(result)) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: 400 });
    }
    return NextResponse.json(result);
  }
  const base = url.searchParams.get("base");
  if (!base) {
    return NextResponse.json({ error: "base (string) required" }, { status: 400 });
  }
  const result = await compareBranches(ws.rootPath, base, head);
  if (isGitError(result)) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: 400 });
  }
  return NextResponse.json(result);
}
