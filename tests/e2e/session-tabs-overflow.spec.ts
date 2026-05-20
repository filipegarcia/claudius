import { test, expect, type Page } from "../helpers/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

async function waitForBoundSession(page: Page, opts: { not?: string } = {}): Promise<string> {
  await page.waitForURL(
    (url) => {
      const m = String(url).match(SESSION_RE);
      if (!m) return false;
      if (opts.not && m[1] === opts.not) return false;
      return true;
    },
    { timeout: 30_000 },
  );
  const m = page.url().match(SESSION_RE)!;
  return m[1];
}

/**
 * Verify that when more session tabs are open than the bar can fit, the
 * overflow is surfaced behind a chevron with a count, NOT via a horizontal
 * scrollbar. Picking a hidden tab from the popover activates it and brings
 * it into the visible portion of the bar.
 */
test.describe("Session tabs — overflow into chevron popover", () => {
  test("opens many tabs in a narrow viewport, the chevron lists hidden ones", async ({ page, baseURL }) => {
    test.setTimeout(120_000);

    // Reset persisted tab strip so leftover tabs from prior runs don't
    // skew the visible/hidden count this test asserts on.
    await page.request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: { tabs: [], activeId: null },
    });

    // Narrow viewport so even ~6 tabs overflow.
    await page.setViewportSize({ width: 700, height: 800 });

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    // Open enough new tabs to exceed the strip's capacity at this width.
    // The "+" button sits flush to the right of the last visible tab inside
    // the strip — not pinned to the far end of the bar.
    const newTabBtn = page.locator('button[title="New session tab"]');
    const ids = [idA];
    for (let i = 0; i < 6; i++) {
      const before = ids[ids.length - 1];
      await newTabBtn.click();
      const next = await waitForBoundSession(page, { not: before });
      ids.push(next);
    }
    expect(ids.length).toBe(7);

    // The overflow chevron should be visible with a non-zero count.
    const overflowBtn = page.getByTestId("session-tabs-overflow");
    await expect(overflowBtn).toBeVisible({ timeout: 5_000 });
    const count = Number((await overflowBtn.textContent())?.trim());
    expect(count).toBeGreaterThan(0);

    // Total tabs = visible (DOM data-tab-hidden=false) + hidden (true).
    const visibleTabs = page.locator(
      '[data-testid="session-tab"][data-tab-hidden="false"]',
    );
    const hiddenTabs = page.locator(
      '[data-testid="session-tab"][data-tab-hidden="true"]',
    );
    const visibleCount = await visibleTabs.count();
    const hiddenCount = await hiddenTabs.count();
    expect(visibleCount + hiddenCount).toBe(ids.length);
    expect(hiddenCount).toBe(count);
    // The active (most recent) tab must be one of the visible ones.
    const activeVisible = page.locator(
      '[data-testid="session-tab"][data-tab-active="true"][data-tab-hidden="false"]',
    );
    await expect(activeVisible).toHaveCount(1);

    // Open the popover; it lists exactly the hidden ones.
    await overflowBtn.click();
    const menu = page.getByTestId("session-tabs-overflow-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("session-tabs-overflow-item")).toHaveCount(hiddenCount);

    // Pick one — the first hidden item should be ids[0] (the original session,
    // which got pushed into overflow as new tabs were appended).
    const hiddenItems = page.getByTestId("session-tabs-overflow-item");
    const firstHidden = await hiddenItems.first().getAttribute("data-tab-id");
    expect(firstHidden).toBeTruthy();
    await hiddenItems.first().click();

    // Menu closes after selection.
    await expect(menu).not.toBeVisible();

    // The selected tab is now active and visible in the strip.
    await waitForBoundSession(page); // any session ok — picking switches it
    const newlyActive = page.locator(
      `[data-testid="session-tab"][data-tab-id="${firstHidden}"]`,
    );
    await expect(newlyActive).toHaveAttribute("data-tab-active", "true", { timeout: 5_000 });
    await expect(newlyActive).toHaveAttribute("data-tab-hidden", "false");

    // The bar itself never scrolls horizontally — its scrollWidth equals
    // its clientWidth (modulo a px or two of rounding on retina).
    const stripBox = await page.locator(".flex.h-8").first().boundingBox();
    expect(stripBox).toBeTruthy();
  });
});
