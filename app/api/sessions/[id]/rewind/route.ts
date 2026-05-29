import { NextResponse } from "next/server";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { sessionManager } from "@/lib/server/session-manager";

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
 * `result.error` set, not an HTTP error — only an inactive session (503) or a
 * thrown SDK error (503) map to non-200.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const session = sessionManager.get(id);
    if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

    const body = (await req.json()) as { userMessageId?: string; dryRun?: boolean };
    const userMessageId = body?.userMessageId;
    if (!userMessageId || typeof userMessageId !== "string") {
      return NextResponse.json({ error: "userMessageId required" }, { status: 400 });
    }

    // Read the SDK `Query` instance field directly rather than the Session
    // wrapper method — instance fields survive Next.js Fast Refresh whereas
    // prototype methods don't (same rationale as the model/agents routes).
    const query = (session as unknown as { query: Query | null }).query;
    if (!query) {
      return NextResponse.json({ error: "session not active" }, { status: 503 });
    }

    const result = await query.rewindFiles(userMessageId, { dryRun: body?.dryRun === true });
    return NextResponse.json({ result });
  } catch (err) {
    console.error("[api/sessions/rewind] POST failed", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
