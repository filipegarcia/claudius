import { NextResponse } from "next/server";

import { getCustomization } from "@/lib/server/customizations-store";
import { buildAvailability, getBuildState, startBuild } from "@/lib/server/customization-build";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Current build state + whether a local build is even possible here. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ availability: buildAvailability(), state: getBuildState(id) });
}

/** Kick off a build that bakes this customization's overlay into a new .app. */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  const avail = buildAvailability();
  if (!avail.available) {
    return NextResponse.json({ error: avail.reason ?? "local build unavailable" }, { status: 400 });
  }
  try {
    const state = await startBuild(id);
    return NextResponse.json(state);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "build failed to start";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
