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
import type { ChildProcess } from "node:child_process";
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

/**
 * Fetch `/api/heartbeat` from the main window, the way the renderer reaches
 * the embedded server (through the https/h2 loopback proxy, whose self-signed
 * certificate only the app trusts, so the test process can't call it itself).
 *
 * Retried when a navigation destroys the page mid-call. A fresh profile's
 * first page is still routing (`/` redirects to `/welcome`), and on a slow
 * runner that redirect lands as a full page load: "Execution context was
 * destroyed, most likely because of a navigation". That failed the Linux
 * AppImage smoke for v0.3.327.1 and v0.3.332.0 though the server was up.
 * Depending on timing, the same navigation instead aborts the request in
 * flight ("Failed to fetch"), so that is retried too; a server that is really
 * down still fails, with that error, at the deadline. Other errors (crash,
 * closed window) fail straight away, and a non-OK answer is returned as is.
 */
export async function fetchHeartbeat(
  page: Page,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; status: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await page.waitForLoadState("domcontentloaded");
      return await page.evaluate(async () => {
        const res = await fetch("/api/heartbeat");
        return { ok: res.ok, status: res.status };
      });
    } catch (err) {
      const navigated = /Execution context was destroyed|Cannot find context with specified id|Failed to fetch/.test(
        String(err),
      );
      if (!navigated || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * How long `app.close()` gets before the packaged process is SIGKILLed. An
 * unbounded `close()` once hung until the 150 s test timeout fired inside
 * `afterEach`. The test had already passed its assertions, but Playwright
 * counted it flaky and failed the Linux AppImage smoke job (v0.3.324.2).
 */
const CLOSE_TIMEOUT_MS = 20_000;

/** How long a killed app gets to release its stdio before we cut it loose. */
const REAP_TIMEOUT_MS = 10_000;

/**
 * SIGKILL the packaged app's whole process group, not just its main pid.
 *
 * Playwright spawns Electron `detached`, so Electron leads its own process
 * group, and gives it five piped fds. On Linux, fds 3 and 4 leak into the
 * children the main process spawns, including the embedded `next-server`
 * (electron/server.ts spawns it without `detached`, so it shares the group).
 * Killing only the main pid orphaned `next-server`, which kept Playwright's
 * pipes open. Playwright never saw the process `close` and waited for it in
 * worker teardown until the 150 s timeout. That failed the Linux AppImage
 * smoke for v0.3.332.0 and v0.3.332.2, though every test had passed.
 * `proc.kill()` also sets `proc.killed`, which makes Playwright skip its own
 * group kill, so it couldn't clean up after us either.
 */
function killProcessGroup(proc: ChildProcess): void {
  if (process.platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch (err) {
      // ESRCH: the whole group is already gone. Anything else: kill the pid.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  proc.kill("SIGKILL");
}

/**
 * Wait for `close` (exit + every stdio pipe at EOF). If a descendant outside
 * the group still holds a pipe, destroy our ends so `close` fires anyway.
 * Playwright waits for that event before it lets the worker exit. Node
 * counts one close per piped fd, so all of `proc.stdio` must go, not just
 * stdout and stderr.
 */
async function waitForClose(proc: ChildProcess): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    new Promise<true>((resolve) => proc.once("close", () => resolve(true))),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), REAP_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (closed) return;
  console.warn(
    `[electron-packaged] pid ${proc.pid} stdio still open ${REAP_TIMEOUT_MS}ms after SIGKILL — destroying the pipes`,
  );
  for (const stream of proc.stdio) stream?.destroy();
}

export async function teardownPackaged(
  launched: LaunchedPackaged,
): Promise<void> {
  const proc = launched.app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    // close() throws if the process already exited (crash / killed window);
    // either way there's nothing left to wait for.
    launched.app.close().then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!closed && proc.exitCode === null && proc.signalCode === null) {
    // Loud on purpose: a packaged app that won't quit is worth knowing about,
    // but it isn't what these launch smokes assert, so it mustn't fail them.
    // The log tail is there to show what the app was doing when it wouldn't
    // quit.
    console.warn(
      `[electron-packaged] app.close() still pending after ${CLOSE_TIMEOUT_MS}ms — SIGKILLing process group ${proc.pid}\n` +
        `--- captured stdio (last 2 KB) ---\n${launched.readLogs().slice(-2048)}`,
    );
    killProcessGroup(proc);
    await waitForClose(proc);
  }
}
