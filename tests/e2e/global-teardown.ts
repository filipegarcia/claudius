import { rmSync } from "node:fs";

/**
 * Best-effort cleanup of the isolated HOME created by `playwright.config.ts`.
 *
 * Why a global teardown instead of just trusting `os.tmpdir()` to be swept:
 *  - On macOS the tempdir survives for days, and a repeated CI run on a
 *    self-hosted runner would accumulate a `claudius-e2e-home-*` per
 *    invocation.
 *  - Cleaning up here means a successful run leaves no on-disk trace.
 *
 * Why best-effort: this hook is skipped on SIGKILL / Ctrl-C and on Playwright
 * runner crashes. The tempdir under `os.tmpdir()` is the fallback safety net
 * (the OS reaps it on reboot at minimum).
 *
 * `CLAUDIUS_E2E_HOME` is set in `playwright.config.ts` at top-level and
 * propagated to this hook via the same Node process's `process.env`.
 */
export default async function globalTeardown(): Promise<void> {
  const home = process.env.CLAUDIUS_E2E_HOME;
  if (!home) return;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Don't fail the run on cleanup failures — `force: true` already
    // swallows ENOENT, so this catches the rare "file is busy" race.
  }
}
