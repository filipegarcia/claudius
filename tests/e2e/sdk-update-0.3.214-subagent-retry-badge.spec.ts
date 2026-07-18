/**
 * SDK 0.3.214 — `tool_progress` messages gain optional `subagent_type` and
 * `subagent_retry` (`{agent_id, attempt, max_retries, retry_delay_ms,
 * error_status, error_category}`) so clients can show a subagent waiting
 * out an API rate-limit retry.
 *
 * `tool_progress.parent_tool_use_id` on a retrying frame points at the
 * OUTER Task/Agent tool_use — never at itself — since the retry belongs to
 * one of the subagent's own (inner) tool calls. This spec mocks a running
 * Task whose inner Bash call is mid-retry and asserts the Task card (not
 * the top-level Tools rail, which never sees subagent-nested tool calls)
 * renders a "retrying" badge.
 *
 * Screenshot target: docs/sdk-updates/0.3.214/subagent-retry-badge.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.214");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000214b1";
const AGENT_TOOL_USE_ID = "toolu_agent_watch_1";
const INNER_BASH_TOOL_USE_ID = "toolu_inner_bash_1";
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

/** Top-level turn spawns a subagent via the Agent tool. */
const AGENT_TOOL_USE: SdkEvent = {
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
        { type: "text", text: "Kicking off a review of the diff." },
        {
          type: "tool_use",
          id: AGENT_TOOL_USE_ID,
          name: "Agent",
          input: { subagent_type: "code-reviewer", description: "Review the pending diff" },
        },
      ],
      usage: { input_tokens: 40, output_tokens: 20 },
    },
  },
};

/** The subagent starts — status flips to "running" and stays there (no
 * task_notification follows), matching a subagent still mid-turn. */
const TASK_STARTED: SdkEvent = {
  type: "sdk",
  at: NOW + 500,
  message: {
    type: "system",
    subtype: "task_started",
    uuid: "sys-task-started-1",
    task_id: "task_1",
    tool_use_id: AGENT_TOOL_USE_ID,
    description: "Review the pending diff",
    subagent_type: "code-reviewer",
  },
};

/**
 * The subagent's OWN inner Bash call is waiting out a rate-limit retry.
 * `parent_tool_use_id` points at the outer Agent tool_use (AGENT_TOOL_USE_ID),
 * not at itself — the field this spec exercises end-to-end.
 */
const SUBAGENT_RETRY_PROGRESS: SdkEvent = {
  type: "sdk",
  at: NOW + 1_000,
  message: {
    type: "tool_progress",
    uuid: "tp-1",
    tool_use_id: INNER_BASH_TOOL_USE_ID,
    tool_name: "Bash",
    parent_tool_use_id: AGENT_TOOL_USE_ID,
    elapsed_time_seconds: 6,
    subagent_type: "code-reviewer",
    subagent_retry: {
      agent_id: "agent_review_1",
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 4000,
      error_status: 429,
      error_category: "rate_limit",
    },
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Subagent rate-limit-retry badge (SDK 0.3.214)", () => {
  test("a running Task whose inner tool call is retrying shows a retrying badge", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, AGENT_TOOL_USE, TASK_STARTED, SUBAGENT_RETRY_PROGRESS]);
    await page.goto("/");

    const taskBlock = page.getByTestId("task-block");
    await expect(taskBlock).toBeVisible({ timeout: 15_000 });
    await expect(taskBlock).toHaveAttribute("data-task-status", "running");

    const badge = taskBlock.getByTestId("subagent-retry-badge");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText("retrying 2/5");
    await expect(badge).toHaveAttribute("title", /attempt 2\/5/);

    await badge.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "subagent-retry-badge.png"),
      fullPage: false,
    });
  });
});
