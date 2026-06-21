import { test, expect, type Page } from "../helpers/test";

/**
 * Coverage for pinning conversation tabs.
 *
 * Pinning a tab:
 *   1. sorts it to the FRONT of the strip (Chrome / IntelliJ behaviour),
 *   2. persists across a reload (stored in the per-cwd `ui_state` table), and
 *   3. protects the tab from "Close all tabs".
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

/** Session ids of the visible tabs, in left-to-right (document) order. */
async function visibleTabIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="session-tab"][data-tab-hidden="false"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-id") ?? ""));
}

test.describe("Session tabs — pinning", () => {
  test("pin moves a tab to the front, persists across reload, and survives close-all", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);

    // Reset persisted strip so leftovers from prior runs don't interfere.
    await page.request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: { tabs: [], activeId: null, pinned: [] },
    });

    // Wide viewport so our handful of tabs never overflow into the chevron.
    await page.setViewportSize({ width: 1600, height: 800 });

    await page.goto("/");
    const idA = await waitForBoundSession(page);

    const newTabBtn = page.locator('button[title="New session tab"]');
    let last = idA;
    for (let i = 0; i < 2; i++) {
      await newTabBtn.click();
      last = await waitForBoundSession(page, { not: last });
    }
    const idC = last; // the rightmost tab
    const before = await visibleTabIds(page);
    expect(before).toHaveLength(3);
    expect(before[before.length - 1]).toBe(idC);

    // ── Pin the last tab. Its pin button lives inside its tab container.
    const lastTab = page.locator(`[data-testid="session-tab"][data-tab-id="${idC}"]`);
    await lastTab.hover();
    await lastTab.getByTestId("session-tab-pin").click();

    // It jumps to the front and reports pinned.
    await expect
      .poll(async () => (await visibleTabIds(page))[0])
      .toBe(idC);
    await expect(
      lastTab.locator('[data-testid="session-tab-pin"][data-tab-pinned="true"]'),
    ).toHaveCount(1);

    // ── Persistence: a full reload restores the pinned-first order.
    // The persist effect fires asynchronously after paint (useEffect), so wait
    // until the server has confirmed the pin before triggering the reload.
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`${baseURL}/api/sessions/open-tabs`);
          const body = (await r.json()) as { pinned?: string[] };
          return body.pinned?.includes(idC) ?? false;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await page.reload();
    await waitForBoundSession(page);
    await expect
      .poll(async () => (await visibleTabIds(page))[0], { timeout: 10_000 })
      .toBe(idC);
    await expect(
      page.locator(
        `[data-testid="session-tab"][data-tab-id="${idC}"] [data-testid="session-tab-pin"][data-tab-pinned="true"]`,
      ),
    ).toHaveCount(1);

    // ── Close-all keeps the pinned tab. Accept the confirm() dialog.
    page.once("dialog", (d) => void d.accept());
    await page.locator('button[title="Close all tabs"]').click();

    await expect
      .poll(async () => visibleTabIds(page).then((ids) => ids.length), { timeout: 10_000 })
      .toBe(1);
    expect((await visibleTabIds(page))[0]).toBe(idC);
  });
});
