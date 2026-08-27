/**
 * CC 2.1.243 — "Added a Loops breakdown to `/usage`: per-loop run count,
 * total tokens, tokens per run, and last run, so runaway or chatty `/loop`
 * tasks are easy to spot."
 *
 * Claudius has no `/usage`-as-token-breakdown surface — the analogous
 * screen is the workspace Cost page (`app/[workspaceId]/cost/page.tsx`),
 * which already breaks spend down by day / session / model. This adds a
 * "Loops" section there, backed by a new `loop_ticks` table (Claudius's
 * live `Session.scheduledLoops` map has no history — each tick replaces
 * the last; see `lib/server/loop-ticks-db.ts` and the 2.1.245 run-notes for
 * why it's grouped by session rather than by individual `/loop`
 * invocation).
 *
 * Server-side aggregation (recordLoopTick / attachLoopTickTokens /
 * listLoopBreakdown) is covered end-to-end by
 * tests/unit/loop-ticks-db.test.ts, including driving a real
 * `Session.trackScheduledLoops` tick through to a persisted row. This spec
 * covers the remaining UI wiring: `/api/cost/loops` is fixtured (no need to
 * drive a real dynamic-loop agent turn just to prove the table renders),
 * and the assertions are on what the component actually displays.
 *
 * Screenshot target: docs/cc-parity/2.1.245/loops-breakdown.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.245");
mkdirSync(SHOTS_DIR, { recursive: true });

const FIXTURE_LOOPS = [
  {
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    sessionTitle: "Watch CI until green",
    runCount: 14,
    totalTokens: 182_000,
    tokensPerRun: 13_000,
    lastRun: Date.now() - 45_000,
    lastPrompt: "check the latest run, report back only if it changed",
  },
  {
    sessionId: "11111111-2222-3333-4444-555555555555",
    sessionTitle: null,
    runCount: 3,
    totalTokens: 9_600,
    tokensPerRun: 3_200,
    lastRun: Date.now() - 3_600_000,
    lastPrompt: "poll the deploy",
  },
];

async function mockLoopsBreakdown(page: Page): Promise<void> {
  await page.route("**/api/cost/loops*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ loops: FIXTURE_LOOPS }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Loops breakdown on the Cost page (CC 2.1.243 parity)", () => {
  test("shows per-session run count, total tokens, tokens/run, and last run", async ({ page }) => {
    await mockLoopsBreakdown(page);
    await page.goto("/cost");

    const section = page.getByText("Loops", { exact: true });
    await expect(section).toBeVisible();

    const table = page.getByTestId("loops-breakdown-table");
    await expect(table).toBeVisible();

    const rows = page.getByTestId("loops-breakdown-row");
    await expect(rows).toHaveCount(2);

    const first = rows.first();
    await expect(first).toContainText("Watch CI until green");
    await expect(first).toContainText("14"); // run count
    await expect(first).toContainText("182.0K"); // total tokens (fmtTok)
    await expect(first).toContainText("13.0K"); // tokens/run

    const second = rows.nth(1);
    // No session title in the fixture → falls back to the short session id.
    await expect(second).toContainText("11111111");
    await expect(second).toContainText("3");

    // Full-context shot: SideNav, Cost header/tabs, and the Daily/Per-
    // session/Per-model sections above the new Loops section. The Loops
    // section sits below the fold on a fresh load, so scroll it into view
    // before shooting — otherwise the screenshot would show the page chrome
    // without the actual feature.
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "loops-breakdown.png"),
      fullPage: false,
    });
  });

  test("shows an empty state when no loops have been recorded", async ({ page }) => {
    await page.route("**/api/cost/loops*", async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ loops: [] }),
      });
    });
    await page.goto("/cost");

    await expect(page.getByTestId("loops-breakdown-empty")).toBeVisible();
    await expect(page.getByTestId("loops-breakdown-empty")).toContainText(
      "No dynamic loops",
    );
  });
});
