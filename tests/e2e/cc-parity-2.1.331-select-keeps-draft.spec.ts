/**
 * CC 2.1.331 parity — "[VSCode] Fixed the arrow keys replacing typed text with
 * an old prompt while selecting, and dropping edits to a recalled prompt".
 *
 * On macOS ⌘⇧↑ is the standard "select to the start of the text" key
 * (Ctrl+Shift+↑ selects elsewhere). Claudius's composer treated any
 * Cmd/Ctrl+↑/↓ as prompt-history recall and swapped the typed draft for an
 * old prompt, so the selection never happened. With Shift held (or a
 * selection in progress) the browser now keeps the key; a plain Cmd/Ctrl+↑
 * still recalls. (The "dropping edits to a recalled prompt" half is covered
 * by the 2.1.332 history-recall spec.)
 *
 * The selection check only runs on a macOS host, where Playwright sends the
 * "select to the beginning" editing command along with the key.
 */

import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText } from "./helpers/mock-chat";

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000331sk01";
const OLD_PROMPT = "an earlier prompt from history";
const DRAFT = "first line of my draft\nsecond line";

async function setup(page: Page): Promise<void> {
  await mockChatBackend(page, FAKE_SESSION_ID, [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    initEvent("sys-init-331sk"),
    userText("u-1", OLD_PROMPT),
    assistantText("a-1", "Done."),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("Cmd/Ctrl+Shift+↑ selects the draft instead of replacing it with an old prompt", async ({ page }) => {
  await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText("Done.")).toBeVisible();
  await composer.fill(DRAFT);
  await composer.press("End");

  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
  await page.waitForTimeout(200);
  await expect(composer).toHaveValue(DRAFT);
  if (process.platform === "darwin") {
    const sel = await composer.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
    expect(sel[0]).toBe(0);
    expect(sel[1]).toBeGreaterThan(0);
  }

  // A plain Cmd/Ctrl+↑ (selection collapsed first) still recalls history.
  await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect(composer).toHaveValue(OLD_PROMPT);
});
