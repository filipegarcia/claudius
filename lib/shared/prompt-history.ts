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

/**
 * CC 2.1.331 parity — "[VSCode] Fixed the arrow keys replacing typed text with
 * an old prompt while selecting".
 *
 * Whether a Cmd/Ctrl+↑/↓ keydown walks prompt history. On macOS ⌘⇧↑/↓ is the
 * standard "select to the start / end" key (Ctrl+Shift+↑/↓ selects elsewhere),
 * but the composer swapped the typed draft for an old prompt instead. With
 * Shift held, or a selection already in progress, the browser keeps the key.
 */
export function isHistoryRecallKey(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  selecting: boolean,
): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
  return !e.shiftKey && !selecting;
}

/**
 * CC 2.1.332 parity — "[VSCode] Fixed a held Up key replacing an unsent
 * message with an earlier prompt, and Down not bringing the message back
 * after the recalled prompt got a new line or was cleared". Also CC 2.1.331's
 * "dropping edits to a recalled prompt".
 *
 * The composer's Cmd/Ctrl+↑/↓ cursor. Any edit used to drop out of history
 * browsing, so after a recalled prompt got a new line (or was cleared) ↓ did
 * nothing, and the next ↑ re-stashed the edited text over the unsent draft,
 * losing it for good. Browsing now survives edits:
 * - `idx`: the entry on screen, or null on the live draft (not browsing);
 * - `stash`: the draft that was in the box when browsing began, which ↓ past
 *   the newest entry brings back;
 * - `edits`: what the user left in recalled entries, by index, so walking
 *   away from an edited entry and back shows the edit, not the original.
 *   Kept until the prompt is sent (the composer resets the cursor then).
 */
export type HistoryCursor = {
  idx: number | null;
  stash: string;
  edits: ReadonlyMap<number, string>;
};

export const IDLE_HISTORY_CURSOR: HistoryCursor = { idx: null, stash: "", edits: new Map() };

export type HistoryStep =
  /** Not a history move: leave the key to the caret. */
  | { kind: "pass" }
  /** Handled, nothing new to show (already at the oldest entry). */
  | { kind: "stay"; cursor: HistoryCursor }
  /** Show `text`: a history entry, or the restored draft when `draft`. */
  | { kind: "show"; cursor: HistoryCursor; text: string; draft: boolean };

/**
 * One Cmd/Ctrl+↑ (`dir -1`, older) or ↓ (`dir 1`, newer) step. `value` is
 * what's in the composer now, which is how edits to the entry on screen are
 * picked up, whichever way they were made (typing, a picker, dictation).
 */
export function stepPromptHistory(
  history: readonly string[],
  cursor: HistoryCursor,
  value: string,
  dir: -1 | 1,
): HistoryStep {
  let idx = cursor.idx;
  let stash = cursor.stash;
  const edits = new Map(cursor.edits);
  const backToDraft = (): HistoryStep => ({
    kind: "show",
    cursor: { idx: null, stash: "", edits },
    text: stash,
    draft: true,
  });
  if (history.length === 0) return idx !== null && dir === 1 ? backToDraft() : { kind: "pass" };
  // History can shrink while browsing (e.g. /clear) — clamp a now-stale
  // cursor back into range so we never index past the end.
  if (idx !== null && idx > history.length - 1) idx = history.length - 1;
  if (idx !== null) {
    if (value === history[idx]) edits.delete(idx);
    else edits.set(idx, value);
  }
  if (dir === -1) {
    if (idx === null) {
      // Entering history — stash the live draft so ↓ can bring it back.
      // CC 2.1.295 parity — skip the newest entry when the composer already
      // holds it (a just-lifted queued message), so the first press recalls
      // the message that lift displaced.
      stash = value;
      idx = historyEntryIndex(history, value) ?? history.length - 1;
    } else if (idx > 0) {
      idx -= 1;
    } else {
      return { kind: "stay", cursor: { idx, stash, edits } };
    }
  } else {
    if (idx === null) return { kind: "pass" };
    if (idx >= history.length - 1) return backToDraft();
    idx += 1;
  }
  return { kind: "show", cursor: { idx, stash, edits }, text: edits.get(idx) ?? history[idx], draft: false };
}
