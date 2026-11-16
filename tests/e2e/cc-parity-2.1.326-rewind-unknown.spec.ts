/**
 * CC 2.1.326 parity — "Fixed `/rewind` saying \"No code changes\" when a shell
 * command changed files it can't restore; a turn whose changes weren't
 * tracked now reads \"Code changes unknown\"", and "Esc now cancels its
 * summary".
 *
 * Claudius's restore-files dialog (`RewindFilesButton.tsx`) showed "0 files"
 * with a live "Restore files" button when the dry run found no checkpointed
 * edits, and claimed "Working tree restored." afterwards. Only Claude's own
 * file edits are checkpointed, so an empty preview means "unknown", not "no
 * changes". The dialog also had no Escape handler.
 *
 * Screenshot target: docs/cc-parity/2.1.326/rewind-unknown.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.326");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002326c01";

type SdkEvent = Record<string, unknown>;

function sseBody(events: SdkEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const rewindCalls: Array<{ dryRun?: boolean }> = [];

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

  // CC 2.1.326 surface under test: the turn after this message made no
  // tracked (checkpointed) file edits — only a Bash command ran — so the
  // dry run reports nothing to restore.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/rewind`, async (route: Route) => {
    rewindCalls.push(route.request().postDataJSON() as { dryRun?: boolean });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } }),
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

const USER_MESSAGE: SdkEvent = {
  type: "sdk",
  at: 1_774_000_000_000,
  message: {
    type: "user",
    uuid: "user-msg-1",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: "user",
      content: [{ type: "text", text: "Refactor the pricing module and add tests." }],
    },
  },
};

const ASSISTANT_REPLY: SdkEvent = {
  type: "sdk",
  at: 1_774_000_001_000,
  message: {
    type: "assistant",
    uuid: "a1",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Done — refactored the pricing module and added coverage." }],
      usage: { input_tokens: 50, output_tokens: 15 },
    },
  },
};

// A second, later user turn. MessageList pins the *last* user message to the
// top of the viewport with a `sticky` + `backdrop-blur` wrapper
// (`isPinnedUser` in MessageList.tsx) — and `backdrop-filter` establishes a
// containing block for `position: fixed` descendants, which would reposition
// RewindFilesButton's full-viewport confirm dialog inside that small pinned
// bar instead of centering it over the page. That's a pre-existing quirk of
// the dialog (not introduced by this change) that only bites the *pinned*
// message; the spec targets the earlier, unpinned "user-msg-1" bubble so the
// screenshot shows the dialog the way it renders for every other message.
const USER_MESSAGE_2: SdkEvent = {
  type: "sdk",
  at: 1_774_000_002_000,
  message: {
    type: "user",
    uuid: "user-msg-2",
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: "user",
      content: [{ type: "text", text: "Also add a changelog entry." }],
    },
  },
};

const RESULT: SdkEvent = {
  type: "sdk",
  message: {
    type: "result",
    uuid: "result-1",
    subtype: "success",
    total_cost_usd: 0.02,
    num_turns: 2,
    duration_ms: 800,
    duration_api_ms: 650,
  },
};

test.beforeEach(async ({ page }) => {
  rewindCalls.length = 0;
  await activateClaudiusWorkspace(page);
});

test("an empty restore preview reads 'Code changes unknown' and Esc closes it", async ({ page }) => {
  await mockChatBackend(page, [...PRELUDE, USER_MESSAGE, ASSISTANT_REPLY, USER_MESSAGE_2, RESULT]);
  await page.goto("/");
  await expect(page.getByText("Also add a changelog entry.", { exact: false })).toBeVisible({ timeout: 15_000 });

  const bubble = page.locator('[data-message-uuid="user-msg-1"]');
  await bubble.hover();
  await bubble.getByTestId("restore-files-button").click();

  const dialog = page.getByRole("dialog");
  const unknown = page.getByTestId("restore-files-unknown");
  await expect(unknown).toBeVisible();
  await expect(unknown.getByRole("heading")).toHaveText("Code changes unknown");
  await expect(unknown).toContainText("Changes made by Bash commands or outside Claude aren't tracked");
  // Nothing to restore, so no restore button; only Close.
  await expect(dialog.getByRole("button", { name: "Restore files" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
  expect(rewindCalls).toEqual([{ userMessageId: "user-msg-1", dryRun: true }]);

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, "rewind-unknown.png"), fullPage: false });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Esc only closed the dialog: no real rewind was sent.
  expect(rewindCalls).toHaveLength(1);
});
