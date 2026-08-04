/**
 * CC 2.1.221 — "Changed emoji autocomplete to accept common alternate
 * shortcodes like `:thumbsup:`, `:thumbsdown:`, and `:love:`."
 *
 * Claudius's emoji shortcode table (`lib/shared/emoji-shortcodes.ts`,
 * shipped for 2.1.217 parity) already used `thumbsup`/`thumbsdown` as its
 * canonical names — the only real gap was `love`, a common alternate for
 * `heart`. This spec drives the same real composer as the 2.1.217 emoji
 * spec and exercises the new `EMOJI_ALIASES` table end-to-end: closing
 * `:love:` inserts ❤️ inline, and a partial `:lov` surfaces "love" in the
 * suggestion picker alongside the canonical `heart` entry.
 *
 * Screenshot target: docs/cc-parity/2.1.221/emoji-alias-picker.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.221");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/** Same "provably empty" composer contract as the 2.1.217 spec — see its comment for why. */
async function readyEmptyComposer(page: Page) {
  const composer = page.getByTestId("prompt-input");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await composer.click();
  await expect
    .poll(
      async () => {
        await composer.fill("");
        return composer.inputValue();
      },
      { timeout: 10_000 },
    )
    .toBe("");
  return composer;
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  // Same open-tabs stub as the 2.1.207/2.1.217 specs — avoids persisting an
  // extra tab into the shared per-cwd store on every `goto("/")`.
  await page.route("**/api/sessions/open-tabs", async (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.fallback();
  });
});

test.describe("CC 2.1.221 — emoji shortcode aliases", () => {
  test("closing `:love:` inserts the same emoji as `:heart:`", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    const composer = await readyEmptyComposer(page);

    await composer.pressSequentially("sending :love:", { delay: 20 });
    await expect(composer).toHaveValue("sending ❤️");
  });

  test("a partial `:lov` surfaces the `love` alias in the picker, resolving to the heart emoji", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    const composer = await readyEmptyComposer(page);

    await composer.pressSequentially("aw :lov", { delay: 20 });

    const picker = page.getByTestId("emoji-shortcode-picker");
    await expect(picker).toBeVisible({ timeout: 5_000 });
    const option = page.getByTestId("emoji-shortcode-option").filter({ hasText: ":love:" });
    await expect(option).toBeVisible();
    await expect(option).toContainText("❤️");

    // Screenshot in context — full chat chrome with the alias suggestion
    // visible in the picker above the composer.
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "emoji-alias-picker.png"), fullPage: false });

    await composer.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(composer).toHaveValue("aw ❤️ ");
  });
});
