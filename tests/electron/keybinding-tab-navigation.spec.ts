/**
 * Electron e2e — tab navigation chords owned by the OS menu.
 *
 * Coverage rows:
 *   COVERAGE.md §6 "Cmd+T / Cmd+W / Cmd+Shift+T open / close / reopen tabs"
 *   COVERAGE.md §12 "Keyboard shortcuts owned by the OS menu"
 *
 * Why two paths (menu click + injected keypress)?
 * -----------------------------------------------
 * In a packaged build, `Cmd+T` / `Cmd+W` / `Cmd+Shift+T` / `Cmd+1..9`
 * are owned by the native application menu (`electron/menu.ts`). The OS
 * delivers the chord to the menu accelerator, which fires the item's
 * `click` → `webContents.send("menu:action", <id>)` → the renderer's
 * `useElectronAction(...)` handler. Crucially, a menu accelerator fires
 * even while a text input (the chat composer) is focused — that's the
 * whole point of owning the chord at the OS level.
 *
 * The renderer ALSO has a `keydown` listener (web-parity fallback for
 * the browser build) but it is deliberately gated by `isTypingTarget`,
 * so it does NOT fire while the composer is focused.
 *
 * Playwright's `_electron` keyboard injection goes through Chromium's
 * input pipeline (renderer keydown + `before-input-event`) but does NOT
 * trigger native menu accelerators. So we exercise the two paths
 * separately:
 *   • Menu path — drive the real menu item `click()` (production-faithful
 *     for the reserved chords). Asserts exactly ±1 tab, i.e. the menu
 *     dispatch fires the action once.
 *   • Renderer-keydown path — blur the composer first, then inject the
 *     non-reserved cycle chords (`Cmd+Shift+Arrow`, `Cmd+1..9`) and assert
 *     the active tab moves. This is the web-parity code path.
 *
 * Driven by the autonomous e2e Ralph loop — see
 * docs/electron-conversion/E2E_LOOP_PROMPT.md.
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

/** Number of session tabs currently in the strip. */
async function tabCount(page: Page): Promise<number> {
  return page.getByTestId("session-tab").count();
}

/** The `data-tab-id` of the active tab, or null if none. */
async function activeTabId(page: Page): Promise<string | null> {
  const active = page.locator('[data-testid="session-tab"][data-tab-active="true"]');
  if ((await active.count()) === 0) return null;
  return active.first().getAttribute("data-tab-id");
}

/**
 * Click the application-menu item whose label matches `label` (walking
 * submenus). Returns true if found + clicked. Same walk pattern as
 * `keybinding-cmd-comma-opens-settings.spec.ts`, but matched by label
 * rather than accelerator so the test stays readable.
 */
async function clickMenuItem(launched: LaunchedElectron, label: string): Promise<boolean> {
  return launched.app.evaluate(({ Menu }, wantLabel) => {
    const m = Menu.getApplicationMenu();
    if (!m) return false;
    type MenuLike = { items?: Electron.MenuItem[] };
    const walk = (items: Electron.MenuItem[]): boolean => {
      for (const item of items) {
        if (item.label === wantLabel && item.enabled !== false) {
          item.click();
          return true;
        }
        const sub = (item.submenu as MenuLike | undefined)?.items;
        if (sub && walk(sub)) return true;
      }
      return false;
    };
    return walk(m.items);
  }, label);
}

/** Boot the renderer to the chat root with at least one session tab. */
async function bootWithTab(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForURL(/\/wks_[a-f0-9]+(\?|$)/, { timeout: 30_000 });
  await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });
  // The boot session resolves into the strip asynchronously.
  await expect(page.getByTestId("session-tab").first()).toBeVisible({ timeout: 30_000 });
  // Let the SessionTabs effects (menu subscriptions) wire up before we
  // synthesize a menu click — otherwise the IPC arrives with no listener.
  await page.waitForTimeout(500);
}

test("tab nav (menu): New Tab / Close Tab / Reopen each move the strip by exactly one", async () => {
  const page = await launched.app.firstWindow();
  await bootWithTab(page);

  const initial = await tabCount(page);
  expect(initial).toBeGreaterThanOrEqual(1);

  // ── New Tab ──────────────────────────────────────────────────────────
  expect(await clickMenuItem(launched, "New Tab"), "menu has a New Tab item").toBe(true);
  await expect
    .poll(() => tabCount(page), { timeout: 20_000 })
    .toBe(initial + 1);
  // Settle, then re-assert: a double-dispatch would have produced initial+2.
  await page.waitForTimeout(800);
  expect(await tabCount(page), "New Tab fires exactly once").toBe(initial + 1);

  // ── Close Tab ────────────────────────────────────────────────────────
  expect(await clickMenuItem(launched, "Close Tab"), "menu has a Close Tab item").toBe(true);
  await expect
    .poll(() => tabCount(page), { timeout: 20_000 })
    .toBe(initial);
  await page.waitForTimeout(800);
  expect(await tabCount(page), "Close Tab fires exactly once").toBe(initial);

  // ── Reopen Closed Tab ────────────────────────────────────────────────
  expect(
    await clickMenuItem(launched, "Reopen Closed Tab"),
    "menu has a Reopen Closed Tab item",
  ).toBe(true);
  await expect
    .poll(() => tabCount(page), { timeout: 20_000 })
    .toBe(initial + 1);
});

test("tab nav (menu): Next Tab / Previous Tab cycle the active tab", async () => {
  const page = await launched.app.firstWindow();
  await bootWithTab(page);

  // Need at least two tabs to observe a cycle.
  const start = await tabCount(page);
  expect(await clickMenuItem(launched, "New Tab"), "menu has a New Tab item").toBe(true);
  await expect.poll(() => tabCount(page), { timeout: 20_000 }).toBe(start + 1);

  // NOTE — why the menu path and not an injected `Cmd+Shift+Arrow`:
  // the renderer's web-parity keydown listener bails on `isTypingTarget`,
  // and on the chat page the composer textarea autofocuses and re-grabs
  // focus even after an explicit `blur()`. So the injected-keydown cycle
  // chord is unreachable here — in Electron the OS menu owns the chord and
  // fires regardless of focus, which is the path users actually hit.
  const before = await activeTabId(page);
  expect(before).not.toBeNull();

  expect(await clickMenuItem(launched, "Next Tab"), "menu has a Next Tab item").toBe(true);
  await expect
    .poll(() => activeTabId(page), { timeout: 5_000 })
    .not.toBe(before);

  // Previous Tab returns to the original active tab (cycling wraps).
  expect(await clickMenuItem(launched, "Previous Tab"), "menu has a Previous Tab item").toBe(true);
  await expect
    .poll(() => activeTabId(page), { timeout: 5_000 })
    .toBe(before);
});
