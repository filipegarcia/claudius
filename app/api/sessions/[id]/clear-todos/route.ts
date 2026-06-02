import { NextResponse } from "next/server";
import { getOrResumeSession } from "@/lib/server/session-resume";

export const runtime = "nodejs";

/**
 * Manually clear the session's TodoWrite snapshot — the "this list is dead,
 * stop showing it" lever invoked by the Clear button on the chat-level
 * `TodosBanner` and the rail's To-dos section.
 *
 * Delegates to `Session.clearTodos("manual")`, which:
 *   - nulls the in-memory snapshot + sets the cutoff so a concurrent late
 *     `TodoWrite` tool_use doesn't sneak the old list back in;
 *   - persists `todosClearedAt` in the session JSON state bag so a server
 *     restart that rebuilds from disk JSONL doesn't resurrect the cleared
 *     entries (the seeded cutoff bounces every pre-clear entry);
 *   - broadcasts a `session_snapshot { todos: [] }` event so every live
 *     SSE subscriber (this tab + siblings) repaints empty immediately.
 *
 * Uses `getOrResumeSession` rather than `sessionManager.get` so a session
 * that was reaped between the user opening the tab and clicking Clear gets
 * rebuilt from disk on demand — same resilience pattern the SSE stream
 * route uses (otherwise the click silently 404s and looks broken).
 *
 * Method-existence guard handles the Next-dev-HMR edge case where an
 * in-memory Session instance was bound to a pre-edit `Session` prototype
 * (same pattern the stream route uses for `resyncFromDisk`): without the
 * guard, calling `session.clearTodos` on a stale instance throws
 * TypeError and the route 500s without a useful message.
 *
 * 404 unknown session id (no JSONL on disk to resume from).
 * 503 method unavailable on this instance — restart the dev server.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getOrResumeSession(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const maybeClear = (
    session as unknown as { clearTodos?: (reason?: string) => Promise<void> }
  ).clearTodos;
  if (typeof maybeClear !== "function") {
    return NextResponse.json(
      {
        error:
          "Session instance predates clearTodos — restart the dev server (or wait for this session to be reaped) so the new prototype takes effect.",
      },
      { status: 503 },
    );
  }
  await maybeClear.call(session, "manual");
  return NextResponse.json({ ok: true });
}
