/**
 * CC 2.1.292 — "Added an `effort` parameter to the Agent tool, so Claude runs
 * a sub-agent at the effort level you ask for". The subagent card already
 * shows the model a subagent ran on (CC 2.1.243); this spec asserts the
 * requested effort joins it in the card's stats, and that a spawn without
 * one says nothing.
 *
 * Screenshot target: docs/cc-parity/2.1.292/agent-effort.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.292");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002292e01";
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
    message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-opus-5-5" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

function agentSpawn(toolUseId: string, uuid: string, input: Record<string, unknown>, at: number): SdkEvent[] {
  return [
    {
      type: "sdk",
      at,
      message: {
        type: "assistant",
        uuid,
        parent_tool_use_id: null,
        message: {
          id: `msg_${uuid}`,
          model: "claude-opus-5-5",
          content: [{ type: "tool_use", id: toolUseId, name: "Agent", input }],
          usage: { input_tokens: 40, output_tokens: 20 },
        },
      },
    },
    {
      type: "sdk",
      at: at + 200,
      message: {
        type: "system",
        subtype: "task_started",
        uuid: `started-${uuid}`,
        task_id: `task-${uuid}`,
        tool_use_id: toolUseId,
        description: input.description,
        subagent_type: input.subagent_type,
      },
    },
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Agent tool effort (CC 2.1.292)", () => {
  test("a subagent spawned at a requested effort shows it in its card", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      {
        type: "sdk",
        at: NOW - 100,
        message: {
          type: "assistant",
          uuid: "a0",
          parent_tool_use_id: null,
          message: {
            id: "msg_a0",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "Running the security audit at max effort, as you asked." }],
            usage: { input_tokens: 10, output_tokens: 10 },
          },
        },
      },
      ...agentSpawn(
        "toolu_agent_effort",
        "a1",
        { subagent_type: "security-auditor", description: "Audit the auth flow", prompt: "Audit.", effort: "max" },
        NOW,
      ),
      ...agentSpawn(
        "toolu_agent_plain",
        "a2",
        { subagent_type: "Explore", description: "Find the session store", prompt: "Find." },
        NOW + 1_000,
      ),
    ]);
    await page.goto("/");

    const withEffort = page.getByTestId("task-block").filter({ hasText: "Audit the auth flow" });
    await expect(withEffort).toBeVisible({ timeout: 15_000 });
    await expect(withEffort).toContainText("max effort");

    const plain = page.getByTestId("task-block").filter({ hasText: "Find the session store" });
    await expect(plain).toBeVisible();
    await expect(plain).not.toContainText("effort");

    await withEffort.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, "agent-effort.png"), fullPage: false });
  });
});
