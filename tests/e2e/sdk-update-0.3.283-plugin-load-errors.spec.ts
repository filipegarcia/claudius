/**
 * SDK 0.3.283 — the `system:init` message now carries `plugin_errors`: the
 * plugins that failed to load this session (an unmet dependency, a
 * `--plugin-dir` entry that failed, a bad manifest, …). A plugin that did not
 * load at all is otherwise just *absent* from the installed list — a silent
 * gap. Claudius captures the array on the session and `GET /api/plugins`
 * returns it as `pluginErrors`; the Plugins page renders a "Plugin load
 * errors" section above the installed list so the skipped plugin, and the
 * reason, are visible.
 *
 * This spec mocks `GET /api/plugins` with a `pluginErrors` payload (one
 * marketplace plugin, one directory entry with a `path`) and asserts both
 * rows render with their type label, message, and — for the directory entry —
 * its resolved path.
 *
 * Screenshot target: docs/sdk-updates/0.3.283/plugin-load-errors.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.283");
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
        installed: [],
        installedError: null,
        // The SDK 0.3.283 addition this spec exists to exercise.
        pluginErrors: [
          {
            plugin: "frontend-design@claude-plugins-official",
            type: "dependency-unsatisfied",
            message: "Requires plugin 'design-tokens', which is not installed.",
          },
          {
            plugin: "synced[0]",
            type: "path-not-found",
            message: "Plugin directory does not exist.",
            path: "/home/user/.claude/plugins/local/my-plugin",
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

test.describe("Plugin load errors (SDK 0.3.283)", () => {
  test("plugins that failed to load render above the installed list", async ({ page }) => {
    await mockPluginsBackend(page);
    await page.goto("/plugins");

    const section = page.getByTestId("plugin-load-errors");
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByText("Plugin load errors (2)", { exact: false })).toBeVisible();

    const rows = page.getByTestId("plugin-load-error");
    await expect(rows).toHaveCount(2);

    // Marketplace plugin: name, type label, message — no path.
    const depRow = rows.filter({ hasText: "frontend-design@claude-plugins-official" });
    await expect(depRow).toBeVisible();
    await expect(depRow.getByText("dependency-unsatisfied", { exact: true })).toBeVisible();
    await expect(
      depRow.getByText("Requires plugin 'design-tokens'", { exact: false }),
    ).toBeVisible();

    // Directory entry: positional tag + resolved path.
    const dirRow = rows.filter({ hasText: "synced[0]" });
    await expect(dirRow).toBeVisible();
    await expect(dirRow.getByText("path-not-found", { exact: true })).toBeVisible();
    await expect(
      dirRow.getByText("/home/user/.claude/plugins/local/my-plugin", { exact: false }),
    ).toBeVisible();

    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "plugin-load-errors.png"),
      fullPage: false,
    });
  });

  test("no section renders when the plugin load was clean", async ({ page }) => {
    await page.route("**/api/plugins?*", async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: process.cwd(),
          scopes: [],
          installed: [],
          installedError: null,
          pluginErrors: [],
        }),
      });
    });
    await page.route("**/api/plugins/available", async (route: Route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) }),
    );
    await page.route("**/api/sessions", async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
    });

    await page.goto("/plugins");
    await expect(page.getByText("Installed plugins", { exact: false })).toBeVisible();
    await expect(page.getByTestId("plugin-load-errors")).toHaveCount(0);
  });
});
