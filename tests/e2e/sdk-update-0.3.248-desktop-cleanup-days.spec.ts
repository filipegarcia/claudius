/**
 * SDK 0.3.248 — `Settings.desktopSessionCleanupPeriodDays` bounds retention
 * for session transcripts written by a desktop-host surface (Claude
 * Desktop, Cowork), which are otherwise exempt from the `cleanupPeriodDays`
 * sweep. It doesn't appear in the upstream prose changelog for this window
 * (a one-line bullet about a per-server MCP timeout) — it was found by
 * diffing `sdk.d.ts`.
 *
 * Claudius isn't a desktop-host surface itself, so this key never governs
 * Claudius's own transcript cleanup (that's still `cleanupPeriodDays`,
 * right above it in the same "Storage & sessions" section). It's surfaced
 * here purely as a `settings.json` passthrough for a user who also runs
 * one of those other hosts against the same config file — same
 * discoverability rationale as the 0.3.245 `promptCacheTtl` rows this spec
 * is modeled on.
 *
 * This spec drives the new number field through the generic SDK-settings
 * catalog on `/settings` (Storage & sessions section) and asserts it
 * round-trips through the settings API.
 *
 * Screenshot target: docs/sdk-updates/0.3.248/desktop-cleanup-days-settings.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.248");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

/**
 * Drop the key from the shared dev fixture's user-scope settings so the
 * spec starts from "Default" regardless of what a previous run left behind.
 */
async function clearSetting(page: Page): Promise<void> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  const rest = { ...body.settings };
  delete rest.desktopSessionCleanupPeriodDays;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

async function readSetting(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearSetting(page);
});

test.afterEach(async ({ page }) => {
  await clearSetting(page);
});

test.describe("desktopSessionCleanupPeriodDays setting (SDK 0.3.248)", () => {
  test("renders as a number row in Storage & sessions and round-trips through the settings API", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("desktopSessionCleanupPeriodDays");

    const field = page.getByTestId("catalog-field-desktopSessionCleanupPeriodDays");
    await expect(field).toBeVisible({ timeout: 15_000 });

    // Unset means "no ceiling" — the SDK's own default — so the row must
    // read as Default, not as a silently-applied 0.
    await expect(field.getByText("default", { exact: true })).toBeVisible();
    await expect(field.locator("input")).toHaveValue("");

    await field.locator("input").fill("14");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readSetting(page)).desktopSessionCleanupPeriodDays, {
        timeout: 10_000,
      })
      .toBe(14);

    // Saving triggers a settings refetch that resets the search box (a
    // pre-existing quirk of the page) — re-apply the filter so the shot
    // shows the row in its section rather than the top of an unfiltered
    // page full of every other catalog entry.
    await page.getByLabel("Search settings").fill("desktopSessionCleanupPeriodDays");
    await expect(field).toBeVisible();
    await expect(field.locator("input")).toHaveValue("14");
    await expect(field.getByText("overridden", { exact: true })).toBeVisible();
    await page.waitForTimeout(200);

    await page.screenshot({
      path: resolve(SHOTS_DIR, "desktop-cleanup-days-settings.png"),
      fullPage: false,
    });
  });

  test("clearing the row removes the key rather than writing 0", async ({ page }) => {
    // 0 is a meaningful value for this field (it's the SDK's own "no
    // ceiling" default) but Claudius must still distinguish "unset" from
    // "explicitly 0" — clearing the input has to delete the key, not write
    // a 0 that would look identical to the default but isn't.
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("desktopSessionCleanupPeriodDays");
    const field = page.getByTestId("catalog-field-desktopSessionCleanupPeriodDays");
    await expect(field).toBeVisible({ timeout: 15_000 });

    await field.locator("input").fill("30");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect
      .poll(async () => (await readSetting(page)).desktopSessionCleanupPeriodDays, {
        timeout: 10_000,
      })
      .toBe(30);

    await page.getByLabel("Search settings").fill("desktopSessionCleanupPeriodDays");
    await expect(field).toBeVisible();
    await field.locator("input").fill("");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => "desktopSessionCleanupPeriodDays" in (await readSetting(page)), {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
