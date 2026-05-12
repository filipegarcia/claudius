import { NextResponse } from "next/server";

import {
  getCustomization,
  setCustomizationDescription,
  setCustomizationDescriptionManual,
} from "@/lib/server/customizations-store";
import {
  describeCustomization,
  diffHashFor,
} from "@/lib/server/customization-description";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ResponseShape = {
  description: string | null;
  descriptionGeneratedAt: number | null;
  descriptionDiffHash: string | null;
  descriptionIsManual: boolean;
  currentDiffHash: string;
  stale: boolean;
};

async function buildResponse(id: string): Promise<ResponseShape | null> {
  const c = await getCustomization(id);
  if (!c) return null;
  // `currentHash` is only consumed to compute `stale`, and `stale` can only
  // be true when (a) the description is generated (not manual), (b) it's
  // non-empty, and (c) we have a baseline `descriptionDiffHash` to compare
  // against. Skipping diffHashFor() in every other case avoids an O(N) walk
  // over the customization src tree — computeSyncStatus() hashes every file
  // and runs to 4+ minutes on slow CI runners, blocking the dev-server
  // request loop. Manual descriptions in particular never go stale on their
  // own, so the user owns the text until they explicitly hit Regenerate.
  const needsCurrentHash =
    !c.descriptionIsManual && !!c.description && !!c.descriptionDiffHash;
  let currentHash = "";
  if (needsCurrentHash) {
    try {
      currentHash = await diffHashFor(id);
    } catch {
      // diff failed (corrupt customization, missing src dir) — treat as no diff.
    }
  }
  const stale =
    needsCurrentHash && currentHash !== "" && c.descriptionDiffHash !== currentHash;
  return {
    description: c.description ?? null,
    descriptionGeneratedAt: c.descriptionGeneratedAt ?? null,
    descriptionDiffHash: c.descriptionDiffHash ?? null,
    descriptionIsManual: !!c.descriptionIsManual,
    currentDiffHash: currentHash,
    stale,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await buildResponse(id);
  if (!body) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(body);
}

/**
 * Regenerate the description by re-reading the user-edited diff and the
 * workspace's chat history, calling the agent SDK once, and persisting.
 * Resets the manual flag — the LLM owns the text again until the user
 * edits.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = await describeCustomization(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }
  const updated = await setCustomizationDescription(id, result.description, result.diffHash);
  if (!updated) {
    return NextResponse.json({ error: "failed to persist" }, { status: 500 });
  }
  const body = await buildResponse(id);
  return NextResponse.json(body!);
}

/**
 * User-typed description. Empty string clears the description.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCustomization(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  let payload: { description?: unknown };
  try {
    payload = (await req.json()) as { description?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof payload.description !== "string") {
    return NextResponse.json({ error: "description must be a string" }, { status: 400 });
  }
  const updated = await setCustomizationDescriptionManual(id, payload.description);
  if (!updated) {
    return NextResponse.json({ error: "failed to persist" }, { status: 500 });
  }
  const body = await buildResponse(id);
  return NextResponse.json(body!);
}
