/**
 * CC 2.1.235 — "Added an optional spellcheck setting that underlines
 * misspelled words in the prompt input as you type, using your installed
 * aspell, hunspell, or ispell."
 *
 * Claudius reimplements this as a browser-native equivalent: the composer's
 * `<textarea>` already gets free spellcheck from the browser, so this ships
 * as a Settings → Chat toggle (`spellcheckEnabled` — NOT `spellcheck`; the
 * SDK already owns that key as an object shape in the same
 * `~/.claude/settings.json`, see `lib/server/settings.ts`) wired to the
 * textarea's `spellCheck` DOM attribute — see
 * `lib/client/useSpellcheckEnabled.ts` / `components/chat/PromptInput.tsx`.
 *
 * Unlike the CLI, Claudius defaults this ON (absent/true = enabled) since
 * the browser already spellchecks by default; see the 2.1.237 run-notes for
 * the full "conservative vs maximal default" reasoning.
 *
 * This spec verifies the toggle end-to-end via the real Settings UI and the
 * DOM attribute it drives (headless Chromium doesn't reliably render the red
 * squiggly underline without a spelling dictionary, so the DOM contract is
 * the meaningful, non-flaky assertion — the screenshot captures the toggle
 * in context instead).
 *
 * Screenshot target: docs/cc-parity/2.1.237/settings-spellcheck.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.237");
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

/** Clear `spellcheckEnabled` from the shared dev fixture's user-scope settings. */
async function clearSpellcheckSetting(page: Page): Promise<void> {
  const cur = await getJsonWithRetry<{ settings: Record<string, unknown> }>(
    page,
    "/api/settings?scope=user",
  );
  const rest = { ...cur.settings };
  delete rest.spellcheckEnabled;
  await page.request.put("/api/settings/full", {
    data: { scope: "user", settings: rest },
  });
}

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
  await clearSpellcheckSetting(page);
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
  await clearSpellcheckSetting(page);
});

test.describe("CC 2.1.235 — prompt-input spellcheck setting", () => {
  test("composer textarea is spellchecked by default (no setting present)", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toHaveAttribute("spellcheck", "true");
  });

  test("spellcheckEnabled=false (via the real Settings UI) disables the composer attribute", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByLabel("Search settings").fill("spellcheckEnabled");
    const row = page.locator("label", { hasText: "spellcheckEnabled" }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Screenshot in context — full Settings page chrome (side nav, header,
    // Chat card) with the toggle visible, before flipping it.
    await page.waitForTimeout(150);
    await page.screenshot({
      path: resolve(SHOTS_DIR, "settings-spellcheck.png"),
      fullPage: false,
    });

    await row.locator('input[type="checkbox"]').uncheck();
    await page.getByRole("button", { name: /^Save$/ }).click();

    await expect
      .poll(
        async () => {
          try {
            const body = await getJsonWithRetry<{ settings: { spellcheckEnabled?: boolean } }>(
              page,
              "/api/settings?scope=user",
            );
            return body.settings.spellcheckEnabled;
          } catch {
            return undefined;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(false);

    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toHaveAttribute("spellcheck", "false");
  });
});
