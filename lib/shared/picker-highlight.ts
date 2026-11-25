/**
 * CC 2.1.331 parity — "[VSCode] Fixed the command menu keeping an earlier
 * match highlighted while you type more in its filter, so Enter could run the
 * wrong row".
 *
 * The composer's menus (slash, emoji, @) reset their highlight to the top row
 * only when the number of visible rows changed. The slash menu shows at most
 * 16 rows and almost always fills them, so typing another letter re-sorted
 * the list under a highlight that stayed on the same slot, now a different
 * command, and Tab or Enter picked it. The highlight now goes back to the top
 * whenever the filter text changes, too.
 *
 * Pure (no React) so the rule is unit-testable; each picker keeps the "store
 * previous props" pattern around it.
 */
export type PickerShape = { filter: string; count: number };

export function shouldResetHighlight(prev: PickerShape, next: PickerShape): boolean {
  return prev.filter !== next.filter || prev.count !== next.count;
}
