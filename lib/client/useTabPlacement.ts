"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Where the session tab strip docks around the chat area — IntelliJ's
 * "Tab placement" (Top / Left / Right). "top" is the classic horizontal strip
 * above the chat; "left" / "right" render a vertical column beside it, which
 * scales better when many sessions are open (labels stay readable, the list
 * scrolls vertically).
 *
 * Per-browser pref, same `useSyncExternalStore` + localStorage pattern as
 * `useFocusMode` / `useGoalBannerHidden`: SSR snapshots the default, the saved
 * value takes over after hydration, and a same-tab event keeps every mounted
 * reader (the strip's context menu, the Settings section) in sync.
 */

export type TabPlacement = "top" | "left" | "right";

export const TAB_PLACEMENTS: readonly TabPlacement[] = ["top", "left", "right"];

const STORAGE_KEY = "claudius.tabPlacement";
const SAME_TAB_EVENT = "claudius.tabPlacement.changed";
const DEFAULT: TabPlacement = "top";

/** Coerce a raw stored value into a placement (unknown → "top"). */
export function parseTabPlacement(raw: unknown): TabPlacement {
  return raw === "left" || raw === "right" ? raw : DEFAULT;
}

function readSnapshot(): TabPlacement {
  if (typeof window === "undefined") return DEFAULT;
  try {
    return parseTabPlacement(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT;
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

export function useTabPlacement() {
  const placement = useSyncExternalStore(subscribe, readSnapshot, () => DEFAULT);

  const setPlacement = useCallback((next: TabPlacement) => {
    try {
      if (next === DEFAULT) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // quota / private mode — swallow; the choice just won't stick.
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { placement, setPlacement };
}
