/**
 * CC 2.1.271 — "Added support for a multiplier above 1, up to 10, in the
 * modelPricing managed setting and the Claude apps gateway pricing block,
 * for marked-up internal chargeback rates."
 *
 * Claudius already reimplements `modelPricing` end-to-end from CC 2.1.243
 * (`lib/server/model-pricing-override.ts`, the `ModelPricingCatalogField`
 * editor in Settings) but scoped the field to a *discount* (< 1) framing.
 * This release extends the field to also support markup, up to 10x,
 * relabelling "Discount multiplier" -> "Pricing multiplier".
 *
 * The field itself commits whatever's typed, unclamped — same as every
 * sibling numeric input in this catalog, and necessary because a *managed*
 * settings.json can set `discountMultiplier` directly, outside this UI
 * entirely. Silently rewriting an out-of-range value in place would hide
 * what was actually configured. Instead, a value above
 * `MODEL_PRICING_MULTIPLIER_MAX` (or <= 0) surfaces an inline "Effective: …"
 * warning, and `applyModelPricing` (`lib/server/model-pricing-override.ts`)
 * is the one place that actually enforces the ceiling — covered separately
 * by the unit tests in `tests/unit/model-pricing-override.test.ts`.
 *
 * This spec drives the real Settings editor: confirms the raw value
 * round-trips through the settings store even above the ceiling, confirms
 * the warning appears/disappears correctly, and confirms an ordinary sub-1
 * discount still round-trips unchanged (no regression on the original
 * 2.1.243 use case).
 *
 * Screenshot target: docs/cc-parity/2.1.271/model-pricing-multiplier.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.271");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

async function clearModelPricing(page: Page): Promise<void> {
  const settings = await readUserSettings(page);
  const rest = { ...settings };
  delete rest.modelPricing;
  await page.request.put("/api/settings/full", { data: { scope: "user", settings: rest } });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearModelPricing(page);
});

test.afterEach(async ({ page }) => {
  await clearModelPricing(page);
});

test.describe("modelPricing multiplier (CC 2.1.271)", () => {
  test("a markup multiplier above 10x round-trips raw and surfaces an 'Effective' warning", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("modelPricing");

    const field = page.getByTestId("catalog-field-modelPricing");
    await expect(field).toBeVisible({ timeout: 15_000 });
    await expect(field).toContainText("Pricing multiplier");
    await expect(field).toContainText("marked-up internal chargeback rate");

    const multiplier = field.getByTestId("model-pricing-discount");
    await multiplier.fill("25");
    // Committed raw, not silently rewritten — a managed settings.json could
    // have set this value directly, outside this field entirely.
    await expect(multiplier).toHaveValue("25");

    const warning = field.getByTestId("model-pricing-discount-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Effective: 10x");

    await page.getByRole("button", { name: /^Save$/ }).click();

    // The raw, above-ceiling value round-trips through the settings store —
    // the clamp is enforced only where cost is actually computed
    // (`applyModelPricing`), not by mangling what the user/admin configured.
    await expect
      .poll(async () => (await readUserSettings(page)).modelPricing, { timeout: 10_000 })
      .toMatchObject({ discountMultiplier: 25 });

    // Re-apply the filter (saving resets the search box) and shoot the
    // Settings page with the relabelled field + markup copy + warning
    // visible, in context (side nav, search box, section header).
    await page.getByLabel("Search settings").fill("modelPricing");
    await expect(field).toBeVisible();
    await expect(warning).toBeVisible();
    await page.waitForTimeout(200);

    await page.screenshot({
      path: resolve(SHOTS_DIR, "model-pricing-multiplier.png"),
      fullPage: false,
    });
  });

  test("an ordinary sub-1 discount still round-trips unchanged, no warning", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("modelPricing");

    const field = page.getByTestId("catalog-field-modelPricing");
    await expect(field).toBeVisible({ timeout: 15_000 });

    const multiplier = field.getByTestId("model-pricing-discount");
    await multiplier.fill("0.85");
    await expect(multiplier).toHaveValue("0.85");
    await expect(field.getByTestId("model-pricing-discount-warning")).toHaveCount(0);

    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readUserSettings(page)).modelPricing, { timeout: 10_000 })
      .toMatchObject({ discountMultiplier: 0.85 });
  });

  test("zero or negative surfaces the 'ignored' warning", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("modelPricing");

    const field = page.getByTestId("catalog-field-modelPricing");
    await expect(field).toBeVisible({ timeout: 15_000 });

    const multiplier = field.getByTestId("model-pricing-discount");
    await multiplier.fill("-2");

    const warning = field.getByTestId("model-pricing-discount-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("ignored");
  });
});
