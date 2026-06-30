import { NextResponse } from "next/server";
import { getCustomization } from "@/lib/server/customizations-store";
import {
  clearActiveCustomizationCookie,
  writeActiveCustomizationCookie,
} from "@/lib/server/active-customization";

export const runtime = "nodejs";

/**
 * Make a customization the active context (parallel to the workspace select).
 * Writes the `claudius.customization` cookie, which also clears the workspace
 * cookie (mutual exclusion) so chat/git/files/sessions resolve against the
 * customization's mirror.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cust = await getCustomization(id);
  if (!cust) {
    await clearActiveCustomizationCookie();
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await writeActiveCustomizationCookie(id);
  return NextResponse.json({ ok: true, id });
}
