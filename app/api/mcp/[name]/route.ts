import { NextResponse } from "next/server";
import { removeServer, type McpScope } from "@/lib/server/mcp";

export const runtime = "nodejs";

const SCOPES: McpScope[] = ["user", "project", "local"];

export async function DELETE(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") as McpScope | null;
  const cwd = url.searchParams.get("cwd") || process.cwd();
  if (!scope || !SCOPES.includes(scope))
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  const ok = await removeServer(scope, cwd, name);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
