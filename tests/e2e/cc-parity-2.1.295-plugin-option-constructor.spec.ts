/**
 * Claude Code 2.1.295 parity — "Fixed plugin options named constructor or
 * prototype always reading as their default and never reloading the plugin
 * when edited".
 *
 * Claudius's plugin options form looked values up with `name in values` on a
 * plain JSON-parsed object, so an unset option named `constructor` resolved
 * to `Object.prototype.constructor` (a function) instead of its manifest
 * default — a boolean defaulting to true rendered unchecked. The form now uses
 * an own-key lookup (`currentOptionValue`).
 *
 * `/api/plugins` is mocked (GET payload + POST capture) — nothing is written
 * to disk. The installed plugin declares a boolean `constructor` (default
 * true) and a string `prototype` (default "abc"); the spec expands its row,
 * asserts both read their defaults, then unchecks `constructor` and asserts
 * the POST carries `false` and the refreshed form reads it back unchecked.
 *
 * Screenshot target: docs/cc-parity/2.1.295/plugin-option-constructor.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.295");
mkdirSync(SHOTS_DIR, { recursive: true });

const PLUGIN_ID = "optbot@test-mkt";

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
  // Stored option values for the user scope; the POST handler updates it so
  // the post-save refresh reads the edit back.
  let userOptions: Record<string, unknown> = {};
  // A predicate (not `**/api/plugins?*`) so the query-less POST is caught too.
  await page.route(
    (url) => url.pathname === "/api/plugins",
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = req.postDataJSON() as Record<string, unknown>;
        posts.push(body);
        if (body.kind === "plugin-config" && typeof body.name === "string") {
          userOptions = { ...userOptions, [body.name]: body.value };
        }
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cwd: process.cwd(),
          scopes: [
            {
              ...emptyScope("user", "/home/user/.claude/settings.json"),
              enabledPlugins: { [PLUGIN_ID]: true },
              pluginConfigs:
                Object.keys(userOptions).length > 0 ? { [PLUGIN_ID]: { options: userOptions } } : {},
            },
            emptyScope("project", "/home/user/acme/.claude/settings.json"),
            emptyScope("local", "/home/user/acme/.claude/settings.local.json"),
          ],
          installed: [
            {
              name: "optbot",
              source: PLUGIN_ID,
              path: "/home/user/.claude/plugins/cache/test-mkt/optbot",
              version: "1.0.0",
              description: "Declares options whose names collide with Object.prototype keys.",
              userConfig: [
                {
                  name: "constructor",
                  type: "boolean",
                  title: "constructor",
                  description: "Boolean option, defaults to true.",
                  default: true,
                },
                {
                  name: "prototype",
                  type: "string",
                  title: "prototype",
                  description: 'String option, defaults to "abc".',
                  default: "abc",
                },
              ],
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
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("plugin options named constructor / prototype read their defaults and save edits", async ({
  page,
}) => {
  const posts: Array<Record<string, unknown>> = [];
  await mockPluginsBackend(page, posts);
  await page.goto("/plugins");

  const rowButton = page.getByRole("button", { name: /optbot/ });
  await expect(rowButton).toBeVisible({ timeout: 15_000 });
  await rowButton.click();

  const ctor = page.getByTestId("plugin-option-constructor");
  const proto = page.getByTestId("plugin-option-prototype");
  await expect(ctor).toBeVisible();
  // Unset → the manifest default (true), not Object.prototype.constructor.
  await expect(ctor).toBeChecked();
  await expect(proto).toHaveValue("abc");

  // Editing persists the real value and the refreshed form reads it back.
  await ctor.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({
    kind: "plugin-config",
    scope: "user",
    pluginId: PLUGIN_ID,
    name: "constructor",
    value: false,
  });
  await expect(ctor).not.toBeChecked();

  // Back to the default state for the screenshot.
  await ctor.click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ name: "constructor", value: true });
  await expect(ctor).toBeChecked();

  // Center the options form so the row header and both controls are in frame.
  await ctor.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await page.screenshot({
    path: resolve(SHOTS_DIR, "plugin-option-constructor.png"),
    fullPage: false,
  });
});
