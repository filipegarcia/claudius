import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Toggle "ultracode" (Dynamic Workflows) for the active session.
 *
 * Mirrors `/api/sessions/[id]/effort`: the right SDK surface is
 * `Query.applyFlagSettings({ ultracode })`, not a slash command. Ultracode
 * runs the session at xhigh effort plus dynamic-workflow orchestration
 * (Opus 4.8 — the model plans, then fans out parallel subagents). The SDK
 * requires the Workflows feature enabled (plan-gated) and an xhigh-capable
 * model; we forward verbatim and trust the SDK to no-op when those
 * preconditions aren't met rather than pre-validating here.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body = (await req.json()) as { enabled?: unknown };
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json(
      { error: "invalid 'enabled' (boolean required)" },
      { status: 400 },
    );
  }
  await session.setUltracode(body.enabled);
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
