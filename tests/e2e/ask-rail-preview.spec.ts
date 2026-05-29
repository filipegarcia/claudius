import { test, expect } from "../helpers/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Renders the "Rail rule" AskUserQuestion fixture from session
 * c8de71dd-1fda-441d-b4b5-bbbaf780eaf2 at /dev/ask-rail-preview so you can
 * eyeball the new <pre> fallback that PreviewPane applies to non-HTML
 * preview content. Run headed to watch:
 *
 *   bunx playwright test tests/e2e/ask-rail-preview.spec.ts --headed
 *
 * Writes a PNG to test-results/ask-rail-preview.png for the marketing
 * gallery / diffing.
 */
test("rail-rule AskUserQuestion fixture renders with text-preview fallback", async ({ page }) => {
  await page.goto("/dev/ask-rail-preview");

  const modal = page.getByTestId("ask-user-question");
  await expect(modal).toBeVisible();

  // Modal header shows the question text. The "Rail rule" header chip only
  // renders for multi-question forms (this fixture has just one), so it's
  // intentionally not asserted here.
  await expect(modal).toContainText("How should customization workspaces appear in the left rail?");

  // Cycle through every option so each preview block is rendered at least
  // once — confirms the <pre> branch survives ASCII / box-drawing chars on
  // all four options, not just the first.
  for (let i = 0; i < 4; i++) {
    await page.getByTestId(`ask-option-${i}`).click();
    // Preview pane mirrors the focused option's label.
    await expect(modal).toContainText(`Preview · ${["Active only", "Active + last 2 recent", "Pin to rail per customization", "Customizations drawer"][i]}`);
  }

  // Refocus the recommended option for the screenshot.
  await page.getByTestId("ask-option-0").click();
  await page.waitForTimeout(300);

  const outDir = resolve(process.cwd(), "test-results");
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: resolve(outDir, "ask-rail-preview.png"), fullPage: false });
});
