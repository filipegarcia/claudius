/**
 * Shell-style prompt history for the composer's Cmd/Ctrl+↑/↓ recall.
 *
 * CC 2.1.295 parity — "Fixed a queued message being lost when pulled back
 * into the prompt with ↑ or Esc just after ←: prompt history now keeps it".
 * In Claudius the analogue is the QueueIndicator's Edit action: it DELETEs
 * the queued row server-side and replaces the composer with its text, so
 * lifting A then B used to lose A for good (it was never sent, so it never
 * reached the history built from user messages). Lifted texts are now
 * merged into the history alongside the sent prompts, in chronological order.
 *
 * Pure (no React, no DOM) so the merge is unit-testable.
 */

/** A prompt the user actually sent (a `role: "user"` transcript message). */
export type SentPromptEntry = {
  text: string;
  /** Epoch ms the message was observed; absent on some replay paths. */
  at?: number;
};

/** A queued message pulled back into the composer via QueueIndicator Edit. */
export type LiftedPromptEntry = {
  text: string;
  /** Epoch ms of the lift (client clock). */
  at: number;
};

/**
 * Normalise one history entry: strip the `[Image #N]` attachment tokens (the
 * images themselves aren't recalled, so leaving the tokens would send dangling
 * references), collapse the double spaces that leaves behind, and trim.
 */
export function normalizeHistoryText(text: string): string {
  return text
    .replace(/\[Image #\d+\]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Build the recall list, oldest → newest. Sent prompts keep their transcript
 * order; each lifted text is slotted in before the first sent prompt that was
 * observed after it (sent prompts without a timestamp never pull a lift ahead
 * of them — the lift is newer than anything we can't date). Empties are
 * dropped and consecutive duplicates collapse, so lifting A and re-sending it
 * unchanged leaves a single A entry.
 */
export function buildPromptHistory(
  sent: readonly SentPromptEntry[],
  lifted: readonly LiftedPromptEntry[] = [],
): string[] {
  const pending = [...lifted].sort((a, b) => a.at - b.at);
  let li = 0;
  const out: string[] = [];
  const push = (raw: string) => {
    const text = normalizeHistoryText(raw);
    if (!text) return;
    if (out.length > 0 && out[out.length - 1] === text) return;
    out.push(text);
  };
  for (const s of sent) {
    if (s.at != null) {
      while (li < pending.length && pending[li].at < s.at) push(pending[li++].text);
    }
    push(s.text);
  }
  while (li < pending.length) push(pending[li++].text);
  return out;
}

/**
 * Where Cmd/Ctrl+↑ lands when entering history from the live draft. Normally
 * the newest entry — but when the composer already holds exactly that text
 * (e.g. the queued message just lifted into it), start one further back so
 * the first press visibly recalls something instead of re-showing the draft.
 * Returns null when there's nothing to recall.
 */
export function historyEntryIndex(history: readonly string[], draft: string): number | null {
  if (history.length === 0) return null;
  const last = history.length - 1;
  // Compare like-for-like: entries are stored normalized (image markers
  // stripped), so a lifted "[Image #1] fix this" matches "fix this".
  if (history[last] === normalizeHistoryText(draft) && last > 0) return last - 1;
  return last;
}
