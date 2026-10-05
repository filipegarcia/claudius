/**
 * CC 2.1.218 parity — "Added an announcement when fast mode changes as a
 * result of switching models via `/config model=<x>` or Remote Control."
 *
 * Claudius already has a fast-mode transition toast (`FastModeNoticePanel`,
 * driven by the SDK's bare `fast_mode_state` edges), but it had no
 * attribution to *why* the state changed — a model switch that flips fast
 * mode's availability produced no notice at all. The SDK has no field
 * correlating `fast_mode_state` to a model switch, so `Session.setModel`
 * derives the signal itself: it diffs `supportsFastMode` for the old vs.
 * new model (via the SDK's `supportedModels()` catalog) and includes
 * `fastModeNowSupported` on the `model_changed` broadcast when it changed.
 * `use-session.ts`'s `model_changed` handler turns that into a
 * `FastModeNotice` with `kind: "model-switch"`, and `FastModeNoticePanel`
 * renders a distinct headline naming the new model.
 *
 * This spec drives the SSE stream directly with `page.route` (same harness
 * as `cc-parity-2.1.216-context-and-compact.spec.ts`) — no real SDK/agent
 * needed: it emits a `model_changed` event carrying `fastModeNowSupported`
 * and asserts the resulting toast.
 *
 * Screenshot target: docs/cc-parity/2.1.218/fast-mode-model-switch.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.218");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "77777777-8888-9999-aaaa-000000000218";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** Mirrors cc-parity-2.1.216-context-and-compact.spec.ts's mockChatBackend. */
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
    message: { type: "system", subtype: "init", uuid: "sys-1", model: "claude-sonnet-4-6" },
  },
  { type: "replay_done", hasMoreAbove: false },
];

test.describe("Fast-mode-change announcement on model switch (CC 2.1.218 parity)", () => {
  test("switching to a non-fast-capable model shows a 'no longer available' toast", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      {
        type: "model_changed",
        model: "claude-opus-4-7",
        source: "picker",
        fastModeNowSupported: false,
      },
    ]);

    await page.goto("/");

    const notice = page.locator('[data-pane-name="fast-mode-notice"]');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveAttribute("data-fast-mode-notice", "model-switch");
    await expect(notice).toContainText("Fast mode is no longer available on claude-opus-4-7");

    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "fast-mode-model-switch.png"),
      fullPage: false,
    });
  });

  test("switching to a fast-capable model shows a 'now available' toast", async ({ page }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      {
        type: "model_changed",
        model: "claude-sonnet-4-6",
        source: "picker",
        fastModeNowSupported: true,
      },
    ]);

    await page.goto("/");

    const notice = page.locator('[data-pane-name="fast-mode-notice"]');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText("Fast mode is now available on claude-sonnet-4-6");
  });

  test("a plain model switch with unchanged fast-mode capability shows no toast", async ({
    page,
  }) => {
    // Regression guard: `fastModeNowSupported` must be OMITTED (not `false`)
    // when capability didn't change, otherwise every model switch would
    // spuriously announce "fast mode is no longer available".
    await mockChatBackend(page, [
      ...PRELUDE,
      { type: "model_changed", model: "claude-sonnet-4-5", source: "picker" },
    ]);

    await page.goto("/");

    await page.waitForTimeout(500);
    await expect(page.locator('[data-pane-name="fast-mode-notice"]')).toHaveCount(0);
  });
});
