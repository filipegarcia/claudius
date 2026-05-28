import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { recordSendUses } from "@/lib/server/asset-ingest";
import { sessionManager } from "@/lib/server/session-manager";
import { recordSuggestedMessage } from "@/lib/server/suggested-messages-db";
import type { SendInputRequest } from "@/lib/shared/events";

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
  // Forward the client-minted uuid (if any) so the user message lands in the
  // session's SSE buffer with the same id the optimistic local add used,
  // and so the SDK writes that same uuid to the on-disk JSONL. `slash` opts
  // in to the no-echo dispatch for SDK-handled slash commands (/compact,
  // /init, etc.).
  const sendOpts: { uuid?: string; slash?: boolean } = {};
  if (body.uuid) sendOpts.uuid = body.uuid;
  if (body.slash) sendOpts.slash = true;
  session.sendInput(
    body.text ?? "",
    body.images,
    Object.keys(sendOpts).length > 0 ? sendOpts : undefined,
  );

  // Record provenance when the message came from a clicked suggestion chip so
  // the chat can badge it as auto-suggested (persists across reloads). Keyed by
  // the client-minted uuid, which the SDK also writes to the JSONL. Best-effort
  // — a bookkeeping write must never fail the send.
  if (body.fromSuggestion && body.uuid) {
    void recordSuggestedMessage(session.cwd, {
      sessionId: session.id,
      messageUuid: body.uuid,
      text: body.text ?? "",
    }).catch((err) => console.warn("[input] recordSuggestedMessage:", err));
  }

  // Best-effort asset indexing — never fail the send because of this.
  if (hasImages) {
    void recordSendUses({
      cwd: session.cwd,
      sessionId: session.id,
      messageUuid: randomUUID(),
      occurredMs: Date.now(),
      images: body.images!,
    }).catch((err) => console.warn("[input] recordSendUses:", err));
  }

  return NextResponse.json({ ok: true });
}
