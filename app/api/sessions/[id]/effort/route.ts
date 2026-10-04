import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Set the reasoning-effort level for the active session.
 *
 * The right SDK surface for effort is `Query.applyFlagSettings`, not a
 * slash command — the `/effort` command doesn't exist in the SDK
 * environment and the input pipeline answers any call with
 * "isn't available in this environment". Mirroring the shape of
 * `/api/sessions/[id]/model` keeps the model and effort controls
 * symmetric and lets the picker post both through dedicated routes.
 *
 * `level: "auto"` clears the flag-settings override so the model returns
 * to adaptive thinking. Any other value is forwarded verbatim — we trust
 * the SDK to reject levels the active model doesn't support rather than
 * pre-validating here and falling out of sync when the SDK adds levels.
 */
const LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "auto"]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body = (await req.json()) as { level?: string; ultracode?: boolean; sessionOnly?: boolean };
  if (!body?.level || !LEVELS.has(body.level)) {
    return NextResponse.json({ error: "invalid effort level" }, { status: 400 });
  }
  // CC 2.1.284 — keep ultracode on across an effort change (send both keys).
  // CC 2.1.257 — `sessionOnly` applies the level live without persisting it.
  await session.setEffort(
    body.level as "low" | "medium" | "high" | "xhigh" | "max" | "auto",
    body.ultracode === true,
    body.sessionOnly === true,
  );
  return NextResponse.json({ ok: true, level: body.level });
}
