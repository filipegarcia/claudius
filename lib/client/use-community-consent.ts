"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-browser opt-in for the community chat.
 *
 * Why: even though the chat-server URL is baked into the build by
 * default (see next.config.ts), we don't want Claudius to silently
 * open an SSE connection to chat.claudius.network the first time a
 * user navigates to /community — that would leak their IP + visit
 * timestamp to a server they may not realize exists. So the
 * /community page gates everything chat-server-bound behind explicit
 * user consent.
 *
 * State machine (persisted in localStorage so the choice survives
 * reloads, but it's a single key, no sync, no cookies):
 *
 *   null      — first visit, no decision made yet
 *   "yes"     — user clicked Connect; chat features available
 *   "no"      — user clicked Don't connect; chat features disabled
 *
 * Both decisions are reversible via the page UI; `reset()` puts the
 * hook back into the null state so the prompt reappears.
 */

export const LS_COMMUNITY_CONSENT_KEY = "claudius.community.consent";
// Same-tab cross-hook signal. localStorage's `storage` event only fires
// in *other* tabs, so changing consent in this tab wouldn't otherwise
// reach the notifications provider running in the layout. Listeners
// subscribe to this event in addition to `storage`.
export const COMMUNITY_CONSENT_EVENT = "claudius:community-consent-changed";

export type CommunityConsent = "yes" | "no" | null;

/**
 * Read the consent key from localStorage. Exposed so other hooks
 * (notably the layout-level notifications provider) can gate their
 * chat-server traffic on the same flag without duplicating the
 * sanitisation.
 */
export function readCommunityConsent(): CommunityConsent {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_COMMUNITY_CONSENT_KEY);
    return raw === "yes" || raw === "no" ? raw : null;
  } catch {
    // Private mode / storage disabled — behave like "no decision yet".
    return null;
  }
}

function write(value: CommunityConsent): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) {
      window.localStorage.removeItem(LS_COMMUNITY_CONSENT_KEY);
    } else {
      window.localStorage.setItem(LS_COMMUNITY_CONSENT_KEY, value);
    }
  } catch {
    // Persistence is best-effort. If storage is blocked the user will
    // just be asked again next page-load — that's acceptable.
  }
  // Notify same-tab listeners. The `storage` event would normally
  // cover this, but it only fires in *other* tabs; without this
  // dispatch the layout-level notifications hook wouldn't notice an
  // opt-out until a page reload, and would keep streaming SSE.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(COMMUNITY_CONSENT_EVENT));
  }
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_COMMUNITY_CONSENT_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(COMMUNITY_CONSENT_EVENT, cb);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(COMMUNITY_CONSENT_EVENT, cb);
  };
}

/**
 * Reads consent via `useSyncExternalStore` — same pattern as `useTheme`.
 * SSR snapshot is `null` (no decision), which matches the visual gate
 * (first frame always shows the consent prompt; opting-in then unlocks
 * the chat surface on the next render after hydration).
 */
export function useCommunityConsent() {
  const consent = useSyncExternalStore(subscribe, readCommunityConsent, () => null);

  const accept = useCallback(() => write("yes"), []);
  const decline = useCallback(() => write("no"), []);
  const reset = useCallback(() => write(null), []);

  return { consent, accept, decline, reset };
}
