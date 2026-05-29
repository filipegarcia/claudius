import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import type {
  CancelSessionLoopRequest,
  CancelSessionLoopResponse,
} from "@/lib/shared/session-loops";

export const runtime = "nodejs";

/**
 * POST /api/schedule/session-loops/cancel
 *
 * Ask the agent owning `sessionId` to cancel a loop with id `loopId` by
 * calling `CronDelete` on it. Same trick the Activity-rail chip uses —
 * the cron tools are inside the agent runtime, not the Claudius server,
 * so we can't kill the loop directly. We compose a short prompt asking
 * the agent to do it and pipe it through `session.sendInput`.
 *
 * If the session is gone (already evicted), we 404 — the loop is dead
 * anyway in that case, but the caller should drop the chip and tell the
 * user the host session is no longer running.
 *
 * The store flips `cancelled: true` when the agent actually runs the
 * `CronDelete` tool_use (observed by `trackScheduledLoops` in
 * `lib/server/session.ts`). We don't optimistically flip it here — if
 * the prompt fails to dispatch, the chip should stay clickable.
 */
export async function POST(req: Request): Promise<NextResponse<CancelSessionLoopResponse>> {
  let body: CancelSessionLoopRequest | null = null;
  try {
    body = (await req.json()) as CancelSessionLoopRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json body" }, { status: 400 });
  }
  const sessionId = body?.sessionId?.trim();
  const loopId = body?.loopId?.trim();
  if (!sessionId || !loopId) {
    return NextResponse.json(
      { ok: false, error: "sessionId and loopId required" },
      { status: 400 },
    );
  }
  const session = sessionManager.get(sessionId);
  if (!session) {
    return NextResponse.json({ ok: false, error: "session not found" }, { status: 404 });
  }

  // Validate `loopId` against the session's actual known loops before
  // interpolating it into a prompt the agent will read. Two reasons:
  //   1. UX: an unknown id should fail fast with 404 instead of asking
  //      the agent "cancel this thing that doesn't exist" and getting
  //      back a confused reply a turn later.
  //   2. Defence in depth: this endpoint takes the id from an HTTP
  //      body, and the prompt is composed by string-interpolating it.
  //      A caller that sneaks shell-or-prompt-injection payloads into
  //      `loopId` would feed them straight to the agent. Allowlisting
  //      against the known set of ids the agent itself created closes
  //      that vector — the only ids that reach the prompt are ones the
  //      agent already minted via CronCreate.
  //
  // The lookup is O(n) over a typically-tiny set; no need for a side
  // index. The `typeof` guard handles the dev-HMR case where a Session
  // instance was constructed before this method existed (same caveat
  // as the GET endpoint — see its comment).
  if (typeof session.getScheduledLoops !== "function") {
    return NextResponse.json(
      { ok: false, error: "session predates session-loops support; restart the session" },
      { status: 409 },
    );
  }
  const known = session.getScheduledLoops().find((l) => l.id === loopId);
  if (!known) {
    return NextResponse.json(
      { ok: false, error: "loop not found in this session" },
      { status: 404 },
    );
  }
  if (known.cancelled) {
    // Idempotent: pretend we did the work. The chip will reconcile on
    // the next poll. Saves a turn on double-clicks.
    return NextResponse.json({ ok: true });
  }

  // Same prompt body the rail chip's Cancel button sends — keep aligned
  // so the agent's reply is consistent regardless of where the user
  // clicked.
  session.sendInput(
    `Please cancel the scheduled loop with id \`${known.id}\` by calling \`CronDelete\` on it. Reply with one short line confirming it's cancelled — don't run any other tools.`,
  );
  return NextResponse.json({ ok: true });
}
