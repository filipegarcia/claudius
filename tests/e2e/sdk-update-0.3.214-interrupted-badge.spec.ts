/**
 * SDK 0.3.214 — assistant messages truncated by `interrupt()` now carry
 * `aborted: true` on the `SDKAssistantMessage`: "stop_reason was never
 * received and the content may end mid-word."
 *
 * Before this, a Stop-clicked message rendered identically to a normally
 * completed one — the user had no way to tell "the model finished" from
 * "I cut it off mid-thought" just by looking at the bubble. This spec mocks
 * the SSE stream with an assistant split carrying `aborted: true` and
 * asserts the chat renders an "Interrupted" badge on that message.
 *
 * Screenshot target: docs/sdk-updates/0.3.214/interrupted-badge.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.214");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000214a1";
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

/**
 * The user hit Stop mid-generation. The split's content ends mid-word and
 * carries the new `aborted: true` flag — no `result` event follows, exactly
 * like a real interrupt (the turn never reaches a normal stop_reason).
 */
const ABORTED_SPLIT: SdkEvent = {
  type: "sdk",
  at: NOW,
  message: {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    aborted: true,
    message: {
      id: "msg_1",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "text",
          text: "Let me walk through the migration plan. First, we'll need to update the datab",
        },
      ],
      usage: { input_tokens: 40, output_tokens: 18 },
    },
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Interrupted assistant message badge (SDK 0.3.214)", () => {
  test("a message truncated by an interrupt shows an Interrupted badge", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, ABORTED_SPLIT]);
    await page.goto("/");

    // Mid-word cutoff is the giveaway this is the aborted split, not a
    // normal completed message.
    await expect(page.getByText("update the datab", { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    const badge = page.getByTestId("assistant-aborted-badge");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText("Interrupted");
    await expect(badge).toHaveAttribute("title", /cut short by an interrupt/i);

    await badge.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "interrupted-badge.png"),
      fullPage: false,
    });
  });
});
