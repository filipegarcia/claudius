/**
 * CC parity 2.1.208 — "as of" staleness note in the CostOverlay's plan-usage
 * section.
 *
 * Upstream CLI 2.1.208 changelog: "`/usage` now shows your last-known usage
 * bars with an 'as of' note when the usage endpoint is rate-limited, instead
 * of an error screen." Claudius's analog is the "Plan" section of the
 * "Session cost & usage" overlay (`components/overlays/CostOverlay.tsx`),
 * fed by the `plan_usage` SSE event
 * (`Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`).
 *
 * Claudius already degrades gracefully on a failed/rate-limited fetch — the
 * server-side catch swallows the error and simply doesn't broadcast fresh
 * data, so the client keeps whatever plan-usage state it last held (no error
 * screen). What was missing is CC's freshness cue: without it, stale bars
 * read as live. This release adds an explicit `plan_usage_unavailable` event
 * (broadcast from that same catch branch) that flags the last-known
 * `plan_usage` data as stale, plus an "as of <time>" note + dimmed bars in
 * the overlay once that flag is set. The flag is deliberately event-driven
 * rather than inferred from elapsed time — Claude Code turns routinely run
 * past any reasonable wall-clock threshold, so a time-based guess would
 * misfire on healthy long-running turns.
 *
 * This spec verifies both ends of that behavior:
 *   1. A `plan_usage` event with no follow-up `plan_usage_unavailable`
 *      shows no staleness note.
 *   2. A `plan_usage` event followed by `plan_usage_unavailable` shows the
 *      "as of <time>" note over the (still-rendered, now dimmed) last-known
 *      bars, and the screenshot captures it in context alongside the rest
 *      of the overlay (subscription badge, utilization bars, surrounding
 *      chrome).
 *
 * Screenshot target: docs/cc-parity/2.1.208/usage-staleness-note.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.208");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000208";

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

test.describe("CC parity 2.1.208 — plan-usage staleness note", () => {
  test("plan_usage with no failed follow-up attempt shows no staleness note", async ({ page }) => {
    const FRESH_PLAN_USAGE: SdkEvent = {
      type: "plan_usage",
      subscriptionType: "max",
      rateLimitsAvailable: true,
      rateLimits: {
        fiveHour: { utilization: 20, resetsAt: "2026-07-14T20:00:00Z" },
      },
      fetchedAt: Date.now(),
    };

    await mockChatBackend(page, [...PRELUDE, ASSISTANT, RESULT, FRESH_PLAN_USAGE]);
    await page.goto("/");
    await openCostOverlay(page);

    await expect(page.getByTestId("plan-usage-stale-note")).not.toBeVisible();
  });

  test("plan_usage_unavailable after plan_usage shows an 'as of <time>' note in context", async ({
    page,
  }) => {
    const FETCHED_AT = Date.now();
    const PLAN_USAGE: SdkEvent = {
      type: "plan_usage",
      subscriptionType: "max",
      rateLimitsAvailable: true,
      rateLimits: {
        fiveHour: { utilization: 62, resetsAt: "2026-07-14T20:00:00Z" },
        sevenDay: { utilization: 88, resetsAt: "2026-07-18T00:00:00Z" },
      },
      fetchedAt: FETCHED_AT,
    };
    // The next turn's usage fetch failed/was rate-limited — the server
    // broadcasts `plan_usage_unavailable` instead of a fresh `plan_usage`,
    // flagging the data above as stale without replacing it.
    const PLAN_USAGE_UNAVAILABLE: SdkEvent = { type: "plan_usage_unavailable" };

    await mockChatBackend(page, [
      ...PRELUDE,
      ASSISTANT,
      RESULT,
      PLAN_USAGE,
      PLAN_USAGE_UNAVAILABLE,
    ]);
    await page.goto("/");
    await openCostOverlay(page);

    const staleNote = page.getByTestId("plan-usage-stale-note");
    await expect(staleNote).toBeVisible();
    await expect(staleNote).toContainText("as of");

    // The rest of the section still renders the last-known bars, not an
    // error screen — matching the CLI's "last-known bars ... instead of an
    // error screen" behavior.
    const planSection = page.getByTestId("plan-usage-section");
    await expect(planSection).toContainText("62%");
    await expect(planSection).toContainText("88%");

    // Screenshot: overlay in context (status line, chat surface behind it).
    await page.screenshot({
      path: resolve(SHOTS_DIR, "usage-staleness-note.png"),
      fullPage: false,
    });
  });
});
