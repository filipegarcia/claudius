/**
 * CC 2.1.210 — "Added a live elapsed-time counter to the collapsed tool
 * summary line so long-running tool calls visibly tick instead of looking
 * stuck."
 *
 * Claudius's Activity rail already had this pattern for Task/Bash rows
 * (`TaskBlock.tsx`'s `formatDuration`, `BackgroundBashes.tsx`), but the
 * per-tool-call row inline in the chat transcript (`ToolCall.tsx`) only
 * showed a static pulsing dot while running — no indication of *how long*.
 * This spec mocks a tool_use with no tool_result (so it stays "running"
 * indefinitely) and asserts the elapsed badge appears and ticks upward.
 *
 * Screenshot target: docs/cc-parity/2.1.210/tool-call-elapsed.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.210");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000210e1";
const TOOL_USE_ID = "toolu_elapsed_watch_1";

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

/**
 * A tool_use with no matching tool_result — stays "running" indefinitely,
 * which is exactly the "long-running tool call" state the elapsed counter
 * exists to make visibly alive rather than looking stuck.
 */
const RUNNING_TOOL_USE: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "Searching the codebase for the config loader." },
        {
          type: "tool_use",
          id: TOOL_USE_ID,
          name: "Grep",
          input: { pattern: "loadConfig", output_mode: "files_with_matches" },
        },
      ],
      usage: { input_tokens: 40, output_tokens: 20 },
    },
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Live elapsed-time counter on the collapsed tool summary line (CC 2.1.210)", () => {
  test("a running tool call shows a ticking elapsed badge", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, RUNNING_TOOL_USE]);
    await page.goto("/");

    const toolCall = page.getByTestId("tool-call").filter({ hasText: "Grep" });
    await expect(toolCall).toBeVisible({ timeout: 15_000 });

    const elapsed = toolCall.getByTestId("tool-call-elapsed");
    await expect(elapsed).toBeVisible({ timeout: 15_000 });
    // Renders as "Ns" (or "Nm Ns" if the run is slow) while running.
    await expect(elapsed).toHaveText(/^\d+[sm]/);

    const firstReading = await elapsed.textContent();
    // Wait past the 1Hz tick and confirm it actually advanced — proving
    // this is a live counter, not a one-shot render.
    await page.waitForTimeout(2200);
    await expect
      .poll(async () => elapsed.textContent())
      .not.toBe(firstReading);

    await toolCall.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "tool-call-elapsed.png"),
      fullPage: false,
    });
  });
});
