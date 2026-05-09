import { NextResponse } from "next/server";

import {
  getCustomization,
  listPublishes,
} from "@/lib/server/customizations-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  const publishes = await listPublishes(id);
  return NextResponse.json({ publishes });
}
