/**
 * CC 2.1.307 parity — "[VSCode] Added a notice on the microphone button when
 * voice dictation stops by itself, saying why and that the text so far is
 * kept."
 *
 * Claudius's dictation (`lib/client/useVoice.ts` → `lib/server/voice-stream.ts`)
 * can end without the user pressing stop:
 *
 * - the upstream speech-to-text socket closes on its own and the proxy relays
 *   that as an SSE `close` frame carrying `{ code, reason }`;
 * - the proxy's idle reaper drops the session (`reason: "idle-timeout"`);
 * - a chunk upload gets `410 Gone` because the server-side session has already
 *   been torn down.
 *
 * Before this change, all three paths quietly flipped the red mic back to
 * grey. This helper turns the stop signal into one user-facing sentence. It is
 * pure, with no DOM or React, so the vitest suite can pin the copy.
 */

/** What ended the dictation session, as seen by the client. */
export type VoiceSelfStop =
  | { kind: "close"; code?: number | null; reason?: string | null }
  | { kind: "gone" };

/** Shared tail, so every variant says the draft survived. */
export const VOICE_TEXT_KEPT = "The text so far is kept.";

/** Longest upstream-supplied reason we echo back before truncating. */
const MAX_REASON_CHARS = 120;

/** Must match `SESSION_IDLE_TIMEOUT_MS` in `lib/server/voice-stream.ts`. */
export const VOICE_IDLE_TIMEOUT_REASON = "idle-timeout";

function cleanReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  // Collapse whitespace and strip control characters so a hostile or
  // malformed close reason can't break the single-line footer.
  const flat = reason.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS - 1)}…` : flat;
}

/**
 * Build the notice shown when dictation stopped by itself. Always ends with
 * {@link VOICE_TEXT_KEPT}.
 */
export function describeVoiceSelfStop(stop: VoiceSelfStop): string {
  if (stop.kind === "gone") {
    return `Dictation stopped — the transcription session ended. ${VOICE_TEXT_KEPT}`;
  }
  const reason = cleanReason(stop.reason);
  if (reason === VOICE_IDLE_TIMEOUT_REASON) {
    return `Dictation stopped — no audio reached the transcription service for 30 seconds. ${VOICE_TEXT_KEPT}`;
  }
  // 1000 = normal closure: the service finished the session on its own
  // (for example a length or silence limit), not a network failure.
  if (stop.code === 1000 || stop.code == null) {
    return reason
      ? `Dictation stopped by the transcription service: ${reason}. ${VOICE_TEXT_KEPT}`
      : `Dictation stopped — the transcription service ended the session. ${VOICE_TEXT_KEPT}`;
  }
  return reason
    ? `Dictation stopped — connection to the transcription service closed (${stop.code}: ${reason}). ${VOICE_TEXT_KEPT}`
    : `Dictation stopped — connection to the transcription service closed (${stop.code}). ${VOICE_TEXT_KEPT}`;
}

/** Parse the proxy's SSE `close` payload (`{"code":1000,"reason":"…"}`), tolerating junk. */
export function parseVoiceCloseFrame(data: unknown): { code: number | null; reason: string | null } {
  if (typeof data !== "string" || !data) return { code: null, reason: null };
  try {
    const parsed = JSON.parse(data) as { code?: unknown; reason?: unknown };
    return {
      code: typeof parsed.code === "number" && Number.isFinite(parsed.code) ? parsed.code : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch {
    return { code: null, reason: null };
  }
}
