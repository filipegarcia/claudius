"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Sparkles, X } from "lucide-react";

/**
 * One-shot "Opus 4.8 is here!" top-of-feed announcement mirroring the Claude
 * Code TUI's `tengu-top-of-feed-tip` setup nudge. Distinct from the rotating
 * spinner tips in `lib/shared/tips.ts` (rendered under the working spinner)
 * and from the transient `OpusOverloadNudgePanel` (a server-emitted
 * high-load nudge): this is a persistent launch announcement pinned above
 * the message list until the user dismisses it.
 *
 * Renders `/effort xhigh` as a styled `<code>` span rather than a clickable
 * affordance: `/effort` is `handler: "sdk"` in the slash-command registry,
 * so a click would dispatch the command into the model on the spot — wrong
 * shape for a setup hint that just points at where to find the lever.
 *
 * Per-browser dismissal via localStorage (same `useSyncExternalStore`
 * shape as `useGoalBannerHidden`): "first run" for this banner means once
 * per browser, not once per session — a new session shouldn't re-pop the
 * announcement.
 */

const STORAGE_KEY = "claudius.opusLaunchTipDismissed";
const SAME_TAB_EVENT = "claudius.opusLaunchTipDismissed.changed";

function readSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
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

/** Hook variant — exposed for unit tests and potential reset-from-settings use. */
export function useOpusLaunchTipDismissed() {
  // `useSyncExternalStore`'s third arg gives a stable server snapshot so
  // SSR + hydration agree on "not dismissed yet"; the real value lands on
  // the next render once the client mounts.
  const dismissed = useSyncExternalStore(subscribe, readSnapshot, () => false);
  const setDismissed = useCallback((next: boolean) => {
    try {
      if (next) window.localStorage.setItem(STORAGE_KEY, "1");
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Non-persistent fallback is fine — in-memory state still updates
      // via the dispatched event below.
    }
    window.dispatchEvent(new Event(SAME_TAB_EVENT));
  }, []);
  return { dismissed, setDismissed };
}

export function OpusLaunchTipBanner({ sessionId }: { sessionId: string | null }) {
  const { dismissed, setDismissed } = useOpusLaunchTipDismissed();
  // Match `RecapBanner`'s gate: no session bound yet, no banner. Avoids a
  // flash on the empty welcome screen where there's no feed to sit above.
  if (!sessionId) return null;
  if (dismissed) return null;
  return (
    <div
      data-testid="opus-launch-tip-banner"
      className="border-b border-[var(--border)] bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent"
    >
      <div className="mx-auto flex w-full max-w-[var(--chat-col)] items-center gap-2 px-4 py-1.5 text-xs">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden />
        <span className="min-w-0 flex-1 text-[var(--foreground)]/90">
          <span className="font-medium text-amber-200">Opus 4.8 is here!</span>{" "}
          <span className="text-[var(--muted)]">
            Now defaults to high effort — try{" "}
            <code className="rounded bg-[var(--panel-2)] px-1 font-mono text-[11px] text-[var(--foreground)]/90">
              /effort xhigh
            </code>{" "}
            for your hardest tasks.
          </span>
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          title="Dismiss"
          data-testid="opus-launch-tip-dismiss"
          className="shrink-0 rounded p-0.5 text-[var(--muted)] transition hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
