/**
 * Playwright Electron launch helper — Phase 10 of
 * docs/electron-conversion/PLAN.md.
 *
 * Spawns the compiled `dist-electron/main.js` with the renderer URL
 * pointing at the same dev server the web Playwright project uses
 * (port from `CLAUDIUS_E2E_PORT` / default 3179). Returns a typed
 * `ElectronApplication` so specs can drive the menu, query windows,
 * and read main-process globals.
 *
 * Specs must `await teardownElectron(app)` in `test.afterEach` so the
 * spawned child does not outlive the test run.
 */
import path from "node:path";
import { _electron as electron, type ElectronApplication } from "@playwright/test";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist-electron", "main.js");

export type LaunchedElectron = {
  app: ElectronApplication;
};

export async function launchElectron(opts?: {
  startUrl?: string;
}): Promise<LaunchedElectron> {
  const port = Number(process.env.CLAUDIUS_E2E_PORT ?? 3179);
  const startUrl = opts?.startUrl ?? `http://localhost:${port}`;
  // `PLAYWRIGHT_SLOW_MO=500 bun run test:e2e:electron` makes every input
  // action take ~500ms — handy when you want to *watch* the test drive
  // the window instead of blinking through it. Honored only when the env
  // var is set so default CI runs stay fast.
  const slowMo = process.env.PLAYWRIGHT_SLOW_MO
    ? Number.parseInt(process.env.PLAYWRIGHT_SLOW_MO, 10)
    : undefined;

  // Per-test user-data-dir.
  //
  // `electron/main.ts` calls `app.setName("Claudius")` + `app.setPath("userData", …)`
  // so the dev/packaged build uses `~/Library/Application Support/Claudius`.
  // That collides with a user-launched `bun run electron:open` (same path
  // → single-instance lock fires → the test's main process app.quit()s
  // immediately and Playwright sees "Target page, context or browser has
  // been closed").
  //
  // We pass `--user-data-dir` as a Chromium switch on the Electron CLI so
  // the test instance lives in its own throwaway dir — same pattern
  // Chromium itself uses for e2e isolation.
  const testUserData = path.join(
    REPO_ROOT,
    "dist-electron",
    `playwright-userdata-${Date.now()}`,
  );

  const app = await electron.launch({
    args: [MAIN_JS, `--user-data-dir=${testUserData}`],
    cwd: REPO_ROOT,
    timeout: 60_000,
    ...(Number.isFinite(slowMo) ? { timeout: 120_000 } : {}),
    env: {
      ...process.env,
      ELECTRON_START_URL: startUrl,
      // Force-disable the legacy git-pull updater inside the embedded
      // next that runs alongside (the test suite isn't a packaged
      // build, so app.isPackaged is false and our main wouldn't set
      // this otherwise).
      CLAUDIUS_UPDATER_DISABLED: "1",
      // The HOME tempdir used by the existing webServer config; keeps
      // the renderer in the same sandbox.
      HOME: process.env.CLAUDIUS_E2E_HOME ?? process.env.HOME ?? "",
    },
    // `slowMo` here delays every Playwright command on the renderer,
    // not the main-process IPC. Good enough for visualisation.
    ...(slowMo && slowMo > 0 ? { slowMo } : {}),
  });
  return { app };
}

export async function teardownElectron(launched: LaunchedElectron): Promise<void> {
  try {
    await launched.app.close();
  } catch {
    // close() can throw if main already exited (e.g. test killed the
    // window). Swallow — we tried.
  }
}
