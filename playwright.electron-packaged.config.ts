import { defineConfig } from "@playwright/test";

/**
 * Playwright config for smoke-testing the PACKAGED desktop artifact (the
 * Linux AppImage produced by the release workflow) — separate from
 * `playwright.config.ts`, which drives the dev-server-backed browser +
 * `chromium-electron` suites.
 *
 * Why a dedicated config rather than another project in the main one:
 *   • No `webServer`. The packaged app boots its OWN embedded Next server
 *     (app.isPackaged === true). The main config's global `next dev`
 *     webServer would be both wrong (not what ships) and wasteful here.
 *   • The binary under test is passed via `CLAUDIUS_PACKAGED_BINARY`; the
 *     spec skips when it's unset, so a bare run is a harmless no-op.
 *
 * Invoked by `.github/workflows/release.yml`'s `linux-smoke` job as:
 *   CLAUDIUS_PACKAGED_BINARY=/abs/Claudius.AppImage \
 *     xvfb-run -a bunx playwright test --config=playwright.electron-packaged.config.ts
 */
export default defineConfig({
  testDir: "./tests/electron-packaged",
  fullyParallel: false,
  // One packaged instance at a time — they'd fight over the single-instance
  // lock and the embedded server otherwise.
  workers: 1,
  // A genuine sandbox/packaging break fails deterministically (no window
  // ever opens), so retries only paper over true flakes; allow one on CI.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 150_000,
  expect: { timeout: 30_000 },
  use: {
    // Capture a trace so a CI failure (crash-at-launch) is debuggable from
    // the uploaded artifact rather than just a red X.
    trace: "retain-on-failure",
  },
});
