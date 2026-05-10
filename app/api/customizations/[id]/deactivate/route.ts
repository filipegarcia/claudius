import { NextResponse } from "next/server";

import {
  getCustomization,
  listPublishes,
} from "@/lib/server/customizations-store";
import { revertPublish } from "@/lib/server/customization-revert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Revert every un-reverted publish for this customization. Goes through the
 * same `bin/claudius-revert` path as the per-publish UI revert button, so
 * snapshots are restored bit-for-bit and the index records each as reverted.
 *
 * Order: newest first. If a revert fails partway through, the prior ones
 * still apply — the user sees the partial result and can retry.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  const publishes = await listPublishes(id);
  const active = publishes
    .filter((p) => p.revertedAt == null)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  if (active.length === 0) {
    return NextResponse.json({ ok: true, reverted: 0, alreadyInactive: true });
  }

  let reverted = 0;
  const errors: { publishId: string; error: string }[] = [];
  for (const p of active) {
    try {
      await revertPublish(p.id);
      reverted++;
    } catch (e) {
      errors.push({ publishId: p.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (errors.length > 0) {
    return NextResponse.json(
      { ok: reverted > 0, reverted, errors },
      { status: 207 }, // multi-status
    );
  }
  return NextResponse.json({ ok: true, reverted });
}
