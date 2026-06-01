"use client";

/**
 * Transient "press ⌘Q again to quit" overlay for the Electron build.
 *
 * The native Quit menu item (electron/menu.ts) intercepts Cmd/Ctrl+Q,
 * arms a short window during which a second press actually quits, and
 * dispatches `menu:action app.quitWarning` to the renderer on the first
 * press. This component listens for that action and renders a HUD-style
 * toast in the upper-center of the viewport, auto-dismissing after the
 * window expires.
 *
 * The renderer is informed of the window length via `QUIT_WARNING_MS`
 * — keep this in lockstep with the same constant in `electron/menu.ts`.
 * If the two drift, the toast either disappears before quit becomes
 * possible or lingers after the chord re-arms.
 *
 * In the browser build `useElectronAction` is a no-op, so the listener
 * never fires and the component renders nothing.
 */
import { useEffect, useState } from "react";

import { useElectronAction, useIsElectron } from "@/lib/client/useElectron";

/**
 * Must match `QUIT_WARNING_MS` in `electron/menu.ts`. The toast hides
 * after this many ms — same horizon the main process uses to decide
 * whether a second Cmd+Q counts as the confirmation press.
 */
const QUIT_WARNING_MS = 2500;

export function QuitWarningToast() {
  const isElectron = useIsElectron();
  // `null` = hidden. `number` = the timestamp the warning started — used
  // as a key so a re-trigger restarts the auto-hide timer cleanly.
  const [shownAt, setShownAt] = useState<number | null>(null);

  useElectronAction("app.quitWarning", () => {
    // performance.now is monotonic and SSR-safe-by-elimination here
    // because useElectronAction's effect only runs in the browser.
    setShownAt(performance.now());
  });

  useEffect(() => {
    if (shownAt === null) return;
    const t = window.setTimeout(() => setShownAt(null), QUIT_WARNING_MS);
    return () => window.clearTimeout(t);
  }, [shownAt]);

  if (!isElectron) return null;
  if (shownAt === null) return null;

  return (
    <div
      data-pane-name="quit-warning-toast"
      role="status"
      aria-live="polite"
      // Fixed in the upper-center so it sits above any pane chrome. The
      // pointer-events:none keeps the toast from intercepting clicks
      // while it's visible.
      style={{ pointerEvents: "none" }}
      className="fixed left-1/2 top-12 z-[200] -translate-x-1/2"
    >
      <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel)]/95 px-3 py-1.5 text-xs shadow-2xl backdrop-blur">
        <span aria-hidden className="font-mono text-[var(--accent)]">⌘Q</span>
        <span className="font-medium">Press again to quit Claudius</span>
      </div>
    </div>
  );
}
