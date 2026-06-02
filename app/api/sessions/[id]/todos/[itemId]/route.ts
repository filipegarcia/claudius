import { NextResponse } from "next/server";
import { getOrResumeSession } from "@/lib/server/session-resume";

export const runtime = "nodejs";

/**
 * Mutate a single to-do item in the session's snapshot. Routed from the
 * chat-level `TodosBanner` (clickable status icon + × delete button) and
 * the rail's To-dos widget — the "I'll handle this one myself, the model
 * never engaged with it" lever.
 *
 * Body: `{ "action": "complete" | "reopen" | "in_progress" | "delete" }`
 *
 * Delegates to `Session.updateTodoItem(itemId, action)`, which:
 *   - mutates `latestTodosSnapshot` in place (status flip or filter for
 *     `delete`) and bumps the cutoff so a racing pre-update TodoWrite /
 *     TaskCreate replay can't undo it;
 *   - persists the mutation as a `manualTodoOverrides[itemId]` entry in
 *     the session JSON state bag so a server restart that rebuilds from
 *     disk JSONL re-applies the user's edit on top of the replayed
 *     transcript;
 *   - broadcasts a `session_snapshot` event so every live SSE subscriber
 *     (this tab + siblings) repaints with the new state immediately.
 *
 * Uses `getOrResumeSession` (same as the sibling `clear-todos` route) so
 * a session reaped between tab-open and click gets rebuilt from disk on
 * demand. Method-existence guard handles the Next-dev-HMR edge where an
 * in-memory Session instance predates the new method.
 *
 * Status codes:
 *   - 200 ok — mutation applied and broadcast.
 *   - 400 invalid body (missing or unknown action) / invalid item id.
 *   - 404 unknown session id.
 *   - 422 valid request but unprocessable: snapshot empty (user already
 *     cleared) or item id not present in current snapshot. Distinct from
 *     400 so the client can show "list already changed, refresh" rather
 *     than "your request was malformed."
 *   - 503 method unavailable on this in-memory Session instance —
 *     restart the dev server (or wait for this session to be reaped) so
 *     the new prototype takes effect.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await ctx.params;
  if (!itemId) {
    return NextResponse.json({ error: "missing item id" }, { status: 400 });
  }
  let body: { action?: unknown } = {};
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = body.action;
  if (
    action !== "complete" &&
    action !== "reopen" &&
    action !== "in_progress" &&
    action !== "delete"
  ) {
    return NextResponse.json(
      { error: "action must be one of: complete, reopen, in_progress, delete" },
      { status: 400 },
    );
  }
  const session = await getOrResumeSession(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const maybeUpdate = (
    session as unknown as {
      updateTodoItem?: (
        itemId: string,
        action: "complete" | "reopen" | "in_progress" | "delete",
      ) => Promise<{ ok: true } | { ok: false; error: string }>;
    }
  ).updateTodoItem;
  if (typeof maybeUpdate !== "function") {
    return NextResponse.json(
      {
        error:
          "Session instance predates updateTodoItem — restart the dev server (or wait for this session to be reaped) so the new prototype takes effect.",
      },
      { status: 503 },
    );
  }
  const result = await maybeUpdate.call(session, itemId, action);
  if (!result.ok) {
    // "no active todo list" and "item not found" are 422 (request fine,
    // current state can't satisfy it); other internal errors fall back to
    // 500 so they're visible.
    const status =
      result.error === "no active todo list" || result.error === "item not found"
        ? 422
        : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
