/**
 * SDK 0.3.273 — the terminal `task_notification` gained
 * `reason: "worker_restart"`: a machine-readable cause set only when a task
 * didn't end through an ordinary completion, failure, or user/agent stop,
 * but because the background worker process itself restarted and the
 * resumed process found the task orphaned (always paired with
 * `status: "stopped"`).
 *
 * Without surfacing this, a worker-restart orphan reads in the rail exactly
 * like a task the user or agent deliberately stopped — "stopped" with no
 * further context. This spec mocks a backgrounded task that ends via a
 * worker restart and asserts the right-rail "Recent" row calls it out as
 * "stopped (restarted)" with an explanatory tooltip, distinguishing it from
 * an ordinary stop.
 *
 * Screenshot target:
 * docs/sdk-updates/0.3.273/task-notification-worker-restart.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.273");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000273w1";
const TASK_TOOL_USE_ID = "toolu_workflow_report";
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
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-init-0",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

/** The turn spawns a long-running backgrounded workflow subagent. */
const WORKFLOW_TOOL_USE: SdkEvent = {
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
        { type: "text", text: "Kicking off the nightly report workflow in the background." },
        {
          type: "tool_use",
          id: TASK_TOOL_USE_ID,
          name: "Workflow",
          input: { name: "nightly-report" },
        },
      ],
      usage: { input_tokens: 40, output_tokens: 20 },
    },
  },
};

const TASK_STARTED: SdkEvent = {
  type: "sdk",
  at: NOW + 300,
  message: {
    type: "system",
    subtype: "task_started",
    uuid: "sys-task-started",
    task_id: "task_nightly_report",
    tool_use_id: TASK_TOOL_USE_ID,
    description: "Generate the nightly report",
    task_type: "local_workflow",
    is_backgrounded: true,
  },
};

/** Terminal notification — the worker process restarted mid-task and orphaned it. */
const TASK_NOTIFICATION_WORKER_RESTART: SdkEvent = {
  type: "sdk",
  at: NOW + 1500,
  message: {
    type: "system",
    subtype: "task_notification",
    uuid: "sys-task-notification",
    task_id: "task_nightly_report",
    tool_use_id: TASK_TOOL_USE_ID,
    status: "stopped",
    reason: "worker_restart",
    summary: "Interrupted by a worker restart",
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Task notification worker-restart reason (SDK 0.3.273 task_notification.reason)", () => {
  test("a task orphaned by a worker restart reads 'stopped (restarted)' in the Recent rail", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      WORKFLOW_TOOL_USE,
      TASK_STARTED,
      TASK_NOTIFICATION_WORKER_RESTART,
    ]);
    await page.goto("/");

    const rightRail = page.locator('[data-pane-name="right-rail"]');
    await expect(rightRail).toBeVisible({ timeout: 15_000 });

    const recent = page.locator('[data-pane-name="recent"]');
    await expect(recent).toBeVisible({ timeout: 15_000 });
    await expect(recent).toContainText("Generate the nightly report");

    const statusLabel = recent.getByText("stopped (restarted)");
    await expect(statusLabel).toBeVisible();
    await expect(statusLabel).toHaveAttribute(
      "title",
      "Stopped because the background worker process restarted and found this task orphaned — not a user or agent action.",
    );

    await recent.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "task-notification-worker-restart.png"),
      fullPage: false,
    });
  });

  test("an ordinary stop (no reason) reads plain 'stopped' with no tooltip", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      WORKFLOW_TOOL_USE,
      TASK_STARTED,
      {
        ...TASK_NOTIFICATION_WORKER_RESTART,
        message: {
          ...(TASK_NOTIFICATION_WORKER_RESTART.message as Record<string, unknown>),
          reason: undefined,
          summary: "Stopped by the user",
        },
      },
    ]);
    await page.goto("/");

    const recent = page.locator('[data-pane-name="recent"]');
    await expect(recent).toBeVisible({ timeout: 15_000 });
    await expect(recent.getByText("stopped (restarted)")).toHaveCount(0);
    const statusLabel = recent.getByText("stopped", { exact: true });
    await expect(statusLabel).toBeVisible();
    expect(await statusLabel.getAttribute("title")).toBeNull();
  });
});
