/**
 * CC 2.1.238 — "Added a `keybindingFlavor` setting: set it to \"readline\"
 * to make Ctrl+W in the prompt delete back to the previous whitespace, as
 * in Bash; the default (\"classic\") is unchanged."
 *
 * This is a CLI-only line-editing behavior — Claudius's own browser
 * composer can't intercept Ctrl+W (browsers reserve it to close the tab
 * and refuse to let page JavaScript preventDefault it), so there's no
 * browser-side equivalent to build. But the underlying `keybindingFlavor`
 * key lives in the same `~/.claude/settings.json` Claudius already owns a
 * full editor for, and the bundled `claude` binary reads it straight from
 * that file — exactly the shape `defaultShell`, `promptCacheTtl`, and
 * `syncClaudeAiPlugins` already cover via the generic `SDK_SETTINGS_CATALOG`
 * on `/settings`. Surfacing it as a catalog row (next to `defaultShell` in
 * the "Shell" section) is the config-passthrough Claudius needs; see the
 * 2.1.238 run-notes classification for why this isn't a browser-behavior
 * feature.
 *
 * This spec drives the real enum row through the Settings UI and asserts
 * it round-trips through the settings API.
 *
 * Screenshot target: docs/cc-parity/2.1.238/keybinding-flavor-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.238");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

/** Drop the key from the shared dev fixture's user-scope settings so every run starts from "Default". */
async function clearKeybindingFlavor(page: Page): Promise<void> {
  const settings = await readUserSettings(page);
  const rest = { ...settings };
  delete rest.keybindingFlavor;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearKeybindingFlavor(page);
});

test.afterEach(async ({ page }) => {
  await clearKeybindingFlavor(page);
});

test.describe("keybindingFlavor settings row (CC 2.1.238)", () => {
  test("renders as an enum row in the Shell section and round-trips through the settings API", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("keybindingFlavor");

    const row = page.getByTestId("catalog-field-keybindingFlavor");
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Absent means "classic" (upstream's own default) — the unset state
    // must read as Default, not as a silently-applied "readline".
    await expect(row.locator("select")).toHaveValue("");
    await expect(row.locator("select option")).toHaveText(["Default", "classic", "readline"]);

    // Screenshot in context: full Settings page chrome (side nav, search
    // box) with the new row visible in its Shell section.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "keybinding-flavor-settings.png"),
      fullPage: false,
    });

    await row.locator("select").selectOption("readline");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readUserSettings(page)).keybindingFlavor, { timeout: 10_000 })
      .toBe("readline");

    // "Default" must delete the key rather than write "classic" explicitly.
    await page.getByLabel("Search settings").fill("keybindingFlavor");
    const rowAfterSave = page.getByTestId("catalog-field-keybindingFlavor");
    await expect(rowAfterSave).toBeVisible();
    await rowAfterSave.locator("select").selectOption("");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => "keybindingFlavor" in (await readUserSettings(page)), {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
