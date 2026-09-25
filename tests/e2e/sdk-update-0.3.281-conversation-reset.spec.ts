import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

/**
 * SDK 0.3.281 — "Added optional `trigger`, `user_message_uuid` and
 * `timestamp` fields to the `conversation_reset` message so clients can
 * tell what reset the conversation, match a /clear to its message, and show
 * when the reset happened."
 *
 * `conversation_reset` itself predates 0.3.281 (emitted on /clear,
 * plan-mode-exit-with-clear-context, a fresh-session-for-approved-plan
 * flow, or an in-session onboarding re-run) but Claudius never had a
 * handler for it — the raw SDK message reached the client over the
 * existing `{type:"sdk", message}` broadcast and was silently dropped.
 * Claudius's own `/clear` (and its /reset, /new aliases) never exercises
 * this path: it's intercepted client-side (see `runNative("clear")` in
 * ChatSurface.tsx) and spins up a brand-new session instead of sending
 * /clear through the SDK. The other three triggers originate inside the
 * CLI itself, outside Claudius's control, so a dropped frame there left
 * the transcript stale with no indication a reset happened.
 *
 * This spec drives the SSE stream directly with `page.route` (same harness
 * as `cc-parity-2.1.216-context-and-compact.spec.ts` and
 * `cc-parity-2.1.247-peer-message-collapse.spec.ts`) to synthesize a
 * `conversation_reset` frame with `trigger: "fresh_session"` and a
 * `timestamp`, and asserts the new divider row renders in the transcript.
 *
 * Screenshot target: docs/sdk-updates/0.3.281/conversation-reset-divider.png
 */

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.281");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000032810";

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
    message: { type: "system", subtype: "init", uuid: "sys-init-32810", model: "claude-sonnet-4-6" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const USER_MESSAGE: SdkEvent = {
  type: "sdk",
  at: 1_774_000_000_000,
  message: {
    type: "user",
    uuid: "user-32810",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text: "Draft a plan for the new billing dashboard." }],
    },
  },
};

const ASSISTANT_REPLY: SdkEvent = {
  type: "sdk",
  at: 1_774_000_001_000,
  message: {
    type: "assistant",
    uuid: "asst-32810",
    parent_tool_use_id: null,
    message: {
      id: "msg_32810",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Here's the plan — three phases, starting with the data layer." }],
      usage: { input_tokens: 30, output_tokens: 18 },
    },
  },
};

const RESULT: SdkEvent = {
  type: "sdk",
  message: {
    type: "result",
    uuid: "result-32810",
    subtype: "success",
    total_cost_usd: 0.02,
    num_turns: 1,
    duration_ms: 500,
    duration_api_ms: 400,
  },
};

const CONVERSATION_RESET: SdkEvent = {
  type: "sdk",
  message: {
    type: "conversation_reset",
    uuid: "reset-32810",
    session_id: FAKE_SESSION_ID,
    new_conversation_id: "bbbbbbbb-cccc-dddd-eeee-000000032811",
    trigger: "fresh_session",
    timestamp: "2026-09-23T12:34:56.000Z",
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("SDK 0.3.281 — conversation_reset trigger/timestamp", () => {
  test("renders a 'Conversation reset' divider with trigger reason and timestamp", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      USER_MESSAGE,
      ASSISTANT_REPLY,
      RESULT,
      CONVERSATION_RESET,
    ]);
    await page.goto("/");

    // The turn before the reset is still visible — the divider augments the
    // transcript, it doesn't wipe it.
    await expect(
      page.getByText("Here's the plan — three phases, starting with the data layer."),
    ).toBeVisible({ timeout: 15_000 });

    const divider = page.getByTestId("conversation-reset-divider");
    await expect(divider).toBeVisible();
    await expect(divider).toContainText("Conversation reset");
    await expect(divider).toContainText(
      "fresh session started to implement the approved plan",
    );

    await divider.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "conversation-reset-divider.png"),
      fullPage: false,
    });
  });
});
