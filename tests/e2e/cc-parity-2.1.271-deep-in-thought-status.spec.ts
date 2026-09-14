/**
 * CC 2.1.271 — "Improved the spinner status during long thinking: it now
 * reads 'deep in thought' after 45s."
 *
 * Claudius's `StatusLine` already shows a live "Working" label plus a
 * per-turn elapsed-time ticker (CC 2.1.246 parity). This extends that same
 * label to swap to "Deep in thought" once the ticker crosses 45s, rather
 * than sitting on the generic "Working" text for the whole turn. Pure logic
 * lives in `lib/shared/turn-status-label.ts` (unit-tested separately); this
 * spec drives the real `StatusLine` end-to-end and captures the swap in
 * context.
 *
 * `turnStartedAt` is stamped client-side (`Date.now()`) on the pending
 * false->true edge (see `lib/client/use-session.ts`), so the 45s threshold
 * is reached deterministically here via Playwright's `page.clock` rather
 * than a real 45s sleep.
 *
 * Reuses `turn-status.spec.ts` / `cc-parity-2.1.246-turn-duration.spec.ts`'s
 * SSE-mocking helpers (`turn_status` events drive the same `pending` edges).
 *
 * Screenshot target: docs/cc-parity/2.1.271/deep-in-thought-status.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.271");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "33333333-4444-5555-6666-777777777777";

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

test.describe("StatusLine 'Deep in thought' label (CC 2.1.271)", () => {
  // Matches cc-parity-2.1.246-turn-duration.spec.ts's viewport choice — the
  // elapsed/done chips (and now this label swap) are the header's rightmost
  // items, so a wide-enough viewport keeps the screenshot representative of
  // the common (uncrowded) case.
  test.use({ viewport: { width: 1600, height: 900 } });

  test("swaps 'Working' to 'Deep in thought' after 45s of continuous turn time", async ({
    page,
  }) => {
    await page.clock.install({ time: Date.now() });
    await mockChatBackend(page, [
      ...PRELUDE,
      { type: "replay_done", hasMoreAbove: false },
      { type: "turn_status", status: "running" },
    ]);

    await page.goto("/");

    const statusText = page.getByTestId("status-line-text");
    await expect(statusText).toBeVisible({ timeout: 15_000 });
    await expect(statusText).toHaveText("Working");

    // Before the threshold: still "Working".
    await page.clock.fastForward(44_000);
    await expect(statusText).toHaveText("Working");

    // Cross the 45s threshold.
    await page.clock.fastForward(2_000);
    await expect(statusText).toHaveText("Deep in thought");

    // The elapsed ticker keeps counting alongside the new label — this is a
    // label swap, not a different status. `formatElapsed` renders bare
    // seconds below the 1-minute mark (see `lib/client/use-elapsed.ts`).
    const elapsed = page.getByTestId("status-line-elapsed");
    await expect(elapsed).toBeVisible();
    await expect(elapsed).toHaveText(/^\d+s$/);

    // Screenshot in context: full chat header chrome, "Deep in thought" +
    // the live elapsed chip both visible.
    await page.screenshot({
      path: resolve(SHOTS_DIR, "deep-in-thought-status.png"),
      fullPage: false,
    });
  });

  test("stays 'Working' before the 45s threshold", async ({ page }) => {
    await page.clock.install({ time: Date.now() });
    await mockChatBackend(page, [
      ...PRELUDE,
      { type: "replay_done", hasMoreAbove: false },
      { type: "turn_status", status: "running" },
    ]);

    await page.goto("/");

    const statusText = page.getByTestId("status-line-text");
    await expect(statusText).toBeVisible({ timeout: 15_000 });
    await page.clock.fastForward(30_000);
    await expect(statusText).toHaveText("Working");
  });
});
