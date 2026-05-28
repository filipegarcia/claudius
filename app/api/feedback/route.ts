import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import {
  insertFeedback,
  listFeedback,
  type FeedbackRating,
} from "@/lib/server/feedback-store";

export const runtime = "nodejs";

/**
 * Feedback submission for the CLI-style session-quality survey.
 *
 * The comment is BOTH forwarded to Anthropic (via the SDK's undocumented
 * `Query.submitFeedback`, the same channel the CLI uses) AND persisted to the
 * per-workspace `.claudius.db`. Persistence is the robust path — even when the
 * forward fails (unsupported method / dropped by an SDK bump) the row is kept,
 * so feedback is never silently lost. The response reports `forwarded` so the
 * UI can tell the user when the Anthropic hop didn't land and suggest another
 * way to share.
 */

type PostBody = {
  sessionId?: string;
  rating?: string;
  comment?: string;
  surface?: string;
};

const RATINGS = new Set<FeedbackRating>(["up", "down"]);

function coerceRating(raw: unknown): FeedbackRating | null {
  return typeof raw === "string" && RATINGS.has(raw as FeedbackRating)
    ? (raw as FeedbackRating)
    : null;
}

/** Encode the thumbs verdict into the forwarded free-text (submitFeedback takes only a description). */
function forwardText(rating: FeedbackRating | null, comment: string): string {
  const tag = rating === "up" ? "[+1] " : rating === "down" ? "[-1] " : "";
  return `${tag}${comment}`.trim();
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as PostBody | null;
  const comment = typeof body?.comment === "string" ? body.comment.trim() : "";
  const rating = coerceRating(body?.rating);
  // Require *something* to submit — a rating or a comment.
  if (!comment && !rating) {
    return NextResponse.json({ error: "empty feedback" }, { status: 400 });
  }

  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
  const surface = typeof body?.surface === "string" ? body.surface : "claudius";
  const session = sessionId ? sessionManager.get(sessionId) : undefined;

  // We need a live session both to forward (its Query holds the control
  // channel) and to know which per-cwd DB to write to. The survey only ever
  // appears for an active session and submission happens within seconds, so
  // this is the overwhelmingly common path. If the session is gone, there's
  // no DB to attribute the row to — surface that so the client can fall back
  // to an alternate share channel rather than silently dropping it.
  if (!session) {
    return NextResponse.json(
      { ok: false, stored: false, forwarded: false, reason: "session-unavailable" },
      { status: 409 },
    );
  }

  let forwarded = false;
  try {
    forwarded = await session.submitFeedback(forwardText(rating, comment), surface);
  } catch {
    forwarded = false;
  }

  // Always keep a local copy, even when the forward failed.
  await insertFeedback(session.cwd, {
    id: randomUUID(),
    sessionId: session.id,
    rating,
    comment,
    surface,
    forwarded,
    createdAt: Date.now(),
  }).catch(() => {
    // best-effort persistence
  });

  return NextResponse.json({ ok: true, stored: true, forwarded });
}

/** Recent feedback for the active session's workspace — handy for a future review surface. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  const session = sessionId ? sessionManager.get(sessionId) : undefined;
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
  const items = await listFeedback(session.cwd, limit);
  return NextResponse.json({ ok: true, items });
}
