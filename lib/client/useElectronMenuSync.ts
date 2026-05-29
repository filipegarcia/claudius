"use client";

/**
 * Push the renderer's resolved keyboard shortcuts to the native menu.
 *
 * Phase 3 follow-up of docs/electron-conversion/PLAN.md.
 *
 * The OS menu (`electron/menu.ts`) owns a set of chords that the
 * renderer's in-page `keydown` listener can't reliably fire — either
 * because the browser reserves them (Cmd+T/W) or because the chat
 * composer holds focus and the listener bails on `isTypingTarget`
 * (tab cycling). Those menu items ship with hardcoded accelerators, so
 * a remap in /settings used to have no effect on them in Electron — and
 * worse, the menu's tab-cycle accelerator had drifted from the registry
 * default the cheatsheet advertised.
 *
 * This hook closes that gap: it resolves the current binding for every
 * menu-dispatched action, converts each to an Electron accelerator
 * string, and pushes the map to main via `bridge.menu.setAccelerators`.
 * Main rebuilds the menu (and its reserved-chord swallow set) so the
 * native accelerators always match what the user configured. Re-sends
 * whenever the overrides change. No-op in the browser build.
 */
import { useEffect, useMemo } from "react";

import {
  resolveBinding,
  toElectronAccelerator,
  useShortcutRegistry,
  type ShortcutBinding,
} from "@/lib/client/shortcuts";
import { useClaudius } from "@/lib/client/useElectron";

/**
 * Action ids the native menu dispatches via `send(actionId)` (see
 * `electron/menu.ts`). Only these are synced — they're all `mod`-based
 * chords with a real menu item. The view/window/quit items are native
 * Electron roles with their own platform accelerators and aren't
 * remappable here, so they're intentionally excluded (syncing them
 * would also risk pulling unrelated keys like Cmd+C into the
 * reserved-chord swallow set on the main side).
 *
 * Keep in lockstep with the `send(...)` call sites in `electron/menu.ts`.
 */
const MENU_ACCELERATOR_ACTION_IDS: readonly string[] = [
  "app.preferences",
  "app.openWorkspace",
  "tab.new",
  "tab.close",
  "tab.reopen",
  "tab.last",
  "tab.next",
  "tab.prev",
  "tab.go1",
  "tab.go2",
  "tab.go3",
  "tab.go4",
  "tab.go5",
  "tab.go6",
  "tab.go7",
  "tab.go8",
  "nav.commandPalette",
  "nav.toggleSidebar",
  "nav.cheatsheet",
];

export function useElectronMenuSync(): void {
  const bridge = useClaudius();
  // `useShortcutRegistry` re-renders this hook whenever the localStorage
  // overrides change, so `items` reflects the live resolved bindings.
  const { items } = useShortcutRegistry();

  // Build { actionId: accelerator } for the menu-dispatched ids that
  // resolve to a representable accelerator. A disabled or modifier-only
  // binding drops out — the menu falls back to its shipped default.
  const accelerators = useMemo(() => {
    const byId = new Map<string, ShortcutBinding | null>(
      items.map((it) => [it.action.id, it.binding]),
    );
    const out: Record<string, string> = {};
    for (const id of MENU_ACCELERATOR_ACTION_IDS) {
      // Prefer the live registry value; fall back to the static resolver
      // (handles ids not surfaced by the registry hook, defensively).
      const binding = byId.has(id) ? byId.get(id)! : resolveBinding(id, {});
      const accel = toElectronAccelerator(binding);
      if (accel) out[id] = accel;
    }
    return out;
  }, [items]);

  // Serialize for a stable effect dependency so we only re-send when the
  // resolved accelerators actually change, not on every render.
  const serialized = useMemo(() => JSON.stringify(accelerators), [accelerators]);

  useEffect(() => {
    // Feature-detect before calling. The bridge contract is strictly
    // additive and `setAccelerators` landed in bridgeVersion 3 — an older
    // preload (a dev Electron process that predates the recompiled
    // preload, or a renderer/main skew after an auto-update) exposes a
    // `menu` namespace without it, and an unguarded call throws
    // "setAccelerators is not a function" and crashes the render. The
    // version gate plus the typeof check keep the web build and older
    // shells as a clean no-op.
    if (!bridge || bridge.bridgeVersion < 3) return;
    if (typeof bridge.menu.setAccelerators !== "function") return;
    bridge.menu.setAccelerators(JSON.parse(serialized) as Record<string, string>);
  }, [bridge, serialized]);
}
