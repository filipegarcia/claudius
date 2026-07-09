/**
 * SDK 0.3.205 — structured `name` and `body` fields on the `peer` variant of
 * `SDKMessageOrigin`.
 *
 * When a user-role turn's origin is `kind: "peer"` (sent by another Claude
 * Code session, e.g. via the `SendMessage` tool), the SDK now stamps:
 *   - `name?: string` — the sender's harness-normalized display name
 *   - `body?: string` — the envelope-stripped decoded body, byte-exact with
 *     what the model saw
 *
 * Claudius previously never read `origin` at all, so a peer-authored turn
 * rendered as a plain, badge-less user bubble showing the raw enveloped
 * text. This spec mocks the SSE stream with a peer-origin user message and
 * asserts:
 *   1. A "From `<name>`" badge renders on the bubble.
 *   2. The bubble text is the decoded `body`, not the raw envelope content.
 *
 * Screenshot target: docs/sdk-updates/0.3.205/peer-message-badge.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.205");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000205a1";

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

/** Minimal SSE prelude emitted before any real assistant content. */
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
 * A user-role turn whose origin is `kind: "peer"` with the full 0.3.205
 * shape (`name` + `body`). The raw `message.content` text intentionally
 * differs from `origin.body` so the assertion below actually proves the
 * client prefers the decoded body over its own re-parsed text.
 */
const PEER_MESSAGE: SdkEvent = {
  type: "sdk",
  at: 1_770_000_000_000,
  message: {
    type: "user",
    uuid: "peer-msg-1",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "[[peer-envelope from=session-release-bot]] Deploy finished successfully.",
        },
      ],
    },
    origin: {
      kind: "peer",
      from: "session-release-bot",
      name: "Release Bot",
      body: "Deploy finished successfully.",
    },
  },
};

const ASSISTANT_REPLY: SdkEvent = {
  type: "sdk",
  at: 1_770_000_001_000,
  message: {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Thanks for the update — I'll keep an eye on the logs." }],
      usage: { input_tokens: 50, output_tokens: 15 },
    },
  },
};

const RESULT: SdkEvent = {
  type: "sdk",
  message: {
    type: "result",
    uuid: "result-1",
    subtype: "success",
    total_cost_usd: 0.01,
    num_turns: 1,
    duration_ms: 500,
    duration_api_ms: 400,
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("peer-message origin badge (SDK 0.3.205)", () => {
  test('renders "From <name>" badge and the decoded body, not the raw envelope', async ({
    page,
  }) => {
    await mockChatBackend(page, [...PRELUDE, PEER_MESSAGE, ASSISTANT_REPLY, RESULT]);
    await page.goto("/");

    const badge = page.getByTestId("user-message-peer-badge");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toContainText("From Release Bot");

    // The bubble shows the decoded body, not the raw enveloped text.
    await expect(page.getByText("Deploy finished successfully.")).toBeVisible();
    await expect(page.getByText("peer-envelope", { exact: false })).not.toBeVisible();

    // Wait for the assistant reply so the screenshot shows a full turn
    // (surrounding chrome: tab strip, side nav, chat transcript).
    await expect(page.getByText("I'll keep an eye on the logs.", { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    await badge.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "peer-message-badge.png"),
      fullPage: false,
    });
  });
});
