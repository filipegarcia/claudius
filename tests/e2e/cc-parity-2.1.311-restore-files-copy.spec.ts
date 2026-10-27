/**
 * CC 2.1.311 parity — "Fixed the /rewind warning that wrongly said manual and
 * Bash edits are never affected by a code restore".
 *
 * Claudius's "Restore files" confirmation (`RewindFilesButton.tsx`) said
 * "Unsaved later edits to these files will be lost", which reads as if saved
 * edits were safe. The SDK's `rewindFiles` writes each checkpointed file back
 * whatever changed it since, so the dialog now says later changes to these
 * files are overwritten, including the user's own and Bash's, and that files
 * only Bash or the user changed are not restored.
 *
 * Drives the real hover → "Restore files" → dry-run preview flow with the
 * rewind route mocked, asserts the copy, and screenshots the dialog over the
 * chat surface.
 *
 * Screenshot target: docs/cc-parity/2.1.311/restore-files-copy.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.311");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000311rf01";

type SdkEvent = Record<string, unknown>;

const user = (uuid: string, text: string, at: number): SdkEvent => ({
  type: "sdk",
  at,
  message: {
    type: "user",
    uuid,
    parent_tool_use_id: null,
    isSynthetic: false,
    message: { role: "user", content: [{ type: "text", text }] },
  },
});

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  { type: "sdk", message: { type: "system", subtype: "init", uuid: "sys-init-311rf", model: "claude-sonnet-4-6" } },
  { type: "replay_done", hasMoreAbove: false },
  user("user-msg-1", "Split the pricing module into tiers and update the tests.", 1_774_000_000_000),
  {
    type: "sdk",
    at: 1_774_000_001_000,
    message: {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Done. The pricing module is split into tiers, and the tests are updated." }],
        usage: { input_tokens: 50, output_tokens: 15 },
      },
    },
  },
  // A later user turn — the last user message is pinned (sticky + backdrop
  // blur, which re-parents the fixed dialog), so the spec targets the first.
  user("user-msg-2", "Now run the formatter.", 1_774_000_002_000),
  {
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
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/rewind`, (route: Route) =>
    route.fulfill({
      json: {
        result: {
          canRewind: true,
          filesChanged: ["lib/pricing/index.ts", "lib/pricing/tiers.ts", "tests/pricing.test.ts"],
          insertions: 48,
          deletions: 17,
        },
      },
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page);
});

test("the Restore files preview says later manual and Bash edits are overwritten", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Split the pricing module", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Now run the formatter.", { exact: false })).toBeVisible({ timeout: 15_000 });

  const bubble = page.locator('[data-message-uuid="user-msg-1"]');
  await bubble.hover();
  const restore = bubble.getByTestId("restore-files-button");
  await expect(restore).toBeVisible();
  await restore.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Restore files to this message?")).toBeVisible();
  await expect(dialog.getByText("3 files")).toBeVisible();

  const note = page.getByTestId("restore-files-preview-note");
  await expect(note).toContainText("removing any it created since");
  await expect(note).toContainText("Later changes to them are overwritten, including your own edits and Bash's");
  await expect(note).toContainText("files changed only by you or by Bash commands are left as they are.");
  // The old wording implied saved edits were safe.
  await expect(note).not.toContainText("Unsaved");

  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(SHOTS_DIR, "restore-files-copy.png"), fullPage: false });

  // Cancel leaves everything as it was.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
