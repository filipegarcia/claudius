/**
 * Claude Code 2.1.295 parity — "Added a warning to claude plugin install,
 * enable, disable and marketplace add when the settings file they write to
 * does not load".
 *
 * Claudius writes `enabledPlugins` / `extraKnownMarketplaces` itself. A
 * malformed settings file used to 500 `GET /api/plugins` (the whole page read
 * just "HTTP 500") and enable/disable silently did nothing. Now the broken
 * scope comes back with `parseError` (the others still render), the Plugins
 * page shows an amber banner naming the file, and a refused write (422) is
 * surfaced inline.
 *
 * `/api/plugins` is mocked (GET payload + POST 422) — nothing is written to
 * disk, and no real settings file is corrupted.
 *
 * Screenshot target: docs/cc-parity/2.1.295/plugin-settings-invalid.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.295");
mkdirSync(SHOTS_DIR, { recursive: true });

const PROJECT_PATH = "/home/user/acme/.claude/settings.json";
const PARSE_REASON = "Expected double-quoted property name in JSON at position 87 (line 5 column 1)";
const BLOCKED =
  `${PROJECT_PATH} doesn't load (${PARSE_REASON}) — fix it before Claudius can change plugins there. The file was not changed.`;

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
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: BLOCKED }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: process.cwd(),
          scopes: [
            {
              ...emptyScope("user", "/home/user/.claude/settings.json"),
              enabledPlugins: { "frontend-design@claude-plugins-official": true },
            },
            { ...emptyScope("project", PROJECT_PATH), parseError: PARSE_REASON },
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

test("Plugins page warns when a scope's settings file doesn't load", async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockPluginsBackend(page, posts);
  await page.goto("/plugins");

  // The other scopes still render — the user-scope plugin row and its count.
  const userTab = page.getByTestId("plugin-scope-tab-user");
  await expect(userTab).toBeVisible({ timeout: 15_000 });
  await expect(userTab).toContainText("1");
  await expect(
    page.getByRole("button", { name: /frontend-design@claude-plugins-official/ }),
  ).toBeVisible();
  // No banner while the (healthy) user scope is active.
  await expect(page.getByTestId("plugin-settings-invalid")).toHaveCount(0);

  // Switch to the broken Project scope → banner names the file + reason.
  await page.getByTestId("plugin-scope-tab-project").click();
  const banner = page.getByTestId("plugin-settings-invalid");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Project settings file doesn't load");
  await expect(banner).toContainText(PROJECT_PATH);
  await expect(banner).toContainText("line 5 column 1");

  // Enabling the plugin here is refused (422) and surfaced inline.
  // `.click()`, not `.check()`: the controlled box stays unchecked after the refusal.
  await page.getByRole("checkbox").first().click();
  const err = page.getByTestId("plugin-toggle-error");
  await expect(err).toBeVisible();
  await expect(err).toContainText(PROJECT_PATH);
  await expect(err).toContainText("The file was not changed.");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    kind: "toggle",
    scope: "project",
    pluginId: "frontend-design@claude-plugins-official",
    enabled: true,
  });

  await page.waitForTimeout(300);
  await page.screenshot({
    path: resolve(SHOTS_DIR, "plugin-settings-invalid.png"),
    fullPage: false,
  });

  // Switching back to a healthy scope clears both warnings.
  await userTab.click();
  await expect(page.getByTestId("plugin-settings-invalid")).toHaveCount(0);
  await expect(page.getByTestId("plugin-toggle-error")).toHaveCount(0);
});

test("Install form warns when user settings (where installs land) don't load", async ({ page }) => {
  const USER_PATH = "/home/user/.claude/settings.json";
  await page.route(
    (url) => url.pathname === "/api/plugins",
    async (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: process.cwd(),
          scopes: [
            { ...emptyScope("user", USER_PATH), parseError: "Unexpected end of JSON input" },
            emptyScope("project", PROJECT_PATH),
            emptyScope("local", "/home/user/acme/.claude/settings.local.json"),
          ],
          installed: [],
          installedError: null,
          pluginErrors: [],
        }),
      }),
  );
  await page.route("**/api/plugins/available", async (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) }),
  );
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });

  await page.goto("/plugins");
  const warn = page.getByTestId("plugin-install-settings-invalid");
  await expect(warn).toBeVisible({ timeout: 15_000 });
  await expect(warn).toContainText(USER_PATH);
  await expect(warn).toContainText("Unexpected end of JSON input");
  // User is the default scope, so its banner shows too.
  await expect(page.getByTestId("plugin-settings-invalid")).toContainText(USER_PATH);

  // A healthy scope drops the banner but keeps the install warning (installs
  // still land in user settings).
  await page.getByTestId("plugin-scope-tab-project").click();
  await expect(page.getByTestId("plugin-settings-invalid")).toHaveCount(0);
  await expect(warn).toBeVisible();
});

test("Plugin options panel surfaces a refused option write instead of silently reverting", async ({ page }) => {
  const PLUGIN_ID = "optbot@test-mkt";
  const posts: Array<Record<string, unknown>> = [];
  await page.route(
    (url) => url.pathname === "/api/plugins",
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "POST") {
        posts.push(req.postDataJSON() as Record<string, unknown>);
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: BLOCKED }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: process.cwd(),
          scopes: [
            emptyScope("user", "/home/user/.claude/settings.json"),
            { ...emptyScope("project", PROJECT_PATH), parseError: PARSE_REASON },
            emptyScope("local", "/home/user/acme/.claude/settings.local.json"),
          ],
          installed: [
            {
              name: "optbot",
              source: PLUGIN_ID,
              path: "/home/user/.claude/plugins/cache/test-mkt/optbot",
              userConfig: [{ name: "verbose", type: "boolean", title: "verbose", default: false }],
            },
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

  await page.goto("/plugins");
  await page.getByTestId("plugin-scope-tab-project").click();
  await expect(page.getByTestId("plugin-settings-invalid")).toContainText("changing plugin options");
  await page.getByRole("button", { name: /optbot/ }).click();
  const opt = page.getByTestId("plugin-option-verbose");
  await expect(opt).toBeVisible();
  await opt.click();

  const err = page.getByTestId("plugin-option-error");
  await expect(err).toBeVisible();
  await expect(err).toContainText("The file was not changed.");
  await expect(opt).not.toBeChecked();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    kind: "plugin-config",
    scope: "project",
    pluginId: PLUGIN_ID,
    name: "verbose",
    value: true,
  });
});
