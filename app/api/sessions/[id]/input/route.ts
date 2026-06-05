import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { recordSendUses } from "@/lib/server/asset-ingest";
import { sessionManager } from "@/lib/server/session-manager";
import { recordSuggestedMessage } from "@/lib/server/suggested-messages-db";
import { recordGoalMessage } from "@/lib/server/goal-messages-db";
import type { SendInputRequest, SendInputResponse } from "@/lib/shared/events";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const body = (await req.json()) as SendInputRequest;
  const hasText = typeof body?.text === "string" && body.text.length > 0;
  const hasImages = Array.isArray(body?.images) && body.images.length > 0;
  if (!hasText && !hasImages) {
    return NextResponse.json({ error: "text or images required" }, { status: 400 });
  }

  // Stable uuid for this message — used by both branches (immediate dispatch
  // and queue enqueue) so provenance bookkeeping below is consistent whether
  // the message runs now or later. Falls back to a server-minted id when the
  // client didn't supply one.
  const uuid = body.uuid ?? randomUUID();
  const text = body.text ?? "";

  // Provenance bookkeeping fires REGARDLESS of immediate-vs-queued. The
  // suggested/goal/asset records are keyed by `uuid`, which is the same id
  // the eventual `sendInput()` broadcast will carry — so the badge re-renders
  // correctly whether the message dispatches now or after sitting in the
  // queue for several turns. Best-effort: a bookkeeping failure must never
  // fail the send.
  if (body.fromSuggestion) {
    void recordSuggestedMessage(session.cwd, {
      sessionId: session.id,
      messageUuid: uuid,
      text,
    }).catch((err) => console.warn("[input] recordSuggestedMessage:", err));
  }
  if (body.fromGoal) {
    void recordGoalMessage(session.cwd, {
      sessionId: session.id,
      messageUuid: uuid,
      text,
    }).catch((err) => console.warn("[input] recordGoalMessage:", err));
  }
  if (hasImages) {
    void recordSendUses({
      cwd: session.cwd,
      sessionId: session.id,
      messageUuid: uuid,
      occurredMs: Date.now(),
      images: body.images!,
    }).catch((err) => console.warn("[input] recordSendUses:", err));
  }

  // Decide: dispatch immediately vs. enqueue. The server is the authority on
  // this — the previous client-side decision (check `pending` in React state)
  // was racy across tabs and broken for backgrounded tabs whose SSE stream
  // had stalled. Server-side state is the only source of truth.
  //
  //   - `forceQueue: true`     → always enqueue, regardless of mode.
  //                              Matches the old explicit `enqueue()` API:
  //                              "stage a message to send after the current
  //                              train of thought, never interrupt".
  //   - mode "asap"            → never enqueue. Push straight to the SDK
  //                              input pipe even when a turn is in flight;
  //                              the SDK runs it as the very next turn.
  //                              Mirrors the Claude Code TUI's fast-pipe.
  //   - mode "wait" + busy OR
  //     queue non-empty        → enqueue. "Queue non-empty" preserves FIFO
  //                              order so a fresh message can't jump the
  //                              line ahead of staged items.
  //   - mode "wait" + idle +
  //     empty queue            → dispatch immediately. Normal fast path.
  const forceQueue = !!body.forceQueue;
  const dispatchMode = session.effectiveQueueDispatchMode;
  const isIdle = session.getStatus() === "idle";
  const queueLen = await session.queueLength();
  const shouldEnqueue =
    forceQueue ||
    (dispatchMode === "wait" && (!isIdle || queueLen > 0));

  if (shouldEnqueue) {
    await session.enqueueMessage({
      text,
      images: body.images,
      uuid,
      slash: body.slash,
      fromSuggestion: body.fromSuggestion,
      fromGoal: body.fromGoal,
    });
    const res: SendInputResponse = { ok: true, queued: true, uuid };
    return NextResponse.json(res);
  }

  // Forward the uuid (client-minted or server-fallback) so the user message
  // lands in the session's SSE buffer with the same id the optimistic local
  // add used, and so the SDK writes that same uuid to the on-disk JSONL.
  // `slash` opts in to the no-echo dispatch for SDK-handled slash commands
  // (/compact, /init, etc.).
  const sendOpts: { uuid: string; slash?: boolean } = { uuid };
  if (body.slash) sendOpts.slash = true;
  session.sendInput(text, body.images, sendOpts);

  const res: SendInputResponse = { ok: true, queued: false, uuid };
  return NextResponse.json(res);
}
