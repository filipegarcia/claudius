/**
 * CC 2.1.304 — "Added the names of the tools called earlier to the compaction
 * summary in the transcript view (Ctrl+O)".
 *
 * The 2.1.304 engine writes the names into the compact-summary record as a
 * `<tools-used-before-summary>Bash, Edit, Read</tools-used-before-summary>`
 * line. Claudius's own copy of the Ctrl+O view is the compaction divider's
 * "show summary" block (`CompactBoundaryDivider` in SystemPill.tsx). It used
 * to render the record verbatim, so the raw tag would have shown. It now shows
 * "Tools called before this summary: …" above the summary and drops the tag,
 * including the empty tag the engine writes when no tools ran.
 *
 * Screenshot target: docs/cc-parity/2.1.304/compact-summary-tools.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.304");
mkdirSync(SHOTS_DIR, { recursive: true });

const PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";

function summaryRecord(uuid: string, toolsTag: string): SdkEvent {
  return userText(
    uuid,
    `${PREAMBLE}\n\n${toolsTag}\nSummary:\n1. Primary Request and Intent:\n   The user asked to add an \`archived\` column to sessions and expose it in the list.\n\n2. Key Technical Concepts:\n   - SQLite migrations in lib/server/db-migrations\n   - The sessions list query in lib/server/sessions-store.ts\n\n3. Pending Tasks:\n   - Write the migration and wire the filter toggle.`,
  );
}

function boundary(uuid: string): SdkEvent {
  return {
    type: "sdk",
    message: {
      type: "system",
      subtype: "compact_boundary",
      uuid,
      compact_metadata: { trigger: "manual", pre_tokens: 148_200, post_tokens: 12_600 },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("the compaction summary lists the tools called before it, without the raw tag", async ({ page }) => {
  const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002304c01";
  await mockChatBackend(page, SESSION, [
    initEvent("sys-init-304c1"),
    userText("u-1", "Find where the sessions list is queried."),
    assistantText("a-1", "It's `listSessions()` in `lib/server/sessions-store.ts`."),
    boundary("cb-304"),
    summaryRecord(
      "u-sum-304",
      "<tools-used-before-summary>Bash, Grep, Read, Edit, mcp__github__create_issue</tools-used-before-summary>",
    ),
    userText("u-2", "Now add the migration for the new column."),
    assistantText("a-2", "Added `lib/server/db-migrations/042_add_archived.sql`."),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const toggle = page.getByRole("button", { name: "▸ show summary" });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.click();

  const tools = page.getByTestId("compact-summary-tools");
  await expect(tools).toBeVisible();
  await expect(tools).toContainText("Tools called before this summary:");
  for (const name of ["Bash", "Grep", "Read", "Edit", "mcp__github__create_issue"]) {
    await expect(tools.locator("code", { hasText: name })).toHaveCount(1);
  }
  const body = page.getByTestId("compact-summary-body");
  await expect(body).toContainText("Primary Request and Intent");
  await expect(body).not.toContainText("tools-used-before-summary");

  // Keep the divider row (label, token stats, hide toggle) in frame above the
  // expanded summary.
  await page.getByRole("button", { name: "▾ hide summary" }).evaluate((el) =>
    el.scrollIntoView({ block: "start" }),
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(SHOTS_DIR, "compact-summary-tools.png"), fullPage: false });
});

test("an empty tag (no tools ran) shows no tools line and no raw tag", async ({ page }) => {
  const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002304c02";
  await mockChatBackend(page, SESSION, [
    initEvent("sys-init-304c2"),
    userText("u-1", "Explain the idea behind the reaper."),
    assistantText("a-1", "It closes idle sessions after a timeout."),
    boundary("cb-304e"),
    summaryRecord("u-sum-304e", "<tools-used-before-summary></tools-used-before-summary>"),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");

  const toggle = page.getByRole("button", { name: "▸ show summary" });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.click();

  const body = page.getByTestId("compact-summary-body");
  await expect(body).toContainText("Primary Request and Intent");
  await expect(body).not.toContainText("tools-used-before-summary");
  await expect(page.getByTestId("compact-summary-tools")).toHaveCount(0);
});
