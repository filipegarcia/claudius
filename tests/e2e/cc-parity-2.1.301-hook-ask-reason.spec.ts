/**
 * CC 2.1.301 parity — "Fixed the permission prompt for a plugin or skill
 * hook's `ask` decision not showing which plugin or skill the hook comes
 * from".
 *
 * Claudius dropped `canUseTool`'s `decisionReason` entirely, so a hook's ask
 * looked like any other prompt. The server now forwards the hook's reason
 * (`decisionReasonType: "hook"`) and the prompt shows "Asked by a hook: …".
 * The plugin/skill name itself isn't forwarded by the SDK yet.
 *
 * Screenshot target: docs/cc-parity/2.1.301/hook-ask-reason.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, userText } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.301");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002301h01";
const REASON = "deploy-guard: production deploys need a human to confirm";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a hook's ask shows the hook's reason on the permission prompt", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-301h"),
    userText("u-1", "Ship the release to production."),
    {
      type: "sdk",
      message: {
        type: "assistant",
        uuid: "a-1",
        message: {
          id: "msg_a-1",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_deploy_301", name: "Bash", input: { command: "./scripts/deploy.sh --prod" } }],
        },
      },
    },
    { type: "replay_done", hasMoreAbove: false },
    {
      type: "permission_request",
      requestId: "perm-301-hook",
      toolName: "Bash",
      toolUseId: "toolu_deploy_301",
      input: { command: "./scripts/deploy.sh --prod" },
      hookAskReason: REASON,
    },
  ]);
  await page.goto("/");

  const reason = page.getByTestId("permission-hook-reason");
  await expect(reason).toBeVisible({ timeout: 15_000 });
  await expect(reason).toContainText("Asked by a hook:");
  await expect(reason).toContainText(REASON);

  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "hook-ask-reason.png"), fullPage: false });
});

test("an ordinary ask shows no hook line", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-301h2"),
    { type: "replay_done", hasMoreAbove: false },
    {
      type: "permission_request",
      requestId: "perm-301-plain",
      toolName: "Bash",
      toolUseId: "toolu_plain_301",
      input: { command: "ls" },
    },
  ]);
  await page.goto("/");
  await expect(page.getByText("Claude wants to use Bash")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("permission-hook-reason")).toHaveCount(0);
});
