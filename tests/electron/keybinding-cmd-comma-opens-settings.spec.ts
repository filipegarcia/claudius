/**
 * Electron e2e — `Cmd+,` opens /settings.
 *
 * Coverage row: COVERAGE.md §12 "Keyboard shortcuts owned by the OS menu".
 *
 * Scope
 * -----
 * The `app.preferences` action is owned by the OS menu (mac places
 * Preferences under the app menu with accelerator `Cmd+,`; win/linux
 * put it under "File"). Clicking it dispatches `menu:action
 * app.preferences`, which the renderer's shortcut registry handles by
 * navigating to `/settings`.
 *
 * Test walks the application menu from main, finds the item with
 * accelerator `CommandOrControl+,`, clicks it, then asserts the
 * renderer URL changed to `/settings` and the page mounted.
 *
 * Driven by the autonomous e2e Ralph loop — see
 * docs/electron-conversion/E2E_LOOP_PROMPT.md.
 */
import { expect, test } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "./launch";

let launched: LaunchedElectron;

test.beforeEach(async () => {
  launched = await launchElectron();
});

test.afterEach(async () => {
  await teardownElectron(launched);
});

// Wrapped in `test.fail()` because the renderer has no subscriber
// for the `app.preferences` action — the menu dispatches it but
// nothing navigates to /settings. See BUGS.md.
test.fail("keybinding: Cmd+, opens /settings", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('aside[data-pane-name="workspace-switcher"]')).toBeVisible({
    timeout: 30_000,
  });

  const clicked = await launched.app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu();
    if (!m) return false;
    type MenuLike = { items?: Electron.MenuItem[] };
    const walk = (items: Electron.MenuItem[]): boolean => {
      for (const item of items) {
        const accel = item.accelerator;
        // Accept either `Cmd+,` (mac branch in menu.ts), `Ctrl+,`
        // (win/linux branch), or the platform-neutral
        // `CommandOrControl+,`. All three resolve to the same chord.
        if (typeof accel === "string" && /^(Cmd|Ctrl|CommandOrControl)\+,$/i.test(accel.trim())) {
          item.click();
          return true;
        }
        const sub = (item.submenu as MenuLike | undefined)?.items;
        if (sub && walk(sub)) return true;
      }
      return false;
    };
    return walk(m.items);
  });
  expect(clicked, "menu item with accelerator CommandOrControl+, should exist").toBe(true);

  // Renderer should navigate to /settings within ~one paint.
  await page.waitForURL(/\/settings(?:$|\?|\/)/, { timeout: 10_000 });

  // Settings page mount marker — same as iter 1.
  await expect(page.getByRole("button", { name: "User", exact: true })).toBeVisible({
    timeout: 10_000,
  });
});
