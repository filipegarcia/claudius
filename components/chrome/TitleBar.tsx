"use client";

/**
 * Custom application title bar for the Electron build.
 *
 * Phase 4 of docs/electron-conversion/PLAN.md.
 *
 * Goals:
 *  - Frameless window chrome that matches the polished look of native
 *    apps like Linear / Cursor / VS Code.
 *  - The whole bar is `WebkitAppRegion: "drag"` so the user can drag
 *    the window from any non-interactive surface. Interactive children
 *    (the win/linux traffic lights) opt out individually.
 *  - Renders nothing in the browser build — `useIsElectron()` gates
 *    the entire output so the existing web layout stays exactly as it
 *    was.
 *
 * Layout invariants:
 *  - 32px tall — matches the `trafficLightPosition: { x: 18, y: 18 }`
 *    we pass to BrowserWindow on mac (lights centered in a 32px bar).
 *  - Sits above `UpdaterBanner` + `CustomizationBanner` (which live
 *    inside the column flex parent in `app/layout.tsx`).
 *  - On mac the left ~78px is reserved for the OS-drawn traffic
 *    lights (via padding-left). On win/linux that space is consumed
 *    by our own controls on the right instead, and the title sits at
 *    the left.
 */
import { useClaudius } from "@/lib/client/useElectron";

import { TrafficLights } from "./TrafficLights";

const TITLE_BAR_HEIGHT = 32; // keep in sync with electron/main.ts `trafficLightPosition`

export function TitleBar() {
  const bridge = useClaudius();
  if (!bridge) return null;

  const isMac = bridge.platform === "darwin";

  return (
    <div
      data-testid="titlebar"
      data-platform={bridge.platform}
      // Inline style for the draggable region — Tailwind doesn't ship
      // a `-webkit-app-region` utility and writing a JIT plugin for
      // one feature would be overkill.
      style={
        {
          WebkitAppRegion: "drag",
          height: TITLE_BAR_HEIGHT,
        } as React.CSSProperties
      }
      className={
        "flex w-full shrink-0 select-none items-center justify-between border-b border-[var(--border)] bg-[var(--panel)]/80 text-[11px] text-[var(--muted)] backdrop-blur " +
        // Pad past the mac traffic lights so the title doesn't collide
        // with them. On win/linux the left side is the app title.
        (isMac ? "pl-[78px] pr-2" : "pl-3 pr-0")
      }
    >
      <div className="min-w-0 flex-1 truncate text-center font-medium tracking-tight">
        Claudius
      </div>
      <TrafficLights />
    </div>
  );
}
