/**
 * SDK 0.3.205 — `still_queued` interrupt receipt.
 *
 * `Query.interrupt()` now resolves to a typed receipt
 * (`{ still_queued: string[] }`) on a CLI advertising the
 * `interrupt_receipt_v1` capability — uuids of async user messages that
 * will still run despite the interrupt (queued commands, or a batch
 * already dequeued for the imminent turn). `Session.interrupt()` forwards
 * this through the `/interrupt` route, and the client renders a
 * "Stop: N queued message(s) will still run" info pill so the user isn't
 * surprised when queued input keeps executing after they hit Stop.
 *
 * This spec mocks the SSE stream (an assistant message with no closing
 * `result`, so the turn stays "pending" and the Stop button renders) and
 * mocks the `/interrupt` route to return a non-empty `stillQueued`. It
 * clicks Stop and asserts the pill appears with the right count.
 *
 * Screenshot target: docs/sdk-updates/0.3.205/interrupt-still-queued.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.205");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000205a2";

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

  // The SDK 0.3.205 receipt: two uuids that will still run despite Stop.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/interrupt`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        stillQueued: ["queued-uuid-1", "queued-uuid-2"],
      }),
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
 * An in-flight assistant message with no closing `result` event — this is
 * what flips the client into "pending" (turn running), which is what makes
 * the composer swap the Send button for the red Stop button.
 */
const ASSISTANT_MID_TURN: SdkEvent = {
  type: "sdk",
  at: 1_770_000_000_000,
  message: {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Working on it…" }],
      usage: { input_tokens: 50, output_tokens: 15 },
    },
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("interrupt still_queued receipt (SDK 0.3.205)", () => {
  test('Stop shows a "N queued messages will still run" pill', async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, ASSISTANT_MID_TURN]);
    await page.goto("/");

    // Wait for the turn to be "pending" (Stop button visible).
    const stopButton = page.getByTestId("prompt-interrupt");
    await expect(stopButton).toBeVisible({ timeout: 15_000 });

    await stopButton.click();

    const pill = page.getByText("Stop: 2 queued messages will still run");
    await expect(pill).toBeVisible({ timeout: 5_000 });

    await pill.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "interrupt-still-queued.png"),
      fullPage: false,
    });
  });
});
