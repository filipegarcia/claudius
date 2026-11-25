"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether the right-hand Activity panel (BackgroundTasksPanel) is expanded.
 * Collapsed, it shrinks to a slim IntelliJ-style tool-window stripe that keeps
 * the busy spinner, attention count and unread-notification badge in view and
 * re-expands on click — so hiding it never hides the "something is running /
 * needs you" signal.
 *
 * Per-browser pref, same `useSyncExternalStore` + localStorage pattern as
 * `useTabPlacement` / `useFocusMode`: SSR snapshots the default (expanded),
 * the saved value takes over after hydration, and a same-tab event keeps the
 * panel's own collapse button and the Settings toggle in sync. Independent of
 * Focus mode, which removes the panel entirely while it's on.
 */

const STORAGE_KEY = "claudius.activityPanel.collapsed";
const SAME_TAB_EVENT = "claudius.activityPanel.changed";

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

export function useActivityPanelCollapsed() {
  const collapsed = useSyncExternalStore(subscribe, readSnapshot, () => false);

  const setCollapsed = useCallback((next: boolean) => {
    try {
      if (next) window.localStorage.setItem(STORAGE_KEY, "1");
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // quota / private mode — swallow; the choice just won't stick.
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { collapsed, setCollapsed };
}
