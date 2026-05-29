import { NextResponse } from "next/server";

import {
  getPreviewState,
  startPreview,
  stopPreview,
} from "@/lib/server/preview-server";
import { getCustomization } from "@/lib/server/customizations-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function ensureExists(id: string): Promise<NextResponse | null> {
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  return null;
}

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const err = await ensureExists(id);
  if (err) return err;
  return NextResponse.json(getPreviewState(id));
}

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const err = await ensureExists(id);
  if (err) return err;
  try {
    const state = await startPreview(id);
    return NextResponse.json(state);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "start failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const err = await ensureExists(id);
  if (err) return err;
  const state = await stopPreview(id);
  return NextResponse.json(state);
}
