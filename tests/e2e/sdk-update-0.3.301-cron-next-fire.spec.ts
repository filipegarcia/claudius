/**
 * SDK 0.3.299 — `CronCreateOutput` / `CronListOutput` gained an optional
 * `nextFireAt` (epoch ms of the job's next run, scheduler offset included).
 * It appears nowhere in the "0.3.299" prose beyond one bullet and rides on the
 * structured `tool_use_result` that accompanies the CronCreate tool_result.
 * Claudius reconstructs session loops from those events, so the Activity rail's
 * loop chip now shows "next in <delay>" while that first run is still ahead.
 *
 * Screenshot target: docs/sdk-updates/0.3.301/cron-next-fire.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.301");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000301n1";
const NOW = Date.now();

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

function cronCreate(toolUseResult: Record<string, unknown> | undefined): SdkEvent[] {
  return [
    {
      type: "sdk",
      at: NOW,
      message: {
        type: "assistant",
        uuid: "a1",
        parent_tool_use_id: null,
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "toolu_cron_1",
              name: "CronCreate",
              input: { cron: "*/30 * * * *", prompt: "check the deploy queue", recurring: true },
            },
          ],
          usage: { input_tokens: 40, output_tokens: 20 },
        },
      },
    },
    {
      type: "sdk",
      at: NOW + 500,
      message: {
        type: "user",
        uuid: "u1",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_cron_1",
              content:
                "Scheduled recurring job 1545ddb6 (Every 30 minutes). Session-only (not written to disk, dies when Claude exits). Use CronDelete to cancel sooner.",
            },
          ],
        },
        ...(toolUseResult ? { tool_use_result: toolUseResult } : {}),
      },
    },
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Cron next fire (SDK 0.3.299 CronCreateOutput.nextFireAt)", () => {
  test("shows the first-run countdown on the loop chip", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      ...cronCreate({
        id: "1545ddb6",
        humanSchedule: "Every 30 minutes",
        recurring: true,
        nextFireAt: NOW + 17 * 60_000,
      }),
    ]);
    await page.goto("/");

    const rail = page.getByTestId("activity-section-loops");
    await expect(rail).toBeVisible({ timeout: 15_000 });
    await expect(rail).toContainText("Every 30 minutes");
    const chip = rail.getByTestId("loop-next-fire");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/^next in 1[67]m/);

    await chip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, "cron-next-fire.png"), fullPage: false });
  });

  test("a CronCreate result without nextFireAt (older SDK) shows no countdown", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, ...cronCreate(undefined)]);
    await page.goto("/");

    const rail = page.getByTestId("activity-section-loops");
    await expect(rail).toBeVisible({ timeout: 15_000 });
    await expect(rail).toContainText("Every 30 minutes");
    await expect(rail.getByTestId("loop-next-fire")).toHaveCount(0);
  });
});
