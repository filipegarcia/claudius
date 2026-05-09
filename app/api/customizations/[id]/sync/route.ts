import { NextResponse } from "next/server";

import { getCustomization } from "@/lib/server/customizations-store";
import { applySafeSync, computeSyncStatus } from "@/lib/server/customization-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const status = await computeSyncStatus(id);
    return NextResponse.json(status);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "sync status failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const result = await applySafeSync(id);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "sync failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
