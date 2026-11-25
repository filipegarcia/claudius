/**
 * CC 2.1.331 parity — "[VSCode] Fixed the command menu keeping an earlier
 * match highlighted while you type more in its filter, so Enter could run the
 * wrong row".
 *
 * Claudius's slash menu reset its highlight only when the number of rows
 * changed. It shows at most 16 rows and usually fills them, so after ↓↓ and
 * another letter the list re-sorted under a highlight that stayed on slot 3,
 * now a different command, and Tab inserted it. The ⌘K command palette never
 * reset its highlight on typing at all. Both now go back to the top row when
 * the filter changes.
 *
 * Screenshot target: docs/cc-parity/2.1.331/slash-menu-highlight-reset.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page, type Route } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";
import { initEvent, mockChatBackend } from "./helpers/mock-chat";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.331");
mkdirSync(SHOTS_DIR, { recursive: true });

const FAKE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-00000331hr01";

async function setup(page: Page): Promise<void> {
  await mockChatBackend(page, FAKE_SESSION_ID, [
    { type: "ready", sessionId: FAKE_SESSION_ID },
    initEvent("sys-init-331hr"),
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

test("typing more in the slash menu moves the highlight back to the top row", async ({ page }) => {
  await setup(page);
  await page.goto("/");

  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.focus();
  await composer.pressSequentially("/s");
  const rows = page.getByTestId("slash-command-row");
  // The capped list is full before and after the next letter, so only the
  // filter changes — the case the length-only reset missed.
  await expect(rows).toHaveCount(16);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(2).getByTestId("picker-selected-pointer")).toHaveCount(1);

  await composer.pressSequentially("e");
  await expect(rows).toHaveCount(16);
  await expect(rows.first().getByTestId("picker-selected-pointer")).toHaveCount(1);

  await page.waitForTimeout(100);
  await page.screenshot({ path: resolve(SHOTS_DIR, "slash-menu-highlight-reset.png"), fullPage: false });
});

test("typing in the command palette moves the highlight back to the top row", async ({ page }) => {
  await setup(page);
  await page.goto("/");

  await expect(page.getByTestId("prompt-input")).toBeEnabled({ timeout: 15_000 });
  // The palette chord is ignored while typing in the composer.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("textbox", { name: "Command palette search" });
  await expect(input).toBeFocused();

  await input.pressSequentially("o");
  const rows = page.getByTestId("command-palette-row");
  await expect(rows.nth(3)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(3)).toHaveAttribute("data-active", "true");

  await input.pressSequentially("p");
  await expect(rows.first()).toHaveAttribute("data-active", "true");
});
