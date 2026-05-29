import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Seed a single "claudius" workspace into the isolated e2e HOME.
 *
 * Claudius used to auto-bootstrap a workspace from `process.cwd()` on the
 * first `/api/workspaces` read, so the e2e dev server (running under the
 * per-run tempdir HOME set in `playwright.config.ts`) always had a workspace
 * named "claudius" to render against. That auto-seed is gone — a fresh
 * install now lands on `/welcome` instead — so we recreate the test-only
 * invariant here: most specs assume an active workspace exists, and
 * `activateClaudiusWorkspace` looks one up by name/rootPath.
 *
 * We write `workspaces.json` directly (no server needed) so the seed is on
 * disk before the first spec hits the API. `rootPath` is the project dir
 * (the dev server's cwd), and the name is "claudius", matching what the old
 * bootstrap produced — and what the spec helpers search for.
 *
 * Idempotent: if a workspaces.json with at least one workspace already
 * exists (e.g. a reused `CLAUDIUS_E2E_HOME`), we leave it untouched.
 *
 * The id is hex-only on purpose — SideNav's `stripWorkspacePrefix` matches
 * `/^\/wks_[a-f0-9]+/`, so a non-hex id would break nav active-state
 * detection in specs like sidenav-reorder.
 */
export default async function globalSetup(): Promise<void> {
  const home = process.env.CLAUDIUS_E2E_HOME;
  if (!home) return;

  const claudiusDir = join(home, ".claude", ".claudius");
  const file = join(claudiusDir, "workspaces.json");

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        workspaces?: unknown[];
      };
      if (Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) return;
    } catch {
      // Corrupt/partial file — fall through and overwrite with a clean seed.
    }
  }

  const cwd = process.cwd();
  const id = "wks_e2ec1a0d0000";
  const now = Date.now();
  const shape = {
    version: 1,
    activeId: id,
    workspaces: [
      {
        id,
        name: "claudius",
        rootPath: cwd,
        icon: { kind: "letter", letter: "C", color: "#d97757" },
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        defaults: { permissionMode: "bypassPermissions" },
      },
    ],
  };

  mkdirSync(claudiusDir, { recursive: true });
  writeFileSync(file, JSON.stringify(shape, null, 2) + "\n", "utf8");
}
