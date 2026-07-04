/**
 * SDK 0.3.200 — `set_model` rejects an unrecognized model *before* it
 * latches, instead of possibly landing half-applied.
 *
 * The server-side plumbing already assumed reject-before-latch:
 * `lib/server/session.ts#setModel` only mutates `this.model` / persists /
 * broadcasts after `await query.setModel(...)` resolves, and the
 * `POST /api/sessions/<id>/model` route maps a `{ ok:false }` result to
 * HTTP 409 so the client can revert its optimistic pick and raise
 * `ModelSwitchNoticePanel`. 0.3.200 makes that rejection path fire far more
 * reliably, which exposed the one place it was under-served: the `/model`
 * slash command's immediate toast used to read "Model → <id>" — a false
 * success claim right before the rejection banner contradicted it. The copy
 * now reads "Switching model → <id>" (an *attempt*, not success).
 *
 * This spec drives the real client path end-to-end against a mocked
 * backend:
 *   a. Typing `/model definitely-not-a-real-model` and sending it fires the
 *      native `/model` handler, which raises the "Switching model → …"
 *      toast (the reworded copy) and POSTs the pick.
 *   b. The mocked route rejects with HTTP 409 + the SDK's error text and the
 *      server-authoritative (unchanged) model, so `ModelSwitchNoticePanel`
 *      surfaces "Couldn't switch to definitely-not-a-real-model".
 *   c. A screenshot of the chat with the amber rejection banner in its
 *      surrounding chrome for PR review.
 *
 * Screenshot target: docs/sdk-updates/0.3.200/model-switch-rejected.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.200");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000200";
const BAD_MODEL = "definitely-not-a-real-model";
const CURRENT_MODEL = "claude-opus-4-8";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const PRELUDE: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: {
      type: "system",
      subtype: "init",
      uuid: "sys-1",
      model: CURRENT_MODEL,
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

type Capture = { modelPosts: Array<{ model: string | null; source?: string }> };

async function mockChatBackend(page: Page, capture: Capture): Promise<void> {
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
      body: sseBody(PRELUDE),
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
    const method = route.request().method();
    if (method === "GET") {
      // The trigger pill fetches the model list on mount; return a minimal
      // one so nothing else on the page errors.
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: [
            { value: CURRENT_MODEL, displayName: "Opus 4.8", description: "Deep reasoning" },
          ],
        }),
      });
    }
    if (method === "POST") {
      const body = route.request().postDataJSON() as { model?: string | null; source?: string };
      capture.modelPosts.push({ model: body?.model ?? null, source: body?.source });
      // 0.3.200 reject-before-latch: the SDK refuses the unrecognized id, so
      // the route returns 409 with the error and the UNCHANGED server model.
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: `unrecognized model '${BAD_MODEL}'`,
          model: CURRENT_MODEL,
        }),
      });
    }
    return route.fallback();
  });
}

test.describe("SDK 0.3.200 — rejected /model switch", () => {
  test("/model <bad-id> toasts an attempt, then surfaces the rejection banner", async ({
    page,
  }) => {
    const capture: Capture = { modelPosts: [] };
    await mockChatBackend(page, capture);

    await page.goto("/");

    // Composer is disabled until `useSession` sees the `ready` frame; wait
    // for it to become editable before typing.
    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeEnabled({ timeout: 30_000 });

    await composer.click();
    await composer.fill(`/model ${BAD_MODEL}`);
    await expect(composer).toHaveValue(`/model ${BAD_MODEL}`);

    const send = page.getByTestId("prompt-send");
    await expect(send).toBeEnabled();
    await send.click();

    // The reworded slash-command toast: an *attempt*, not a success claim.
    // (It auto-dismisses after ~2.2s; assert it before the async POST
    // resolves the rejection banner.)
    await expect(page.getByText(`Switching model → ${BAD_MODEL}`)).toBeVisible({
      timeout: 5_000,
    });

    // The POST landed with the chat-command source.
    await expect.poll(() => capture.modelPosts.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(capture.modelPosts.at(-1)).toMatchObject({
      model: BAD_MODEL,
      source: "chat_command",
    });

    // The 409 raises ModelSwitchNoticePanel with the "Couldn't switch to …"
    // headline and the SDK error text underneath.
    const banner = page.locator('[data-model-switch-notice="rejected"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(`Couldn't switch to ${BAD_MODEL}`);

    // Capture the banner in the full chat chrome for PR review.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "model-switch-rejected.png"),
      fullPage: false,
    });
  });
});
