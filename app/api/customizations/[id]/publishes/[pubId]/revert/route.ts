import { NextResponse } from "next/server";

import {
  getCustomization,
  listPublishes,
} from "@/lib/server/customizations-store";
import { revertPublish } from "@/lib/server/customization-revert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; pubId: string }> },
) {
  const { id, pubId } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "customization not found" }, { status: 404 });
  const all = await listPublishes(id);
  const p = all.find((x) => x.id === pubId);
  if (!p) return NextResponse.json({ error: "publish not found" }, { status: 404 });
  if (p.revertedAt != null) {
    return NextResponse.json({ ok: true, alreadyReverted: true });
  }
  try {
    const { stdout, stderr } = await revertPublish(pubId);
    return NextResponse.json({ ok: true, stdout, stderr });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "revert failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
