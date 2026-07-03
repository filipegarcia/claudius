/**
 * CC 2.1.199 — SessionStart/Setup/SubagentStart hooks that exit 2 no longer
 * silently hide stderr; the CLI now shows it in the transcript.
 *
 * Claudius already renders `hook_response` system events as a pill
 * (`components/chat/SystemPill.tsx`), but only read `hook_name` / `outcome` /
 * `exit_code` off the SDK's `SDKHookResponseMessage` — the message has
 * always carried a `stderr` field, it just went unread. This spec drives a
 * failed-hook `hook_response` event through the mocked SSE stream and
 * verifies the pill now surfaces that stderr (expandable, error-toned)
 * instead of dropping it.
 *
 * Screenshot target: docs/cc-parity/2.1.199/hook-stderr-on-failure.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.199");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000002199";

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
];

const HOOK_STARTED: SdkEvent = {
  type: "sdk",
  message: {
    type: "system",
    subtype: "hook_started",
    uuid: "hook-started-199",
    hook_id: "h1",
    hook_name: "SessionStart",
    hook_event: "SessionStart",
  },
};

const HOOK_RESPONSE_FAILED: SdkEvent = {
  type: "sdk",
  message: {
    type: "system",
    subtype: "hook_response",
    uuid: "hook-response-199",
    hook_id: "h1",
    hook_name: "SessionStart",
    hook_event: "SessionStart",
    output: "",
    stdout: "",
    stderr: "SessionStart hook failed: missing CLAUDE_PROJECT_TOKEN env var",
    exit_code: 2,
    outcome: "error",
  },
};

const TAIL: SdkEvent[] = [{ type: "replay_done", hasMoreAbove: false }];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.199 — hook stderr surfaced on failure", () => {
  test("hook_response pill shows stderr for a failed (exit 2) hook", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, HOOK_STARTED, HOOK_RESPONSE_FAILED, ...TAIL]);
    await page.goto("/");

    const pill = page.getByText(/Hook SessionStart → error/);
    await expect(pill).toBeVisible({ timeout: 15_000 });

    // exit code shown alongside the failure.
    await expect(page.getByText("exit 2")).toBeVisible();

    // stderr is collapsed by default — not visible until expanded.
    const stderrText = /SessionStart hook failed: missing CLAUDE_PROJECT_TOKEN env var/;
    await expect(page.getByText(stderrText)).toHaveCount(0);

    await pill.click();
    await expect(page.getByText(stderrText)).toBeVisible({ timeout: 5_000 });

    await pill.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "hook-stderr-on-failure.png"),
      fullPage: false,
    });
  });
});
