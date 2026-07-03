/**
 * Gate marketing-screenshot writes behind `UPDATE_SCREENSHOTS=1`.
 *
 * Several e2e specs (chat-screenshots.spec.ts and the customization-*.spec.ts
 * family) double as marketing-image producers — they navigate to a fixture
 * page, assert it renders, and snap a PNG into `site/screenshots/`. The
 * navigation + assertion half is useful regression coverage and stays
 * enabled by default. The disk write, however, was clobbering committed
 * marketing images on every plain `bun run test:e2e` run — sometimes with
 * byte-identical bytes (no git diff), sometimes with a subtly different
 * crop or theme that landed in the working tree as an unintended change.
 *
 * Default behaviour now:
 *   - `bun run test:e2e`                            → tests run, no PNGs written
 *   - `UPDATE_SCREENSHOTS=1 bun run test:e2e`       → tests run, PNGs refreshed
 *   - `bun run test:e2e:screenshots`                → shortcut for the above
 *
 * This flag is read once at module load. Vitest / Playwright don't reload
 * the test file between specs in the same run, so the value stays stable
 * for the whole `playwright test` invocation.
 */
export const UPDATE_SCREENSHOTS = process.env.UPDATE_SCREENSHOTS === "1";

/**
 * Hide the Next.js dev overlay before a marketing screenshot.
 *
 * `next dev` injects a floating dev-tools indicator that renders a "N · 1
 * Issue" badge in the bottom-right whenever it detects a build/runtime issue
 * (a stray hydration warning is enough). `next.config.ts` sets
 * `devIndicators: false` under the e2e dist dir, but that flag only suppresses
 * the *route* indicator — Next 16's error badge still bleeds through and lands
 * in the committed gallery.
 *
 * The overlay lives inside a `<nextjs-portal>` custom element appended to the
 * body (its UI is in a shadow root, but the host is light-DOM). Hiding the
 * host element via a plain stylesheet reliably removes the whole overlay
 * regardless of the flag. Selectors cover the 16.2.x host + badge + toast
 * element names. No-op (caught) if the page navigated away mid-call.
 */
export async function hideNextDevOverlay(page: import("@playwright/test").Page) {
  await page
    .addStyleTag({
      content:
        "nextjs-portal,nextjs-dev-tools,nextjs-toast,[data-next-badge],[data-next-badge-root],#__next-build-watcher{display:none!important}",
    })
    .catch(() => {});
}
