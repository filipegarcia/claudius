"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Per-browser pref controlling when the context-window warning banner
 * appears in chat. As the active session's transcript grows toward the
 * model's context limit, we surface a warning (with a one-click Compact
 * action) once usage crosses this threshold — the same way the CLI nudges
 * you to `/compact` before auto-compaction kicks in.
 *
 * Stored as a 0–100 percentage of the context window. The gating predicate
 * is simply:
 *
 *   percentage >= threshold  → show the banner
 *
 * Unlike the rate-limit utilization (a 0–1 fraction), the context watcher
 * already reports `percentage` in 0–100 units (see `useContextWatcher`), so
 * the comparison is direct — no multiply at the gate.
 *
 * Mirrors the same `useSyncExternalStore` + localStorage pattern as
 * `useRateLimitWarning` / `useTheme` so the value stays in sync across tabs
 * and same-tab updates without a setState-in-effect anti-pattern.
 */

const STORAGE_KEY = "claudius.contextWarningPct";
// Default chosen to mirror the CLI: it starts nudging toward /compact when
// the window is getting tight but with enough headroom that you can act
// before auto-compaction takes over.
const DEFAULT_PCT = 90;
const SAME_TAB_EVENT = "claudius.contextWarning.changed";

export type ContextWarningPct = number; // 0..100, integer

/** Preset options surfaced in the settings UI. */
export const CONTEXT_WARNING_PRESETS: { value: number; label: string; description: string }[] = [
  { value: 75, label: "Early", description: "Heads-up with plenty of headroom left." },
  { value: 80, label: "Comfortable", description: "Warn once the window is mostly full." },
  { value: 90, label: "Recommended", description: "Nudge to compact before auto-compaction kicks in." },
  { value: 95, label: "Last call", description: "Only when the window is nearly exhausted." },
  {
    value: 100,
    label: "Never",
    description: "Hide the soft nudge; still warns if the window is actually exceeded.",
  },
];

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PCT;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function readSnapshot(): ContextWarningPct {
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

export function useContextWarningPct() {
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
 * Predicate used by the context-warning banner: returns true when the
 * banner should be shown given the user's current threshold.
 *
 * Kept here (alongside the storage hook) so callers don't re-derive the
 * rule from a raw number — one place to change the policy. A threshold of
 * 100 means "never nudge me early" (the UI presents 100 as the "Never"
 * preset) — but that preference only silences the *soft* approaching-full
 * nudge. Once the conversation has actually exceeded the context window
 * (percentage > 100), the SDK is no longer just close to the limit, it's
 * over it — turns can start failing until a compact happens — so that state
 * always surfaces regardless of the user's threshold pick (mirrors the CLI's
 * unconditional "/context exceeds context window" warning, CC 2.1.216).
 */
export function shouldShowContextWarning(
  percentage: number | null | undefined,
  thresholdPct: number,
): boolean {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) return false;
  if (percentage > 100) return true;
  if (thresholdPct >= 100) return false;
  return percentage >= thresholdPct;
}

/**
 * Stable identity helper for tests / debug: the preset that the current
 * value matches, or `null` for a custom number.
 */
export function useContextWarningPreset() {
  const { value } = useContextWarningPct();
  return useMemo(
    () => CONTEXT_WARNING_PRESETS.find((p) => p.value === value) ?? null,
    [value],
  );
}
