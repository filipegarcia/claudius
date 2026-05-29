/**
 * Electron e2e — Title bar uses the `var(--panel-2)` token.
 *
 * Coverage row: COVERAGE.md §4 "Top bar / chrome".
 *
 * Scope
 * -----
 * Asserts that the rendered <TitleBar /> resolves its background CSS
 * property to the value of the `--panel-2` theme variable. This is the
 * regression we just fixed — before the fix the bar was
 * `bg-[var(--panel)]/80` and blended into the body background, so the
 * draggable region wasn't visually distinct and the user couldn't
 * tell where to grab to move the window.
 *
 * The test reads `getComputedStyle` for both the title bar's
 * background-color AND a sentinel element whose background is set to
 * `var(--panel-2)`. We use the body's `--panel-2` custom property
 * instead of synthesising a new element, because the resolved
 * computed value is theme-dependent and we want the assertion to
 * survive theme changes (light/dark/synthwave all have a `--panel-2`).
 *
 * Driven by the autonomous e2e Ralph loop — see
 * docs/electron-conversion/E2E_LOOP_PROMPT.md.
 */
import { expect, test } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "./launch";

let launched: LaunchedElectron;

test.beforeEach(async () => {
  launched = await launchElectron();
});

test.afterEach(async () => {
  await teardownElectron(launched);
});

test("top-bar: title bar background resolves to var(--panel-2)", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const titleBar = page.locator('[data-testid="titlebar"]');
  await expect(titleBar).toBeVisible({ timeout: 30_000 });

  // Read both:
  //   • the title bar's computed background-color
  //   • the same color the browser resolves `var(--panel-2)` to, by
  //     setting it on a freshly-injected sentinel element.
  // Comparing the two is more robust than hard-coding an rgb()
  // because the value depends on the active theme.
  const colors = await page.evaluate(() => {
    const tb = document.querySelector('[data-testid="titlebar"]') as HTMLElement | null;
    if (!tb) throw new Error("titlebar testid missing — TitleBar didn't mount");
    const titleBg = getComputedStyle(tb).backgroundColor;

    const sentinel = document.createElement("div");
    sentinel.style.background = "var(--panel-2)";
    // Take it out of the flow so we don't shift layout. We only need a
    // computed style.
    sentinel.style.position = "absolute";
    sentinel.style.left = "-9999px";
    sentinel.style.top = "-9999px";
    sentinel.style.width = "1px";
    sentinel.style.height = "1px";
    document.body.appendChild(sentinel);
    const sentinelBg = getComputedStyle(sentinel).backgroundColor;
    sentinel.remove();

    return { titleBg, sentinelBg };
  });

  expect(colors.titleBg, "title bar background should be a real color, not transparent").not.toBe(
    "rgba(0, 0, 0, 0)",
  );
  expect(
    colors.titleBg,
    `title bar background ${colors.titleBg} should equal the resolved var(--panel-2) value ${colors.sentinelBg}`,
  ).toBe(colors.sentinelBg);
});
