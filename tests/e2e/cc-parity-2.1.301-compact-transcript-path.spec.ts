/**
 * CC 2.1.301 parity — "Fixed the compaction row in a resumed session
 * offering ctrl+o for history that is not loaded; it now says where the
 * earlier messages are saved".
 *
 * A resumed Claudius session replays from its last compaction on, so the
 * turns before it aren't in the view. The `ready` event carries the resumed
 * transcript's path and the top-of-thread compaction row names it — even
 * though the stream ends with the route's bare `ready` (see `mockChatBackend`),
 * and, for a session longer than the reattach window, once "load older"
 * reaches the top of the history.
 *
 * Screenshot target: docs/cc-parity/2.1.301/compact-transcript-path.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.301");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002301b01";
const PATH = `~/.claude/projects/-Users-me-claudius/${SESSION}.jsonl`;

const BOUNDARY: SdkEvent = {
  type: "sdk",
  message: {
    type: "system",
    subtype: "compact_boundary",
    uuid: "cb-301",
    compact_metadata: { trigger: "auto", pre_tokens: 182_400, post_tokens: 14_900 },
  },
};

const AFTER: SdkEvent[] = [
  userText("u-2", "Now add the migration for the new column."),
  assistantText("a-2", "Added `lib/server/db-migrations/042_add_archived.sql`."),
  { type: "replay_done", hasMoreAbove: false },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a resumed session's compaction row says where the earlier messages are saved", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION, transcriptPath: PATH },
    initEvent("sys-init-301b"),
    BOUNDARY,
    ...AFTER,
  ]);
  await page.goto("/");

  const line = page.getByTestId("compact-earlier-saved");
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect(line).toContainText("Earlier messages aren't loaded in this resumed session");
  await expect(line).toContainText(PATH);
  await expect(page.getByText("Compacted earlier conversation")).toBeVisible();

  await line.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "compact-transcript-path.png"), fullPage: false });
});

test("a long resumed session gets the row once paging reaches the top of its history", async ({ page }) => {
  // More turns after the compaction than the reattach window (`tail`) holds:
  // the replay starts below the continuation summary, so the row can only come
  // from the "load older" page that reaches the top of the resumed chain.
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION, transcriptPath: PATH },
    initEvent("sys-init-301b3"),
    userText("u-2", "Now add the migration for the new column."),
    assistantText("a-2", "Added `lib/server/db-migrations/042_add_archived.sql`."),
    { type: "replay_done", hasMoreAbove: true },
  ]);
  await page.route(`**/api/sessions/${SESSION}/transcript*`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hasMore: false,
        messages: [
          { type: "system", uuid: "cb-disk-301" },
          {
            type: "user",
            uuid: "summary-301",
            isCompactSummary: true,
            message: {
              role: "user",
              content: "This session is being continued from a previous conversation that ran out of context.",
            },
          },
          { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "Add an archived flag." }] } },
          {
            type: "assistant",
            uuid: "a-1",
            message: { id: "msg_a-1", role: "assistant", content: [{ type: "text", text: "Planning the column." }] },
          },
        ],
      }),
    }),
  );
  await page.goto("/");

  await expect(page.getByText("Planning the column.")).toBeVisible({ timeout: 15_000 });
  const line = page.getByTestId("compact-earlier-saved");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText(PATH);
});

test("a fresh session's compaction row has no transcript line", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-301b2"),
    userText("u-1", "Read the whole repo."),
    assistantText("a-1", "Done reading."),
    BOUNDARY,
    ...AFTER,
  ]);
  await page.goto("/");
  await expect(page.getByText("Compacted earlier conversation")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("compact-earlier-saved")).toHaveCount(0);
});
