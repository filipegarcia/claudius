/**
 * SDK 0.3.181 — credits-required rate-limit signal in the rate-limit pill.
 *
 * 0.3.181 adds three new fields to `SDKRateLimitInfo`:
 *   - `errorCode?: 'credits_required'` — rejection is a credits issue, not a plan limit
 *   - `canUserPurchaseCredits?: boolean` — whether the user can buy credits
 *   - `hasChargeableSavedPaymentMethod?: boolean` — whether a payment method is on file
 *
 * When `errorCode === 'credits_required'`, Claudius replaces the standard
 * "Upgrade your plan / Upgrade to Team plan" upgrade links with a "Buy credits"
 * (or "Add payment method") link pointing to claude.ai/settings/usage.
 *
 * This spec mocks the SSE stream with a `rate_limit_event` carrying the new
 * fields and asserts that:
 *   1. The rate-limit pill renders with the "Credits required" CTA.
 *   2. The link text reflects `hasChargeableSavedPaymentMethod`
 *      (true → "Buy credits", false → "Add payment method").
 *   3. The standard upgrade links do NOT appear.
 *
 * Screenshot target: docs/sdk-updates/0.3.181/credits-required-pill.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.181");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-0000000181aa";

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

/** rate_limit_event with credits_required and a saved payment method. */
function makeRateLimitEvent(opts: {
  hasChargeableSavedPaymentMethod: boolean;
  canUserPurchaseCredits?: boolean;
}): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "rate_limit_event",
      uuid: "rl-credits-01",
      session_id: FAKE_SESSION_ID,
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        errorCode: "credits_required",
        canUserPurchaseCredits: opts.canUserPurchaseCredits ?? true,
        hasChargeableSavedPaymentMethod: opts.hasChargeableSavedPaymentMethod,
      },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("SDKRateLimitInfo credits_required fields (SDK 0.3.181)", () => {
  test('shows "Buy credits" link when payment method on file', async ({ page }) => {
    const events = [
      ...PRELUDE,
      makeRateLimitEvent({ hasChargeableSavedPaymentMethod: true }),
    ];

    await mockChatBackend(page, events);
    await page.goto("/");

    // The pill should appear — rate_limit_event with status "rejected" is always shown.
    const buyLink = page.getByTestId("rate-limit-buy-credits-link");
    await expect(buyLink).toBeVisible({ timeout: 15_000 });
    await expect(buyLink).toHaveText("Buy credits");
    await expect(buyLink).toHaveAttribute("href", "https://claude.ai/settings/usage");

    // Standard upgrade links must NOT be present — this is a credits block, not a plan limit.
    await expect(page.locator('a[href="https://claude.ai/upgrade/max"]')).not.toBeVisible();
    await expect(page.locator('a[href="https://claude.ai/create/team"]')).not.toBeVisible();

    // Scroll link into view and wait for layout to settle before screenshotting.
    await buyLink.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // Screenshot in full-page context — status bar, chat transcript, input all visible.
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "credits-required-pill.png"),
      fullPage: false,
    });
  });

  test('shows "Add payment method" when no saved payment method', async ({ page }) => {
    const events = [
      ...PRELUDE,
      makeRateLimitEvent({ hasChargeableSavedPaymentMethod: false }),
    ];

    await mockChatBackend(page, events);
    await page.goto("/");

    const addPaymentLink = page.getByTestId("rate-limit-buy-credits-link");
    await expect(addPaymentLink).toBeVisible({ timeout: 15_000 });
    await expect(addPaymentLink).toHaveText("Add payment method");
    await expect(addPaymentLink).toHaveAttribute("href", "https://claude.ai/settings/usage");
  });

  test('shows contact-admin message when canUserPurchaseCredits is false', async ({ page }) => {
    // When the account is org-managed and the user cannot purchase credits
    // directly, the buy-credits link must not appear — show a contact-admin
    // line instead so they have a clear next step.
    const events = [
      ...PRELUDE,
      makeRateLimitEvent({
        hasChargeableSavedPaymentMethod: false,
        canUserPurchaseCredits: false,
      }),
    ];

    await mockChatBackend(page, events);
    await page.goto("/");

    // Contact-admin text must appear.
    const adminMsg = page.getByTestId("rate-limit-credits-contact-admin");
    await expect(adminMsg).toBeVisible({ timeout: 15_000 });

    // Purchase links must NOT appear.
    await expect(page.getByTestId("rate-limit-buy-credits-link")).not.toBeVisible();
    await expect(page.locator('a[href="https://claude.ai/settings/usage"]')).not.toBeVisible();

    // Standard upgrade links also must not appear — this is still a credits block.
    await expect(page.locator('a[href="https://claude.ai/upgrade/max"]')).not.toBeVisible();
    await expect(page.locator('a[href="https://claude.ai/create/team"]')).not.toBeVisible();
  });
});
