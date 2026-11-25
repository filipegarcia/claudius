/**
 * Pure key predicates for the chat composer and its pickers. No React, no
 * DOM, so the vitest suite can pin them.
 */

import { isLetterKey } from "@/lib/client/key-match";

/**
 * CC 2.1.330 parity — "[VSCode] Fixed a held-down Enter key sending a
 * half-written message or running a typed slash command".
 *
 * True for a keyboard auto-repeat of Enter or Tab. The first keydown of a held
 * Enter picks the highlighted `@` file or `/` command; the repeats that follow
 * reach the composer with the picker already closed, so they used to send the
 * half-written message or run the just-completed command. An auto-repeat must
 * never pick, send or run anything.
 */
export function isHeldRepeat(e: { repeat?: boolean; key?: string }): boolean {
  return e.repeat === true && (e.key === "Enter" || e.key === "Tab");
}

/**
 * CC 2.1.330 parity — "[VSCode] Fixed Ctrl+F and Ctrl+P not moving the caret
 * in the message box on macOS".
 *
 * Whether a keydown opens the transcript find bar. On macOS Ctrl+F is the
 * system text binding "forward one character" in every text field, so while
 * typing there only Cmd+F finds and Ctrl+F is left to move the caret. Outside
 * a text field, and on other platforms, Cmd/Ctrl+F opens the bar as before.
 * (Claudius binds nothing to Ctrl+P, so only Ctrl+F needed the fix.)
 */
export function isFindChord(
  e: { key: string; code: string; altKey?: boolean; metaKey: boolean; ctrlKey: boolean },
  ctx: { mac: boolean; typing: boolean },
): boolean {
  if (!(e.metaKey || e.ctrlKey) || !isLetterKey(e, "f")) return false;
  if (ctx.mac && ctx.typing && !e.metaKey) return false;
  return true;
}
