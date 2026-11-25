/**
 * Pure key predicates for the chat composer and its pickers. No React, no
 * DOM, so the vitest suite can pin them.
 */

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
