/**
 * SDK 0.3.319 — added two top-level boolean settings the bundled `claude`
 * binary reads straight from settings.json: `disableWindowsBashCommandSplit`
 * (Shell) and `disableReplyCheck` (Claude Tag reply check). Both are surfaced
 * as boolean rows in the generic `SDK_SETTINGS_CATALOG` on `/settings`.
 *
 * Screenshot target: docs/sdk-updates/0.3.319/shell-reply-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.319");
mkdirSync(SHOTS_DIR, { recursive: true });

const KEYS = ["disableWindowsBashCommandSplit", "disableReplyCheck"] as const;

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

async function clearKeys(page: Page): Promise<void> {
  const rest = { ...(await readUserSettings(page)) };
  for (const k of KEYS) delete rest[k];
  await page.request.put("/api/settings/full", { data: { scope: "user", settings: rest } });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearKeys(page);
});

test.afterEach(async ({ page }) => {
  await clearKeys(page);
});

test.describe("0.3.319 boolean settings rows", () => {
  test("disableWindowsBashCommandSplit and disableReplyCheck render and round-trip", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("disableWindowsBashCommandSplit");
    const shellRow = page.getByTestId("catalog-field-disableWindowsBashCommandSplit");
    await expect(shellRow).toBeVisible({ timeout: 15_000 });
    await expect(shellRow.locator("select")).toHaveValue("");
    await expect(shellRow.locator("select option")).toHaveText(["Default", "On (true)", "Off (false)"]);

    await shellRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "shell-reply-settings.png"), fullPage: false });

    await shellRow.locator("select").selectOption("true");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect
      .poll(async () => (await readUserSettings(page)).disableWindowsBashCommandSplit, { timeout: 10_000 })
      .toBe(true);

    await page.getByLabel("Search settings").fill("disableReplyCheck");
    const replyRow = page.getByTestId("catalog-field-disableReplyCheck");
    await expect(replyRow).toBeVisible();
    await expect(replyRow.locator("select")).toHaveValue("");
    await replyRow.locator("select").selectOption("true");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect
      .poll(async () => (await readUserSettings(page)).disableReplyCheck, { timeout: 10_000 })
      .toBe(true);
  });
});
