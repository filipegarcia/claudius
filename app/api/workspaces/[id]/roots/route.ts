import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { listWorkspaceRoots } from "@/lib/server/workspace-roots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — list every root directory the Files browser should show for this
 * workspace: the workspace cwd plus each `additionalDirectories` entry
 * (workspace defaults + project-scope `settings.json`, deduped).
 *
 * The client uses the returned ids verbatim as the `?root=` selector on the
 * files / reveal endpoints — the server is the source of truth for which
 * indices map to which absolute paths, so a stale id from a removed dir 404s
 * rather than reaching `fs.*` with a forged base.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const roots = await listWorkspaceRoots(ws);
  return NextResponse.json({ roots });
}
