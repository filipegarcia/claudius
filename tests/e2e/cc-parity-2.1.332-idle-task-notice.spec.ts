/**
 * CC 2.1.332 parity — "[VSCode] Fixed the chat showing no notice when a
 * background command, agent, workflow or monitor finished while Claude was
 * idle".
 *
 * The engine wakes an idle session with a `<task-notification>` user message.
 * Claudius dropped it (XML the user never typed) and showed nothing, so
 * Claude's reply appeared with no cause. A finished task's wrapper now shows
 * as a pill with its summary. A monitor's per-event wrapper (no status) stays
 * silent.
 *
 * Screenshot target: docs/cc-parity/2.1.332/idle-task-notice.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002332b07";

function wrapper(uuid: string, inner: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: `<task-notification>\n<task-id>b720wy810</task-id>\n<tool-use-id>toolu_bg_1</tool-use-id>\n${inner}\n</task-notification>`,
      },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a background command that finishes while idle shows a notice", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-332b7"),
    userText("u-1", "Run the e2e suite in the background and tell me when it's done."),
    assistantText("a-1", "Started the suite in the background. I'll report back when it finishes."),
    wrapper("u-notif-monitor", '<summary>Monitor event: "12 specs passed so far"</summary>'),
    wrapper(
      "u-notif-1",
      '<status>completed</status>\n<summary>Background command "bun run test:e2e &gt; /tmp/e2e.log 2&gt;&amp;1" completed (exit code 0)</summary>',
    ),
    assistantText("a-2", "The e2e suite finished: all specs passed."),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const pill = page.getByTestId("system-pill").filter({ hasText: "Background command" });
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await expect(pill).toHaveText('Background command "bun run test:e2e > /tmp/e2e.log 2>&1" completed (exit code 0)');
  await expect(page.getByText("Monitor event:")).toHaveCount(0);
  await expect(page.getByText("<task-notification>")).toHaveCount(0);

  await pill.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "idle-task-notice.png"), fullPage: false });
});
