/**
 * SDK 0.3.210 — `BashOutput.timedOutAfterMs`, set when a foreground Bash
 * command hits its timeout and is auto-backgrounded (as opposed to being
 * launched with `run_in_background: true`, or manually backgrounded by the
 * user via Ctrl+B).
 *
 * The value arrives on the SDK message's `tool_use_result` field — a
 * sibling of `message.content`, not inside it — which Claudius previously
 * never read (it only flattened `message.content`'s `tool_result` block
 * into plain text). Without reading it, a command that silently kept
 * running past its timeout was invisible: nothing at launch time indicated
 * it would ever go to background, so the Activity rail's "Running" section
 * never picked it up.
 *
 * This spec mocks the SSE stream with a Bash tool_use that was launched
 * WITHOUT `run_in_background`, followed by its tool_result carrying
 * `tool_use_result: { backgroundTaskId, timedOutAfterMs }`, and asserts:
 *   1. The command shows up in the Activity rail's "Running" section even
 *      though it was never explicitly launched in the background.
 *   2. A "timed out" badge renders on it, with a title citing the timeout.
 *
 * Screenshot target: docs/sdk-updates/0.3.210/bash-timeout-background.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.210");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000210b1";
const BASH_TOOL_USE_ID = "toolu_bash_watch_1";
const COMMAND = "npm run build:assets -- --watch";

// Anchor event timestamps to real "now" (not a fixed historical epoch) so
// the widget's live elapsed-time counter reads a small, sensible value —
// e.g. "0:05" instead of a four-digit hour count — in the screenshot.
const NOW = Date.now();

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

/** Minimal SSE prelude emitted before any real assistant content. */
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

/**
 * Bash launched WITHOUT `run_in_background` — a plain foreground call. If
 * Claudius only tracked backgrounding at launch time (the pre-0.3.210
 * behavior), this command would never appear in the Activity rail at all.
 */
const BASH_TOOL_USE: SdkEvent = {
  type: "sdk",
  at: NOW,
  message: {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "Kicking off the watch build." },
        {
          type: "tool_use",
          id: BASH_TOOL_USE_ID,
          name: "Bash",
          input: { command: COMMAND, description: "Run the asset watch build" },
        },
      ],
      usage: { input_tokens: 40, output_tokens: 20 },
    },
  },
};

/**
 * The command's tool_result. `message.content` carries the model-facing
 * text (what a pre-0.3.210 Claudius could already parse); the sibling
 * `tool_use_result` carries the new structured `BashOutput`, including
 * `timedOutAfterMs` — the field this spec exists to exercise.
 */
const BASH_TOOL_RESULT: SdkEvent = {
  type: "sdk",
  at: NOW + 1_000,
  message: {
    type: "user",
    uuid: "tool-result-1",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: BASH_TOOL_USE_ID,
          content:
            "Command timed out after 120000ms and was moved to the background (bash_id: bash_watch_9f2). Use BashOutput to check on its progress.",
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      stdout: "",
      stderr: "",
      interrupted: false,
      backgroundTaskId: "bash_watch_9f2",
      timedOutAfterMs: 120_000,
    },
  },
};

const ASSISTANT_REPLY: SdkEvent = {
  type: "sdk",
  at: NOW + 2_000,
  message: {
    type: "assistant",
    uuid: "a2",
    parent_tool_use_id: null,
    message: {
      id: "msg_2",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "text",
          text: "That's taking a while, so I moved it to the background — I'll check on it periodically.",
        },
      ],
      usage: { input_tokens: 60, output_tokens: 25 },
    },
  },
};

const RESULT: SdkEvent = {
  type: "sdk",
  message: {
    type: "result",
    uuid: "result-1",
    subtype: "success",
    total_cost_usd: 0.01,
    num_turns: 1,
    duration_ms: 500,
    duration_api_ms: 400,
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("Bash auto-backgrounded-on-timeout (SDK 0.3.210)", () => {
  test("a foreground command that timed out shows up as Running with a timed-out badge", async ({
    page,
  }) => {
    await mockChatBackend(page, [
      ...PRELUDE,
      BASH_TOOL_USE,
      BASH_TOOL_RESULT,
      ASSISTANT_REPLY,
      RESULT,
    ]);
    await page.goto("/");

    // Wait for the turn to complete so the screenshot shows a settled state.
    await expect(page.getByText("I'll check on it periodically", { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // The command surfaces in the "Running" section even though it was
    // never launched with run_in_background — proving the tool_result path
    // (not just the tool_use launch path) now tracks it.
    const badge = page.getByTestId("bash-timeout-badge");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText(/timed out/i);
    await expect(badge).toHaveAttribute("title", /120s timeout/);

    // The command renders both in the transcript's tool_use pill and in the
    // Activity rail's "Running" row — scope to the badge's own list item to
    // avoid a strict-mode ambiguous match.
    const runningRow = page.locator("li", { has: badge });
    await expect(runningRow.getByText(COMMAND, { exact: false })).toBeVisible();

    await badge.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "bash-timeout-background.png"),
      fullPage: false,
    });
  });
});
