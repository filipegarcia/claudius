/**
 * CC 2.1.314 parity — "Fixed pasted text and dragged-in files being lost in
 * Claude's question dialog unless the 'Other' row had focus".
 *
 * Claudius's AskUserQuestion card had no paste handler: with focus on an
 * option row (a button) a paste went nowhere. Now a paste anywhere on the
 * card outside a text field opens "Other" and lands the text there. Dropped
 * files already reach the composer through the chat-area drop target, so
 * only the paste half applied (see the run-notes Risks).
 *
 * Mocked SSE stream (the cc-parity pattern) so a live question is pending
 * in the real chat surface without a real Claude turn.
 *
 * Screenshot target: docs/cc-parity/2.1.314/ask-paste-other.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.314");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000314ask1";
const PASTED = "Use the existing release script in scripts/release.sh, then tag";

type SdkEvent = Record<string, unknown>;

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-314ask", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "sdk",
    at: 1_774_000_000_000,
    message: {
      type: "user",
      uuid: "user-ask-1",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { role: "user", content: [{ type: "text", text: "Cut the 0.4 release." }] },
    },
  },
  {
    type: "sdk",
    at: 1_774_000_001_000,
    message: {
      type: "assistant",
      uuid: "assistant-ask-1",
      parent_tool_use_id: null,
      message: {
        id: "msg_ask_1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Before I start, one question about how you ship releases." }],
        usage: { input_tokens: 40, output_tokens: 20 },
      },
    },
  },
  {
    type: "ask_user_question",
    requestId: "req-314-ask",
    toolUseId: "toolu_314_ask",
    questions: [
      {
        question: "How should I publish the release?",
        header: "Release",
        multiSelect: false,
        options: [
          { label: "GitHub release", description: "Draft a GitHub release with generated notes." },
          { label: "npm publish", description: "Bump the version and publish to npm." },
        ],
      },
    ],
  },
];

async function mockChatBackend(page: Page): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { id: FAKE_SESSION_ID } });
  });
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/stream*`, async (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: EVENTS.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    }),
  );
  await page.route("**/api/sessions/open-tabs", (route: Route) =>
    route.fulfill({ json: { activeId: null, tabs: [] } }),
  );
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/pending-prompts`, (route: Route) =>
    route.fulfill({ json: { asks: [], permissions: [] } }),
  );
  await page.route("**/api/limits*", (route: Route) =>
    route.fulfill({ json: { limits: { sessionUsd: 0, projectDailyUsd: 0 } } }),
  );
}

/** A real `paste` event (Cmd/Ctrl+V) on whatever has focus. */
async function pasteIntoFocused(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page);
});

test("pasting while an option row has focus lands the text in Other", async ({ page }) => {
  await page.goto("/");
  const card = page.getByTestId("ask-user-question");
  await expect(card).toBeVisible({ timeout: 15_000 });

  const option = page.getByTestId("ask-option-0");
  await option.focus();
  await expect(option).toBeFocused();

  await pasteIntoFocused(page, PASTED);

  // Other is open and holds the pasted text, with focus moved into it so the
  // user can keep typing.
  const other = card.locator('[data-testid="ask-other-input"]:visible, [data-testid="ask-other-input-inline"]:visible');
  await expect(other).toHaveCount(1);
  await expect(other).toHaveValue(PASTED);
  await expect(other).toBeFocused();

  // A second paste from an option row appends; a paste inside the textarea
  // is left to the textarea (not doubled).
  await option.focus();
  await pasteIntoFocused(page, " v0.4.0");
  await expect(other).toHaveValue(`${PASTED} v0.4.0`);

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "ask-paste-other.png"), fullPage: false });
});
