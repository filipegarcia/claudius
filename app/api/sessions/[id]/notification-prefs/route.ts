import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { info as sessionFileInfo } from "@/lib/server/sessions-store";
import {
  getSessionPrefs,
  setSessionPrefs,
} from "@/lib/server/notifications-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  blocked?: boolean;
  /**
   * Minutes from now to snooze. Pass `null` to clear an existing snooze.
   * Pass `undefined` (omit) to leave the snooze unchanged.
   */
  snoozeMinutes?: number | null;
};

/**
 * Resolve the cwd backing a session id. Prefers the in-memory session
 * (always accurate), falls back to the SDK's session file index so prefs
 * can be edited for a session that has been reaped but still exists on
 * disk (typical after the 10-minute idle window).
 */
async function resolveCwd(sessionId: string): Promise<string | null> {
  const live = sessionManager.get(sessionId);
  if (live) return live.cwd;
  try {
    const info = await sessionFileInfo(sessionId);
    return info?.cwd ?? null;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cwd = await resolveCwd(id);
  if (!cwd) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const prefs = await getSessionPrefs(cwd, id);
  return NextResponse.json(
    prefs ?? { sessionId: id, blocked: false, snoozeUntil: null },
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Body;
  const cwd = await resolveCwd(id);
  if (!cwd) return NextResponse.json({ error: "session not found" }, { status: 404 });

  const patch: { blocked?: boolean; snoozeUntil?: number | null } = {};
  if (typeof body.blocked === "boolean") patch.blocked = body.blocked;
  if (body.snoozeMinutes !== undefined) {
    if (body.snoozeMinutes == null) {
      patch.snoozeUntil = null;
    } else if (Number.isFinite(body.snoozeMinutes) && body.snoozeMinutes > 0) {
      patch.snoozeUntil = Date.now() + Math.floor(body.snoozeMinutes) * 60_000;
    } else {
      return NextResponse.json({ error: "invalid snoozeMinutes" }, { status: 400 });
    }
  }
  const next = await setSessionPrefs(cwd, id, patch);
  return NextResponse.json(next);
}
