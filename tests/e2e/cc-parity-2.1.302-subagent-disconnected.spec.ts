/**
 * CC 2.1.302 — "[Remote Control] Fixed a subagent's pane spinning forever in a
 * Remote Control session after your computer goes offline; it now says Remote
 * Control is disconnected".
 *
 * Claudius analog: when the session's SSE stream drops, the status line shows
 * "Reconnecting", but a running subagent's card used to keep pulsing
 * "running" / "Subagent working…" as if progress were still arriving. While
 * the stream is down, the card now stops pulsing and says it's disconnected.
 *
 * Screenshot target: docs/cc-parity/2.1.302/subagent-disconnected.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.302");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000021302d01";
const NOW = Date.now();

type SdkEvent = Record<string, unknown>;

/** `retry: 500` keeps the browser's own reconnect quick (Chromium defaults to 3 s). */
function sseBody(events: SdkEvent[]): string {
  return ["retry: 500\n\n", ...events.map((e) => `data: ${JSON.stringify(e)}\n\n`)].join("");
}

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  {
    type: "sdk",
    message: { type: "system", subtype: "init", uuid: "sys-init-0", model: "claude-opus-5-5" },
  },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "sdk",
    at: NOW - 2_000,
    message: {
      type: "assistant",
      uuid: "a0",
      parent_tool_use_id: null,
      message: {
        id: "msg_a0",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "I'll have a subagent map the session store while I read the routes." }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    },
  },
  {
    type: "sdk",
    at: NOW - 1_500,
    message: {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        id: "msg_a1",
        model: "claude-opus-5-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_agent_map",
            name: "Agent",
            input: { subagent_type: "Explore", description: "Map the session store", prompt: "Map it." },
          },
        ],
        usage: { input_tokens: 40, output_tokens: 20 },
      },
    },
  },
  {
    type: "sdk",
    at: NOW - 1_300,
    message: {
      type: "system",
      subtype: "task_started",
      uuid: "started-a1",
      task_id: "task-a1",
      tool_use_id: "toolu_agent_map",
      description: "Map the session store",
      subagent_type: "Explore",
    },
  },
];

/** `outage`: after the first stream, every reconnect is refused (server unreachable). */
async function mockChatBackend(page: Page, opts: { outage: boolean }): Promise<void> {
  let attempts = 0;
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: FAKE_SESSION_ID }),
    });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) => {
    attempts++;
    if (opts.outage && attempts > 1) {
      return route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" });
    }
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sseBody(EVENTS),
    });
  });
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeId: null, tabs: [] }) }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asks: [], permissions: [] }) }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ limits: { sessionUsd: 0, projectDailyUsd: 0 } }),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Subagent card while the stream is disconnected (CC 2.1.302)", () => {
  test("a running subagent stops pulsing and says it's disconnected", async ({ page }) => {
    await mockChatBackend(page, { outage: true });
    await page.goto("/");

    const card = page.getByTestId("task-block").filter({ hasText: "Map the session store" });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-task-status", "running");

    // The stream drops: the status line says so, and so does the card.
    await expect(page.getByTestId("status-line-stream")).toBeVisible({ timeout: 15_000 });
    const badge = card.getByTestId("subagent-disconnected-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/disconnected/);
    await expect(card).toHaveAttribute("data-stream-disconnected", "1");
    // No pulsing "still working" dot while nothing can arrive.
    await expect(card.locator(".animate-pulse")).toHaveCount(0);

    // The Activity rail agrees: no "Working…" spinner while nothing can arrive.
    await expect(page.getByTestId("activity-disconnected")).toHaveText(/Reconnecting…/);
    await expect(page.locator('[data-pane-name="right-rail"] .animate-spin')).toHaveCount(0);
    // Nothing in the transcript pulses either (streaming dot, tool calls).
    await expect(page.locator("main .animate-pulse, main .animate-spin")).toHaveCount(0);

    await card.getByRole("button").first().click();
    await expect(card).toContainText("Disconnected — reconnecting…");
    await expect(card).not.toContainText("Subagent working…");

    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, "subagent-disconnected.png"), fullPage: false });
  });

  test("with a live stream the running card keeps its normal running state", async ({ page }) => {
    await mockChatBackend(page, { outage: false });
    await page.goto("/");

    const card = page.getByTestId("task-block").filter({ hasText: "Map the session store" });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-task-status", "running");
    await expect(card.getByTestId("subagent-disconnected-badge")).toHaveCount(0);
    await expect(card.locator(".animate-pulse")).toHaveCount(1);
    await expect(page.getByTestId("activity-disconnected")).toHaveCount(0);
  });
});
