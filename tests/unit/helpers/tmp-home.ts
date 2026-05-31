import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { closeAll } from "@/lib/server/db";

/**
 * Hijacks `process.env.HOME` for the lifetime of the returned handle so any
 * server module that resolves paths relative to `homedir()` (workspaces-store,
 * db) writes into a throwaway tmpdir.
 *
 * Three gotchas this handles:
 *   1. `lib/server/db.ts` caches SQLite handles in a module-level `Map`. If
 *      the previous test left a handle open against a different tmp HOME,
 *      the new test would see a stale connection. `closeAll()` runs both on
 *      setup (defensive) and on `restore()`.
 *   2. `lib/server/workspaces-store.ts` used to bake `homedir()` at module
 *      load — fixed in the same pass that introduced this helper, but if
 *      a future regression brings the eager binding back, the symptom will
 *      be tests passing locally and failing in CI because of HOME order.
 *   3. Bun's `os.homedir()` ignores `process.env.HOME` and resolves the user's
 *      real home via `getpwuid` regardless. Running these tests under Bun
 *      (e.g. `bun test`, or vitest launched via `bun run …` in a setup that
 *      lets it inherit the Bun runtime) silently writes into the developer's
 *      real `~/.claude/.claudius/` and clobbers their workspaces.json. The
 *      verification block below catches that and refuses to continue.
 *
 * Callers should pair this with `beforeEach`/`afterEach`, not `beforeAll`,
 * so each test starts from a clean tmpdir and the DB handle cache is fresh.
 */
export type TmpHome = {
  /** Absolute path to the fresh tmpdir we redirected HOME to. */
  home: string;
  /** Restores the previous HOME and removes the tmpdir. */
  restore: () => void;
};

export function makeTempHome(): TmpHome {
  const home = mkdtempSync(join(tmpdir(), "claudius-test-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  // Verify the redirect actually took effect before any test code runs.
  // See gotcha #3 above — Bun's homedir() ignores $HOME, so without this
  // check every test using this helper would silently write into the real
  // user home.
  const resolved = homedir();
  if (resolved !== home) {
    // Restore $HOME and remove the tmpdir we just made before throwing, so
    // a caught error doesn't leak state into subsequent tests.
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw new Error(
      `makeTempHome: process.env.HOME redirection is inert in this runtime ` +
        `(set HOME=${home}, but os.homedir() returned ${resolved}). ` +
        `This usually means the test was launched under Bun, whose ` +
        `os.homedir() bypasses $HOME. Run tests under Node — e.g. ` +
        `\`bun run test\` (which spawns vitest under Node), \`npx vitest run\`, ` +
        `or \`node --import tsx node_modules/.bin/vitest run\`. Letting this ` +
        `pass would clobber the real ~/.claude/.claudius/ files.`,
    );
  }
  closeAll();
  return {
    home,
    restore() {
      closeAll();
      if (prev === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prev;
      }
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // tmpdir cleanup is best-effort; the OS will reap it eventually.
      }
    },
  };
}
