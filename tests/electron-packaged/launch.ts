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
  /**
   * Snapshot of everything the packaged Electron main process has emitted
   * to stdout/stderr since launch. Updated live as the process writes.
   * Used by `mac-smoke.spec.ts` / `appimage-smoke.spec.ts` to assert no
   * fatal markers appear (uncaught exceptions, native-module load
   * failures, the SDK's "exists but failed to launch" pattern, etc.).
   *
   * Empty string when the test runner couldn't attach to the child
   * stdio — Playwright's `_electron.launch` doesn't expose its child's
   * stdio handles directly, so we hold a reference and re-read it on
   * demand. Reading the field is preferred over a snapshot callback so
   * the test can decide WHEN to check (after both assertions land, after
   * a known navigation, etc.).
   */
  readLogs: () => string;
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

  // Capture main-process stdout/stderr into a growing buffer.
  //
  // Why this is needed: the existing UI assertions (titlebar visible,
  // /api/heartbeat OK) cover the "process didn't crash" dimension well, but
  // miss a whole class of regressions that print loudly to the terminal
  // without breaking the renderer — e.g. "Cannot find module" warnings from
  // a dropped asarUnpack rule, `dlopen … incompatible architecture` from a
  // mixed-arch standalone tree, "exists but failed to launch" from the SDK
  // when a session is created. We capture stdio here so the spec can scan
  // for those markers as a separate assertion after the boot path lands.
  //
  // `app.process()` returns the real ChildProcess Playwright spawned. Its
  // stdout/stderr streams are inherited so they're readable here. We never
  // re-emit — the buffer is text-only, the test reads it on demand.
  const buf: string[] = [];
  const child = app.process();
  child.stdout?.on("data", (d: Buffer | string) => buf.push(d.toString()));
  child.stderr?.on("data", (d: Buffer | string) => buf.push(d.toString()));

  return { app, readLogs: () => buf.join("") };
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
