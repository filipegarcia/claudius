import { NextResponse } from "next/server";
import { listUses } from "@/lib/server/asset-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const uses = await listUses(cwd, hash);
  return NextResponse.json({ uses });
}
