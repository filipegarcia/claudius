import { NextResponse } from "next/server";
import { backfillProject } from "@/lib/server/asset-ingest";
import { listAssets, type Scope, type TypeFilter } from "@/lib/server/asset-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") as Scope | null) ?? "project";
  const type = (url.searchParams.get("type") as TypeFilter | null) ?? "all";
  const q = url.searchParams.get("q") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "60") || 60;
  const cursor = url.searchParams.get("cursor");
  const cwd = url.searchParams.get("cwd") || process.cwd();
  const backfill = url.searchParams.get("backfill") === "1";
  if (backfill && scope === "project") {
    await backfillProject(cwd);
  }
  const result = await listAssets({
    scope,
    cwd,
    type,
    q,
    limit,
    cursor: cursor ? Number(cursor) : undefined,
  });
  return NextResponse.json(result);
}
