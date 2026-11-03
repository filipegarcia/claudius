/**
 * SDK 0.3.317 — `system/session_writes_lost` (`SDKSessionWritesLostMessage`).
 *
 * Sent as the CLI exits when a full disk / exhausted quota kept it from saving
 * the session transcript or ~/.claude.json. The changelog names it; Claudius
 * previously had no branch for the subtype and would have rendered the cryptic
 * `system/session_writes_lost` catch-all pill. `use-session.ts` now renders a
 * warning-toned info pill built by `describeSessionWritesLost`.
 *
 * Screenshot target: docs/sdk-updates/0.3.317/session-writes-lost-pill.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { mockChatBackend, initEvent, userText, assistantText } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/sdk-updates/0.3.317");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000000317w1";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("session_writes_lost warning pill (SDK 0.3.317)", () => {
  test("renders a warning pill naming the loss and cause", async ({ page }) => {
    await mockChatBackend(page, SESSION_ID, [
      { type: "ready", sessionId: SESSION_ID },
      initEvent("sys-init-317w"),
      userText("u-317w", "Write the report to disk."),
      assistantText("a-317w", "Done — the report is written."),
      {
        type: "sdk",
        message: {
          type: "result",
          uuid: "result-317w",
          subtype: "success",
          total_cost_usd: 0.003,
          num_turns: 1,
          duration_ms: 800,
          duration_api_ms: 600,
        },
      },
      {
        type: "sdk",
        message: {
          type: "system",
          subtype: "session_writes_lost",
          uuid: "swl-317w",
          session_id: SESSION_ID,
          error_code: "ENOSPC",
          lost: ["transcript"],
          transcript_session_ids: [SESSION_ID],
        },
      },
      { type: "replay_done", hasMoreAbove: false },
    ]);
    await page.goto("/");

    await expect(page.getByText("Done — the report is written.", { exact: false })).toBeVisible({ timeout: 15_000 });
    const pill = page.getByText("Couldn't save the session transcript: the disk is full", { exact: false });
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Resuming the session may miss part of the conversation.", { exact: false })).toBeVisible();
    // The cryptic catch-all must not appear.
    await expect(page.getByText("system/session_writes_lost")).toHaveCount(0);

    await pill.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(SHOTS_DIR, "session-writes-lost-pill.png"), fullPage: false });
  });
});
