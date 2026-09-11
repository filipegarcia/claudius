/**
 * SDK 0.3.268 — `SDKRateLimitInfo.limitScope` (`'service' | 'channel' |
 * 'group_pool'`), not mentioned in the prose changelog (found by diffing
 * `sdk.d.ts`). "Which spend limit blocked the request when it is not the
 * member's own cap: `'group_pool'` means a pooled group budget shared by
 * the member's team is used up (the denial otherwise looks like the
 * member's own monthly cap)."
 *
 * Claudius forwards it through `use-session.ts` → `types.ts` →
 * `RateLimitHitPanel.tsx` / `SystemPill.tsx`, same pattern 0.3.181 used for
 * `errorCode`/`canUserPurchaseCredits` (see
 * sdk-update-0.3.181-credits-required.spec.ts, which this spec mirrors):
 * a `group_pool` denial swaps the personal "Upgrade your plan" / "Upgrade
 * to Team plan" links for a "contact your administrator" line, since
 * upgrading a personal plan doesn't refill a shared pool.
 *
 * Screenshot target: docs/sdk-updates/0.3.268/rate-limit-group-pool.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.268");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000003268";

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

function makeRateLimitEvent(limitScope?: "service" | "channel" | "group_pool"): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "rate_limit_event",
      uuid: "rl-scope-01",
      session_id: FAKE_SESSION_ID,
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "seven_day",
        ...(limitScope ? { limitScope } : {}),
      },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("SDKRateLimitInfo.limitScope (SDK 0.3.268)", () => {
  test("group_pool denial shows a contact-admin line instead of upgrade links", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, makeRateLimitEvent("group_pool")]);
    await page.goto("/");

    const adminMsg = page.getByTestId("rate-limit-group-pool-contact-admin");
    await expect(adminMsg).toBeVisible({ timeout: 15_000 });
    await expect(adminMsg).toContainText("shared team limit");

    // The personal upgrade links must not appear — upgrading a personal
    // plan doesn't refill a shared pool.
    await expect(page.locator('a[href="https://claude.ai/upgrade/max"]')).not.toBeVisible();
    await expect(page.locator('a[href="https://claude.ai/create/team"]')).not.toBeVisible();

    await adminMsg.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "rate-limit-group-pool.png"),
      fullPage: false,
    });
  });

  test("a plain personal denial (no limitScope) still shows the standard upgrade links", async ({
    page,
  }) => {
    await mockChatBackend(page, [...PRELUDE, makeRateLimitEvent()]);
    await page.goto("/");

    await expect(page.locator('a[href="https://claude.ai/upgrade/max"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("rate-limit-group-pool-contact-admin")).not.toBeVisible();
  });
});
