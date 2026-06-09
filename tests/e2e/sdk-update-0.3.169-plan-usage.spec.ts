/**
 * SDK 0.3.169 — Plan rate-limit usage in the cost overlay.
 *
 * Verifies that a `plan_usage` SSE event (emitted by Claudius after each
 * successful turn via Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET())
 * is consumed by the client and surfaced in the "Session cost & usage" overlay.
 *
 * The spec mocks the SSE stream (no real API key required) with a minimal
 * script: prelude → assistant message → result → plan_usage event. It then:
 *   1. Asserts the subscription type badge renders.
 *   2. Asserts the "Plan rate limits not available" fallback shows for a
 *      non-claude.ai (API-key) session (rateLimitsAvailable: false).
 *   3. Captures a screenshot of the overlay in context — surrounding chrome
 *      (status line, chat input) is visible so the reviewer can see where
 *      the new section appears.
 *
 * A second sub-test exercises the rate-limit windows path (rateLimitsAvailable:
 * true) to verify the utilization bars render.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.169");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

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

/** Minimal SSE prelude emitted before any real assistant content. */
const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-init-0",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

/** A minimal assistant message with token usage. */
const ASSISTANT: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Hello!" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  },
};

/** A result event that closes the turn and gives us a cost. */
const RESULT: SdkEvent = {
  type: "sdk",
  message: {
    type: "result",
    uuid: "result-1",
    subtype: "success",
    total_cost_usd: 0.42,
    num_turns: 1,
    duration_ms: 1234,
    duration_api_ms: 900,
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("plan_usage SSE event — cost overlay (SDK 0.3.169)", () => {
  test("shows subscription-type badge and 'not available' message for API-key sessions", async ({
    page,
  }) => {
    /** plan_usage event with rateLimitsAvailable: false (API-key session). */
    const PLAN_USAGE_API_KEY: SdkEvent = {
      type: "plan_usage",
      subscriptionType: null,
      rateLimitsAvailable: false,
      rateLimits: null,
    };

    await mockChatBackend(page, [...PRELUDE, ASSISTANT, RESULT, PLAN_USAGE_API_KEY]);
    await page.goto("/");

    // Wait for the cost tile to appear in the status bar (needs a completed
    // turn with total_cost_usd > 0).
    await expect(page.getByTestId("token-tile-cost")).toBeVisible({ timeout: 15_000 });

    // Open the cost overlay via the status-line's cost button.
    const costButton = page.getByTitle("Session cost & usage");
    await costButton.waitFor({ state: "visible", timeout: 5_000 });
    await costButton.click();

    // The overlay should show the plan-usage section.
    await expect(page.getByTestId("plan-usage-section")).toBeVisible({ timeout: 5_000 });

    // Subscription type badge shows "API key" when subscriptionType is null.
    const badge = page.getByTestId("subscription-type-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("API key");

    // Rate limits not available message should show.
    await expect(page.getByTestId("rate-limits-unavailable")).toBeVisible();
    await expect(page.getByTestId("rate-limits-unavailable")).toContainText(
      "Plan rate limits not available",
    );

    // Screenshot: take a full-context shot of the cost overlay.
    await page.waitForTimeout(300); // allow layout to settle
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "cost-overlay-plan-usage.png"),
      fullPage: false,
    });
  });

  test("shows subscription type and utilization bars for claude.ai subscribers", async ({
    page,
  }) => {
    /** plan_usage event with rateLimitsAvailable: true (claude.ai Pro session). */
    const PLAN_USAGE_PRO: SdkEvent = {
      type: "plan_usage",
      subscriptionType: "pro",
      rateLimitsAvailable: true,
      rateLimits: {
        fiveHour: { utilization: 45, resetsAt: "2026-06-09T16:00:00Z" },
        sevenDay: { utilization: 78, resetsAt: "2026-06-13T00:00:00Z" },
        sevenDayOpus: { utilization: 12, resetsAt: "2026-06-13T00:00:00Z" },
      },
    };

    await mockChatBackend(page, [...PRELUDE, ASSISTANT, RESULT, PLAN_USAGE_PRO]);
    await page.goto("/");

    await expect(page.getByTestId("token-tile-cost")).toBeVisible({ timeout: 15_000 });
    const costButton2 = page.getByTitle("Session cost & usage");
    await costButton2.waitFor({ state: "visible", timeout: 5_000 });
    await costButton2.click();

    await expect(page.getByTestId("plan-usage-section")).toBeVisible({ timeout: 5_000 });

    // Badge shows the subscription type.
    const badge = page.getByTestId("subscription-type-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("pro");

    // The "not available" fallback should NOT show.
    await expect(page.getByTestId("rate-limits-unavailable")).not.toBeVisible();

    // Rate limit windows render (the section has at least one utilization
    // text — "45%", "78%", "12%").
    const planSection = page.getByTestId("plan-usage-section");
    await expect(planSection).toContainText("45%");
    await expect(planSection).toContainText("78%");
  });
});
