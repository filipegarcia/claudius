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
