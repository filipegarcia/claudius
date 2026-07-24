/**
 * SDK 0.3.219 — `fast_mode_disabled_reason` on the `result` / `system:init`
 * messages.
 *
 * Before this release, `FastModeState` was the bare `'off' | 'cooldown' |
 * 'on'` — the SDK gave no reason for why fast mode couldn't serve, so the
 * cooldown toast (`FastModeNoticePanel`) and the StatusLine's `⚡ cooldown`
 * chip could only ever say "temporarily unavailable". 0.3.219 adds
 * `fast_mode_disabled_reason` (e.g. `extra_usage_disabled`, `free`,
 * `model_not_allowed`); Claudius now threads it through
 * `lib/client/use-session.ts` into both surfaces via the reason → copy
 * mapping in `lib/shared/fast-mode.ts`.
 *
 * This spec mocks a two-turn SSE stream: the first `result` reports
 * `fast_mode_state: "on"` (seeds the edge-detector, no toast), the second
 * transitions to `"cooldown"` with `fast_mode_disabled_reason:
 * "extra_usage_disabled"` — which should produce the reason-specific detail
 * text on both the transient toast and the persistent StatusLine chip's
 * tooltip.
 *
 * Screenshot target: docs/sdk-updates/0.3.219/fast-mode-disabled-reason.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.219");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000219fa";

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

function assistant(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "assistant",
      uuid,
      parent_tool_use_id: null,
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
        usage: { input_tokens: 80, output_tokens: 12 },
      },
    },
  };
}

function result(uuid: string, fastModeState: "on" | "cooldown", reason?: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "result",
      uuid,
      subtype: "success",
      total_cost_usd: 0.02,
      num_turns: 1,
      duration_ms: 800,
      duration_api_ms: 600,
      fast_mode_state: fastModeState,
      ...(reason ? { fast_mode_disabled_reason: reason } : {}),
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("fast_mode_disabled_reason (SDK 0.3.219)", () => {
  test("cooldown toast and StatusLine chip show the specific reason, not generic copy", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      assistant("a1", "Working on the first turn…"),
      result("result-1", "on"),
      assistant("a2", "Working on the second turn…"),
      result("result-2", "cooldown", "extra_usage_disabled"),
    ]);
    await page.goto("/");

    // The transient toast, with the reason-specific detail text.
    const notice = page.locator('[data-pane-name="fast-mode-notice"]');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveAttribute("data-fast-mode-notice", "cooldown");
    await expect(notice).toContainText("Fast mode temporarily unavailable");
    await expect(notice).toContainText("Extra usage is disabled, and fast mode requires it.");

    // The persistent StatusLine chip, with the same reason in its tooltip.
    const chip = page.getByTestId("status-line-fast");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-fast-state", "cooldown");
    await expect(chip).toHaveAttribute(
      "title",
      "Extra usage is disabled, and fast mode requires it.",
    );

    await page.waitForTimeout(300);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "fast-mode-disabled-reason.png"),
      fullPage: false,
    });
  });
});
