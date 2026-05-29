import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import {
  clearCommitDraft,
  getCommitDraft,
  setCommitDraft,
} from "@/lib/server/commit-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-workspace commit-message draft persistence.
 *
 * - GET    → `{ message }` if a draft exists, otherwise `{ message: null }`.
 * - POST   body `{ message: string }` → upsert (or delete on empty).
 * - DELETE → clear the draft (called after a successful commit).
 *
 * Keyed by the workspace's `rootPath` (cwd) — one draft per workspace.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const message = await getCommitDraft(ws.rootPath);
  return NextResponse.json({ message });
}

type PostBody = { message?: unknown };
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as PostBody;
  if (typeof body.message !== "string") {
    return NextResponse.json({ error: "message must be a string" }, { status: 400 });
  }
  await setCommitDraft(ws.rootPath, body.message);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  await clearCommitDraft(ws.rootPath);
  return NextResponse.json({ ok: true });
}
