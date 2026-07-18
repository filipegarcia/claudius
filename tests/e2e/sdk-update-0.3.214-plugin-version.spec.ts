/**
 * SDK 0.3.214 — `system/init`'s `plugins` entries and the `reload_plugins`
 * control response now include each plugin's manifest `version`, forwarded
 * verbatim from `plugin.json` (plugin-author-controlled, display only).
 *
 * `app/api/plugins/route.ts` already passes the `reload_plugins` response's
 * `plugins` array straight through as `installed` — the `version` field was
 * arriving and being silently dropped by `InstalledPlugin`
 * (`lib/client/usePlugins.ts`), which had no field for it. This spec mocks
 * `GET /api/plugins` with an installed plugin that carries a `version` and
 * asserts the Plugins page renders it next to the plugin name.
 *
 * Screenshot target: docs/sdk-updates/0.3.214/plugin-version.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.214");
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
            enabledPlugins: { "frontend-design@claude-plugins-official": true },
            extraKnownMarketplaces: [],
            strictKnownMarketplaces: false,
            blockedMarketplaces: [],
          },
          {
            scope: "project",
            path: ".claude/settings.json",
            enabledPlugins: {},
            extraKnownMarketplaces: [],
            strictKnownMarketplaces: false,
            blockedMarketplaces: [],
          },
          {
            scope: "local",
            path: ".claude/settings.local.json",
            enabledPlugins: {},
            extraKnownMarketplaces: [],
            strictKnownMarketplaces: false,
            blockedMarketplaces: [],
          },
        ],
        installed: [
          {
            name: "frontend-design",
            path: "/home/user/.claude/plugins/marketplaces/claude-plugins-official/frontend-design",
            source: "frontend-design@claude-plugins-official",
            // The SDK 0.3.214 addition this spec exists to exercise.
            version: "1.4.2",
          },
        ],
        installedError: null,
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

  // The page probes for a live session to enable the "Reload" button and
  // scope the installed-plugin fetch — an empty list keeps it in the
  // "open a session for live data" state, which is fine for this spec
  // since /api/plugins is mocked directly regardless of sessionId.
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Plugin manifest version (SDK 0.3.214)", () => {
  test("an installed plugin's manifest version renders next to its name", async ({ page }) => {
    await mockPluginsBackend(page);
    await page.goto("/plugins");

    await expect(page.getByText("Installed plugins", { exact: false })).toBeVisible();

    const versionBadge = page.getByTestId("plugin-version");
    await expect(versionBadge).toBeVisible({ timeout: 15_000 });
    await expect(versionBadge).toHaveText("v1.4.2");

    // Scoped to the plugin's own row, next to its name — not a floating
    // page-level badge — so the screenshot shows it in the right context.
    const row = page.locator("li", { has: versionBadge });
    await expect(row.getByText("frontend-design", { exact: true })).toBeVisible();

    await versionBadge.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "plugin-version.png"),
      fullPage: false,
    });
  });
});
