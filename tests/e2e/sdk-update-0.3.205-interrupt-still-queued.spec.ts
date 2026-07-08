/**
 * SDK 0.3.205 — interrupt control responses now include `still_queued`
 * (uuids of async user messages that will still run despite the
 * interrupt), `Query.interrupt()` resolves to the typed receipt instead of
 * `undefined`, and `system/init` advertises an `interrupt_receipt_v1`
 * capability for feature detection.
 *
 * Claudius's own message queue (the SQLite-backed `queued_messages` table)
 * only ever hands the SDK one message at a time — but `sendInput`'s
 * "mid-turn user inject" path (Claude Code TUI parity, feature 37) pushes a
 * SECOND message onto the SDK's own async input queue while a turn is
 * still in flight, so a Stop click right after that can leave content the
 * user didn't expect still queued to run. `Session.interrupt()`
 * (`lib/server/session.ts`) now forwards the SDK's receipt through the
 * `/api/sessions/[id]/interrupt` route, and the client
 * (`lib/client/use-session.ts`'s `interrupt` callback) surfaces a non-empty
 * `stillQueued` as an inline "info" system pill so the user isn't confused
 * when a response keeps streaming right after they hit Stop.
 *
 * This spec mocks the `/interrupt` route to return a non-empty
 * `stillQueued`, clicks the Stop button, and verifies:
 *   a. The pill "Stop: 2 queued messages will still run" appears in the
 *      transcript.
 *   b. A screenshot of the chat surface in context (tab strip / composer
 *      chrome around the pill) for PR review.
 *
 * Screenshot target: docs/sdk-updates/0.3.205/interrupt-still-queued.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.205");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "bbbbbbbb-cccc-dddd-eeee-000000000205";

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

  // The interrupt route itself: the real server would return whatever
  // `Session.interrupt()` forwards from the SDK's receipt. Stand in the
  // 0.3.205 shape directly so this spec doesn't depend on a live agent
  // actually having a mid-turn message queued.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/interrupt`, async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, stillQueued: ["queued-uuid-1", "queued-uuid-2"] }),
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
      uuid: "sys-1",
      model: "claude-sonnet-4-6",
    },
  },
];

function assistantEvent(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: null,
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    },
  };
}

test.describe("SDK 0.3.205 — interrupt receipt still_queued", () => {
  test("Stop click surfaces a pill when the SDK reports still-queued messages", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      assistantEvent("a1", "Working on it..."),
      { type: "replay_done", hasMoreAbove: false },
      { type: "turn_status", status: "running" },
    ]);

    await page.goto("/");

    const stopButton = page.getByTestId("prompt-interrupt");
    await expect(stopButton).toBeVisible({ timeout: 15_000 });

    await stopButton.click();

    const pill = page.getByText("Stop: 2 queued messages will still run");
    await expect(pill).toBeVisible({ timeout: 10_000 });

    await pill.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "interrupt-still-queued.png"),
      fullPage: false,
    });
  });
});
