import { NextResponse } from "next/server";
import { basename, dirname } from "node:path";

import { isRunningInsideCustomizationMirror } from "@/lib/server/customizations-startup";
import { getLiveSourceDir } from "@/lib/server/runtime-dir";
import {
  customizationsRoot,
  getCustomization,
} from "@/lib/server/customizations-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tells the client which kind of Claudius is serving this page:
 *   - The "main" install where edits are isolated and Publish lives.
 *   - A preview spawned out of a customization mirror.
 *
 * The CustomizationBanner uses this to flip its copy / CTAs. Detection is
 * authoritative because it's derived from `process.cwd()` on the server,
 * not a guess from the browser URL.
 */
export async function GET() {
  const isPreview = isRunningInsideCustomizationMirror();
  if (!isPreview) {
    return NextResponse.json({ isPreview: false as const });
  }
  // Live source for a preview is `<customizations-root>/<id>/src/`. Walk up
  // one level to the customization id directory.
  const live = getLiveSourceDir();
  const idDir = dirname(live);
  const customizationId = basename(idDir);
  const root = customizationsRoot();
  // Only resolve the human name when the path actually sits under our
  // customizations root — defends against the env-var-override case where
  // someone might have CLAUDIUS_LIVE_SOURCE pointed elsewhere.
  let name: string | null = null;
  if (idDir.startsWith(root)) {
    const c = await getCustomization(customizationId).catch(() => null);
    name = c?.name ?? null;
  }
  return NextResponse.json({
    isPreview: true as const,
    customizationId,
    name,
  });
}
