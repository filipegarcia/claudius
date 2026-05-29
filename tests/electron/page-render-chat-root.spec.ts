/**
 * Electron e2e — Chat root page (`/<workspaceId>`) renders cleanly.
 *
 * Coverage row: COVERAGE.md §10 "Per-page render smoke" first row.
 *
 * Scope
 * -----
 * The Electron renderer loads `ELECTRON_START_URL=/` on boot, which
 * the middleware redirects to `/<activeWorkspaceId>` — the chat root.
 * This is the most-trafficked page and the canonical "did the app
 * boot" smoke. Asserts:
 *   • the URL resolves to a /<wks_xxx> path (middleware fired)
 *   • the prompt-input composer mounts (primary user action available)
 *   • the right-side Activity panel mounts (chat shell laid out)
 *   • no console.error / pageerror fired during render
 *
 * Driven by the autonomous e2e Ralph loop — see
 * docs/electron-conversion/E2E_LOOP_PROMPT.md.
 */
import { expect, test, type ConsoleMessage } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "./launch";

let launched: LaunchedElectron;

test.beforeEach(async () => {
  launched = await launchElectron();
});

test.afterEach(async () => {
  await teardownElectron(launched);
});

test("page-render: chat root mounts without console errors", async () => {
  const page = await launched.app.firstWindow();

  const consoleErrors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

  await page.waitForLoadState("domcontentloaded");

  // Middleware redirect: `/` → `/<wks_xxx>`. Wait on the URL pattern
  // so the assertion doesn't fire before the redirect lands.
  await page.waitForURL(/\/wks_[a-f0-9]+(\?|$)/, { timeout: 30_000 });

  // Composer is the user's primary action on the chat root.
  await expect(page.getByTestId("prompt-input")).toBeVisible({ timeout: 30_000 });

  // The right-side Activity panel renders the "Notifications" button
  // — a stable testid that identifies the right rail is wired.
  await expect(page.getByTestId("notifications-drawer-trigger")).toBeVisible({
    timeout: 10_000,
  });

  // Settle deferred fetches before checking for console errors.
  await page.waitForTimeout(500);

  expect(
    consoleErrors,
    `chat root emitted ${consoleErrors.length} console error(s):\n${consoleErrors.join("\n")}`,
  ).toEqual([]);
});
