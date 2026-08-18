/**
 * SDK 0.3.234 — `effort` on the `system:init` message.
 *
 * Before this release the SDK had no `effort_changed` analogue to
 * `model_changed`, so `use-session.ts` could only *optimistically* mirror
 * reasoning effort: "auto" until the user picked a level through the
 * ModelPicker, with no way to correct for a silent server-side downgrade (env
 * override, org cap, model-support ceiling) or for a user typing `/effort
 * high` straight into the composer. 0.3.234 adds an `effort` field to
 * `system:init` — the session's authoritative *applied* effort, post every
 * resolution step. `lib/shared/parse-init.ts` now extracts it and
 * `lib/client/use-session.ts` uses it to correct the mirror on session
 * start/reconnect (`if (init.effort) setEffortState(init.effort)`).
 *
 * This spec starts a session whose `system:init` reports `effort: "high"`
 * with NO picker interaction at all, and asserts the SessionCard's
 * always-on effort pill (`session-card-effort-pill`, right-rail
 * BackgroundTasksPanel) already reads "high" from the very first paint —
 * proving the mirror is seeded from the init message rather than staying
 * stuck at the "auto" default.
 *
 * Screenshot target: docs/sdk-updates/0.3.234/effort-init-mirror.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.234");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000234ef";

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

function events(effort: "low" | "medium" | "high" | "xhigh" | "max" | null): SdkEvent[] {
  return [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    {
      type: "sdk",
      message: {
        type: "system",
        subtype: "init",
        uuid: "sys-init-0",
        model: "claude-opus-4-7",
        effort,
      },
    },
    { type: "replay_done", hasMoreAbove: false },
    {
      type: "sdk",
      message: {
        type: "assistant",
        uuid: "a1",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "Ready to help." }],
          usage: { input_tokens: 40, output_tokens: 6 },
        },
      },
    },
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("effort mirror seeded from system:init (SDK 0.3.234)", () => {
  test("a session that inits at effort=high shows 'high' on first paint, no picker interaction", async ({
    page,
  }) => {
    await mockChatBackend(page, events("high"));
    await page.goto("/");

    const pill = page.getByTestId("session-card-effort-pill");
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(pill).toHaveAttribute("data-effort", "high");
    await expect(pill).toHaveAttribute("title", "Reasoning effort: high");
    await expect(pill).toContainText("high");

    await pill.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "effort-init-mirror.png"),
      fullPage: false,
    });
  });

  test("effort=null on init leaves the 'auto' default untouched", async ({ page }) => {
    await mockChatBackend(page, events(null));
    await page.goto("/");

    const pill = page.getByTestId("session-card-effort-pill");
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(pill).toHaveAttribute("data-effort", "auto");
  });
});
