/**
 * CC 2.1.331 — "Fixed Manage Plugins losing its search box or showing no
 * message when a search has no match, and not saying that the list of
 * available plugins failed to load".
 *
 * On /plugins → Available plugins, a failed load (`/api/plugins/available`
 * 500) read as "No marketplaces cached yet", and a search with no match left
 * an empty box with only a small "0 of N" counter. Discover now says the list
 * failed to load and why, and says when nothing matches the search.
 *
 * `/api/plugins` and `/api/plugins/available` are mocked.
 *
 * Screenshot targets: docs/cc-parity/2.1.331/plugins-discover-states.png
 * (failed load) and docs/cc-parity/2.1.331/plugins-discover-no-match.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.331");
mkdirSync(SHOTS_DIR, { recursive: true });

const READ_ERROR = "EACCES: permission denied, scandir '/home/user/.claude/plugins/marketplaces'";

function scope(name: string, path: string) {
  return {
    scope: name,
    path,
    enabledPlugins: {},
    extraKnownMarketplaces: [],
    strictKnownMarketplaces: [],
    blockedMarketplaces: [],
    legacyExtra: false,
    pluginConfigs: {},
  };
}

async function mockBackend(page: Page, available: () => { status: number; body: unknown }): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/plugins",
    async (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: process.cwd(),
          scopes: [
            scope("user", "/home/user/.claude/settings.json"),
            scope("project", "/home/user/acme/.claude/settings.json"),
            scope("local", "/home/user/acme/.claude/settings.local.json"),
          ],
          installed: [],
          installedError: null,
          pluginErrors: [],
        }),
      }),
  );
  await page.route("**/api/plugins/available", async (route: Route) => {
    const a = available();
    return route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) });
  });
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

const CATALOG = {
  plugins: [
    { marketplace: "claude-plugins-official", name: "frontend-design", description: "Design UIs", category: "design" },
    { marketplace: "claude-plugins-official", name: "code-review", description: "Review a diff", category: "dev" },
  ],
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a failed load says so instead of 'No marketplaces cached yet'", async ({ page }) => {
  let fail = true;
  await mockBackend(page, () => (fail ? { status: 500, body: { error: READ_ERROR } } : { status: 200, body: CATALOG }));

  await page.goto("/plugins");
  const err = page.getByTestId("plugins-available-error");
  await expect(err).toHaveText(`Couldn't load the available plugins: ${READ_ERROR}. Refresh to try again.`, {
    timeout: 15_000,
  });
  await expect(page.getByText("No marketplaces cached yet", { exact: false })).toHaveCount(0);
  await expect(page.getByText("couldn't load", { exact: true })).toBeVisible();
  // The search box is still there.
  await expect(page.getByPlaceholder("Search by name, description, marketplace…")).toBeVisible();

  await err.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "plugins-discover-states.png"), fullPage: false });

  // Refresh after the cause is fixed: the list loads and the error goes.
  fail = false;
  await page.getByTitle("Re-read marketplace manifests from disk").click();
  await expect(err).toHaveCount(0);
  await expect(page.getByText("frontend-design", { exact: true })).toBeVisible();
});

test("a search with no match says so", async ({ page }) => {
  await mockBackend(page, () => ({ status: 200, body: CATALOG }));
  await page.goto("/plugins");
  const search = page.getByPlaceholder("Search by name, description, marketplace…");
  await expect(page.getByText("code-review", { exact: true })).toBeVisible({ timeout: 15_000 });

  await search.fill("kubernetes");
  const none = page.getByTestId("plugins-available-no-match");
  await expect(none).toHaveText('No plugins match "kubernetes".');
  await expect(page.getByText("0 of 2", { exact: true })).toBeVisible();
  // An existing marketplace list isn't mistaken for "no marketplaces".
  await expect(page.getByText("No marketplaces cached yet", { exact: false })).toHaveCount(0);

  // With a category picked, the message names it.
  await search.fill("review");
  await page.getByRole("button", { name: "design", exact: true }).click();
  await expect(none).toHaveText('No plugins match "review" in design.');

  await none.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "plugins-discover-no-match.png"), fullPage: false });

  await search.fill("");
  await expect(none).toHaveCount(0);
  await expect(page.getByText("frontend-design", { exact: true })).toBeVisible();
});
