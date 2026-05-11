import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.CLAUDIUS_E2E_PORT ?? 3179);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    trace: "on",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    headless: !!process.env.CI,
    viewport: { width: 1280, height: 800 },
  },

  // Three projects:
  //   • chromium         — default mocked suite. Excludes site-screenshots.
  //   • chromium-live    — API-key / chat-server specs in tests/e2e-live/.
  //   • screenshots      — marketing screenshot capture (site-screenshots.spec).
  //
  // The default `playwright test` runs all three unless filtered. The npm
  // scripts (test:e2e, test:e2e:live, site:screenshots) pass --project so
  // each command runs only what its name says.
  //
  // Why not testIgnore at top level? It hides the file from direct path
  // targeting too — which broke `bun run site:screenshots`. Per-project
  // testMatch keeps the spec selectable when its project is named.
  //
  // Live specs still call test.skip(!env) so running them without
  // ANTHROPIC_API_KEY / NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL is a no-op
  // rather than a failure.
  projects: [
    {
      name: "chromium",
      testIgnore: ["**/site-screenshots.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-live",
      testDir: "./tests/e2e-live",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "screenshots",
      testMatch: /site-screenshots\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: `next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // NEXT_PUBLIC_* env vars are baked into the client bundle at dev-server
      // startup. Without this, /community renders the "not configured" empty
      // state and tests that look for `data-testid="community-page"` fail.
      // The community-nav.spec uses page.route to mock the chat-server URL,
      // so the value doesn't have to be reachable — just present. Falls back
      // to a local placeholder when nothing's exported (CI case).
      NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL:
        process.env.NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL ?? "http://localhost:8787",
    },
  },
});
