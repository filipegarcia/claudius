/**
 * CC 2.1.332 parity — "Fixed replies that start with phrases like "You've
 * used" or "You've hit your" showing as a red usage limit error".
 *
 * Claudius matched the usage-limit prose on any text-only assistant message,
 * so an ordinary reply opening "You've hit your…" was swapped for the red
 * rate-limit panel. Only the engine's synthetic API-error message
 * (`error` set, `message.model: "<synthetic>"`) gets the panel now.
 *
 * Screenshot target: docs/cc-parity/2.1.332/limit-prose-reply.png
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { apiErrorText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002332b02";
const REPLY = "You've hit your limit on retries for the flaky upload test, so I stopped and left the branch as is.";

function modelReply(uuid: string, text: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "assistant",
      uuid,
      message: { id: `msg_${uuid}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("an ordinary reply that opens 'You've hit your…' renders as a plain bubble", async ({ page }) => {
  const events: SdkEvent[] = [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-332b"),
    userText("u-1", "Retry the upload test until it passes."),
    modelReply("a-1", REPLY),
    { type: "replay_done", hasMoreAbove: false },
  ];
  await mockChatBackend(page, SESSION, events);
  await page.goto("/");

  const bubble = page.getByText(REPLY);
  await expect(bubble).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("rate-limit-hit-panel")).toHaveCount(0);

  await bubble.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "limit-prose-reply.png"), fullPage: false });
});

test("the engine's synthetic limit stop still gets the panel", async ({ page }) => {
  const events: SdkEvent[] = [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-332b"),
    userText("u-1", "Retry the upload test until it passes."),
    apiErrorText("a-1", "You've hit your 5-hour limit · resets 4pm"),
    { type: "replay_done", hasMoreAbove: false },
  ];
  await mockChatBackend(page, SESSION, events);
  await page.goto("/");

  await expect(page.getByTestId("rate-limit-hit-panel")).toBeVisible({ timeout: 15_000 });
});
