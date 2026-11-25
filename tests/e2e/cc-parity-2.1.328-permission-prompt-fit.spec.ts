/**
 * CC 2.1.328 parity — "[VSCode] Fixed the permission prompt cutting off its
 * No button, reply field or title when the panel is low or a command, URL or
 * description is long".
 *
 * In a short window (900×520 here), a permission card with a long path in
 * its title, a long description, a hook reason and `defaultToNo` (which opens
 * the deny field at once) grew past the viewport: its title and its
 * Deny/feedback area were cut off with no way to scroll to them. The card is
 * now capped to the window: the answer area stays put at the bottom and
 * everything above it, title first, scrolls (layout contract unit-tested in
 * tests/unit/cc-parity-2.1.328-permission-prompt-fit.test.ts).
 *
 * Screenshot target: docs/cc-parity/2.1.328/permission-prompt-short-window.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend, type SdkEvent } from "./helpers/mock-chat";

const SCREENSHOT_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.328");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-000002328b08";
const LONG_PATH = `/Users/dev/projects/${"deeply-nested-workspace-folder/".repeat(9)}settings.local.json`;

const EVENTS: SdkEvent[] = [
  { type: "ready", sessionId: FAKE_SESSION_ID },
  initEvent("sys-328-fit"),
  { type: "replay_done", hasMoreAbove: false },
  {
    type: "permission_request",
    requestId: "req-328-fit",
    toolName: "Edit",
    toolUseId: "tu-328-fit",
    input: { file_path: LONG_PATH, old_string: "a".repeat(400), new_string: "b".repeat(400) },
    title: `Claude wants to edit ${LONG_PATH}`,
    description:
      "This file is outside the folders this session can write to, and it holds settings that change how Claude Code runs. " +
      "Editing it can grant or remove permissions for every later session in this project. ".repeat(4),
    hookAsk: {
      reason:
        "Policy hook: edits to settings files need a person to look at them. " +
        "The change will be logged with the session id and the diff. ".repeat(3),
    },
    defaultToNo: true,
  },
];

test.use({ viewport: { width: 900, height: 520 } });

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await mockChatBackend(page, FAKE_SESSION_ID, EVENTS);
});

test("in a short window the title, the deny buttons and the feedback field stay on screen", async ({ page }) => {
  await page.goto("/");
  const card = page.getByTestId("permission-card");
  await expect(card).toBeVisible({ timeout: 15_000 });

  const title = page.getByTestId("permission-title");
  await expect(title).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: "Deny without feedback" })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: "Deny with feedback" })).toBeInViewport({ ratio: 1 });
  await expect(page.getByPlaceholder(/Why are you denying this/)).toBeInViewport({ ratio: 1 });

  // The long path wraps inside the card instead of running off its right edge.
  const [titleBox, cardBox] = await Promise.all([title.boundingBox(), card.boundingBox()]);
  expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
  expect(cardBox!.height).toBeLessThanOrEqual(520);

  await page.screenshot({ path: resolve(SCREENSHOT_DIR, "permission-prompt-short-window.png"), fullPage: false });

  // Expanding the tool input scrolls inside the card; the answer area stays.
  await page.getByRole("button", { name: /Tool input/ }).click();
  await expect(page.getByRole("button", { name: "Deny without feedback" })).toBeInViewport({ ratio: 1 });
  await expect(page.getByPlaceholder(/Why are you denying this/)).toBeInViewport({ ratio: 1 });
});
