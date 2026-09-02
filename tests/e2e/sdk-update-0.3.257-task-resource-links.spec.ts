/**
 * SDK 0.3.257 — the terminal `task_notification` for an auto-backgrounded
 * MCP tool call that completed can now carry `resource_links`: the
 * `resource_link` content blocks its result returned, i.e. files the tool
 * returned by reference (joined to the call via `tool_use_id`). Without
 * this, those files were invisible in the UI — the task pill only ever
 * showed token/tool counters and an AI summary.
 *
 * This spec mocks a backgrounded MCP task that completes with two returned
 * files and asserts the transcript's tool_use card (generic `ToolCall`, the
 * enduring record — the right-rail Tasks panel only lists running/pending
 * work, and this task arrives already-completed) shows a "files returned"
 * badge collapsed and the full file list expanded, with the card correctly
 * reading "completed" (not stuck on "running") via the joined task status.
 *
 * Screenshot target: docs/sdk-updates/0.3.257/task-resource-links.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.257");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000257c1";
const MCP_TOOL_USE_ID = "toolu_mcp_report_1";
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

/** The turn calls an MCP tool that gets auto-backgrounded. */
const MCP_TOOL_USE: SdkEvent = {
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
        { type: "text", text: "Generating the quarterly report." },
        {
          type: "tool_use",
          id: MCP_TOOL_USE_ID,
          name: "mcp__reports__generate",
          input: { period: "Q3" },
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
    task_id: "task_mcp_report",
    tool_use_id: MCP_TOOL_USE_ID,
    description: "Generate the quarterly report",
    task_type: "mcp_task",
    is_backgrounded: true,
  },
};

/** Terminal notification — the tool finished and returned two files by reference. */
const TASK_NOTIFICATION_WITH_LINKS: SdkEvent = {
  type: "sdk",
  at: NOW + 1500,
  message: {
    type: "system",
    subtype: "task_notification",
    uuid: "sys-task-notification",
    task_id: "task_mcp_report",
    tool_use_id: MCP_TOOL_USE_ID,
    status: "completed",
    summary: "Report generated",
    usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4500 },
    resource_links: [
      {
        uri: "reports://q3-2026/summary.pdf",
        name: "summary.pdf",
        title: "Q3 2026 summary.pdf",
        description: "Quarterly summary report",
        mimeType: "application/pdf",
      },
      {
        uri: "reports://q3-2026/data.csv",
        name: "data.csv",
        title: "Q3 2026 data.csv",
        mimeType: "text/csv",
      },
    ],
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Task resource links (SDK 0.3.257 task_notification.resource_links)", () => {
  test("a completed MCP task shows the files it returned by reference", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      MCP_TOOL_USE,
      TASK_STARTED,
      TASK_NOTIFICATION_WITH_LINKS,
    ]);
    await page.goto("/");

    // The terminal task_notification arrives already-completed, so the
    // right-rail Tasks panel (running/pending only) never shows this row —
    // the transcript's tool_use card is the enduring record. Collapsed, it
    // already shows a "files returned" badge without expanding.
    const toolCall = page.getByTestId("tool-call").filter({ hasText: "reports__generate" });
    await expect(toolCall).toBeVisible({ timeout: 15_000 });
    const badge = toolCall.getByTestId("tool-call-resource-links-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("2");
    // Joined task status (SDK 0.3.257) — reads "completed" (emerald check),
    // not stuck on "running" (the tool_use itself never got a real result).
    await expect(toolCall.locator(".text-emerald-500")).toBeVisible();

    await toolCall.click();
    const links = toolCall.getByTestId("tool-call-resource-links");
    await expect(links).toBeVisible();
    await expect(links).toContainText("Q3 2026 summary.pdf");
    await expect(links).toContainText("Q3 2026 data.csv");

    await toolCall.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "task-resource-links.png"),
      fullPage: false,
    });
  });
});
