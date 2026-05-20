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
 *  - Renders nothing in the browser build. We detect Electron two ways:
 *      1. `useClaudius()` (returns the IPC bridge when preload is up)
 *      2. `navigator.userAgent.includes('Electron')` (synchronous and
 *         always true inside the renderer, even if preload races React)
 *    Either signal is enough to render the bar — that way the user
 *    never sees the window with no draggable strip even on a slow boot.
 *
 * Layout invariants:
 *  - 32px tall — matches the `trafficLightPosition: { x: 12, y: 10 }`
 *    we pass to BrowserWindow on mac (lights centered in a 32px bar).
 *  - `position: fixed; top: 0; left: 0; right: 0; z-index: 100` so it
 *    sits above the WorkspaceSwitcher's mobile drawer (z-50) and any
 *    other overlay. The body gets a corresponding `padding-top: 32px`
 *    via `globals.css` (gated on `[data-electron]` so the web build is
 *    unaffected).
 *  - On mac the left ~78px is reserved for the OS-drawn traffic
 *    lights (via padding-left). On win/linux that space is consumed
 *    by our own controls on the right instead.
 */
import { useSyncExternalStore } from "react";

import { useClaudius } from "@/lib/client/useElectron";

import { TrafficLights } from "./TrafficLights";

const TITLE_BAR_HEIGHT = 32; // keep in sync with electron/main.ts `trafficLightPosition`

/**
 * Synchronous Electron probe used as a fallback when the IPC bridge
 * isn't ready yet. The UA contains "Electron/<version>" inside the
 * Electron renderer; in a normal browser tab it doesn't.
 *
 * Wrapped in `useSyncExternalStore` (no-op subscribe; the UA never
 * changes during a session) so SSR returns `false` while the client
 * snapshot returns the real check — same pattern as `useClaudius` and
 * safe under React 19's hydration model.
 */
const NOOP_SUBSCRIBE = () => () => {};
function getUASnapshot(): boolean {
  if (typeof navigator === "undefined") return false;
  return /\bElectron\//i.test(navigator.userAgent);
}
function getUAServerSnapshot(): boolean {
  return false;
}

export function TitleBar() {
  const bridge = useClaudius();
  const uaElectron = useSyncExternalStore(
    NOOP_SUBSCRIBE,
    getUASnapshot,
    getUAServerSnapshot,
  );

  const inElectron = Boolean(bridge) || uaElectron;
  if (!inElectron) return null;

  // Platform comes from the bridge when present; UA-only mode falls
  // back to `darwin` because that's the visual default and the only
  // platform where traffic-light padding actually matters. The bridge
  // takes over within ~one frame so this fallback is only used during
  // the very first paint.
  const platform = bridge?.platform ?? "darwin";
  const isMac = platform === "darwin";

  return (
    <div
      data-testid="titlebar"
      data-platform={platform}
      style={
        {
          // `-webkit-app-region` is NOT inherited by descendants. Apply
          // the drag property here on the bar itself…
          WebkitAppRegion: "drag",
          height: TITLE_BAR_HEIGHT,
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 100,
        } as React.CSSProperties
      }
      className={
        // Solid panel-2 background (one shade lighter than the body) so
        // the drag region reads as a distinct surface. Without this the
        // bar blended into `var(--background)` on every dark theme and
        // users couldn't tell where to grab to move the window.
        "flex w-full select-none items-center justify-between border-b border-[var(--border)] bg-[var(--panel-2)] text-[11px] text-[var(--muted)] " +
        // Pad past the mac traffic lights so the title doesn't collide
        // with them. On win/linux the left side is the app title.
        (isMac ? "pl-[78px] pr-2" : "pl-3 pr-0")
      }
    >
      <div
        // …and again on every descendant that should remain draggable.
        // Without this, the centered "Claudius" text takes up most of
        // the bar's width and the user has no draggable surface to
        // grab (clicking the text would be a no-op rather than a drag
        // initiation). The TrafficLights component opts back out with
        // `WebkitAppRegion: "no-drag"` on its individual buttons.
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        className="min-w-0 flex-1 truncate text-center font-medium tracking-tight"
      >
        Claudius
      </div>
      <TrafficLights />
    </div>
  );
}
