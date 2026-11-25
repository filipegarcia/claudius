/**
 * CC 2.1.328 parity — "Fixed the error shown when usage credits run out
 * mid-response, which named a rate limit".
 *
 * The engine ends the turn with "You're out of usage credits · resets …".
 * Claudius's limit panel under it read "You've hit your 5-hour limit" with the
 * reset countdown of an earlier rate_limit_event, and offered plan upgrades.
 * It now says the credits ran out and offers buying more (or the admin line
 * when the seat can't buy them).
 *
 * Screenshot target: docs/cc-parity/2.1.328/credits-exhausted-panel.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { apiErrorText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.328");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002328b05";

function transcript(canUserPurchaseCredits?: boolean): SdkEvent[] {
  return [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-328b"),
    userText("u-1", "Finish the settings-loader refactor."),
    {
      type: "sdk",
      message: {
        type: "rate_limit_event",
        uuid: "rl-328",
        session_id: SESSION,
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.91,
          resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600,
          ...(canUserPurchaseCredits === undefined ? {} : { canUserPurchaseCredits }),
        },
      },
    },
    apiErrorText("a-1", "You're out of usage credits · resets 4pm"),
    { type: "replay_done", hasMoreAbove: false },
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a credits-exhausted stop says so instead of naming a plan limit", async ({ page }) => {
  await mockChatBackend(page, SESSION, transcript());
  await page.goto("/");

  const title = page.getByTestId("credits-exhausted-title");
  await expect(title).toBeVisible({ timeout: 15_000 });
  await expect(title).toHaveText("Out of usage credits");
  const panel = page.getByTestId("rate-limit-hit-panel");
  await expect(panel).not.toContainText("You've hit your");
  await expect(panel).not.toContainText("until reset");
  await expect(panel).not.toContainText("Upgrade your plan");
  const buy = page.getByTestId("credits-exhausted-buy-link");
  await expect(buy).toHaveText("Buy more usage credits");
  await expect(buy).toHaveAttribute("href", "https://claude.ai/settings/usage");

  await panel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "credits-exhausted-panel.png"), fullPage: false });
});

test("a seat that can't buy credits is pointed at its admin", async ({ page }) => {
  await mockChatBackend(page, SESSION, transcript(false));
  await page.goto("/");

  await expect(page.getByTestId("credits-exhausted-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("credits-contact-admin")).toBeVisible();
  await expect(page.getByTestId("credits-exhausted-buy-link")).toHaveCount(0);
});
