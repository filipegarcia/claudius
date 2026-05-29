"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Per-browser pref controlling when the rate-limit pill in chat
 * appears for *non-rejected* events. A `rate_limit_event` whose
 * `status === "rejected"` is always shown — that's a hard stop the user
 * must know about — but `allowed`/`allowed_warning` events are gated on
 * the user's chosen threshold so the chat doesn't yell at someone who's
 * only consumed 30% of their 5-hour budget.
 *
 * Stored as a 0–100 percentage. The gating predicate is:
 *
 *   rejected                          → always show
 *   utilization is a number           → show if (utilization*100) >= threshold
 *   utilization is undefined          → show only if threshold === 0
 *
 * The SDK reports `utilization` as a 0–1 fraction (the CLI does
 * `Math.floor(H.utilization*100)` before rendering), so the multiply is
 * applied at the gate, not at the storage layer.
 *
 * Mirrors the same `useSyncExternalStore` + localStorage pattern as
 * `useTheme` so the value stays in sync across tabs and same-tab updates
 * without a setState-in-effect anti-pattern.
 */

const STORAGE_KEY = "claudius.rateLimitWarningPct";
// Default chosen empirically: at 50% the pill starts showing up well
// before users actually hit the wall, but doesn't fire on first-message-
// of-the-window noise that the SDK seems to emit around 25–30%.
const DEFAULT_PCT = 50;
const SAME_TAB_EVENT = "claudius.rateLimitWarning.changed";

export type RateLimitWarningPct = number; // 0..100, integer

/** Preset options surfaced in the settings UI. */
export const RATE_LIMIT_WARNING_PRESETS: { value: number; label: string; description: string }[] = [
  { value: 0, label: "Always", description: "Show every rate-limit event the SDK fires." },
  { value: 50, label: "Halfway", description: "Heads-up once you've burned through half the window." },
  { value: 75, label: "Most-spent", description: "Wait until you're three-quarters through." },
  { value: 90, label: "About to hit", description: "Only when you're close to the wall." },
  { value: 100, label: "Hard stop only", description: "Hide warnings entirely; only show on rejection." },
];

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PCT;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function readSnapshot(): RateLimitWarningPct {
  if (typeof window === "undefined") return DEFAULT_PCT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_PCT;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_PCT;
    return clamp(n);
  } catch {
    return DEFAULT_PCT;
  }
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", cb);
  window.addEventListener(SAME_TAB_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(SAME_TAB_EVENT, cb);
  };
}

export function useRateLimitWarningPct() {
  const value = useSyncExternalStore(subscribe, readSnapshot, () => DEFAULT_PCT);

  const setValue = useCallback((next: number) => {
    const v = clamp(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      // ignore — non-persistent fallback is fine, the in-memory state
      // is driven by the `useSyncExternalStore` snapshot.
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { value, setValue, default: DEFAULT_PCT };
}

/**
 * Predicate used by the rate-limit pill: returns true when the event
 * should be rendered given the user's current threshold.
 *
 * Kept here (alongside the storage hook) so callers don't have to
 * re-derive the rule from a raw number — there's one place to change
 * the policy if the gating semantics need to evolve (e.g. per-tier
 * thresholds later on).
 */
export function shouldShowRateLimitPill(
  info: {
    status?: "allowed" | "allowed_warning" | "rejected";
    utilization?: number;
  },
  thresholdPct: number,
): boolean {
  if (info.status === "rejected") return true;
  if (typeof info.utilization === "number") {
    return info.utilization * 100 >= thresholdPct;
  }
  // Event has no `utilization` field — the SDK fired a warning without
  // attaching a percentage. Respect the user's "show everything" choice
  // (threshold = 0) but otherwise hide; the alternative would silently
  // override the pref whenever the SDK omitted the field, which is
  // exactly the noise the setting exists to suppress.
  return thresholdPct <= 0;
}

/**
 * Stable identity helper for tests / debug: the preset that the current
 * value matches, or `null` for a custom number.
 */
export function useRateLimitWarningPreset() {
  const { value } = useRateLimitWarningPct();
  return useMemo(
    () => RATE_LIMIT_WARNING_PRESETS.find((p) => p.value === value) ?? null,
    [value],
  );
}
