import { test, expect } from "@playwright/test";

/**
 * Regression: opening /community should land the view at the bottom of
 * the message list — the most recent message visible, no further scroll
 * available downward. Bug shape: the replay-frame messages render but
 * the container stays scrolled to the top.
 *
 * We assert against scrollTop / scrollHeight directly. Tolerance is a
 * couple of pixels since the message rows have margins.
 */

const SERVER_URL = process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "";

async function distanceFromBottom(page: import("@playwright/test").Page): Promise<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distance: number;
}> {
  const messageList = page.getByTestId("community-message-list");
  await messageList.waitFor({ state: "visible" });
  return messageList.evaluate((el) => {
    const d = el as HTMLDivElement;
    return {
      scrollTop: d.scrollTop,
      scrollHeight: d.scrollHeight,
      clientHeight: d.clientHeight,
      distance: d.scrollHeight - d.clientHeight - d.scrollTop,
    };
  });
}

test("community message list lands at the bottom on open", async ({
  browser,
}) => {
  test.skip(!SERVER_URL, "needs NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL set");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("claudius.community.nick", "scroll-tester");
    } catch {}
  });

  await page.goto("/community");
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({
    timeout: 5_000,
  });
  await page.waitForTimeout(800);

  const before = await distanceFromBottom(page);
  const overflowsViewport = before.scrollHeight > before.clientHeight + 5;
  if (!overflowsViewport) {
    test.skip(true, "history fits in viewport; scroll assertion is N/A");
  }
  console.log(`[scroll/open] ${JSON.stringify(before)}`);
  expect(before.distance).toBeLessThan(10);

  await ctx.close();
});

test("community message list stays at the bottom across repeated nav cycles", async ({
  browser,
}) => {
  test.skip(!SERVER_URL, "needs NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL set");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.text().startsWith("[ML]")) console.log(msg.text());
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("claudius.community.nick", "scroll-tester");
    } catch {}
  });

  await page.goto("/community");
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({
    timeout: 5_000,
  });
  await page.waitForTimeout(800);

  for (let cycle = 1; cycle <= 3; cycle++) {
    await page.getByRole("link", { name: /^Chat$/ }).first().click();
    await expect(page).toHaveURL(/\/$|\/\?/);
    await page.waitForTimeout(600);

    await page
      .locator('[data-pane-name="workspace-switcher"] a[href="/community"]')
      .click();
    await expect(page).toHaveURL(/\/community/);
    await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "general" })).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(1200);

    const snap = await distanceFromBottom(page);
    console.log(`[scroll/cycle ${cycle}] ${JSON.stringify(snap)}`);
    const overflows = snap.scrollHeight > snap.clientHeight + 5;
    if (overflows) {
      expect(snap.distance, `cycle ${cycle} not at bottom`).toBeLessThan(10);
    }
  }

  await ctx.close();
});

test("community message list lands at the bottom on soft-nav back", async ({
  browser,
}) => {
  test.skip(!SERVER_URL, "needs NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL set");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("claudius.community.nick", "scroll-tester");
    } catch {}
  });

  // First visit so the replay frame populates.
  await page.goto("/community");
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({
    timeout: 5_000,
  });
  await page.waitForTimeout(800);

  // Leave to /chat.
  await page.getByRole("link", { name: /^Chat$/ }).first().click();
  await expect(page).toHaveURL(/\/$|\/\?/);
  await page.waitForTimeout(1000);

  // Come back to /community via the workspace-rail Community tile.
  await page
    .locator('[data-pane-name="workspace-switcher"] a[href="/community"]')
    .click();
  await expect(page).toHaveURL(/\/community/);
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({
    timeout: 5_000,
  });
  await page.waitForTimeout(1200);

  const after = await distanceFromBottom(page);
  console.log(`[scroll/nav-back] ${JSON.stringify(after)}`);
  const overflowsViewport = after.scrollHeight > after.clientHeight + 5;
  if (!overflowsViewport) {
    test.skip(true, "history fits in viewport; scroll assertion is N/A");
  }
  expect(after.distance).toBeLessThan(10);

  await ctx.close();
});
