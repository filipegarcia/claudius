import { test, expect, type Page } from "../helpers/test";

/**
 * Regression coverage for the "+" new-session button position.
 *
 * The button used to be pinned to the far-right end of the tab bar, with
 * a wide gap between the last tab and the button. The expected layout is
 * the opposite — the "+" sits flush against the right edge of the last
 * (visible) tab, and the empty space stretches between the "+" and the
 * trailing chevron / close-all controls.
 *
 *   [tab1][tab2][tab3][+]  ────empty──── [chevron?] [x]
 *
 * Two scenarios:
 *   1. No overflow (few tabs, wide viewport) — "+" hugs the last tab and
 *      sits well to the LEFT of the close-all "[x]" button.
 *   2. Overflow (many tabs, narrow viewport) — "+" hugs the last *visible*
 *      tab and still sits to the LEFT of the chevron + close-all controls,
 *      i.e. it remains INSIDE the tab strip, not pushed to the bar's end.
 */

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
  const id = page.url().match(SESSION_RE)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return id!;
}

/** Rightmost visible tab in the strip (data-tab-hidden="false"). */
async function lastVisibleTabBox(page: Page) {
  const visible = page.locator('[data-testid="session-tab"][data-tab-hidden="false"]');
  const count = await visible.count();
  expect(count, "at least one visible tab is required for this assertion").toBeGreaterThan(0);
  // The visible tabs render in document order, so the last in DOM is the
  // rightmost on screen.
  const box = await visible.nth(count - 1).boundingBox();
  expect(box, "last visible tab must have a bounding box").toBeTruthy();
  return box!;
}

test.describe("Session tabs — '+' button sits flush to the right of the last tab", () => {
  test("no overflow: '+' hugs the last tab, NOT pinned to the bar's far right", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    // Reset persisted tab strip so leftover tabs from prior runs don't
    // leak into the layout we're measuring.
    await page.request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: { tabs: [], activeId: null },
    });

    // Wide viewport so the handful of tabs we open never overflow.
    await page.setViewportSize({ width: 1600, height: 800 });

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    const newTabBtn = page.locator('button[title="New session tab"]');
    // Open two extra tabs so we have three total — comfortable for the
    // 1600px viewport, far from triggering overflow.
    let last = idA;
    for (let i = 0; i < 2; i++) {
      await newTabBtn.click();
      last = await waitForBoundSession(page, { not: last });
    }
    const visibleCount = await page
      .locator('[data-testid="session-tab"][data-tab-hidden="false"]')
      .count();
    expect(visibleCount).toBe(3);

    // No chevron expected at this viewport width.
    await expect(page.getByTestId("session-tabs-overflow")).toHaveCount(0);

    const lastTab = await lastVisibleTabBox(page);
    const plusBox = await newTabBtn.boundingBox();
    expect(plusBox).toBeTruthy();
    const closeAllBox = await page
      .locator('button[title="Close all tabs"]')
      .boundingBox();
    expect(closeAllBox).toBeTruthy();

    // ── Assertion 1: "+" hugs the right edge of the last tab.
    // The new layout places the button as the strip's last child, so its
    // left edge should be within a couple of pixels of the last tab's
    // right edge (gap-px on the strip adds 1px between siblings).
    const gap = plusBox!.x - (lastTab.x + lastTab.width);
    expect(gap, `expected '+' to sit flush after the last tab — gap was ${gap}px`).toBeLessThan(8);
    expect(gap, "gap must be non-negative (button is AFTER the tab)").toBeGreaterThanOrEqual(-1);

    // ── Assertion 2: "+" is NOT at the bar's far right.
    // There must be substantial empty space between the "+" right edge
    // and the close-all "[x]" left edge.
    const trailingSpace = closeAllBox!.x - (plusBox!.x + plusBox!.width);
    expect(
      trailingSpace,
      `expected empty space between '+' and '[x]' — was ${trailingSpace}px`,
    ).toBeGreaterThan(200);
  });

  test("overflow: '+' hugs the last VISIBLE tab and still sits inside the strip", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);

    await page.request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: { tabs: [], activeId: null },
    });

    // Narrow viewport mirrors the overflow spec so ~6 tabs are enough to
    // push some into the chevron menu.
    await page.setViewportSize({ width: 700, height: 800 });

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    const newTabBtn = page.locator('button[title="New session tab"]');
    let last = idA;
    for (let i = 0; i < 6; i++) {
      await newTabBtn.click();
      last = await waitForBoundSession(page, { not: last });
    }

    // Wait for overflow to settle.
    const overflowBtn = page.getByTestId("session-tabs-overflow");
    await expect(overflowBtn).toBeVisible({ timeout: 5_000 });

    const hiddenCount = await page
      .locator('[data-testid="session-tab"][data-tab-hidden="true"]')
      .count();
    expect(hiddenCount, "test only makes sense when something overflowed").toBeGreaterThan(0);

    const lastTab = await lastVisibleTabBox(page);
    const plusBox = await newTabBtn.boundingBox();
    const chevronBox = await overflowBtn.boundingBox();
    const closeAllBox = await page
      .locator('button[title="Close all tabs"]')
      .boundingBox();
    expect(plusBox && chevronBox && closeAllBox).toBeTruthy();

    // ── "+" hugs the right edge of the last visible tab.
    const gap = plusBox!.x - (lastTab.x + lastTab.width);
    expect(
      gap,
      `expected '+' to sit flush after the last visible tab — gap was ${gap}px`,
    ).toBeLessThan(8);
    expect(gap).toBeGreaterThanOrEqual(-1);

    // ── "+" stays to the LEFT of the chevron and the close-all button.
    expect(plusBox!.x + plusBox!.width).toBeLessThanOrEqual(chevronBox!.x + 1);
    expect(plusBox!.x + plusBox!.width).toBeLessThan(closeAllBox!.x);
  });
});
