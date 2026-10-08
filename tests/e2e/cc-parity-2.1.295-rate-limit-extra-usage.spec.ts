/**
 * CC 2.1.295 parity — "Improved headless rate_limit_event usage-limit
 * warnings to say whether the account has extra usage turned on".
 *
 * RateLimitPill (components/chat/SystemPill.tsx) now adds a line to a soft
 * `allowed_warning` pill saying whether extra usage will carry the session
 * past the limit, derived by `extraUsageState` (lib/shared/
 * rate-limit-extra-usage.ts) from the SDKRateLimitInfo overage fields.
 * The chat SSE stream is mocked exactly like
 * sdk-update-0.3.268-rate-limit-scope.spec.ts.
 *
 * Screenshot target: docs/cc-parity/2.1.295/rate-limit-extra-usage.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.295");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002129501";

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
    message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-sonnet-4-6" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

function makeWarningEvent(overage: Record<string, unknown>): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "rate_limit_event",
      uuid: "rl-extra-usage-01",
      session_id: FAKE_SESSION_ID,
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.95,
        // Epoch seconds, ~1h out, so the countdown renders.
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
        ...overage,
      },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("rate-limit warning extra-usage state (CC 2.1.295)", () => {
  test("overage allowed → 'Extra usage is on' line", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, makeWarningEvent({ overageStatus: "allowed" })]);
    await page.goto("/");

    const line = page.getByTestId("rate-limit-extra-usage-state");
    await expect(line).toBeVisible({ timeout: 15_000 });
    await expect(line).toHaveAttribute("data-state", "on");
    await expect(line).toHaveText(
      "Extra usage is on — you'll keep going on extra usage after this limit.",
    );
    await expect(page.getByText("You've used 95% of your 5-hour limit")).toBeVisible();

    await line.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "rate-limit-extra-usage.png"),
      fullPage: false,
    });
  });

  test("org disabled extra usage → 'off' line with the reason, shown once", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      makeWarningEvent({ overageStatus: "rejected", overageDisabledReason: "org_level_disabled" }),
    ]);
    await page.goto("/");

    const line = page.getByTestId("rate-limit-extra-usage-state");
    await expect(line).toBeVisible({ timeout: 15_000 });
    await expect(line).toHaveAttribute("data-state", "off");
    await expect(line).toHaveText("Your org has disabled extra usage.");
    // The standalone reason span is suppressed so the copy isn't doubled.
    await expect(page.getByText("Your org has disabled extra usage.", { exact: true })).toHaveCount(1);
  });

  test("no overage signal → no extra-usage line", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, makeWarningEvent({})]);
    await page.goto("/");

    await expect(page.getByText("You've used 95% of your 5-hour limit")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("rate-limit-extra-usage-state")).toHaveCount(0);
  });
});
