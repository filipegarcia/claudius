/**
 * Claude Code 2.1.323 parity — two /plugins fixes on Claudius's own copy of
 * `/plugin`:
 *
 * 1. "Fixed plugins with a version list in enabledPlugins staying off with no
 *    message: /plugin and claude plugin list now say why". Only `true` turns a
 *    marketplace plugin on. The page used to show a version list as on (green
 *    scope badge, "enabled here" checked) for a plugin the engine never loads.
 * 2. "Fixed marketplaces named npm, pip, uv, cargo, github or gh being refused
 *    as reserved names". The add-marketplace form no longer refuses them.
 *
 * `/api/plugins` is mocked — nothing is written to disk.
 *
 * Screenshot targets:
 *   docs/cc-parity/2.1.323/plugin-version-list.png
 *   docs/cc-parity/2.1.323/marketplace-npm-name.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.323");
mkdirSync(SHOTS_DIR, { recursive: true });

function emptyScope(scope: string, path: string) {
  return {
    scope,
    path,
    enabledPlugins: {},
    extraKnownMarketplaces: [],
    strictKnownMarketplaces: [],
    blockedMarketplaces: [],
    legacyExtra: false,
    pluginConfigs: {},
  };
}

async function mockPluginsBackend(page: Page, posts: Array<Record<string, unknown>>): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/plugins",
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "POST") {
        posts.push(req.postDataJSON() as Record<string, unknown>);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: process.cwd(),
          scopes: [
            {
              ...emptyScope("user", "/home/user/.claude/settings.json"),
              enabledPlugins: {
                "formatter@acme-tools": true,
                "linter@acme-tools": ["1.4.0", "1.5.0"],
              },
            },
            emptyScope("project", "/home/user/acme/.claude/settings.json"),
            emptyScope("local", "/home/user/acme/.claude/settings.local.json"),
          ],
          // The engine loaded only the plugin whose value is `true`.
          installed: [
            { name: "formatter", source: "formatter@acme-tools", path: "/home/user/.claude/plugins/formatter", version: "2.0.1" },
          ],
          installedError: null,
          pluginErrors: [],
        }),
      });
    },
  );
  await page.route("**/api/plugins/available", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) }),
  );
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a version-list enabledPlugins entry reads as off, with the engine's reason", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockPluginsBackend(page, posts);
  await page.goto("/plugins");

  const note = page.getByTestId("plugin-version-list-note");
  await expect(note).toHaveCount(1, { timeout: 15_000 });
  await expect(note).toContainText(
    "Not enabled because its enabledPlugins entry is a version list. Only the value true turns on a marketplace plugin.",
  );
  // The list is in User settings, the tab on screen, so the fix is here.
  await expect(note.getByTestId("plugin-version-list-fix")).toHaveText("Tick “enabled here” to set it to true.");

  const row = page.locator("li", { has: note });
  await expect(row).toContainText("linter@acme-tools");
  // Off: unchecked, and not mislabelled "configured but not installed".
  await expect(row.getByRole("checkbox")).not.toBeChecked();
  await expect(row).not.toContainText("configured but not installed");
  // The `true` plugin is still on.
  const onRow = page.locator("li", { hasText: "formatter" }).first();
  await expect(onRow.getByRole("checkbox")).toBeChecked();
  // The User tab counts only the plugin that is actually on.
  await expect(page.getByTestId("plugin-scope-tab-user")).toContainText("1");

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "plugin-version-list.png"), fullPage: false });

  // From another tab, the note names the tab that holds the list.
  await page.getByTestId("plugin-scope-tab-project").click();
  await expect(page.getByTestId("plugin-version-list-fix")).toHaveText(
    "Open the User tab and tick “enabled here” to set it to true.",
  );
});

test("marketplace add accepts npm / gh names again", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockPluginsBackend(page, posts);
  await page.goto("/plugins");

  const nameInput = page.getByTestId("marketplace-name-input");
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  const repoInput = page.getByTestId("marketplace-source-input");
  const add = page.getByTestId("marketplace-add-button");
  const warning = page.getByTestId("marketplace-name-warning");

  await repoInput.fill("acme/npm-plugins");
  for (const name of ["gh", "pip", "npm"]) {
    await nameInput.fill(name);
    await expect(warning).toHaveCount(0);
    await expect(add).toBeEnabled();
  }
  // Built-in source names are still reserved.
  await nameInput.fill("builtin");
  await expect(warning).toContainText("reserved for built-in plugins");
  await nameInput.fill("npm");
  await expect(warning).toHaveCount(0);

  await nameInput.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "marketplace-npm-name.png"), fullPage: false });

  await add.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(JSON.stringify(posts[0])).toContain('"npm"');
});
