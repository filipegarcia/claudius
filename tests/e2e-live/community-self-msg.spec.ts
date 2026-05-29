import { test, expect } from "@playwright/test";

/**
 * Regression: a user's own message must not badge them as unread. The
 * bug shape: send a message while viewing /community → leave to /chat →
 * navigate back → the per-room unread pill shows 1 because the provider
 * subscribed to the room after leaving, the replay frame included the
 * user's own message, and the SSE handler had no way to recognize the
 * echo as self.
 *
 * Uses the real chat-server so the round-trip exercises the actual
 * replay frame path.
 */

const SERVER_URL = process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "";

test("own message does not increment unread badge after nav-away/back", async ({
  browser,
}) => {
  test.skip(!SERVER_URL, "needs NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL set");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const nick = `self-${Date.now() % 100_000}`;
  await page.addInitScript(({ n }) => {
    try {
      localStorage.setItem("claudius.community.nick", n);
      // Notifications must be enabled — that's what wires the provider's
      // per-room SSE fanout, which is the surface that exhibits the bug.
      localStorage.setItem("claudius.community.notifications.enabled", "1");
    } catch {}
  }, { n: nick });

  await page.goto("/community");
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({
    timeout: 5_000,
  });

  // Send a unique message.
  const body = `self-${Date.now()}`;
  const composer = page.getByTestId("community-composer");
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
  await expect(page.getByText(body, { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // Leave to /chat — provider's SSE for #general will (re)open with the
  // user not viewing the room.
  await page.getByRole("link", { name: /^Chat$/ }).first().click();
  await expect(page).toHaveURL(/\/$|\/\?/);
  // Give the provider's SSE replay frame time to land.
  await page.waitForTimeout(1500);

  // Total community badge in the workspace rail must be 0 — our own
  // message should not have badged us.
  const badge = page.getByTestId("community-notification-badge");
  await expect(badge).toHaveCount(0);

  // Sanity: nav back and the per-room unread pill should also be absent
  // for #general.
  await page
    .locator('[data-pane-name="workspace-switcher"] a[href="/community"]')
    .click();
  await expect(page).toHaveURL(/\/community/);
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("community-room-unread-general")).toHaveCount(0);

  await ctx.close();
});
