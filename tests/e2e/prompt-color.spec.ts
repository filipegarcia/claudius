/**
 * Verifies the `/color` slash command recolors the composer border.
 *
 * Regression guard: the first implementation applied the color through a
 * Tailwind arbitrary-value class with an opacity modifier
 * (`border-[var(--prompt-accent)]/70`), which did not compile — the toast
 * fired but the border never changed. The fix applies the color inline, so
 * this spec asserts the *computed* border color actually flips.
 */
import { test, expect } from "../helpers/test";

// #e5484d (red) → rgb(229, 72, 77)
const RED = "rgb(229, 72, 77)";

test.describe("/color slash command", () => {
  test("recolors the composer border", async ({ page }) => {
    await page.goto("/");

    // Boot auto-creates + binds a session; wait until the URL carries it so
    // `/color` dispatches against a real session id (not "No active session").
    await page.waitForURL((url) => /[?&]session=[0-9a-f-]{36}/i.test(String(url)), {
      timeout: 30_000,
    });

    const composer = page.getByTestId("prompt-input");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    // Let the freshly-bound session settle to `ready` so submit isn't a no-op.
    await page.waitForTimeout(500);

    // Helper: walk up from the textarea to the bordered composer container and
    // read its computed border color.
    const borderColor = () =>
      composer.evaluate((el) => {
        let node: HTMLElement | null = el.parentElement;
        while (node) {
          const c = getComputedStyle(node).borderTopColor;
          // The container is the rounded box with a visible 1px border.
          if (node.className.includes("rounded-2xl")) return c;
          node = node.parentElement;
        }
        return null;
      });

    const before = await borderColor();
    expect(before).not.toBe(RED);

    // Type it out (not fill()) so the space genuinely fires the change handler
    // that closes the slash picker — otherwise Enter selects the highlighted
    // command instead of submitting.
    await composer.click();
    await composer.pressSequentially("/color red", { delay: 20 });
    await page.waitForTimeout(150);
    await composer.press("Enter");

    // Toast confirms dispatch; border is the real assertion.
    await expect(page.getByText("Session color set to: red")).toBeVisible({ timeout: 10_000 });
    await expect.poll(borderColor, { timeout: 10_000 }).toBe(RED);
  });
});
