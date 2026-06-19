import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { info as sessionFileInfo } from "@/lib/server/sessions-store";
import { getSessionState, mergeSessionState } from "@/lib/server/sessions-db";
import { isPromptColorName } from "@/lib/shared/prompt-colors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Key under which the per-session prompt color name lives in `sessions.state`. */
const STATE_KEY = "promptColor";

type Body = {
  /** A named color (see PROMPT_COLORS), or `null` to clear back to the theme default. */
  color?: string | null;
};

/**
 * Resolve the cwd backing a session id. Prefers the in-memory session, falls
 * back to the SDK's on-disk session index so the color can still be read/written
 * for a session that has been reaped but exists on disk. Mirrors the
 * notification-prefs route.
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

function readColor(state: Record<string, unknown>): string | null {
  const raw = state[STATE_KEY];
  return typeof raw === "string" && isPromptColorName(raw) ? raw : null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cwd = await resolveCwd(id);
  if (!cwd) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const state = await getSessionState(cwd, id);
  return NextResponse.json({ sessionId: id, color: readColor(state) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Body;
  const cwd = await resolveCwd(id);
  if (!cwd) return NextResponse.json({ error: "session not found" }, { status: 404 });

  // `null` clears the color; a string must be a known palette name.
  if (body.color !== null && (typeof body.color !== "string" || !isPromptColorName(body.color))) {
    return NextResponse.json({ error: "invalid color" }, { status: 400 });
  }

  await mergeSessionState(cwd, id, { [STATE_KEY]: body.color });
  return NextResponse.json({ sessionId: id, color: body.color });
}
