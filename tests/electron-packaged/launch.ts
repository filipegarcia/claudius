/**
 * Playwright launcher for the PACKAGED desktop artifact (the AppImage /
 * deb / rpm electron binary produced by the release pipeline) — as opposed
 * to `tests/electron/launch.ts`, which drives the freshly-compiled
 * `dist-electron/main.js` against a shared `next dev`.
 *
 * The difference is the whole point: the packaged binary has
 * `app.isPackaged === true`, so it boots its OWN embedded Next server from
 * the bundled `resources/standalone` tree and loads `/` from loopback —
 * exactly what ships to users. That exercises the parts the dev-server
 * specs can't: native-module ABI, the standalone bundle, the SDK binary,
 * and the Linux Chromium sandbox path that crashed the AppImage.
 *
 * The binary under test is supplied via `CLAUDIUS_PACKAGED_BINARY` (an
 * absolute path). Specs `test.skip` themselves when it's unset so a bare
 * `playwright test` with no artifact is a no-op, not a failure.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

export type LaunchedPackaged = {
  app: ElectronApplication;
};

/**
 * Launch the packaged binary with an isolated HOME + userData so the smoke
 * can neither read nor stomp anything on the runner, and the single-instance
 * lock can't collide with a stray prior launch.
 *
 * We deliberately do NOT set `ELECTRON_START_URL` — that env var is honored
 * only in unpackaged/dev builds (see electron/main.ts:resolveStartUrl). For
 * the real artifact we want the embedded-server path.
 */
export async function launchPackaged(
  executablePath: string,
): Promise<LaunchedPackaged> {
  const home = mkdtempSync(join(tmpdir(), "claudius-pkg-home-"));
  const userData = mkdtempSync(join(tmpdir(), "claudius-pkg-userdata-"));

  const app = await electron.launch({
    executablePath,
    // `--user-data-dir` is honored by electron/main.ts (it skips its own
    // setPath override when the switch is present), giving this run a
    // throwaway profile.
    //
    // We do NOT pass --no-sandbox here: the executablePath is the AppImage
    // launch wrapper (build/after-pack.js), which adds --no-sandbox itself when
    // $APPIMAGE is set (the release job sets it). The wrapper `exec`s the real
    // binary in-place (same PID, same stdio), so Playwright's CDP attachment
    // survives. Letting the wrapper do it keeps this test exercising the real
    // launch path rather than papering over it.
    args: [`--user-data-dir=${userData}`],
    // Packaged cold start = require("next") inside the asar + app.prepare()
    // + first SSR. Generous ceiling so a slow runner doesn't read as a hang.
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: home,
      // No ANTHROPIC_API_KEY: the chat shell renders without one, and the
      // heartbeat route does no I/O — the boot smoke needs neither.
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  return { app };
}

/**
 * Resolve the MAIN application window, skipping the cold-start splash.
 *
 * The packaged build opens a splash BrowserWindow first (electron/splash.ts)
 * that loads an inline `data:` URL, then opens the real window which loads
 * `http://127.0.0.1:<port>` from the embedded server and is destroyed once
 * the main window paints. `firstWindow()` would race the splash, so we poll
 * for the window whose origin is loopback — that's unambiguously the app.
 *
 * If the app crashed at launch (e.g. the Chromium SUID-sandbox abort) no
 * such window ever appears and this throws with an actionable message — the
 * regression signal we want CI to surface.
 */
export async function waitForMainWindow(
  app: ElectronApplication,
  timeoutMs = 90_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      let url = "";
      try {
        url = w.url();
      } catch {
        // Window is mid-teardown (the splash being destroyed) — ignore.
      }
      if (/^https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(url)) {
        return w;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    "packaged app never opened its main (loopback-origin) window within " +
      `${timeoutMs}ms — it most likely crashed at launch (e.g. the AppImage ` +
      "Chromium sandbox abort). Check the captured stdout/stderr.",
  );
}

export async function teardownPackaged(
  launched: LaunchedPackaged,
): Promise<void> {
  try {
    await launched.app.close();
  } catch {
    // close() throws if the process already exited (crash / killed window).
    // We tried — nothing else to clean up.
  }
}
