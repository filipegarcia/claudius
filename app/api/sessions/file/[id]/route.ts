import { NextResponse } from "next/server";
import { remove } from "@/lib/server/sessions-store";

export const runtime = "nodejs";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  try {
    await remove(id, dir);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
