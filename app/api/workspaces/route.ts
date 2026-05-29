import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import {
  createWorkspace,
  listWorkspaces,
  type Icon,
} from "@/lib/server/workspaces-store";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import { PathInjectionError, assertAbsoluteUserPath } from "@/lib/server/safe-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Include `activeId` so callers without access to the workspace-cookie
  // (e.g. Playwright's request context, which has its own cookie jar
  // separate from the page) can identify the active workspace via the
  // server-side resolver instead of guessing at the list order.
  const [workspaces, active] = await Promise.all([
    listWorkspaces(),
    resolveActiveWorkspace(),
  ]);
  return NextResponse.json({ workspaces, activeId: active?.id ?? null });
}

type CreateBody = {
  name?: string;
  rootPath?: string;
  icon?: Icon;
  defaults?: import("@/lib/server/workspaces-store").WorkspaceDefaults;
};

export async function POST(req: Request) {
  const body = (await req.json()) as CreateBody;
  if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!body?.rootPath?.trim()) return NextResponse.json({ error: "rootPath required" }, { status: 400 });
  // The user picks any directory on their machine as a workspace root —
  // there's no enclosing base we can validate against. `assertAbsoluteUserPath`
  // is the recognized barrier: it rejects relative paths and null bytes, then
  // hands back a normalized absolute path.
  let root: string;
  try {
    root = assertAbsoluteUserPath(body.rootPath.trim());
  } catch (err) {
    if (err instanceof PathInjectionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return NextResponse.json({ error: "rootPath is not a directory" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "rootPath does not exist" }, { status: 400 });
  }
  const ws = await createWorkspace({
    name: body.name.trim(),
    rootPath: root,
    icon: body.icon,
    defaults: body.defaults,
  });
  return NextResponse.json(ws, { status: 201 });
}
