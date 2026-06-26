/**
 * CC 2.1.193 parity — Recent Denials section on /permissions
 *
 * When a session records permission denials via the in-memory ring buffer
 * (populated in `Session.broadcast()` on `permission_denied` SDK events),
 * the /permissions page shows a "Recent Denials" section below the rules
 * grid with tool name, reason type, and timestamp for each denial.
 *
 * Test strategy
 * -------------
 * We mock the `/api/sessions` list to return a synthetic session whose CWD
 * matches the active workspace rootPath (which is `process.cwd()` on the
 * local dev machine). We also mock `/api/sessions/<id>/denials` to return
 * a pre-seeded denial entry. The real workspaces API is left untouched so
 * `useActiveCwd()` resolves normally. Navigating to `/permissions` triggers
 * the middleware redirect to `/<workspaceId>/permissions`, and the mocked
 * sessions/denials responses drive the UI.
 */
import { test, expect } from "../helpers/test";

const SESSION_ID = "cc193-dddd-eeee-ffff-recent-denials";

test.describe("CC 2.1.193 — Recent Denials section on /permissions", () => {
  test.beforeEach(async ({ page }) => {
    // Stub session list — must include a session whose cwd matches the
    // active workspace rootPath so `useActiveCwd()` finds a match.
    await page.route("**/api/sessions**", async (route) => {
      const url = route.request().url();
      // Let the denials sub-route fall through to its own handler below.
      if (url.includes("/denials")) return route.fallback();
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            { id: SESSION_ID, cwd: process.cwd(), model: null, title: null, status: "idle" },
          ]),
        });
      }
      return route.fallback();
    });

    // Stub the denials endpoint to return a pre-seeded denial entry.
    await page.route(`**/api/sessions/${SESSION_ID}/denials`, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            denials: [
              {
                toolName: "Bash",
                reasonType: "auto_deny",
                at: Date.now() - 5_000,
              },
            ],
          }),
        });
      }
      return route.fallback();
    });

    // Stub sessions/all so the tab strip doesn't interfere.
    await page.route("**/api/sessions/all**", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      }),
    );

    // Navigate to /permissions — middleware redirects to /<workspaceId>/permissions.
    await page.goto("/permissions");
  });

  test("Recent Denials section appears and shows the seeded denial", async ({ page }) => {
    // The section heading must be visible.
    const section = page.getByTestId("recent-denials-section");
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section).toContainText("Recent Denials");

    // At least one denial entry must list the seeded tool name and reason.
    const entry = page.getByTestId("recent-denial-entry").first();
    await expect(entry).toBeVisible({ timeout: 10_000 });
    await expect(entry).toContainText("Bash");
    await expect(entry).toContainText("auto_deny");
  });

  test("screenshot — Recent Denials section on /permissions (CC 2.1.193)", async ({ page }) => {
    await expect(page.getByTestId("recent-denials-section")).toBeVisible({ timeout: 15_000 });
    // Scroll to the bottom so the section is in frame.
    await page.getByTestId("recent-denials-section").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "docs/cc-parity/2.1.193/recent-denials.png",
      fullPage: false,
    });
  });
});
