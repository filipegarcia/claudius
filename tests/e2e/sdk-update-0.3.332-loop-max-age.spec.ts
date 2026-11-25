/**
 * SDK 0.3.332 — `CronCreateOutput.maxAgeMs` ("Age at which a recurring job
 * ends; 0 = never"), with CC 2.1.330: "Changed recurring scheduled tasks and
 * `/loop` to run up to 30 days instead of 7 while their session keeps running,
 * and say when they end; tasks made before this release still end at 7 days".
 *
 * The Activity rail's loop chip now says when a recurring loop ends, and a
 * loop past its end is muted (no cancel button) instead of looking live.
 *
 * Screenshot target: docs/sdk-updates/0.3.332/loop-ends.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000000332a01";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function cronCreate(opts: {
  at: number;
  text: string;
  input: Record<string, unknown>;
  toolUseResult?: Record<string, unknown>;
}): SdkEvent[] {
  return [
    {
      type: "sdk",
      at: opts.at,
      message: {
        type: "assistant",
        uuid: "a-cron",
        parent_tool_use_id: null,
        message: {
          id: "msg_cron",
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", id: "toolu_cron_1", name: "CronCreate", input: opts.input }],
          usage: { input_tokens: 40, output_tokens: 20 },
        },
      },
    },
    {
      type: "sdk",
      at: opts.at + 500,
      message: {
        type: "user",
        uuid: "u-cron",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_cron_1", content: opts.text }],
        },
        ...(opts.toolUseResult ? { tool_use_result: opts.toolUseResult } : {}),
      },
    },
  ];
}

function transcript(events: SdkEvent[]): SdkEvent[] {
  return [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-332a"),
    { type: "replay_done", hasMoreAbove: false },
    ...events,
  ];
}

const shortDate = (page: import("@playwright/test").Page, ms: number) =>
  page.evaluate((t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }), ms);

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a recurring loop says when it ends (30 days from creation)", async ({ page }) => {
  await mockChatBackend(
    page,
    SESSION,
    transcript(
      cronCreate({
        at: NOW,
        // `recurring` omitted: CronCreate's default is recurring.
        input: { cron: "*/30 * * * *", prompt: "check the deploy queue" },
        text: "Scheduled recurring job 1545ddb6 (Every 30 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 30 days. Use CronDelete to cancel sooner.",
        toolUseResult: {
          id: "1545ddb6",
          humanSchedule: "Every 30 minutes",
          recurring: true,
          nextFireAt: NOW + 17 * 60_000,
          maxAgeMs: 30 * DAY,
        },
      }),
    ),
  );
  await page.goto("/");

  const rail = page.getByTestId("activity-section-loops");
  await expect(rail).toBeVisible({ timeout: 15_000 });
  await expect(rail).toContainText("Every 30 minutes");
  await expect(rail).toContainText("recurring");
  const chip = rail.getByTestId("loop-ends");
  await expect(chip).toHaveText(`ends ${await shortDate(page, NOW + 30 * DAY)}`);
  await expect(rail.getByTestId("scheduled-loop-cancel")).toBeVisible();

  await chip.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "loop-ends.png"), fullPage: false });
});

test("a loop made before 2.1.330 ends at 7 days and reads as ended after", async ({ page }) => {
  const created = NOW - 8 * DAY;
  await mockChatBackend(
    page,
    SESSION,
    transcript(
      cronCreate({
        at: created,
        input: { cron: "0 * * * *", prompt: "summarise new issues", recurring: true },
        text: "Scheduled recurring job 77aa01ff (Every hour). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.",
      }),
    ),
  );
  await page.goto("/");

  const rail = page.getByTestId("activity-section-loops");
  await expect(rail).toBeVisible({ timeout: 15_000 });
  await expect(rail.getByTestId("loop-ends")).toHaveText(`ended ${await shortDate(page, created + 7 * DAY)}`);
  await expect(rail.getByTestId("scheduled-loop-cancel")).toHaveCount(0);
});
