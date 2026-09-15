/**
 * SDK 0.3.269 (part of the 0.3.267→0.3.272 window) — `resume_reason` on the
 * result message: set only on the automatic re-run of a turn that a host
 * restart interrupted mid-way (the CLI's
 * `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` rescue path). Not called out in the
 * prose changelog for any single point release — found by diffing `sdk.d.ts`.
 *
 * Claudius persists sessions to SQLite and can resume the underlying `Session`
 * independently of the browser tab (dev-server reload, service restart), so
 * this is a real path here, not just a hosted-container concern. Without
 * surfacing it, a user reconnecting after such a restart would see a turn
 * apparently re-run with no explanation.
 *
 * `lib/client/use-session.ts`'s `result`-message handler now reads
 * `resume_reason` and appends an "info" `SystemEntry` pill
 * ("Turn resumed after interruption") anchored after the in-flight assistant
 * message, rendered generically by `SystemPill.tsx`'s `info`-kind fallback.
 *
 * Screenshot target: docs/sdk-updates/0.3.272/resume-reason-pill.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.272");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000272r1";

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
      uuid: "sys-init-272r",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const ASSISTANT_REPLY: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-272r",
    parent_tool_use_id: null,
    message: {
      id: "msg_272r",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Picking up where we left off." }],
      usage: { input_tokens: 30, output_tokens: 12 },
    },
  },
};

const RESULT_RESUMED: SdkEvent = {
  type: "sdk",
  message: {
    type: "result",
    uuid: "result-272r",
    subtype: "success",
    total_cost_usd: 0.004,
    num_turns: 1,
    duration_ms: 900,
    duration_api_ms: 700,
    resume_reason: "host_draining",
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Resumed-turn nudge (SDK result.resume_reason)", () => {
  test("a result with resume_reason shows an explanatory info pill", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, ASSISTANT_REPLY, RESULT_RESUMED]);
    await page.goto("/");

    await expect(
      page.getByText("Picking up where we left off.", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });

    const pill = page.getByText("Turn resumed after interruption", { exact: false });
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("the host was draining for maintenance")).toBeVisible();

    await pill.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "resume-reason-pill.png"),
      fullPage: false,
    });
  });
});
