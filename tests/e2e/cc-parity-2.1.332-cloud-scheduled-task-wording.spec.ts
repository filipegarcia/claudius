/**
 * CC 2.1.332 parity — "Changed `/schedule`, permission prompts and `/loop`'s
 * cloud offer to say "cloud scheduled task" instead of "routine" or "cloud
 * schedule"; `/routines` still works".
 *
 * The cloud-schedule tool rows (`RemoteTrigger`) said "List routines",
 * "Create routine", …; they now say "cloud scheduled task", like the engine.
 * The `/schedule` slash command, which opens Claudius's own (local) Schedule
 * page, now reads "Manage scheduled jobs." — covered by the unit test.
 *
 * Screenshot target: docs/cc-parity/2.1.332/cloud-scheduled-task-wording.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002332c01";

function toolUse(id: string, action: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "assistant",
      uuid: `a-${id}`,
      parent_tool_use_id: null,
      message: {
        id: `msg_${id}`,
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id, name: "RemoteTrigger", input: { action } }],
      },
    },
  };
}

function toolResult(id: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "user",
      uuid: `r-${id}`,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("cloud-schedule tool rows say cloud scheduled task, not routine", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-332c"),
    toolUse("toolu_332c_list", "list"),
    toolResult("toolu_332c_list", "1 cloud scheduled task: nightly-triage"),
    toolUse("toolu_332c_create", "create"),
    toolResult("toolu_332c_create", "Created nightly-deps-audit"),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const labels = page.getByTestId("tool-call-schedule-action");
  await expect(labels).toHaveCount(2, { timeout: 15_000 });
  await expect(labels.nth(0)).toHaveText("— List cloud scheduled tasks");
  await expect(labels.nth(1)).toHaveText("— Create cloud scheduled task");
  await expect(page.getByTestId("tool-call").filter({ hasText: /routine/i })).toHaveCount(0);

  await page.screenshot({ path: resolve(SHOTS_DIR, "cloud-scheduled-task-wording.png"), fullPage: false });
});
