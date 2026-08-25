/**
 * SDK 0.3.245 — `ScheduleWakeupInput` gained `noop`: the agent reporting
 * that a self-paced loop tick changed nothing ("no change", "still waiting",
 * "quiet hold") versus one that did something worth keeping. Claude Code
 * collapses consecutive `noop: true` ticks in its terminal view and tracks
 * the run as a streak, so a long quiet hold stays legible instead of
 * scrolling past as an indistinguishable series.
 *
 * The field appears nowhere in the upstream prose changelog for the
 * 0.3.241 → 0.3.245 window — it was found by diffing `sdk-tools.d.ts`.
 * Claudius already reconstructs session loops from this tool's *input*
 * (`delaySeconds` / `reason` / `prompt`), so `noop` slots into the same
 * reducer. The streak has to be accumulated as each wake-up supersedes the
 * last, because the field itself is per-tick.
 *
 * Screenshot target: docs/sdk-updates/0.3.245/wakeup-quiet-hold.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.245");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000245n1";
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
 * One `/loop` tick. A dynamic-mode loop chains exactly one ScheduleWakeup
 * per turn, each superseding the previous entry — which is why the streak
 * has to be carried across the replacement rather than read off one call.
 */
function wakeup(
  n: number,
  opts: { noop?: boolean; reason: string; atOffsetMs: number },
): SdkEvent {
  return {
    type: "sdk",
    at: NOW + opts.atOffsetMs,
    message: {
      type: "assistant",
      uuid: `a${n}`,
      parent_tool_use_id: null,
      message: {
        id: `msg_${n}`,
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: `toolu_wakeup_${n}`,
            name: "ScheduleWakeup",
            input: {
              delaySeconds: 1800,
              prompt: "/loop check whether the deploy finished",
              reason: opts.reason,
              ...(opts.noop === undefined ? {} : { noop: opts.noop }),
            },
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

test.describe("Wake-up quiet hold (SDK 0.3.245 ScheduleWakeup.noop)", () => {
  test("consecutive quiet ticks collapse into one chip carrying the streak", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      wakeup(1, { noop: true, reason: "deploy still queued", atOffsetMs: 0 }),
      wakeup(2, { noop: true, reason: "deploy still queued", atOffsetMs: 1000 }),
      wakeup(3, { noop: true, reason: "deploy still running", atOffsetMs: 2000 }),
    ]);
    await page.goto("/");

    const rail = page.getByTestId("activity-section-loops");
    await expect(rail).toBeVisible({ timeout: 15_000 });

    // Only the latest wake-up is "armed" — the chain replaces, it doesn't
    // accumulate rows.
    const chips = rail.getByTestId("loop-noop");
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveText("quiet hold ×3");

    await chips.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "wakeup-quiet-hold.png"),
      fullPage: false,
    });
  });

  test("a single quiet tick reads as a plain chip with no count", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      wakeup(1, { noop: true, reason: "nothing new", atOffsetMs: 0 }),
    ]);
    await page.goto("/");

    const chip = page.getByTestId("activity-section-loops").getByTestId("loop-noop");
    await expect(chip).toBeVisible({ timeout: 15_000 });
    // A streak of one is not worth a "×1" suffix.
    await expect(chip).toHaveText("quiet hold");
  });

  test("a tick that did something clears the streak", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      wakeup(1, { noop: true, reason: "deploy still queued", atOffsetMs: 0 }),
      wakeup(2, { noop: true, reason: "deploy still queued", atOffsetMs: 1000 }),
      // `noop: false` — this tick posted a result, so the run ends here.
      wakeup(3, { noop: false, reason: "deploy finished, filed the report", atOffsetMs: 2000 }),
    ]);
    await page.goto("/");

    const rail = page.getByTestId("activity-section-loops");
    await expect(rail).toBeVisible({ timeout: 15_000 });
    await expect(rail).toContainText("deploy finished, filed the report");
    await expect(rail.getByTestId("loop-noop")).toHaveCount(0);
  });

  test("a wake-up from an older SDK, with no noop field, is unaffected", async ({ page }) => {
    // Absent must not be read as `false`-with-a-chip or as `true` — older
    // CLIs simply don't send the field.
    await mockChatBackend(page, [
      ...PRELUDE,
      wakeup(1, { reason: "polling the queue", atOffsetMs: 0 }),
    ]);
    await page.goto("/");

    const rail = page.getByTestId("activity-section-loops");
    await expect(rail).toBeVisible({ timeout: 15_000 });
    await expect(rail).toContainText("polling the queue");
    await expect(rail.getByTestId("loop-noop")).toHaveCount(0);
  });
});
