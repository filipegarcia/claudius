/* eslint-disable react-hooks/rules-of-hooks -- Playwright's fixture API
   exposes a `use` callback the spec body waits on. The React-hooks lint
   rule sees the identifier and assumes it's React 19's `use()` hook, which
   isn't the case here. */
/**
 * Shared Playwright test fixture for the Claudius e2e suite.
 *
 * Why this file exists
 * --------------------
 * The same suite has to run in two project shapes:
 *   1. `chromium`           — Playwright launches a normal Chrome instance.
 *      The auto-injected `page` fixture is a `BrowserContext.newPage()`.
 *   2. `chromium-electron`  — Playwright launches the compiled
 *      `dist-electron/main.js` via `_electron.launch()`. The first window
 *      of the running app is the renderer we want to drive.
 *
 * Both modes ultimately point at the same `next dev` server (the
 * project-level `webServer` block in `playwright.config.ts`). The
 * renderer in Electron loads `ELECTRON_START_URL=http://localhost:3179`
 * — the same URL the browser project hits via its `baseURL`. So spec
 * bodies that call `page.goto("/foo")`, `page.route("**\/api\/...")`,
 * etc. behave identically once the `page` fixture is swapped.
 *
 * Specs import `test`, `expect`, and any Playwright types from THIS file
 * instead of from `@playwright/test`. The override is invisible to spec
 * code — it just sees a `page` that happens to be the Electron window
 * when running under the Electron project.
 *
 * Electron-only specs (menu top-level labels, sandbox guarantees, bridge
 * shape) live under `tests/electron/` and continue to use Playwright's
 * `_electron.launch()` directly via `tests/electron/launch.ts`. The
 * fixture here is for parametrising browser specs to also run in
 * Electron — see Phase 10 followup in `docs/electron-conversion/PLAN.md`.
 */
import { test as base } from "@playwright/test";

import { launchElectron, teardownElectron, type LaunchedElectron } from "../electron/launch";

// Re-export everything from Playwright so spec files can pull `expect` and
// type aliases (Page, Route, Locator, ConsoleMessage, APIRequestContext) from
// the same module path they pull `test` from. Named `test` re-defined below
// shadows the one from `@playwright/test`.
export { expect } from "@playwright/test";
export type * from "@playwright/test";

type ClaudiusFixtures = {
  /**
   * True when the current test is running under the `chromium-electron`
   * project. Specs that branch on runtime affordances (the OS menu, OS
   * notifications, the custom `<TitleBar />`) can read this directly
   * instead of inspecting `testInfo.project.name`.
   */
  isElectron: boolean;
};

export const test = base.extend<ClaudiusFixtures>({
  isElectron: async ({}, use, testInfo) => {
    await use(testInfo.project.name === "chromium-electron");
  },

  // Override the built-in `page` fixture. When running under the Electron
  // project we launch the app, await its first window, and hand THAT page
  // to the spec body. The default browser-mode path is otherwise unchanged.
  //
  // The `_electronApp` reference is held inside the fixture closure so the
  // teardown path can shut down the spawned child after the spec finishes.
  // Using `await use(...)` means the fixture's `finally` runs even if the
  // spec throws — same lifecycle guarantee Playwright gives for the
  // default `page` fixture.
  page: async ({ page, baseURL }, use, testInfo) => {
    if (testInfo.project.name !== "chromium-electron") {
      await use(page);
      return;
    }
    let launched: LaunchedElectron | null = null;
    try {
      launched = await launchElectron();
      const win = await launched.app.firstWindow();
      // The renderer needs a moment to load the dev server's HTML.
      // `domcontentloaded` is the cheapest signal that we have something
      // to drive — specs that need more wait on their own selectors.
      await win.waitForLoadState("domcontentloaded");

      // Resolve relative `page.goto("/foo")` calls against the test
      // server's base URL.
      //
      // For the chromium browser project Playwright reads `use.baseURL`
      // and applies it inside the BrowserContext at creation time, so
      // `page.goto("/")` resolves correctly. The Electron app owns its
      // own context — Playwright never sees that creation point — so
      // the baseURL never reaches it and the relative URL hits Chromium
      // as `/` (no scheme, no host), which fails with the "Cannot
      // navigate to invalid URL" protocol error.
      //
      // We rewrap `goto` so any path-style argument resolves against the
      // same `baseURL` that the browser project uses. Absolute URLs and
      // `data:` / `file:` URIs pass through untouched.
      if (baseURL) {
        const orig = win.goto.bind(win);
        type GotoOpts = Parameters<typeof win.goto>[1];
        win.goto = (url: string, opts?: GotoOpts) => {
          const isRelative = url.startsWith("/");
          const resolved = isRelative ? `${baseURL.replace(/\/$/, "")}${url}` : url;
          return orig(resolved, opts);
        };
      }

      await use(win);
    } finally {
      if (launched) await teardownElectron(launched);
    }
  },
});
