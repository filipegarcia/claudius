"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-browser pref tracking which {@link Tip} ids the user has pressed × on in
 * the {@link SpinnerTip}. Dismissed tips stay in the rotation but show with a
 * low probability (see `nextTipIndexWithDismissals` and
 * `DISMISSED_TIP_SHOW_PROBABILITY`) — the dismiss action is "show less", not
 * "show never", so the tip can still surface a feature the user might want
 * later.
 *
 * Mirrors the `useSyncExternalStore` + localStorage pattern of
 * `useGoalBannerHidden` / `useContextWarning` / `useTheme` so dismissals stay
 * in sync across tabs and same-tab callers without a setState-in-effect
 * anti-pattern. The snapshot is the parsed JSON string, kept stable across
 * reads via a module-level cache so React's strict-equality check on the
 * snapshot doesn't fire spuriously and re-render every consumer per
 * dispatched event.
 */

const STORAGE_KEY = "claudius.tipDismissals";
const SAME_TAB_EVENT = "claudius.tipDismissals.changed";

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

// Cache the last parsed snapshot so repeated readSnapshot() calls return the
// same reference until the underlying string changes — `useSyncExternalStore`
// bails out of re-rendering on `Object.is` equality, so a fresh Set every call
// would defeat that.
let cachedRaw: string | null | undefined = undefined;
let cachedSet: ReadonlySet<string> = EMPTY_SET;

function readSnapshot(): ReadonlySet<string> {
  if (typeof window === "undefined") return EMPTY_SET;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY_SET;
  }
  if (raw === cachedRaw) return cachedSet;
  cachedRaw = raw;
  if (!raw) {
    cachedSet = EMPTY_SET;
    return cachedSet;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      cachedSet = new Set(parsed.filter((x): x is string => typeof x === "string"));
      return cachedSet;
    }
  } catch {
    // ignore — corrupt value, treat as empty
  }
  cachedSet = EMPTY_SET;
  return cachedSet;
}

function writeSnapshot(set: ReadonlySet<string>): void {
  try {
    if (set.size === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore — non-persistent fallback is fine, the next snapshot read will
    // return the prior value but the in-memory consumer already moved on.
  }
  window.dispatchEvent(new Event(SAME_TAB_EVENT));
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

export function useTipDismissals() {
  const dismissed = useSyncExternalStore(subscribe, readSnapshot, () => EMPTY_SET);

  const dismiss = useCallback((id: string) => {
    const next = new Set(readSnapshot());
    next.add(id);
    writeSnapshot(next);
  }, []);

  const reset = useCallback(() => {
    writeSnapshot(EMPTY_SET);
  }, []);

  return { dismissed, dismiss, reset };
}
