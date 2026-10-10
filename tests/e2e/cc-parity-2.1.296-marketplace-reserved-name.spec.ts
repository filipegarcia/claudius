/**
 * Claude Code 2.1.296 parity — "Fixed claude plugin marketplace add,
 * marketplace update and plugin install failing with an internal error for a
 * marketplace named like constructor; add now refuses such names clearly".
 *
 * Claudius's "Extra known marketplaces" form writes `extraKnownMarketplaces`
 * itself, so the CLI's add-time refusal never runs. The shared
 * `lintMarketplaceName` now refuses exact `Object.prototype` own keys
 * (`constructor`, `toString`, `valueOf`, …), so the form warns as the user
 * types and disables Add (the server-side add refuses it too).
 *
 * `/api/plugins` is mocked — nothing is added or written to disk.
 *
 * Screenshot target: docs/cc-parity/2.1.296/marketplace-reserved-name.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.296");
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
  // A predicate (not `**/api/plugins?*`) so the query-less POST is caught too.
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
              extraKnownMarketplaces: [
                {
                  name: "acme-tools",
                  kind: "github",
                  label: "acme/claude-plugins",
                  headerKeys: [],
                  hasHeadersHelper: false,
                },
              ],
            },
            emptyScope("project", "/home/user/acme/.claude/settings.json"),
            emptyScope("local", "/home/user/acme/.claude/settings.local.json"),
          ],
          installed: [],
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

test("marketplace add refuses a name Claude Code reserves (constructor)", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockPluginsBackend(page, posts);
  await page.goto("/plugins");

  const nameInput = page.getByTestId("marketplace-name-input");
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  const repoInput = page.getByTestId("marketplace-source-input");
  const add = page.getByTestId("marketplace-add-button");
  const warning = page.getByTestId("marketplace-name-warning");

  await repoInput.fill("someone/repo");
  await nameInput.fill("constructor");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("“constructor” is reserved by Claude Code");
  await expect(nameInput).toHaveAttribute("aria-invalid", "true");
  await expect(add).toBeDisabled();
  await nameInput.press("Enter");
  expect(posts).toHaveLength(0);

  await warning.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "marketplace-reserved-name.png"), fullPage: false });

  // Other Object.prototype keys are refused too…
  await nameInput.fill("toString");
  await expect(warning).toContainText("“toString” is reserved by Claude Code");
  await expect(add).toBeDisabled();

  // …but the check is exact and case-sensitive, like the CLI's.
  await nameInput.fill("Constructor");
  await expect(warning).toHaveCount(0);
  await expect(add).toBeEnabled();
  expect(posts).toHaveLength(0);
});
