import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { customizationSrcDir, getCustomization } from "@/lib/server/customizations-store";
import { getStatus, isGitError } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Customizations aren't workspaces; the Git pane passes the `cust_<id>` id.
  // Resolve its mirror dir directly and run the same git status.
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
  const result = await getStatus(rootPath);
  if (isGitError(result)) {
    if (result.code === "not-a-repo") {
      return NextResponse.json({ isRepo: false, files: [] });
    }
    return NextResponse.json({ error: result.message, code: result.code }, { status: 500 });
  }
  return NextResponse.json(result);
}
