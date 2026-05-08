import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import {
  createWorkspace,
  listWorkspaces,
  type Icon,
} from "@/lib/server/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const workspaces = await listWorkspaces();
  return NextResponse.json({ workspaces });
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
  const root = body.rootPath.trim();
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
