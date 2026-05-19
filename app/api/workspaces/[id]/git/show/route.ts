import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { gitShow, isGitError } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read a file's content at a specific git revision. Powers the "old" pane
 * of the side-by-side diff view on /git.
 *
 * Query params:
 *   - `path` — workspace-relative path
 *   - `ref`  — git revision. `"HEAD"` for the committed version, `""`
 *              (empty string) for the index version. Passed through to
 *              `git show <ref>:<path>`.
 *
 * Returns `{ content: string }`. The content is the empty string when the
 * file doesn't exist at that revision (e.g. newly added file vs HEAD) —
 * the UI uses that as "render the left pane blank" rather than as an
 * error condition.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const ref = url.searchParams.get("ref");
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  if (ref == null) return NextResponse.json({ error: "ref required" }, { status: 400 });
  // Reject obvious traversal — git would also catch this, but a 400 with a
  // clear message beats a 500 with git's stderr.
  if (path.startsWith("..") || path.includes("\0")) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  const result = await gitShow(ws.rootPath, ref, path);
  if (isGitError(result)) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: 500 });
  }
  return NextResponse.json(result);
}
