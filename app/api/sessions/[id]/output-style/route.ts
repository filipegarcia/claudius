import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { STATIC_OUTPUT_STYLES } from "@/lib/shared/output-styles";

export const runtime = "nodejs";

/**
 * Session-scoped `/output-style` surface — CC 2.1.269 parity. See the doc
 * comment on `Session.setOutputStyle` / `Session.outputStyles` in
 * `lib/server/session.ts` for why this exists (Claudius already had the
 * setting; it just never live-applied or listed available styles).
 *
 * GET returns `{ current, available }`. When the session has an active SDK
 * query we ask it directly (`initializationResult()`), which can surface
 * plugin-provided custom styles the static fallback below doesn't know
 * about. Without a live query (session not started yet, reaped) we fall
 * back to the static list so the slash command's "no args" listing always
 * has *something* to show — same fallback strategy as `/api/models`.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const result = await session.outputStyles();
  if (result.ok) {
    const data = result.data as { output_style?: string; available_output_styles?: string[] };
    const available =
      Array.isArray(data.available_output_styles) && data.available_output_styles.length > 0
        ? data.available_output_styles
        : STATIC_OUTPUT_STYLES;
    return NextResponse.json({
      current: data.output_style ?? "default",
      available,
      source: "session",
    });
  }
  return NextResponse.json({
    current: "default",
    available: STATIC_OUTPUT_STYLES,
    source: "fallback",
  });
}

/**
 * PATCH `{ outputStyle: string }` — switch the style. Live-applies to the
 * running session's SDK query (best-effort) and persists to the "user"
 * settings scope so the pick is sticky for future sessions, mirroring
 * `/model`'s `persistModelToUserSettings` pattern.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { outputStyle?: string } | null;
  const name = body?.outputStyle?.trim();
  if (!name) {
    return NextResponse.json({ error: "outputStyle is required" }, { status: 400 });
  }

  const result = await session.setOutputStyle(name);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, outputStyle: result.outputStyle });
}
