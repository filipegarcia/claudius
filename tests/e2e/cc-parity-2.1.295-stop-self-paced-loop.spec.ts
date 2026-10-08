/**
 * Claude Code 2.1.295 parity — "Fixed Esc not stopping a self-paced /loop
 * that was moved to the background with ←; cancelling a pending wakeup now
 * shows a notice".
 *
 * Claudius had no working stop for a self-paced (`ScheduleWakeup`) loop: the
 * Activity-rail chip's X was cron-only, and a `ScheduleWakeup { stop: true }`
 * from the agent was mistaken for a new arm — the pending chip vanished and a
 * blank ghost chip took its place. Now the wake-up chip has a cancel X that
 * asks the agent to call `ScheduleWakeup` with `stop: true`, and when that
 * call arrives the pending chip flips to "cancelled" (the same notice a
 * CronDelete gives a cron chip).
 *
 * Mocks the chat backend the same way `sdk-update-0.3.245-wakeup-noop` and
 * `cc-parity-2.1.291-chat-surface` do (routed SSE fixture + captured input
 * POSTs). The fixture is read at fulfill time, so pushing the stop event
 * after the cancel click delivers it on the EventSource's next reconnect.
 *
 * Screenshot target: docs/cc-parity/2.1.295/stop-self-paced-loop.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.295");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002295sl1";
const NOW = Date.now();

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  // The mocked body ends immediately, so the browser's automatic EventSource
  // reconnect (~3s) re-requests the fixture — that's how events pushed
  // mid-test get delivered.
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockChatBackend(
  page: Page,
  events: SdkEvent[],
): Promise<{ inputs: Array<{ text?: string }> }> {
  const inputs: Array<{ text?: string }> = [];
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
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/input`, async (route: Route) => {
    inputs.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
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
  return { inputs };
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

function scheduleWakeup(n: number, input: Record<string, unknown>, atOffsetMs: number): SdkEvent {
  return {
    type: "sdk",
    at: NOW + atOffsetMs,
    message: {
      type: "assistant",
      uuid: `a-wakeup-${n}`,
      parent_tool_use_id: null,
      message: {
        id: `msg_wakeup_${n}`,
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: `toolu_wakeup_${n}`,
            name: "ScheduleWakeup",
            input,
          },
        ],
        usage: { input_tokens: 40, output_tokens: 20 },
      },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.295 — stopping a self-paced /loop", () => {
  test("the wake-up chip's X asks for ScheduleWakeup stop, and the stop flips the chip to cancelled", async ({
    page,
  }) => {
    const events: SdkEvent[] = [
      ...PRELUDE,
      scheduleWakeup(
        1,
        {
          delaySeconds: 600,
          reason: "waiting on the CI run for the release branch",
          prompt: "<<autonomous-loop-dynamic>>",
        },
        0,
      ),
    ];
    const { inputs } = await mockChatBackend(page, events);
    await page.goto("/");

    const rail = page.getByTestId("activity-section-loops");
    await expect(rail).toBeVisible({ timeout: 15_000 });
    await expect(rail).toContainText("waiting on the CI run for the release branch");
    await expect(rail).toContainText(/fires in/);

    // The cancel X used to be cron-only — a wake-up chip had no stop at all.
    const cancel = rail.getByTestId("scheduled-loop-cancel");
    await expect(cancel).toHaveCount(1);
    await expect(cancel).toBeVisible();
    await expect(cancel).toHaveAttribute("aria-label", "Ask the agent to stop this self-paced loop");
    await expect(rail.getByTestId("scheduled-loop-cancelled")).toHaveCount(0);

    await cancel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "stop-self-paced-loop.png"),
      fullPage: false,
    });

    await cancel.click();
    // Optimistic "cancelling…" while the request round-trips to the agent.
    await expect(rail.getByTestId("scheduled-loop-cancelled")).toHaveText(/cancelling/i);

    await expect.poll(() => inputs.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const text = String(inputs[0]?.text ?? "");
    expect(text).toContain("ScheduleWakeup");
    expect(text).toContain("stop: true");
    expect(text).not.toContain("CronDelete");

    // The agent complies: a stopping ScheduleWakeup arrives on the stream.
    events.push(scheduleWakeup(2, { stop: true }, 5_000));

    // The pending wake-up reads as cancelled instead of silently vanishing,
    // and the stop call doesn't arm a blank ghost chip of its own.
    const status = rail.getByTestId("scheduled-loop-cancelled");
    await expect(status).toHaveText(/^cancelled$/i, { timeout: 15_000 });
    await expect(rail.locator("li")).toHaveCount(1);
    await expect(rail).toContainText("waiting on the CI run for the release branch");
    await expect(rail.getByTestId("scheduled-loop-cancel")).toHaveCount(0);
    // A stopped wake-up never fires — no countdown left ticking toward "due now".
    await expect(rail).not.toContainText(/fires in/);
    await expect(rail).not.toContainText(/due now/);
    await expect(rail).toContainText("stopped");
  });
});
