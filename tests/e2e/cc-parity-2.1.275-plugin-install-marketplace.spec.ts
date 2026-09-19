/**
 * Claude Code 2.1.275 — "Added `/plugin install <plugin> --marketplace
 * <source>`, which offers to add the marketplace before installing the
 * plugin."
 *
 * Claudius's `/plugins` Install form already sends `/plugin install <ref>`
 * to the live session as a passthrough — the SDK's own native slash-command
 * handling owns marketplace resolution, download, and registration, so
 * there's no Claudius-side logic to duplicate for the actual install. The
 * product-surface gap is discoverability: the form's own help text told
 * users to "Add custom marketplaces in the Marketplaces section below
 * *before* referencing plugins from them" — a manual two-step with no way
 * to type the one-step `--marketplace` form. This adds an optional
 * "marketplace source" field that composes into the same passthrough
 * command, plus a `plugin-ref-lint` carve-out so the two-token form doesn't
 * false-positive as "can't contain spaces".
 *
 * Screenshot target: docs/cc-parity/2.1.275/plugin-install-marketplace.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.275");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "dddddddd-1111-2222-3333-0000002753pl";

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
        ],
        installed: [],
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

  // A live session matching the active workspace's cwd — required for the
  // Install form/button to enable at all.
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: FAKE_SESSION_ID, cwd: process.cwd() }]),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Plugin install with an inline --marketplace source (CC 2.1.275 parity)", () => {
  test("filling the marketplace source composes it into the /plugin install command", async ({
    page,
  }) => {
    await mockPluginsBackend(page);

    const inputPost = page.waitForRequest(
      (req) =>
        req.url().includes(`/api/sessions/${FAKE_SESSION_ID}/input`) && req.method() === "POST",
    );
    await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto("/plugins");

    const refInput = page.getByPlaceholder("frontend-design@claude-plugins-official");
    await expect(refInput).toBeEnabled({ timeout: 15_000 });
    await refInput.fill("frontend-design");

    const marketplaceInput = page.getByTestId("plugin-install-marketplace-source");
    await expect(marketplaceInput).toBeVisible();
    await marketplaceInput.fill("anthropics/claude-plugins");

    // No lint warning for the valid two-token form.
    await expect(page.getByTestId("plugin-ref-warning")).toHaveCount(0);

    // Screenshot in context: the full Install card (heading, help text,
    // both inputs, buttons) before submitting.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "plugin-install-marketplace.png"),
      fullPage: false,
    });

    await page.getByRole("button", { name: /Install/ }).click();
    const req = await inputPost;
    expect(JSON.parse(req.postData() ?? "{}")).toMatchObject({
      text: "/plugin install frontend-design --marketplace anthropics/claude-plugins",
    });

    await expect(page.getByText(/Sent .*plugin install/)).toBeVisible();
  });

  test("leaving the marketplace source empty sends the plain ref, unchanged", async ({
    page,
  }) => {
    await mockPluginsBackend(page);

    const inputPost = page.waitForRequest(
      (req) =>
        req.url().includes(`/api/sessions/${FAKE_SESSION_ID}/input`) && req.method() === "POST",
    );
    await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto("/plugins");

    const refInput = page.getByPlaceholder("frontend-design@claude-plugins-official");
    await expect(refInput).toBeEnabled({ timeout: 15_000 });
    await refInput.fill("frontend-design@claude-plugins-official");
    await page.getByRole("button", { name: /Install/ }).click();

    const req = await inputPost;
    expect(JSON.parse(req.postData() ?? "{}")).toMatchObject({
      text: "/plugin install frontend-design@claude-plugins-official",
    });
  });
});
