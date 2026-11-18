/**
 * CC 2.1.327 parity — a subagent's trail no longer shows the raw
 * `<task-notification>` wake-up the engine sends it when one of its background
 * tasks finishes.
 *
 * The top-level transcript already dropped these wrappers, but a parented one
 * was routed into the subagent card first and rendered verbatim as a
 * "→ subagent" row. It's now dropped there too, the same way.
 *
 * Screenshot target: docs/cc-parity/2.1.327/subagent-task-notification.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.327");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002327a01";
const NOW = Date.now();
const AGENT_ID = "toolu_agent_tests";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const SUBAGENT_PROMPT = "Run the unit tests in the background and report any failures.";
const NOTIFICATION_TOKEN = "bg-task-9c41";

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-opus-5-5" },
  },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "sdk",
    at: NOW - 5_000,
    message: {
      type: "user",
      uuid: "user-msg-1",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "text", text: "Check the test suite is green." }] },
    },
  },
  {
    type: "sdk",
    at: NOW - 4_000,
    message: {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        id: "msg_a1",
        model: "claude-opus-5-5",
        content: [
          {
            type: "tool_use",
            id: AGENT_ID,
            name: "Agent",
            input: { subagent_type: "general-purpose", description: "Run the tests", prompt: "Spawn prompt text." },
          },
        ],
        usage: { input_tokens: 40, output_tokens: 20 },
      },
    },
  },
  {
    type: "sdk",
    at: NOW - 3_900,
    message: {
      type: "system",
      subtype: "task_started",
      uuid: "started-a1",
      task_id: "task-a1",
      tool_use_id: AGENT_ID,
      description: "Run the tests",
      subagent_type: "general-purpose",
    },
  },
  // The subagent's real prompt.
  {
    type: "sdk",
    at: NOW - 3_800,
    message: {
      type: "user",
      uuid: "sub-user-1",
      parent_tool_use_id: AGENT_ID,
      message: { role: "user", content: [{ type: "text", text: SUBAGENT_PROMPT }] },
    },
  },
  {
    type: "sdk",
    at: NOW - 3_000,
    message: {
      type: "assistant",
      uuid: "sub-a1",
      parent_tool_use_id: AGENT_ID,
      message: {
        id: "msg_sub_a1",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "Started the test run in the background." }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    },
  },
  // The engine waking the subagent when its background task finished.
  {
    type: "sdk",
    at: NOW - 2_000,
    message: {
      type: "user",
      uuid: "sub-user-2",
      parent_tool_use_id: AGENT_ID,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `<task-notification>\n<task-id>${NOTIFICATION_TOKEN}</task-id>\n<status>completed</status>\n` +
              "<summary>Background command \"bun test\" completed (exit code 0)</summary>\n</task-notification>",
          },
        ],
      },
    },
  },
  {
    type: "sdk",
    at: NOW - 1_000,
    message: {
      type: "assistant",
      uuid: "sub-a2",
      parent_tool_use_id: AGENT_ID,
      message: {
        id: "msg_sub_a2",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "All 412 tests passed." }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    },
  },
];

async function mockChatBackend(page: Page): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(EVENTS),
    }),
  );
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a subagent's background-task notification doesn't show as raw XML in its trail", async ({ page }) => {
  await mockChatBackend(page);
  await page.goto("/");

  const card = page.getByTestId("task-block").filter({ hasText: "Run the tests" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button").first().click();

  // The real prompt and both subagent replies are in the trail…
  await expect(card).toContainText(SUBAGENT_PROMPT);
  await expect(card).toContainText("Started the test run in the background.");
  await expect(card).toContainText("All 412 tests passed.");
  // …with exactly one "→ subagent" row: the prompt, not the notification.
  await expect(card.getByText("→ subagent", { exact: true })).toHaveCount(1);
  await expect(card).not.toContainText("<task-notification");
  await expect(card).not.toContainText(NOTIFICATION_TOKEN);
  await expect(page.getByText(NOTIFICATION_TOKEN)).toHaveCount(0);

  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, "subagent-task-notification.png"), fullPage: false });
});
