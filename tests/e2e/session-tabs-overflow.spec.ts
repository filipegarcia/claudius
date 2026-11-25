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
 * Verify the IntelliJ "scroll tabs" overflow: when more session tabs are open
 * than the bar can fit, the strip scrolls horizontally (every tab stays
 * rendered — nothing is `display: none`d) and a chevron with a count lists
 * the tabs that are currently out of view. Picking one from the popover
 * activates it and scrolls it into view; a vertical mouse wheel over the
 * strip scrolls it sideways.
 */
test.describe("Session tabs — overflow scrolls, chevron lists out-of-view tabs", () => {
  test("opens many tabs in a narrow viewport, scrolls the strip, the chevron lists hidden ones", async ({ page, baseURL }) => {
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

    // Every tab is still laid out (scrolled, not hidden): the scroller's
    // content is wider than its viewport and each tab has a real width.
    const scroller = page.getByTestId("session-tabs-scroller");
    const dims = await scroller.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);
    const widths = await page
      .locator('[data-testid="session-tab"]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).offsetWidth));
    expect(widths).toHaveLength(ids.length);
    for (const w of widths) expect(w).toBeGreaterThan(0);

    // Total tabs = in view (data-tab-hidden=false) + out of view (true).
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

    // ── Vertical wheel over the strip scrolls it sideways (IntelliJ). The
    // picked tab (ids[0]) is at the start, so wheeling "down" scrolls right
    // until the last tab comes into view and the first goes out of view.
    const scrollBefore = await scroller.evaluate((el) => el.scrollLeft);
    await scroller.hover();
    await page.mouse.wheel(0, 4000);
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollLeft), { timeout: 5_000 })
      .toBeGreaterThan(scrollBefore);
    const lastId = ids[ids.length - 1];
    await expect(
      page.locator(`[data-testid="session-tab"][data-tab-id="${lastId}"]`),
    ).toHaveAttribute("data-tab-hidden", "false");
    await expect(newlyActive).toHaveAttribute("data-tab-hidden", "true");
    // Scrolling never changes the selection.
    await expect(newlyActive).toHaveAttribute("data-tab-active", "true");

    // ── Clicking the active tab's entry in the chevron (it's now out of
    // view) scrolls it back without re-selecting anything else.
    await overflowBtn.click();
    await page
      .locator(`[data-testid="session-tabs-overflow-item"][data-tab-id="${firstHidden}"]`)
      .click();
    await expect(newlyActive).toHaveAttribute("data-tab-hidden", "false", { timeout: 5_000 });
  });
});
