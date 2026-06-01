"use client";

import { useEffect, useRef } from "react";

/**
 * "Where were we?" auto-trigger — fires `requestRecap("away")` when the user
 * returns to a tab after a long blur period. Mirrors the Claude Code TUI's
 * away-summary trigger (≥5 minutes of focus loss; produced on regain).
 *
 * # What we watch
 *
 * `document.visibilitychange` is the right signal: it fires on tab switch,
 * window minimize, and OS-level focus loss across every modern browser.
 * `window.blur` / `window.focus` are more eager (they fire when *any* OS
 * window steals focus, including an Electron devtools panel) and would
 * trigger recaps too often. The TUI itself counts blur time via terminal
 * focus events; the visibility API is the browser-native analogue.
 *
 * # What we don't try to do here
 *
 * - **Multi-tab dedupe** — handled server-side by `Session.requestRecap`'s
 *   `lastRecapAt` gate. If three tabs all regain focus within the dedupe
 *   window, only the first POST spawns a query; the others fast-fail with
 *   a silent `rate_limited`.
 * - **Settings gate** — also server-side: when `sessionRecapEnabled === false`
 *   the request returns a (silent) `disabled` error. Doing the gate
 *   client-side too would require duplicating settings plumbing, and the
 *   network cost of one fire-and-forget POST when off is negligible.
 * - **Disable when there's no session** — the trigger respects the
 *   `enabled` prop. The workspace page sets it to `false` when no session
 *   id is bound, so a no-op page doesn't auto-fire on first focus.
 *
 * # Why we gate on "composer draft present"
 *
 * The TUI suppresses recaps when there's typed-but-unsent input ("draft
 * input present" in its skip log). Same reason: surprising the user with a
 * banner while they're typing is jarring. We pass that check in via
 * `getHasDraft` so the workspace page can plug its composer ref in without
 * this hook needing to know about the editor surface.
 */
export type UseAwayRecapOptions = {
  /** Master kill-switch. When false, the hook does nothing. */
  enabled: boolean;
  /**
   * Minimum blur duration (ms) before a refocus fires a recap. Defaults to
   * 5 min, matching the TUI. Lower it in tests by passing a tiny number; the
   * Playwright spec sets this to a few hundred ms so it can reproduce the
   * flow without literally idling.
   */
  thresholdMs?: number;
  /**
   * Probe for "is there unsent text in the composer?" Called at trigger
   * time, not eagerly, so it can read live editor state. Returning true
   * suppresses the recap; we never fight the user mid-sentence.
   */
  getHasDraft?: () => boolean;
  /**
   * The actual trigger — same shape as `useSession().requestRecap`. Stable
   * identity preferred (memoize on the caller) but the hook re-binds the
   * listener on identity change so a fresh callback is always live.
   */
  requestRecap: (origin: "away" | "manual") => void | Promise<void>;
};

const DEFAULT_THRESHOLD_MS = 5 * 60_000;

export function useAwayRecap(opts: UseAwayRecapOptions): void {
  const { enabled, thresholdMs = DEFAULT_THRESHOLD_MS, getHasDraft, requestRecap } = opts;

  // Track when the tab went hidden so the visibility-change listener can
  // compute elapsed-blur on its own. Using a ref (not state) because we don't
  // want a re-render on every blur — the only consumer is the listener.
  const hiddenAtRef = useRef<number | null>(null);

  // Mirror the latest callbacks into refs so the listener effect can stay
  // mounted across prop changes — re-binding `visibilitychange` on every
  // callback identity change would race against quick tab-switches.
  const requestRecapRef = useRef(requestRecap);
  const getHasDraftRef = useRef(getHasDraft);
  const enabledRef = useRef(enabled);
  const thresholdRef = useRef(thresholdMs);

  useEffect(() => {
    requestRecapRef.current = requestRecap;
  }, [requestRecap]);
  useEffect(() => {
    getHasDraftRef.current = getHasDraft;
  }, [getHasDraft]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    thresholdRef.current = thresholdMs;
  }, [thresholdMs]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    function onChange() {
      if (document.visibilityState === "hidden") {
        // Stamp the start of this blur span. Note: a refocus that fires
        // BEFORE we stamped (a brief background flash) just doesn't trigger
        // — we'd rather miss a marginal blur than fire spurious recaps on
        // every alt-tab.
        hiddenAtRef.current = Date.now();
        return;
      }
      if (document.visibilityState !== "visible") return;
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (!enabledRef.current) return;
      if (hiddenAt === null) return;
      const elapsed = Date.now() - hiddenAt;
      if (elapsed < thresholdRef.current) return;
      // Defer the draft check + RPC to the next microtask so this handler
      // doesn't share a stack with whatever else the browser is firing on
      // visibility-restore (focus restoration, IME state, etc.).
      queueMicrotask(() => {
        try {
          if (getHasDraftRef.current?.()) return;
          void requestRecapRef.current("away");
        } catch {
          // Swallow — a recap is a nice-to-have, never blocking.
        }
      });
    }
    // Stamp the current state up-front so a tab that was hidden BEFORE the
    // hook mounted (e.g. user opened the workspace in a background tab,
    // switched to it later) still gets a chance to fire. Without this,
    // hiddenAtRef stays null and the very first focus event short-circuits.
    if (document.visibilityState === "hidden") {
      hiddenAtRef.current = Date.now();
    }
    document.addEventListener("visibilitychange", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
    };
  }, []);
}
