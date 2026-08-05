import { NextResponse } from "next/server";
import { listWorktrees } from "@/lib/server/worktrees";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const worktrees = await listWorktrees(cwd);
  return NextResponse.json({ cwd, worktrees });
}
