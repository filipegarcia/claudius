"use client";

/**
 * Web-only "try the desktop app" banner.
 *
 * Rendered next to the other top-of-app banners (UpdaterBanner,
 * CustomizationBanner). Tells the user the desktop app keeps sessions
 * running in the background — a hint the browser's address-bar chrome
 * can't carry. Dismissible; the choice is persisted to localStorage.
 *
 * An earlier revision also armed a `beforeunload` close-guard from
 * here. That was removed because `beforeunload` natively can't tell a
 * reload from a real close — every chord we tried (Cmd+R, F5, the
 * toolbar reload button, DevTools-focused reloads) leaked through at
 * least one focus state, so the prompt fired on routine refreshes.
 * The desktop app intercept (electron/menu.ts double-press ⌘Q) covers
 * the "ask before quit" case in the surface where we can do it
 * accurately.
 *
 * No-op in:
 *  - the Electron build (the desktop IS the alternative being advertised),
 *  - under automation (`navigator.webdriver`) so e2e screenshots aren't
 *    polluted.
 */
import { useEffect, useState } from "react";
import { Monitor, X } from "lucide-react";

import { useIsElectron } from "@/lib/client/useElectron";

/**
 * Persisted dismissal flag. Same v1-suffix convention the rest of the
 * app uses so a future schema change can land a v2 without colliding.
 */
const STORAGE_KEY = "claudius.webDesktopBanner.dismissed.v1";

/**
 * Read the dismissal flag without throwing on private-mode / quota.
 * Lives at module scope so the mount-time effect can reference it
 * without tripping React Compiler's "accessed before declared" rule
 * (which fires when a function declaration is hoisted INSIDE a
 * component but referenced earlier in the body).
 */
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private mode / quota — fall through to "show". The banner is
    // dismissible per-session via state regardless.
    return false;
  }
}

export function WebDesktopBanner() {
  const isElectron = useIsElectron();

  // `null` until we've read localStorage on mount; rendering nothing
  // during the read avoids a hydration flash that would flip the banner
  // visible-then-hidden on every reload for users who dismissed it.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Read once on mount to flip from the SSR-safe `null` (renders
    // nothing — see below) to the resolved boolean. The dismissal flag
    // is set elsewhere by user click, so there's no external system
    // to subscribe to; one direct setState on mount is the minimum
    // amount of state synchronization React needs to know about. The
    // `null` sentinel pattern is what avoids the alternative
    // hydration flash (rendering visible-then-hidden for dismissed
    // users), so the suppression is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(readDismissed());
  }, []);

  if (isElectron) return null;
  // Hide under automation so marketing screenshots
  // (`site-screenshots.spec.ts`) and other e2e suites don't pick up
  // the promo bar in fixed-layout shots.
  if (typeof navigator !== "undefined" && navigator.webdriver) return null;
  if (dismissed !== false) return null;

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // No-op: the in-memory state already hid the banner; persistence
      // is a nice-to-have.
    }
  }

  return (
    <div
      data-pane-name="web-desktop-banner"
      className="flex items-center gap-2 border-b border-[var(--accent)]/30 bg-[var(--accent)]/5 px-4 py-1.5 text-xs"
    >
      <Monitor className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
      <span className="font-medium">Running in the browser</span>
      <span className="hidden text-[var(--muted)] sm:inline">
        Try the desktop app — Claudius keeps sessions running in the background and
        respects the OS quit/close flow.
      </span>
      <a
        href="https://github.com/claudius-network/claudius/releases"
        target="_blank"
        rel="noreferrer"
        className="ml-auto rounded border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-2 py-0.5 hover:bg-[var(--accent)]/25"
      >
        Get desktop app
      </a>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss desktop-app suggestion"
        title="Dismiss"
        className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--accent)]/15 hover:text-[var(--foreground)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
