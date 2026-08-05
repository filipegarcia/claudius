import { NextResponse } from "next/server";
import { listUses } from "@/lib/server/asset-list";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const url = new URL(req.url);
  const cwd = await resolveTrustedCwd(url.searchParams.get("cwd"));
  if (!cwd) return NextResponse.json({ error: "unknown cwd" }, { status: 400 });
  const uses = await listUses(cwd, hash);
  return NextResponse.json({ uses });
}
