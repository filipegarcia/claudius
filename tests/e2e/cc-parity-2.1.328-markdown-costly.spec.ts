/**
 * CC 2.1.328 parity — "Fixed markdown rendering freezing on some very long or
 * malformed input".
 *
 * A reply with one long paragraph dense with `*`/`_` (here a 32 KB run of
 * `2*3*4`) made react-markdown + remark-gfm go super-linear — ~2 s per parse,
 * paid again on every streaming delta. `Markdown` now pre-scans the text and
 * shows such a message as plain text with a one-line note, while the ordinary
 * reply next to it still formats.
 *
 * Screenshot target: docs/cc-parity/2.1.328/markdown-costly.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.328");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002328m01";

const COSTLY = "Products: " + "2*3*4 ".repeat(5400) + "end of the run.";
const NORMAL = "This reply still **formats**: `code`, _italics_ and a list:\n\n- one\n- two";

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("a long paragraph dense with emphasis markers renders as plain text instead of freezing", async ({ page }) => {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-328m"),
    assistantText("assistant-328m-1", NORMAL),
    assistantText("assistant-328m-2", COSTLY),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.goto("/");

  const fallback = page.getByTestId("markdown-plain-fallback");
  await expect(fallback).toHaveCount(1, { timeout: 15_000 });
  await expect(fallback).toContainText("Products: 2*3*4 2*3*4");
  await expect(fallback).toContainText("too long and irregular to format quickly");

  // The ordinary reply beside it still goes through the markdown renderer.
  await expect(page.locator("strong", { hasText: "formats" })).toBeVisible();
  expect(pageErrors).toEqual([]);

  // Bring the end of the run and its note into view for the screenshot.
  await fallback.getByText("too long and irregular to format quickly").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOTS_DIR, "markdown-costly.png"), fullPage: false });
});
