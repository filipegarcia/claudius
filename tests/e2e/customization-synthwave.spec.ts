import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { UPDATE_SCREENSHOTS } from "./helpers/marketing-screenshot";

/**
 * Screenshot for the Synthwave customization on the marketing site.
 *
 * Unlike the other customization demos (see customization-showcase.spec.ts),
 * Synthwave only touches `app/globals.css` + `lib/client/theme.ts` — there's
 * no behaviour to demo, just a palette. Spinning up a dedicated preview
 * server for that would be wasteful: instead we hit the live dev server,
 * seed `localStorage.claudius.theme = "synthwave"` via addInitScript so the
 * theme is active on first paint, and snap.
 *
 * Output (only written when UPDATE_SCREENSHOTS=1):
 *   site/screenshots/customization-synthwave.png — referenced from
 *   site/index.html in the customizations gallery.
 */

const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
if (UPDATE_SCREENSHOTS) mkdirSync(SHOTS_DIR, { recursive: true });

type WorkspaceSummary = { id: string; name: string; rootPath: string };

test.describe("customization · synthwave screenshot", () => {
  test("customization-synthwave", async ({ page }) => {
    // Seed the theme + suppress the customize help tour so the screenshot
    // shows the actual content, not the onboarding overlay.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("claudius.theme", "synthwave");
        localStorage.setItem("claudius.customize.help-seen", "1");
      } catch {
        // private mode — the page will still load with the default theme.
      }
    });

    // Activate the claudius workspace so the side nav reflects this project,
    // matching the rest of the marketing screenshots. Skipped silently if a
    // workspace can't be found — the screenshot still renders, just with
    // whatever workspace was last selected.
    const list = await page.request
      .get("/api/workspaces")
      .then((r) => r.json() as Promise<{ workspaces: WorkspaceSummary[] }>);
    const cwd = process.cwd();
    const ws =
      list.workspaces.find((w) => w.name === "claudius") ??
      list.workspaces.find((w) => w.rootPath === cwd);
    if (ws) {
      await page.request.post(`/api/workspaces/${ws.id}/select`);
    }

    await page.goto("/customize", { waitUntil: "load" });
    // The synthwave body backdrop renders via background-image which is
    // applied as soon as the data-theme attribute lands; give the page a
    // beat to settle skeleton-loaders.
    await page.waitForTimeout(800);

    // Sanity: data-theme really is synthwave (the addInitScript ran).
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(
      "synthwave",
    );

    if (UPDATE_SCREENSHOTS) {
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-synthwave.png"),
        fullPage: false,
      });
    }
  });
});
