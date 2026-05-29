"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-browser pref controlling whether the empty "Set a session goal" prompt
 * shows in the chat session header. Some users never use the goal feature and
 * would rather not see the affordance — dismissing it hides the empty state
 * everywhere (it does NOT suppress an active goal, which is real session
 * metadata you still want to see).
 *
 * Mirrors the `useSyncExternalStore` + localStorage pattern of
 * `useContextWarning` / `useRateLimitWarning` / `useTheme` so the value stays
 * in sync across tabs and same-tab updates without a setState-in-effect
 * anti-pattern. The setter is exposed on the banner (the dismiss ×), on the
 * collapsed title row (a hover affordance), and in Settings (a restore toggle).
 */

const STORAGE_KEY = "claudius.goalBannerHidden";
const SAME_TAB_EVENT = "claudius.goalBannerHidden.changed";

function readSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
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

export function useGoalBannerHidden() {
  const hidden = useSyncExternalStore(subscribe, readSnapshot, () => false);

  const setHidden = useCallback((next: boolean) => {
    try {
      if (next) window.localStorage.setItem(STORAGE_KEY, "1");
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore — non-persistent fallback is fine, the in-memory state is
      // driven by the `useSyncExternalStore` snapshot.
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { hidden, setHidden };
}
