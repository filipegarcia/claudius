/**
 * Claude Code 2.1.275 — "Added syncing of the skills and plugins enabled on
 * your claude.ai account to terminal sessions signed in with it; opt out
 * with `syncClaudeAiSkills: false` or `syncClaudeAiPlugins: false`."
 *
 * Claudius already shipped `syncClaudeAiPlugins` as a toggle in the
 * Settings "Plugins" card (SDK 0.3.246 run) — that run's own notes named
 * the sibling `syncClaudeAiSkills` key as a known, not-yet-surfaced
 * follow-up. This release's changelog entry is what finally exercises it
 * upstream, so this closes the gap: same config-passthrough shape (only
 * `false` is honored, the bundled `claude` binary reads the key straight
 * from `~/.claude/settings.json`, no per-session SDK forwarding needed),
 * added right next to `syncClaudeAiPlugins` in the same card.
 *
 * This spec mirrors `sdk-update-0.3.246-sync-claude-ai-plugins.spec.ts`
 * exactly, for the new key.
 *
 * Screenshot target: docs/cc-parity/2.1.275/sync-claude-ai-skills-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.275");
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
  delete rest.syncClaudeAiSkills;
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

test.describe("syncClaudeAiSkills settings toggle (CC 2.1.275)", () => {
  test("renders checked by default next to syncClaudeAiPlugins and round-trips through the settings API", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("syncClaudeAiSkills");

    const row = page.locator("label", { hasText: "syncClaudeAiSkills" }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const checkbox = row.locator('input[type="checkbox"]');

    // Absent means "on" — only `false` is honored — so the unset state
    // must render checked, not indeterminate/off.
    await expect(checkbox).toBeChecked();

    // Search for the shared "plugins" keyword so both toggles render
    // together in the same card — the screenshot shows the new row in the
    // context its sibling already established.
    await page.getByLabel("Search settings").fill("sync claude.ai");
    await expect(page.locator("label", { hasText: "syncClaudeAiPlugins" }).first()).toBeVisible();
    await expect(page.locator("label", { hasText: "syncClaudeAiSkills" }).first()).toBeVisible();

    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "sync-claude-ai-skills-settings.png"),
      fullPage: false,
    });

    await page.getByLabel("Search settings").fill("syncClaudeAiSkills");
    const rowAgain = page.locator("label", { hasText: "syncClaudeAiSkills" }).first();
    await rowAgain.locator('input[type="checkbox"]').uncheck();
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readUserSettings(page)).syncClaudeAiSkills, { timeout: 10_000 })
      .toBe(false);

    // Flipping back to "Default" must delete the key rather than write
    // `true` — the SDK doesn't honor an explicit `true` any earlier than
    // the account's own server-side flag does.
    await page.getByLabel("Search settings").fill("syncClaudeAiSkills");
    const rowAfterSave = page.locator("label", { hasText: "syncClaudeAiSkills" }).first();
    await expect(rowAfterSave).toBeVisible();
    await rowAfterSave.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => "syncClaudeAiSkills" in (await readUserSettings(page)), {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
