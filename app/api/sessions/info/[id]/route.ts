import { NextResponse } from "next/server";
import { info } from "@/lib/server/sessions-store";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  const meta = await info(id, dir);
  if (!meta) return NextResponse.json({ error: "session not found" }, { status: 404 });
  return NextResponse.json(meta);
}
