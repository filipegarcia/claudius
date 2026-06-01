"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * User overrides for the chat reading column. When either value is set, an
 * inline CSS variable is written to `<html>` that beats the responsive
 * `clamp()` rule in `globals.css` at every viewport — so the user's choice
 * sticks regardless of screen width. When unset (`null`), the stylesheet
 * default wins and the column scales fluidly with viewport (the original
 * behavior).
 *
 * Storage shape mirrors the theme hook: two independent number values held
 * in localStorage and applied with `useSyncExternalStore` so cross-tab edits
 * and same-tab edits both reach every consumer.
 */
export type ChatSize = {
  /** Column width in rem, or null for "auto" (use the fluid clamp default). */
  colRem: number | null;
  /** Body text size in px, or null for "auto". */
  textPx: number | null;
};

export const CHAT_SIZE_BOUNDS = {
  /** Slider min for the column width. Matches the narrowest default. */
  colMinRem: 36,
  /**
   * Hard upper bound for the column override. Set well above any realistic
   * viewport (covers 8K at 1× scaling) so the *actual* slider max — which
   * ChatSizeSection caps at `min(window.innerWidth / 16, this)` — is almost
   * always the viewport, not this constant. The default (auto) is still
   * capped at 96rem by `globals.css` for everyone who doesn't move the
   * slider; this only widens the manual ceiling.
   */
  colMaxRem: 400,
  /** Slider min for the body text size. */
  textMinPx: 13,
  /**
   * Slider max — well above the responsive clamp's 28px cap so users on
   * very dense displays can dial body text up further. Same auto-vs-manual
   * split as the column: the default stays at 28px.
   */
  textMaxPx: 48,
} as const;

const COL_KEY = "claudius.chatColRem";
const TEXT_KEY = "claudius.chatTextPx";
const SAME_TAB_EVENT = "claudius.chatSize.changed";

function clampCol(n: number): number {
  if (!Number.isFinite(n)) return CHAT_SIZE_BOUNDS.colMinRem;
  return Math.max(CHAT_SIZE_BOUNDS.colMinRem, Math.min(CHAT_SIZE_BOUNDS.colMaxRem, n));
}
function clampText(n: number): number {
  if (!Number.isFinite(n)) return CHAT_SIZE_BOUNDS.textMinPx;
  return Math.max(CHAT_SIZE_BOUNDS.textMinPx, Math.min(CHAT_SIZE_BOUNDS.textMaxPx, n));
}

function readSnapshot(): ChatSize {
  if (typeof window === "undefined") return { colRem: null, textPx: null };
  let colRem: number | null = null;
  let textPx: number | null = null;
  try {
    const c = window.localStorage.getItem(COL_KEY);
    if (c != null && c !== "") {
      const n = Number(c);
      if (Number.isFinite(n)) colRem = clampCol(n);
    }
  } catch {
    // ignore — privacy mode, storage disabled, etc.
  }
  try {
    const t = window.localStorage.getItem(TEXT_KEY);
    if (t != null && t !== "") {
      const n = Number(t);
      if (Number.isFinite(n)) textPx = clampText(n);
    }
  } catch {
    // ignore
  }
  return { colRem, textPx };
}

// The store returns a *fresh object* on each read but `useSyncExternalStore`
// requires reference stability between snapshots that should be considered
// equal. We memoize per (colRem, textPx) pair so React doesn't tear-render
// every time some unrelated state changes elsewhere.
let cachedSnapshot: ChatSize = { colRem: null, textPx: null };
let cachedKey = ":";
function getSnapshot(): ChatSize {
  const fresh = readSnapshot();
  const key = `${fresh.colRem ?? ""}:${fresh.textPx ?? ""}`;
  if (key === cachedKey) return cachedSnapshot;
  cachedKey = key;
  cachedSnapshot = fresh;
  return fresh;
}

const SERVER_SNAPSHOT: ChatSize = { colRem: null, textPx: null };

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
 * Write the inline CSS variables onto `<html>` so the user's choice beats
 * the `@media (min-width: 1536px)` `clamp()` rule. Removing the property
 * restores the stylesheet rule, which is the "auto" state.
 */
function applyToDom(size: ChatSize) {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  if (size.colRem == null) root.removeProperty("--chat-col");
  else root.setProperty("--chat-col", `${size.colRem}rem`);
  if (size.textPx == null) root.removeProperty("--chat-text");
  else root.setProperty("--chat-text", `${size.textPx}px`);
}

/**
 * `useChatSize` returns the current overrides plus three setters. Mirrors
 * `useTheme` deliberately — chat sizing is a UI preference, not a Claude
 * setting, so it bypasses the `ClaudeSettings` draft/save flow and lives
 * entirely in localStorage with instant DOM application.
 *
 * The hook does NOT seed a default into localStorage. Unset stays unset so
 * existing users keep the fluid responsive behavior shipped in
 * `globals.css` — only an explicit slider drag persists a number.
 */
export function useChatSize() {
  const size = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);

  // Re-apply on every change. The `beforeInteractive` bootstrap in
  // `app/layout.tsx` handles the first paint; this effect handles every
  // subsequent change (and survives any DOM that the bootstrap missed,
  // e.g. cross-tab updates landing after first paint).
  useEffect(() => {
    applyToDom(size);
  }, [size]);

  const setColRem = useCallback((rem: number) => {
    try {
      window.localStorage.setItem(COL_KEY, String(clampCol(rem)));
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  const setTextPx = useCallback((px: number) => {
    try {
      window.localStorage.setItem(TEXT_KEY, String(clampText(px)));
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(COL_KEY);
      window.localStorage.removeItem(TEXT_KEY);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { size, setColRem, setTextPx, reset };
}
