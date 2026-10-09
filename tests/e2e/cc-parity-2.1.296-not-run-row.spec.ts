/**
 * Claude Code 2.1.296 parity — "Improved auto mode: a tool call that wasn't
 * run because auto mode's check had no usable answer now shows as a dim
 * 'Not run' row instead of a red error".
 *
 * The engine tags such a result on the wrapper SDK user message:
 * `tool_result_meta: [{ id, non_execution_kind: "automode-unavailable" }]`.
 * Claudius's generic tool row (`components/chat/ToolCall.tsx`) previously
 * rendered every `is_error` result as a red error. This spec streams two Bash
 * calls — one auto mode couldn't check (`automode-unavailable`) and one it
 * blocked (`automode-blocked`) — and asserts only the first is dimmed to
 * "Not run"; the blocked one keeps its red error treatment.
 *
 * Screenshot target: docs/cc-parity/2.1.296/not-run-row.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.296");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000296a0a1";
const NOT_RUN_ID = "toolu_296_not_run";
const BLOCKED_ID = "toolu_296_blocked";

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
      uuid: "sys-init-296nr",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const TOOL_USES: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-296nr",
    parent_tool_use_id: null,
    message: {
      id: "msg_296nr",
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "Running the test suite, then cleaning the build output." },
        { type: "tool_use", id: NOT_RUN_ID, name: "Bash", input: { command: "bun run test", description: "Run tests" } },
        { type: "tool_use", id: BLOCKED_ID, name: "Bash", input: { command: "rm -rf ~/build-cache", description: "Clean cache" } },
      ],
      usage: { input_tokens: 50, output_tokens: 25 },
    },
  },
};

function toolResult(id: string, text: string, kind: string, uuid: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid,
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] },
      tool_result_meta: [{ id, non_execution_kind: kind }],
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("an automode-unavailable tool result renders as a dim Not run row", async ({ page }) => {
  await mockChatBackend(page, [
    ...PRELUDE,
    TOOL_USES,
    toolResult(NOT_RUN_ID, "Auto mode could not check this action, so it was not run.", "automode-unavailable", "tr-296nr-1"),
    toolResult(BLOCKED_ID, "Auto mode blocked this action: deletes files outside the project.", "automode-blocked", "tr-296nr-2"),
  ]);
  await page.goto("/");

  const rows = page.getByTestId("tool-call");
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  const notRun = rows.nth(0);
  const blocked = rows.nth(1);

  // The unchecked call: dim, "Not run", no red error icon.
  await expect(notRun.getByTestId("tool-call-not-run")).toHaveText("Not run");
  await expect(notRun).toHaveAttribute("data-not-run", "1");
  await expect(notRun.locator("svg.text-red-500")).toHaveCount(0);

  // The blocked call keeps the red error treatment.
  await expect(blocked.getByTestId("tool-call-not-run")).toHaveCount(0);
  await expect(blocked).not.toHaveAttribute("data-not-run", "1");
  await expect(blocked.locator("svg.text-red-500")).toHaveCount(1);

  // The Activity rail's Tools list matches: dim, not red.
  const rail = page.locator('li[data-not-run="1"]');
  await expect(rail).toHaveCount(1);
  await expect(rail).toContainText("bun run test");

  // Expanded, the not-run result is labelled "not run" (not "error").
  await notRun.getByRole("button").first().click();
  await expect(notRun.getByText("not run", { exact: true })).toBeVisible();

  await notRun.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "not-run-row.png"), fullPage: false });
});
