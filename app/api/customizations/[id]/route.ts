import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";

import {
  customizationDir,
  deleteCustomizationRecord,
  getCustomization,
  listPublishes,
  updateCustomizationRecord,
} from "@/lib/server/customizations-store";
import { stopPreview } from "@/lib/server/preview-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(c);
}

type PatchBody = { name?: string };

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: PatchBody = {};
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const patch: PatchBody = {};
  if (typeof body.name === "string") {
    const trimmed = body.name.trim();
    if (!trimmed) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    patch.name = trimmed;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }
  const updated = await updateCustomizationRecord(id, patch);
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Block deletion while a publish is active — the snapshot lives under the
  // customization dir, and removing it would strand the revert path. The
  // user must revert first (UI button or `make claudius-revert`).
  const publishes = await listPublishes(id);
  const active = publishes.filter((p) => p.revertedAt == null);
  if (active.length > 0) {
    return NextResponse.json(
      {
        error: `cannot delete: ${active.length} active publish${active.length === 1 ? "" : "es"}. Revert first.`,
      },
      { status: 409 },
    );
  }

  // Best-effort: stop any running preview, then drop the on-disk customization
  // tree. Failures past this point are non-fatal — the record itself is removed
  // regardless so a half-cleaned dir doesn't leave a phantom in the UI.
  // (Customizations are no longer backed by a workspace, so there's nothing to
  // cascade-delete; a stale active-customization cookie self-heals because
  // resolveActiveCustomization returns null once the record is gone.)
  try {
    await stopPreview(id);
  } catch {
    // ignore
  }
  try {
    await fs.rm(customizationDir(id), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[customizations] could not remove ${customizationDir(id)}:`, err);
  }
  await deleteCustomizationRecord(id);
  return NextResponse.json({ ok: true });
}
