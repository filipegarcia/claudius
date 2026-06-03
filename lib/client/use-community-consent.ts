"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Opt-in for the community chat.
 *
 * Why: even though the chat-server URL is baked into the build by
 * default (see next.config.ts), we don't want Claudius to silently
 * open an SSE connection to chat.claudius.network the first time a
 * user navigates to /community — that would leak their IP + visit
 * timestamp to a server they may not realize exists. So the
 * /community page gates everything chat-server-bound behind explicit
 * user consent.
 *
 * Storage: the choice is persisted in `~/.claude/settings.json`
 * (`communityConsent` key) so a fresh Electron install, a Claudius
 * upgrade, or a switch between desktop and browser preserves the
 * opt-in. `localStorage` is kept as a fast-path cache so the first
 * paint after navigation reads synchronously (the server fetch
 * resolves a beat later and reconciles).
 *
 * State machine:
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

/**
 * Write the consent value to localStorage + fire the same-tab event so
 * any sibling hook (notifications provider, useCommunity) refreshes its
 * snapshot. Does NOT hit the server — that's the caller's job (the
 * `useCommunityConsent` accept/decline/reset entrypoints) so we don't
 * double-write when reconciling from a fetched server value.
 */
function writeLocal(value: CommunityConsent): void {
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
  window.dispatchEvent(new Event(COMMUNITY_CONSENT_EVENT));
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
 * PUT the consent value to the server-backed prefs endpoint. Errors are
 * swallowed — the localStorage write already happened, so the user's
 * choice is still honoured for this session; the worst case is the
 * prompt reappears on the next fresh install.
 */
async function writeServer(value: CommunityConsent): Promise<void> {
  try {
    await fetch("/api/community/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consent: value }),
    });
  } catch {
    // Best effort.
  }
}

/**
 * Reads consent via `useSyncExternalStore` — same pattern as `useTheme`.
 * SSR snapshot is `null` (no decision), which matches the visual gate
 * (first frame always shows the consent prompt; opting-in then unlocks
 * the chat surface on the next render after hydration).
 *
 * On mount we also fire a GET to `/api/community/prefs` to reconcile
 * with the user-scope settings file. If the server has a recorded
 * choice that localStorage doesn't, we hydrate localStorage from it —
 * that's what makes a fresh Electron / fresh browser install skip the
 * consent prompt when the user previously opted in on another device
 * using the same `~/.claude/`.
 */
export function useCommunityConsent() {
  const consent = useSyncExternalStore(subscribe, readCommunityConsent, () => null);
  // `hydrated` flips true once we've checked ~/.claude/settings.json for
  // a recorded choice (or the GET has failed). Callers (the consent
  // router page) use this to defer rendering the consent prompt until
  // we KNOW the user hasn't already opted in on this `~/.claude/` —
  // otherwise a fresh browser / Electron reinstall flashes the prompt
  // for the few hundred ms the GET is in flight, even though the
  // server is about to say "yes."
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from the server on mount.
  //
  // Two cases that need different handling:
  //   • localConsent is null   → fresh install on this device. Adopt
  //     the server's choice if it has one. This is the cross-device /
  //     reinstall flow the user asked for.
  //   • localConsent is set    → the user has already chosen on this
  //     device. Sync UP to the server if the server doesn't have it
  //     yet, but never DOWN — otherwise a stale server value could
  //     clobber a fresh same-session decision made between mount and
  //     the GET resolving. (Race: user mounts the page and clicks
  //     "No thanks" while the GET for an old "yes" is in flight.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/community/prefs");
        if (!r.ok) return;
        const data = (await r.json()) as { consent: CommunityConsent };
        const serverConsent: CommunityConsent =
          data.consent === "yes" || data.consent === "no" ? data.consent : null;
        // Re-read AFTER the await so we see the latest local value,
        // including any decision the user made while the GET was in
        // flight.
        const localConsent = readCommunityConsent();
        if (cancelled) return;
        if (localConsent === null && serverConsent) {
          // Fresh device — adopt the saved choice. This is what skips
          // the consent prompt on a reinstall / new browser pointing at
          // the same `~/.claude/`.
          writeLocal(serverConsent);
        } else if (localConsent && !serverConsent) {
          // Locally chosen but never persisted to the user-scope file
          // (upgrade from the pre-server-prefs build). Sync up.
          void writeServer(localConsent);
        }
      } catch {
        // Network errors are non-fatal — the local cache stands.
      } finally {
        // Flip hydrated regardless of outcome — callers that gate on
        // it shouldn't hang forever if the server is down.
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const accept = useCallback(() => {
    writeLocal("yes");
    void writeServer("yes");
  }, []);
  const decline = useCallback(() => {
    writeLocal("no");
    void writeServer("no");
  }, []);
  const reset = useCallback(() => {
    writeLocal(null);
    void writeServer(null);
  }, []);

  return { consent, hydrated, accept, decline, reset };
}
