/**
 * CC 2.1.281 (F7) — the `attribution` setting (hide commit/PR attribution).
 *
 * The SDK types it as `boolean | { commit?; pr?; sessionUrl?; … }`:
 * `false` hides all attribution, `true` is the same as leaving it out
 * (the default, standard attribution), and the object form customizes
 * per-field text. The Settings catalog surfaces only the simple hide-all
 * toggle; an object config is left to the raw-JSON "Other" editor so the
 * toggle never clobbers it.
 *
 * Pure + dependency-free so the state mapping is unit-testable.
 */

export type AttributionFieldState = "custom" | "hidden" | "default";

/**
 * Which of the catalog toggle's three states the stored value represents:
 * - an object → `"custom"` (edit via the Other JSON editor; toggle is inert)
 * - `false` → `"hidden"` (attribution suppressed)
 * - anything else (`true`, unset, or an unexpected scalar) → `"default"`
 *   (standard attribution; `true` is explicitly "same as leaving it out").
 */
export function attributionFieldState(value: unknown): AttributionFieldState {
  if (value !== null && typeof value === "object") return "custom";
  if (value === false) return "hidden";
  return "default";
}
