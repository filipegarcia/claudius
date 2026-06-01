"use client";

/**
 * Renderer-side store for the outbound-link target preference.
 *
 * Mirrors the localStorage + `useSyncExternalStore` pattern used by
 * `theme.ts` and the shortcut registry: SSR-safe (falls back to the
 * default before hydration), broadcasts a same-tab custom event so
 * subscribers in this tab re-render synchronously, and listens for the
 * native `storage` event so a settings change in another window
 * propagates too.
 *
 * The current value is pushed to the Electron main process by
 * `useElectronLinkTargetSync` (mounted at app-layout level via
 * `useElectronGlobalActions`) so `setWindowOpenHandler` can branch
 * synchronously per click — see `electron/ipc/link-target.ts`.
 */
import { useCallback, useSyncExternalStore } from "react";

import {
  DEFAULT_LINK_TARGET,
  type LinkTarget,
} from "@/lib/shared/link-target";

const STORAGE_KEY = "claudius.linkTarget";
const SAME_TAB_EVENT = "claudius.linkTarget.changed";

function isValidTarget(value: unknown): value is LinkTarget {
  return value === "external" || value === "in-app";
}

function readSnapshot(): LinkTarget {
  if (typeof window === "undefined") return DEFAULT_LINK_TARGET;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (isValidTarget(raw)) return raw;
  } catch {
    // localStorage blocked (private mode) — fall through.
  }
  return DEFAULT_LINK_TARGET;
}

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", cb);
  window.addEventListener(SAME_TAB_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(SAME_TAB_EVENT, cb);
  };
}

function getServerSnapshot(): LinkTarget {
  return DEFAULT_LINK_TARGET;
}

/**
 * Read + write the link-target preference. Returns the current value plus
 * a setter that persists and broadcasts.
 *
 * In the browser build this is read-write-only — there's no Electron
 * preload so the preference has no main-process side effect. The setting
 * still appears on /settings (it's harmless and explains itself), and
 * tracks the user's stated preference for when they next launch the
 * Electron build.
 */
export function useLinkTarget(): {
  target: LinkTarget;
  setTarget: (next: LinkTarget) => void;
} {
  const target = useSyncExternalStore(subscribe, readSnapshot, getServerSnapshot);

  const setTarget = useCallback((next: LinkTarget) => {
    try {
      if (next === DEFAULT_LINK_TARGET) {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Quota / private mode — swallow.
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);

  return { target, setTarget };
}
