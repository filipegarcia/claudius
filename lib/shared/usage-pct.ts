/**
 * CC 2.1.299 parity — "Fixed /usage, the approaching-limit warning (terminal
 * and VS Code) and the status line sometimes showing more than 100% used".
 *
 * Plan-usage utilization can come back above 100 (a window that ran past its
 * limit before the server cut it off). Claudius's bars were already clamped,
 * but the "% used" text and `aria-valuenow` printed the raw figure ("112%
 * used"). These helpers clamp the DISPLAYED number only — callers keep the
 * raw value for tone logic (`usageTone` treats `pct >= 100` as a hard stop).
 *
 * Not for the context-window %: there, >100 is a deliberate "exceeded" signal
 * (see StatusLine.tsx).
 */

/** Clamp a display percentage into 0–100. Non-finite input reads as 0. */
export function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/**
 * A rate-limit event's 0–1 `utilization` fraction as the whole percentage the
 * approaching-limit pill prints: floored like the CLI
 * (`Math.floor(utilization*100)`), then clamped to 100. The product is first
 * rounded to two decimals so float error can't floor a whole figure down a
 * point (`0.57 * 100` is `56.99999999999999`).
 */
export function rateLimitEventPct(utilization: number): number {
  return clampPct(Math.floor(Math.round(utilization * 1e4) / 100));
}
