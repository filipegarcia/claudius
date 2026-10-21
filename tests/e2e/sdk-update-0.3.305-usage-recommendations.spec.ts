/**
 * SDK 0.3.305 — the experimental `get_usage` response's behavior windows gained
 * `recommendations` (one worded change per notable behaviour or source, largest
 * share first). The Cost overlay's "What's contributing to your limits usage?"
 * section renders them under the behaviour warnings as "Recommended changes",
 * following the Day / Week toggle.
 *
 * Screenshot target: docs/sdk-updates/0.3.305/usage-recommendations.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.305");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000305ab01";

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
      behaviors: [{ key: "max_effort", pct: 41.2, count: 170 }],
      recommendations: [
        { key: "max_effort", pct: 41.2, title: "Use a lower effort level for everyday work", detail: "/effort high" },
        { key: "mcp_server", pct: 12.4, title: "Disable the linear MCP server", detail: "unused in 9 of 10 sessions" },
      ],
    },
    week: {
      requestCount: 2310,
      sessionCount: 31,
      behaviors: [{ key: "always_on_context", pct: 18, count: 410 }],
      recommendations: [{ key: "skill", pct: 15, title: "Trim the dataviz skill description" }],
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
      uuid: "sys-init-305rec",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const ASSISTANT: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-305rec",
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
    uuid: "result-305rec",
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

test("Cost overlay lists recommended changes per window", async ({ page }) => {
  await mockChatBackend(page, [...PRELUDE, ASSISTANT, RESULT, PLAN_USAGE]);
  await page.goto("/");
  await openCostOverlay(page);

  const section = page.getByTestId("usage-behaviors-section");
  await expect(section).toBeVisible({ timeout: 5_000 });
  const recs = section.getByTestId("usage-recommendation");
  await expect(recs).toHaveCount(2);
  await expect(recs.nth(0)).toHaveAttribute("data-key", "max_effort");
  await expect(recs.nth(0)).toContainText("Use a lower effort level for everyday work");
  await expect(recs.nth(0)).toContainText("~41% of usage");
  await expect(recs.nth(0)).toContainText("/effort high");
  await expect(recs.nth(1)).toContainText("Disable the linear MCP server");
  await expect(recs.nth(1)).toContainText("unused in 9 of 10 sessions");

  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "usage-recommendations.png"), fullPage: false });

  await page.getByTestId("usage-behaviors-period-week").click();
  await expect(recs).toHaveCount(1);
  await expect(recs.nth(0)).toContainText("Trim the dataviz skill description");
  await expect(recs.nth(0)).toContainText("~15% of usage");
});

test("a window with recommendations but no flag over the threshold still renders the section", async ({ page }) => {
  await mockChatBackend(page, [...PRELUDE, ASSISTANT, RESULT, PLAN_USAGE]);
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/usage-behaviors`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        behaviors: {
          day: {
            requestCount: 10,
            sessionCount: 1,
            behaviors: [],
            recommendations: [{ key: "cron", pct: 6, title: "Review the long-running loop" }],
          },
          week: { requestCount: 10, sessionCount: 1, behaviors: [], recommendations: [] },
        },
      }),
    });
  });
  await page.goto("/");
  await openCostOverlay(page);
  const section = page.getByTestId("usage-behaviors-section");
  await expect(section).toBeVisible({ timeout: 5_000 });
  await expect(section.getByTestId("usage-behavior-flag")).toHaveCount(0);
  await expect(section.getByTestId("usage-recommendation")).toHaveCount(1);
  await expect(section.getByTestId("usage-behaviors-empty")).toHaveCount(0);
});
