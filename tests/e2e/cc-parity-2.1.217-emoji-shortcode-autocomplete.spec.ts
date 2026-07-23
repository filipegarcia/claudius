/**
 * CC 2.1.217 — "Added emoji shortcode autocomplete in the prompt input: type
 * `:heart:` to insert ❤️, or `:hea` for suggestions — disable with the
 * `emojiCompletionEnabled` setting."
 *
 * Claudius reimplements this as browser-side composer logic (no SDK
 * involvement — see `lib/shared/emoji-shortcodes.ts` /
 * `components/chat/EmojiShortcodePicker.tsx` / `PromptInput.tsx`). This spec
 * drives the real composer and verifies:
 *   1. typing the closing `:` of a known shortcode (`:heart:`) swaps it for
 *      the emoji glyph inline,
 *   2. a partial token (`:fir`) opens the suggestion picker, and Enter
 *      inserts the highlighted match,
 *   3. the `emojiCompletionEnabled` setting (flipped through the real
 *      Settings UI, matching the 2.1.207 disableAutoMode spec's pattern)
 *      disables both behaviors when set to `false`.
 *
 * Screenshot targets: docs/cc-parity/2.1.217/emoji-shortcode-picker.png,
 * docs/cc-parity/2.1.217/emoji-completion-setting.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.217");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function getJsonWithRetry<T>(page: Page, url: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return (await page.request.get(url).then((r) => r.json())) as T;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(250 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Clear `emojiCompletionEnabled` from the shared dev fixture's user-scope settings. */
async function clearEmojiCompletionSetting(page: Page): Promise<void> {
  const cur = await getJsonWithRetry<{ settings: Record<string, unknown> }>(
    page,
    "/api/settings?scope=user",
  );
  const rest = { ...cur.settings };
  delete rest.emojiCompletionEnabled;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

/**
 * Return the composer once it's mounted, enabled, and *provably empty*.
 *
 * All three cases in this file resume the same dev-fixture session, and
 * Claudius persists the composer draft per session (debounced `PUT
 * /api/sessions/:id/prompt-draft`, restored via a `GET` on the next mount).
 * Without this, a prior case's typed-but-unsubmitted text (e.g. `nice ❤️`)
 * bleeds into the next case's `pressSequentially`. A bare `fill("")` isn't
 * enough — the restore GET can land *after* mount and re-populate the field —
 * so clear-then-poll-until-empty, which lets the one-shot restore lose the race.
 */
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

/** `goto("/")`, wait for a real session, then hand back a provably-empty composer. */
async function gotoFreshComposer(page: Page) {
  await page.goto("/");
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
  return readyEmptyComposer(page);
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearEmojiCompletionSetting(page);
  // Same open-tabs stub as the 2.1.207 spec — this file navigates to "/"
  // more than once, and each visit would otherwise persist another tab into
  // the shared per-cwd store.
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

test.afterEach(async ({ page }) => {
  await clearEmojiCompletionSetting(page);
});

test.describe("CC 2.1.217 — emoji shortcode autocomplete", () => {
  test("closing the colon on a known shortcode inserts the emoji inline", async ({ page }) => {
    const composer = await gotoFreshComposer(page);
    await composer.pressSequentially("nice :heart:", { delay: 20 });

    await expect(composer).toHaveValue("nice ❤️");
  });

  test("a partial shortcode opens the suggestion picker; Enter inserts the highlighted match", async ({
    page,
  }) => {
    const composer = await gotoFreshComposer(page);
    await composer.pressSequentially("ship it :fir", { delay: 20 });

    const picker = page.getByTestId("emoji-shortcode-picker");
    await expect(picker).toBeVisible({ timeout: 5_000 });
    const option = page.getByTestId("emoji-shortcode-option").filter({ hasText: ":fire:" });
    await expect(option).toBeVisible();

    // Screenshot in context — full chat chrome (side nav, tab strip, message
    // area) with the picker open above the composer, not a cropped element.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "emoji-shortcode-picker.png"),
      fullPage: false,
    });

    await composer.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(composer).toHaveValue("ship it 🔥 ");
  });

  test("emojiCompletionEnabled=false (via the real Settings UI) disables both behaviors", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("emojiCompletionEnabled");
    const row = page.locator("label", { hasText: "emojiCompletionEnabled" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('input[type="checkbox"]').uncheck();
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(
        async () => {
          // Guarded read — under parallel-suite load the settings GET can return
          // a truncated body and `r.json()` throws "Unexpected end of JSON
          // input"; swallow it so the poll retries instead of failing the test.
          try {
            const body = await getJsonWithRetry<{ settings: { emojiCompletionEnabled?: boolean } }>(
              page,
              "/api/settings?scope=user",
            );
            return body.settings.emojiCompletionEnabled;
          } catch {
            return undefined;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(false);

    // Saving resets the search filter (same quirk noted in the
    // disableAutoMode spec) — re-apply it so the screenshot shows the row.
    await page.getByLabel("Search settings").fill("emojiCompletionEnabled");
    await expect(row).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "emoji-completion-setting.png"),
      fullPage: false,
    });

    const composer = await gotoFreshComposer(page);
    await composer.pressSequentially("nice :heart:", { delay: 20 });
    // No replacement — the literal text stays put.
    await expect(composer).toHaveValue("nice :heart:");
    await expect(page.getByTestId("emoji-shortcode-picker")).toHaveCount(0);

    await composer.pressSequentially(" :fir", { delay: 20 });
    await expect(page.getByTestId("emoji-shortcode-picker")).toHaveCount(0);
  });
});
