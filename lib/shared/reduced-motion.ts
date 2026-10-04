/**
 * CC 2.1.287 (F9) — the `prefersReducedMotion` setting ("Reduce or disable
 * animations for accessibility"). Claudius honors the OS
 * `prefers-reduced-motion: reduce` media query automatically (CSS in
 * `app/globals.css`); this setting additionally *forces* reduced motion on
 * even when the OS doesn't request it, applied as `data-reduced-motion="1"` on
 * the document element by `useReducedMotionSetting`.
 *
 * Pure so the (deliberately strict) mapping is unit-testable.
 */

/**
 * True only when the setting is explicitly `true`. Anything else — unset,
 * false, or a stray non-boolean from a hand-edited settings.json — means "do
 * not force it" (the OS media query still applies independently).
 */
export function shouldForceReducedMotion(value: unknown): boolean {
  return value === true;
}
