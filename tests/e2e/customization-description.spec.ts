import { test, expect } from "@playwright/test";

/**
 * End-to-end UI test for the manual-edit path on the Feature description
 * section of /customize/[id]:
 *
 *   1. Bootstrap a fresh customization from the /customize listing.
 *   2. Land on the detail page and click "Write your own" to enter edit mode.
 *   3. Type a description, hit Save.
 *   4. Verify the text renders, the "Manual" pill appears, and the meta line
 *      reads "Edited …" (not "Generated …").
 *   5. Round-trip the GET endpoint to confirm `descriptionIsManual=true` and
 *      `stale=false` (manual text never goes stale on its own).
 *   6. Cleanup via HTTP DELETE so the user's machine state is unchanged.
 *
 * Skips the LLM-driven Generate path — that needs an API key. The manual
 * lifecycle is what this test exercises end-to-end through the UI.
 */
const CUST_ID_RE = /\/customize\/(cust_[0-9a-f]+)/;

test.describe("Customization description — manual edit (headed UI flow)", () => {
  test("Write your own → Save → Manual pill + stale=false", async ({ page, request, baseURL }) => {
    // Bootstrap copies the live source mirror (~324 files on this repo) and
    // then the page renders the description section + a 5s poll — so be
    // generous on the timeout.
    test.setTimeout(90_000);

    let id = "";

    try {
      // The /customize page auto-opens a first-visit help overlay when
      // localStorage doesn't carry the "seen" flag. Fresh Playwright contexts
      // always trip that, and the overlay then eats clicks. Pre-set the flag
      // so the overlay stays closed.
      await page.addInitScript(() => {
        window.localStorage.setItem("claudius.customize.help-seen", "1");
      });

      // 1. Open the customize listing and create a new customization.
      await page.goto("/customize");
      await page.getByRole("button", { name: /New customization/i }).click();

      // 2. Wait for the bootstrap + redirect to /customize/[id].
      await page.waitForURL(CUST_ID_RE, { timeout: 60_000 });
      id = page.url().match(CUST_ID_RE)![1];

      // 3. The Feature description section renders empty-state with two
      // buttons. Click "Write your own" to enter edit mode.
      const section = page.locator("section", { hasText: "Feature description" });
      await expect(section).toBeVisible({ timeout: 15_000 });
      await section.getByRole("button", { name: /Write your own/i }).click();

      // 4. Textarea is auto-focused; type a description and save.
      const textarea = section.getByPlaceholder(/Describe what this customization does/i);
      await expect(textarea).toBeVisible();
      await expect(textarea).toBeFocused();

      const description =
        "Adds a Konami-code easter egg: ↑↑↓↓←→←→BA triggers a confetti shower " +
        "and an 8-bit \"★ CHEAT ACTIVATED ★\" banner.";
      await textarea.fill(description);

      await section.getByRole("button", { name: /^Save$/ }).click();

      // 5. Description prose now visible + "Manual" pill + "Edited …" prefix.
      await expect(section.getByText(description)).toBeVisible({ timeout: 10_000 });
      await expect(section.getByText("Manual", { exact: true })).toBeVisible();
      await expect(section.getByText(/Edited \d+s? ago/)).toBeVisible();

      // No "Generated" label and no stale chip on a fresh manual save.
      await expect(section.getByText(/Generated \d+s? ago/)).toHaveCount(0);
      await expect(section.getByText(/May be out of date/)).toHaveCount(0);

      // 6. Round-trip the API to confirm the persisted shape matches the UI.
      const res = await request.get(`${baseURL}/api/customizations/${id}/description`);
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as {
        description: string | null;
        descriptionIsManual: boolean;
        descriptionDiffHash: string | null;
        stale: boolean;
      };
      expect(body.description).toBe(description);
      expect(body.descriptionIsManual).toBe(true);
      expect(body.descriptionDiffHash).toBeNull();
      expect(body.stale).toBe(false);
    } finally {
      // Best-effort cleanup. DELETE tears down the workspace, stops any
      // running preview, and removes the on-disk mirror.
      if (id) {
        await request.delete(`${baseURL}/api/customizations/${id}`).catch(() => {});
      }
    }
  });
});
