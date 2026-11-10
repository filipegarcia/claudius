import { test, expect } from "../helpers/test";
import { activateClaudiusWorkspace } from "./helpers/workspace";

/**
 * "What's new" window + /release-notes history.
 *
 * The real `public/release-notes.json` is generated from this checkout's git
 * tags (scripts/release-notes.mjs), so it varies per machine — the spec swaps
 * in a fixed fixture. Versions are tiny (v0.0.1.x) so they always sit at or
 * below the running build's version and count as "already released".
 *
 * The auto-open-after-update path is production-only (the e2e server is
 * `next dev`); its decision logic is covered in tests/unit/release-notes.test.ts.
 */
const FIXTURE = {
  version: 1,
  head: null,
  releases: [
    {
      tag: "v0.0.1.3",
      previous: "v0.0.1.2",
      date: "2026-11-10T07:43:41Z",
      commits: [
        { sha: "c3000001", subject: "feat(chat): show the rename shortcut on hover" },
        { sha: "c3000002", subject: "fix(release): pin Linux jobs" },
        { sha: "c3000003", subject: "docs: internal note" },
      ],
    },
    {
      tag: "v0.0.1.2",
      previous: "v0.0.1.1",
      date: "2026-11-09T07:43:41Z",
      commits: [{ sha: "c2000001", subject: "chore: refresh analytics [skip ci]" }],
    },
    {
      tag: "v0.0.1.1",
      previous: "v0.0.1.0",
      date: "2026-11-08T07:43:41Z",
      commits: [{ sha: "c1000001", subject: "fix(files): stop the tree flickering" }],
    },
  ],
};

test.describe("What's new", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/release-notes.json", (route) => route.fulfill({ json: FIXTURE }));
  });

  test("version label opens the window; history page lists every release", async ({ page }) => {
    await activateClaudiusWorkspace(page);
    await page.goto("/");

    await page.getByTestId("claudius-version").click();
    const win = page.getByTestId("whats-new-window");
    await expect(win).toBeVisible();

    // User-facing releases only, newest first; the maintenance-only one is skipped.
    const releases = win.getByTestId("release-note");
    await expect(releases).toHaveCount(2);
    await expect(releases.nth(0)).toHaveAttribute("data-tag", "v0.0.1.3");
    await expect(releases.nth(1)).toHaveAttribute("data-tag", "v0.0.1.1");
    await expect(releases.nth(0)).toContainText("Show the rename shortcut on hover");
    // Release-machinery and docs commits are counted, not listed.
    await expect(releases.nth(0)).not.toContainText("Pin Linux jobs");
    await expect(releases.nth(0)).toContainText("+2 internal changes");

    await win.getByTestId("whats-new-all").click();
    await expect(page).toHaveURL(/\/release-notes$/);
    await expect(win).toBeHidden();

    const history = page.getByTestId("release-notes-history").getByTestId("release-note");
    await expect(history).toHaveCount(2);
    await page.getByTestId("release-notes-show-maintenance").check();
    await expect(history).toHaveCount(3);
    await expect(history.nth(1)).toContainText("Maintenance release");
  });

  test("Got it closes the window", async ({ page }) => {
    await activateClaudiusWorkspace(page);
    await page.goto("/");
    await page.getByTestId("claudius-version").click();
    await expect(page.getByTestId("whats-new-window")).toBeVisible();
    await page.getByTestId("whats-new-dismiss").click();
    await expect(page.getByTestId("whats-new-window")).toBeHidden();
  });
});
