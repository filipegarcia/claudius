import { NextResponse } from "next/server";
import { listWorktrees } from "@/lib/server/worktrees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const worktrees = await listWorktrees(cwd);
  return NextResponse.json({ cwd, worktrees });
}
