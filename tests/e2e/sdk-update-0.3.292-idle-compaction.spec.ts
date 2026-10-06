/**
 * SDK 0.3.292 — new `Settings.idleCompaction` (set false to stop Claude Code
 * compacting a long conversation while idle). Surfaced as a catalog row in
 * Settings → Model & behavior; round-trips through the settings API.
 *
 * Screenshot target: docs/sdk-updates/0.3.292/idle-compaction-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.292");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

async function clearSetting(page: Page): Promise<void> {
  const rest = { ...(await readUserSettings(page)) };
  delete rest.idleCompaction;
  await page.request.put("/api/settings/full", { data: { scope: "user", settings: rest } });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearSetting(page);
});

test.afterEach(async ({ page }) => {
  await clearSetting(page);
});

test.describe("idleCompaction settings row (SDK 0.3.292)", () => {
  test("renders as Default and round-trips false through the settings API", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("idleCompaction");

    const row = page.getByTestId("catalog-field-idleCompaction").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const select = row.locator("select");
    await expect(select).toHaveValue("");

    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "idle-compaction-settings.png"),
      fullPage: false,
    });

    await select.selectOption("false");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect
      .poll(async () => (await readUserSettings(page)).idleCompaction, { timeout: 10_000 })
      .toBe(false);
  });
});
