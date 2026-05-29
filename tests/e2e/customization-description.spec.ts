import { test, expect } from "../helpers/test";

/**
 * End-to-end UI test for the manual-edit path on the Feature description
 * section of /customize/[id]:
 *
 *   1. Open the /customize listing.
 *   2. Click "New customization" — capture the id from the POST response so
 *      we don't have to wait for the [id] route's cold-compile redirect.
 *   3. Wait for the redirect to /customize/[id].
 *   4. Click "Write your own" to enter edit mode.
 *   5. Type a description, hit Save.
 *   6. Verify the text renders, the "Manual" pill appears, and the meta line
 *      reads "Edited …" (not "Generated …").
 *   7. Round-trip the GET endpoint to confirm `descriptionIsManual=true` and
 *      `stale=false` (manual text never goes stale on its own).
 *   8. Cleanup via HTTP DELETE so the user's machine state is unchanged.
 *
 * Skips the LLM-driven Generate path — that needs an API key. The manual
 * lifecycle is what this test exercises end-to-end through the UI.
 */
const CUST_ID_RE = /\/customize\/(cust_[0-9a-f]+)/;

test.describe("Customization description — manual edit (headed UI flow)", () => {
  test("Write your own → Save → Manual pill + stale=false", async ({ page, request, baseURL }) => {
    // Bootstrap copies the live source mirror (~324 files on this repo), then
    // the [id] route cold-compiles in `next dev` and the page renders the
    // description section + a 5s poll. On CI's slower runners the
    // bootstrap-plus-compile reliably crosses 2 minutes, *and* the page
    // auto-fetches a `/diff` whose computeDiff() can chew 60-70s of single-
    // threaded dev-server time, queueing every other request behind it. So
    // this spec gets an unusually large budget. The right long-term fix is
    // running e2e against `next build && next start` in CI — dev-mode
    // compile + serialized request handling dominate — but that's a wider
    // change than this test owns.
    test.setTimeout(600_000);

    let id = "";

    try {
      // The /customize page auto-opens a first-visit help overlay when
      // localStorage doesn't carry the "seen" flag. Fresh Playwright contexts
      // always trip that, and the overlay then eats clicks. Pre-set the flag
      // so the overlay stays closed.
      await page.addInitScript(() => {
        window.localStorage.setItem("claudius.customize.help-seen", "1");
      });

      // Stub the heavy diff / sync / publishes fetches that PublishRevertPanel
      // and SyncFromBasePanel fire on mount. computeDiff() and
      // computeSyncStatus() each hash ~324 source files; on slow CI runners
      // we've observed them at 4+ minutes of single-threaded application
      // time, and Next dev serializes route handlers — every subsequent
      // request (including the Save-click PATCH this test waits on) queues
      // behind them. None of these endpoints are exercised by the manual
      // description-edit flow, so we short-circuit them with deterministic
      // empty payloads to keep the dev server's request loop free.
      await page.route(/\/api\/customizations\/cust_[0-9a-f]+\/diff$/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            changedFiles: 0,
            addedFiles: 0,
            identicalFiles: 0,
            files: [],
          }),
        }),
      );
      await page.route(/\/api\/customizations\/cust_[0-9a-f]+\/publishes$/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ publishes: [] }),
        }),
      );
      await page.route(/\/api\/customizations\/cust_[0-9a-f]+\/sync$/, (route) => {
        // Only stub the on-mount GET; let any explicit POST (sync apply) fall
        // through if the test ever decides to exercise it.
        if (route.request().method() !== "GET") {
          return route.fallback();
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            manifestCreatedAt: Date.now(),
            totals: {
              "in-sync": 0,
              "upstream-only": 0,
              "user-only": 0,
              conflict: 0,
              "new-upstream": 0,
              "new-user": 0,
              "deleted-upstream": 0,
              "deleted-user": 0,
            },
            entries: [],
          }),
        });
      });

      // 1. Open the customize listing and create a new customization.
      await page.goto("/customize");

      // 2. Click + wait for the POST response in parallel — this gives us
      // the new id without depending on the redirect (which has to compile
      // /customize/[id] on first hit in dev, the slow part on cold CI).
      const [createRes] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().endsWith("/api/customizations") &&
            r.request().method() === "POST",
          { timeout: 240_000 },
        ),
        page.getByRole("button", { name: /New customization/i }).click(),
      ]);
      expect(createRes.ok()).toBeTruthy();
      const created = (await createRes.json()) as { customization: { id: string } };
      id = created.customization.id;
      expect(id).toMatch(/^cust_[0-9a-f]+$/);

      // 3. Wait for the redirect to land on /customize/[id]. The compile
      // happens here; allow the rest of the test budget to flow through.
      await page.waitForURL(CUST_ID_RE, { timeout: 180_000 });
      expect(page.url()).toContain(`/customize/${id}`);

      // 4. The Feature description section renders empty-state with two
      // buttons. Click "Write your own" to enter edit mode.
      const section = page.locator("section", { hasText: "Feature description" });
      await expect(section).toBeVisible({ timeout: 15_000 });
      await section.getByRole("button", { name: /Write your own/i }).click();

      // 5. Textarea is auto-focused; type a description and save.
      const textarea = section.getByPlaceholder(/Describe what this customization does/i);
      await expect(textarea).toBeVisible();
      await expect(textarea).toBeFocused();

      const description =
        "Adds a Konami-code easter egg: ↑↑↓↓←→←→BA triggers a confetti shower " +
        "and an 8-bit \"★ CHEAT ACTIVATED ★\" banner.";
      await textarea.fill(description);

      // Click Save and wait for the PATCH to complete. On CI's overloaded
      // dev server the PATCH can sit behind the auto-mounted PublishRevertPanel's
      // /diff request — observed at 67s of single-threaded compute on a slow
      // runner — so the round-trip from click to response easily crosses
      // 60-90s. Waiting on the response surfaces a 4xx/5xx directly and
      // gates the assertions on a real, completed save. The 240s budget is
      // intentional headroom over the worst observed runner.
      const [patchRes] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().endsWith(`/api/customizations/${id}/description`) &&
            r.request().method() === "PATCH",
          { timeout: 240_000 },
        ),
        section.getByRole("button", { name: /^Save$/ }).click(),
      ]);
      expect(patchRes.ok()).toBeTruthy();

      // 6. Description prose now visible + "Manual" pill + "Edited …" prefix.
      //    Anchor on the rendered <p> (not just any descendant text) so the
      //    assertion can't be satisfied by a still-mounted textarea echoing
      //    its filled value while the save round-trip is in flight.
      await expect(section.locator("p", { hasText: description })).toBeVisible({ timeout: 10_000 });
      await expect(section.getByText("Manual", { exact: true })).toBeVisible();
      await expect(section.getByText(/Edited \d+s? ago/)).toBeVisible();

      // No "Generated" label and no stale chip on a fresh manual save.
      await expect(section.getByText(/Generated \d+s? ago/)).toHaveCount(0);
      await expect(section.getByText(/May be out of date/)).toHaveCount(0);

      // 7. Round-trip the API to confirm the persisted shape matches the UI.
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
      // 8. Best-effort cleanup. DELETE tears down the workspace, stops any
      // running preview, and removes the on-disk mirror.
      if (id) {
        await request.delete(`${baseURL}/api/customizations/${id}`).catch(() => {});
      }
    }
  });
});
