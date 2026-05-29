import { NextResponse } from "next/server";

import { getCustomization } from "@/lib/server/customizations-store";
import { publishCustomization } from "@/lib/server/customization-publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const rec = await publishCustomization(id);
    return NextResponse.json(rec, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "publish failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
