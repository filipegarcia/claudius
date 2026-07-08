/**
 * SDK 0.3.205 — peer-message session events gained structured `name` and
 * `body` fields on `SDKMessageOrigin` (`kind: "peer"`): the sender's
 * harness-normalized display name and the envelope-stripped decoded body,
 * byte-exact with what the model saw. Before this release Claudius didn't
 * read `origin` at all, so a message from another Claude Code session (the
 * `SendMessage` tool, cross-session Remote Control) rendered as a plain user
 * bubble with the raw sender envelope still in the text — indistinguishable
 * from something the human typed.
 *
 * This spec drives a fake SSE stream carrying one such peer-authored user
 * message and verifies:
 *   a. The bubble shows a "From <name>" badge
 *      (`data-testid="user-message-peer-badge"`) instead of the default
 *      (badge-less) rendering for human input.
 *   b. The bubble's visible text is `origin.body` (the decoded message),
 *      not the raw enveloped `message.content` the SDK also sent alongside
 *      it.
 *   c. A screenshot of the chat surface in context (tab strip / chrome
 *      around the bubble) for PR review.
 *
 * Screenshot target: docs/sdk-updates/0.3.205/peer-message-badge.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.205");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000205";

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

const RAW_ENVELOPE_TEXT =
  "[peer:session-release-bot] Deploy finished — smoke tests are green, ready for review.";
const DECODED_BODY = "Deploy finished — smoke tests are green, ready for review.";

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-1",
      model: "claude-sonnet-4-6",
    },
  },
  {
    type: "sdk",
    message: {
      type: "user",
      uuid: "peer-msg-1",
      parent_tool_use_id: null,
      session_id: FAKE_SESSION_ID,
      origin: {
        kind: "peer",
        from: "session-release-bot",
        name: "Release Bot",
        body: DECODED_BODY,
      },
      message: { role: "user", content: RAW_ENVELOPE_TEXT },
    },
  },
  {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Thanks — I'll take a look at the PR now." }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    },
  },
  { type: "replay_done", hasMoreAbove: false },
  { type: "turn_status", status: "idle" },
];

test.describe("SDK 0.3.205 — peer-message name/body", () => {
  test("a peer-authored user turn shows a 'From <name>' badge and the decoded body", async ({
    page,
  }) => {
    await mockChatBackend(page, EVENTS);
    await page.goto("/");

    const bubble = page.locator('[data-message-role="user"]').first();
    await expect(bubble).toBeVisible({ timeout: 15_000 });

    const badge = bubble.getByTestId("user-message-peer-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("From Release Bot");

    // The raw enveloped text (with the sender wrapper) must NOT be what's
    // shown — only the decoded `origin.body`.
    await expect(bubble).toContainText(DECODED_BODY);
    await expect(bubble).not.toContainText("[peer:session-release-bot]");

    // Wait for the assistant reply so the shot shows a real turn, not a
    // lone bubble.
    await expect(page.getByText("Thanks — I'll take a look at the PR now.")).toBeVisible();

    await bubble.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "peer-message-badge.png"),
      fullPage: false,
    });
  });
});
