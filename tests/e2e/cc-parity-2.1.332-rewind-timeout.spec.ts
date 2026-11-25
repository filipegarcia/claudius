/**
 * CC 2.1.332 parity — "[VSCode] Fixed Rewind staying on 'Checking code
 * changes…' while Claude's process hung at its start".
 *
 * "Restore files" fetched `/api/sessions/[id]/rewind` with no limit, and the
 * route awaited the SDK's `rewind_files` control request with none either, so
 * a hung CLI left the button spinning (and disabled) forever. Now the route
 * answers 504 after 20 s (unit-tested in
 * tests/unit/cc-parity-2.1.332-rewind-timeout.test.ts) and the button aborts
 * after 45 s as a backstop. Both end on the error dialog, with the button
 * usable again.
 *
 * Screenshot target: docs/cc-parity/2.1.332/rewind-timeout.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText, type SdkEvent } from "./helpers/mock-chat";
import { REWIND_CLIENT_TIMEOUT_MS, rewindTimeoutMessage } from "../../lib/shared/rewind-timeout";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002332b06";

// The last user message is pinned (sticky + backdrop-blur), which would trap
// the dialog's `position: fixed` inside it — target the earlier bubble, as
// cc-parity-2.1.327-rewind-restore-failed.spec.ts does.
const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  initEvent("sys-332-rw"),
  { type: "replay_done", hasMoreAbove: false },
  userText("user-msg-1", "Refactor the pricing module and add tests."),
  assistantText("a1", "Done — refactored the pricing module and added coverage."),
  userText("user-msg-2", "Also add a changelog entry."),
];

async function openRestore(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Also add a changelog entry.")).toBeVisible({ timeout: 15_000 });
  const bubble = page.locator('[data-message-uuid="user-msg-1"]');
  await bubble.hover();
  const button = bubble.getByTestId("restore-files-button");
  await button.click();
  return button;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page, FAKE_SESSION_ID, EVENTS);
});

test("the button gives up on a rewind request that never answers", async ({ page }) => {
  await page.clock.install({ time: Date.now() });
  // The process is hung: the request never gets an answer.
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/rewind`, () => {});

  const button = await openRestore(page);
  await expect(button).toBeDisabled();

  await page.clock.fastForward(REWIND_CLIENT_TIMEOUT_MS + 1_000);

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText(/Couldn.t restore files/);
  await expect(dialog).toContainText(rewindTimeoutMessage(true));
  await expect(button).toBeEnabled();
});

test("the route's 504 lands on the error dialog with its message", async ({ page }) => {
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/rewind`, (route: Route) =>
    route.fulfill({ status: 504, json: { error: rewindTimeoutMessage(true) } }),
  );

  const button = await openRestore(page);

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText(/Couldn.t restore files/);
  await expect(dialog).toContainText(rewindTimeoutMessage(true));
  await expect(button).toBeEnabled();

  await page.screenshot({ path: resolve(SCREENSHOT_DIR, "rewind-timeout.png"), fullPage: false });
});
