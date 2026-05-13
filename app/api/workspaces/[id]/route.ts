import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import {
  deleteWorkspace,
  getWorkspace,
  updateWorkspace,
  type Icon,
  type WorkspaceDefaults,
} from "@/lib/server/workspaces-store";
import type { CommitPrefixConfig } from "@/lib/shared/commit-prefix";
import { clearActiveCookie, readActiveCookie } from "@/lib/server/active-workspace";
import { PathInjectionError, assertAbsoluteUserPath } from "@/lib/server/safe-path";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(ws);
}

type Patch = Partial<{
  name: string;
  rootPath: string;
  icon: Icon;
  defaults: WorkspaceDefaults;
  commitPrefix: CommitPrefixConfig;
}>;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as Patch;
  if (typeof body.rootPath === "string") {
    // assertAbsoluteUserPath is the recognized barrier for "user chooses any
    // directory on their machine": rejects relative paths / null bytes, then
    // hands back a normalized absolute path that flows on into fs.stat.
    try {
      body.rootPath = assertAbsoluteUserPath(body.rootPath);
    } catch (err) {
      if (err instanceof PathInjectionError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
    try {
      const stat = await fs.stat(body.rootPath);
      if (!stat.isDirectory()) return NextResponse.json({ error: "rootPath not a directory" }, { status: 400 });
    } catch {
      return NextResponse.json({ error: "rootPath does not exist" }, { status: 400 });
    }
  }
  const ws = await updateWorkspace(id, body);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(ws);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteWorkspace(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  // If the deleted workspace was active, clear the cookie.
  if ((await readActiveCookie()) === id) await clearActiveCookie();
  return NextResponse.json({ ok: true });
}
