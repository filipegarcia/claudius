/**
 * CC 2.1.216 (F6) — "/context warns when over the context window". The
 * `/context` overlay and the in-chat ContextWarningBanner both decide "is the
 * window exceeded?" off the SDK's reported usage percentage. Centralizing the
 * boundary here keeps the two surfaces from drifting apart (the banner's
 * comment already warns it "must match the `> 100` boundary").
 *
 * Pure + dependency-free so the boundary is unit-testable.
 */

/**
 * True when usage is *over* the model's context window — strictly greater than
 * 100%. An exact 100.0% is "at the limit", not exceeded, so it does not count
 * (and a non-finite value never does). The percentage is in 0–100(+) units and
 * is NOT pre-rounded: rounding first would flip a genuine 99.5% ("nearly
 * full") to a displayed 100% and mislabel it, and flip an exact 100.0% to
 * "exceeded".
 */
export function isContextWindowExceeded(percentage: number): boolean {
  return Number.isFinite(percentage) && percentage > 100;
}
