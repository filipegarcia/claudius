"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

export type ThemeId = "dark" | "light" | "midnight" | "paper" | "tui" | "tui-light" | "synthwave";

export const THEMES: { id: ThemeId; label: string; preview: { bg: string; accent: string } }[] = [
  { id: "dark", label: "Dark", preview: { bg: "#0b0b0c", accent: "#d97757" } },
  { id: "light", label: "Light", preview: { bg: "#fafafa", accent: "#c0531a" } },
  { id: "midnight", label: "Midnight", preview: { bg: "#070914", accent: "#8b9bff" } },
  { id: "paper", label: "Paper", preview: { bg: "#f6f1e7", accent: "#7c4a2a" } },
  { id: "tui", label: "TUI", preview: { bg: "#000000", accent: "#f5a524" } },
  { id: "tui-light", label: "TUI Light", preview: { bg: "#fafaf7", accent: "#b45309" } },
  { id: "synthwave", label: "Synthwave", preview: { bg: "#14092b", accent: "#ff6ad5" } },
];

const STORAGE_KEY = "claudius.theme";
const DEFAULT: ThemeId = "dark";
// Custom event name for same-tab updates — the native `storage` event only
// fires for OTHER tabs.
const SAME_TAB_EVENT = "claudius.theme.changed";

function applyTheme(id: ThemeId) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = id;
}

function readSnapshot(): ThemeId {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
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
 * Theme is sourced from localStorage via `useSyncExternalStore`, which is
 * the React 19 way to read from an external store without setState-in-
 * effect. SSR uses the `DEFAULT` snapshot; on the client the store falls
 * back to the saved value after hydration.
 *
 * `applyTheme` writes to `document.documentElement.dataset.theme`. That's
 * a DOM mutation, not a setState, so the post-render effect that pushes
 * `theme` into the DOM is rule-compliant.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, readSnapshot, () => DEFAULT);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((id: ThemeId) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore
    }
    // Tell `useSyncExternalStore` to resnapshot.
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { theme, setTheme };
}
