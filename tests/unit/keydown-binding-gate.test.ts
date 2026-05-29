/**
 * The renderer keydown path must defer to the native Electron menu for every
 * chord that menu owns — otherwise (post the `before-input-event` fix, which
 * lets the menu accelerator fire) the in-page listener and the menu both run
 * and the action double-fires (two new tabs, a palette that opens-then-closes).
 *
 * `isElectronMenuOwned` is the pure decision behind `useKeydownBinding`. This
 * guards the SET — not real key delivery, which only osascript/manual can
 * verify (CDP-injected keys bypass both the menu accelerator and
 * before-input-event). It catches the regression where an id the menu
 * dispatches stops being suppressed in the renderer (or vice-versa).
 */
import { describe, expect, test } from "vitest";

import { isElectronMenuOwned, ELECTRON_MENU_OWNED_IDS } from "@/lib/client/useKeydownBinding";
import { MENU_ACCELERATOR_ACTION_IDS } from "@/lib/client/useElectronMenuSync";

describe("isElectronMenuOwned", () => {
  test("covers every action the native menu dispatches", () => {
    for (const id of MENU_ACCELERATOR_ACTION_IDS) {
      expect(isElectronMenuOwned(id), `${id} must defer to the menu`).toBe(true);
    }
  });

  test("covers the numeric tab selector (menu owns ⌘1–9 via tab.go*/tab.last)", () => {
    // The renderer keys ⌘1–9 off `tab.selectByNumber`, which is NOT itself a
    // menu-dispatched id — but the menu owns the same physical chords, so the
    // renderer must still stand down in Electron.
    expect(isElectronMenuOwned("tab.selectByNumber")).toBe(true);
  });

  test.each([
    "tab.new",
    "tab.close",
    "tab.reopen",
    "tab.last",
    "tab.next",
    "tab.prev",
    "nav.commandPalette",
    "app.preferences",
  ])("non-idempotent / menu-owned action %s is gated", (id) => {
    expect(isElectronMenuOwned(id)).toBe(true);
  });

  test.each([
    "workspace.next", // ⌘⇧] — rail cycling, never in the native menu
    "workspace.prev",
    "nav.chat", // Alt+letter nav — not a menu accelerator
    "nav.files",
    "totally.unknown.id",
  ])("renderer-owned action %s is NOT gated (stays live in Electron)", (id) => {
    expect(isElectronMenuOwned(id)).toBe(false);
  });

  test("the owned set is exactly the menu ids plus the numeric selector", () => {
    expect(ELECTRON_MENU_OWNED_IDS).toEqual(
      new Set([...MENU_ACCELERATOR_ACTION_IDS, "tab.selectByNumber"]),
    );
  });
});
