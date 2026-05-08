import { NextResponse } from "next/server";
import { messages } from "@/lib/server/sessions-store";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  const includeSystem = url.searchParams.get("system") !== "0";
  try {
    const list = await messages(id, dir, includeSystem);
    return NextResponse.json({ messages: list });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
