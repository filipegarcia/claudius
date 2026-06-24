/**
 * SDK 0.3.190 — seven_day_overage_included rate-limit tier + model_scoped
 * per-model usage windows.
 *
 * Two additions in 0.3.190:
 *   1. `SDKRateLimitEvent.rateLimitType` union extended with
 *      `'seven_day_overage_included'` — a weekly tier where overage is
 *      included in the plan window rather than metered separately.
 *
 *   2. `SDKControlGetUsageResponse.rate_limits.model_scoped` — an optional
 *      array of per-model weekly windows (e.g., a "Fable" bucket) emitted by
 *      accounts on the overage-included-models allowlist.
 *
 * This spec verifies:
 *   a. A `rate_limit_event` with `rateLimitType: "seven_day_overage_included"`
 *      renders the correct "Weekly (overage incl.)" label in the SystemPill.
 *   b. A `plan_usage` event that includes a `modelScoped` array renders the
 *      per-model bars (e.g., "7-day (Fable)") in the CostOverlay.
 *
 * Screenshot targets:
 *   - docs/sdk-updates/0.3.190/seven-day-overage-included-pill.png
 *   - docs/sdk-updates/0.3.190/model-scoped-windows.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.190");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000190";

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

  await page.route(
    `**/api/sessions/${FAKE_SESSION_ID}/stream*`,
    async (route: Route) => {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body: sseBody(events),
      });
    },
  );

  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });

  await page.route(
    `**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`,
    async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ asks: [], permissions: [] }),
      });
    },
  );

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

/** Minimal assistant + result pair to populate the cost tile. */
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

// ---------------------------------------------------------------------------
// Test 1: seven_day_overage_included pill label
// ---------------------------------------------------------------------------

test.describe("SDK 0.3.190 — seven_day_overage_included rate-limit tier", () => {
  test("rate-limit pill shows 'Weekly (overage incl.)' for seven_day_overage_included", async ({
    page,
  }) => {
    const RATE_LIMIT_OVERAGE_INCLUDED: SdkEvent = {
      type: "sdk",
      message: {
        type: "rate_limit_event",
        uuid: "rl-190-overage-included",
        session_id: FAKE_SESSION_ID,
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "seven_day_overage_included",
        },
      },
    };

    await mockChatBackend(page, [...PRELUDE, RATE_LIMIT_OVERAGE_INCLUDED]);
    await page.goto("/");

    // The pill renders the tier label in the headline text.
    // For a rejected pill with seven_day_overage_included, the headline is:
    //   "You've hit your Weekly (overage incl.)"
    const pill = page.getByText(/Weekly \(overage incl\.\)/);
    await expect(pill).toBeVisible({ timeout: 15_000 });

    // Also confirm the full headline.
    await expect(page.getByText(/You've hit your Weekly \(overage incl\.\)/)).toBeVisible();

    // Capture pill in context.
    await pill.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "seven-day-overage-included-pill.png"),
      fullPage: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Test 2: model_scoped windows in CostOverlay
// ---------------------------------------------------------------------------

test.describe("SDK 0.3.190 — model_scoped per-model windows in CostOverlay", () => {
  test("CostOverlay renders per-model windows when modelScoped is present", async ({
    page,
  }) => {
    /** plan_usage event with a modelScoped entry for Fable. */
    const PLAN_USAGE_WITH_MODEL_SCOPED: SdkEvent = {
      type: "plan_usage",
      subscriptionType: "max",
      rateLimitsAvailable: true,
      rateLimits: {
        sevenDay: { utilization: 30, resetsAt: "2026-07-01T00:00:00Z" },
      },
      modelScoped: [
        {
          displayName: "Fable",
          utilization: 55,
          resetsAt: "2026-07-01T00:00:00Z",
        },
      ],
    };

    await mockChatBackend(page, [
      ...PRELUDE,
      ASSISTANT,
      RESULT,
      PLAN_USAGE_WITH_MODEL_SCOPED,
    ]);
    await page.goto("/");

    // Wait for the cost tile to appear (completed turn with cost).
    await expect(page.getByTestId("token-tile-cost")).toBeVisible({ timeout: 15_000 });

    // Open the cost overlay.
    const costButton = page.getByTitle("Session cost & usage");
    await costButton.waitFor({ state: "visible", timeout: 5_000 });
    await costButton.click();

    // The plan-usage section must be visible.
    await expect(page.getByTestId("plan-usage-section")).toBeVisible({ timeout: 5_000 });

    // The model-scoped window entry must appear with the display name.
    const modelScopedRow = page.getByTestId("model-scoped-window");
    await expect(modelScopedRow).toBeVisible({ timeout: 5_000 });
    await expect(modelScopedRow).toContainText("7-day (Fable)");

    // The utilization percentage must be rendered.
    await expect(modelScopedRow).toContainText("55%");

    // The named window (sevenDay) still renders too.
    const planSection = page.getByTestId("plan-usage-section");
    await expect(planSection).toContainText("30%");

    // Screenshot: capture the overlay showing both named and model-scoped windows.
    await page.waitForTimeout(300);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "model-scoped-windows.png"),
      fullPage: false,
    });
  });
});
