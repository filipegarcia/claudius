/**
 * Regression guard for a bug found while wiring up the emoji shortcode
 * picker (CC 2.1.217 parity): `AtMentionPicker` / `SlashCommandPicker`'s
 * keydown handlers ran on `window` in the CAPTURE phase (ahead of
 * `PromptInput`'s own `onKeyDown`, which runs in the BUBBLE phase on the
 * textarea) and called `preventDefault()` but not `stopPropagation()` on
 * Tab/Enter select. Because `onSelect` resets the picker's query state
 * (`atQuery`/`pickerOpen`) synchronously enough that the *same* keydown
 * still reached `onKeyDown` afterward, the picker's own Enter-to-select (or
 * Tab-to-select) could immediately re-trigger PromptInput's "picker is
 * closed now" fallback — submitting the message or inserting a Tab-indent
 * on the very keystroke that was supposed to just insert the mention/command.
 *
 * Fixed by adding `e.stopPropagation()` alongside the existing
 * `e.preventDefault()` in all three composer pickers (slash, @-mention,
 * emoji). This spec exercises the two pre-existing pickers directly (the
 * emoji picker's own contract is covered by
 * `cc-parity-2.1.217-emoji-shortcode-autocomplete.spec.ts`).
 */
import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

test.beforeEach(async ({ page }) => {
  await activateClaudiusWorkspace(page);
});

test.describe("composer picker Tab/Enter selection doesn't leak into PromptInput's own handling", () => {
  test("selecting an @-mention with Enter inserts the mention, not a submit or a newline", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(500);

    // See the matching comment in the slash-command test below — clear any
    // restored draft before typing so this test is independent of tab reuse.
    await composer.fill("");
    await composer.click();
    await composer.pressSequentially("check @package", { delay: 20 });

    // Wait for the fs/list fetch to resolve so the picker has real rows
    // (not the transient "loading…" empty state, which no-ops on Enter).
    await expect(page.getByText("loading…")).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(200);

    await composer.press("Enter");
    await page.waitForTimeout(200);

    // Neither "submitted (cleared)" nor "fell through to a literal newline"
    // — the mention itself should be inserted, trailing space included.
    const value = await composer.inputValue();
    expect(value).not.toBe("");
    expect(value).not.toContain("\n");
    expect(value.startsWith("check @package")).toBe(true);
    expect(value.endsWith(" ")).toBe(true);
  });

  test("selecting a slash command with Tab inserts the command, not a stray indent", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(500);

    // Belt-and-suspenders: a restored per-session draft (from prompt-draft
    // persistence) could otherwise leak leftover text ahead of what this
    // test types, since Claudius may bind to an already-open tab rather
    // than a guaranteed-fresh session.
    await composer.fill("");
    await composer.click();
    await composer.pressSequentially("/clear", { delay: 20 });
    await page.waitForTimeout(200);

    await composer.press("Tab");
    await page.waitForTimeout(200);

    const value = await composer.inputValue();
    // Selecting replaces the whole buffer with "/<cmd> " — no leaked extra
    // whitespace/indent from a Tab that fell through to the list-indent path.
    expect(value).toBe("/clear ");
  });
});
