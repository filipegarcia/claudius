import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Toggle "fast mode" for the active session.
 *
 * Mirrors `/api/sessions/[id]/ultracode`: the right SDK surface is
 * `Query.applyFlagSettings({ fastMode })`, not a slash command. Fast mode is
 * an accelerated-decoding flag on supported models (Opus 4.8 — the
 * cheat-sheet binding is `Option+O` / `/fast`); it's orthogonal to effort and
 * does NOT force xhigh the way ultracode does. Session-scoped with no DB
 * persistence: it resets to off after a reap → resume, same as effort and
 * ultracode. We forward verbatim and trust the SDK to no-op when the model
 * doesn't support fast mode rather than pre-validating here (the picker only
 * offers the toggle on `supportsFastMode` models).
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
  await session.setFast(body.enabled);
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
