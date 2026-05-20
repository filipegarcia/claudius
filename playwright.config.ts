import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.CLAUDIUS_E2E_PORT ?? 3179);
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Per-run isolated HOME for the e2e dev server.
 *
 * Two problems this solves:
 *   1. The user might have their own `next dev` running against this same
 *      project dir. Next 16 holds an exclusive lockfile under
 *      `<project>/.next/dev/lock`, so a second instance against the same
 *      `.next` dir fails. We pass `--dist-dir .next-e2e` below to scope the
 *      lockfile (and the build cache) to its own directory.
 *   2. Everything Claudius reads/writes under `~/.claude/` (workspaces.json,
 *      per-workspace `.claudius.db`, auto-memory, user-scope settings /
 *      agents / skills / mcp) is keyed on `homedir()`. Pointing HOME at a
 *      fresh tempdir gives the test server its own world — sessions, drafts
 *      and notifications never touch the user's real workspace.
 *
 * Gating on `process.env.CLAUDIUS_E2E_HOME` matters because Playwright
 * loads this config file twice (once in the runner, once when reporting),
 * and we want both passes — plus the webServer.env spawn — to see the
 * *same* tempdir. Writing back into `process.env` propagates to the dev
 * server, which then auto-bootstraps its default workspace into the
 * tempdir.
 */
const E2E_HOME =
  process.env.CLAUDIUS_E2E_HOME ??
  mkdtempSync(join(tmpdir(), "claudius-e2e-home-"));
process.env.CLAUDIUS_E2E_HOME = E2E_HOME;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  // Retry flaky specs on CI only. We hit this with a workspace-switch
  // refresh test that's timing-sensitive on slower runners — the retry
  // catches the flake without papering over deterministic bugs (those
  // fail all 3 attempts). Locally retries stay at 0 so flakes are loud.
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Best-effort cleanup of the isolated HOME after the run. Not run on
  // SIGKILL / Ctrl-C — `mkdtempSync` lives under `os.tmpdir()` so the OS
  // sweeps it eventually if we miss.
  globalTeardown: "./tests/e2e/global-teardown.ts",

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
    // Phase 10 of docs/electron-conversion/PLAN.md — runs against the
    // compiled `dist-electron/main.js` via Playwright's `_electron`
    // helper. Shares the same `webServer` (next dev) as the browser
    // suite — the renderer loads from it via ELECTRON_START_URL.
    //
    // Picks up two trees:
    //   • tests/electron/  — intrinsically Electron-only specs
    //     (titlebar, bridge shape, sandbox, application menu).
    //   • tests/e2e/       — the same parametrised browser specs the
    //     chromium project runs. Each one resolves the shared
    //     `page` fixture from `tests/helpers/test.ts`; under the
    //     `chromium-electron` project name the fixture swaps in
    //     `_electron.launch().firstWindow()` so the renderer the
    //     spec drives is the packaged-app window. The dev server
    //     stays shared via the project-level `webServer` block
    //     below — no second Next instance.
    //
    // testIgnore: a small handful of browser specs can't translate to
    // the single-window Electron shell — they fork multiple browser
    // contexts / tabs to simulate "two browser windows open at once,"
    // which the renderer here intentionally doesn't support:
    //   • session-resume.spec.ts        — opens two `browser.newContext()`s
    //   • notifications-multi-tab.spec  — opens two pages in one context
    //   • site-screenshots.spec.ts      — marketing PNGs only
    //   • site-marketing.spec.ts        — marketing-only, no in-app flow
    {
      name: "chromium-electron",
      testDir: "./tests",
      testMatch: /(e2e|electron)\/.*\.spec\.ts$/,
      testIgnore: [
        "**/session-resume.spec.ts",
        "**/notifications-multi-tab.spec.ts",
        "**/site-screenshots.spec.ts",
        "**/site-marketing.spec.ts",
      ],
      // Electron specs pay a per-test cost: `_electron.launch()` spawns a
      // fresh main + renderer process, blank-window then loads `/` from the
      // next dev server. On a warm box that's ~700ms; under cold-compile
      // load (first hit to a route triggers Next 16's per-route compile)
      // it can spike past the 60s default. Tighten the bound to 120s so
      // genuine hangs still surface but Electron's startup cost doesn't
      // get attributed to the test body.
      timeout: 120_000,
    },
  ],

  webServer: {
    // `NEXT_DIST_DIR=.next-e2e` (read by `next.config.ts`) keeps the
    // dev server's lockfile, build cache and trace separate from
    // `.next/`. That lets the test server run *alongside* the user's
    // own `next dev` against the same project dir without tripping
    // Next 16's "another next dev server is already running"
    // exclusive lock at `<project>/.next/dev/lock`. The CLI flag
    // `--dist-dir` was removed from `next dev` in Next 16, so the
    // override has to flow through next.config.ts.
    command: `next dev -p ${PORT}`,
    url: BASE_URL,
    // CI runs once and exits; reusing buys nothing. Locally a stale dev
    // server on the same port (e.g. from a killed prior run) shouldn't
    // be inherited — the HOME we passed in is per-run, so its state
    // wouldn't match the new tempdir anyway.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // See the comment above on `command` — flows into
      // `next.config.ts`'s `distDir`.
      NEXT_DIST_DIR: ".next-e2e",
      // Sandbox `~/.claude/*` reads/writes inside a per-run tempdir so
      // the test server can't see (or overwrite) the user's real
      // workspaces, sessions, settings, agents or skills.
      HOME: E2E_HOME,
      // Telemetry surveys would otherwise spawn a separate child process
      // that races with shutdown and occasionally hangs the test run.
      NEXT_TELEMETRY_DISABLED: "1",
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
