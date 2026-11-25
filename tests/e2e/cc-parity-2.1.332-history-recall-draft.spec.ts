/**
 * CC 2.1.332 parity — "[VSCode] Fixed a held Up key replacing an unsent
 * message with an earlier prompt, and Down not bringing the message back
 * after the recalled prompt got a new line or was cleared". Also covers CC
 * 2.1.331's "dropping edits to a recalled prompt".
 *
 * In Claudius any edit to a recalled prompt ended history browsing. So after
 * Cmd/Ctrl+↑ recalled an earlier prompt and the user added a line (or cleared
 * it), Cmd/Ctrl+↓ did nothing, and the next Cmd/Ctrl+↑ stashed the edited
 * text over the unsent draft, losing it for good. Browsing now survives
 * edits: ↓ walks back to the draft, and the edited entry keeps its edit.
 * (Claudius's plain ↑ never enters history, so the held-Up half doesn't apply.)
 *
 * Screenshot target: docs/cc-parity/2.1.332/history-recall-keeps-draft.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { assistantText, initEvent, mockChatBackend, userText } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.332");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000332hr01";
const DRAFT = "my unsent draft about the billing bug";
const EARLIER = "summarize the failing tests";

async function setup(page: Page): Promise<void> {
  await mockChatBackend(page, FAKE_SESSION_ID, [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    initEvent("sys-init-332hr"),
    userText("u-1", "an older prompt"),
    assistantText("a-1", "Older answer."),
    userText("u-2", EARLIER),
    assistantText("a-2", "Two tests fail."),
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

test("Down brings the unsent draft back after the recalled prompt got a new line", async ({ page }) => {
  await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText("Two tests fail.")).toBeVisible();
  await composer.fill(DRAFT);

  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect(composer).toHaveValue(EARLIER);
  // Give the recalled prompt a new line.
  await composer.press("End");
  await page.keyboard.press("Shift+Enter");
  await composer.pressSequentially("and fix them");
  await expect(composer).toHaveValue(`${EARLIER}\nand fix them`);

  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect(composer).toHaveValue(DRAFT);

  await page.waitForTimeout(100);
  await page.screenshot({ path: resolve(SHOTS_DIR, "history-recall-keeps-draft.png"), fullPage: false });

  // The edit to the recalled prompt is kept too.
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect(composer).toHaveValue(`${EARLIER}\nand fix them`);
});

test("Down brings the draft back after the recalled prompt was cleared, and Up never overwrites it", async ({ page }) => {
  await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText("Two tests fail.")).toBeVisible();
  await composer.fill(DRAFT);

  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect(composer).toHaveValue(EARLIER);
  await composer.fill("");
  // Up again walks on to the older entry instead of re-stashing the edit.
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect(composer).toHaveValue("an older prompt");
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect(composer).toHaveValue("");
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect(composer).toHaveValue(DRAFT);
});
