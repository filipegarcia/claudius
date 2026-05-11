import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Regression: the unread badge must not double on each nav cycle. The
 * bug shape:
 *   Bob posts 2 messages in #bugs. Alice (on /community, viewing
 *   #general, notifications on) sees the #bugs unread pill at 2. She
 *   navigates to /chat → the provider re-opens its #bugs SSE → the
 *   replay frame redelivers the same 2 messages → handleNewMessage
 *   re-counts them → unread is now 4. Each /chat ↔ /community round
 *   trip doubles the count.
 *
 * The fix advances the watermark when a message is badged, so a
 * subsequent replay treats those messages as "already seen."
 */

const SERVER_URL = process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "";

async function landOnCommunity(
  ctx: BrowserContext,
  opts: { nick: string; notificationsOn?: boolean },
): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript(
    ({ n, on }) => {
      try {
        localStorage.setItem("claudius.community.nick", n);
        if (on) {
          localStorage.setItem("claudius.community.notifications.enabled", "1");
        }
      } catch {}
    },
    { n: opts.nick, on: !!opts.notificationsOn },
  );
  await page.goto("/community");
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({
    timeout: 5_000,
  });
  return page;
}

async function send(page: Page, body: string): Promise<void> {
  const composer = page.getByTestId("community-composer");
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
  await expect(page.getByText(body, { exact: true })).toBeVisible({ timeout: 5_000 });
}

async function unreadBadge(page: Page): Promise<number> {
  const badge = page.getByTestId("community-notification-badge");
  const count = await badge.count();
  if (count === 0) return 0;
  const txt = (await badge.first().textContent())?.trim() ?? "0";
  return Number(txt) || 0;
}

test("unread count doesn't double across /chat ↔ /community cycles", async ({
  browser,
}) => {
  test.skip(!SERVER_URL, "needs NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL set");

  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  try {
    // Alice has notifications enabled (the fanout-on-reopen surface).
    const alice = await landOnCommunity(aliceCtx, {
      nick: `alice-${Date.now() % 100_000}`,
      notificationsOn: true,
    });
    const bob = await landOnCommunity(bobCtx, {
      nick: `bob-${Date.now() % 100_000}`,
    });

    // Bob switches to #bugs (a room Alice isn't viewing) and posts twice.
    await bob.getByRole("button", { name: "bugs" }).click();
    await send(bob, `bugs-msg-A-${Date.now()}`);
    await send(bob, `bugs-msg-B-${Date.now()}`);

    // Wait for the badges to settle on Alice's side. We don't assert the
    // initial value tightly — the chat-server has history from prior
    // tests, so the pill may show more than 2. We just record the
    // baseline and assert it doesn't grow on subsequent nav cycles.
    await alice.waitForTimeout(1200);
    const baseline = await unreadBadge(alice);
    expect(baseline).toBeGreaterThan(0);

    // Cycle 1: /chat → /community.
    for (let i = 1; i <= 3; i++) {
      await alice.getByRole("link", { name: /^Chat$/ }).first().click();
      await expect(alice).toHaveURL(/\/$|\/\?/);
      await alice.waitForTimeout(800);

      await alice
        .locator('[data-pane-name="workspace-switcher"] a[href="/community"]')
        .click();
      await expect(alice).toHaveURL(/\/community/);
      await expect(alice.getByTestId("community-page")).toBeVisible({
        timeout: 10_000,
      });
      await alice.waitForTimeout(1200);

      const after = await unreadBadge(alice);
      console.log(`[cycle ${i}] baseline=${baseline} after=${after}`);
      // Allow a tiny drift (e.g. a stray live message from another test)
      // but a real doubling would push it well past baseline + 2.
      expect(after, `cycle ${i} unread shouldn't grow vs baseline`).toBeLessThanOrEqual(
        baseline + 2,
      );
    }
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});
