/**
 * Claude Code 2.1.275 parity — "Added a send-now key (ctrl+enter, or
 * ctrl+x ctrl+s) that interrupts the current turn and sends all queued
 * messages at once."
 *
 * Claudius already had per-item "Send now" (jump one queued message ahead)
 * and a Ctrl+C interrupt, but nothing that flushed the *whole* queue in one
 * action. This adds:
 *   - `POST /api/sessions/[id]/queue/send-all` — orchestrates the existing
 *     `interrupt()` + `sendQueuedNow(uuid)` primitives over every queued row.
 *   - a "Send all now" button on the QueueIndicator strip (shown once more
 *     than one message is queued — a single item already has its own
 *     per-row "Send now").
 *   - a Ctrl+Enter binding in the composer that fires the same action.
 *
 * This spec mocks the chat backend the same way
 * `sdk-update-0.3.245-queued-turn-count.spec.ts` does (fixed SSE fixture +
 * routed POSTs) and asserts both entry points hit the new endpoint, plus
 * captures the strip in context.
 *
 * Screenshot target: docs/cc-parity/2.1.275/send-all-queued-now.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.275");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-0000002751q";
const NOW = Date.now();

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(
  page: Page,
  events: SdkEvent[],
): Promise<{ sendAllCalls: number[] }> {
  const calls: number[] = [];

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

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/queue/send-all`, async (route: Route) => {
    calls.push(Date.now());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, dispatched: ["q-1", "q-2"] }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/interrupt`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, stillQueued: [] }),
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

  return { sendAllCalls: calls };
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

/** Two staged messages — enough to show the "Send all now" affordance. */
const TWO_QUEUED: SdkEvent = {
  type: "queue:updated",
  at: NOW,
  sessionId: FAKE_SESSION_ID,
  queue: [
    { uuid: "q-1", text: "run the migration", createdAtMs: NOW },
    { uuid: "q-2", text: "then update the changelog", createdAtMs: NOW + 1 },
  ],
  sdkQueuedTurns: 0,
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Send-now key: flush the whole queue at once (CC 2.1.275)", () => {
  test("'Send all now' button appears once more than one message is queued and hits the new endpoint", async ({
    page,
  }) => {
    const { sendAllCalls } = await mockChatBackend(page, [...PRELUDE, TWO_QUEUED]);
    await page.goto("/");

    const strip = page.getByTestId("queue-indicator");
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(strip).toContainText("run the migration");
    await expect(strip).toContainText("then update the changelog");

    const sendAllBtn = page.getByTestId("queue-send-all-now");
    await expect(sendAllBtn).toBeVisible();

    await strip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "send-all-queued-now.png"),
      fullPage: false,
    });

    await sendAllBtn.click();
    await expect.poll(() => sendAllCalls.length).toBeGreaterThan(0);
  });

  test("Ctrl+Enter in the composer triggers the same send-all action", async ({ page }) => {
    const { sendAllCalls } = await mockChatBackend(page, [...PRELUDE, TWO_QUEUED]);
    await page.goto("/");

    const strip = page.getByTestId("queue-indicator");
    await expect(strip).toBeVisible({ timeout: 15_000 });

    const composer = page.getByTestId("prompt-input");
    await composer.click();
    await page.keyboard.press("Control+Enter");

    await expect.poll(() => sendAllCalls.length).toBeGreaterThan(0);
  });

  test("a single queued message does not show 'Send all now' — only the per-item Send now", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      {
        type: "queue:updated",
        at: NOW,
        sessionId: FAKE_SESSION_ID,
        queue: [{ uuid: "q-1", text: "just this one", createdAtMs: NOW }],
        sdkQueuedTurns: 0,
      },
    ]);
    await page.goto("/");

    const strip = page.getByTestId("queue-indicator");
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("queue-send-all-now")).toHaveCount(0);
    await expect(strip.getByRole("button", { name: /Send now/ })).toHaveCount(1);
  });
});
