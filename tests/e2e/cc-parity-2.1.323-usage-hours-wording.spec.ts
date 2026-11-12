/**
 * Claude Code 2.1.323 parity — "Fixed /usage … saying sessions ran 8 hours
 * when it only counts hours with requests".
 *
 * Claudius keeps its own copy of the /usage behaviour headlines (Cost
 * overlay, CC 2.1.299). The `cron` flag read "sessions active for 8+ hours",
 * which sounds like continuous runtime; the flag counts whole sessions with
 * requests in 8 or more separate hours, the engine's 2.1.323 wording.
 *
 * Screenshot target: docs/cc-parity/2.1.323/usage-hours-wording.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.323");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000323ab01";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** Same body shape as `UsageBehaviorsResponse` in lib/shared/usage-behaviors.ts. */
/** Same body shape as `UsageBehaviorsResponse` in lib/shared/usage-behaviors.ts. */
const USAGE_BEHAVIORS = {
  behaviors: {
    day: {
      requestCount: 412,
      sessionCount: 6,
      behaviors: [
        { key: "cron", pct: 27, count: 110 },
        { key: "subagent_heavy", pct: 14, count: 58 },
      ],
    },
    week: { requestCount: 0, sessionCount: 0, behaviors: [] },
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
      uuid: "sys-init-323ub",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const ASSISTANT: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-323ub",
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
    uuid: "result-323ub",
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

test("the cron usage flag counts hours with requests, not hours active", async ({ page }) => {
  await mockChatBackend(page, [...PRELUDE, ASSISTANT, RESULT, PLAN_USAGE]);
  await page.goto("/");
  await openCostOverlay(page);

  const section = page.getByTestId("usage-behaviors-section");
  await expect(section).toBeVisible({ timeout: 5_000 });
  const flags = section.getByTestId("usage-behavior-flag");
  await expect(flags).toHaveCount(2);
  await expect(flags.nth(0)).toHaveAttribute("data-key", "cron");
  await expect(flags.nth(0)).toContainText(
    "27% of your usage came from sessions with requests in 8 or more separate hours",
  );
  await expect(section).not.toContainText("active for 8+ hours");
  await expect(flags.nth(1)).toContainText("14% of your usage came from subagent-heavy sessions");

  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "usage-hours-wording.png"), fullPage: false });
});
