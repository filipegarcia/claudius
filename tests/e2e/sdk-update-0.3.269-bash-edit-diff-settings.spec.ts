/**
 * SDK 0.3.269 — added a `bashEditDiffEnabled` setting: "Whether the Bash
 * tool shows a diff of the files a Bash command changed (PostToolUse Bash
 * hooks get the changed-file list in tool_response). Set to false to turn
 * that off. Default: on when the Bash tool handles file edits. Only user,
 * flag or policy settings can turn it on outside auto and bypassPermissions
 * modes."
 *
 * This is a config-passthrough field the bundled `claude` binary reads
 * straight out of `~/.claude/settings.json` — exactly the shape
 * `defaultShell`, `bashOutputMaxChars`, and `keybindingFlavor` already cover
 * via the generic `SDK_SETTINGS_CATALOG` on `/settings`. Surfacing it as a
 * boolean catalog row (next to `defaultShell` in the "Shell" section) is
 * the browser-side equivalent Claudius needs; see the 0.3.269 run-notes for
 * why the rest of this release's changelog/type-surface items have no
 * browser surface to add.
 *
 * This spec drives the new boolean row through the Settings UI and asserts
 * it round-trips through the settings API.
 *
 * Screenshot target: docs/sdk-updates/0.3.269/bash-edit-diff-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.269");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

/** Drop the key from the shared dev fixture's user-scope settings so every run starts from "Default". */
async function clearBashEditDiffEnabled(page: Page): Promise<void> {
  const settings = await readUserSettings(page);
  const rest = { ...settings };
  delete rest.bashEditDiffEnabled;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearBashEditDiffEnabled(page);
});

test.afterEach(async ({ page }) => {
  await clearBashEditDiffEnabled(page);
});

test.describe("bashEditDiffEnabled settings row (SDK 0.3.269)", () => {
  test("renders as a boolean row in the Shell section and round-trips through the settings API", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("bashEditDiffEnabled");

    const row = page.getByTestId("catalog-field-bashEditDiffEnabled");
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Absent means "on when the Bash tool handles file edits" (upstream's
    // own default) — the unset state must read as Default, not as an
    // explicit true/false.
    await expect(row.locator("select")).toHaveValue("");
    await expect(row.locator("select option")).toHaveText(["Default", "On (true)", "Off (false)"]);

    // Screenshot in context: full Settings page chrome (side nav, search
    // box) with the new row visible in its Shell section.
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "bash-edit-diff-settings.png"),
      fullPage: false,
    });

    await row.locator("select").selectOption("false");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readUserSettings(page)).bashEditDiffEnabled, { timeout: 10_000 })
      .toBe(false);

    // "Default" must delete the key rather than write `true` explicitly.
    await page.getByLabel("Search settings").fill("bashEditDiffEnabled");
    const rowAfterSave = page.getByTestId("catalog-field-bashEditDiffEnabled");
    await expect(rowAfterSave).toBeVisible();
    await rowAfterSave.locator("select").selectOption("");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => "bashEditDiffEnabled" in (await readUserSettings(page)), {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
