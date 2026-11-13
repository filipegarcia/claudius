/**
 * SDK 0.3.325 — plugin_errors entries on `system:init` gained `managed_lock`:
 * the managed-settings `enabledPlugins` entry that dropped a --plugin-dir /
 * SDK `plugins` / synced copy. The Plugins page's load-errors section now
 * explains the lock under the affected row ("Managed settings enable
 * corp-tools@corp-marketplace, so this local copy is not accepted…").
 *
 * Screenshot target: docs/sdk-updates/0.3.325/plugin-managed-lock.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.325");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function mockPluginsBackend(page: Page): Promise<void> {
  await page.route("**/api/plugins?*", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cwd: process.cwd(),
        scopes: [
          {
            scope: "user",
            path: "~/.claude/settings.json",
            enabledPlugins: {},
            extraKnownMarketplaces: [],
            strictKnownMarketplaces: [],
            blockedMarketplaces: [],
          },
          {
            scope: "project",
            path: ".claude/settings.json",
            enabledPlugins: {},
            extraKnownMarketplaces: [],
            strictKnownMarketplaces: [],
            blockedMarketplaces: [],
          },
          {
            scope: "local",
            path: ".claude/settings.local.json",
            enabledPlugins: {},
            extraKnownMarketplaces: [],
            strictKnownMarketplaces: [],
            blockedMarketplaces: [],
          },
        ],
        installed: [],
        installedError: null,
        // The SDK 0.3.325 `managed_lock` addition this spec exists to exercise
        // (the session route camel-cases it to `managedLock`).
        pluginErrors: [
          {
            plugin: "inline[0]",
            type: "generic-error",
            message: "Plugin copy was dropped.",
            path: "/home/user/dev/corp-tools",
            managedLock: { pluginEnabled: true, name: "corp-tools", marketplace: "corp-marketplace" },
          },
          {
            plugin: "synced[0]",
            type: "generic-error",
            message: "Plugin copy was dropped.",
            managedLock: { pluginEnabled: false, name: "legacy-linter" },
          },
        ],
      }),
    });
  });

  await page.route("**/api/plugins/available", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plugins: [] }),
    });
  });

  // The page probes for a live session to scope the installed-plugin fetch;
  // an empty list keeps it in the "open a session for live data" state, which
  // is fine since /api/plugins is mocked directly regardless of sessionId.
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Plugin managed_lock explanation (SDK 0.3.325)", () => {
  test("a dropped plugin copy explains the managed-settings lock", async ({ page }) => {
    await mockPluginsBackend(page);
    await page.goto("/plugins");

    const section = page.getByTestId("plugin-load-errors");
    await expect(section).toBeVisible({ timeout: 15_000 });

    const rows = page.getByTestId("plugin-load-error");
    await expect(rows).toHaveCount(2);

    const enabledRow = rows.filter({ hasText: "inline[0]" });
    await expect(enabledRow.getByTestId("plugin-load-error-managed-lock")).toHaveText(
      "Managed settings enable corp-tools@corp-marketplace, so this local copy is not accepted as that plugin.",
    );

    const disabledRow = rows.filter({ hasText: "synced[0]" });
    await expect(disabledRow.getByTestId("plugin-load-error-managed-lock")).toHaveText(
      "Managed settings turn legacy-linter off, so no local copy of that plugin may load.",
    );

    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, "plugin-managed-lock.png"), fullPage: false });
  });
});
