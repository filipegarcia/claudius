/**
 * CC 2.1.212/2.1.214 parity — "Added a session-wide limit on WebSearch tool
 * calls (default 200, tunable via CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION)"
 * and "Added a per-session cap on subagent spawns (default 200, override
 * with CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION)".
 *
 * Claudius reimplements both as a per-cwd Limits setting instead of env
 * vars, extending the existing spending-limits screen
 * (components/cost/LimitsPanel.tsx) rather than adding a new one — the
 * caps are conceptually the same "protect the session from a runaway loop"
 * feature the USD caps already cover.
 *
 * This spec drives the Cost → Limits tab, fills the two new inputs, saves,
 * and asserts the PUT payload actually carries the new fields (the
 * server-side enforcement itself is covered by
 * tests/unit/tool-budget.test.ts + tests/unit/limits-store-tool-caps.test.ts
 * — this is the UI wiring).
 *
 * Screenshot target: docs/cc-parity/2.1.214/tool-caps.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.214");
mkdirSync(SHOTS_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Session WebSearch / subagent-spawn caps (CC 2.1.212 parity)", () => {
  test("Limits panel exposes and saves the new tool-call caps", async ({ page }) => {
    let savedLimits: Record<string, number> = {};

    await mockLimits(page, () => savedLimits, (next) => {
      savedLimits = next;
    });

    await page.goto("/cost");
    await page.getByRole("button", { name: "Limits" }).click();

    await expect(page.getByText("Spending limits")).toBeVisible();

    const webSearchInput = page.getByTestId("limits-max-web-searches");
    const subagentInput = page.getByTestId("limits-max-subagents");
    await expect(webSearchInput).toBeVisible();
    await expect(subagentInput).toBeVisible();

    // Sanity: starts blank (disabled), matching the "0/undefined disables"
    // convention shared with the existing USD caps.
    await expect(webSearchInput).toHaveValue("");
    await expect(subagentInput).toHaveValue("");

    await webSearchInput.fill("50");
    await subagentInput.fill("10");

    await page.getByRole("button", { name: /Save/ }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10_000 });

    expect(savedLimits.maxWebSearches).toBe(50);
    expect(savedLimits.maxSubagents).toBe(10);

    // Reload to confirm the saved values actually round-trip back into the
    // form (not just accepted by the mock).
    await page.reload();
    await page.getByRole("button", { name: "Limits" }).click();
    await expect(page.getByTestId("limits-max-web-searches")).toHaveValue("50");
    await expect(page.getByTestId("limits-max-subagents")).toHaveValue("10");

    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "tool-caps.png"), fullPage: false });
  });
});

/**
 * Mocks GET/PUT /api/limits so the test controls the panel's state
 * precisely and never touches the real repo's on-disk limits file (the
 * dev server used by e2e specs runs against this checkout's own cwd).
 */
async function mockLimits(
  page: Page,
  getSaved: () => Record<string, number>,
  setSaved: (next: Record<string, number>) => void,
): Promise<void> {
  await page.route("**/api/limits*", async (route: Route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData() || "{}") as Record<string, number>;
      setSaved(body);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ limits: body, overrides: {}, audit: [] }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: getSaved(), overrides: {}, audit: [] }),
    });
  });
}
