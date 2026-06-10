"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "claudius.showPreviews";
const SAME_TAB_EVENT = "claudius.showPreviews.changed";
const DEFAULT = true;

function readSnapshot(): boolean {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved !== null) return saved !== "false";
  } catch {
    // ignore
  }
  return DEFAULT;
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

/**
 * Preference hook for inline file previews (images + HTML) in the chat and
 * file browser. Stored in localStorage, consistent with theme.ts / ide.ts.
 * Defaults to `true` (previews on).
 */
export function useMediaPreferences() {
  const showPreviews = useSyncExternalStore(subscribe, readSnapshot, () => DEFAULT);

  const setShowPreviews = useCallback((val: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(val));
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { showPreviews, setShowPreviews };
}
