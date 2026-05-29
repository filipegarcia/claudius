"use client";

/**
 * Keydown-path binding resolver that yields to the native menu in Electron.
 *
 * In the packaged Electron build the OS application menu (electron/menu.ts)
 * owns a set of chords (Cmd+T / Cmd+W / Cmd+K / …) and dispatches them via
 * `menu:action`. Electron documents that those native accelerators fire even
 * while a text input holds focus — which is the whole reason the menu owns
 * them (the renderer's in-page `keydown` listeners bail on `isTypingTarget`).
 *
 * Crucially, when a menu accelerator is NOT suppressed, Electron dispatches
 * BOTH the menu shortcut AND the page `keydown`. So if the renderer's
 * web-parity keydown listener also matched the chord, the action would fire
 * twice (two new tabs, a palette that opens-then-closes, a sidebar that
 * toggles back). To keep the native menu the single handler, this hook
 * returns `null` for menu-owned actions when running in Electron — the
 * in-page listener's `matchBinding(null, …)` then short-circuits, leaving the
 * menu accelerator as the sole path. In the browser build (and for actions
 * the menu doesn't own, e.g. workspace cycling) it returns the resolved
 * binding unchanged, preserving web parity.
 *
 * This is the keydown counterpart to `useShortcut`: use this in `keydown`
 * handlers; keep `useShortcut` for DISPLAY (cheatsheet / hint glyphs), which
 * must always show the real binding regardless of runtime.
 */
import { useShortcut, type ShortcutBinding } from "./shortcuts";
import { useIsElectron } from "./useElectron";
import { MENU_ACCELERATOR_ACTION_IDS } from "./useElectronMenuSync";

/**
 * Action ids whose chord the Electron menu fires, so the renderer keydown
 * path must stay inert for them in Electron. This is the menu-dispatched set
 * plus `tab.selectByNumber`: the renderer keys ⌘1–9 off that modifier-only
 * binding, but the menu already owns the same physical chords via
 * `tab.go1..8` / `tab.last`, so the renderer must not also handle them.
 */
export const ELECTRON_MENU_OWNED_IDS: ReadonlySet<string> = new Set<string>([
  ...MENU_ACCELERATOR_ACTION_IDS,
  "tab.selectByNumber",
]);

/**
 * Pure decision (no hooks) — true when the native Electron menu owns this
 * action's chord, so the renderer keydown path must defer to it. Exported so
 * the rule is unit-testable without a DOM/React renderer.
 */
export function isElectronMenuOwned(id: string): boolean {
  return ELECTRON_MENU_OWNED_IDS.has(id);
}

export function useKeydownBinding(id: string): ShortcutBinding | null {
  // Both hooks run unconditionally every render (the early return is on the
  // RESULT, not the hook calls) so the rules of hooks stay satisfied.
  const binding = useShortcut(id);
  const isElectron = useIsElectron();
  if (isElectron && isElectronMenuOwned(id)) return null;
  return binding;
}
