/**
 * CC 2.1.329 parity —
 *   "[VSCode] Fixed keys pressed while an input method (IME) is composing
 *    moving focus on or declining a permission prompt, running menu rows and
 *    closing dialogs", and
 *   "[VSCode] Fixed … an input method's Enter … picking an @-mentioned file".
 *
 * The composer half of the fix (937687ea): the @ picker's capture-phase key
 * listener returns on `isImeComposing` first, without preventDefault, so the
 * Enter that commits a Japanese/Chinese/Korean conversion (or the arrows that
 * walk its candidates) belongs to the IME instead of picking a file. A plain
 * Enter still picks.
 *
 * A real IME can't be driven from Playwright, so the composing keydowns are
 * dispatched with `isComposing: true`, the way Chromium marks them.
 */

import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend } from "./helpers/mock-chat";

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000329im01";

async function setup(page: Page): Promise<void> {
  await mockChatBackend(page, FAKE_SESSION_ID, [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    initEvent("sys-init-329im"),
    { type: "replay_done", hasMoreAbove: false },
  ]);
  await page.route(`**/api/sessions/${FAKE_SESSION_ID}/prompt-draft`, (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { text: "", images: [] } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/fs/list**", (route: Route) =>
    route.fulfill({
      json: {
        entries: [
          { relPath: "lib/foo.ts", absPath: "/repo/lib/foo.ts", type: "file" },
          { relPath: "lib/foo-bar.ts", absPath: "/repo/lib/foo-bar.ts", type: "file" },
        ],
      },
    }),
  );
}

/** Dispatch a keydown on the composer the way Chromium does during IME composition. */
async function composingKey(page: Page, key: string): Promise<void> {
  await page.evaluate((k) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: k, isComposing: true, bubbles: true, cancelable: true }));
  }, key);
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test("an IME's Enter in the @ picker inserts nothing; a plain Enter still picks", async ({ page }) => {
  await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.focus();
  await composer.pressSequentially("open @lib/fo");
  const pointer = page.getByTestId("picker-selected-pointer");
  await expect(pointer).toHaveCount(1);
  await expect(page.getByText("lib/foo-bar.ts")).toBeVisible();

  // The arrows that walk IME candidates don't move the picker's highlight …
  const highlighted = page.locator("button", { has: pointer });
  await expect(highlighted).toContainText("lib/foo.ts");
  await composingKey(page, "ArrowDown");
  await expect(highlighted).toContainText("lib/foo.ts");
  await expect(highlighted).not.toContainText("lib/foo-bar.ts");

  // … and the Enter that commits the conversion picks nothing.
  await composingKey(page, "Enter");
  await page.waitForTimeout(200);
  await expect(composer).toHaveValue("open @lib/fo");
  await expect(pointer).toHaveCount(1);

  // A plain Enter still picks the highlighted file.
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("open @lib/foo.ts ");
});
