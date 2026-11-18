/**
 * CC 2.1.327 parity — "Added a line when a resumed session's earlier messages
 * can't be loaded".
 *
 * When a resumed session's JSONL is missing part of its chain, the SDK
 * replays only what comes after the cut. `Session.start()` now puts the
 * CLI's warning above the replayed history (detection is covered by
 * `tests/unit/cc-parity-2.1.327-resume-gap.test.ts`); a long session whose
 * reattach window starts lower gets it from the "load older" page that
 * reaches the top.
 *
 * Screenshot target: docs/cc-parity/2.1.327/resume-gap.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.327");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002327a01";
const NOTICE =
  "Earlier messages couldn't be loaded because part of this session's file is missing or damaged. Claude won't see them, so repeat anything it still needs.";

const GAP_ROW: SdkEvent = {
  type: "sdk",
  message: {
    type: "system",
    subtype: "informational",
    level: "warning",
    content: NOTICE,
    uuid: `resume-gap-${SESSION}`,
  },
};

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a resumed session with a cut history opens with the warning on top", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-327g"),
    GAP_ROW,
    assistantText("a-7", "The retry helper now backs off exponentially, capped at 30s."),
    userText("u-8", "Add a test for the cap."),
    assistantText("a-8", "Added `retry.test.ts` covering the 30s ceiling."),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const pill = page.getByTestId("system-pill").filter({ hasText: "Earlier messages couldn't be loaded" });
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await expect(pill).toHaveText(NOTICE);
  await expect(pill).toHaveAttribute("data-kind", "info");
  await expect(pill).toHaveAttribute("data-info-level", "warning");

  // It sits above the first replayed message.
  const reply = page.getByText("The retry helper now backs off exponentially", { exact: false });
  await expect(reply).toBeVisible();
  const pillBox = await pill.boundingBox();
  const replyBox = await reply.boundingBox();
  expect(pillBox && replyBox && pillBox.y < replyBox.y).toBe(true);

  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "resume-gap.png"), fullPage: false });
});

test("a long resumed session gets the warning once paging reaches the top", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-327g2"),
    userText("u-8", "Add a test for the cap."),
    assistantText("a-8", "Added `retry.test.ts` covering the 30s ceiling."),
    { type: "replay_done", hasMoreAbove: true },
  ]);
  await page.route(`**/api/sessions/${SESSION}/transcript*`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasMore: false,
        resumeGap: { uuid: `resume-gap-${SESSION}`, content: NOTICE },
        messages: [
          {
            type: "assistant",
            uuid: "a-7",
            message: {
              id: "msg_a-7",
              role: "assistant",
              content: [{ type: "text", text: "The retry helper now backs off exponentially." }],
            },
          },
        ],
      }),
    }),
  );
  await page.goto("/");

  await expect(page.getByText("The retry helper now backs off exponentially.")).toBeVisible({ timeout: 15_000 });
  const pill = page.getByTestId("system-pill").filter({ hasText: "Earlier messages couldn't be loaded" });
  await expect(pill).toHaveCount(1);
  await expect(pill).toHaveAttribute("data-info-level", "warning");
});

test("a healthy resumed session has no warning", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-327g3"),
    userText("u-1", "Add a retry helper."),
    assistantText("a-1", "Added the retry helper."),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");
  await expect(page.getByText("Added the retry helper.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Earlier messages couldn't be loaded", { exact: false })).toHaveCount(0);
});
