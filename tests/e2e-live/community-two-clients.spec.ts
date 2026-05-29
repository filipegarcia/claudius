import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Two-client integration test against the real chat-server. One window
 * acts as the "user under test" (Alice) and navigates around; the other
 * (Bob) stays on /community and posts messages that should appear in
 * Alice's view when she returns.
 *
 * Scenarios this covers that the single-window test does not:
 *   1. State survives a soft-nav round trip (rooms list, WiFi indicator).
 *   2. Replay frame on reconnect catches up to messages posted while
 *      Alice was on another page.
 *   3. Live SSE in the second window is unaffected by the first window's
 *      navigation.
 *
 * Pre-reqs: chat-server must be running at
 * NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL (typically http://localhost:8787 in
 * dev). The test creates fresh browser contexts so localStorage state
 * doesn't leak between runs.
 */

const SERVER_URL = process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "";

async function landOnCommunity(ctx: BrowserContext, nick: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript((n) => {
    try {
      localStorage.setItem("claudius.community.nick", n);
    } catch {}
  }, nick);
  await page.goto("/community");
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  // Wait for the rooms list to populate so we know the SSE handshake landed.
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({
    timeout: 5_000,
  });
  return page;
}

async function sendMessage(page: Page, body: string): Promise<void> {
  const composer = page.getByTestId("community-composer");
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
  // Wait for our own echo to appear in the message list (live SSE).
  await expect(page.getByText(body, { exact: true })).toBeVisible({ timeout: 5_000 });
}

test.describe("/community with two clients", () => {
  test.skip(
    !SERVER_URL,
    "needs NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL set + chat-server running",
  );

  test("Alice navigates away and back; sees Bob's intervening messages", async ({
    browser,
  }) => {
    // Two isolated contexts = two browsers' worth of state.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const alice = await landOnCommunity(ctxA, `alice-${Date.now() % 100_000}`);
      const bob = await landOnCommunity(ctxB, `bob-${Date.now() % 100_000}`);

      // Sanity: both connected, both see #general button.
      await expect(alice.getByRole("button", { name: "general" })).toBeVisible();
      await expect(bob.getByRole("button", { name: "general" })).toBeVisible();

      // Bob sends; Alice should see live.
      const greeting = `hi-from-bob-${Date.now()}`;
      await sendMessage(bob, greeting);
      await expect(alice.getByText(greeting, { exact: true })).toBeVisible({
        timeout: 5_000,
      });

      // Alice navigates to /chat via the side-nav. Bob keeps posting.
      await alice.getByRole("link", { name: /^Chat$/ }).first().click();
      await expect(alice).toHaveURL(/\/$|\/\?/);

      const whileAway = `while-alice-away-${Date.now()}`;
      await sendMessage(bob, whileAway);

      // Alice clicks back to /community via the workspace-rail tile.
      // This is the failing case the user reports: rooms empty, WiFi-off.
      await alice.locator('[data-pane-name="workspace-switcher"] a[href="/community"]').click();
      await expect(alice).toHaveURL(/\/community/);
      await expect(alice.getByTestId("community-page")).toBeVisible({
        timeout: 10_000,
      });

      // Rooms list should repopulate within a few seconds.
      await expect(alice.getByRole("button", { name: "general" })).toBeVisible({
        timeout: 10_000,
      });

      // The reconnect-replay should include Bob's "while away" message.
      await expect(alice.getByText(whileAway, { exact: true })).toBeVisible({
        timeout: 10_000,
      });

      // And live SSE should be working again: Bob posts a third message,
      // Alice sees it without a second nav.
      const afterReturn = `after-alice-back-${Date.now()}`;
      await sendMessage(bob, afterReturn);
      await expect(alice.getByText(afterReturn, { exact: true })).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
