/**
 * SDK 0.3.243 — result messages gained `queued_turn_count`: user sends still
 * waiting in the **SDK's own** command queue when the result was produced.
 *
 * That is a different queue from Claudius's DB-backed `queued_messages`
 * table, and normally the two are disjoint: in the default
 * `queueDispatchMode: "wait"` everything parks in our table and the SDK's
 * count stays 0. But under `queueDispatchMode: "asap"` — and for every
 * "Send now" click — the server pushes straight to the agent's input pipe
 * mid-turn, so sends stack up on the SDK side where our table cannot see
 * them. Before this change the QueueIndicator strip read *empty* in exactly
 * that case, while turns were genuinely pending.
 *
 * This spec drives the `queue:updated` event with an empty `queue` and a
 * non-zero `sdkQueuedTurns`, asserting the strip appears anyway and reports
 * the pending turns without offering edit/reorder/withdraw affordances (once
 * a message is inside the SDK's queue we no longer hold it).
 *
 * Screenshot target: docs/sdk-updates/0.3.245/sdk-queued-turns.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.245");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000245q1";
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
 * The asap-mode shape: our own queue is empty (the sends bypassed the DB
 * table entirely) while the SDK reports two turns still pending.
 */
const SDK_QUEUE_ONLY: SdkEvent = {
  type: "queue:updated",
  at: NOW,
  sessionId: FAKE_SESSION_ID,
  queue: [],
  sdkQueuedTurns: 2,
};

/** Both queues populated — the two rows must coexist, not replace each other. */
const BOTH_QUEUES: SdkEvent = {
  type: "queue:updated",
  at: NOW + 100,
  sessionId: FAKE_SESSION_ID,
  queue: [
    {
      uuid: "q-1",
      text: "and then update the changelog",
      createdAtMs: NOW,
    },
  ],
  sdkQueuedTurns: 1,
};

/** The turn drained: no rows on either side, so the strip goes away. */
const DRAINED: SdkEvent = {
  type: "queue:updated",
  at: NOW + 200,
  sessionId: FAKE_SESSION_ID,
  queue: [],
  sdkQueuedTurns: 0,
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("SDK-side queued turns (SDK 0.3.243 queued_turn_count)", () => {
  test("pending SDK turns show in the strip even when our own queue is empty", async ({
    page,
  }) => {
    await mockChatBackend(page, [...PRELUDE, SDK_QUEUE_ONLY]);
    await page.goto("/");

    const strip = page.getByTestId("queue-indicator");
    await expect(strip).toBeVisible({ timeout: 15_000 });

    const sdkRow = page.getByTestId("sdk-queued-turns");
    await expect(sdkRow).toBeVisible();
    await expect(sdkRow).toHaveText(/2 more turns sent · runs automatically/);

    // Our own queue contributed nothing, so the "Queued · sends after
    // current response" header — which belongs to the cancellable rows —
    // must not appear.
    await expect(strip).not.toContainText("sends after current response");

    // These sends are already inside the SDK; we no longer hold them, so
    // none of the row affordances should be offered for them.
    await expect(strip.getByRole("button", { name: /Remove/ })).toHaveCount(0);
    await expect(strip.getByRole("button", { name: /Send now/ })).toHaveCount(0);
    await expect(strip.getByRole("button", { name: /Edit/ })).toHaveCount(0);

    await strip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "sdk-queued-turns.png"),
      fullPage: false,
    });
  });

  test("singular wording for a single pending turn, alongside our own queued rows", async ({
    page,
  }) => {
    await mockChatBackend(page, [...PRELUDE, BOTH_QUEUES]);
    await page.goto("/");

    const strip = page.getByTestId("queue-indicator");
    await expect(strip).toBeVisible({ timeout: 15_000 });

    // Both halves render: our cancellable row keeps its header and Remove
    // button, and the SDK count sits below it.
    await expect(strip).toContainText("sends after current response");
    await expect(strip).toContainText("and then update the changelog");
    await expect(strip.getByRole("button", { name: /Remove/ })).toHaveCount(1);

    await expect(page.getByTestId("sdk-queued-turns")).toHaveText(
      /1 more turn sent · runs automatically/,
    );
  });

  test("the strip disappears once both queues drain", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, SDK_QUEUE_ONLY, DRAINED]);
    await page.goto("/");

    // The composer is up, so the app is live — the strip is simply absent.
    await expect(page.getByTestId("sdk-queued-turns")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("queue-indicator")).toHaveCount(0);
  });
});
