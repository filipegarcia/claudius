/**
 * Claude Code 2.1.295 parity — "Fixed claude plugin marketplace add
 * reporting success for a marketplace whose name no plugin can be installed
 * under; such an add is now refused".
 *
 * Plugins are installed as `<plugin>@<marketplace>`, so a marketplace name
 * with spaces / `@` / a leading `.` or `-` can never be installed under, and
 * Anthropic's reserved names are only allowed for `anthropics/` GitHub
 * sources. The "Extra known marketplaces" add form on /plugins now warns as
 * the user types and disables Add (the server-side add refuses it too).
 *
 * `/api/plugins` is mocked — nothing is added or written to disk.
 *
 * Screenshot target: docs/cc-parity/2.1.295/marketplace-name.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.295");
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

test("marketplace add refuses a name no plugin can be installed under", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockPluginsBackend(page, posts);
  await page.goto("/plugins");

  const nameInput = page.getByTestId("marketplace-name-input");
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  const repoInput = page.getByTestId("marketplace-source-input");
  const add = page.getByTestId("marketplace-add-button");
  const warning = page.getByTestId("marketplace-name-warning");

  // Reserved Anthropic name from a non-`anthropics/` repo → refused.
  await repoInput.fill("someone/repo");
  await nameInput.fill("claude-plugins-official");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("reserved for Anthropic's official marketplace");
  await expect(add).toBeDisabled();

  // …but allowed from the anthropics org.
  await repoInput.fill("anthropics/claude-plugins-official");
  await expect(warning).toHaveCount(0);
  await expect(add).toBeEnabled();

  // A name with a space can never be the `@<marketplace>` half of a ref.
  await repoInput.fill("someone/repo");
  await nameInput.fill("my market");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("“my market” can't be used as a marketplace name");
  await expect(warning).toContainText("<plugin>@<marketplace>");
  await expect(nameInput).toHaveAttribute("aria-invalid", "true");
  await expect(add).toBeDisabled();
  // Enter doesn't sneak past the disabled button.
  await nameInput.press("Enter");
  expect(posts).toHaveLength(0);

  // Centre the add form so the warning (below it) is in frame with the section chrome.
  await warning.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "marketplace-name.png"), fullPage: false });

  // A valid name clears the warning and re-enables Add.
  await nameInput.fill("my-market");
  await expect(warning).toHaveCount(0);
  await expect(add).toBeEnabled();
  expect(posts).toHaveLength(0);
});
