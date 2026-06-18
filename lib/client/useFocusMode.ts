"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Focus mode — a global, remembered, three-level toggle that progressively
 * strips the chat surface down. Levels:
 *
 *   - "off"   — full UI.
 *   - "focus" — hide the left nav-icon rail and the right BackgroundTasksPanel,
 *               force ultra-compact chat. Workspace rail, tabs and the header
 *               controls stay.
 *   - "zen"   — everything in "focus" PLUS hide the workspace rail and every
 *               other header control; only the toggle (now "Zen Mode") remains.
 *
 * State lives in `localStorage` and is read via `useSyncExternalStore`, the
 * React 19 way to read an external store without setState-in-effect. This
 * mirrors `useTheme` (`lib/client/theme.ts`): SSR uses the `DEFAULT` snapshot;
 * the saved value takes over after hydration. A custom same-tab event pokes the
 * store to resnapshot (the native `storage` event only fires for OTHER tabs),
 * so two open tabs stay in sync.
 */

export type FocusLevel = "off" | "focus" | "zen";

const STORAGE_KEY = "claudius.focusMode";
const DEFAULT: FocusLevel = "off";
const SAME_TAB_EVENT = "claudius.focusMode.changed";
// Cycle order for the toggle button / shortcut.
const ORDER: FocusLevel[] = ["off", "focus", "zen"];

function readSnapshot(): FocusLevel {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "zen") return "zen";
    // "1" is the legacy boolean-on value from the first version of this hook.
    if (raw === "focus" || raw === "1") return "focus";
    return "off";
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

function write(level: FocusLevel) {
  try {
    window.localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // quota / private-mode — swallow
  }
  // Tell `useSyncExternalStore` (this tab + any others) to resnapshot.
  window.dispatchEvent(new Event(SAME_TAB_EVENT));
}

export function useFocusMode(): {
  focusLevel: FocusLevel;
  /** True for both "focus" and "zen" — i.e. side rails hidden, ultra-compact chat. */
  isFocus: boolean;
  /** True only for "zen". */
  isZen: boolean;
  setFocusLevel: (level: FocusLevel) => void;
  /** Advance off → focus → zen → off. */
  cycleFocus: () => void;
} {
  const focusLevel = useSyncExternalStore(subscribe, readSnapshot, () => DEFAULT);

  const setFocusLevel = useCallback((level: FocusLevel) => {
    write(level);
  }, []);

  const cycleFocus = useCallback(() => {
    const cur = readSnapshot();
    write(ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length]);
  }, []);

  return {
    focusLevel,
    isFocus: focusLevel !== "off",
    isZen: focusLevel === "zen",
    setFocusLevel,
    cycleFocus,
  };
}
