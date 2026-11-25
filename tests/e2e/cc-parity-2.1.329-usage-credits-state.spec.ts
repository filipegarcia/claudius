/**
 * CC 2.1.329 parity — "Fixed `/usage` saying usage credits are off when they
 * had run out or reached the monthly limit" and "[VSCode] Fixed the limit
 * banner not saying when usage credits are in use".
 *
 * Claudius's own surfaces got the credit state wrong:
 *  - a warning on an account whose credits are on but spent said "Extra usage
 *    is off";
 *  - a rejected base limit the session carries on past on credits said
 *    nothing about credits (and offered plan upgrades);
 *  - `/cost` hid the Usage credits row exactly when the monthly limit was
 *    reached, and printed its cents as dollars.
 *
 * Screenshot targets: docs/cc-parity/2.1.329/usage-credits-used-up.png,
 *                     docs/cc-parity/2.1.329/usage-credits-monthly-limit.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.329");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002329b06";

function rateLimitEvent(info: Record<string, unknown>): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "rate_limit_event",
      uuid: `rl-329-${String(info.status)}`,
      session_id: SESSION,
      rate_limit_info: { rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) + 3600, ...info },
    },
  };
}

function transcript(extra: SdkEvent[]): SdkEvent[] {
  return [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-329b"),
    { type: "replay_done", hasMoreAbove: false },
    { type: "plan_usage", subscriptionType: "max", rateLimitsAvailable: false, rateLimits: null },
    ...extra,
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a warning with credits on but spent says they're used up, not off", async ({ page }) => {
  await mockChatBackend(
    page,
    SESSION,
    transcript([
      rateLimitEvent({ status: "allowed_warning", utilization: 0.95, overageEnabled: true, overageStatus: "rejected" }),
    ]),
  );
  await page.goto("/");

  const line = page.getByTestId("rate-limit-extra-usage-state");
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect(line).toHaveAttribute("data-state", "used_up");
  await expect(line).toHaveText("Usage credits are used up — you'll be paused when this limit is reached.");
  await expect(page.getByText(/Extra usage is off/)).toHaveCount(0);

  await line.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "usage-credits-used-up.png"), fullPage: false });
});

test("a rejected base limit the session carries on past on credits says so", async ({ page }) => {
  await mockChatBackend(
    page,
    SESSION,
    transcript([rateLimitEvent({ status: "rejected", isUsingOverage: true, overageStatus: "allowed" })]),
  );
  await page.goto("/");

  const line = page.getByTestId("rate-limit-on-usage-credits");
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect(line).toHaveText("You're now using usage credits.");
  await expect(page.getByText(/^Out of usage\?/)).toHaveCount(0);
});

test("/cost keeps the Usage credits row at the monthly limit, in dollars", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    ...transcript([]),
    {
      type: "plan_usage",
      subscriptionType: "team",
      rateLimitsAvailable: true,
      rateLimits: { fiveHour: { utilization: 40, resetsAt: new Date(Date.now() + 3600_000).toISOString() } },
      extraUsage: { isEnabled: false, monthlyLimit: 50000, usedCredits: 50000, utilization: 100, currency: "USD" },
    },
  ]);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("/cost");
  await page.getByTestId("prompt-send").click();

  const row = page.getByTestId("extra-usage-bar");
  await expect(row).toBeVisible({ timeout: 5_000 });
  await expect(row).toContainText("$500.000 / $500.000");
  await expect(page.getByTestId("extra-usage-caption")).toHaveText("Monthly limit reached.");

  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "usage-credits-monthly-limit.png"), fullPage: false });
});
