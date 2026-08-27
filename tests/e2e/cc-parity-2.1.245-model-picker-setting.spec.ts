/**
 * CC 2.1.243 — "Added `modelPicker` setting: curate the `/model` picker
 * with an ordered, labeled list of models (any id spelling, including
 * Vertex/Bedrock ids), appended to or replacing the built-in lineup."
 *
 * Claudius already has its own model-list surfaces (`ModelPicker.tsx`,
 * `/api/models`, `/api/sessions/[id]/model`) built on the SDK's
 * `supportedModels()`. This is a settings-driven post-process on the list
 * those routes already build — see `lib/server/model-picker-curation.ts`.
 * The Settings UI gets a bespoke list editor (`ModelPickerCatalogField`)
 * rather than the generic scalar catalog row, since the value is a
 * structured `{mode, entries[]}` object — same treatment as `advisorModel`.
 *
 * This spec drives the real editor through the Settings UI, asserts it
 * round-trips through the settings API, and confirms `/api/models`
 * actually reflects the curated entry (proving the wiring, not just the
 * form).
 *
 * Screenshot target: docs/cc-parity/2.1.245/model-picker-setting.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.245");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

async function clearModelPicker(page: Page): Promise<void> {
  const settings = await readUserSettings(page);
  const rest = { ...settings };
  delete rest.modelPicker;
  await page.request.put("/api/settings/full", { data: { scope: "user", settings: rest } });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearModelPicker(page);
});

test.afterEach(async ({ page }) => {
  await clearModelPicker(page);
});

test.describe("modelPicker settings (CC 2.1.243)", () => {
  test("curated entries round-trip through settings and reach /api/models", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("modelPicker");

    const field = page.getByTestId("catalog-field-modelPicker");
    await expect(field).toBeVisible({ timeout: 15_000 });
    // Starts unset — "Default" (no curation applied).
    await expect(field).toContainText("default");

    await field.getByTestId("model-picker-add-entry").click();
    await field.getByTestId("model-picker-entry-id").fill("bedrock:anthropic.claude-opus-4-8");
    await field.getByTestId("model-picker-entry-label").fill("Org Opus (Bedrock)");

    await field.getByTestId("model-picker-add-entry").click();
    const idInputs = field.getByTestId("model-picker-entry-id");
    const labelInputs = field.getByTestId("model-picker-entry-label");
    await idInputs.nth(1).fill("vertex:claude-haiku-4-5");
    await labelInputs.nth(1).fill("House Haiku (Vertex)");

    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => await readUserSettings(page), { timeout: 10_000 })
      .toMatchObject({
        // `mode` is never touched in this test, so it stays absent
        // (append is the implicit default — see model-picker-curation.ts).
        modelPicker: {
          entries: [
            { id: "bedrock:anthropic.claude-opus-4-8", label: "Org Opus (Bedrock)" },
            { id: "vertex:claude-haiku-4-5", label: "House Haiku (Vertex)" },
          ],
        },
      });

    // Prove the setting actually reaches the model list, not just the
    // settings store — this is the part that would silently drift if the
    // curation call were wired into the wrong route.
    const models = await page.request
      .get("/api/models")
      .then((r) => r.json() as Promise<{ models: Array<{ value: string; displayName: string }> }>);
    expect(models.models).toContainEqual(
      expect.objectContaining({
        value: "bedrock:anthropic.claude-opus-4-8",
        displayName: "Org Opus (Bedrock)",
      }),
    );

    // Re-apply the filter (saving resets the search box) and shoot the
    // Settings page with the two curated rows visible, in context — the
    // surrounding Settings chrome (side nav, search, section header).
    await page.getByLabel("Search settings").fill("modelPicker");
    await expect(field).toBeVisible();
    await expect(field.getByTestId("model-picker-entry-id")).toHaveCount(2);
    await page.waitForTimeout(200);

    await page.screenshot({
      path: resolve(SHOTS_DIR, "model-picker-setting.png"),
      fullPage: false,
    });
  });

  test("replace mode is persisted distinctly from append", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("modelPicker");
    const field = page.getByTestId("catalog-field-modelPicker");
    await expect(field).toBeVisible({ timeout: 15_000 });

    await field.getByTestId("model-picker-mode").selectOption("replace");
    await field.getByTestId("model-picker-add-entry").click();
    await field.getByTestId("model-picker-entry-id").fill("claude-opus-4-8");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(async () => (await readUserSettings(page)).modelPicker, { timeout: 10_000 })
      .toMatchObject({ mode: "replace", entries: [{ id: "claude-opus-4-8" }] });
  });
});
