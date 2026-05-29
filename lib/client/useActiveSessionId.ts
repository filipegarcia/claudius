"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Single source of truth for "which session is the URL currently bound to".
 *
 * Why this is its own hook: `useSession.bindToSession` (lib/client/use-session.ts)
 * updates the URL via `window.history.replaceState`, which Next.js's
 * `useSearchParams` doesn't observe. Consumers that read `useSearchParams`
 * directly stall on the previous session after an in-app tab switch — that
 * silently broke the OS-popup suppression gate in `useNotifications` and the
 * auto-read gate in `NotificationsProvider`.
 *
 * This hook combines three signals:
 *   1. `useSearchParams().get("session")` — fires on Next-driven nav (initial
 *      load, router.push from notification jumps).
 *   2. `popstate` event — fires on back/forward (also misses replaceState
 *      writes, but free to listen for).
 *   3. `claudius:session-bound` custom event — dispatched by `bindToSession`
 *      immediately after the `replaceState` call. This is the path that
 *      handles in-app tab switches.
 *
 * The returned value tracks the latest of the three. Any consumer that
 * needs to know the foregrounded session should use this hook instead of
 * raw `useSearchParams`.
 */
export function useActiveSessionId(): string | null {
  const params = useSearchParams();
  const fromParams = params?.get("session") ?? null;
  const [override, setOverride] = useState<string | null>(null);

  useEffect(() => {
    function readUrl(): string | null {
      if (typeof window === "undefined") return null;
      try {
        return new URLSearchParams(window.location.search).get("session");
      } catch {
        return null;
      }
    }
    function onBound(e: Event) {
      const detail = (e as CustomEvent<{ sessionId?: string | null }>).detail;
      // Trust the explicit detail; fall back to reading the URL in case the
      // event was dispatched without a payload.
      setOverride(detail?.sessionId ?? readUrl());
    }
    function onPop() {
      setOverride(readUrl());
    }
    window.addEventListener("claudius:session-bound", onBound);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("claudius:session-bound", onBound);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  // When `useSearchParams` reflects a fresh value, prefer it — that path is
  // synchronous with the React render, so it's the most up-to-date signal
  // we have. The override path catches replaceState writes that Next misses.
  if (override === null) return fromParams;
  if (fromParams && override !== fromParams) return override;
  return override;
}
