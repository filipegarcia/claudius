import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Account-switcher surface for a single session.
 *
 * Background: a session is *pinned* to the account profile it was first
 * spawned under (see `Session.resolveAccountProfile`), so that being reaped
 * and resumed after the user switched accounts doesn't silently continue the
 * conversation under a different identity and bill. The pin is deliberately
 * escapable, because the switcher's motivating use case — "I hit my Max-plan
 * limit on A, flip to B" — wants existing sessions moved, not frozen.
 *
 * GET  → what account this session is running under, and whether that differs
 *        from the current global default.
 * POST → re-pin this session to the active profile and rebuild its query so
 *        the new credential actually takes effect.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  return NextResponse.json({
    // Null when no account profile is configured at all — the SDK is running
    // on the ambient environment and there's nothing to pin or move.
    account:
      session.accountProfileId && session.accountProfileLabel
        ? {
            id: session.accountProfileId,
            label: session.accountProfileLabel,
            ...(session.accountDriftFromActive
              ? { driftFromActive: session.accountDriftFromActive }
              : {}),
          }
        : null,
  });
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  // (1) Rewrite the persisted pin. This alone is enough for any FUTURE
  //     start of this session; it does not touch the running query.
  const moved = await session.moveToActiveAccount();
  if (!moved) {
    return NextResponse.json(
      { error: "no active account profile configured" },
      { status: 400 },
    );
  }

  // (2) Rebuild the query so the credential change applies now. The SDK
  //     reads env once at `query()` construction, so there is no in-place
  //     swap — see `SessionManager.restartInPlace`. The id is preserved, so
  //     the client's EventSource reconnects and replays rather than the user
  //     losing their tab.
  const restarted = await sessionManager.restartInPlace(id);

  return NextResponse.json({
    ok: true,
    account: { id: moved.id, label: moved.label },
    // false ⇒ the pin is saved but the live query wasn't rebuilt (session
    // was reaped between the two steps). It'll come up on the new account at
    // its next resume, so this is informational rather than an error.
    restarted: restarted.ok,
  });
}
