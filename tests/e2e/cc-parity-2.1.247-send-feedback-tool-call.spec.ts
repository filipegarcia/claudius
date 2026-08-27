/**
 * CC 2.1.247 — "Added the SendFeedback tool: when something goes wrong in a
 * session, Claude can draft a feedback report for you to review and send
 * from /feedback (turn off with the feedbackDrafts setting)."
 *
 * The tool itself is engine-side (baked into the SDK's tool surface) — no
 * Claudius code runs it. What Claudius reimplements is the transcript
 * rendering: `ToolCall.tsx` special-cases the `SendFeedback` name (same
 * pattern already used for `AskUserQuestion` / `Schedule`) to show a
 * friendly "Feedback draft" label and the drafted report text instead of
 * the generic tool-name + raw-JSON-input card every unrecognized tool gets.
 *
 * See the sibling `cc-parity-2.1.247-feedback-drafts-setting.spec.ts` for
 * the `feedbackDrafts` settings row this pairs with.
 *
 * Screenshot target: docs/cc-parity/2.1.247/send-feedback-tool-call.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.247");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-0000002147f1";
const TOOL_USE_ID = "toolu_send_feedback_2147_1";
const DRAFT_TEXT =
  "The Bash tool reported success but the build output directory was empty — likely a race between the build step and the file-checkpointing snapshot.";

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
      uuid: "sys-init-2147f",
      model: "claude-sonnet-4-6",
    },
  },
  { type: "replay_done", hasMoreAbove: false },
];

const SEND_FEEDBACK_TOOL_USE: SdkEvent = {
  type: "sdk",
  message: {
    type: "assistant",
    uuid: "a-2147f",
    parent_tool_use_id: null,
    message: {
      id: "msg_2147f",
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "That build result looked wrong — let me flag it for the team." },
        {
          type: "tool_use",
          id: TOOL_USE_ID,
          name: "SendFeedback",
          input: { report: DRAFT_TEXT },
        },
      ],
      usage: { input_tokens: 60, output_tokens: 30 },
    },
  },
};

const SEND_FEEDBACK_TOOL_RESULT: SdkEvent = {
  type: "sdk",
  at: 1_773_000_000_000,
  message: {
    type: "user",
    uuid: "tool-result-2147f",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: TOOL_USE_ID,
          content: "Draft queued — review and send it with /feedback.",
          is_error: false,
        },
      ],
    },
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("SendFeedback tool call rendering (CC 2.1.247)", () => {
  test("renders a Feedback draft card with the drafted report text", async ({ page }) => {
    await mockChatBackend(page, [...PRELUDE, SEND_FEEDBACK_TOOL_USE, SEND_FEEDBACK_TOOL_RESULT]);
    await page.goto("/");

    const toolCall = page.getByTestId("tool-call").filter({ hasText: "Feedback draft" });
    await expect(toolCall).toBeVisible({ timeout: 15_000 });
    // The raw tool name still round-trips through the data attribute even
    // though the visible label is friendlier.
    await expect(toolCall).toHaveAttribute("data-tool-name", "SendFeedback");

    await toolCall.click();
    await expect(toolCall).toContainText(DRAFT_TEXT);
    await expect(toolCall).toContainText("/feedback");

    await toolCall.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "send-feedback-tool-call.png"),
      fullPage: false,
    });
  });
});
