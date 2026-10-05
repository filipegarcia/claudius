import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { customizationSrcDir, getCustomization } from "@/lib/server/customizations-store";
import { getOriginRemoteUrl } from "@/lib/server/git";
import { detectGitRemoteHost } from "@/lib/shared/git-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CC 2.1.259 — classify the workspace's `origin` remote by host so the
 * `/install-github-app` slash handler can show GitLab CI/CD docs in a GitLab
 * repo instead of opening the GitHub App page. `rootPath` comes from the
 * trusted workspace/customization registry (not a client-supplied path).
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
  const url = await getOriginRemoteUrl(rootPath);
  return NextResponse.json({ host: detectGitRemoteHost(url), url });
}
