/**
 * CC 2.1.326 parity — two transcript-pill fixes:
 *
 *  1. "Fixed an upgrade hint appearing under an old usage limit message after
 *     the limit had reset". Claudius's inline `RateLimitHitPanel` (and the
 *     rejected `RateLimitPill`) kept "Out of usage? Upgrade to keep going:" +
 *     the upgrade / Get more usage links under a limit whose reset time had
 *     already passed. Once it has, those rows give way to "This limit has
 *     reset." — the "You've hit your …" header stays as history.
 *
 *  2. "Improved hook failures, blocks and timeouts in the transcript: failures
 *     are now red instead of grey, a hook that stops Claude is yellow, and the
 *     reason is shown under them". A failed hook's stderr reason is now open
 *     by default, and a `system/informational` line with
 *     `prevent_continuation` (a Stop hook that ended the turn) renders amber
 *     instead of as a grey notice.
 *
 * Screenshots: docs/cc-parity/2.1.326/rate-limit-reset.png
 *              docs/cc-parity/2.1.326/hook-stop.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { apiErrorText, assistantText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.326");
mkdirSync(SHOTS_DIR, { recursive: true });

const RL_SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002326r01";
const HOOK_SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002326h01";

/**
 * The app-wide updater banner reflects the dev machine's real updater state
 * (not mocked here) and has nothing to do with this feature — dismiss it so
 * the screenshot shows the page chrome without unrelated noise.
 */
async function dismissUpdaterBanner(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", {
    name: /^Dismiss (updater error|update-feed notice|for this session|for 24 hours|until a newer version is available)$/,
  });
  for (let i = 0; i < 3 && (await dismiss.count()) > 0; i++) {
    await dismiss.first().click().catch(() => {});
  }
}

// The limit was hit earlier and its reset time is already two minutes past.
const RESET_PASSED_AT = Math.floor(Date.now() / 1000) - 120;

function rateLimitTranscript(): SdkEvent[] {
  return [
    { type: "ready", sessionId: RL_SESSION },
    initEvent("sys-init-326r"),
    userText("u-1", "Finish the settings-loader refactor."),
    { type: "replay_done", hasMoreAbove: false },
    { type: "plan_usage", subscriptionType: "max", rateLimitsAvailable: false, rateLimits: null },
    {
      type: "sdk",
      message: {
        type: "rate_limit_event",
        uuid: "rl-326",
        session_id: RL_SESSION,
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: RESET_PASSED_AT },
      },
    },
    apiErrorText("a-hit-326", "You've hit your session limit · resets 3pm"),
  ];
}

function hookTranscript(): SdkEvent[] {
  return [
    { type: "ready", sessionId: HOOK_SESSION },
    initEvent("sys-init-326h"),
    userText("u-1", "Wrap up the migration and stop when the tests pass."),
    assistantText("a-1", "Migration done — handing off to the Stop hook."),
    {
      type: "sdk",
      message: {
        type: "system",
        subtype: "hook_response",
        uuid: "hook-response-326",
        hook_id: "h-lint",
        hook_name: "PostToolUse",
        hook_event: "PostToolUse",
        output: "",
        stdout: "",
        stderr: "eslint: 2 errors in lib/server/migrate.ts",
        exit_code: 2,
        outcome: "error",
      },
    },
    {
      type: "sdk",
      message: {
        type: "system",
        subtype: "informational",
        uuid: "info-stop-326",
        session_id: HOOK_SESSION,
        level: "notice",
        content: "Stop hook stopped Claude: 3 specs in tests/unit are still failing",
        prevent_continuation: true,
      },
    },
    { type: "replay_done", hasMoreAbove: false },
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.326 — transcript pills", () => {
  test("a usage-limit message whose reset has passed drops the upgrade hint", async ({ page }) => {
    await mockChatBackend(page, RL_SESSION, rateLimitTranscript());
    await page.goto("/");

    const notice = page.getByTestId("rate-limit-reset-notice");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveText("This limit has reset.");

    // The header stays as history.
    const panel = notice.locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]");
    await expect(panel).toContainText("You've hit your 5-hour limit");
    await expect(panel).not.toContainText("Out of usage?");
    await expect(panel).not.toContainText("until reset");

    // The rejected rate-limit pill drops its next steps the same way.
    await expect(page.getByTestId("rate-limit-pill-reset-notice")).toHaveText("This limit has reset.");

    // No upgrade / get-more-usage links anywhere in the transcript.
    await expect(page.getByTestId("rate-limit-get-more-usage-link")).toHaveCount(0);
    await expect(page.locator('a[href="https://claude.ai/upgrade/max"]')).toHaveCount(0);
    await expect(page.locator('a[href="https://claude.ai/create/team"]')).toHaveCount(0);

    await dismissUpdaterBanner(page);
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SHOTS_DIR, "rate-limit-reset.png"), fullPage: false });
  });

  test("a hook that stops Claude is amber and a failed hook shows its reason", async ({ page }) => {
    await mockChatBackend(page, HOOK_SESSION, hookTranscript());
    await page.goto("/");

    // Failed hook: red, with the stderr reason open by default.
    const failure = page.getByTestId("hook-failure-pill");
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expect(failure).toContainText("exit 2");
    const reason = page.getByTestId("hook-failure-reason");
    await expect(reason).toBeVisible();
    await expect(reason).toHaveText("eslint: 2 errors in lib/server/migrate.ts");

    // Stop hook: shown with the warning (amber) tone, reason as its text.
    const stop = page.locator('[data-testid="system-pill"][data-kind="info"]', {
      hasText: "Stop hook stopped Claude",
    });
    await expect(stop).toHaveCount(1);
    await expect(stop).toHaveAttribute("data-info-level", "warning");
    await expect(stop).toContainText("3 specs in tests/unit are still failing");
    await expect(stop).toContainText("blocked");

    await dismissUpdaterBanner(page);
    await stop.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SHOTS_DIR, "hook-stop.png"), fullPage: false });
  });
});
