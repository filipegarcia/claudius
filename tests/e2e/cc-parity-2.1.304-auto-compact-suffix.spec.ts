/**
 * CC 2.1.304 — "Fixed `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200k` silently setting
 * a 100K window: the variable now accepts `k` and `M` suffixes like
 * `--autocompact`, and warns when a value is out of range or ignored."
 *
 * Claudius has its own editor for the same window: the `autoCompactWindow`
 * catalog field on /settings (top-level value + per-model overrides under
 * `modelSettings.<model>.autoCompactWindow`). Before this change it dropped
 * `200k` without a word: the top-level input was `type="number"` and the
 * per-model parser returned "ignore". This spec checks that:
 *   1. `200k` (top-level) and `300k` (per-model) save as 200000 / 300000;
 *   2. a value that doesn't parse shows an "ignored" warning, and an
 *      out-of-range one an "out of range" warning, under the input.
 *
 * Screenshot target: docs/cc-parity/2.1.304/auto-compact-suffix.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.304");
mkdirSync(SHOTS_DIR, { recursive: true });

const MODEL = "claude-e2e-compact-suffix";

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

let snapshot: { autoCompactWindow: unknown; modelSettings: unknown } | null = null;

async function restore(page: Page): Promise<void> {
  const settings = await readUserSettings(page);
  const next = { ...settings };
  delete next.autoCompactWindow;
  delete next.modelSettings;
  if (snapshot?.autoCompactWindow !== undefined) next.autoCompactWindow = snapshot.autoCompactWindow;
  if (snapshot?.modelSettings !== undefined) next.modelSettings = snapshot.modelSettings;
  await page.request.put("/api/settings/full", { data: { scope: "user", settings: next } });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  const settings = await readUserSettings(page);
  snapshot = { autoCompactWindow: settings.autoCompactWindow, modelSettings: settings.modelSettings };
  // Start with no top-level window so the field begins empty.
  const next = { ...settings };
  delete next.autoCompactWindow;
  await page.request.put("/api/settings/full", { data: { scope: "user", settings: next } });
});

test.afterEach(async ({ page }) => {
  await restore(page);
});

test.describe("autoCompactWindow k/M suffixes (CC 2.1.304)", () => {
  test("200k / 300k save as token counts; bad values warn instead of vanishing", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("autoCompactWindow");

    const field = page.getByTestId("catalog-field-autoCompactWindow");
    await expect(field).toBeVisible({ timeout: 15_000 });
    await expect(field).toContainText("k and M suffixes work");

    // Top-level: `200k` is accepted (this was impossible with type="number").
    await field.getByTestId("auto-compact-window-top").fill("200k");
    await expect(field.getByTestId("auto-compact-window-top-warning")).toHaveCount(0);

    // Per-model: `300k` enables the add button and saves as 300000.
    await field.getByTestId("auto-compact-window-new-model").fill(MODEL);
    await field.getByTestId("auto-compact-window-new-window").fill("300k");
    await expect(field.getByTestId("auto-compact-window-add")).toBeEnabled();
    await field.getByTestId("auto-compact-window-add").click();

    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect
      .poll(async () => await readUserSettings(page), { timeout: 10_000 })
      .toMatchObject({
        autoCompactWindow: 200_000,
        modelSettings: { [MODEL]: { autoCompactWindow: 300_000 } },
      });

    // Saving resets the search box — filter back to the field.
    await page.getByLabel("Search settings").fill("autoCompactWindow");
    await expect(field).toBeVisible();
    await expect(field.getByTestId("auto-compact-window-top")).toHaveValue("200000");

    // A value that doesn't parse leaves the stored window alone, even if saved.
    await field.getByTestId("auto-compact-window-top").fill("200g");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForTimeout(500);
    expect((await readUserSettings(page)).autoCompactWindow).toBe(200_000);

    await page.getByLabel("Search settings").fill("autoCompactWindow");
    await expect(field).toBeVisible();

    // The "ignored" warning names the value the form still holds, and the text stays put.
    await field.getByTestId("auto-compact-window-top").fill("200g");
    const topWarning = field.getByTestId("auto-compact-window-top-warning");
    await expect(topWarning).toBeVisible();
    await expect(topWarning).toHaveAttribute("data-warning-kind", "ignored");
    await expect(topWarning).toContainText("ignored — the window stays 200,000");
    await expect(field.getByTestId("auto-compact-window-top")).toHaveValue("200g");

    // Typing key by key commits each prefix that parses (9, then 90) before the
    // bad `x`. The warning must say the form holds 90, and flag it as out of range.
    const row = field.locator("li", { hasText: MODEL });
    const rowInput = row.getByTestId("auto-compact-window-model-input");
    await rowInput.fill("");
    await rowInput.pressSequentially("90x");
    const rowWarning = row.getByTestId("auto-compact-window-model-warning");
    await expect(rowWarning).toHaveAttribute("data-warning-kind", "ignored");
    await expect(rowWarning).toContainText("the window stays 90.");
    await expect(rowWarning).toContainText("outside 100,000");

    // A suffixed value outside 100k–1M on the per-model row: "out of range".
    await rowInput.fill("50k");
    await expect(rowWarning).toBeVisible();
    await expect(rowWarning).toHaveAttribute("data-warning-kind", "out-of-range");
    await expect(rowWarning).toContainText("Outside 100,000");

    await field.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "auto-compact-suffix.png"),
      fullPage: false,
    });
  });
});
