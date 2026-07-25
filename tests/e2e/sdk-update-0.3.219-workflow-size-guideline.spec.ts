/**
 * SDK 0.3.219 — `Settings.workflowSizeGuideline`.
 *
 * Advisory size guideline for "ultracode" (Dynamic Workflows): how large a
 * fan-out the model's own Workflow tool should aim for when it plans a run.
 * Claudius surfaces it as an enum row in the generic SDK-settings catalog
 * on `/settings` (Model & behavior), next to `advisorModel` / `fastMode`,
 * and `lib/server/session.ts` forwards a valid value to the SDK's flag
 * layer at session start (same mechanism as `advisorModel` /
 * `includeCoAuthoredBy`).
 *
 * This spec drives the real setting through `/settings`, confirms it
 * round-trips through the settings API, and screenshots the field in
 * context (same shape as `cc-parity-2.1.207-disable-auto-mode.spec.ts`,
 * which covers the sibling `disableAutoMode` enum row).
 *
 * Screenshot target: docs/sdk-updates/0.3.219/workflow-size-guideline.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.219");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function getJsonWithRetry<T>(page: Page, url: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return (await page.request.get(url).then((r) => r.json())) as T;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(250 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Clear `workflowSizeGuideline` from the shared dev fixture's user-scope settings. */
async function clearWorkflowSizeGuideline(page: Page): Promise<void> {
  const cur = await getJsonWithRetry<{ settings: Record<string, unknown> }>(
    page,
    "/api/settings?scope=user",
  );
  const rest = { ...cur.settings };
  delete rest.workflowSizeGuideline;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearWorkflowSizeGuideline(page);
});

test.afterEach(async ({ page }) => {
  await clearWorkflowSizeGuideline(page);
});

test.describe("workflowSizeGuideline settings catalog row (SDK 0.3.219)", () => {
  test("the Model & behavior catalog exposes workflowSizeGuideline and it round-trips", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("workflowSizeGuideline");

    const field = page.getByTestId("catalog-field-workflowSizeGuideline");
    await expect(field).toBeVisible({ timeout: 15_000 });
    await expect(field).toContainText("Dynamic Workflows");

    await field.locator("select").selectOption("large");
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(
        async () => {
          // Guarded read — under parallel-suite load (many specs writing the
          // same shared user-scope settings.json) the GET can return a
          // truncated body and `r.json()` throws "Unexpected end of JSON
          // input"; swallow it so the poll retries instead of failing the
          // test. Same pattern as cc-parity-2.1.217-emoji-shortcode-autocomplete.spec.ts.
          try {
            const body = await getJsonWithRetry<{
              settings: { workflowSizeGuideline?: string };
            }>(page, "/api/settings?scope=user");
            return body.settings.workflowSizeGuideline;
          } catch {
            return undefined;
          }
        },
        { timeout: 10_000 },
      )
      .toBe("large");

    // Saving re-triggers a settings refetch that clears the search box —
    // re-apply so the screenshot frames the field, not whatever section
    // happens to sort first on the unfiltered page.
    await page.getByLabel("Search settings").fill("workflowSizeGuideline");
    await expect(field).toBeVisible();
    await expect(field.locator("select")).toHaveValue("large");
    await page.waitForTimeout(200);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "workflow-size-guideline.png"),
      fullPage: false,
    });
  });
});
