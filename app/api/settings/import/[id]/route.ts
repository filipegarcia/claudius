import { NextResponse } from "next/server";

import { cancelImport, getImportProgress } from "@/lib/server/settings-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET  /api/settings/import/:id` — re-fetch current progress (useful when
 * the heal dialog mounts after a page refresh and just has the session id
 * in URL state).
 *
 * `DELETE /api/settings/import/:id` — discard the session file. The
 * partial state stays — we don't roll back already-applied steps. Used by
 * the heal dialog's "Cancel import" button.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const progress = await getImportProgress(id);
  if (!progress) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(progress);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await cancelImport(id);
  return NextResponse.json({ ok: true });
}
