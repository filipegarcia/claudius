"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * CC 2.1.247 (G6) — per-browser record of the startup count at which each
 * spinner tip was last shown, so a tip carrying `cooldownSessions` can be
 * hidden for that many launches afterwards (the browser analog of the CLI's
 * session-count cooldown; `useStartupCount` is Claudius's `numStartups`).
 *
 * Mirrors the `useSyncExternalStore` + localStorage pattern of
 * `useTipDismissals`: a module-cached snapshot so React's `Object.is` check
 * doesn't re-render every consumer per event, cross-tab sync via `storage`,
 * same-tab via a custom event. All access is wrapped in try/catch so a private
 * window / blocked storage degrades to "no cooldown" rather than throwing.
 */

const STORAGE_KEY = "claudius.tipLastShown";
const SAME_TAB_EVENT = "claudius.tipLastShown.changed";

const EMPTY: Readonly<Record<string, number>> = Object.freeze({});

let cachedRaw: string | null | undefined = undefined;
let cachedMap: Readonly<Record<string, number>> = EMPTY;

function readSnapshot(): Readonly<Record<string, number>> {
  if (typeof window === "undefined") return EMPTY;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (raw === cachedRaw) return cachedMap;
  cachedRaw = raw;
  if (!raw) {
    cachedMap = EMPTY;
    return cachedMap;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      cachedMap = out;
      return cachedMap;
    }
  } catch {
    // corrupt value → empty
  }
  cachedMap = EMPTY;
  return cachedMap;
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

export function useTipLastShown() {
  const lastShownAt = useSyncExternalStore(subscribe, readSnapshot, () => EMPTY);

  const recordShown = useCallback((id: string, startupCount: number) => {
    const current = readSnapshot();
    if (current[id] === startupCount) return; // already recorded for this launch
    const next = { ...current, [id]: startupCount };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // non-persistent fallback is fine
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { lastShownAt, recordShown };
}
