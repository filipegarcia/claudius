/**
 * Claude Code 2.1.295 parity — "Fixed the /advisor dialog showing a checkmark
 * on a saved advisor model that is no longer available; it now opens on
 * \"No advisor\"".
 *
 * Claudius's global Settings page renders `advisorModel` as a radio list and
 * used to force-add and check a Fable 5 row whenever the saved advisor was
 * Fable — even when a live session's model list said the account has no
 * Fable. It now opens on "No advisor" with a note naming the dropped model,
 * and leaves the saved value alone until the user picks a row. Without a live
 * list (`source: "fallback"`) it can't tell, so Fable stays checked.
 *
 * `/api/models` is mocked; the saved advisor lives in the isolated e2e HOME's
 * user settings.json and is removed again afterwards.
 *
 * Screenshot target: docs/cc-parity/2.1.295/advisor-unavailable.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.295");
mkdirSync(SHOTS_DIR, { recursive: true });

type UserSettings = Record<string, unknown>;

async function readUserSettings(page: Page): Promise<UserSettings> {
  const res = await page.request.get("/api/settings?scope=user");
  const body = (await res.json()) as { settings: UserSettings };
  return body.settings;
}

async function writeAdvisor(page: Page, advisorModel: string | undefined): Promise<void> {
  const rest = { ...(await readUserSettings(page)) };
  if (advisorModel === undefined) delete rest.advisorModel;
  else rest.advisorModel = advisorModel;
  const res = await page.request.put("/api/settings/full", { data: { scope: "user", settings: rest } });
  expect(res.ok(), "writing user settings").toBeTruthy();
}

async function mockModels(page: Page, source: "session" | "fallback"): Promise<void> {
  await page.route("**/api/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source,
        models: [
          { value: "opus", displayName: "Opus", description: "Most capable." },
          { value: "sonnet", displayName: "Sonnet", description: "Balanced." },
        ],
      }),
    }),
  );
}

async function openAdvisorField(page: Page) {
  const probed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/models");
  await page.goto("/settings");
  await probed;
  await page.getByLabel("Search settings").fill("advisorModel");
  const field = page.getByTestId("catalog-field-advisorModel");
  await expect(field).toBeVisible({ timeout: 20_000 });
  return field;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await writeAdvisor(page, "claude-fable-5");
});

test.afterEach(async ({ page }) => {
  await writeAdvisor(page, undefined);
});

test("a saved Fable advisor the live model list lacks opens on No advisor", async ({ page }) => {
  await mockModels(page, "session");
  const field = await openAdvisorField(page);

  const note = field.getByTestId("advisor-setting-unavailable");
  await expect(note).toBeVisible({ timeout: 15_000 });
  await expect(note).toHaveText(
    "Saved advisor Fable 5 isn't available to this account — pick another, or keep No advisor.",
  );

  await expect(field.getByTestId("advisor-setting-option")).toHaveCount(4);
  await expect(field.locator('[data-advisor="claude-fable-5"]')).toHaveCount(0);
  await expect(field.locator('[data-advisor="none"]')).toHaveAttribute("aria-checked", "true");
  await expect(field.locator('[aria-checked="true"]')).toHaveCount(1);
  // Not misfiled as a hand-edited "custom" advisor either.
  await expect(field.getByText("custom", { exact: true })).toHaveCount(0);

  await field.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "advisor-unavailable.png"), fullPage: false });

  // Opening the page doesn't rewrite the saved setting — only a click would.
  expect((await readUserSettings(page)).advisorModel).toBe("claude-fable-5");
});

test("without a live model list the saved Fable advisor stays checked", async ({ page }) => {
  await mockModels(page, "fallback");
  const field = await openAdvisorField(page);

  const fable = field.locator('[data-advisor="claude-fable-5"]');
  await expect(fable).toHaveAttribute("aria-checked", "true");
  await expect(field.locator('[data-advisor="none"]')).toHaveAttribute("aria-checked", "false");
  await expect(field.getByTestId("advisor-setting-unavailable")).toHaveCount(0);
});
