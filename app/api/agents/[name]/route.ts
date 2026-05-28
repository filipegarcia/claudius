import { NextResponse } from "next/server";
import { deleteAgent, type AgentScope } from "@/lib/server/agents";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

const SCOPES: AgentScope[] = ["user", "project"];

export async function DELETE(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") as AgentScope | null;
  const cwd = url.searchParams.get("cwd") || process.cwd();
  if (!scope || !SCOPES.includes(scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const ok = await deleteAgent(scope, cwd, name);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Reload live sessions in this cwd so the deletion takes effect without a
  // restart. Best-effort — never fails the delete.
  const reloaded = await sessionManager.reloadForCwd(cwd);
  return NextResponse.json({ ok: true, reloadedSessions: reloaded });
}
