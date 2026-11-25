import { test, expect, type Page } from "../helpers/test";

/**
 * Coverage for IntelliJ-style "Tab placement" of the session tab strip.
 *
 *   1. Default is "top": a horizontal bar inside the chat column.
 *   2. Right-click the strip → "Tab placement" → Left docks it as a vertical
 *      column to the left of the chat (tabs stack top-to-bottom).
 *   3. The choice survives a reload (per-browser localStorage).
 *   4. Settings → Tab placement → Right docks it on the right of the chat.
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

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, `${selector} must have a bounding box`).toBeTruthy();
  return b!;
}

test.describe("Session tabs — placement (top / left / right)", () => {
  test("switches between top, left and right and persists the choice", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);

    await page.request.put(`${baseURL}/api/sessions/open-tabs`, {
      data: { tabs: [], activeId: null, pinned: [] },
    });
    await page.setViewportSize({ width: 1400, height: 800 });

    await page.goto("/");
    const idA = await waitForBoundSession(page);
    await page.locator('button[title="New session tab"]').click();
    const idB = await waitForBoundSession(page, { not: idA });

    const strip = page.getByTestId("session-tabs");
    const chat = '[data-pane-name="chat-area"]';

    // ── 1. Default: top, inside the chat column.
    await expect(strip).toHaveAttribute("data-tab-placement", "top");
    await expect(page.locator(`${chat} [data-testid="session-tabs"]`)).toHaveCount(1);

    // ── 2. Right-click a tab → Tab placement → Left.
    await page.locator(`[data-testid="session-tab"][data-tab-id="${idA}"]`).click({
      button: "right",
    });
    const menu = page.getByTestId("session-tabs-context-menu");
    await expect(menu).toBeVisible();
    await menu
      .locator('[data-testid="session-tabs-placement-option"][data-placement="left"]')
      .click();
    await expect(menu).toHaveCount(0);

    await expect(strip).toHaveAttribute("data-tab-placement", "left");
    // Now a sibling of the chat column, not inside it…
    await expect(page.locator(`${chat} [data-testid="session-tabs"]`)).toHaveCount(0);
    // …docked on its left, as a tall column.
    {
      const s = await box(page, '[data-testid="session-tabs"]');
      const c = await box(page, chat);
      expect(s.x + s.width).toBeLessThanOrEqual(c.x + 1);
      expect(s.height).toBeGreaterThan(300);
    }
    // Tabs stack vertically: same x, B below A.
    {
      const a = await box(page, `[data-testid="session-tab"][data-tab-id="${idA}"]`);
      const b = await box(page, `[data-testid="session-tab"][data-tab-id="${idB}"]`);
      expect(Math.abs(a.x - b.x)).toBeLessThan(2);
      expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
    }

    // ── 3. Persists across a reload.
    await page.reload();
    await waitForBoundSession(page);
    await expect(page.getByTestId("session-tabs")).toHaveAttribute("data-tab-placement", "left", {
      timeout: 10_000,
    });

    // ── 4. Settings → Tab placement → Right.
    await page.goto("/settings");
    const right = page.locator('[data-testid="tab-placement-option"][data-placement="right"]');
    await right.click();
    await expect(right).toHaveAttribute("aria-checked", "true");

    await page.goto("/");
    await waitForBoundSession(page);
    await expect(page.getByTestId("session-tabs")).toHaveAttribute(
      "data-tab-placement",
      "right",
      { timeout: 10_000 },
    );
    {
      const s = await box(page, '[data-testid="session-tabs"]');
      const c = await box(page, chat);
      expect(s.x).toBeGreaterThanOrEqual(c.x + c.width - 1);
    }

    // ── Back to top via the empty part of the strip's context menu.
    await page.getByTestId("session-tabs").click({ button: "right", position: { x: 20, y: 300 } });
    await page
      .locator('[data-testid="session-tabs-placement-option"][data-placement="top"]')
      .click();
    await expect(page.getByTestId("session-tabs")).toHaveAttribute("data-tab-placement", "top");
    await expect(page.locator(`${chat} [data-testid="session-tabs"]`)).toHaveCount(1);
  });
});
