/**
 * SDK 0.3.312 — new auto-mode settings keys:
 *   - `autoMode.classifyAllShell`  → checkbox on /permissions → Auto mode tab
 *   - `skipAutoPermissionPrompt`   → boolean row on /settings (Permissions)
 *   - `useAutoModeDuringPlan`      → boolean row on /settings (Permissions)
 *
 * The /permissions half mocks the settings endpoints (never touches the dev
 * fixture's settings.json); the /settings half round-trips the real API and
 * restores the fixture afterwards.
 *
 * Screenshots: docs/sdk-updates/0.3.312/{auto-mode-classify-all-shell,auto-mode-settings-rows}.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.312");
mkdirSync(SHOTS_DIR, { recursive: true });

const EMPTY_RULES = { allow: [], ask: [], deny: [] };

test.describe("classifyAllShell on the /permissions Auto mode tab (SDK 0.3.312)", () => {
  test("renders the toggle, reflects loaded state, and saves a boolean patch", async ({ page }) => {
    let lastPatch: unknown = null;
    let autoModeConfig: Record<string, unknown> = { allow: ["$defaults"] };

    await page.route("**/api/settings/permissions**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ user: EMPTY_RULES, project: EMPTY_RULES, local: EMPTY_RULES }),
        });
      }
      return route.fallback();
    });
    await page.route("**/api/settings/auto-mode**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ autoMode: autoModeConfig }),
        });
      }
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { patch: Record<string, unknown> };
        lastPatch = body.patch;
        autoModeConfig = { ...autoModeConfig, ...body.patch };
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, autoMode: autoModeConfig }),
        });
      }
      return route.fallback();
    });
    await page.route("**/api/sessions**", async (route: Route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      return route.fallback();
    });

    await page.goto("/permissions");
    const autoModeTabButton = page.getByTestId("permissions-tab-auto-mode");
    await expect(async () => {
      await page.getByRole("radio", { name: "Account" }).click();
      await expect(autoModeTabButton).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await autoModeTabButton.click();

    const toggle = page.getByTestId("auto-mode-classify-all-shell");
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect.poll(() => lastPatch).toEqual({ classifyAllShell: true });
    await expect(toggle).toBeChecked();
    // A saved boolean counts as non-default config → Reset becomes available.
    await expect(page.getByTestId("auto-mode-reset")).toBeEnabled();

    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "auto-mode-classify-all-shell.png"),
      fullPage: false,
    });
  });
});

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  return ((await res.json()) as { settings: UserSettings }).settings;
}

async function clearKeys(page: Page): Promise<void> {
  const rest = { ...(await readUserSettings(page)) };
  delete rest.skipAutoPermissionPrompt;
  delete rest.useAutoModeDuringPlan;
  await page.request.put("/api/settings/full", { data: { scope: "user", settings: rest } });
}

test.describe("auto-mode boolean rows on /settings (SDK 0.3.312)", () => {
  test.beforeEach(async ({ page }) => {
    await activateClaudiusWorkspace(page);
    await clearKeys(page);
  });
  test.afterEach(async ({ page }) => {
    await clearKeys(page);
  });

  test("skipAutoPermissionPrompt and useAutoModeDuringPlan render and round-trip", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("auto");

    const skipRow = page.getByTestId("catalog-field-skipAutoPermissionPrompt");
    const planRow = page.getByTestId("catalog-field-useAutoModeDuringPlan");
    await expect(skipRow).toBeVisible({ timeout: 15_000 });
    await expect(planRow).toBeVisible();
    await expect(skipRow.locator("select")).toHaveValue("");
    await expect(planRow.locator("select")).toHaveValue("");

    await skipRow.locator("select").selectOption("true");
    await planRow.locator("select").selectOption("false");

    await skipRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "auto-mode-settings-rows.png"),
      fullPage: false,
    });

    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect
      .poll(async () => {
        const s = await readUserSettings(page);
        return [s.skipAutoPermissionPrompt, s.useAutoModeDuringPlan];
      }, { timeout: 10_000 })
      .toEqual([true, false]);
  });
});
