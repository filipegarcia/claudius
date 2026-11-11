"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-browser on/off pref for the "Resume from summary" offer (see
 * `lib/shared/resume-from-summary.ts`). The offer's "Don't ask me again"
 * button turns it off; Settings → Context-window warning turns it back on.
 *
 * Same `useSyncExternalStore` + localStorage shape as `useContextWarningPct`,
 * so a change in one tab (or the settings page) is seen everywhere at once.
 */

const STORAGE_KEY = "claudius.resumeFromSummaryEnabled";
const SAME_TAB_EVENT = "claudius.resumeFromSummary.changed";

function readSnapshot(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
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

export function useResumeFromSummaryEnabled() {
  const enabled = useSyncExternalStore(subscribe, readSnapshot, () => true);

  const setEnabled = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    } catch {
      // ignore — the snapshot falls back to the default
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { enabled, setEnabled };
}
