import { test, expect } from "../helpers/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { UPDATE_SCREENSHOTS } from "./helpers/marketing-screenshot";

/**
 * Screenshot for the Minecraft Thinking customization. The customization
 * edits ThinkingBlock to render a Minecraft parkour video alongside the
 * model's reasoning — but a screenshot of the customize dashboard (what
 * the showcase spec used to grab) doesn't actually show the feature.
 *
 * Instead, we render a dedicated dev preview at /dev/minecraft-preview
 * that mocks up a streaming chat turn with the Thinking block open and the
 * parkour frame visible. The visual matches what the customization
 * produces when active in a real session, but without needing a live
 * Claude turn or a YouTube iframe.
 *
 * Output (only written when UPDATE_SCREENSHOTS=1):
 *   site/screenshots/customization-minecraft.png — referenced from
 *   site/index.html in the customizations gallery.
 */

const SHOTS_DIR = resolve(process.cwd(), "site/screenshots");
if (UPDATE_SCREENSHOTS) mkdirSync(SHOTS_DIR, { recursive: true });

test.describe("customization · minecraft thinking screenshot", () => {
  test("customization-minecraft", async ({ page }) => {
    // The parkour thumbnail is loaded from img.youtube.com. In an offline
    // CI run that would render the broken-image icon; intercept and replace
    // with a 1x1 transparent gif so the layout collapses to the chrome (the
    // alt text "Minecraft parkour…" still narrates the intent). When the
    // network is available the real thumbnail wins because routes only
    // fulfill on match — see the test order.
    await page.route(
      "https://img.youtube.com/vi/n_Dv4JMiwK8/hqdefault.jpg",
      async (route) => {
        // Try real network first; only stub if it fails.
        try {
          const r = await route.fetch();
          if (r.ok()) {
            await route.fulfill({ response: r });
            return;
          }
        } catch {
          // fall through
        }
        // 1x1 transparent gif so the <img> still rasterises.
        await route.fulfill({
          status: 200,
          contentType: "image/gif",
          body: Buffer.from(
            "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
            "base64",
          ),
        });
      },
    );

    await page.goto("/dev/minecraft-preview", { waitUntil: "load" });
    const block = page.getByTestId("minecraft-thinking-block");
    await expect(block).toBeVisible({ timeout: 10_000 });
    // Wait for the parkour image so the screenshot includes it (not the
    // pre-load whitespace).
    await page.getByTestId("minecraft-parkour-thumb").evaluate(
      (img: HTMLImageElement) =>
        img.complete
          ? Promise.resolve()
          : new Promise((res) => img.addEventListener("load", () => res(null), { once: true })),
    );
    await page.waitForTimeout(200);

    if (UPDATE_SCREENSHOTS) {
      await page.screenshot({
        path: resolve(SHOTS_DIR, "customization-minecraft.png"),
        fullPage: false,
      });
    }
  });
});
