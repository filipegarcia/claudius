/**
 * CC 2.1.323 parity — "Added an options menu (stop, switch to usage credits,
 * upgrade) when a model needs usage credits that are turned off or used up".
 *
 * The engine ends the turn with "<Model> requires usage credits.". Claudius's
 * limit panel read that as a plan window — "You've hit your weekly Opus
 * limit", with the reset clock of whatever rate_limit_event came earlier —
 * and offered only "Upgrade". It now says the model needs usage credits and
 * offers turning them on plus the upgrade links, or an admin line when the
 * seat can't buy credits. ("Stop" needs no control: the turn already ended.)
 *
 * Screenshot target: docs/cc-parity/2.1.323/model-needs-credits.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.323");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002323c01";

function earlierWarning(canUserPurchaseCredits?: boolean): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "rate_limit_event",
      uuid: "rl-323",
      session_id: SESSION,
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.82,
        resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400,
        ...(canUserPurchaseCredits === undefined ? {} : { canUserPurchaseCredits }),
      },
    },
  };
}

function transcript(canUserPurchaseCredits?: boolean): SdkEvent[] {
  return [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-323c"),
    userText("u-1", "Review the migration plan with Opus."),
    earlierWarning(canUserPurchaseCredits),
    assistantText("a-1", "Opus 5 requires usage credits."),
    { type: "replay_done", hasMoreAbove: false },
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a credits-only model gets 'needs usage credits' options, not a plan-window label", async ({ page }) => {
  await mockChatBackend(page, SESSION, transcript());
  await page.goto("/");

  const title = page.getByTestId("model-needs-credits-title");
  await expect(title).toBeVisible({ timeout: 15_000 });
  await expect(title).toHaveText("Opus 5 needs usage credits");
  const panel = title.locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]");
  await expect(panel).not.toContainText("You've hit your");
  await expect(panel).not.toContainText("resets");
  await expect(panel).not.toContainText("until reset");
  await expect(panel).not.toContainText("Now using");

  const options = page.getByTestId("model-needs-credits-options");
  await expect(options).toContainText("Claude stopped here. To keep going:");
  const turnOn = page.getByTestId("model-needs-credits-turn-on-link");
  await expect(turnOn).toHaveText("Turn on usage credits");
  await expect(turnOn).toHaveAttribute("href", "https://claude.ai/settings/usage");
  await expect(options.locator('a[href="https://claude.ai/upgrade/max"]')).toHaveText("Upgrade your plan");
  await expect(options.locator('a[href="https://claude.ai/create/team"]')).toBeVisible();

  await panel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "model-needs-credits.png"), fullPage: false });
});

test("a seat that can't buy credits is pointed at its admin", async ({ page }) => {
  await mockChatBackend(page, SESSION, transcript(false));
  await page.goto("/");

  await expect(page.getByTestId("model-needs-credits-title")).toHaveText("Opus 5 needs usage credits", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("model-needs-credits-contact-admin")).toContainText(
    "Usage credits are managed by your administrator",
  );
  await expect(page.getByTestId("model-needs-credits-turn-on-link")).toHaveCount(0);
});
