import { NextResponse } from "next/server";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { deadSessionResponse, sessionManager } from "@/lib/server/session-manager";
import { REWIND_ROUTE_TIMEOUT_MS, TIMED_OUT, rewindTimeoutMessage, withTimeout } from "@/lib/shared/rewind-timeout";

export const runtime = "nodejs";

/**
 * Rewind the working tree to its state at a given user message, using the
 * SDK's file-checkpointing (enabled via `Options.enableFileCheckpointing` in
 * Session.start()).
 *
 * Body: `{ userMessageId: string, dryRun?: boolean }`.
 * - `dryRun: true` reports what *would* change (filesChanged / insertions /
 *   deletions) without touching disk — the client previews this before the
 *   user confirms.
 * - `dryRun: false` (or omitted) performs the rewind.
 *
 * The SDK's `RewindFilesResult` is returned as `result`. A `canRewind: false`
 * outcome (unknown message id, no checkpoint) is a normal 200 response with
 * `result.error` set, not an HTTP error — only an inactive session (503), a
 * thrown SDK error (503) or no answer from the process in time (504) map to
 * non-200.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    // Validate before any restart below, so a malformed (or cross-origin)
    // POST can't spawn an SDK child just to be told 400.
    const body = (await req.json()) as { userMessageId?: string; dryRun?: boolean };
    const userMessageId = body?.userMessageId;
    if (!userMessageId || typeof userMessageId !== "string") {
      return NextResponse.json({ error: "userMessageId required" }, { status: 400 });
    }

    // CC 2.1.331 — "Fixed Rewind showing 'No active session' after Claude's
    // process had ended". The dead process's `query` can't answer the
    // control request, so the restore failed with a raw transport error.
    // Restart a dead session first, as the input route does (the rebuilt one
    // resumes the transcript, checkpoints included), then rewind on it.
    const live = await sessionManager.restartIfDead(id);
    if (!live.ok) {
      const { error, status } = deadSessionResponse(live);
      return NextResponse.json({ error }, { status });
    }

    // Read the SDK `Query` instance field directly rather than the Session
    // wrapper method — instance fields survive Next.js Fast Refresh whereas
    // prototype methods don't (same rationale as the model/agents routes).
    const query = (live.session as unknown as { query: Query | null }).query;
    if (!query) {
      return NextResponse.json({ error: "session not active" }, { status: 503 });
    }

    // CC 2.1.332 — "Fixed Rewind staying on 'Checking code changes…' while
    // Claude's process hung at its start". A process that exists but never
    // answers left this await (and the button's spinner) hanging forever.
    const dryRun = body?.dryRun === true;
    const result = await withTimeout(query.rewindFiles(userMessageId, { dryRun }), REWIND_ROUTE_TIMEOUT_MS);
    if (result === TIMED_OUT) {
      return NextResponse.json({ error: rewindTimeoutMessage(dryRun) }, { status: 504 });
    }
    return NextResponse.json({ result });
  } catch (err) {
    console.error("[api/sessions/rewind] POST failed", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
