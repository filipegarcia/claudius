import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";

export const runtime = "nodejs";

/**
 * Set, replace, or clear the session goal (see `/goal`, GoalBanner).
 *
 * Body: `{ goal: string }` to set/replace, `{ goal: null }` (or empty/missing)
 * to clear. Setting a goal resets any prior achievement. The resolved goal
 * state is also pushed to every open tab over SSE via the `goal_changed`
 * event broadcast inside `setGoal`/`clearGoal`, so this response is mainly
 * for the caller's optimistic update + error surfacing.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { goal?: string | null };
  const text = typeof body?.goal === "string" ? body.goal.trim() : "";
  const goal = text ? await session.setGoal(text) : await session.clearGoal();
  return NextResponse.json({ ok: true, goal });
}
