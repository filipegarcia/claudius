/**
 * CC 2.1.330 parity — "[VSCode] Fixed Ctrl+F and Ctrl+P not moving the caret
 * in the message box on macOS".
 *
 * On macOS Ctrl+F is the system text binding "forward one character" in every
 * text field. Claudius's chat listened for Cmd *or* Ctrl+F on the window and
 * called preventDefault, so in the message box Ctrl+F opened the transcript
 * find bar and the caret didn't move. Now, on macOS and while typing, only
 * Cmd+F opens the bar. Elsewhere (other platforms, or focus outside a text
 * field) nothing changed. Claudius binds nothing to Ctrl+P.
 *
 * The platform is pinned per test with an init script. The caret check only
 * runs on a macOS host, where Playwright sends Ctrl+F's "moveForward" editing
 * command along with the key.
 */

import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend } from "./helpers/mock-chat";

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000330cf01";

async function setup(page: Page, platform: string): Promise<void> {
  await page.addInitScript((p) => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => p, configurable: true });
  }, platform);
  await mockChatBackend(page, FAKE_SESSION_ID, [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    initEvent("sys-init-330cf"),
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

test("macOS: Ctrl+F in the message box moves the caret instead of opening find", async ({ page }) => {
  await setup(page, "MacIntel");
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("hello world");
  await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));

  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("transcript-find")).toHaveCount(0);
  await expect(composer).toBeFocused();
  if (process.platform === "darwin") {
    await expect.poll(() => composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(1);
  }

  // Cmd+F still opens the find bar.
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("transcript-find")).toBeVisible();
});

test("other platforms: Ctrl+F in the message box still opens find", async ({ page }) => {
  await setup(page, "Win32");
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("hello world");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("transcript-find")).toBeVisible();
});
