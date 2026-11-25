/**
 * CC 2.1.329 parity — "[VSCode] Fixed the permission prompt for Bash, Edit,
 * Write and other built-in tools not showing why a safety check asks".
 *
 * A permission request raised by one of the engine's safety checks now
 * carries the check's warning (`safetyReason`, from `canUseTool`'s
 * `decisionReason`), and the card shows it in a "Why Claude Code is asking"
 * row. Before, the card showed only the title and subtitle. The server half
 * (session.ts → `safetyReason`) is unit-tested in
 * tests/unit/cc-parity-2.1.329-permission-safety-reason.test.ts.
 *
 * Screenshot target: docs/cc-parity/2.1.329/permission-safety-reason.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.329");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002329b04";
const REASON = "Claude requested permissions to edit /repo/.git/hooks/pre-commit, which is a sensitive file.";

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  initEvent("sys-329-safety"),
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "permission_request",
    requestId: "req-329-safety",
    toolName: "Edit",
    toolUseId: "tu-329-safety",
    input: { file_path: "/repo/.git/hooks/pre-commit", old_string: "exit 0", new_string: "exit 1" },
    title: "Claude wants to edit pre-commit",
    description: "/repo/.git/hooks/pre-commit",
    safetyReason: REASON,
  },
];

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page, FAKE_SESSION_ID, EVENTS);
});

test("a safety-check permission card says why Claude Code is asking", async ({ page }) => {
  await page.goto("/");
  const card = page.getByTestId("permission-card");
  await expect(card).toBeVisible({ timeout: 15_000 });

  const row = page.getByTestId("permission-safety-reason");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Why Claude Code is asking:");
  await expect(row).toContainText(REASON);

  await card.screenshot({ path: resolve(SCREENSHOT_DIR, "permission-safety-reason.png") });
});
