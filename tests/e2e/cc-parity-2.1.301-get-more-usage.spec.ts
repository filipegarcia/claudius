/**
 * CC 2.1.301 parity — "[VSCode] Added a 'Get more usage' link to the
 * usage-limit banner for Pro and Max plans".
 *
 * Claudius's hard-limit surfaces (the rejected rate-limit pill and the
 * inline RateLimitHitPanel) offered Pro/Max only "Upgrade your plan /
 * Upgrade to Team plan". For a Pro or Max account (from the `plan_usage`
 * event) a "Get more usage" link now leads that row; the upgrade links stay.
 *
 * Screenshot target: docs/cc-parity/2.1.301/get-more-usage.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.301");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002301u01";

function planUsage(subscriptionType: string | null): SdkEvent {
  return { type: "plan_usage", subscriptionType, rateLimitsAvailable: false, rateLimits: null };
}

const REJECTED: SdkEvent = {
  type: "sdk",
  message: {
    type: "rate_limit_event",
    uuid: "rl-301",
    session_id: SESSION,
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 },
  },
};

function transcript(subscriptionType: string | null): SdkEvent[] {
  return [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-301u"),
    userText("u-1", "Refactor the settings loader."),
    assistantText("a-1", "Working on it — splitting `readSettings` out first."),
    { type: "replay_done", hasMoreAbove: false },
    planUsage(subscriptionType),
    REJECTED,
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a Max account at its limit gets Get more usage beside the upgrade links", async ({ page }) => {
  await mockChatBackend(page, SESSION, transcript("max"));
  await page.goto("/");

  const link = page.getByTestId("rate-limit-get-more-usage-link");
  await expect(link).toBeVisible({ timeout: 15_000 });
  await expect(link).toHaveText("Get more usage");
  await expect(link).toHaveAttribute("href", "https://claude.ai/settings/usage");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(page.locator('a[href="https://claude.ai/upgrade/max"]').first()).toBeVisible();

  await link.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "get-more-usage.png"), fullPage: false });
});

test("an unknown tier keeps the upgrade-only row", async ({ page }) => {
  await mockChatBackend(page, SESSION, transcript(null));
  await page.goto("/");
  await expect(page.locator('a[href="https://claude.ai/upgrade/max"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("rate-limit-get-more-usage-link")).toHaveCount(0);
});
