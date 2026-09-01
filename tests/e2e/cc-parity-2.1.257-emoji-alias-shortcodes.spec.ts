/**
 * CC 2.1.257 — "Improved emoji autocomplete to accept the remaining
 * GitHub/Slack shortcode aliases (:satisfied:, :telephone:, :collision:, …)."
 *
 * Same shape as the 2.1.221 alias spec (`:love:`) — this exercises the two
 * new `EMOJI_ALIASES` entries added for this release: `satisfied` →
 * `laughing`, and `collision` → `boom`. (`:telephone:` needed no alias —
 * it's already a canonical `EMOJI_SHORTCODES` key — so it isn't re-tested
 * here; see `tests/unit/emoji-shortcodes.test.ts` for that assertion.)
 *
 * Screenshot target: docs/cc-parity/2.1.257/emoji-alias-satisfied.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.257");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/** Same "provably empty" composer contract as the 2.1.217/2.1.221 specs. */
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

test.describe("CC 2.1.257 — emoji shortcode aliases (satisfied, collision)", () => {
  test("closing `:collision:` inserts the same emoji as `:boom:`", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    const composer = await readyEmptyComposer(page);

    await composer.pressSequentially("careful :collision:", { delay: 20 });
    await expect(composer).toHaveValue("careful 💥");
  });

  test("a partial `:satisf` surfaces the `satisfied` alias, resolving to the same emoji as `laughing`", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    const composer = await readyEmptyComposer(page);

    await composer.pressSequentially("nice :satisf", { delay: 20 });

    const picker = page.getByTestId("emoji-shortcode-picker");
    await expect(picker).toBeVisible({ timeout: 5_000 });
    const option = page.getByTestId("emoji-shortcode-option").filter({ hasText: ":satisfied:" });
    await expect(option).toBeVisible();
    await expect(option).toContainText("😆");

    // Screenshot in context — full chat chrome with the alias suggestion
    // visible in the picker above the composer.
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(SHOTS_DIR, "emoji-alias-satisfied.png"), fullPage: false });

    await composer.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(composer).toHaveValue("nice 😆 ");
  });
});
