/**
 * Electron e2e — the native menu's accelerators follow the shortcut
 * registry (Phase 3 follow-up of docs/electron-conversion/PLAN.md).
 *
 * Coverage row: COVERAGE.md §12 "Keyboard shortcuts owned by the OS menu".
 *
 * Two things this guards:
 *   1. The shipped default for "Next Tab" is the registry's ⌘⌥→
 *      (`CommandOrControl+Alt+Right`) — picked to dodge macOS's
 *      Shift+Arrow text-selection chord. The menu and the cheatsheet
 *      both read from the registry, so they stay in agreement.
 *   2. A remap written to the renderer's shortcut store propagates to the
 *      native menu accelerator (the renderer pushes it via
 *      `bridge.menu.setAccelerators`, main rebuilds the menu).
 */
import { expect, test, type Page } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "./launch";

let launched: LaunchedElectron;

test.beforeEach(async () => {
  launched = await launchElectron();
});

test.afterEach(async () => {
  await teardownElectron(launched);
});

/** Read the accelerator string of the menu item with the given label. */
async function acceleratorFor(
  launched: LaunchedElectron,
  label: string,
): Promise<string | null> {
  return launched.app.evaluate(({ Menu }, wantLabel) => {
    const m = Menu.getApplicationMenu();
    if (!m) return null;
    type MenuLike = { items?: Electron.MenuItem[] };
    const walk = (items: Electron.MenuItem[]): string | null => {
      for (const item of items) {
        if (item.label === wantLabel) return item.accelerator ?? null;
        const sub = (item.submenu as MenuLike | undefined)?.items;
        if (sub) {
          const hit = walk(sub);
          if (hit !== null) return hit;
        }
      }
      return null;
    };
    return walk(m.items);
  }, label);
}

async function bootReady(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForURL(/\/wks_[a-f0-9]+(\?|$)/, { timeout: 30_000 });
  await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });
  // Give useElectronMenuSync's effect a beat to push the initial map.
  await page.waitForTimeout(700);
}

test("menu accelerator: Next Tab default matches the registry (⌘⌥→)", async () => {
  const page = await launched.app.firstWindow();
  await bootReady(page);

  await expect
    .poll(() => acceleratorFor(launched, "Next Tab"), { timeout: 10_000 })
    .toBe("CommandOrControl+Alt+Right");
});

test("menu accelerator: remapping tab.next in the store updates the native menu", async () => {
  const page = await launched.app.firstWindow();
  await bootReady(page);

  // Write an override the same way the Settings UI does: the localStorage
  // key + the same-tab change event the registry's `subscribe` listens for.
  await page.evaluate(() => {
    const overrides = { "tab.next": { mod: true, alt: false, shift: true, code: "ArrowUp" } };
    window.localStorage.setItem("claudius.shortcuts.v1", JSON.stringify(overrides));
    window.dispatchEvent(new Event("claudius.shortcuts.changed"));
  });

  await expect
    .poll(() => acceleratorFor(launched, "Next Tab"), { timeout: 10_000 })
    .toBe("CommandOrControl+Shift+Up");
});
