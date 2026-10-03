/**
 * SDK 0.3.283 — added a `maxProseWidth` setting: "Maximum width, in terminal
 * columns, of the prose in Claude's responses (paragraphs, headings, lists,
 * blockquotes). In a wider terminal the prose wraps at this width while tables
 * and code blocks keep the full width; only the display wraps… Minimum 40.
 * Unset (the default) uses the full terminal width."
 *
 * This is a config-passthrough field the bundled `claude` binary reads
 * straight out of `~/.claude/settings.json` — exactly the shape `timeFormat`,
 * `bashOutputMaxChars`, and `keybindingFlavor` already cover via the generic
 * `SDK_SETTINGS_CATALOG` on `/settings`. Surfacing it as a number catalog row
 * in the "Display" section (next to `timeFormat`/`timeZone`) is the
 * browser-side equivalent Claudius needs; its own prose wraps with CSS and is
 * unaffected by this key.
 *
 * NOTE: the 0.3.283 run-notes claimed this row was already shipped — it was
 * never committed (a phantom-implementation note). This spec covers the real
 * build.
 *
 * This spec drives the new number row through the Settings UI and asserts it
 * round-trips through the settings API.
 *
 * Screenshot target: docs/sdk-updates/0.3.283/max-prose-width-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.283");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

/** Drop the key from the shared dev fixture so every run starts from "unset". */
async function clearMaxProseWidth(page: Page): Promise<void> {
  const settings = await readUserSettings(page);
  const rest = { ...settings };
  delete rest.maxProseWidth;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearMaxProseWidth(page);
});

test.afterEach(async ({ page }) => {
  await clearMaxProseWidth(page);
});

test.describe("maxProseWidth settings row (SDK 0.3.283)", () => {
  test("renders as a number row in the Display section and round-trips through the settings API", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("maxProseWidth");

    const row = page.getByTestId("catalog-field-maxProseWidth");
    await expect(row).toBeVisible({ timeout: 15_000 });

    const input = row.locator('input[type="number"]');
    // Unset reads as empty, not an explicit 0 — "full terminal width" default.
    await expect(input).toHaveValue("");

    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "max-prose-width-settings.png"),
      fullPage: false,
    });

    await input.fill("100");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readUserSettings(page)).maxProseWidth, { timeout: 10_000 })
      .toBe(100);

    // Clearing the field deletes the key rather than writing 0.
    await page.getByLabel("Search settings").fill("maxProseWidth");
    const rowAfterSave = page.getByTestId("catalog-field-maxProseWidth");
    await expect(rowAfterSave).toBeVisible();
    await rowAfterSave.locator('input[type="number"]').fill("");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => "maxProseWidth" in (await readUserSettings(page)), { timeout: 10_000 })
      .toBe(false);
  });
});
