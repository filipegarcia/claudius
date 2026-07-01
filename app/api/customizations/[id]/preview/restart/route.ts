import { NextResponse } from "next/server";

import { restartPreview } from "@/lib/server/preview-server";
import { getCustomization } from "@/lib/server/customizations-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Restart a customization's preview process. The banner's "Restart" button
 * POSTs here (previously a 404 — the button existed but the route didn't).
 * `restartPreview` stops any running preview, reaps orphaned Turbopack workers
 * holding the old port, then starts a fresh one — useful after "Sync from base"
 * or when the dev server gets wedged.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const state = await restartPreview(id);
    return NextResponse.json(state);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "restart failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
