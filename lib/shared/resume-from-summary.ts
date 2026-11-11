/**
 * "Resume from summary" offer — Claudius's take on the Claude Code TUI's
 * stale-resume dialog (`tengu_resume_return_action` in the CLI binary):
 *
 *   This session is 2h 15m old and 140k tokens.
 *   Resuming the full session will consume a substantial portion of your
 *   usage limits. We recommend resuming from a summary.
 *     › Resume from summary (recommended)   → runs /compact
 *       Resume full session as-is
 *       Don't ask me again
 *
 * Why it saves tokens: the prompt cache expires long before 70 minutes, so the
 * next turn on an idle session re-sends the whole conversation uncached. A
 * compacted session re-sends a summary instead.
 *
 * The TUI only checks when a session is resumed from disk. A Claudius tab can
 * sit open for hours without reloading, so we check whenever a fresh
 * context-usage reading lands (on bind, then every idle poll) — the cost is
 * the same whether the user reloaded the page or just came back to it.
 *
 * Pure helpers only; the browser pref lives in `lib/client/useResumeFromSummary`.
 */

/** TUI default (`CLAUDE_CODE_RESUME_THRESHOLD_MINUTES`). */
export const RESUME_SUMMARY_MIN_IDLE_MINUTES = 70;
/** TUI default (`CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`). */
export const RESUME_SUMMARY_MIN_TOKENS = 100_000;

export type ResumeSummaryOffer = {
  /** Minutes since the last message, at the time of the context reading. */
  idleMinutes: number;
  /** Context-window tokens the next turn would re-send. */
  tokens: number;
  /**
   * The activity timestamp the offer was computed from. Doubles as the
   * dismissal key: answering the offer silences it until new activity moves
   * this forward (and the session goes stale again).
   */
  lastActivityAt: number;
};

/**
 * Epoch ms of the newest message the model has actually seen. Optimistic
 * (`pending`) user bubbles are skipped — they haven't reached the model yet,
 * and the send that created them is about to make the session fresh anyway.
 * Messages without a timestamp (older paginated assistant entries) are
 * ignored; returns null when nothing carries one.
 */
export function lastActivityAt(
  messages: ReadonlyArray<{ createdAt?: number; pending?: boolean }>,
): number | null {
  let latest: number | null = null;
  for (const m of messages) {
    if (m.pending) continue;
    const at = m.createdAt;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/**
 * The offer to show, or null when the session isn't stale enough or big
 * enough to be worth interrupting for. `now` is the time of the context
 * reading, so callers never need a clock read during render.
 */
export function staleResumeOffer(input: {
  lastActivityAt: number | null;
  totalTokens: number | null | undefined;
  now: number;
  minIdleMinutes?: number;
  minTokens?: number;
}): ResumeSummaryOffer | null {
  const {
    lastActivityAt: at,
    totalTokens,
    now,
    minIdleMinutes = RESUME_SUMMARY_MIN_IDLE_MINUTES,
    minTokens = RESUME_SUMMARY_MIN_TOKENS,
  } = input;
  if (at === null || !Number.isFinite(now)) return null;
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens)) return null;
  if (totalTokens < minTokens) return null;
  const idleMinutes = (now - at) / 60_000;
  if (idleMinutes < minIdleMinutes) return null;
  return { idleMinutes, tokens: totalTokens, lastActivityAt: at };
}

/** "45m", "2h", "2h 15m", "3d", "3d 4h" — same shape as the TUI. */
export function formatSessionAge(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "0m";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = Math.floor(minutes % 60);
    return m === 0 ? `${hours}h` : `${hours}h ${m}m`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h === 0 ? `${days}d` : `${days}d ${h}h`;
}

/** "950", "140k", "1.2M". */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (Math.round(n) < 1_000) return String(Math.round(n));
  const k = Math.round(n / 1_000);
  if (k < 1_000) return `${k}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}
