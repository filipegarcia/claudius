import { NextResponse } from "next/server";
import { listFs } from "@/lib/server/fs-list";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const q = url.searchParams.get("q") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "200") || 200;
  try {
    const entries = await listFs({ cwd, query: q, limit });
    return NextResponse.json({ cwd, entries });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
