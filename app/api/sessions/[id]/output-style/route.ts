import { NextResponse } from "next/server";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { sessionManager } from "@/lib/server/session-manager";
import { STATIC_OUTPUT_STYLES } from "@/lib/shared/output-styles";

export const runtime = "nodejs";

/**
 * Session-scoped `/output-style` surface — CC 2.1.269 parity. See the doc
 * comment on `Session.setOutputStyle` in `lib/server/session.ts` for why
 * this exists (Claudius already had the setting; it just never live-applied
 * or listed available styles).
 *
 * GET returns `{ current, available }`. When the session has an active SDK
 * query we ask it directly (`initializationResult()`), which can surface
 * plugin-provided custom styles the static fallback below doesn't know
 * about. Without a live query (session not started yet, reaped) we fall
 * back to the static list so the slash command's "no args" listing always
 * has *something* to show — same fallback strategy as `/api/models`.
 *
 * Reads `session.query` directly instead of going through a wrapper method
 * on `Session` — deliberate, same reasoning as `/api/sessions/[id]/model`'s
 * GET (see its doc comment): `query` is an instance field assigned in
 * `Session.start()` and survives Next.js Fast Refresh, but a wrapper
 * *method* lives on the prototype and goes missing from pre-existing
 * instances after HMR replaces the class — `model-picker-route.test.ts` is
 * the regression test for exactly that trap. PATCH below uses a wrapper
 * (`session.setOutputStyle`) because a write that fails under HMR is a
 * visible, recoverable one-shot error, not a permanently-broken read.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const query = (session as unknown as { query: Query | null }).query;
  if (query) {
    try {
      const data = (await query.initializationResult()) as {
        output_style?: string;
        available_output_styles?: string[];
      };
      const available =
        Array.isArray(data.available_output_styles) && data.available_output_styles.length > 0
          ? data.available_output_styles
          : STATIC_OUTPUT_STYLES;
      return NextResponse.json({
        current: data.output_style ?? "default",
        available,
        source: "session",
      });
    } catch (err) {
      console.error("[api/sessions/output-style] GET failed", err);
      // Fall through to the static fallback below.
    }
  }
  return NextResponse.json({
    current: "default",
    available: STATIC_OUTPUT_STYLES,
    source: "fallback",
  });
}

/**
 * PATCH `{ outputStyle: string }` — switch the style. Live-applies to the
 * running session's SDK query (best-effort) and persists to the `local`
 * settings scope (`.claude/settings.local.json`) — the exact file the
 * SDK's own `updateSettings('localSettings', …)` writer targets, so the
 * two writes agree instead of leaving the pick shadowed by a stale value
 * in a different settings file. See `Session.setOutputStyle`'s doc comment.
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
