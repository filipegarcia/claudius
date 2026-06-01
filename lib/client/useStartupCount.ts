"use client";

import { useSyncExternalStore } from "react";

/**
 * Per-browser counter of "launches" — incremented once per chat-page load, so
 * the value approximates how many times the user has opened Claudius in this
 * browser. The Claudius analog of the Claude Code TUI's `numStartups` counter
 * (which the TUI bumps once per process start and uses to gate first-run
 * onboarding tips like the `/powerup` nudge).
 *
 * "Launch = page load," not "session start" / "tab focus" — a soft-navigated
 * SPA route change does NOT bump it (single module init per page load). The
 * write happens at module evaluation behind a `bumped` guard so React 19's
 * StrictMode double-render in dev doesn't double-increment, and so a remount
 * within the same JS context (Suspense boundary retry, error recovery) also
 * counts as one launch.
 *
 * Mirrors the `useSyncExternalStore` + localStorage pattern of
 * `useGoalBannerHidden` / `useTipDismissals`: cross-tab sync via the `storage`
 * event, same-tab callers via a custom `claudius.startupCount.changed` event,
 * `getServerSnapshot` returns 0 so the value is treated as "new user" on the
 * server (no hydration mismatch — the tip is gated on `< 10` and the post-
 * hydration read settles to the real count).
 */

const STORAGE_KEY = "claudius.startupCount";
const SAME_TAB_EVENT = "claudius.startupCount.changed";

// Cap the persisted value so a long-running browser doesn't bloat localStorage
// or overflow into a non-finite number — the only consumer cares about
// `< 10` anyway, so 100 is generous headroom.
const MAX_COUNT = 100;

function read(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function write(n: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.min(n, MAX_COUNT)));
  } catch {
    // ignore — non-persistent fallback is fine, the in-memory value still
    // reflects the bump for this JS context.
  }
  window.dispatchEvent(new Event(SAME_TAB_EVENT));
}

// Module-level guard so the bump runs exactly once per JS context. Surviving
// StrictMode's double-mount and any in-app remount within the same page load
// is the whole reason this lives at module scope rather than in a `useEffect`.
let bumped = false;
if (typeof window !== "undefined" && !bumped) {
  bumped = true;
  write(read() + 1);
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
 * Snapshot of the per-browser launch counter. SSR returns 0 — the caller's
 * conditional tip (gated on `< 10`) would surface during SSR if we returned a
 * higher seed, and the hydrated value settles to the real count immediately
 * after mount.
 */
export function useStartupCount(): number {
  return useSyncExternalStore(subscribe, read, () => 0);
}
