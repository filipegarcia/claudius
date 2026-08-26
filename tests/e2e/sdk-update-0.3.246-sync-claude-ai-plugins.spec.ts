/**
 * SDK 0.3.246 — `Settings.syncClaudeAiPlugins` (boolean). Mirrors the
 * pre-existing `Settings.syncClaudeAiSkills` shape exactly: set to `false`
 * to stop syncing plugins enabled on claude.ai into every session. Only
 * `false` is honored — the feature is enabled server-side for the account,
 * so setting `true` here doesn't turn it on early — and the bundled `claude`
 * binary reads the key straight from the same `~/.claude/settings.json`
 * this page writes, so surfacing it as a toggle is all Claudius needs;
 * there is no per-session SDK forwarding to add.
 *
 * This field doesn't appear in the upstream prose changelog for 0.3.246 at
 * all — it was found by diffing `sdk.d.ts` against 0.3.245. It sits right
 * next to `Settings.enabledPlugins`, which Claudius already surfaces
 * (read-only) as a "Plugins" card on `/settings`, so the new toggle lives
 * in that same card rather than a new section.
 *
 * This spec drives the real toggle through the Settings UI and asserts it
 * round-trips through the settings API.
 *
 * Screenshot target: docs/sdk-updates/0.3.246/sync-claude-ai-plugins-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.246");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

/** Drop the key from the shared dev fixture's user-scope settings so every run starts from "Default". */
async function clearSyncSetting(page: Page): Promise<void> {
  const settings = await readUserSettings(page);
  const rest = { ...settings };
  delete rest.syncClaudeAiPlugins;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearSyncSetting(page);
});

test.afterEach(async ({ page }) => {
  await clearSyncSetting(page);
});

test.describe("syncClaudeAiPlugins settings toggle (SDK 0.3.246)", () => {
  test("renders checked by default in the Plugins card and round-trips through the settings API", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("syncClaudeAiPlugins");

    const row = page.locator("label", { hasText: "syncClaudeAiPlugins" }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const checkbox = row.locator('input[type="checkbox"]');

    // Absent means "on" — only `false` is honored per the SDK's contract —
    // so the unset state must render checked, not indeterminate/off.
    await expect(checkbox).toBeChecked();

    // Screenshot in context: full Settings page chrome (side nav, search
    // box, the pre-existing read-only enabledPlugins JSON panel) with the
    // new toggle visible beneath it in the same "Plugins" card.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "sync-claude-ai-plugins-settings.png"),
      fullPage: false,
    });

    await checkbox.uncheck();
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readUserSettings(page)).syncClaudeAiPlugins, { timeout: 10_000 })
      .toBe(false);

    // Flipping back to "Default" must delete the key rather than write `true`
    // — the SDK doesn't honor an explicit `true` any earlier than the
    // account's own server-side flag does.
    await page.getByLabel("Search settings").fill("syncClaudeAiPlugins");
    const rowAfterSave = page.locator("label", { hasText: "syncClaudeAiPlugins" }).first();
    await expect(rowAfterSave).toBeVisible();
    await rowAfterSave.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => "syncClaudeAiPlugins" in (await readUserSettings(page)), {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
