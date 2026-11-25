/**
 * CC 2.1.327 parity — the spending-limits panel no longer says "Saved." after
 * a save the server refused.
 *
 * "Saved." showed whenever any earlier save had succeeded, and a refused PUT
 * returned false from `useLimits.save` without any message, so a later failed
 * save kept reading "Saved.". The panel now hides it on failure, shows the
 * server's reason in its error slot, and keeps the values the user typed.
 *
 * Screenshot target: docs/cc-parity/2.1.327/limits-save-refused.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.327");
mkdirSync(SHOTS_DIR, { recursive: true });

const REFUSAL = "Couldn't save limits: EACCES: permission denied, open 'limits.json'";

/**
 * GET returns the last saved limits; the first PUT succeeds, every later PUT
 * fails with a 500 JSON error. Never touches the real on-disk limits file.
 */
async function mockLimits(page: Page): Promise<{ puts: () => number }> {
  let saved: Record<string, number> = {};
  let putCount = 0;
  await page.route("**/api/limits*", async (route: Route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      putCount++;
      if (putCount > 1) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: REFUSAL }),
        });
      }
      saved = JSON.parse(req.postData() || "{}") as Record<string, number>;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: saved, overrides: {}, audit: [] }),
    });
  });
  return { puts: () => putCount };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a refused save hides 'Saved.', shows the reason, and keeps the edits", async ({ page }) => {
  const mock = await mockLimits(page);

  await page.goto("/cost");
  await page.getByRole("button", { name: "Limits" }).click();
  await expect(page.getByText("Spending limits")).toBeVisible();

  const webSearchInput = page.getByTestId("limits-max-web-searches");
  const saveButton = page.getByRole("button", { name: /Save/ });

  // First save goes through.
  await webSearchInput.fill("50");
  await saveButton.click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("limits-error")).toHaveCount(0);

  // Second save is refused by the server.
  await webSearchInput.fill("75");
  await saveButton.click();
  await expect.poll(mock.puts).toBe(2);

  const error = page.getByRole("alert").filter({ hasText: REFUSAL });
  await expect(error).toBeVisible();
  await expect(page.getByTestId("limits-error")).toHaveText(REFUSAL);
  await expect(page.getByText("Saved.")).toHaveCount(0);
  // The edited value is still there to retry with.
  await expect(webSearchInput).toHaveValue("75");
  await expect(saveButton).toBeEnabled();

  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SHOTS_DIR, "limits-save-refused.png"), fullPage: false });
});
