import { test, expect } from "@playwright/test";

/**
 * Same regression as community-nav.spec.ts, but against the *real*
 * chat-server (must be running at NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL).
 * The mocked version passes, so this one checks whether the bug is
 * specific to the real-network code path (CORS, real SSE handshake,
 * timing) that page.route + FakeES smooth over.
 */
test("real chat-server — soft-nav back to /community", async ({ page }) => {
  test.skip(
    !process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL,
    "needs NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL set",
  );

  await page.addInitScript(() => {
    try {
      localStorage.setItem("claudius.community.nick", "tester");
    } catch {}
  });

  await page.goto("/community");
  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  // Real chat-server has at least "general" / "bugs" / "ideas" rooms.
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({ timeout: 5_000 });

  // Leave via the side-nav Chat link.
  await page.getByRole("link", { name: /^Chat$/ }).first().click();
  await expect(page).toHaveURL(/\/$|\/\?/);

  // Come back via the Community tile.
  await page.locator('[data-pane-name="workspace-switcher"] a[href="/community"]').click();
  await expect(page).toHaveURL(/\/community/);

  await expect(page.getByTestId("community-page")).toBeVisible({ timeout: 10_000 });
  // The bug claim: rooms list stays empty after this nav. Assert otherwise.
  await expect(page.getByRole("button", { name: "general" })).toBeVisible({ timeout: 5_000 });
});
