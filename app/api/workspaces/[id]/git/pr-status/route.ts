import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { customizationSrcDir, getCustomization } from "@/lib/server/customizations-store";
import { getPrStatus } from "@/lib/server/pr-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CC 2.1.234 (H7) — the current branch's PR (GitHub) / MR (GitLab) badge, via
 * `gh` / `glab`. `rootPath` comes from the trusted workspace/customization
 * registry (not a client-supplied path). `{ badge: null }` when there's no
 * open PR/MR, the CLI is missing/unauthenticated, or the remote isn't a
 * recognized host — the UI then shows nothing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let rootPath: string;
  if (id.startsWith("cust_")) {
    const cust = await getCustomization(id).catch(() => null);
    if (!cust) return NextResponse.json({ error: "customization not found" }, { status: 404 });
    rootPath = customizationSrcDir(id);
  } else {
    const ws = await getWorkspace(id);
    if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
    rootPath = ws.rootPath;
  }
  const badge = await getPrStatus(rootPath);
  return NextResponse.json({ badge });
}
