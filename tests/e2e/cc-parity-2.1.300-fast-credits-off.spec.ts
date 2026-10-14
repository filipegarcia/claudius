/**
 * CC 2.1.300 parity — "[VSCode] Fixed fast mode staying on after usage
 * credits ran out, which made each request be refused and re-sent; it now
 * turns off until you turn it back on, with an error notice".
 *
 * On a credit-exhaustion rejection the 2.1.300 engine retries the request
 * without fast mode and emits `system/notification` with key
 * `fast-mode-overage-rejected` (priority `immediate`, color `error`). It
 * leaves the session's fast flag on, so an SDK host has to turn it off
 * itself. Claudius now does that server-side (`lib/server/session.ts`, unit
 * tested in `tests/unit/session-fast-mode-credits.test.ts`). The client
 * (`lib/client/use-session.ts`) flips the ModelPicker toggle and the
 * SessionCard fast badge to Off without POSTing `/fast` again, and the
 * notice renders as a red pill in the transcript.
 *
 * This spec turns fast on through the picker, then delivers the engine's
 * notice on the next stream connection (after `replay_done`, i.e. as a live
 * frame). It asserts the toggle reads Off, the notice is shown, and the
 * client sent no second `/fast` POST.
 *
 * Screenshot target: docs/cc-parity/2.1.300/fast-credits-off.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.300");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000300fm01";
const NOTICE_TEXT = "Fast mode disabled · usage credits exhausted";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const MODELS = [
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Balanced speed and quality.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  },
];

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-300fm", model: "claude-sonnet-4-6" } },
  {
    type: "sdk",
    message: { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "Summarise the open PRs." }] } },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const CREDITS_NOTICE: SdkEvent = {
  type: "sdk",
  message: {
    type: "system",
    subtype: "notification",
    uuid: "sys-notice-300fm",
    key: "fast-mode-overage-rejected",
    text: NOTICE_TEXT,
    priority: "immediate",
    color: "error",
  },
};

async function mockChatBackend(page: Page) {
  const state = { noticeArmed: false, fastPosts: [] as boolean[] };

  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: FAKE_SESSION_ID }) });
  });
  // Every (re)connect replays the prelude; once armed, the engine's notice
  // follows `replay_done` as a live frame.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(state.noticeArmed ? [...PRELUDE, CREDITS_NOTICE] : PRELUDE),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/fast`, async (route: Route) => {
    const body = route.request().postDataJSON() as { enabled?: boolean };
    state.fastPosts.push(Boolean(body?.enabled));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/model`, async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: MODELS }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/advisor`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: null }) });
  });
  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) });
  });
  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }) });
  });
  return state;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("fast mode turns off, with an error notice, when usage credits run out", async ({ page }) => {
  const state = await mockChatBackend(page);
  await page.goto("/");

  const trigger = page.getByTestId("model-picker-trigger");
  await expect(trigger).toContainText("Sonnet 4.6", { timeout: 30_000 });
  const panel = page.getByTestId("model-picker-panel");
  // The picker closes after a choice; reopen it to read the toggle.
  async function fastToggle() {
    if (!(await panel.isVisible())) await trigger.click();
    await expect(panel).toBeVisible();
    return panel.getByTestId("model-picker-fast");
  }

  // Turn fast mode on.
  await expect(await fastToggle()).toHaveAttribute("data-enabled", "0");
  await (await fastToggle()).click();
  await expect.poll(() => state.fastPosts).toEqual([true]);
  await expect(await fastToggle()).toHaveAttribute("data-enabled", "1");

  // The next request is refused for credits: the engine's notice arrives live.
  state.noticeArmed = true;
  const notice = page.getByText(NOTICE_TEXT);
  await expect(notice).toBeVisible({ timeout: 30_000 });

  // The picker reads Off. The server turned fast off itself, so the client
  // only flips its mirror and sends no second POST.
  await expect(await fastToggle()).toHaveAttribute("data-enabled", "0");
  expect(state.fastPosts).toEqual([true]);

  await (await fastToggle()).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "fast-credits-off.png"), fullPage: false });
});
