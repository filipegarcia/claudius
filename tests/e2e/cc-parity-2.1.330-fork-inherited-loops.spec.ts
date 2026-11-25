/**
 * CC 2.1.330 parity — "[VSCode] Fixed a forked conversation running the
 * original conversation's `/loop` schedules a second time".
 *
 * A fork's transcript is a copy of its source's, so replaying it tracked the
 * source's `/loop` crons as the fork's own: shown running in the Activity
 * rail, with a cancel button that asked the fork's agent to delete a job it
 * doesn't have. The server now marks copied lines with `forkedFrom` on replay;
 * the rail shows those loops muted, labelled "original session", with no
 * cancel button. The fork's own loops are unchanged.
 *
 * Screenshot target: docs/cc-parity/2.1.330/fork-inherited-loops.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.330");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002330b09";
const SOURCE = "aaaaaaaa-bbbb-cccc-dddd-000002330a00";
const NOW = Date.now();

function cronCreate(opts: {
  n: number;
  at: number;
  cron: string;
  prompt: string;
  text: string;
  forked: boolean;
}): SdkEvent[] {
  const forkedFrom = (uuid: string) => (opts.forked ? { forkedFrom: { sessionId: SOURCE, messageUuid: uuid } } : {});
  const toolUseId = `toolu_cron_${opts.n}`;
  return [
    {
      type: "sdk",
      at: opts.at,
      message: {
        type: "assistant",
        uuid: `a-cron-${opts.n}`,
        parent_tool_use_id: null,
        message: {
          id: `msg_cron_${opts.n}`,
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", id: toolUseId, name: "CronCreate", input: { cron: opts.cron, prompt: opts.prompt } }],
          usage: { input_tokens: 40, output_tokens: 20 },
        },
        ...forkedFrom(`src-a-${opts.n}`),
      },
    },
    {
      type: "sdk",
      at: opts.at + 500,
      message: {
        type: "user",
        uuid: `u-cron-${opts.n}`,
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: opts.text }] },
        ...forkedFrom(`src-u-${opts.n}`),
      },
    },
  ];
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a fork shows its source's /loop as the original session's, not running here", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-330b"),
    // Copied from the source session by the fork.
    ...cronCreate({
      n: 1,
      at: NOW - 3_600_000,
      cron: "*/30 * * * *",
      prompt: "check the deploy queue",
      text: "Scheduled recurring job 1545ddb6 (Every 30 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 30 days. Use CronDelete to cancel sooner.",
      forked: true,
    }),
    // Armed in the fork itself after it was made.
    ...cronCreate({
      n: 2,
      at: NOW - 60_000,
      cron: "0 * * * *",
      prompt: "summarise new issues",
      text: "Scheduled recurring job 77aa01ff (Every hour). Session-only (not written to disk, dies when Claude exits). Auto-expires after 30 days. Use CronDelete to cancel sooner.",
      forked: false,
    }),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const rail = page.getByTestId("activity-section-loops");
  await expect(rail).toBeVisible({ timeout: 15_000 });
  const inherited = rail.locator("li", { hasText: "check the deploy queue" });
  const own = rail.locator("li", { hasText: "summarise new issues" });
  await expect(inherited.getByTestId("loop-inherited")).toHaveText("original session");
  await expect(inherited.getByTestId("scheduled-loop-cancel")).toHaveCount(0);
  await expect(inherited.getByTestId("loop-ends")).toHaveCount(0);
  await expect(own.getByTestId("loop-inherited")).toHaveCount(0);
  await expect(own.getByTestId("scheduled-loop-cancel")).toBeVisible();

  await rail.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "fork-inherited-loops.png"), fullPage: false });
});
