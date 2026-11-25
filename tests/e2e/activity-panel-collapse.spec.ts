import { test, expect, type Page } from "../helpers/test";

/**
 * The right-hand Activity panel can be collapsed to a slim stripe and the
 * choice is remembered:
 *   1. Expanded by default; the header's collapse button shrinks it to the
 *      stripe (and the chat column gets the space back).
 *   2. The collapsed state survives a reload.
 *   3. Clicking the stripe expands it again.
 *   4. Settings → Layout → "Show the Activity panel" toggles the same pref.
 */

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: Page): Promise<void> {
  await page.waitForURL((url) => SESSION_RE.test(String(url)), { timeout: 30_000 });
}

test.describe("Activity panel — collapse / expand", () => {
  test("collapses to a stripe, persists, and is toggleable from Settings", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1400, height: 800 });

    await page.goto("/");
    await waitForBoundSession(page);

    const rail = page.locator('[data-pane-name="right-rail"]');
    const collapsedRail = page.getByTestId("activity-panel-collapsed");
    const chat = page.locator('[data-pane-name="chat-area"]');

    // ── 1. Expanded by default → collapse from the header.
    await expect(rail).toHaveCount(1);
    await expect(collapsedRail).toHaveCount(0);
    const expandedWidth = (await rail.boundingBox())!.width;
    const chatBefore = (await chat.boundingBox())!.width;

    await page.getByTestId("activity-panel-collapse").click();
    await expect(collapsedRail).toBeVisible();
    const stripeWidth = (await rail.boundingBox())!.width;
    expect(stripeWidth).toBeLessThan(expandedWidth / 3);
    // The panel's content (e.g. the notifications drawer) is gone…
    await expect(rail.locator('[data-pane-name="notifications"]')).toHaveCount(0);
    // …and the chat column picked up the freed width.
    await expect
      .poll(async () => (await chat.boundingBox())!.width)
      .toBeGreaterThan(chatBefore + 100);

    // ── 2. Survives a reload.
    await page.reload();
    await waitForBoundSession(page);
    await expect(page.getByTestId("activity-panel-collapsed")).toBeVisible({ timeout: 10_000 });

    // ── 3. The stripe's toggle expands it again.
    await page.getByTestId("activity-panel-expand").click();
    await expect(page.getByTestId("activity-panel-collapsed")).toHaveCount(0);
    await expect(page.getByTestId("activity-panel-collapse")).toBeVisible();

    // ── 4. Settings → Layout toggles the same pref.
    await page.goto("/settings");
    const toggle = page.getByTestId("activity-panel-show-toggle");
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();

    await page.goto("/");
    await waitForBoundSession(page);
    await expect(page.getByTestId("activity-panel-collapsed")).toBeVisible({ timeout: 10_000 });
  });
});
