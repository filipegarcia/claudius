/**
 * Claude Code 2.1.299 parity —
 *   • "Added /usage warnings for max effort, workflows, always-on context and
 *     large tool results"
 *   • "Fixed /usage, the approaching-limit warning (terminal and VS Code) and
 *     the status line sometimes showing more than 100% used"
 *
 * The CLI's `/usage` dialog lists each usage behaviour accounting for >= 10%
 * of local usage (last 24h / 7d), read from the SDK's experimental usage API
 * `behaviors` section. Claudius's home for it is the per-session "Session cost
 * & usage" overlay (`components/overlays/CostOverlay.tsx`, opened by `/cost`),
 * which fetches `GET /api/sessions/[id]/usage-behaviors` when it opens.
 *
 * This spec mocks that route with a Day window carrying max_effort (41%) and
 * workflow (22%) plus two sub-threshold behaviours (7% and an unrounded 9.6%
 * that would print as "10%") and a Week window carrying only always-on context
 * and large tool results. It asserts the Day headlines render and the
 * sub-threshold ones don't, toggles to Week and asserts the rows swap. The
 * plan-usage fixture's 5-hour window reads 112% — the overlay must print
 * "100%", never "112%".
 *
 * Screenshot target: docs/cc-parity/2.1.299/usage-behaviors.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.299");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000299ab01";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** Same body shape as `UsageBehaviorsResponse` in lib/shared/usage-behaviors.ts. */
const USAGE_BEHAVIORS = {
  behaviors: {
    day: {
      requestCount: 412,
      sessionCount: 6,
      behaviors: [
        { key: "workflow", pct: 22, count: 90 },
        { key: "max_effort", pct: 41.2, count: 170 },
        { key: "cache_miss", pct: 7, count: 12 },
        { key: "long_context", pct: 9.6, count: 30 },
      ],
    },
    week: {
      requestCount: 2310,
      sessionCount: 31,
      behaviors: [
        { key: "always_on_context", pct: 18, count: 410 },
        { key: "large_tool_results", pct: 12.4, count: 280 },
        { key: "max_effort", pct: 4, count: 60 },
      ],
    },
  },
};

async function mockChatBackend(page: Page, events: SdkEvent[]): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody(events),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/usage-behaviors`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(USAGE_BEHAVIORS),
    });
  });

  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asks: [], permissions: [] }),
    });
  });

  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-init-299ub",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const ASSISTANT: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-299ub",
    parent_tool_use_id: null,
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Done — the migration ran across all twelve packages." }],
      usage: { input_tokens: 1200, output_tokens: 340 },
    },
  },
};

const RESULT: SdkEvent = {
  type: "sdk",
  message: {
    type: "result",
    uuid: "result-299ub",
    subtype: "success",
    total_cost_usd: 1.87,
    num_turns: 1,
    duration_ms: 64_000,
    duration_api_ms: 51_000,
  },
};

const PLAN_USAGE: SdkEvent = {
  type: "plan_usage",
  subscriptionType: "max",
  rateLimitsAvailable: true,
  rateLimits: {
    // Ran past its limit before the server cut it off — must print 100%.
    fiveHour: { utilization: 112, resetsAt: "2026-10-14T20:00:00Z" },
    sevenDay: { utilization: 64, resetsAt: "2026-10-18T00:00:00Z" },
  },
  fetchedAt: Date.now(),
};

async function openCostOverlay(page: Page): Promise<void> {
  await expect(page.getByTestId("token-tile-cost")).toBeVisible({ timeout: 15_000 });
  const costButton = page.getByTitle("Session cost & usage");
  await costButton.waitFor({ state: "visible", timeout: 5_000 });
  await costButton.click();
  await expect(page.getByTestId("plan-usage-section")).toBeVisible({ timeout: 5_000 });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("Cost overlay shows the /usage behaviour warnings with a Day / Week toggle", async ({ page }) => {
  await mockChatBackend(page, [...PRELUDE, ASSISTANT, RESULT, PLAN_USAGE]);
  await page.goto("/");
  await openCostOverlay(page);

  // Percent clamp: the 112% window prints 100%, never above.
  const plan = page.getByTestId("plan-usage-section");
  await expect(plan).toContainText("100%");
  await expect(plan).not.toContainText("112%");
  await expect(plan).toContainText("64%");

  const section = page.getByTestId("usage-behaviors-section");
  await expect(section).toBeVisible({ timeout: 5_000 });
  await expect(section).toContainText("What's contributing to your limits usage?");
  await expect(section).toHaveAttribute("data-period", "day");
  await expect(page.getByTestId("usage-behaviors-period-day")).toHaveAttribute("aria-pressed", "true");
  await expect(section).toContainText("Last 24h");

  // Day: max_effort + workflow, highest share first; 7% and 9.6% are under
  // the 10% threshold (9.6 is filtered unrounded, like the CLI).
  const flags = section.getByTestId("usage-behavior-flag");
  await expect(flags).toHaveCount(2);
  await expect(flags.nth(0)).toHaveAttribute("data-key", "max_effort");
  await expect(flags.nth(0)).toContainText("41% of your usage was at max effort");
  await expect(flags.nth(0)).toContainText("Save it for the hardest tasks");
  await expect(flags.nth(1)).toHaveAttribute("data-key", "workflow");
  await expect(flags.nth(1)).toContainText("22% of your usage came from workflows");
  await expect(flags.nth(1)).toContainText("Ultracode starts one on every task; /effort turns it off.");
  await expect(section).not.toContainText("cache miss");
  await expect(section).not.toContainText(">150k context");

  // Week: the rows swap to the week window's flags.
  await page.getByTestId("usage-behaviors-period-week").click();
  await expect(section).toHaveAttribute("data-period", "week");
  await expect(page.getByTestId("usage-behaviors-period-week")).toHaveAttribute("aria-pressed", "true");
  await expect(section).toContainText("Last 7d");
  await expect(flags).toHaveCount(2);
  await expect(flags.nth(0)).toContainText("18% of your usage went to always-on context over 40k tokens");
  await expect(flags.nth(1)).toContainText("12% of your usage went to tool results over 10k tokens");
  await expect(section).not.toContainText("max effort");

  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "usage-behaviors.png"), fullPage: false });
});

test("the section stays hidden when the SDK reports no behaviours (non-subscriber)", async ({ page }) => {
  await mockChatBackend(page, [...PRELUDE, ASSISTANT, RESULT, PLAN_USAGE]);
  // Registered after mockChatBackend, so this handler wins.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/usage-behaviors`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ behaviors: null }) });
  });
  const fetched = page.waitForResponse(`**/api/sessions/${FAKE_SESSION_ID}/usage-behaviors`);
  await page.goto("/");
  await openCostOverlay(page);
  await fetched;
  await expect(page.getByTestId("usage-behaviors-section")).toHaveCount(0);
});
