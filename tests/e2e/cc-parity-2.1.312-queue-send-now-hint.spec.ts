/**
 * CC 2.1.312 parity — "Added click to send: in fullscreen, clicking the 'to
 * send now' hint under a queued message sends it right away, as its key does".
 *
 * Claude Code's hint reads "ctrl+enter to send now", and clicking it runs the
 * same handler as the key. Claudius's composer footer used to say "N queued ·
 * edit above · send now". That link named no key and sent only the first
 * queued message, while Claudius's send-now key (Ctrl+Enter) flushes all of
 * them. The hint now names the key, and a click does what Ctrl+Enter does:
 * it hits the send-all endpoint, not the per-item send-now one. The per-row
 * "Send now" buttons in the queue strip still send just one.
 *
 * Screenshot target: docs/cc-parity/2.1.312/queue-send-now-hint.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.312");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000312qh01";
const NOW = Date.now();

type SdkEvent = Record<string, unknown>;

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-312qh", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "sdk",
    at: NOW - 5_000,
    message: {
      type: "user",
      uuid: "user-qh-1",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "text", text: "Run the full test suite and fix what breaks." }] },
    },
  },
  {
    type: "sdk",
    at: NOW - 4_000,
    message: {
      type: "assistant",
      uuid: "assistant-qh-1",
      parent_tool_use_id: null,
      message: {
        id: "msg_qh_1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Running the suite now — 412 tests so far, two failures in the upload client." }],
        usage: { input_tokens: 40, output_tokens: 20 },
      },
    },
  },
  // The turn is still running, so new sends queue.
  { type: "turn_status", status: "running" },
  {
    type: "queue:updated",
    at: NOW,
    sessionId: FAKE_SESSION_ID,
    queue: [
      { uuid: "q-1", text: "also bump the retry limit to 5", createdAtMs: NOW },
      { uuid: "q-2", text: "then update the changelog", createdAtMs: NOW + 1 },
    ],
    sdkQueuedTurns: 0,
  },
];

async function mockChatBackend(page: Page): Promise<{ sendAll: number; sendOne: string[] }> {
  const calls = { sendAll: 0, sendOne: [] as string[] };
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: EVENTS.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/queue/send-all`, (route: Route) => {
    calls.sendAll += 1;
    return route.fulfill({ json: { ok: true, dispatched: ["q-1", "q-2"] } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/queue/*/send-now`, (route: Route) => {
    calls.sendOne.push(route.request().url());
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ json: { activeId: null, tabs: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
  return calls;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("the queue hint names Ctrl+Enter, and clicking it does what the key does", async ({ page }) => {
  const calls = await mockChatBackend(page);
  await page.goto("/");

  const strip = page.getByTestId("queue-indicator");
  await expect(strip).toBeVisible({ timeout: 15_000 });
  await expect(strip).toContainText("also bump the retry limit to 5");

  const hint = page.getByTestId("prompt-queue-send-now-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText("· Ctrl+Enter to send now");
  await expect(hint).toHaveAttribute("title", /as Ctrl\+Enter does/);

  await hint.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "queue-send-now-hint.png"), fullPage: false });

  await hint.click();
  await expect.poll(() => calls.sendAll).toBe(1);
  expect(calls.sendOne).toHaveLength(0);

  // The key does the same thing.
  await page.getByTestId("prompt-input").click();
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => calls.sendAll).toBe(2);
  expect(calls.sendOne).toHaveLength(0);
});
