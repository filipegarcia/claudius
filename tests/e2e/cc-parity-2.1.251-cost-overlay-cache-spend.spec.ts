/**
 * CC 2.1.251 parity — two additions to the "Session cost & usage" overlay
 * (opened via `/cost` · `/usage` · `/stats`, or the status-line cost tile):
 *
 *  1. "Prompt cache" line — hit ratio + misses, derived purely client-side
 *     from the same cache-token totals the overlay already displays (Cache
 *     read / Cache writes stats). Upstream computes this CLI-side for its
 *     `/cost` output and there's no new server field for it (see
 *     lib/shared/prompt-cache.ts doc comment). Deliberately just the two
 *     ratios — no repeated raw token counts, no warm/cold badge (see that
 *     file's doc comment for why a cumulative-only warm/cold signal would
 *     be misleading).
 *
 *  2. "Gateway spend limit" bar — a dollar-denominated cap for sessions
 *     behind a Claude apps gateway with an org-configured spend limit
 *     (`rate_limits.spend_limit`). As of the SDK version this repo builds
 *     against, that field isn't published yet, so this spec fixtures it via
 *     the `plan_usage` SSE event (reusing the harness from
 *     sdk-update-0.3.169-plan-usage.spec.ts) to prove the UI renders once
 *     the field is present. Distinct from Claudius's own client-enforced
 *     "Spending limits" panel on the Cost page's Limits tab.
 *
 * Screenshot target: docs/cc-parity/2.1.251/cost-overlay-cache-and-spend.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.251");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "ffffffff-1111-2222-3333-444444444444";

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

/** Assistant message carrying a mostly-warm cache mix: 900 read, 50 write, 50 fresh input. */
const ASSISTANT: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Hello!" }],
      usage: {
        input_tokens: 50,
        output_tokens: 20,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      },
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

/**
 * plan_usage event carrying a gateway spend limit alongside the usual
 * windows. `spendLimit` is a sibling of `rateLimits` (like `modelScoped`),
 * not nested inside it — see PlanUsageEvent.spendLimit in lib/shared/events.ts.
 */
const PLAN_USAGE_WITH_SPEND_LIMIT: SdkEvent = {
  type: "plan_usage",
  subscriptionType: "enterprise",
  rateLimitsAvailable: true,
  rateLimits: {
    fiveHour: { utilization: 30, resetsAt: "2026-08-28T20:00:00Z" },
  },
  spendLimit: { limitUsd: 100, usedUsd: 42.5, utilization: 42.5, currency: "USD" },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CostOverlay — prompt cache line + gateway spend limit bar (CC 2.1.251 parity)", () => {
  test("shows the prompt-cache hit ratio and the gateway spend limit bar in context", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, ASSISTANT, RESULT, PLAN_USAGE_WITH_SPEND_LIMIT]);
    await page.goto("/");

    await expect(page.getByTestId("token-tile-cost")).toBeVisible({ timeout: 15_000 });

    const costButton = page.getByTitle("Session cost & usage");
    await costButton.waitFor({ state: "visible", timeout: 5_000 });
    await costButton.click();

    // ── Prompt cache line ──────────────────────────────────────────────
    const cacheSection = page.getByTestId("prompt-cache-section");
    await expect(cacheSection).toBeVisible({ timeout: 5_000 });
    // hit ratio = 900 / (50 + 900 + 50) = 90%, misses = 10%
    await expect(cacheSection).toContainText("90%");
    await expect(cacheSection).toContainText("10%");

    // ── Gateway spend limit bar ────────────────────────────────────────
    const spendBar = page.getByTestId("spend-limit-bar");
    await expect(spendBar).toBeVisible({ timeout: 5_000 });
    await expect(spendBar).toContainText("Gateway spend limit");
    await expect(spendBar).toContainText("$42.500");
    await expect(spendBar).toContainText("$100.000");

    // The overlay scrolls internally — bring the spend-limit bar fully into
    // view so the screenshot shows its bar + disclaimer, not just the label.
    await spendBar.scrollIntoViewIfNeeded();

    // Screenshot in context — surrounding overlay chrome (stats grid, plan
    // section, status line/chat behind it) all visible.
    await page.waitForTimeout(300);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "cost-overlay-cache-and-spend.png"),
      fullPage: false,
    });
  });

  test("prompt cache line stays hidden with no usage yet; spend limit bar hidden with no gateway data", async ({
    page,
  }) => {
    // No RESULT/ASSISTANT — session just started, no plan_usage either.
    await mockChatBackend(page, [...PRELUDE]);
    await page.goto("/");

    // Open via /cost slash command instead of the (absent, no-cost-yet) status tile.
    // Fill + click Send directly — Enter would be intercepted by the
    // slash-autocomplete menu instead of submitting (see
    // cc-parity-2.1.191-cleared-from-banner.spec.ts for the same pattern).
    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("/cost");
    await page.getByTestId("prompt-send").click();

    await expect(page.getByText("Session cost & usage")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("prompt-cache-section")).not.toBeVisible();
    await expect(page.getByTestId("spend-limit-bar")).not.toBeVisible();
  });
});
