/**
 * Claude Code 2.1.295 parity — "Fixed a queued message being lost when pulled
 * back into the prompt with ↑ or Esc just after ←: prompt history now keeps
 * it".
 *
 * Claudius's analogue is the QueueIndicator's Edit action: it DELETEs the
 * queued row server-side and replaces the composer with its text. Lifting A
 * then B used to lose A entirely — it was never sent, so it never reached the
 * prompt history built from user messages. Now:
 *   - lifted texts are merged into the composer's Cmd/Ctrl+↑ history, and the
 *     first press skips the entry the composer already shows (B) → A;
 *   - the draft a lift overwrites is stashed in the cleared-draft slot, so a
 *     plain ↑ on the emptied composer brings it back too.
 *
 * Mocks the chat backend the same way the 2.1.275 send-all spec does (fixed
 * SSE fixture with queued rows + routed DELETEs).
 *
 * Screenshot target: docs/cc-parity/2.1.295/queue-lift-history.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.295");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000029501q";
const NOW = Date.now();

const QUEUED = [
  { uuid: "q-a", text: "rename the config loader to loadSettings", createdAtMs: NOW },
  { uuid: "q-b", text: "then add a unit test for the empty-file case", createdAtMs: NOW + 1 },
  { uuid: "q-c", text: "finally bump the changelog", createdAtMs: NOW + 2 },
];

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
      uuid: "sys-init-0",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

async function mockChatBackend(page: Page): Promise<{ deleted: string[] }> {
  const deleted: string[] = [];

  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });

  // Serve the queue minus whatever was lifted, so a stream reconnect shows
  // the server's real post-DELETE state.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody([
        ...PRELUDE,
        {
          type: "queue:updated",
          at: NOW,
          sessionId: FAKE_SESSION_ID,
          queue: QUEUED.filter((q) => !deleted.includes(q.uuid)),
          sdkQueuedTurns: 0,
        },
      ]),
    });
  });

  // QueueIndicator Edit → DELETE returns the row so the composer can pre-fill.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/queue/*`, async (route: Route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const qid = route.request().url().split("/").pop() ?? "";
    const row = QUEUED.find((q) => q.uuid === qid);
    if (!row) return route.fulfill({ status: 404, body: "{}" });
    deleted.push(qid);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: row.text }),
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

  return { deleted };
}

/** Lift A, then B, out of the queue — the second lift overwrites the first. */
async function liftAThenB(page: Page, deleted: string[]) {
  const strip = page.getByTestId("queue-indicator");
  await expect(strip).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("queue-item")).toHaveCount(3);

  const composer = page.getByTestId("prompt-input");
  await page.locator('[data-testid="queue-item"][data-queue-id="q-a"]').getByTestId("queue-item-edit").click();
  await expect(composer).toHaveValue(QUEUED[0].text);
  await expect.poll(() => deleted).toContain("q-a");

  await page.locator('[data-testid="queue-item"][data-queue-id="q-b"]').getByTestId("queue-item-edit").click();
  await expect(composer).toHaveValue(QUEUED[1].text);
  await expect.poll(() => deleted).toContain("q-b");
  return composer;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Lifted queued messages stay in prompt history (CC 2.1.295)", () => {
  test("Cmd/Ctrl+↑ recalls the queued message a later lift overwrote", async ({ page }) => {
    const { deleted } = await mockChatBackend(page);
    await page.goto("/");

    const composer = await liftAThenB(page, deleted);
    // The mocked stream ends after each fixture, so EventSource re-subscribes
    // every few seconds and picks up the post-DELETE queue (just C) — the
    // same echo the real server sends after a lift.
    await expect(page.getByTestId("queue-item")).toHaveCount(1, { timeout: 20_000 });

    // First press skips B (already in the composer) and recalls A.
    await composer.focus();
    await page.keyboard.press("ControlOrMeta+ArrowUp");
    await expect(composer).toHaveValue(QUEUED[0].text);

    await page.getByTestId("queue-indicator").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "queue-lift-history.png"),
      fullPage: false,
    });

    // ↓ walks back out of history to the live draft (B).
    await page.keyboard.press("ControlOrMeta+ArrowDown");
    await expect(composer).toHaveValue(QUEUED[1].text);
  });

  test("plain ↑ on the emptied composer restores the draft a lift overwrote", async ({ page }) => {
    const { deleted } = await mockChatBackend(page);
    await page.goto("/");

    const composer = await liftAThenB(page, deleted);

    await composer.fill("");
    await expect(composer).toHaveValue("");
    await composer.focus();
    await page.keyboard.press("ArrowUp");
    await expect(composer).toHaveValue(QUEUED[0].text);
  });
});
