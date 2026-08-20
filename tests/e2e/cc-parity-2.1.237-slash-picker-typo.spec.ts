/**
 * CC 2.1.236 — "Pressing Enter on a slash-command typo or a command
 * unavailable in this session now reports it instead of running the closest
 * fuzzy match; prefixes and aliases still run."
 *
 * Claudius's `SlashCommandPicker` is an independent fuzzy-matching
 * implementation (no shared code with the CLI's), but had the identical
 * footgun: `filtered` ranks commands by a loose subsequence fuzzy score
 * (e.g. the filter "cs" scores a positive — but weak — match against "cost"
 * purely because 'c' and 's' appear in order), and Enter always inserted
 * `visible[hi]` regardless of how confident that top match was. A user
 * typing a typo could have the composer silently rewritten to an unrelated
 * command name.
 *
 * Fixed with `isConfidentSlashMatch` (`lib/shared/slash-commands.ts`): Enter
 * only auto-completes when the top match is a prefix of the command's name
 * or one of its aliases. Tab (an explicit "insert the suggestion" gesture)
 * still uses the looser fuzzy ranking, unchanged.
 *
 * Screenshot target: docs/cc-parity/2.1.237/slash-picker-typo.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.237");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.236 — SlashCommandPicker Enter no longer auto-completes a weak fuzzy match", () => {
  test("typing a subsequence-only typo and pressing Enter leaves the composer text intact", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(500);

    await composer.fill("");
    await composer.click();
    // "cs" is a subsequence of "cost" (c...s) — a weak fuzzy hit, but not a
    // prefix of "cost" or of any registered command/alias. Before the fix,
    // this is exactly the shape of typo that could silently autocomplete.
    await composer.pressSequentially("/cs", { delay: 20 });
    await page.waitForTimeout(200);

    // Screenshot in context — full chat chrome with the picker's fuzzy-only
    // (non-confident) result set showing above the composer.
    await page.screenshot({
      path: resolve(SHOTS_DIR, "slash-picker-typo.png"),
      fullPage: false,
    });

    await composer.press("Enter");
    await page.waitForTimeout(200);

    const value = await composer.inputValue();
    // Never silently rewritten to a real command like "/cost ".
    expect(value).not.toBe("/cost ");
    expect(value.startsWith("/cs")).toBe(true);
  });

  test("typing a real command's prefix and pressing Enter still auto-completes it", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(500);

    await composer.fill("");
    await composer.click();
    // "cost" is a genuine prefix match of the "cost" command — still
    // confident, still auto-completes on Enter.
    await composer.pressSequentially("/cost", { delay: 20 });
    await page.waitForTimeout(200);

    await composer.press("Enter");
    await page.waitForTimeout(200);

    expect(await composer.inputValue()).toBe("/cost ");
  });
});
