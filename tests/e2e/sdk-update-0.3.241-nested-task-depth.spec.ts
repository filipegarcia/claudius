/**
 * SDK 0.3.238 — `task_started` gained `spawn_depth` (nesting depth of a
 * spawned subagent: 1 for a top-level spawn, N+1 when spawned from inside a
 * depth-N agent) and `is_backgrounded` (previously only arrived via a later
 * `task_updated` patch, which a task backgrounded from birth — e.g. a
 * resumed subagent, always backgrounded per the SDK — never receives).
 *
 * This spec mocks a top-level subagent (depth 1, unbadged) that itself
 * spawned a nested subagent (depth 2) while running in the background from
 * birth, and asserts the right-rail Tasks panel renders an "L2" nesting
 * badge on the nested task and none on the top-level one.
 *
 * Screenshot target: docs/sdk-updates/0.3.241/nested-task-depth-badge.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.241");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000241b1";
const AGENT_TOOL_USE_ID = "toolu_agent_outer_1";
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
        { type: "text", text: "Kicking off a documentation audit." },
        {
          type: "tool_use",
          id: AGENT_TOOL_USE_ID,
          name: "Agent",
          input: { subagent_type: "general-purpose", description: "Audit the docs tree" },
        },
      ],
      usage: { input_tokens: 40, output_tokens: 20 },
    },
  },
};

/** The top-level subagent starts at depth 1 — the common case, unbadged. */
const OUTER_TASK_STARTED: SdkEvent = {
  type: "sdk",
  at: NOW + 300,
  message: {
    type: "system",
    subtype: "task_started",
    uuid: "sys-task-started-outer",
    task_id: "task_outer",
    tool_use_id: AGENT_TOOL_USE_ID,
    description: "Audit the docs tree",
    subagent_type: "general-purpose",
    spawn_depth: 1,
  },
};

/**
 * The outer subagent itself spawns a nested subagent (depth 2), registered
 * in the background from birth — `is_backgrounded: true` right on
 * `task_started`, with no follow-up `task_updated` patch (SDK 0.3.238).
 */
const NESTED_TASK_STARTED: SdkEvent = {
  type: "sdk",
  at: NOW + 800,
  message: {
    type: "system",
    subtype: "task_started",
    uuid: "sys-task-started-nested",
    task_id: "task_nested",
    tool_use_id: "toolu_agent_nested_1",
    description: "Cross-check API reference examples",
    subagent_type: "general-purpose",
    spawn_depth: 2,
    is_backgrounded: true,
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Nested subagent depth badge (SDK 0.3.238 spawn_depth)", () => {
  test("a depth-2 nested subagent shows an L2 badge; the depth-1 parent stays unbadged", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      AGENT_TOOL_USE,
      OUTER_TASK_STARTED,
      NESTED_TASK_STARTED,
    ]);
    await page.goto("/");

    const tasksSection = page.locator('[data-pane-name="tasks"]');
    await expect(tasksSection).toBeVisible({ timeout: 15_000 });
    await expect(tasksSection).toContainText("Audit the docs tree");
    await expect(tasksSection).toContainText("Cross-check API reference examples");

    // Exactly one nesting badge — the depth-1 top-level spawn stays unbadged.
    const badges = tasksSection.getByTestId("task-nesting-badge");
    await expect(badges).toHaveCount(1);
    await expect(badges.first()).toHaveText("L2");
    await expect(badges.first()).toHaveAttribute(
      "title",
      "Nested subagent — spawned from inside a depth-1 agent",
    );

    await badges.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "nested-task-depth-badge.png"),
      fullPage: false,
    });
  });
});
