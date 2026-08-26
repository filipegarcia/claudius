/**
 * CC 2.1.246 — "Added the turn's completion time to the end-of-turn
 * duration line, e.g. `✻ Sautéed for 23s · done 6:05 PM`."
 *
 * Claudius's `StatusLine` showed live Idle/Working state but had no
 * per-turn elapsed timer or completion timestamp at all. This adds two
 * sibling chips next to the status label (never inside it — the
 * `turn-status.spec.ts` specs assert exact text on `status-line-text`):
 * a live "Ns" ticker while a turn is running, and a "done H:MM AM/PM" label
 * once it settles, using the real wall-clock time the turn ended.
 *
 * Reuses `turn-status.spec.ts`'s SSE-mocking helpers (`turn_status` events
 * drive the same `pending` edges this feature is stamped on).
 *
 * Screenshot target: docs/cc-parity/2.1.246/turn-duration.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.246");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "22222222-3333-4444-5555-666666666666";

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
      uuid: "sys-1",
      model: "claude-sonnet-4-6",
    },
  },
];

test.describe("Turn elapsed + completion time (CC 2.1.246)", () => {
  test("shows a live elapsed ticker while the turn is running", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      { type: "replay_done", hasMoreAbove: false },
      { type: "turn_status", status: "running" },
    ]);

    await page.goto("/");

    const statusText = page.getByTestId("status-line-text");
    await expect(statusText).toBeVisible({ timeout: 15_000 });
    await expect(statusText).toHaveText("Working");

    const elapsed = page.getByTestId("status-line-elapsed");
    await expect(elapsed).toBeVisible();
    await expect(elapsed).toHaveText(/^\d+s$/);
    const first = Number((await elapsed.textContent())?.replace("s", ""));

    // No "done" label yet — the turn hasn't completed.
    await expect(page.getByTestId("status-line-done")).toHaveCount(0);

    // Live ticker: the count only ever advances, matching the real elapsed
    // clock rather than a static render.
    await expect
      .poll(async () => Number((await elapsed.textContent())?.replace("s", "")), { timeout: 5_000 })
      .toBeGreaterThan(first);

    // Screenshot in context: full chat header chrome with the ticker live.
    await page.screenshot({
      path: resolve(SHOTS_DIR, "turn-duration.png"),
      fullPage: false,
    });
  });

  test("shows a wall-clock 'done' time once the turn completes", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      { type: "replay_done", hasMoreAbove: false },
      { type: "turn_status", status: "running" },
      { type: "turn_status", status: "idle" },
    ]);

    await page.goto("/");

    const statusText = page.getByTestId("status-line-text");
    await expect(statusText).toBeVisible({ timeout: 15_000 });
    await expect(statusText).toHaveText("Idle");

    // The elapsed ticker is gone (no turn in flight)...
    await expect(page.getByTestId("status-line-elapsed")).toHaveCount(0);
    // ...replaced by the completion timestamp, in "done H:MM AM/PM" shape.
    const done = page.getByTestId("status-line-done");
    await expect(done).toBeVisible();
    await expect(done).toHaveText(/^done \d{1,2}:\d{2}\s?(AM|PM)$/i);
  });
});
