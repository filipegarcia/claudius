/**
 * CC 2.1.332 parity — "[VSCode] Fixed most links to files without an
 * extension, to folders, and with a line and column doing nothing".
 *
 * A link in Claude's reply to `Makefile`, to a folder (`lib/shared/`) or with a
 * line suffix (`./LICENSE:3`) used to render as `<a target="_blank">` with a
 * relative href — a new tab on an app route that doesn't exist. They now open
 * the in-app Files view: the file in the editor, or the folder expanded and
 * selected in the tree.
 *
 * Screenshot target: docs/cc-parity/2.1.332/markdown-links.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000002332l01";

const REPLY = [
  "The targets live in the [Makefile](Makefile), the helpers in [lib/shared](lib/shared/),",
  "and the license header is at [LICENSE:3](./LICENSE:3). Upstream docs: [Next.js](https://nextjs.org/docs).",
].join("\n");

async function openChat(page: Page) {
  await mockChatBackend(page, SESSION, [
    { type: "ready", sessionId: SESSION },
    initEvent("sys-init-332l"),
    assistantText("assistant-332l-1", REPLY),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.goto("/");
  const reply = page.locator('[data-message-role="assistant"]').last();
  await expect(reply).toContainText("The targets live in the Makefile", { timeout: 15_000 });
  return reply;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("links to an extensionless file, a folder and a file:line point at the Files view", async ({ page }) => {
  const reply = await openChat(page);
  await expect(reply.getByRole("link", { name: "Makefile" })).toHaveAttribute("href", /\/files\?path=Makefile$/);
  await expect(reply.getByRole("link", { name: "lib/shared" })).toHaveAttribute("href", /\/files\?path=lib%2Fshared$/);
  await expect(reply.getByRole("link", { name: "LICENSE:3" })).toHaveAttribute("href", /\/files\?path=LICENSE$/);
  for (const name of ["Makefile", "lib/shared", "LICENSE:3"]) {
    await expect(reply.getByRole("link", { name })).not.toHaveAttribute("target", "_blank");
  }
  // A web link still opens outside the app.
  await expect(reply.getByRole("link", { name: "Next.js" })).toHaveAttribute("target", "_blank");
});

test("clicking a Makefile link opens it in the editor", async ({ page }) => {
  const reply = await openChat(page);
  await reply.getByRole("link", { name: "Makefile" }).click();
  await expect(page).toHaveURL(/\/files\?path=Makefile$/);
  await expect(page.locator("section span.font-mono", { hasText: /^Makefile$/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("files-error")).toHaveCount(0);
});

test("clicking a folder link reveals the folder in the tree", async ({ page }) => {
  const reply = await openChat(page);
  await reply.getByRole("link", { name: "lib/shared" }).click();
  await expect(page).toHaveURL(/\/files\?path=lib%2Fshared$/);

  const folder = page.locator('[data-tree-path="lib/shared/"]');
  await expect(folder).toHaveAttribute("data-selected", "true", { timeout: 15_000 });
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  // Its contents are listed, and nothing was opened as a file.
  await expect(page.locator('[data-tree-path="lib/shared/markdown-nesting.ts"]')).toBeVisible();
  await expect(page.getByText("Pick a file to view or edit.")).toBeVisible();
  await expect(page.getByTestId("files-error")).toHaveCount(0);

  await folder.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOTS_DIR, "markdown-links.png"), fullPage: false });
});
