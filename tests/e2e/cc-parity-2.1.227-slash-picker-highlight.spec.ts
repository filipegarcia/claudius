/**
 * CC 2.1.227 — "Improved slash-command menu: blue now marks only the
 * selected row, matched characters are bolded instead of recolored, and
 * emoji or accented names keep their glyphs."
 *
 * Claudius's `SlashCommandPicker` already only tints the *selected* row's
 * background (never per-row blue) and command names are already plain
 * unicode text rendered by the browser (no glyph-stripping to fix) — so
 * those two clauses were already true here. The one actionable gap: typed
 * characters that matched a command name weren't visually indicated at
 * all (no bold, no recolor). Fixed with `fuzzySlashMatchIndices`
 * (`lib/shared/slash-commands.ts`) + `HighlightedCommandName`
 * (`components/chat/SlashCommandPicker.tsx`): the characters in the name
 * that matched the typed filter now render `font-semibold`.
 *
 * Screenshot target: docs/cc-parity/2.1.227/slash-picker-highlight.png
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SHOTS_DIR = resolve(process.cwd(), "docs/cc-parity/2.1.227");
mkdirSync(SHOTS_DIR, { recursive: true });

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("CC 2.1.227 — SlashCommandPicker bolds matched characters", () => {
  test("typing a filter bolds the matched characters in the visible command names", async ({
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
    // "co" is a contiguous prefix match of "cost" (and other co* commands) —
    // the leading two characters of the matching rows should render bold.
    await composer.pressSequentially("/co", { delay: 20 });
    await page.waitForTimeout(200);

    const costRow = page.locator("button", { hasText: "cost" }).first();
    await expect(costRow).toBeVisible({ timeout: 5_000 });

    // The matched run ("c", "o") renders as individual bold <span>s ahead of
    // the unmatched remainder — assert the bold spans exist and spell out
    // the typed filter, not just that *some* bold text is present.
    const boldChars = await costRow.locator("span.font-semibold").allTextContents();
    expect(boldChars.join("")).toBe("co");

    // Screenshot in context — full chat chrome, composer with the picker
    // open above it, bolded matches visible in the result rows.
    await page.screenshot({
      path: resolve(SHOTS_DIR, "slash-picker-highlight.png"),
      fullPage: false,
    });
  });
});
