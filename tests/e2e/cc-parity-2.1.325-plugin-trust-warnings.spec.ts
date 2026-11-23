/**
 * CC 2.1.325 parity — "Improved the add-marketplace confirmations, plugin
 * recommendation prompts and plugin install warning to say that plugins can
 * run code on your computer, with access to your files and shell."
 *
 * Claudius's equivalents live on `/plugins`: the install form carries the
 * engine's install warning, the catalog browser heads its list with the
 * one-liner, and typing a source into the marketplace add form shows the
 * add-marketplace note.
 *
 * Screenshots: docs/cc-parity/2.1.325/plugin-trust-install.png
 *              docs/cc-parity/2.1.325/plugin-trust-marketplace.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import {
  MARKETPLACE_TRUST_NOTE,
  PLUGIN_INSTALL_TRUST_WARNING,
  PLUGIN_RUNS_CODE_NOTE,
} from "../../lib/shared/plugin-trust";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.325");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const emptyScope = (scope: string, path: string) => ({
  scope,
  path,
  enabledPlugins: {},
  extraKnownMarketplaces: [],
  strictKnownMarketplaces: [],
  blockedMarketplaces: [],
});

async function mockPluginsBackend(page: Page): Promise<void> {
  await page.route("**/api/plugins?*", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cwd: process.cwd(),
        scopes: [
          emptyScope("user", "~/.claude/settings.json"),
          emptyScope("project", ".claude/settings.json"),
          emptyScope("local", ".claude/settings.local.json"),
        ],
        installed: [],
        installedError: null,
        pluginErrors: [],
      }),
    });
  });

  await page.route("**/api/plugins/available", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plugins: [
          {
            marketplace: "claude-plugins-official",
            name: "frontend-design",
            displayName: "Frontend Design",
            description: "Design and build distinctive, production-grade frontend interfaces.",
            category: "development",
            installs: 51200,
          },
          {
            marketplace: "claude-plugins-official",
            name: "code-review",
            description: "Review the current branch for correctness bugs.",
            category: "productivity",
            installs: 1830,
          },
        ],
      }),
    });
  });

  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });
}

/**
 * The app-wide updater banner reflects the dev machine's real updater state
 * (not mocked here) and has nothing to do with this feature — dismiss it so
 * the screenshot shows the page chrome without unrelated noise.
 */
async function dismissUpdaterBanner(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: /^Dismiss (updater error|update-feed notice|for this session|for 24 hours|until a newer version is available)$/ });
  for (let i = 0; i < 3 && (await dismiss.count()) > 0; i++) {
    await dismiss.first().click().catch(() => {});
  }
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Plugin trust warnings (CC 2.1.325)", () => {
  test("install form and catalog say plugins can run code", async ({ page }) => {
    await mockPluginsBackend(page);
    await page.goto("/plugins");

    const installWarning = page.getByTestId("plugin-install-trust-warning");
    await expect(installWarning).toBeVisible({ timeout: 15_000 });
    await expect(installWarning).toHaveText(PLUGIN_INSTALL_TRUST_WARNING);

    const catalogNote = page.getByTestId("plugin-catalog-trust-note");
    await expect(catalogNote).toHaveText(PLUGIN_RUNS_CODE_NOTE);
    // Once for the list, not on every row.
    await expect(catalogNote).toHaveCount(1);

    // The long install warning already covers a `--marketplace` install, so
    // filling that field doesn't stack a second "can run code" line under it.
    await page.getByPlaceholder("frontend-design@claude-plugins-official").fill("dataviz");
    await page.getByTestId("plugin-install-marketplace-source").fill("acme/claude-plugins");
    await expect(page.getByText(MARKETPLACE_TRUST_NOTE)).toHaveCount(0);

    await dismissUpdaterBanner(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, "plugin-trust-install.png"), fullPage: false });
  });

  test("marketplace add form shows the add-marketplace note once a source is typed", async ({ page }) => {
    await mockPluginsBackend(page);
    await page.goto("/plugins");

    const sourceInput = page.getByTestId("marketplace-source-input");
    await expect(sourceInput).toBeVisible({ timeout: 15_000 });

    const note = page.getByTestId("marketplace-trust-note");
    await expect(note).toHaveCount(0);

    await page.getByTestId("marketplace-name-input").fill("acme-tools");
    await sourceInput.fill("acme/claude-plugins");
    await expect(note).toHaveText(MARKETPLACE_TRUST_NOTE);
    // The note is advice, not a lint error — Add stays enabled.
    await expect(page.getByTestId("marketplace-add-button")).toBeEnabled();

    await sourceInput.fill("");
    await expect(note).toHaveCount(0);
    await sourceInput.fill("acme/claude-plugins");

    await dismissUpdaterBanner(page);
    await note.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, "plugin-trust-marketplace.png"), fullPage: false });
  });
});
