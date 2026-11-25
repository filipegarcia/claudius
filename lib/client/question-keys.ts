/**
 * Keyboard rules for the AskUserQuestion modal (`AskUserQuestionPrompt`),
 * kept pure so they can be unit-tested without a DOM.
 */

/** The bits of a `KeyboardEvent` the digit rule reads. */
export type DigitKeyLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

/**
 * The option (0-based) a digit key picks, or `null`.
 *
 * CC 2.1.331 — "[VSCode] Fixed shortcuts such as Ctrl+1, Alt+1 or Ctrl+Space
 * answering an open dialog". Any keydown whose `key` was a digit used to pick
 * that option, so a chord meant for the app (Ctrl+Alt+N "Go to workspace N",
 * Ctrl+1 on macOS) silently changed the answer. Only a bare digit counts now.
 */
export function answerDigitIndex(e: DigitKeyLike, optionCount: number): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (!/^[1-9]$/.test(e.key)) return null;
  const idx = Number(e.key) - 1;
  return idx < optionCount ? idx : null;
}

/**
 * The option label Enter should pick before it advances or submits, or
 * `null` when Enter should only advance/submit.
 *
 * CC 2.1.330 — "[VSCode] Fixed Enter on a question card sending your earlier
 * answer instead of picking the focused one". Enter used to submit whatever
 * was picked before (say option 1) even with the highlight moved to option 3,
 * and did nothing at all with nothing picked yet. A single-select question
 * now picks the highlighted option first. Multi-select keeps Enter as the
 * submit key (Space and the digits toggle), so it never re-picks there.
 */
export function enterPickLabel(q: {
  multiSelect: boolean;
  options: readonly { label: string }[];
  highlighted: number;
  selectedLabels: readonly string[];
  showOther: boolean;
}): string | null {
  if (q.multiSelect) return null;
  const label = q.options[q.highlighted]?.label;
  if (!label) return null;
  if (!q.showOther && q.selectedLabels.length === 1 && q.selectedLabels[0] === label) return null;
  return label;
}

/**
 * Whether an arrow key in the "Other" textarea should leave it for the option
 * list: `"up"` (to the last option) or `"down"` (to the first), else `null`.
 *
 * CC 2.1.330 — "… and arrow keys not working after an 'Other' answer". The
 * modal's list navigation skipped every key typed in a text field, so once
 * focus was in Other's textarea the arrows never reached the options again.
 * They now leave it from the edge of the text: ArrowUp with the caret at the
 * very start, ArrowDown at the very end, either one when it's empty. A
 * selection, or Shift/Alt/Ctrl/Cmd held, stays the textarea's.
 */
export function arrowOutOfOther(
  e: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  field: { value: string; selectionStart: number | null; selectionEnd: number | null },
): "up" | "down" | null {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return null;
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return null;
  const dir = e.key === "ArrowUp" ? "up" : "down";
  if (field.value === "") return dir;
  const { selectionStart: start, selectionEnd: end } = field;
  if (start === null || start !== end) return null;
  if (dir === "up" && start === 0) return dir;
  if (dir === "down" && end === field.value.length) return dir;
  return null;
}
