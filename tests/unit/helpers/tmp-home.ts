import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAll } from "@/lib/server/db";

/**
 * Hijacks `process.env.HOME` for the lifetime of the returned handle so any
 * server module that resolves paths relative to `homedir()` (workspaces-store,
 * db) writes into a throwaway tmpdir.
 *
 * Two gotchas this handles:
 *   1. `lib/server/db.ts` caches SQLite handles in a module-level `Map`. If
 *      the previous test left a handle open against a different tmp HOME,
 *      the new test would see a stale connection. `closeAll()` runs both on
 *      setup (defensive) and on `restore()`.
 *   2. `lib/server/workspaces-store.ts` used to bake `homedir()` at module
 *      load — fixed in the same pass that introduced this helper, but if
 *      a future regression brings the eager binding back, the symptom will
 *      be tests passing locally and failing in CI because of HOME order.
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
