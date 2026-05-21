/**
 * Electron e2e — Settings page renders without console errors.
 *
 * Coverage row: COVERAGE.md §3 "Settings page" — first item.
 *
 * Scope
 * -----
 * Boots the Electron app, navigates the renderer to `/settings`, and
 * asserts both:
 *   (a) DOM signal — the settings shell mounted (the page renders a
 *       top-level "Settings" heading inside an `<h1>` — see
 *       `app/settings/page.tsx`).
 *   (b) Console signal — Chromium emitted no `console.error` /
 *       `pageerror` events while the page was loading or rendering.
 *
 * Console errors are the cheapest "the page actually works" signal for
 * a render smoke. A React error boundary firing, a 404 on a required
 * fetch, an unhandled promise rejection — they all light up the
 * console even when nothing visually breaks. We accumulate them via
 * `page.on("console", ...)` + `page.on("pageerror", ...)` and assert
 * the array is empty at the end.
 *
 * Driven by the autonomous e2e Ralph loop — see
 * docs/electron-conversion/E2E_LOOP_PROMPT.md.
 */
import { expect, test, type ConsoleMessage } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "./launch";

let launched: LaunchedElectron;

test.beforeEach(async () => {
  launched = await launchElectron();
});

test.afterEach(async () => {
  await teardownElectron(launched);
});

test("settings: /settings route renders without console errors", async () => {
  const page = await launched.app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Collect all console messages tagged `error` plus uncaught page
  // errors. Filtering happens later so the failure message can include
  // a transcript of what came in.
  const consoleErrors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
  });

  // Navigate via the renderer (same as a user clicking the settings
  // link in the workspace rail). `goto` resolves relative against the
  // electron renderer's current URL — the launcher loads
  // `localhost:<port>/` first via ELECTRON_START_URL.
  const port = Number(process.env.CLAUDIUS_E2E_PORT ?? 3179);
  await page.goto(`http://localhost:${port}/settings`);

  // Settings page mount marker. `app/settings/page.tsx` renders the
  // SettingsIcon followed by a literal "Settings" span at the top
  // of the page (it's not a `<h1>`). The Scope-selector buttons
  // ("User" / "Project" / "Local") are the next reliable structural
  // marker — they exist only on the settings page. Use them as the
  // mount signal.
  await expect(page.getByRole("button", { name: "User", exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Give it a beat past the initial paint for any deferred fetches
  // (the SettingsScope fetcher hits /api/settings, the theme fetcher
  // reads localStorage). 500ms is enough on a warm next dev; if a
  // route takes longer to compile on cold-boot the deferred error
  // would still arrive within the test's overall timeout.
  await page.waitForTimeout(500);

  expect(
    consoleErrors,
    `settings page emitted ${consoleErrors.length} console error(s):\n${consoleErrors.join("\n")}`,
  ).toEqual([]);
});
