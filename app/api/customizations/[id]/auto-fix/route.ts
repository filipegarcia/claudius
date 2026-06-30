import { NextResponse } from "next/server";
import { getCustomization } from "@/lib/server/customizations-store";
import { computeSyncStatus } from "@/lib/server/customization-sync";
import { getSettings } from "@/lib/server/customize-settings";

export const runtime = "nodejs";

/**
 * Returns a fully-substituted prompt for auto-fixing the customization's
 * current set of conflicts. The frontend makes the customization the active
 * context and routes the user to its chat with this prompt prefilled.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cust = await getCustomization(id);
  if (!cust) return NextResponse.json({ error: "customization not found" }, { status: 404 });

  const status = await computeSyncStatus(id);
  const conflictPaths = status.entries
    .filter((e) => e.verdict === "conflict")
    .map((e) => e.path);

  if (conflictPaths.length === 0) {
    return NextResponse.json(
      { error: "no conflicts to fix" },
      { status: 400 },
    );
  }

  const settings = await getSettings();
  const composed = settings.autoFixPrompt
    .replaceAll("{{conflict_count}}", String(conflictPaths.length))
    .replaceAll(
      "{{conflict_paths}}",
      conflictPaths.map((p) => `  - ${p}`).join("\n"),
    );

  return NextResponse.json({
    prompt: composed,
    conflictCount: conflictPaths.length,
  });
}
