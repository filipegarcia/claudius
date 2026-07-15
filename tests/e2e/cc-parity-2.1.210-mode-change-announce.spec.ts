/**
 * CC 2.1.210 — "Screen reader mode now announces permission mode changes
 * aloud when cycling modes with Shift+Tab."
 *
 * Claudius already has the identical Shift+Tab permission-mode cycle
 * (`lib/shared/permission-modes.ts`, `components/chat/ModeSelector.tsx`).
 * Rather than porting a separate opt-in "screen reader mode" toggle, this
 * is surfaced as a standard always-on `aria-live="polite"` region — inert
 * for sighted users, read automatically by whatever assistive tech is
 * running. No visual change, so no screenshot for this one (see the
 * run-notes "New UI surfaces" section) — this spec instead asserts the
 * announcement text directly.
 */
import { test, expect } from "../helpers/test";

test.describe("Permission mode change announcement (CC 2.1.210)", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/sessions**", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      }
      return route.fallback();
    });
    await page.goto("/");
  });

  test("changing mode via the picker updates the live-region announcement", async ({ page }) => {
    const trigger = page.getByTestId("mode-selector-trigger");
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    const announcement = page.getByTestId("mode-selector-announcement");
    // aria-live region exists from first render, but stays empty until the
    // mode actually changes — first mount is not "a change".
    await expect(announcement).toHaveText("");
    await expect(announcement).toHaveAttribute("aria-live", "polite");

    await trigger.click();
    await page.getByTestId("mode-selector-option-acceptEdits").click();

    await expect(announcement).toHaveText(/Permission mode: Accept edits/);

    // A second change re-announces with the new mode's own text.
    await trigger.click();
    await page.getByTestId("mode-selector-option-plan").click();
    await expect(announcement).toHaveText(/Permission mode: Plan/);
  });
});
