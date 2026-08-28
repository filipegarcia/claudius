/**
 * SDK 0.3.251 — `PostModelSwitch` hook, `source: "auto"`.
 *
 * The SDK's `.d.ts` diff adds a `PostModelSwitch` control-protocol hook
 * event, fired after the model changes mid-session, with a `source` field
 * that includes `"auto"` — an automatic `fallbackModel` swap the SDK applies
 * on its own (e.g. after a rate limit hit). Before this release, Claudius
 * had no way to observe that swap: `lib/server/session.ts#setModel` (picker)
 * and the `local_command_output` regex (chat `/model`) only cover switches
 * the user drove directly, so an automatic fallback changed the model with
 * *zero* client-visible signal — the user only found out once responses
 * started coming back from a different model (see the `opusOverloadStreak`
 * doc comment in session.ts: "the SDK's automatic fallbackModel path...
 * swaps silently").
 *
 * `lib/server/session.ts` now registers a `PostModelSwitch` hook that
 * broadcasts the existing `model_changed` SSE event with `source: "auto"`
 * for exactly this case, and the client raises a toast. This spec can't
 * drive the real SDK-side fallback (that requires an actual rate-limit
 * condition against a live agent), so it verifies the client half of the
 * contract by injecting the SSE event the hook would produce and asserting
 * the resulting toast — see the "server-side hook is unverified" note in
 * the run-notes Risks section for what this spec does NOT cover.
 *
 * Screenshot target: docs/sdk-updates/0.3.251/auto-model-switch-notice.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.251");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000251";
const STARTING_MODEL = "claude-opus-4-8";
const FALLBACK_MODEL = "claude-sonnet-4-5";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-1",
      model: STARTING_MODEL,
    },
  },
  { type: "replay_done", hasMoreAbove: false },
  // What `lib/server/session.ts`'s new PostModelSwitch hook broadcasts when
  // the SDK applies `fallbackModel` on its own mid-turn.
  { type: "model_changed", model: FALLBACK_MODEL, source: "auto" },
];

async function mockChatBackend(page: Page): Promise<void> {
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
      body: sseBody(EVENTS),
    });
  });

  await page.route("**/api/sessions/open-tabs", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeId: null, tabs: [] }),
    });
  });

  await page.route(
    `**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`,
    async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ asks: [], permissions: [] }),
      });
    },
  );

  await page.route("**/api/limits*", async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    });
  });

  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/model`, async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          { value: STARTING_MODEL, displayName: "Opus 4.8", description: "Deep reasoning" },
          { value: FALLBACK_MODEL, displayName: "Sonnet 4.5", description: "Balanced" },
        ],
      }),
    });
  });
}

test.describe("SDK 0.3.251 — PostModelSwitch source:auto notice", () => {
  test("an automatic fallback swap surfaces a toast instead of switching silently", async ({
    page,
  }) => {
    await mockChatBackend(page);

    await page.goto("/");

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });

    // The toast the new PostModelSwitch(`source: "auto"`) broadcast raises —
    // distinct copy from the chat-command variant ("Your pick becomes the
    // default") since an automatic fallback isn't a user pick.
    const notice = page.locator('[data-pane-name="model-chat-command-notice"]');
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toHaveAttribute("data-reason", "auto");
    await expect(notice).toContainText("Switched to sonnet-4-5");
    await expect(notice).toContainText("Automatic fallback (rate limit)");

    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "auto-model-switch-notice.png"),
      fullPage: false,
    });
  });
});
