import { NextResponse } from "next/server";
import { list } from "@/lib/server/sessions-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") || undefined;
  const limit = Number(url.searchParams.get("limit") || "200") || 200;
  try {
    const sessions = await list({ dir, limit });
    return NextResponse.json({ sessions });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
